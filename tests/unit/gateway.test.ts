import { expect, test, vi, afterEach } from "vitest";
import { toRequest, parseResponse, saveProvider, generate } from "@/core/gateway";
import { openDb } from "@/core/db";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("anthropic request shape", () => {
  const r = toRequest("anthropic", "https://a/v1", "sk", { role: "code", messages: [{ role: "user", content: "hi" }] });
  expect(r.url).toBe("https://a/v1/messages");
  expect(r.headers["x-api-key"]).toBe("sk");
});

test("openai request shape", () => {
  const r = toRequest("openai", "https://o/v1", "sk", { role: "code", messages: [{ role: "user", content: "hi" }] });
  expect(r.url).toBe("https://o/v1/chat/completions");
  expect(r.headers["Authorization"]).toBe("Bearer sk");
});

test("parse openai response", () => {
  const p = parseResponse("openai", { choices: [{ message: { content: "ok" } }], usage: { total_tokens: 5 } });
  expect(p.text).toBe("ok");
  expect(p.tokens).toBe(5);
});

test("parse anthropic response with tool call", () => {
  const p = parseResponse("anthropic", {
    content: [
      { type: "text", text: "ok" },
      { type: "tool_use", name: "click", input: { x: 1 } },
    ],
    usage: { input_tokens: 3, output_tokens: 4 },
  });
  expect(p.text).toBe("ok");
  expect(p.tokens).toBe(7);
  expect(p.toolCalls).toEqual([{ name: "click", args: { x: 1 } }]);
});

function setupProvider(role: "vision" | "code" | "design" = "code") {
  const db = openDb(":memory:");
  const id = saveProvider(db, {
    name: "openai-test",
    kind: "openai",
    baseUrl: "https://o/v1",
    apiKey: "sk-secret-key",
    roles: { [role]: "gpt-test" },
  });
  return { db, id };
}

test("generate retries once on 429 then succeeds", async () => {
  const { db } = setupProvider();
  let calls = 0;
  const fetchMock = vi.fn(async () => {
    calls += 1;
    if (calls === 1) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "hello" } }], usage: { total_tokens: 9 } }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);

  const result = await generate(db, { role: "code", messages: [{ role: "user", content: "hi" }] }, async () => {});
  expect(result.text).toBe("hello");
  expect(result.tokens).toBe(9);
  expect(calls).toBe(2);
});

test("generate throws AI_AUTH on 401 without retrying", async () => {
  const { db } = setupProvider();
  const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(generate(db, { role: "code", messages: [{ role: "user", content: "hi" }] }, async () => {})).rejects.toMatchObject({
    code: "AI_AUTH",
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("generate never leaks the api key in a thrown error", async () => {
  const { db } = setupProvider();
  const apiKey = "sk-secret-key";
  const fetchMock = vi.fn(async () => new Response("bad request", { status: 400 }));
  vi.stubGlobal("fetch", fetchMock);

  try {
    await generate(db, { role: "code", messages: [{ role: "user", content: "hi" }] }, async () => {});
    throw new Error("expected generate to throw");
  } catch (e) {
    const err = e as { message: string; context?: Record<string, unknown> };
    expect(err.message).not.toContain(apiKey);
    expect(JSON.stringify(err.context ?? {})).not.toContain(apiKey);
  }
});

test("generate throws AI_BAD_CONFIG when no provider has the requested role", async () => {
  const db = openDb(":memory:");
  await expect(generate(db, { role: "vision", messages: [{ role: "user", content: "hi" }] }, async () => {})).rejects.toMatchObject({
    code: "AI_BAD_CONFIG",
  });
});

test("generate accumulates tokens_used and throws BUDGET_EXCEEDED past project's tokenBudget", async () => {
  const { db } = setupProvider();
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES(?,?,?,?,?)")
    .run("p1", "http://x", "single", JSON.stringify({ tokenBudget: 5 }), "draft");
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { total_tokens: 9 } }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(
    generate(db, { role: "code", messages: [{ role: "user", content: "hi" }], projectId: "p1" }, async () => {}),
  ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

  const row = db.prepare("SELECT tokens_used FROM projects WHERE id=?").get("p1") as { tokens_used: number };
  expect(row.tokens_used).toBe(9);
});
