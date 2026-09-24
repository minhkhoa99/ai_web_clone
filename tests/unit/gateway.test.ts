import { expect, test, vi, afterEach } from "vitest";
import { toRequest, parseResponse, saveProvider, updateProvider, generate, fetchModels } from "@/core/gateway";
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

test("fetchModels returns ids from a happy-path /models response", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "x" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);

  const res = await fetchModels("openai", "https://o/v1", "sk-secret-key");
  expect(res).toEqual({ models: ["x"], httpStatus: 200 });
  expect(fetchMock).toHaveBeenCalledWith("https://o/v1/models", expect.objectContaining({ headers: { Authorization: "Bearer sk-secret-key" } }));
});

test("fetchModels maps a non-2xx status the same way generate does", async () => {
  const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);

  await expect(fetchModels("anthropic", "https://a/v1", "sk-secret-key")).rejects.toMatchObject({ code: "AI_AUTH" });
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

test("openai tool call with malformed JSON arguments -> AppError AI_BAD_RESPONSE, not a SyntaxError", () => {
  const raw = { choices: [{ message: { content: "", tool_calls: [{ function: { name: "readStyle", arguments: "{not json" } }] } }] };
  expect(() => parseResponse("openai", raw)).toThrow(expect.objectContaining({ name: "AppError", code: "AI_BAD_RESPONSE" }));
});

test("provider choice: project config.providerId wins when it serves the role, else the most recently saved/updated one", async () => {
  const db = openDb(":memory:");
  const add = (name: string, roles: Record<string, string>) => saveProvider(db, { name, kind: "openai", baseUrl: `https://${name}/v1`, apiKey: "sk-x", roles });
  const a = add("a", { code: "model-a" });
  add("b", { code: "model-b" });
  const c = add("c", { vision: "model-c" });
  const seen: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: { body: string }) => {
    seen.push(`${new URL(url).host}:${(JSON.parse(init.body) as { model: string }).model}`);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1 } }), { status: 200 });
  }));
  const ask = (projectId?: string) => generate(db, { role: "code", messages: [{ role: "user", content: "hi" }], ...(projectId ? { projectId } : {}) }, async () => {});
  const project = (id: string, providerId: string) =>
    db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES(?,?,?,?,?)").run(id, "http://x", "single", JSON.stringify({ providerId }), "draft");

  await ask(); // newest with the role
  expect(updateProvider(db, a, { name: "a" })).toBe(true); // updating a makes it the newest
  await ask();
  project("p-a", a);
  project("p-c", c); // c has no code role: ignored
  expect(updateProvider(db, a, { roles: { vision: "model-a" } })).toBe(true); // a loses the code role
  await ask("p-a");
  await ask("p-c");
  expect(updateProvider(db, "missing", { name: "x" })).toBe(false);
  expect(seen).toEqual(["b:model-b", "a:model-a", "b:model-b", "b:model-b"]);
});

test("provider choice: config.providerId pins an older provider for its project only", async () => {
  const db = openDb(":memory:");
  const old = saveProvider(db, { name: "old", kind: "openai", baseUrl: "https://old/v1", apiKey: "sk-x", roles: { code: "m-old" } });
  saveProvider(db, { name: "new", kind: "openai", baseUrl: "https://new/v1", apiKey: "sk-x", roles: { code: "m-new" } });
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES(?,?,?,?,?)").run("p1", "http://x", "single", JSON.stringify({ providerId: old }), "draft");
  const hosts: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    hosts.push(new URL(url).host);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1 } }), { status: 200 });
  }));
  await generate(db, { role: "code", messages: [{ role: "user", content: "hi" }], projectId: "p1" }, async () => {});
  await generate(db, { role: "code", messages: [{ role: "user", content: "hi" }] }, async () => {});
  expect(hosts).toEqual(["old", "new"]);
});

test("updateProvider re-encrypts a new api key; omitted fields are kept", () => {
  const db = openDb(":memory:");
  const id = saveProvider(db, { name: "n", kind: "openai", baseUrl: "https://o/v1", apiKey: "sk-first-key-0000", roles: { code: "m" } });
  const before = db.prepare("SELECT * FROM providers WHERE id=?").get(id) as Record<string, string>;
  updateProvider(db, id, { apiKey: "sk-second-key-1111" });
  const after = db.prepare("SELECT * FROM providers WHERE id=?").get(id) as Record<string, string>;
  expect(after.api_key_enc).not.toBe(before.api_key_enc);
  expect(JSON.stringify(after)).not.toContain("sk-second-key-1111");
  expect([after.name, after.base_url, after.roles_json]).toEqual([before.name, before.base_url, before.roles_json]);
});

test("code role gets images only when the same provider+model also serves vision (else text-only)", async () => {
  const bodies: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1 } }), { status: 200 });
  }));
  const withRoles = async (roles: Record<string, string>, role: "code" | "vision" = "code") => {
    const db = openDb(":memory:");
    saveProvider(db, { name: "p", kind: "openai", baseUrl: "https://o/v1", apiKey: "sk-x", roles });
    await generate(db, { role, messages: [{ role: "user", content: "evidence text" }], images: ["iVBORw0KGgo="] }, async () => {});
    return bodies.at(-1)!;
  };
  expect(await withRoles({ code: "m" })).not.toContain("image_url");
  expect(await withRoles({ code: "m", vision: "other" })).not.toContain("image_url");
  expect(await withRoles({ code: "m", vision: "m" })).toContain("image_url");
  expect(await withRoles({ vision: "v" }, "vision")).toContain("image_url");
  expect(bodies.every((b) => b.includes("evidence text"))).toBe(true);
});

test("generate refuses before any request when the project's budget is already spent", async () => {
  const { db } = setupProvider();
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status,tokens_used) VALUES(?,?,?,?,?,?)").run("p1", "http://x", "single", JSON.stringify({ tokenBudget: 5 }), "draft", 5);
  const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(generate(db, { role: "code", messages: [{ role: "user", content: "hi" }], projectId: "p1" }, async () => {})).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  expect(fetchMock).not.toHaveBeenCalled();
});
