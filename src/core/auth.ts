import type { BrowserContext, Cookie, Locator, Page } from "playwright";
import { AppError, Codes } from "./errors";
import { writeJsonAtomic } from "./fsx";

const CAPTCHA_SRC = /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile/i;
const CAPTCHA_SELECTOR = ".g-recaptcha, .h-captcha, .cf-turnstile";
const LOGIN_PATH = /login|signin|auth/i;
const NAV_TIMEOUT_MS = 10_000;

function loginPathOf(url: string): boolean {
  try {
    return LOGIN_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// Single page.evaluate for both DOM checks (captcha wins over auth upstream).
async function readDomSignals(page: Page): Promise<{ hasCaptcha: boolean; hasPasswordField: boolean }> {
  return page.evaluate(
    ({ captchaSrcSource, captchaSelector }: { captchaSrcSource: string; captchaSelector: string }) => {
      const captchaSrcRe = new RegExp(captchaSrcSource, "i");
      const hasCaptchaSrc = [...document.querySelectorAll("iframe[src], script[src]")].some((el) =>
        captchaSrcRe.test(el.getAttribute("src") ?? ""),
      );
      const hasCaptchaEl = document.querySelector(captchaSelector) !== null;
      const pwField = document.querySelector('input[type="password"]') as HTMLElement | null;
      return {
        hasCaptcha: hasCaptchaSrc || hasCaptchaEl,
        hasPasswordField: pwField !== null && pwField.offsetParent !== null,
      };
    },
    { captchaSrcSource: CAPTCHA_SRC.source, captchaSelector: CAPTCHA_SELECTOR },
  );
}

export async function detectNeedsAuth(
  page: Page,
  opts?: { status?: number; requestedUrl?: string },
): Promise<"none" | "auth" | "captcha"> {
  const { hasCaptcha, hasPasswordField } = await readDomSignals(page);
  if (hasCaptcha) return "captcha";
  if (hasPasswordField) return "auth";
  if (opts?.status === 401 || opts?.status === 403) return "auth";

  const redirectedToLogin = loginPathOf(page.url()) && !(opts?.requestedUrl && loginPathOf(opts.requestedUrl));
  return redirectedToLogin ? "auth" : "none";
}

// Heuristic user-field locator: type=email/name*=user|email|login, else the
// first text input inside the password field's own <form>.
async function resolveUserLocator(page: Page, override?: string): Promise<Locator | null> {
  if (override) return page.locator(override).first();
  const candidates = ['input[type="email"]', 'input[name*="user" i]', 'input[name*="email" i]', 'input[name*="login" i]'];
  for (const selector of candidates) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0) return locator;
  }
  const inSameForm = page
    .locator('input[type="password"]')
    .first()
    .locator('xpath=ancestor::form[1]//input[@type="text" or not(@type)]')
    .first();
  return (await inSameForm.count()) > 0 ? inSameForm : null;
}

export async function autoLogin(
  page: Page,
  opts: { user: string; pass: string; selectors?: { user?: string; pass?: string; submit?: string } },
): Promise<void> {
  const passField = page.locator(opts.selectors?.pass ?? 'input[type="password"]').first();
  const userField = await resolveUserLocator(page, opts.selectors?.user);
  if (userField) await userField.fill(opts.user);
  await passField.fill(opts.pass);

  const requestedUrl = page.url();
  const submitButton = page.locator(opts.selectors?.submit ?? 'button[type="submit"], input[type="submit"]').first();
  const submit = (await submitButton.count()) > 0 ? submitButton.click() : passField.press("Enter");
  await Promise.all([page.waitForURL((url) => url.toString() !== requestedUrl, { timeout: NAV_TIMEOUT_MS }).catch(() => {}), submit]);

  const result = await detectNeedsAuth(page, { requestedUrl });
  if (result === "captcha") {
    throw new AppError(Codes.CAPTCHA_REQUIRED, "captcha appeared during login", { url: page.url() });
  }
  if (result === "auth") {
    throw new AppError(Codes.LOGIN_FAILED, "login failed: still on the auth page", { url: page.url() });
  }
}

// Atomic like the checkpoint invariant: write tmp then rename, never a
// half-written session file on the target path.
export async function saveSession(context: BrowserContext, path: string): Promise<void> {
  await writeJsonAtomic(path, await context.storageState());
}

type StorageStateOrigin = { origin: string; localStorage?: { name: string; value: string }[] };

function validateStorageState(json: unknown): { cookies: Cookie[]; origins: StorageStateOrigin[] } {
  if (typeof json !== "object" || json === null) {
    throw new AppError(Codes.AUTH_REQUIRED, "invalid storage state: not an object", { type: typeof json });
  }
  const { cookies, origins } = json as { cookies?: unknown; origins?: unknown };
  if (cookies !== undefined && !Array.isArray(cookies)) {
    throw new AppError(Codes.AUTH_REQUIRED, "invalid storage state: cookies must be an array", { type: typeof cookies });
  }
  if (origins !== undefined && !Array.isArray(origins)) {
    throw new AppError(Codes.AUTH_REQUIRED, "invalid storage state: origins must be an array", { type: typeof origins });
  }
  return { cookies: (cookies as Cookie[] | undefined) ?? [], origins: (origins as StorageStateOrigin[] | undefined) ?? [] };
}

const IMPORTED_SESSION_COOKIE_TTL_S = 7 * 24 * 3600;
const MAX_IMPORT_ORIGINS = 50;

// Works on a persistent profile too: a session cookie (no expiry) would vanish when the profile closes, so it
// is kept for 7 days; localStorage is written now, on a stub page per origin (nothing is fetched from the network).
export async function importStorageState(context: BrowserContext, json: unknown): Promise<void> {
  const { cookies, origins } = validateStorageState(json);
  const until = Math.floor(Date.now() / 1000) + IMPORTED_SESSION_COOKIE_TTL_S;
  if (cookies.length > 0) await context.addCookies(cookies.map((c) => (c.expires === undefined || c.expires < 0 ? { ...c, expires: until } : c)));

  // Sequential, capped: one stub page at a time.
  for (const o of origins.filter((x) => x.localStorage && x.localStorage.length > 0).slice(0, MAX_IMPORT_ORIGINS)) {
    const url = URL.parse(o.origin);
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) {
      throw new AppError(Codes.AUTH_REQUIRED, "invalid storage state: origin must be an http(s) URL", {});
    }
    const page = await context.newPage();
    try {
      await page.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "" }));
      await page.goto(url.origin + "/");
      await page.evaluate((entries) => {
        for (const { name, value } of entries) window.localStorage.setItem(name, value);
      }, o.localStorage ?? []);
    } finally {
      await page.close();
    }
  }
}
