import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { serveDir } from "@/core/serve";
import { detectNeedsAuth, autoLogin, saveSession, importStorageState } from "@/core/auth";

const fixtureDir = fileURLToPath(new URL("../fixtures/auth", import.meta.url));

let handle: BrowserHandle;
let site: { url: string; close(): Promise<void> };

beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  site = await serveDir(fixtureDir);
});

afterAll(async () => {
  await handle.close();
  await site.close();
});

test("detects 'none' on a normal page", async () => {
  const result = await withPage(handle, async (page) => {
    await page.goto(`${site.url}/index.html`);
    return detectNeedsAuth(page);
  });
  expect(result).toBe("none");
});

test("detects 'auth' on the login page", async () => {
  const result = await withPage(handle, async (page) => {
    await page.goto(`${site.url}/login.html`);
    return detectNeedsAuth(page);
  });
  expect(result).toBe("auth");
});

test("a visible position:fixed password field is 'auth'; a display:none / visibility:hidden one is not", async () => {
  const detect = (html: string) =>
    withPage(handle, async (page) => {
      await page.goto(`${site.url}/index.html`);
      await page.setContent(html);
      return detectNeedsAuth(page, { requestedUrl: `${site.url}/index.html` });
    });
  expect(await detect('<div style="position:fixed;top:0"><input type="password"></div>')).toBe("auth");
  expect(await detect('<input type="password" style="position:fixed;top:0">')).toBe("auth");
  expect(await detect('<input type="password" style="display:none">')).toBe("none");
  expect(await detect('<input type="password" style="visibility:hidden">')).toBe("none");
});

test("detects 'captcha' on a page with a recaptcha widget", async () => {
  const result = await withPage(handle, async (page) => {
    await page.goto(`${site.url}/captcha.html`);
    return detectNeedsAuth(page);
  });
  expect(result).toBe("captcha");
});

test("detects 'auth' for a 401/403 response status", async () => {
  const result = await withPage(handle, async (page) => {
    await page.goto(`${site.url}/index.html`);
    return detectNeedsAuth(page, { status: 401 });
  });
  expect(result).toBe("auth");
});

test("autoLogin with correct credentials reaches the dashboard", async () => {
  await withPage(handle, async (page) => {
    await page.goto(`${site.url}/login.html`);
    await autoLogin(page, { user: "demo@example.com", pass: "pass123" });
    expect(page.url()).toBe(`${site.url}/dashboard.html`);
  });
});

test("autoLogin with wrong credentials throws LOGIN_FAILED without leaking the password", async () => {
  await withPage(handle, async (page) => {
    await page.goto(`${site.url}/login.html`);
    let threw = false;
    try {
      await autoLogin(page, { user: "demo@example.com", pass: "not-the-real-password" });
    } catch (err) {
      threw = true;
      const appErr = err as { code?: string; message: string; context?: Record<string, unknown> };
      expect(appErr.code).toBe("LOGIN_FAILED");
      expect(appErr.message).not.toContain("not-the-real-password");
      expect(JSON.stringify(appErr.context ?? {})).not.toContain("not-the-real-password");
    }
    expect(threw).toBe(true);
  });
});

test("saveSession then importStorageState carries a cookie into a fresh context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "auth-session-"));
  const statePath = join(dir, "state.json");
  try {
    await handle.context.addCookies([{ name: "session", value: "abc123", url: site.url }]);
    await saveSession(handle.context, statePath);

    const fresh = await openBrowser({ headed: false });
    try {
      const raw: unknown = JSON.parse(await readFile(statePath, "utf8"));
      await importStorageState(fresh.context, raw);
      const cookies = await fresh.context.cookies(site.url);
      expect(cookies.some((c) => c.name === "session" && c.value === "abc123")).toBe(true);
    } finally {
      await fresh.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSession then importStorageState restores localStorage for the origin", async () => {
  const dir = await mkdtemp(join(tmpdir(), "auth-session-ls-"));
  const statePath = join(dir, "state.json");
  try {
    await withPage(handle, async (page) => {
      await page.goto(`${site.url}/index.html`);
      await page.evaluate(() => localStorage.setItem("theme", "dark"));
    });
    await saveSession(handle.context, statePath);

    const fresh = await openBrowser({ headed: false });
    try {
      const raw: unknown = JSON.parse(await readFile(statePath, "utf8"));
      await importStorageState(fresh.context, raw);
      const value = await withPage(fresh, async (page) => {
        await page.goto(`${site.url}/index.html`);
        return page.evaluate(() => localStorage.getItem("theme"));
      });
      expect(value).toBe("dark");
    } finally {
      await fresh.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
