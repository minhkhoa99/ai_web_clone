import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { serveDir } from "@/core/serve";

const fixtureDir = fileURLToPath(new URL("../fixtures/site3", import.meta.url));

let site: { url: string; close(): Promise<void> };

beforeAll(async () => {
  site = await serveDir(fixtureDir);
});

afterAll(async () => {
  await site.close();
});

test("serves an existing file with the right content-type", async () => {
  const res = await fetch(`${site.url}/index.html`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("<title>Home</title>");
});

test("returns 404 for a missing file", async () => {
  const res = await fetch(`${site.url}/nope.html`);
  expect(res.status).toBe(404);
});

test("returns 400 instead of crashing on a malformed %-escape", async () => {
  const res = await fetch(`${site.url}/%zz`);
  expect(res.status).toBe(400);
});
