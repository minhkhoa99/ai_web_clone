import { afterEach, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Codes } from "@/core/errors";
import { api } from "@/app/_ui/api";
import { ERROR_HINTS, hintFor } from "@/app/_ui/error-hints";

afterEach(() => vi.unstubAllGlobals());

// The hint table is the spec's (hardening §4): every code row there, verbatim; grouped rows give each code the same text.
test("ERROR_HINTS is exactly the spec §4 table", () => {
  const spec = readFileSync("docs/superpowers/specs/2026-09-26-sp1-realrun-hardening-design.md", "utf8");
  const table = spec.slice(spec.indexOf("Bảng gợi ý"), spec.indexOf("## 5."));
  const expected: Record<string, string> = {};
  for (const [, codes, hint] of table.matchAll(/^\| (`[A-Z_]+`(?:(?: \/ |, )`[A-Z_]+`)*) \| (.+) \|$/gm)) {
    for (const [, code] of codes!.matchAll(/`([A-Z_]+)`/g)) expected[code!] = hint!;
  }
  expect(Object.keys(expected).length).toBeGreaterThan(15);
  // E4 adds one API-only hint beyond the hardening spec's table (CHAT_BUSY, E4 Task 6)
  expect(ERROR_HINTS).toEqual({ ...expected, CHAT_BUSY: ERROR_HINTS.CHAT_BUSY });
  expect(ERROR_HINTS.CHAT_BUSY).toMatch(/chat AI/);
  // every table code the engine raises is a real Codes key (the others are API-only codes)
  const apiOnly = ["PROJECT_BUSY", "BAD_STATE", "CHAT_BUSY"];
  for (const code of Object.keys(ERROR_HINTS)) expect(code in Codes || apiOnly.includes(code), code).toBe(true);
  expect(hintFor("AI_QUOTA")).toBe(ERROR_HINTS.AI_QUOTA);
  expect([hintFor("NOPE"), hintFor("constructor"), hintFor(null)]).toEqual([undefined, undefined, undefined]);
});

const failWith = (status: number, body: unknown) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status, statusText: "Conflict", headers: { "content-type": "application/json" } })));

test("api(): a known code reads as its hint (+ the server message); an unknown code keeps `code: message`", async () => {
  failWith(409, { code: "PROJECT_BUSY", message: "Đang chạy, thử lại sau 15 s." });
  await expect(api("/x")).rejects.toThrow(`${ERROR_HINTS.PROJECT_BUSY} (Đang chạy, thử lại sau 15 s.)`);
  failWith(429, { code: "QUEUE_FULL", message: "" });
  await expect(api("/x")).rejects.toMatchObject({ message: ERROR_HINTS.QUEUE_FULL, code: "QUEUE_FULL" });
  failWith(400, { code: "VALIDATION", message: "url: bad" });
  await expect(api("/x")).rejects.toMatchObject({ message: "VALIDATION: url: bad" });
  failWith(409, {});
  await expect(api("/x")).rejects.toMatchObject({ message: "409: Conflict" });
  // a stale edit: the error keeps the current revision, for the editor's reload prompt
  failWith(409, { code: "STALE_REVISION", message: "document is at revision 7, not 6", revision: 7 });
  await expect(api("/x")).rejects.toMatchObject({ code: "STALE_REVISION", revision: 7 });
});
