# SP1 Clone Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Xây clone engine tất định: thả URL → capture UI đầy đủ (kể cả tương tác ẩn) → dựng IR/graph → xuất HTML → QA pixel-diff theo section + fix loop, có lịch sử và resume.

**Architecture:** Một process Next.js (App Router) chạy local. `app/` mỏng chỉ gọi `core/`. Pipeline chạy tất định trong `core/`, AI chỉ can thiệp ở đặt tên section và fix section fail. Trạng thái ở SQLite (`node:sqlite`) + `workspace/<projectId>/`. Tiến độ qua SSE.

**Tech Stack:** Node 24+ (`node:sqlite`, `node:crypto`), Next.js 16 (App Router, TS strict), Playwright (`connectOverCDP` Chrome thật), pixelmatch + pngjs, GrapesJS (editor), shiki (code view), zod (validate), Vitest + Playwright test.

**Spec:** `docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md`

## Global Constraints

- Tuân thủ `rules.md`: lean, không over-engineering, không abstraction thừa, early return, 1 function 1 trách nhiệm, bounded workload, không sequential await cho op độc lập, error có context, resource có lifecycle rõ.
- **Mọi workload bounded.** Giới hạn cứng theo bảng mục 1 của spec. Không `Promise.all` trên mảng không bounded; input lớn → concurrency limit.
- TS strict mode. Không `any` trừ ranh giới `evaluate` (browser context) có comment.
- `core/` không import từ `app/`. Hướng phụ thuộc: `jobs → (crawl|capture|qa|emit) → (browser|graph|ir|gateway)`.
- `ir.ts`, `emit-html.ts`, dedupe, hash, `applyPatch` phải **thuần** (không I/O), test không cần browser/AI.
- Secret (API key, mật khẩu) mã hóa AES-256-GCM (`node:crypto`), khóa ở file local ngoài `workspace/`. Không log, không gửi AI, không vào graph/output.
- Commit thường xuyên, mỗi task ≥1 commit. TDD: test fail trước, code sau.

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, next.config.ts, playwright.config.ts
src/
  core/
    config.ts           # đọc env, đường dẫn workspace, khóa mã hóa
    crypto.ts           # AES-256-GCM encrypt/decrypt
    db.ts               # node:sqlite: mở, migrate, WAL, helper
    gateway.ts          # AI provider Anthropic/OpenAI compatible
    auth.ts             # phát hiện login/CAPTCHA, login, phiên
    browser.ts          # connectOverCDP / launch, page pool
    crawl.ts            # BFS cùng origin + sitemap
    capture.ts          # chụp 1 trang (DOM/style/asset/shot/tương tác)
    dedupe.ts           # dedupe style, hash section/component, token
    ir.ts               # kiểu IR, buildIR, applyPatch
    graph.ts            # nodes/edges + truy vấn ngữ cảnh
    emit-html.ts        # IR → HTML/CSS/runtime JS
    inspector.ts        # lệnh rà soát cho fix loop
    qa.ts               # pixel diff theo section + fix loop
    jobs.ts             # queue bounded, task checkpoint, SSE bus
    url.ts              # chuẩn hóa URL
    assets.ts           # tải + dedupe asset
    errors.ts           # mã lỗi + AppError
  app/
    (routes + API — Phase 8)
tests/
  unit/*.test.ts
  fixtures/site1|site2|site3/   # static site test
  e2e/*.test.ts
workspace/<projectId>/          # runtime, gitignore
```

---

## Phase 0 — Scaffold

### Task 0: Project scaffold + tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/core/errors.ts`
- Test: `tests/unit/errors.test.ts`

**Interfaces:**
- Produces: `class AppError extends Error { code: string; context?: Record<string,unknown> }`; `errors.ts` export các mã: `NAV_TIMEOUT, BROWSER_CRASH, AUTH_REQUIRED, CAPTCHA_REQUIRED, LOGIN_FAILED, ROBOTS_DISALLOWED, ASSET_TOO_LARGE, NODE_LIMIT, PROJECT_SIZE_LIMIT, AI_RATE_LIMIT, AI_AUTH, AI_BAD_CONFIG, AI_BAD_RESPONSE, BUDGET_EXCEEDED`.

- [ ] **Step 1: Init package + deps**

```bash
cd D:/ai_web_clone
npm init -y
npm i next@16 react@19 react-dom@19 playwright@1 pixelmatch pngjs zod shiki grapesjs
npm i -D typescript @types/node @types/react @types/pngjs vitest
npx playwright install chromium
```

- [ ] **Step 2: tsconfig strict**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noUncheckedIndexedAccess": true, "skipLibCheck": true,
    "jsx": "preserve", "baseUrl": ".", "paths": { "@/*": ["src/*"] },
    "lib": ["ES2023", "DOM", "DOM.Iterable"], "types": ["node"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: vitest.config + gitignore**

`vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/unit/**/*.test.ts"] } });
```
`.gitignore`: add `node_modules/`, `workspace/`, `.next/`, `secret.key`, `test-results/`.

- [ ] **Step 4: Write failing test for errors.ts**

`tests/unit/errors.test.ts`:
```ts
import { expect, test } from "vitest";
import { AppError, Codes } from "@/core/errors";
test("AppError carries code + context", () => {
  const e = new AppError(Codes.NAV_TIMEOUT, "nav timed out", { url: "x" });
  expect(e.code).toBe("NAV_TIMEOUT");
  expect(e.context?.url).toBe("x");
  expect(e).toBeInstanceOf(Error);
});
```

- [ ] **Step 5: Run — verify fail** — `npx vitest run tests/unit/errors.test.ts` → FAIL (module missing)

- [ ] **Step 6: Implement `src/core/errors.ts`**

```ts
export const Codes = {
  NAV_TIMEOUT: "NAV_TIMEOUT", BROWSER_CRASH: "BROWSER_CRASH",
  AUTH_REQUIRED: "AUTH_REQUIRED", CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
  LOGIN_FAILED: "LOGIN_FAILED", ROBOTS_DISALLOWED: "ROBOTS_DISALLOWED",
  ASSET_TOO_LARGE: "ASSET_TOO_LARGE", NODE_LIMIT: "NODE_LIMIT",
  PROJECT_SIZE_LIMIT: "PROJECT_SIZE_LIMIT", AI_RATE_LIMIT: "AI_RATE_LIMIT",
  AI_AUTH: "AI_AUTH", AI_BAD_CONFIG: "AI_BAD_CONFIG",
  AI_BAD_RESPONSE: "AI_BAD_RESPONSE", BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
} as const;
export type Code = keyof typeof Codes;
export class AppError extends Error {
  constructor(public code: Code, message: string, public context?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
  }
}
```

- [ ] **Step 7: Run — verify pass** — `npx vitest run tests/unit/errors.test.ts` → PASS

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore src/core/errors.ts tests/unit/errors.test.ts
git commit -m "chore: scaffold SP1 project + error codes"
```

---

## Phase 1 — Foundations: config, crypto, db

### Task 1: Config + AES-256-GCM crypto

**Files:**
- Create: `src/core/config.ts`, `src/core/crypto.ts`
- Test: `tests/unit/crypto.test.ts`

**Interfaces:**
- Produces: `config` object `{ workspaceRoot: string, dbPath: string, keyPath: string }`; `encrypt(plain: string): string` (trả `base64(iv|tag|ct)`), `decrypt(blob: string): string`. Khóa 32 byte đọc/ tạo tại `config.keyPath` (0600).

- [ ] **Step 1: Failing test**

`tests/unit/crypto.test.ts`:
```ts
import { expect, test } from "vitest";
import { encrypt, decrypt } from "@/core/crypto";
test("roundtrip", () => {
  const s = "sk-secret-123";
  const blob = encrypt(s);
  expect(blob).not.toContain(s);
  expect(decrypt(blob)).toBe(s);
});
test("tamper detected", () => {
  const blob = encrypt("x");
  const bad = Buffer.from(blob, "base64"); bad[bad.length - 1] ^= 0xff;
  expect(() => decrypt(bad.toString("base64"))).toThrow();
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement config.ts**

```ts
import { join } from "node:path";
const root = process.env.WORKSPACE_ROOT ?? join(process.cwd(), "workspace");
export const config = {
  workspaceRoot: root,
  dbPath: process.env.DB_PATH ?? join(process.cwd(), "sp1.db"),
  keyPath: process.env.KEY_PATH ?? join(process.cwd(), "secret.key"),
};
```

- [ ] **Step 4: Implement crypto.ts**

```ts
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { config } from "./config.js";

function key(): Buffer {
  if (!existsSync(config.keyPath)) writeFileSync(config.keyPath, randomBytes(32), { mode: 0o600 });
  const k = readFileSync(config.keyPath);
  if (k.length !== 32) throw new Error("secret.key must be 32 bytes");
  return k;
}
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function decrypt(blob: string): string {
  const b = Buffer.from(blob, "base64");
  const iv = b.subarray(0, 12), tag = b.subarray(12, 28), ct = b.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}
```

- [ ] **Step 5: Run — pass** — set `KEY_PATH` tạm trong test qua env nếu cần; PASS

- [ ] **Step 6: Commit** — `git commit -m "feat: config + AES-256-GCM crypto for secrets"`

### Task 2: SQLite layer + migrations

**Files:**
- Create: `src/core/db.ts`
- Test: `tests/unit/db.test.ts`

**Interfaces:**
- Produces: `openDb(path: string): DatabaseSync` (bật `journal_mode=WAL`, `synchronous=FULL`, chạy migrations idempotent). Bảng: `projects`, `tasks`, `providers`, `nodes`, `edges` đúng schema spec mục 4 & 7. Helper `tx(db, fn)` chạy trong transaction.

- [ ] **Step 1: Failing test**

`tests/unit/db.test.ts`:
```ts
import { expect, test } from "vitest";
import { openDb } from "@/core/db";
test("migrate + insert project", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES(?,?,?,?,?)")
    .run("p1", "http://x", "single", "{}", "draft");
  const row = db.prepare("SELECT status FROM projects WHERE id=?").get("p1") as any;
  expect(row.status).toBe("draft");
});
test("tasks UNIQUE(project_id,phase,key)", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,?,?,?)").run("t1","p","capture","/a","pending");
  expect(() => db.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,?,?,?)").run("t2","p","capture","/a","pending")).toThrow();
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement db.ts** (migrations inline, dùng `CREATE TABLE IF NOT EXISTS`)

```ts
import { DatabaseSync } from "node:sqlite";
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,url TEXT,mode TEXT,config_json TEXT,status TEXT,progress INTEGER DEFAULT 0,tokens_used INTEGER DEFAULT 0,created_at INTEGER DEFAULT (unixepoch()),updated_at INTEGER DEFAULT (unixepoch()));`,
  `CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,project_id TEXT,phase TEXT,key TEXT,status TEXT,attempts INTEGER DEFAULT 0,output_path TEXT,error_code TEXT,error_msg TEXT,updated_at INTEGER DEFAULT (unixepoch()),UNIQUE(project_id,phase,key));`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_ps ON tasks(project_id,status);`,
  `CREATE TABLE IF NOT EXISTS providers(id TEXT PRIMARY KEY,name TEXT,kind TEXT,base_url TEXT,api_key_enc TEXT,roles_json TEXT);`,
  `CREATE TABLE IF NOT EXISTS nodes(id TEXT,project_id TEXT,type TEXT,key TEXT,data_json TEXT,PRIMARY KEY(project_id,id));`,
  `CREATE TABLE IF NOT EXISTS edges(project_id TEXT,src TEXT,dst TEXT,type TEXT);`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_pt ON nodes(project_id,type);`,
  `CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src,type);`,
  `CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst,type);`,
];
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
  for (const m of MIGRATIONS) db.exec(m);
  return db;
}
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
}
```

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Commit** — `git commit -m "feat: sqlite layer + migrations"`

### Task 3: URL normalization

**Files:**
- Create: `src/core/url.ts`
- Test: `tests/unit/url.test.ts`

**Interfaces:**
- Produces: `normalizeUrl(raw: string, base?: string): string | null` (null nếu không phải http(s) hoặc khác origin khi có base cùng-origin check ở crawl); `sameOrigin(a,b): boolean`; `isHtmlLike(url): boolean`.

- [ ] **Step 1: Failing test**

```ts
import { expect, test } from "vitest";
import { normalizeUrl, sameOrigin, isHtmlLike } from "@/core/url";
test("strips tracking + hash + trailing slash", () => {
  expect(normalizeUrl("https://x.com/a/?utm_source=z&b=1#top"))
    .toBe("https://x.com/a?b=1");
});
test("resolves relative", () => {
  expect(normalizeUrl("../b", "https://x.com/a/c")).toBe("https://x.com/b");
});
test("rejects non-http", () => {
  expect(normalizeUrl("mailto:a@b.com")).toBeNull();
});
test("isHtmlLike false for assets", () => {
  expect(isHtmlLike("https://x.com/a.png")).toBe(false);
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** using `URL`. Strip params matching `/^(utm_|fbclid|gclid|mc_)/`, sort remaining, drop hash, drop trailing `/` (except root). `isHtmlLike`: reject known asset extensions.

```ts
const DROP = /^(utm_|fbclid$|gclid$|mc_)/;
const ASSET = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|mjs|json|xml|pdf|zip|mp4|webm|woff2?|ttf|eot|map)$/i;
export function normalizeUrl(raw: string, base?: string): string | null {
  let u: URL;
  try { u = new URL(raw, base); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  const keep = [...u.searchParams.entries()].filter(([k]) => !DROP.test(k)).sort();
  u.search = ""; for (const [k, v] of keep) u.searchParams.append(k, v);
  let s = u.toString();
  if (u.pathname !== "/" && s.endsWith("/")) s = s.slice(0, -1);
  return s;
}
export function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
export function isHtmlLike(url: string): boolean {
  try { return !ASSET.test(new URL(url).pathname); } catch { return false; }
}
```

- [ ] **Step 4: Run — pass**  — [ ] **Step 5: Commit** — `git commit -m "feat: url normalization"`

---

## Phase 2 — AI Gateway

### Task 4: Gateway — provider adapters + generate

**Files:**
- Create: `src/core/gateway.ts`
- Test: `tests/unit/gateway.test.ts`

**Interfaces:**
- Consumes: `crypto.decrypt`, `db`, `AppError`.
- Produces:
  - `saveProvider(db, {name,kind:'anthropic'|'openai',baseUrl,apiKey,roles})`
  - `fetchModels(kind, baseUrl, apiKey): Promise<string[]>`
  - `generate(db, { role:'vision'|'code'|'design', messages, images?, tools?, jsonSchema?, projectId? }): Promise<{ text: string, toolCalls?: {name:string,args:any}[], tokens: number }>`
  - Timeout 120s, retry 2 + exponential backoff; map lỗi HTTP → `AI_RATE_LIMIT|AI_AUTH|AI_BAD_CONFIG`. Với `projectId`, cộng `tokens` vào `projects.tokens_used`; nếu vượt `config.tokenBudget` → throw `BUDGET_EXCEEDED`.

- [ ] **Step 1: Failing test** (mock global `fetch`, cả 2 kind)

```ts
import { expect, test, vi } from "vitest";
import { toRequest, parseResponse } from "@/core/gateway";
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
  expect(p.text).toBe("ok"); expect(p.tokens).toBe(5);
});
```

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** — tách `toRequest`/`parseResponse` (thuần, test được) khỏi `generate` (I/O). `generate` gọi `fetch` với `AbortSignal.timeout(120000)`, retry vòng for ≤2 với backoff `500*2^i` ms; đọc `retry-after` cho 429. Ánh xạ tool-call về `{name,args}` cho cả 2 chuẩn.

- [ ] **Step 4: Run — pass**

- [ ] **Step 5: Test generate with mocked fetch** (retry 429 rồi thành công) → add test, implement to pass.

- [ ] **Step 6: Commit** — `git commit -m "feat: AI gateway (anthropic + openai compatible)"`

---

## Phase 3 — Browser + Crawl + Auth

### Task 5: Browser pool

**Files:**
- Create: `src/core/browser.ts`
- Test: `tests/e2e/browser.test.ts` (dùng Playwright thật, headless launch fallback)

**Interfaces:**
- Produces: `openBrowser({ profileDir?, headed? }): Promise<Browser>` (thử `connectOverCDP(process.env.CDP_URL)` nếu có, else `chromium.launchPersistentContext(profileDir)` / `chromium.launch`); `withPage(browser, fn, {timeout})` mở page, chạy fn, đóng trong `finally`; pool giới hạn qua semaphore `maxPages` (mặc định 3).

- [ ] **Step 1: Failing test** — `withPage` navigate `data:text/html,<h1>hi` và đọc title; đảm bảo page đóng sau đó (context.pages().length giảm).

- [ ] **Step 2: Run — fail**

- [ ] **Step 3: Implement** — semaphore đơn giản (mảng promise), `try/finally` đóng page. Không giữ browser global leak: caller đóng.

- [ ] **Step 4: Run — pass** — `npx playwright test tests/e2e/browser.test.ts` (hoặc vitest với include e2e). Cấu hình `playwright.config.ts` trỏ testDir `tests/e2e`.

- [ ] **Step 5: Commit** — `git commit -m "feat: browser pool with connectOverCDP + launch fallback"`

### Task 6: Semaphore util + concurrency map

**Files:**
- Create: `src/core/limit.ts`
- Test: `tests/unit/limit.test.ts`

**Interfaces:**
- Produces: `mapLimit<T,R>(items: T[], limit: number, fn: (t:T,i:number)=>Promise<R>): Promise<R[]>` — bounded concurrency, giữ thứ tự kết quả, dừng nạp mới khi 1 task throw (nhưng chờ các task đang chạy settle rồi reject).

- [ ] **Step 1: Failing test** — 10 item, limit 3, đếm max concurrent = 3; kết quả đúng thứ tự.

- [ ] **Step 2: fail → 3: implement → 4: pass → 5: commit** — `git commit -m "feat: bounded mapLimit"`

*(Task 6 nằm trước capture/asset vì cả hai dùng nó.)*

### Task 7: Crawl + robots

**Files:**
- Create: `src/core/crawl.ts`
- Test: `tests/e2e/crawl.test.ts` (dùng fixture site3 nhiều trang)

**Interfaces:**
- Consumes: `browser.withPage`, `url.normalizeUrl/sameOrigin/isHtmlLike`, `mapLimit`.
- Produces: `crawl(browser, { start, depth, maxPages, sameOriginOnly:true }): Promise<{ url:string, needsAuth:boolean }[]>` — BFS: đọc `sitemap.xml` nếu có + `a[href]`, chuẩn hóa, dedupe, tôn trọng `robots.txt` (nếu disallow → bỏ), delay 500ms/origin, dừng ở `maxPages`/`depth`. `needsAuth` do `auth.detectNeedsAuth` (Task 8) đánh dấu.

- [ ] **Step 1: Failing test** — crawl fixture site3 (3 trang, có link chéo) depth 2 → trả đúng 3 URL, không trùng.

- [ ] **Step 2: fail → 3: implement → 4: pass → 5: commit** — `git commit -m "feat: bounded same-origin crawler"`

### Task 8: Auth detection + login + session

**Files:**
- Create: `src/core/auth.ts`
- Test: `tests/e2e/auth.test.ts` (fixture site có `/login` với `input[type=password]`)

**Interfaces:**
- Consumes: `browser`, `crypto`, `AppError`.
- Produces:
  - `detectNeedsAuth(page): Promise<'none'|'auth'|'captcha'>` — kiểm `input[type=password]`, redirect `login|signin|auth`, HTTP 401/403 (từ response listener), iframe/script reCAPTCHA/hCaptcha/Turnstile.
  - `autoLogin(page, { user, pass, selectors? }): Promise<void>` — điền form heuristic, submit, chờ điều hướng; captcha xuất hiện → throw `CAPTCHA_REQUIRED`; sai đăng nhập (vẫn ở trang login) → throw `LOGIN_FAILED` (không retry).
  - `saveSession(context, profileDir)` / dùng lại qua `launchPersistentContext(profileDir)`; `importStorageState(context, json)`.

- [ ] **Step 1: Failing test** — `detectNeedsAuth` trả `'auth'` trên fixture `/login`; trả `'none'` trên trang thường.

- [ ] **Step 2: fail → 3: implement → 4: pass**

- [ ] **Step 5: Test autoLogin** — điền đúng creds fixture → chuyển sang `/dashboard`; sai → `LOGIN_FAILED`. Implement to pass.

- [ ] **Step 6: Commit** — `git commit -m "feat: auth detection + auto-login + session reuse"`

---

## Phase 4 — Capture

### Task 9: DOM + computed style snapshot (single evaluate)

**Files:**
- Create: `src/core/capture.ts` (phần snapshot); `src/core/capture-eval.ts` (hàm chạy trong page context)
- Test: `tests/e2e/capture-dom.test.ts` (fixture site1)

**Interfaces:**
- Produces: `snapshotDom(page): Promise<CaptureNode>` where
  `CaptureNode = { tag:string, attrs:Record<string,string>, text?:string, bbox:[number,number,number,number], style:Record<string,string>, pseudo?:{before?:Record<string,string>,after?:Record<string,string>}, hidden?:boolean, children:CaptureNode[] }`.
  Một lần `page.evaluate`: duyệt cây, computed style **trừ default của tag** (default tính 1 lần/tag trong iframe sạch, cache). Trần 20.000 node → throw `NODE_LIMIT`. Gồm `::before/::after`, shadow DOM open, iframe cùng origin (inline subtree).

- [ ] **Step 1: Failing test** — snapshot fixture site1 → root tag `html`, tồn tại node có `text` = tiêu đề, style có `color` đã set (không có mọi default).

- [ ] **Step 2: fail → 3: implement** (chú ý: hàm eval là string-serializable, không import ngoài; `any` cho DOM có comment) → 4: pass

- [ ] **Step 5: Commit** — `git commit -m "feat: single-pass DOM + computed style snapshot"`

### Task 10: Responsive + screenshots + CSSOM

**Files:** Modify `src/core/capture.ts`; Test `tests/e2e/capture-responsive.test.ts`

**Interfaces:**
- Produces: `captureResponsive(page): Promise<{ bp: 375|768|1440, dom: CaptureNode, shot: Buffer }[]>` (setViewport → lazy-load scroll → snapshot + full-page png mỗi bp). `readCssom(page): Promise<{ keyframes:string[], fontFace:string[], media:string[], vars:Record<string,string> }>` — đọc mọi styleSheets, sheet khác origin fetch text.

- [ ] **Step 1: Failing test** — 3 bp trả 3 phần tử, shot là PNG (magic byte `\x89PNG`).

- [ ] **Step 2: fail → 3: implement** — lazy-load helper: cuộn ≤50 bước/30.000px, `img.decode()`, về đầu; infinite-scroll dừng ở trần.

- [ ] **Step 4: pass → 5: commit** — `git commit -m "feat: responsive capture + screenshots + CSSOM read"`

### Task 11: Hidden interaction scan

**Files:** Create `src/core/interactions.ts`; Test `tests/e2e/interactions.test.ts` (fixture site2: menu/tab/modal/carousel/hover)

**Interfaces:**
- Produces: `scanInteractions(page): Promise<Interaction[]>` where
  `Interaction = { id:string, kind:'hover'|'menu'|'tab'|'accordion'|'modal'|'carousel'|'sticky'|'form', trigger:string /*selector*/, styleDelta?:Record<string,string>, subtreeHtml?:string, status:'captured'|'failed'|'skipped' }`.
  Phát hiện theo bảng spec mục 6. Sau mỗi thao tác khôi phục (Esc/click lại/reload). Giới hạn 300 tương tác, 5s/cái (`Promise.race` timeout), tổng 5 phút.

- [ ] **Step 1: Failing test** — site2 → có ít nhất 1 `menu`, 1 `tab`, 1 `modal` với `status:'captured'`.

- [ ] **Step 2: fail → 3: implement** (mỗi loại 1 hàm nhỏ; MutationObserver bắt subtree qua `page.evaluate` + `exposeBinding` hoặc poll DOM) → 4: pass

- [ ] **Step 5: Commit** — `git commit -m "feat: hidden interaction scanner"`

### Task 12: Asset download + dedupe

**Files:** Create `src/core/assets.ts`; Test `tests/e2e/assets.test.ts`

**Interfaces:**
- Consumes: `mapLimit`, `AppError`.
- Produces: `collectAssetUrls(page, dom): string[]` (network responses + DOM: img/srcset/picture/video/poster/background-image/font/svg-sprite/favicon/og); `downloadAssets(context, urls, destDir): Promise<Map<string,string>>` (url→relPath). Dedupe sha256 nội dung; 6 song song (mapLimit); >25MB/file → skip `ASSET_TOO_LARGE`; tổng >500MB → `PROJECT_SIZE_LIMIT`; timeout 30s, retry 2. Tải qua `context.request` (giữ cookie).

- [ ] **Step 1: Failing test** — tải 2 URL trùng nội dung → 1 file, map 2 key trỏ cùng path.

- [ ] **Step 2: fail → 3: implement → 4: pass → 5: commit** — `git commit -m "feat: bounded asset download + content dedupe"`

### Task 13: Capture orchestrator (1 page → capture.json)

**Files:** Modify `src/core/capture.ts`; Test `tests/e2e/capture-page.test.ts`

**Interfaces:**
- Consumes: 9–12.
- Produces: `capturePage(browser, context, { url, pageId, workspaceDir }): Promise<PageCapture>` — chạy responsive + cssom + interactions + assets, ghi `pages/<pageId>/capture.json` (atomic tmp→rename) + `shots/<bp>.png`, trả metadata. Giải phóng RAM sau ghi.

- [ ] **Step 1: Failing test** — capture site1 → file `capture.json` tồn tại, có `dom`, `cssom`, `interactions`, `assets`, `shots` paths.

- [ ] **Step 2: fail → 3: implement → 4: pass → 5: commit** — `git commit -m "feat: single-page capture orchestrator"`

---

## Phase 5 — IR + Graph

### Task 14: Style dedupe + section/component hash + tokens

**Files:** Create `src/core/dedupe.ts`; Test `tests/unit/dedupe.test.ts` (thuần, input JSON)

**Interfaces:**
- Produces:
  - `dedupeStyles(nodes): { classMap: Map<nodeId,string[]>, classes: Record<className,Record<string,string>> }` — mỗi tập khai báo duy nhất → `.s-<hash6>`.
  - `structuralHash(node): string` — cây tag+class, bỏ text.
  - `extractTokens(nodes): Record<string,string>` — đếm tần suất màu/font/size/spacing/radius/shadow, trên ngưỡng → `--token`, giữ nguyên giá trị.
  - `hash6(s): string` (sha256 cắt 6).

- [ ] **Step 1: Failing test** — 3 node cùng style → cùng 1 class; 2 section cùng cấu trúc khác text → cùng `structuralHash`.

- [ ] **Step 2: fail → 3: implement → 4: pass → 5: commit** — `git commit -m "feat: style dedupe + structural hash + tokens"`

### Task 15: IR types + buildIR + applyPatch

**Files:** Create `src/core/ir.ts`; Test `tests/unit/ir.test.ts` (thuần)

**Interfaces:**
- Consumes: `dedupe`.
- Produces:
  - Types `IRNode, Section, Page` (spec mục 7, có `origin:'capture'|'ai'`).
  - `buildIR(captures: PageCapture[]): { pages: Page[], sections: Section[], layouts: Layout[], components: Component[], classes, tokens }` — tách section (landmark/main-children/full-width>100px), merge breakpoint diff → media, dedupe layout (hash ≥2 trang) + component (≥3 anh em).
  - `applyPatch(ir, ops: PatchOp[]): IR` thuần; `PatchOp = {op:'setStyle',id,style} | {op:'setAttr',id,attrs} | {op:'setText',id,text} | {op:'replaceSubtree',id,node} | {op:'setBehavior',id,behavior}`. Op id không tồn tại → throw có context.

- [ ] **Step 1: Failing test** — buildIR 2 trang cùng header → 1 layout, 2 page tham chiếu; applyPatch setText đổi đúng node, immutable (input không đổi).

- [ ] **Step 2: fail → 3: implement → 4: pass → 5: commit** — `git commit -m "feat: IR build + applyPatch"`

### Task 16: Graph store + context queries

**Files:** Create `src/core/graph.ts`; Test `tests/unit/graph.test.ts` (dùng `:memory:` db)

**Interfaces:**
- Consumes: `db`.
- Produces:
  - `writeGraph(db, projectId, ir): void` — ghi nodes (Page/Section/Layout/Component/Token/Asset/Interaction) + edges (HAS_SECTION/USES_LAYOUT/INSTANCE_OF/USES_TOKEN/USES_ASSET/TRIGGERS) trong 1 transaction.
  - `contextForFix(db, projectId, sectionId, budgetChars): { subtree, tokens, interactions, assetPaths }` — cắt theo ngân sách.
  - `coverage(db, projectId): { page:string, captured:number, failed:number, skipped:number }[]`.
  - `sharedLayouts(db, projectId): Layout[]`.

- [ ] **Step 1: Failing test** — writeGraph rồi coverage đếm đúng interaction theo status; contextForFix trả subtree của section yêu cầu.

- [ ] **Step 2: fail → 3: implement → 4: pass → 5: commit** — `git commit -m "feat: graph store + bounded context queries"`

### Task 17: Section naming via AI (1 call/page)

**Files:** Modify `src/core/ir.ts` or new `src/core/naming.ts`; Test `tests/unit/naming.test.ts` (mock gateway)

**Interfaces:**
- Consumes: `gateway.generate` (role `vision`), zod.
- Produces: `nameSections(db, projectId, page, outline): Promise<Record<sectionId,{name,role}>>` — gửi outline (cây tag sâu 3, 200 ký tự text, thumbnail nhỏ), validate zod; AI lỗi/bad → fallback `section-N` (không chặn).

- [ ] **Step 1: Failing test** — mock gateway trả JSON hợp lệ → map đúng; mock trả rác → fallback `section-1..N`.

- [ ] **Step 2: fail → 3: implement → 4: pass → 5: commit** — `git commit -m "feat: AI section naming with safe fallback"`

---

## Phase 6 — Emit HTML

### Task 18: emit-html (IR → out/)

**Files:** Create `src/core/emit-html.ts`, `src/core/runtime.js` (asset tĩnh ~3KB); Test `tests/unit/emit.test.ts` (thuần) + `tests/e2e/emit-render.test.ts`

**Interfaces:**
- Consumes: `ir`.
- Produces: `emitHtml(ir, { outDir, assetMap }): Promise<void>` — mỗi page 1 `.html` (chèn layout chung), `css/styles.css` (token+@font-face+@keyframes+class+media), `js/runtime.js` (data-toggle/tabs/carousel/modal/sticky), viết lại URL tuyệt đối→local, `data-ir-id` mỗi phần tử, `behavior=unresolved` giữ nguyên. `emitSection(ir, sectionId): string` (dùng cho QA re-emit).

- [ ] **Step 1: Failing test (unit)** — emit IR nhỏ → HTML chứa `data-ir-id`, CSS chứa class `.s-`, layout chung xuất 1 lần.

- [ ] **Step 2: fail → 3: implement → 4: pass**

- [ ] **Step 5: e2e render** — serve out/, mở bằng browser, `file://` không lỗi console nghiêm trọng; runtime toggle menu hoạt động. Implement runtime.js to pass.

- [ ] **Step 6: Commit** — `git commit -m "feat: deterministic HTML/CSS/runtime emitter"`

---

## Phase 7 — QA + Fix loop

### Task 19: Inspector

**Files:** Create `src/core/inspector.ts`; Test `tests/e2e/inspector.test.ts`

**Interfaces:**
- Produces (dùng cả cho orchestrator lẫn tool-call AI, mỗi cái bounded): `snapshotA11y(page,selector)`, `screenshotSection(page,bbox):Buffer`, `hover(page,selector)`, `click(page,selector)`, `readStyle(page,selector,props):Record<string,string>`. Wrapper `asTools()` trả định nghĩa tool cho gateway, đếm số lần gọi ≤5/vòng.

- [ ] **Step 1: Failing test** — readStyle trên fixture trả đúng `color`; đếm gọi vượt 5 → throw.

- [ ] **Step 2: fail → 3: implement → 4: pass → 5: commit** — `git commit -m "feat: inspector commands + tool wrapper"`

### Task 20: QA scorer (per-section pixel diff)

**Files:** Create `src/core/qa.ts` (phần score); Test `tests/e2e/qa-score.test.ts`

**Interfaces:**
- Consumes: `browser`, `emit-html`, `pixelmatch`, `pngjs`.
- Produces: `scoreSections(browser, { origShotsDir, outDir, sections, bps }): Promise<{ sectionId, bp, score, heatPath }[]>` — serve out/, chụp cùng viewport, chèn CSS tắt animation/transition/caret, chờ font; crop theo bbox (orig từ capture, clone qua `data-ir-id`); pixelmatch threshold 0.1; điểm `1-diff/total`; mask vùng `dynamic`; lưu orig/clone/heat png.

- [ ] **Step 1: Failing test** — clone giống hệt orig → score ~1.0; đổi màu 1 section → score < 1 cho section đó, section khác vẫn ~1.

- [ ] **Step 2: fail → 3: implement → 4: pass → 5: commit** — `git commit -m "feat: per-section pixel-diff scorer"`

### Task 21: Fix loop

**Files:** Modify `src/core/qa.ts`; Test `tests/e2e/qa-fixloop.test.ts` (mock gateway trả patch tất định)

**Interfaces:**
- Consumes: `inspector`, `graph.contextForFix`, `gateway.generate` (role `code`), `ir.applyPatch`, `emit-html.emitSection`, zod.
- Produces: `fixSection(ctx, sectionId): Promise<{ finalScore, rounds, patched:boolean }>` — ≤3 vòng: (1) inspector bắt buộc trên orig+clone; (2) contextForFix; (3) AI trả JSON patch (zod validate; bad→`AI_BAD_RESPONSE`, tính 1 vòng); (4) applyPatch→emitSection→re-score, **điểm giảm→revert giữ best**; (5) hết vòng<ngưỡng→đánh dấu đỏ. AI tool-call inspector ≤5/vòng. Vượt token budget→dừng, đánh dấu, không fail job. `fixAll(ctx)` chạy ≤2 section song song (mapLimit).

- [ ] **Step 1: Failing test** — mock gateway trả patch sửa màu đúng → score tăng qua ngưỡng, `rounds`≤3; mock trả patch làm xấu → revert, giữ best (score không tụt).

- [ ] **Step 2: fail → 3: implement → 4: pass → 5: commit** — `git commit -m "feat: bounded QA fix loop with revert-on-regression"`

---

## Phase 8 — Jobs + API + UI

### Task 22: Job orchestrator + SSE bus

**Files:** Create `src/core/jobs.ts`; Test `tests/unit/jobs.test.ts` + `tests/e2e/jobs-resume.test.ts`

**Interfaces:**
- Consumes: tất cả core trên.
- Produces:
  - `createProject(db,{url,mode,config}): projectId` (status `draft`).
  - `enqueue(projectId, selectedPages)` → sinh tasks theo phase, status `pending`.
  - `runProject(db, projectId)` — chạy pipeline theo phase, mỗi task: `running`→(atomic output)→`done`/`failed`(attempts<3 retry theo bảng lỗi); circuit breaker AI 5 lỗi liên tiếp→`failed`. Phát event qua `bus.emit(projectId, evt)`.
  - `recoverOnStartup(db)` — mọi `running`→`pending`, project chạy→`interrupted`, **không auto-run**.
  - `pauseProject`, `resumeProject` (chạy `pending`+`failed<3`, bỏ `done`).
  - `subscribe(projectId, cb): unsubscribe` (SSE).
  - Queue bounded: 1 job chạy, ≤5 chờ, vượt→throw (map 429 ở API).

- [ ] **Step 1: Failing test (unit)** — createProject+enqueue sinh đúng số task; recoverOnStartup đưa `running`→`pending`.

- [ ] **Step 2: fail → 3: implement → 4: pass**

- [ ] **Step 5: resume e2e** — chạy runProject site1, kill giữa chừng (throw ở phase capture trang 2 qua injected fault), gọi recover+resume → hoàn tất, kết quả trùng lần chạy liền mạch (so số node IR).

- [ ] **Step 6: Commit** — `git commit -m "feat: job orchestrator + checkpoint resume + SSE"`

### Task 23: Next.js app + API routes

**Files:** Create `next.config.ts`, `src/app/layout.tsx`, API routes; Test `tests/e2e/api.test.ts`

**Interfaces:**
- Produces API (mỏng, chỉ gọi core):
  - `POST /api/providers`, `GET /api/providers`, `POST /api/providers/models`, `POST /api/providers/test`
  - `POST /api/projects` (create), `GET /api/projects` (list, paginate 20, filter), `POST /api/projects/:id/crawl`, `POST /api/projects/:id/start`, `POST /api/projects/:id/pause`, `POST /api/projects/:id/resume`, `DELETE /api/projects/:id`
  - `POST /api/projects/:id/auth/continue`, `POST /api/projects/:id/auth/open`
  - `GET /api/projects/:id/events` (SSE), `GET /api/projects/:id/preview`, `GET /api/projects/:id/coverage`
  - `POST /api/projects/:id/export` (ZIP stream / to folder)
  - App gọi `recoverOnStartup` khi khởi động (instrumentation hook).

- [ ] **Step 1: Failing test** — `POST /api/projects` trả id; `GET /api/projects` list chứa nó.

- [ ] **Step 2: fail → 3: implement (từng route) → 4: pass → 5: commit** — `git commit -m "feat: next.js api routes over core"`

### Task 24: UI screens

**Files:** Create pages `src/app/settings/ai/page.tsx`, `/page.tsx`, `/new/page.tsx`, `/p/[id]/sitemap`, `/p/[id]`, `/p/[id]/preview`, `/p/[id]/code`; Test `tests/e2e/ui-smoke.test.ts`

**Interfaces:**
- Consumes: API Task 23.
- Produces: 7 màn spec mục 10 (editor GrapesJS tách Task 25). SSE client cho `/p/[id]`. Preview side-by-side + heatmap + section scores + checklist tab. Code view shiki read-only + export.

- [ ] **Step 1: Failing test (smoke)** — Playwright mở `/settings/ai`, thêm provider, thấy trong list; mở `/new`, submit URL fixture, thấy sitemap.

- [ ] **Step 2: fail → 3: implement → 4: pass → 5: commit** — `git commit -m "feat: UI screens (settings, history, new, sitemap, progress, preview, code)"`

### Task 25: GrapesJS editor + IR adapter

**Files:** Create `src/app/p/[id]/editor/page.tsx`, `src/core/grapes-adapter.ts`; Test `tests/unit/grapes-adapter.test.ts` + `tests/e2e/editor-smoke.test.ts`

**Interfaces:**
- Consumes: `ir`, `applyPatch`.
- Produces: `irToGrapes(ir): GrapesProject`; `grapesToPatch(before, grapesJson): PatchOp[]`. Layout chung = symbol. Panel hiệu ứng (keyframes capture + preset fade/slide). Save → grapesToPatch → applyPatch → re-emit.

- [ ] **Step 1: Failing test (unit)** — irToGrapes rồi grapesToPatch trên thay đổi text → patch `setText` đúng id.

- [ ] **Step 2: fail → 3: implement → 4: pass**

- [ ] **Step 5: editor smoke** — mở editor, kéo đổi 1 text, save, preview phản ánh. → 6: commit — `git commit -m "feat: GrapesJS editor + IR two-way adapter"`

---

## Phase 9 — E2E fixtures + acceptance

### Task 26: Fixtures + full E2E

**Files:** Create `tests/fixtures/site1|site2|site3/*` (HTML tĩnh), `tests/e2e/full-clone.test.ts`

**Interfaces:**
- Consumes: toàn pipeline.
- Produces: 3 site tĩnh (spec mục 13): (1) landing đơn giản; (2) menu/tab/modal/carousel/hover; (3) 3 trang header dùng chung. E2E: clone từng site → mọi section ≥95% ở 3 bp, checklist 100% `captured`, header 1 lần trong IR. Test grep: key/mật khẩu không trong log/graph/output.

- [ ] **Step 1: Write fixtures** (HTML tĩnh serve bằng `npx serve` hoặc route local).

- [ ] **Step 2: Write full-clone e2e** (site1 trước).

- [ ] **Step 3: Run — fix cho tới khi site1 pass ≥95%.**

- [ ] **Step 4: site2 (tương tác) + site3 (multi-page) pass.**

- [ ] **Step 5: Security grep test pass.**

- [ ] **Step 6: Commit** — `git commit -m "test: fixtures + full clone e2e acceptance"`

---

## Self-Review Notes

- **Spec coverage:** Gateway(T4)=§2; Auth(T8)=§3; Jobs/Resume(T22)=§4; Crawl(T7)=§5; Capture(T9-13)=§6; IR/Graph(T14-17)=§7; Emit(T18)=§8; QA/Fix(T19-21)=§9; API/UI(T23-25)=§10; Errors(T0)=§11; Testing(T26)=§13; Acceptance(T26)=§14. SP3(§12) ngoài phạm vi SP1 (chỉ chừa `origin:'ai'` field ở T15, node `Feature` ở graph schema T2).
- **Type consistency:** `CaptureNode`(T9)→`PageCapture`(T13)→`buildIR`(T15)→`IRNode`. `PatchOp` định nghĩa T15, dùng T21/T25. `Interaction` T11 dùng T16 graph. `contextForFix` chữ ký nhất quán T16/T21.
- **Order:** `mapLimit`(T6) trước mọi consumer; `inspector`(T19) trước `qa`(T20-21); `ir`(T15) trước `emit`(T18)/`graph`(T16).
```
