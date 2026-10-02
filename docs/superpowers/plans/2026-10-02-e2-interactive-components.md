# E2 Interactive Components Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nâng carousel, tabs, accordion, modal, dropdown, menu, video từ "hành vi chung" của E1 thành component có cấu trúc trong IR v2 (`IRNode.interactive`), chạy bằng runtime riêng, kiểm chứng bằng QA hành vi và sửa được qua Command API + panel "Component".

**Architecture:** `interactive.ts` là model thuần (zod schema theo kind, validate tham chiếu, role index, cfg). Capture chỉ lo phần cần trang thật (đọc config thư viện, quan sát autoplay, hover); mọi suy luận cấu trúc (guessed, loop clone, slidesPerView/gap từ bbox, migration v1) là hàm thuần trên IR. `compileV2` biến `interactive` thành `data-c`/`data-c-cfg`/`data-c-role` trên view tạm (không lưu), `runtime.js` đọc đúng các attribute đó. Command mới đi qua `prepareCommands`/`applyCommands` của E1 với inverse riêng (`restoreSpec`, `restoreItems`); panel React chỉ phát command.

**Tech Stack:** TypeScript, Next.js 16 App Router, React 19, Zod 4, `node:sqlite`, GrapesJS 0.23 (canvas tạm), Playwright 1.63 (`page.clock`), Vitest 5. Không thêm dependency.

**Spec:** `docs/superpowers/specs/2026-10-02-e2-interactive-components-design.md` (đã duyệt 2026-10-02). Nền: `docs/superpowers/specs/2026-09-27-e1-document-model-design.md`, rulings E1 trong `.superpowers/visual-editor-handoff.md`.

## Global Constraints

- Người dùng đã đưa code lên `main` (remote `origin/main`); spec E2 là commit `0f71994` trên `main` (chưa push). Trước Task 1 chạy `git switch -c e2-interactive-components` (từ `main`), làm toàn bộ E2 trên nhánh đó. Không push/merge.
- Chỉ stage file của task bằng `git add -- <paths>`; không bao giờ `git add -A`; không commit `next-env.d.ts`, `passcaptchar/`, `rules.md`, `.playwright-mcp/`, `.superpowers/`. Trailer mọi commit: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Trước Task 1: `/graphify explain feat_interaction_scan`, `feat_emit_html`, `feat_editor`, `mod_runtime_js`. E2 là phần mở rộng SP1 đã duyệt (như E1), không phải SP2/SP3. Không build `drift_*`.
- Kind E2: carousel, tabs, accordion, modal, dropdown, menu, video (tất cả). Không đóng gói Swiper/Slick, không chạy script gốc.
- Giới hạn cứng (§10, chép nguyên): Component mỗi trang **50** (vượt: phần còn lại ghi unsupported "vượt giới hạn"); Item mỗi component **100**; Quan sát autoplay **≤ 6 s mỗi carousel, ≤ 30 s mỗi trang** (vượt: `guessed`); Evaluate đọc cấu hình **1 lần mỗi trang, timeout 30 s**; `data-c-cfg` **≤ 16 KB mỗi component**; `runtime.js` **≤ 15 KB** (test kiểm, 15 × 1024 byte); QA hành vi **≤ 5 s mỗi component, ≤ 50 component mỗi trang**.
- `data-c-cfg` chỉ chứa số, boolean, enum và id node (`data-ir-id`). `poster`/`src` video đi qua asset map hiện có; embed chỉ cho host `www.youtube-nocookie.com`, `player.vimeo.com`.
- Không giải CAPTCHA, không giả fingerprint/stealth, không vượt anti-bot (`rule_no_captcha_bypass`). Đọc `el.swiper.params` là đọc thuộc tính read-only trên trang đã mở; capture không bao giờ fail vì E2 (lỗi → observed → guessed).
- `core/` không import `app/`. `interactive.ts`, `interactive-guess.ts`, `interactive-build.ts`, `fidelity.ts`, `ir-command.ts` thuần: không fs/network/db/Date/random/DOM. Không `Promise.all` trên mảng không bounded.
- Command: thuần, inverse chính xác, ≤ 50 lệnh/batch, ≤ 8 MB/bước History (`COMMAND_LIMITS` của E1). Validation lỗi trả `IR_PATCH_INVALID`, không cắt input ngầm.
- Secret không vào spec, `data-c-cfg`, Fidelity hay request AI.
- UI: copy tiếng Việt; dùng `_ui` (`Card`, `Button`, `IconButton`, `Field`, `Badge`, `SegmentedControl`) và token Stitch sẵn có; mọi phần tử mới có `data-ui="ui_editor_component_*"` (hoặc `ui_qa_preview_behavior_list`) ghi vào `docs/superpowers/design/stitch-screens.md`; không cuộn ngang ở 375 và 1440.
- QA pixel: điểm từng section × bp của site1–3 trên `?qa=1` không thấp hơn baseline trước E2 (`tests/fixtures/qa-baseline.json`, sai số đo 0.001 như `qa-score.test.ts`).
- Mỗi task: test đỏ → code tối thiểu → test xanh → `npm run typecheck` → review diff → commit riêng. Code dưới đây là điểm neo + assertion bắt buộc; edge case thêm vào cùng file test của task.

**Rulings đã chốt khi viết plan (chỗ spec mơ hồ hoặc không khớp code thật):**
- R1 `slidesPerView` cho phép số lẻ tới 2 chữ số thập phân (`multipleOf(0.01)`), đọc ".5" là "cho phép số lẻ"; giá trị đo từ bbox giữ 2 chữ số để layout runtime khớp pixel bản chụp.
- R2 Dropdown/menu: gốc = tổ tiên chung thấp nhất (LCA) của trigger và panel. Nếu LCA đã giữ một `interactive` khác (hai dropdown anh em chung một cha, site2 `#vis-btn`/`#fade-btn`) thì gốc = chính node trigger, và `panel` của dropdown/menu được phép nằm ngoài subtree cùng trang — cùng ngoại lệ như `triggers` của modal (validate Task 1: `(spec.kind === "dropdown" || spec.kind === "menu") && role === "panel" && onPage.has(ref)`; guess Task 6 dùng gốc = trigger khi LCA bị chiếm). Không hồi quy so với runtime toggle cũ; chỉ khi chính trigger cũng đã bị chiếm mới ghi unsupported "trùng node gốc". Test bắt buộc: Task 1 (validate nhận panel ngoài subtree cho dropdown/menu, vẫn từ chối cho tabs/carousel) và Task 6 (hai dropdown anh em kiểu site2 → cả hai thành component).
- R3 QA hành vi là bước thứ hai của task `qa` (và của lần chấm lại sau `fix`), không thêm task/phase mới vào DB hay phase stepper; kết quả ở `qa.json.behavior[]`.
- R4 Kiểm tra autoplay dùng `page.clock` (đồng hồ giả của Playwright) để `1.5 × interval` (tới 90 s) vẫn nằm trong 5 s/component.
- R5 Nâng Fidelity bằng QA hành vi được áp lúc đọc Preview từ `qa.json` còn tươi (không `stale`), không ghi vào IR; edit làm `qa.json` stale nên item tự về trạng thái gốc.
- R6 `stripIds` (export) vẫn giữ `data-ir-id` trên các node được `data-c-cfg` tham chiếu.
- R7 Chỉ node có ở 1440 biểu diễn được (IR dựng từ 1440): node 1440 thiếu ở 768/375 (sau khi ghép theo khoá slide) nhận `display:none` ở bp đó; node chỉ có ở 768/375 không có trong IR.
- R8 Canvas GrapesJS (srcdoc, không có `?edit=1` trên URL) nạp `runtime.js?edit=1`; runtime đọc mode từ `document.currentScript.src`. Panel nhận thêm prop `onShow(rootId, index)` để editor chuyển `postMessage` vào frame.
- R9 CSP `frame-src` cho embed: emitter thêm `<meta http-equiv="Content-Security-Policy" content="frame-src https://www.youtube-nocookie.com https://player.vimeo.com">` vào trang có embed (kết hợp với header của files route, giữ được cả khi export/file://); header route không đổi.
- R10 Fixture site4 dùng hai script "mini" tự viết (`swiper-mini.js`, `slick-mini.js`) mô phỏng đúng bề mặt E2 đọc (class DOM, `el.swiper.params`, `$(el).slick('getSlick').options`, slide duplicate theo breakpoint, autoplay); không vendor bản build thật (không có mạng, không thêm dependency). Kiểm với thư viện thật cần một lần chạy tay trên site thật.
- R11 Load-time validate: `interactive` sai trong tài liệu đã lưu là lỗi `IR_PATCH_INVALID` như mọi cấu trúc v2 sai khác (chỉ code của tool tạo ra nó, command luôn validate sau mỗi bước).
- R12 `interactive` không được đặt trên node main (`ir.components`); trên instance thì kèm override path `interactive` (cả spec) hoặc `interactive.<field>` (updateComponent). Copy bằng `duplicateNode` bỏ `interactive`. Copy item (add/duplicate) bỏ `id`, `aria-controls`, `aria-labelledby`, `for` để không trùng id HTML.
- R13 Tabs/accordion/dropdown ẩn–hiện panel theo đúng cách bản chụp ẩn nó (`hidden` / `display` / `visibility` / `opacity`, logic `show/hide` của runtime cũ), không đổi `visibility:hidden` thành `display:none` (đổi layout → tụt pixel site2).

## Review Focus

1. Swiper loop có slide duplicate ở hai đầu và số duplicate khác nhau giữa 1440/768/375: `slides` chỉ gồm slide thật đúng thứ tự, clone `hidden` và không emit, style 768/375 của slide thật vẫn được clone (ghép theo khoá), slidesPerView/gap theo bp (Task 8).
2. Trang có `.swiper` nhưng `el.swiper` không lộ ra (bundle đóng gói): không fail, chuyển `observed` (autoplay + interval đo được), không phải `config` (Task 7).
3. `deleteNode`/`moveNode` một slide hoặc trigger modal đang được tham chiếu (từ canvas GrapesJS hay AI): bị từ chối `IR_PATCH_INVALID` nêu đúng vai trò; xoá cả gốc component thì được (Task 10).
4. `?qa=1` với carousel autoplay: không đổi slide theo thời gian, trạng thái = lúc chụp, hai ảnh chụp cách nhau 5 s giống hệt (Task 3); trang chấm điểm và trang inspector của vòng fix luôn tải `?qa=1` (Task 9).
5. Trigger modal nằm ở section khác với dialog (ngoài subtree, cùng trang): validate nhận (Task 1), runtime mở/đóng đúng và trả focus (Task 4), guess dựng được từ bản chụp thật — trigger ở `<header>`, dialog ở `<footer>` của site4 (Task 14).

## File map và interfaces

| File | Trách nhiệm |
|---|---|
| `src/core/interactive.ts` (mới) | Type + zod schema theo kind, `parseSpec`, `rolesOf`, `cfgOf`, `checkInteractives`, `roleIndex`, `loopClones`, `baseDecl`, item helpers, `patchSpec`, `specFromRoles`, `panelComponents`. Thuần. |
| `src/core/interactive-guess.ts` (mới) | `pageNodes`, suy cấu trúc `guessed` (tabs/accordion/modal/dropdown/menu/carousel/video), `measureCarousel` từ `box`, `migrateBehaviors` (§9), `upgradeDocument`. Thuần. |
| `src/core/interactive-eval.ts` (mới) | Hàm chạy trong trang: đọc config Swiper/Slick/Splide, quan sát chuyển động, tìm trigger hover. |
| `src/core/interactive-scan.ts` (mới) | `scanInteractives(page)`: config → observed → hover, có ngân sách; kiểu `CapturedInteractive`. |
| `src/core/interactive-build.ts` (mới) | `attachInteractives(ir, captures)`: record capture → spec (loop clone, active, slidesPerView/gap, effect), guess phần còn lại, giới hạn 50/100, Fidelity note. Thuần. |
| `src/core/qa-behavior.ts` (mới) | `checkBehavior(handle, opts)`: QA hành vi có giới hạn, không AI. |
| `src/core/runtime.js` | Viết lại: runtime component (carousel, tabs, accordion, modal, dropdown/menu, video), mode qa/edit. |
| `src/core/ir-v2.ts`, `ir-legacy.ts`, `ir-migrate.ts`, `ir-component.ts`, `ir-store.ts`, `ir.ts`, `ir-build.ts` | Field `interactive`, view field `c/skip/keepId/embed`, validate khi load, override path, hook upgrade, `buildIR` gọi attach, ghép con theo khoá. |
| `src/core/emit-html.ts`, `grapes-adapter.ts` | `data-c*`, CSS cơ bản, bỏ clone, bỏ `data-behavior`, embed + CSP meta; canvas mang `data-c*` mà không diff ngược. |
| `src/core/fidelity.ts` | Item `component` suy từ IR, `component-note` mang theo, "bỏ hành vi", `withBehavior`. |
| `src/core/ir-command.ts`, `qa-fix.ts`, `qa.ts`, `jobs.ts`, `capture.ts` | Command mới + bảo vệ vai trò; prompt AI `updateComponent`; `?qa=1`; QA hành vi trong `scoreAll`; capture gọi scan. |
| `src/app/api/projects/[id]/editor/commands/route.ts`, `editor/route.ts`, `preview/route.ts` | Zod nhận command mới; GET editor trả `components`; Preview trả `behavior` + Fidelity đã nâng. |
| `src/app/p/[id]/editor/component-panel/*` (mới), `editor-view.tsx`, `preview/preview-view.tsx`, `globals.css` | Panel "Component", wizard, nối GrapesJS + postMessage; danh sách QA hành vi. |
| `tests/fixtures/site4/*` (mới), `tests/fixtures/qa-baseline.json` (mới) | Fixture E2; baseline pixel site1–3 trước E2. |

Interface dùng chung (các task sau dùng đúng tên này):

```ts
// src/core/interactive.ts
export type Bp = "1440" | "768" | "375";
export type InteractiveKind = "carousel" | "tabs" | "accordion" | "modal" | "dropdown" | "menu" | "video";
export type Confidence = "config" | "observed" | "guessed" | "manual";
export type InteractiveSource = "swiper" | "slick" | "splide" | "scroll-snap" | "aria" | "details" | "native" | "generic" | "manual";
export type InteractiveSpec = CarouselSpec | TabsSpec | AccordionSpec | ModalSpec | DropdownSpec | VideoSpec; // đúng §2
export type Role = "viewport" | "track" | "slide" | "prev" | "next" | "pagination" | "tab" | "panel" | "trigger" | "dialog" | "close" | "video";
export type Member = { root: string; spec: InteractiveSpec; role: Role };
export const INTERACTIVE_LIMITS: { perPage: 50; items: 100; cfgBytes: 16384 };
export const EMBED_HOSTS: readonly ["www.youtube-nocookie.com", "player.vimeo.com"];
export function parseSpec(value: unknown): InteractiveSpec;               // throws AppError(IR_PATCH_INVALID)
export function rolesOf(spec: InteractiveSpec): [string, Role][];
export function cfgOf(spec: InteractiveSpec): string;                       // JSON, không có source/confidence/poster
export function checkInteractives(ir: IRV2): void;                          // throws AppError(IR_PATCH_INVALID)
export function roleIndex(ir: IRV2): Map<string, Member[]>;
export function loopClones(ir: IRV2): Set<string>;
export function baseDecl(spec: InteractiveSpec, roles: Role[], captured: Decl): Decl;
// IRNodeV2 (ir-v2.ts): interactive?: InteractiveSpec
// LegacyIRNode view-only (ir-legacy.ts): c?: Record<string, string | null>; skip?: true; keepId?: true; embed?: true
```

---

### Task 1: Model, schema, validate tham chiếu, baseline QA

**Files:**
- Create: `src/core/interactive.ts`
- Modify: `src/core/ir-v2.ts:14-28` (thêm `interactive?: InteractiveSpec` vào `IRNodeV2`), `src/core/ir-migrate.ts:28-55` (node check + `checkInteractives` trước `return input as IRV2`), `src/core/ir-component.ts:42-52` (`isOverridePath`, `overlay`)
- Test: `tests/unit/interactive.test.ts`, `tests/e2e/qa-baseline.test.ts`; Create: `tests/fixtures/qa-baseline.json`

**Interfaces:**
- Consumes: `AppError`, `Codes.IR_PATCH_INVALID` (`errors.ts`); `IRV2`, `IRNodeV2` (`ir-v2.ts`); `buildIR`, `capturePage`, `emitHtml`, `scoreSections` (cho baseline).
- Produces: toàn bộ block interface ở trên trừ `roleIndex`/`loopClones`/`baseDecl` (Task 2). `isOverridePath("interactive") === true`, `isOverridePath("interactive.autoplay") === true`; `resolveComponents` chép `interactive` của instance khi có override path đó.

- [ ] **Step 0: Ghi baseline pixel trước E2 (code chưa đổi)**

Tạo `tests/e2e/qa-baseline.test.ts`:

```ts
// E2 §5: pixel scores of site1-3 on the QA page never drop below the pre-E2 baseline (tests/fixtures/qa-baseline.json).
// WRITE_QA_BASELINE=1 records it (run once at the pre-E2 commit); otherwise every section x bp must stay >= baseline - 0.001.
import { afterAll, beforeAll, expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, type BrowserHandle } from "@/core/browser";
import { capturePage, type PageCapture } from "@/core/capture";
import { emitHtml } from "@/core/emit-html";
import { buildIR } from "@/core/ir";
import { scoreSections } from "@/core/qa";
import { serveDir } from "@/core/serve";

const BASELINE = fileURLToPath(new URL("../fixtures/qa-baseline.json", import.meta.url));
const SITES = ["site1", "site2", "site3"] as const;
let handle: BrowserHandle;
let tmp = "";
beforeAll(async () => { handle = await openBrowser({ headed: false }); tmp = await mkdtemp(join(tmpdir(), "qa-baseline-")); });
afterAll(async () => { await handle.close(); await rm(tmp, { recursive: true, force: true }); });

async function scores(site: (typeof SITES)[number]): Promise<Record<string, number>> {
  const server = await serveDir(fileURLToPath(new URL(`../fixtures/${site}`, import.meta.url)));
  try {
    const workspaceDir = join(tmp, site, "ws"), outDir = join(tmp, site, "out"), url = `${server.url}/index.html`;
    const meta = await capturePage(handle, { url, pageId: "home", workspaceDir });
    const cap = JSON.parse(await readFile(join(workspaceDir, meta.capturePath), "utf8")) as PageCapture;
    const ir = buildIR([cap]);
    await emitHtml(ir, { outDir, workspaceDir, assetMap: cap.assets, pageUrls: { home: url } });
    const rows = await scoreSections(handle, { workspaceDir, outDir, ir, captures: [cap] });
    return Object.fromEntries(rows.map((r) => [`${site}/${r.sectionId}@${r.bp}`, r.score]));
  } finally {
    await server.close();
  }
}

test("site1-3: no section x bp scores below the pre-E2 baseline", { timeout: 300_000 }, async () => {
  const now: Record<string, number> = {};
  for (const site of SITES) Object.assign(now, await scores(site)); // sequential: one browser page at a time
  if (process.env.WRITE_QA_BASELINE === "1") {
    await writeFile(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  expect(existsSync(BASELINE)).toBe(true);
  const base = JSON.parse(await readFile(BASELINE, "utf8")) as Record<string, number>;
  expect(Object.keys(now).sort()).toEqual(Object.keys(base).sort());
  for (const [key, score] of Object.entries(base)) expect(now[key], key).toBeGreaterThanOrEqual(score - 0.001);
});
```

Run (PowerShell): `$env:WRITE_QA_BASELINE='1'; npx vitest run -c vitest.e2e.config.ts tests/e2e/qa-baseline.test.ts; Remove-Item Env:WRITE_QA_BASELINE`
Expected: PASS, `tests/fixtures/qa-baseline.json` được tạo (mọi key `siteN/<sectionId>@<bp>`). Chạy lại không env: PASS.

- [ ] **Step 1: Viết test đỏ cho model**

`tests/unit/interactive.test.ts`:

```ts
import { expect, test } from "vitest";
import { cfgOf, checkInteractives, INTERACTIVE_LIMITS, parseSpec, rolesOf, type CarouselSpec, type InteractiveSpec } from "@/core/interactive";
import { migrateIR } from "@/core/ir-migrate";
import { isOverridePath, resolveComponents } from "@/core/ir-component";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
const carousel = (over: Partial<CarouselSpec> = {}): CarouselSpec => ({
  kind: "carousel", source: "swiper", confidence: "config", viewport: "vp", track: "tr", slides: ["s0", "s1", "s2"], active: 0,
  autoplay: false, interval: 5000, loop: false, direction: "horizontal", transition: "slide", speed: 300,
  slidesPerView: { "1440": 3, "768": 2.5 }, gap: { "1440": 30 }, arrows: { next: "nx" }, ...over,
});
// page "pg": section s1 holds the carousel; section s2 holds a modal trigger for the dialog in s1
const doc = (spec: InteractiveSpec, rootChildren?: IRNodeV2[]): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "pg", path: "/", title: "", meta: {}, sectionIds: ["s1", "s2"], shell: n("html", "html", [n("body", "body", [
    n("ph1", "#section", [], { attrs: { "data-section": "s1" } }), n("ph2", "#section", [], { attrs: { "data-section": "s2" } })])]) }],
  sections: [
    { id: "s1", pageId: "pg", name: "a", role: "block", hash: "h", origin: "capture", root: n("root", "section", rootChildren ?? [
      n("vp", "div", [n("tr", "div", [n("s0", "div"), n("s1", "div"), n("s2", "div")])]), n("nx", "button"), n("dlg", "div"),
    ], { interactive: spec }) },
    { id: "s2", pageId: "pg", name: "b", role: "block", hash: "h2", origin: "capture", root: n("other", "section", [n("open", "button")]) },
  ],
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
});

test("schema per kind: valid specs parse, unknown fields / out-of-range values / semantic errors are refused", () => {
  expect(parseSpec(carousel())).toEqual(carousel());
  expect(() => parseSpec({ ...carousel(), tabs: [] })).toThrow(/IR_PATCH_INVALID|invalid/);
  expect(() => parseSpec(carousel({ interval: 999 }))).toThrow();
  expect(() => parseSpec(carousel({ speed: 5001 }))).toThrow();
  expect(() => parseSpec(carousel({ slidesPerView: { "1440": 11 } }))).toThrow();
  expect(() => parseSpec(carousel({ slidesPerView: { "1440": 2.333 } }))).toThrow(); // R1: 2 decimals
  expect(() => parseSpec(carousel({ gap: { "375": 201 } }))).toThrow();
  expect(() => parseSpec(carousel({ active: 3 }))).toThrow(/active/);
  expect(() => parseSpec(carousel({ slides: Array.from({ length: INTERACTIVE_LIMITS.items + 1 }, (_, i) => `s${i}`) }))).toThrow();
  expect(() => parseSpec(carousel({ slides: ["s0", "s0"] }))).toThrow(/duplicate/);
  const video = { kind: "video", source: "native", confidence: "guessed", node: "v", mode: "native", autoplay: true, muted: false, loop: false, controls: true };
  expect(() => parseSpec(video)).toThrow(/muted/);
  expect(parseSpec({ ...video, muted: true }).kind).toBe("video");
  expect(() => parseSpec({ kind: "modal", source: "aria", confidence: "guessed", triggers: ["t"], dialog: "d", closeOn: ["button"] })).toThrow(/closeButton/);
});

test("rolesOf and cfgOf: ids by role; cfg has only numbers/booleans/enums/ids and stays under 16 KB", () => {
  expect(rolesOf(carousel())).toEqual([["vp", "viewport"], ["tr", "track"], ["s0", "slide"], ["s1", "slide"], ["s2", "slide"], ["nx", "next"]]);
  const cfg = JSON.parse(cfgOf(carousel()));
  expect(cfg).not.toHaveProperty("source");
  expect(cfg).not.toHaveProperty("confidence");
  expect(cfg.slides).toEqual(["s0", "s1", "s2"]);
  const big = carousel({ slides: Array.from({ length: 100 }, (_, i) => `${"x".repeat(190)}${i}`) });
  const children = big.slides.map((id) => n(id, "div"));
  expect(() => checkInteractives(doc(big, [n("vp", "div", [n("tr", "div", children)]), n("nx", "button")]))).toThrow(/16 KB/);
});

test("references: inside the root, slides are track children, modal triggers may sit elsewhere on the same page", () => {
  expect(() => checkInteractives(doc(carousel()))).not.toThrow();
  expect(() => checkInteractives(doc(carousel({ arrows: { next: "open" } })))).toThrow(/outside/);
  expect(() => checkInteractives(doc(carousel({ slides: ["s0", "s1", "nx"] })))).toThrow(/track/);
  const modal: InteractiveSpec = { kind: "modal", source: "aria", confidence: "guessed", triggers: ["open"], dialog: "dlg", closeOn: ["esc", "backdrop"] };
  expect(() => checkInteractives(doc(modal))).not.toThrow(); // Review Focus 5: trigger in another section of the page
  expect(() => checkInteractives(doc({ ...modal, triggers: ["nowhere"] }))).toThrow(/outside|not on page/);
});

test("at most 50 components per page; none on a component main", () => {
  const tabs = (i: number): IRNodeV2 => n(`r${i}`, "div", [n(`t${i}`, "button"), n(`p${i}`, "div")], { interactive: { kind: "tabs", source: "aria", confidence: "guessed", tabs: [{ trigger: `t${i}`, panel: `p${i}` }], active: 0 } });
  const many = doc(carousel(), Array.from({ length: INTERACTIVE_LIMITS.perPage + 1 }, (_, i) => tabs(i)));
  many.sections[0]!.root = n("root", "section", many.sections[0]!.root.children);
  expect(() => checkInteractives(many)).toThrow(/50/);
  const withMain = doc(carousel());
  withMain.components = [{ id: "c", root: tabs(99), instanceIds: [] }];
  expect(() => checkInteractives(withMain)).toThrow(/main/);
});

test("migrateIR v2 validates interactive on load (R11) and keeps a valid document as-is", () => {
  const ok = doc(carousel());
  expect(migrateIR(ok, [])).toBe(ok);
  expect(() => migrateIR(doc(carousel({ track: "missing" })), [])).toThrow(/IR_PATCH_INVALID|outside/);
});

test("an instance keeps its own interactive through resolveComponents via the interactive override path", () => {
  expect(isOverridePath("interactive")).toBe(true);
  expect(isOverridePath("interactive.autoplay")).toBe(true);
  expect(isOverridePath("interactive.__proto__")).toBe(false);
  const ir = doc(carousel());
  const main = n("m", "div", [n("m1", "button"), n("m2", "div")], { component: { id: "c", role: "main" } });
  const spec: InteractiveSpec = { kind: "dropdown", source: "aria", confidence: "guessed", trigger: "i1", panel: "i2", openOn: "click" };
  const inst = n("i", "div", [n("i1", "button", [], { component: { id: "c", role: "instance", sourceId: "m1", overrides: [] } }), n("i2", "div", [], { component: { id: "c", role: "instance", sourceId: "m2", overrides: [] } })],
    { component: { id: "c", role: "instance", sourceId: "m", overrides: ["interactive"] }, interactive: spec });
  ir.sections[1]!.root = n("other", "section", [n("open", "button"), inst]);
  ir.components = [{ id: "c", root: main, instanceIds: ["i"] }];
  const shown = resolveComponents(ir).sections[1]!.root.children[1]!;
  expect(shown.interactive).toEqual(spec);
});
```

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run tests/unit/interactive.test.ts`
Expected: FAIL — `Cannot find module '@/core/interactive'`.

- [ ] **Step 3: Implement `src/core/interactive.ts` + nối vào v2**

```ts
// E2 §2: the interactive component model on IR v2 nodes. Pure (zod + plain data): no DOM, fs, Date or random.
import { z } from "zod";
import { AppError, Codes } from "./errors";
import type { IRNodeV2, IRV2 } from "./ir-v2";

export type Bp = "1440" | "768" | "375";
export type InteractiveKind = "carousel" | "tabs" | "accordion" | "modal" | "dropdown" | "menu" | "video";
export type Confidence = "config" | "observed" | "guessed" | "manual";
export type InteractiveSource = "swiper" | "slick" | "splide" | "scroll-snap" | "aria" | "details" | "native" | "generic" | "manual";
interface InteractiveBase { kind: InteractiveKind; source: InteractiveSource; confidence: Confidence }
export interface CarouselSpec extends InteractiveBase {
  kind: "carousel"; viewport: string; track: string; slides: string[]; active: number;
  autoplay: boolean; interval: number; loop: boolean; direction: "horizontal" | "vertical";
  transition: "slide" | "fade"; speed: number;
  slidesPerView: Partial<Record<Bp, number>>; gap: Partial<Record<Bp, number>>;
  arrows?: { prev?: string; next?: string }; pagination?: { container: string; kind: "bullets" | "fraction" };
}
export interface TabsSpec extends InteractiveBase { kind: "tabs"; tabs: { trigger: string; panel: string }[]; active: number }
export interface AccordionSpec extends InteractiveBase { kind: "accordion"; items: { trigger: string; panel: string; open: boolean }[]; multiple: boolean }
export interface ModalSpec extends InteractiveBase { kind: "modal"; triggers: string[]; dialog: string; closeOn: ("backdrop" | "esc" | "button")[]; closeButton?: string }
export interface DropdownSpec extends InteractiveBase { kind: "dropdown" | "menu"; trigger: string; panel: string; openOn: "click" | "hover" }
export interface VideoSpec extends InteractiveBase { kind: "video"; node: string; mode: "native" | "embed"; autoplay: boolean; muted: boolean; loop: boolean; controls: boolean; poster?: string }
export type InteractiveSpec = CarouselSpec | TabsSpec | AccordionSpec | ModalSpec | DropdownSpec | VideoSpec;
export type Role = "viewport" | "track" | "slide" | "prev" | "next" | "pagination" | "tab" | "panel" | "trigger" | "dialog" | "close" | "video";
export type Member = { root: string; spec: InteractiveSpec; role: Role };

export const INTERACTIVE_LIMITS = { perPage: 50, items: 100, cfgBytes: 16 * 1024 } as const;
export const EMBED_HOSTS = ["www.youtube-nocookie.com", "player.vimeo.com"] as const;

const invalid = (message: string): never => { throw new AppError(Codes.IR_PATCH_INVALID, message); };
const id = z.string().min(1).max(200);
const base = {
  source: z.enum(["swiper", "slick", "splide", "scroll-snap", "aria", "details", "native", "generic", "manual"]),
  confidence: z.enum(["config", "observed", "guessed", "manual"]),
};
const perBp = (value: z.ZodNumber) => z.strictObject({ "1440": value.optional(), "768": value.optional(), "375": value.optional() });
const list = <T extends z.ZodType>(item: T) => z.array(item).min(1).max(INTERACTIVE_LIMITS.items);
const carousel = z.strictObject({
  kind: z.literal("carousel"), ...base, viewport: id, track: id, slides: list(id), active: z.number().int().min(0),
  autoplay: z.boolean(), interval: z.number().int().min(1000).max(60000), loop: z.boolean(),
  direction: z.enum(["horizontal", "vertical"]), transition: z.enum(["slide", "fade"]), speed: z.number().int().min(0).max(5000),
  slidesPerView: perBp(z.number().min(1).max(10).multipleOf(0.01)), gap: perBp(z.number().min(0).max(200)),
  arrows: z.strictObject({ prev: id.optional(), next: id.optional() }).optional(),
  pagination: z.strictObject({ container: id, kind: z.enum(["bullets", "fraction"]) }).optional(),
});
const tabs = z.strictObject({ kind: z.literal("tabs"), ...base, tabs: list(z.strictObject({ trigger: id, panel: id })), active: z.number().int().min(0) });
const accordion = z.strictObject({ kind: z.literal("accordion"), ...base, items: list(z.strictObject({ trigger: id, panel: id, open: z.boolean() })), multiple: z.boolean() });
const modal = z.strictObject({ kind: z.literal("modal"), ...base, triggers: list(id), dialog: id, closeOn: z.array(z.enum(["backdrop", "esc", "button"])).max(3), closeButton: id.optional() });
const dropdown = (kind: "dropdown" | "menu") => z.strictObject({ kind: z.literal(kind), ...base, trigger: id, panel: id, openOn: z.enum(["click", "hover"]) });
const video = z.strictObject({ kind: z.literal("video"), ...base, node: id, mode: z.enum(["native", "embed"]), autoplay: z.boolean(), muted: z.boolean(), loop: z.boolean(), controls: z.boolean(), poster: z.string().max(2000).optional() });
export const interactiveSchema = z.discriminatedUnion("kind", [carousel, tabs, accordion, modal, dropdown("dropdown"), dropdown("menu"), video]);

export function rolesOf(spec: InteractiveSpec): [string, Role][] {
  switch (spec.kind) {
    case "carousel": return [[spec.viewport, "viewport"], [spec.track, "track"], ...spec.slides.map((s): [string, Role] => [s, "slide"]),
      ...(spec.arrows?.prev ? [[spec.arrows.prev, "prev"] as [string, Role]] : []), ...(spec.arrows?.next ? [[spec.arrows.next, "next"] as [string, Role]] : []),
      ...(spec.pagination ? [[spec.pagination.container, "pagination"] as [string, Role]] : [])];
    case "tabs": return spec.tabs.flatMap((t): [string, Role][] => [[t.trigger, "tab"], [t.panel, "panel"]]);
    case "accordion": return spec.items.flatMap((t): [string, Role][] => [[t.trigger, "trigger"], [t.panel, "panel"]]);
    case "modal": return [...spec.triggers.map((t): [string, Role] => [t, "trigger"]), [spec.dialog, "dialog"], ...(spec.closeButton ? [[spec.closeButton, "close"] as [string, Role]] : [])];
    case "video": return [[spec.node, "video"]];
    default: return [[spec.trigger, "trigger"], [spec.panel, "panel"]];
  }
}

export function parseSpec(value: unknown): InteractiveSpec {
  const parsed = interactiveSchema.safeParse(value);
  if (!parsed.success) return invalid(`invalid interactive: ${parsed.error.message.slice(0, 300)}`);
  const spec = parsed.data as InteractiveSpec;
  const count = spec.kind === "carousel" ? spec.slides.length : spec.kind === "tabs" ? spec.tabs.length : undefined;
  if (count !== undefined && (spec as CarouselSpec | TabsSpec).active >= count) invalid(`active ${(spec as CarouselSpec).active} is out of range 0..${count - 1}`);
  if (spec.kind === "video" && spec.autoplay && !spec.muted) invalid("a video with autoplay must be muted");
  if (spec.kind === "modal" && spec.closeOn.includes("button") && !spec.closeButton) invalid("closeOn button needs a closeButton");
  const seen = new Set<string>();
  for (const [ref, role] of rolesOf(spec)) {
    if (role === "track" && ref === (spec as CarouselSpec).viewport) continue; // scroll-snap: the box is both
    if (seen.has(ref)) invalid(`duplicate node in interactive: ${ref}`);
    seen.add(ref);
  }
  return spec;
}

export function cfgOf(spec: InteractiveSpec): string {
  const { source: _source, confidence: _confidence, ...cfg } = spec as InteractiveSpec & { poster?: string };
  delete (cfg as { poster?: string }).poster; // a URL: written as the video's own attribute through the asset map
  return JSON.stringify(cfg);
}

const walk = (node: IRNodeV2, visit: (n: IRNodeV2) => void): void => { visit(node); node.children.forEach((c) => walk(c, visit)); };

// After load and after every command (E2 §2): schema, references inside the root (modal triggers: anywhere on the same
// page), slides are track children, <= 50 per page, cfg <= 16 KB, never on a component main.
export function checkInteractives(ir: IRV2): void {
  for (const c of ir.components) walk(c.root, (n) => { if (n.interactive) invalid(`component main node ${n.id} cannot hold an interactive`); });
  for (const page of ir.pages) {
    const onPage = new Set<string>(), parent = new Map<string, string>(), roots: IRNodeV2[] = [];
    for (const tree of [page.shell, ...ir.sections.filter((s) => s.pageId === page.id).map((s) => s.root)]) {
      walk(tree, (n) => { onPage.add(n.id); n.children.forEach((c) => parent.set(c.id, n.id)); if (n.interactive) roots.push(n); });
    }
    if (roots.length > INTERACTIVE_LIMITS.perPage) invalid(`page ${page.id} has ${roots.length} components (limit ${INTERACTIVE_LIMITS.perPage})`);
    for (const root of roots) {
      const spec = parseSpec(root.interactive);
      const inside = new Set<string>();
      walk(root, (n) => inside.add(n.id));
      for (const [ref, role] of rolesOf(spec)) {
        if (inside.has(ref)) continue;
        if (spec.kind === "modal" && role === "trigger" && onPage.has(ref)) continue;
        if ((spec.kind === "dropdown" || spec.kind === "menu") && role === "panel" && onPage.has(ref)) continue; // R2
        invalid(`${spec.kind} ${root.id}: ${role} ${ref} is outside the component (or not on page ${page.id})`);
      }
      if (spec.kind === "carousel") for (const s of spec.slides) if (parent.get(s) !== spec.track) invalid(`slide ${s} is not a child of track ${spec.track}`);
      if (new TextEncoder().encode(cfgOf(spec)).length > INTERACTIVE_LIMITS.cfgBytes) invalid(`data-c-cfg of ${root.id} exceeds 16 KB`);
    }
  }
}
```

`ir-v2.ts`: `import type { InteractiveSpec } from "./interactive";` và thêm `interactive?: InteractiveSpec;` sau `behavior?: string;`.

`ir-migrate.ts` (nhánh v2): thêm vào điều kiện node `(node.interactive !== undefined && !object(node.interactive))`; thay `return input as IRV2;` bằng:

```ts
    checkInteractives(input as IRV2); // E2 §2 (R11): an invalid interactive is a corrupt document like any other
    return input as IRV2;
```

`ir-component.ts`:

```ts
const INTERACTIVE_PATH = /^interactive(\.(?!__proto__|constructor|prototype)[a-zA-Z]+)?$/;
export const isOverridePath = (path: string): boolean =>
  path === "children" || INTERACTIVE_PATH.test(path) || fields.includes(path as typeof fields[number]) || mapPath(path) !== undefined;
function overlay(out: IRNodeV2, instance: IRNodeV2, path: string): void {
  if (path === "children") return;
  // E2 R12: a main never holds an interactive, so the instance's own spec is the whole value (ids are the instance's)
  if (INTERACTIVE_PATH.test(path)) {
    if (instance.interactive) out.interactive = structuredClone(instance.interactive); else delete out.interactive;
    return;
  }
  // ...existing body unchanged
```

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run tests/unit/interactive.test.ts tests/unit/ir-migrate.test.ts tests/unit/ir-component.test.ts tests/unit/ir-command.test.ts; npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/interactive.ts src/core/ir-v2.ts src/core/ir-migrate.ts src/core/ir-component.ts tests/unit/interactive.test.ts tests/e2e/qa-baseline.test.ts tests/fixtures/qa-baseline.json
git commit -m "feat(e2): interactive component model, schema and reference validation; pre-E2 QA baseline" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Emit `data-c*`, CSS cơ bản, bỏ clone, canvas GrapesJS

**Files:**
- Modify: `src/core/interactive.ts` (thêm `roleIndex`, `loopClones`, `baseDecl`), `src/core/ir-legacy.ts:3-12` (view field), `src/core/emit-html.ts:114-155` (`renderAttrs`, `renderNode`), `:234-286` (`renderCss`), `:327-367` (`compileV2`), `src/core/grapes-adapter.ts:40,79,100-103` (`SKIP_ATTRS`, `shown`, `toComponent`)
- Test: `tests/unit/emit-components.test.ts`

**Interfaces:**
- Consumes: Task 1 `rolesOf`, `cfgOf`, `InteractiveSpec`, `Role`.
- Produces: `roleIndex(ir): Map<string, Member[]>`, `loopClones(ir): Set<string>` (con của track không thuộc `slides` và `hidden`), `baseDecl(spec, roles, captured): Decl`. View `LegacyIRNode` có `c?: Record<string, string | null>` (null = bỏ attribute bản chụp cùng tên), `skip?: true`, `keepId?: true`, `embed?: true`. Hằng `HIDDEN_RULE = "[data-c-role][hidden]{display:none!important}"` export từ `emit-html.ts`. `data-behavior` **vẫn** được emit ở task này (bỏ ở Task 6).

- [ ] **Step 1: Viết test đỏ**

```ts
import { expect, test } from "vitest";
import { compileV2, HIDDEN_RULE, renderSite } from "@/core/emit-html";
import { grapesToCommands, irToGrapes, type GrapesComponent } from "@/core/grapes-adapter";
import type { CarouselSpec } from "@/core/interactive";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const css = (base: Record<string, string> = {}) => ({ base, bp: {}, state: {}, pseudo: {} });
const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: css(), children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
const spec: CarouselSpec = {
  kind: "carousel", source: "swiper", confidence: "config", viewport: "vp", track: "tr", slides: ["s0", "s1"], active: 0,
  autoplay: false, interval: 5000, loop: true, direction: "horizontal", transition: "slide", speed: 300,
  slidesPerView: { "1440": 1 }, gap: { "1440": 0 }, arrows: { next: "nx" },
};
const site = (): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "p1", path: "/", title: "t", meta: {}, sectionIds: ["p1-s1"], shell: n("p1:0", "html", [n("p1:0.1", "body", [n("p1-s1", "#section", [], { attrs: { "data-section": "p1-s1" } })])]) }],
  sections: [{ id: "p1-s1", pageId: "p1", name: "hero", role: "block", hash: "h", origin: "capture", root: n("root", "section", [
    n("vp", "div", [n("tr", "div", [
      n("clone", "div", [n("c.t", "#text", [], { text: "B" })], { hidden: true }),
      n("s0", "div", [n("s0.t", "#text", [], { text: "A" })], { styles: css({ width: "300px", "flex-shrink": "1" }) }),
      n("s1", "div", [n("s1.t", "#text", [], { text: "B" })], { styles: css({ width: "300px", "flex-shrink": "1" }) }),
    ])]),
    n("nx", "button", [n("nx.t", "#text", [], { text: "Next" })]),
    n("plain", "p", [n("plain.t", "#text", [], { text: "x" })]),
  ], { interactive: spec }) }],
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
});
const opts = { assetMap: {}, pageUrls: { p1: "https://x.test/" } };

test("root gets data-c + data-c-cfg (ids, no source/confidence), parts get data-c-role, loop clones are not emitted", () => {
  const html = renderSite(site(), opts)["index.html"]!;
  const root = /<section[^>]*data-c="carousel"[^>]*>/.exec(html)![0];
  const cfg = JSON.parse(/data-c-cfg="([^"]*)"/.exec(root)![1]!.replaceAll("&quot;", '"').replaceAll("&amp;", "&"));
  expect(cfg).toMatchObject({ kind: "carousel", viewport: "vp", track: "tr", slides: ["s0", "s1"], loop: true });
  expect(cfg).not.toHaveProperty("confidence");
  expect(html).toMatch(/data-c-role="viewport"/);
  expect(html.match(/data-c-role="slide"/g)).toHaveLength(2);
  expect(html).toMatch(/<button[^>]*data-c-role="next"/);
  expect(html).not.toContain('data-ir-id="clone"');
  expect(html).not.toContain("data-behavior");
});

test("CSS: base decl per role through dedupe (slide flex-shrink:0, viewport overflow hidden) and the [hidden] rule", () => {
  const out = renderSite(site(), opts)["css/styles.css"]!;
  expect(out).toContain(HIDDEN_RULE);
  expect(out).toMatch(/flex-shrink:0/);
  expect(out).toMatch(/overflow-x:hidden/);
  const plain = site();
  delete plain.sections[0]!.root.interactive;
  expect(renderSite(plain, opts)["css/styles.css"]).not.toContain(HIDDEN_RULE);
});

test("stripIds keeps data-ir-id only on nodes the cfg references (R6)", () => {
  const html = renderSite(site(), { ...opts, stripIds: true })["index.html"]!;
  for (const id of ["root", "vp", "tr", "s0", "s1", "nx"]) expect(html).toContain(`data-ir-id="${id}"`);
  expect(html).not.toContain('data-ir-id="plain"');
});

test("canvas: data-c* attributes shown, clone hidden, an untouched save diffs to no command", () => {
  const ir = site();
  const project = irToGrapes(compileV2(ir), "p1", opts);
  const root = project.components[0]!;
  expect(root.attributes["data-c"]).toBe("carousel");
  const track = root.components![0]!.components![0]!;
  expect(track.components!.map((c: GrapesComponent) => c.attributes["data-ir-id"])).toEqual(["s0", "s1"]);
  const json = JSON.parse(JSON.stringify({ components: project.components, styles: [] }));
  expect(grapesToCommands(ir, "p1", json, opts)).toEqual([]);
});
```

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run tests/unit/emit-components.test.ts`
Expected: FAIL — `HIDDEN_RULE` không export / không có `data-c`.

- [ ] **Step 3: Implement**

`interactive.ts` (thêm):

```ts
import type { Decl } from "./dedupe";

export function roleIndex(ir: IRV2): Map<string, Member[]> {
  const out = new Map<string, Member[]>();
  const visit = (n: IRNodeV2): void => {
    if (n.interactive) for (const [ref, role] of rolesOf(n.interactive)) out.set(ref, [...(out.get(ref) ?? []), { root: n.id, spec: n.interactive, role }]);
    n.children.forEach(visit);
  };
  ir.pages.forEach((p) => visit(p.shell));
  ir.sections.forEach((s) => visit(s.root));
  return out;
}

// Loop clones (E2 §2): hidden children of a carousel track that are not slides. They stay in the document, never in the output.
export function loopClones(ir: IRV2): Set<string> {
  const out = new Set<string>();
  const visit = (n: IRNodeV2): void => {
    const spec = n.interactive;
    if (spec?.kind === "carousel") {
      const slides = new Set(spec.slides);
      walk(n, (m) => { if (m.id === spec.track) for (const c of m.children) if (c.tag !== "#text" && c.hidden && !slides.has(c.id)) out.add(c.id); });
    }
    n.children.forEach(visit);
  };
  ir.pages.forEach((p) => visit(p.shell));
  ir.sections.forEach((s) => visit(s.root));
  return out;
}

// CSS the runtime relies on (E2 §4), only where the captured style differs. Panels need none (R13): they are
// shown/hidden the way the capture hid them.
export function baseDecl(spec: InteractiveSpec, roles: Role[], captured: Decl): Decl {
  if (spec.kind !== "carousel") return {};
  const want: Decl = {};
  const fade = spec.transition === "fade";
  if (roles.includes("viewport") && spec.source !== "scroll-snap") Object.assign(want, { "overflow-x": "hidden", "overflow-y": "hidden" });
  if (roles.includes("track")) Object.assign(want, fade ? { display: "grid" } : { display: "flex", ...(spec.direction === "vertical" && { "flex-direction": "column" }) });
  if (roles.includes("slide")) Object.assign(want, fade ? { "grid-area": "1 / 1" } : { "flex-shrink": "0" });
  return Object.fromEntries(Object.entries(want).filter(([prop, value]) => captured[prop] !== value));
}
```

`ir-legacy.ts` (`LegacyIRNode`):

```ts
  // view-only (compileV2, E2 §4), never stored: component attrs (null drops the captured attr of that name), a loop
  // clone the renderer skips, an id kept under stripIds, an iframe embed (its page gets the frame-src meta CSP)
  c?: Record<string, string | null>;
  skip?: true;
  keepId?: true;
  embed?: true;
```

`emit-html.ts` — `compileV2` (sau `const ir = resolveComponents(input);`):

```ts
  const members = roleIndex(ir), clones = loopClones(ir);
  const rolesOfNode = (n: IRNodeV2): Role[] => [...new Set((members.get(n.id) ?? []).map((m) => m.role))];
  const withBase = (n: IRNodeV2): NodeStyles => {
    const extra = Object.assign({}, ...(members.get(n.id) ?? []).map((m) => baseDecl(m.spec, [m.role], n.styles.base)));
    return Object.keys(extra).length ? { ...n.styles, base: { ...n.styles.base, ...extra } } : n.styles;
  };
  const styled = (n: IRNodeV2): StyledNode => ({ id: n.id, tag: n.tag, attrs: n.attrs, style: styleSetOf(withBase(n)), children: n.children.map(styled) });
```

và trong `toV1`:

```ts
    const roles = rolesOfNode(n), c: Record<string, string | null> = {};
    if (n.interactive) Object.assign(c, { "data-c": n.interactive.kind, "data-c-cfg": cfgOf(n.interactive) });
    if (roles.length) c["data-c-role"] = roles.join(" ");
    if (Object.keys(c).length) out.c = c;
    if (clones.has(n.id)) out.skip = true;
    if (n.interactive || members.has(n.id)) out.keepId = true;
```

`renderAttrs`: trong vòng attrs thêm `if (node.c && Object.hasOwn(node.c, name)) continue;`; sau class (trước block `behavior` cũ, giữ nguyên tới Task 6):

```ts
  for (const [name, value] of Object.entries(node.c ?? {})) if (value !== null) out += ` ${name}="${escAttr(value)}"`;
```

dòng `data-ir-id`: `if (!ctx.opts.stripIds || node.keepId) out += ...`. `renderNode`: đầu hàm thêm `if (node.skip) return;`. `renderCss`: `export const HIDDEN_RULE = "[data-c-role][hidden]{display:none!important}";` và trước `lines.push(block(MEDIA_768 ...))`:

```ts
  const hasComponent = (n: IRNode): boolean => !!n.c?.["data-c"] || n.children.some(hasComponent);
  if (ir.sections.some((s) => hasComponent(s.root)) || ir.pages.some((p) => hasComponent(p.shell))) lines.push(HIDDEN_RULE);
```

`grapes-adapter.ts`:

```ts
const SKIP_ATTRS = new Set([ID, "class", "style", "id", "srcdoc", "data-c", "data-c-cfg", "data-c-role"]);
const shown = (n: IRNode) => !n.skip && (n.tag === "#text" || n.tag === "#section" || (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(n.tag) && !HIDDEN_TAGS.has(n.tag.toLowerCase())));
// toComponent: the runtime's attributes ride along for the edit-mode canvas (R8); SKIP_ATTRS keeps them out of the diff
    const attributes: Record<string, string> = { [ID]: node.id };
    for (const [name, value] of Object.entries(node.attrs)) if (safeAttr(node.tag, name, value)) attributes[name] = rewrite(node, name, value, base);
    for (const [name, value] of Object.entries(node.c ?? {})) if (value !== null && name.startsWith("data-c")) attributes[name] = value;
```

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run tests/unit/emit-components.test.ts tests/unit/emit.test.ts tests/unit/emit-v2.test.ts tests/unit/grapes-adapter.test.ts; npm run typecheck`
Expected: PASS (chưa tài liệu nào có `interactive` ngoài test này nên output cũ không đổi).

- [ ] **Step 5: Commit**

```bash
git add -- src/core/interactive.ts src/core/ir-legacy.ts src/core/emit-html.ts src/core/grapes-adapter.ts tests/unit/emit-components.test.ts
git commit -m "feat(e2): emit data-c/data-c-cfg/data-c-role, base component CSS, skip loop clones, canvas carries component attrs" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Runtime lõi + carousel, mode `?qa=1` / `?edit=1`

**Files:**
- Modify: `src/core/runtime.js` (viết lại; khối `[data-behavior]` cũ giữ nguyên trong IIFE riêng ở cuối file tới Task 6)
- Create: `tests/e2e/component-site.ts` (helper dựng IR + emit + serve), `tests/e2e/runtime-components.test.ts`, `tests/unit/runtime-size.test.ts`
- Modify: `tests/e2e/emit-render.test.ts:90` (giới hạn kích thước `3_500` → `15 * 1024`)

**Interfaces:**
- Consumes: Task 2 attributes `data-c`, `data-c-cfg`, `data-c-role`, `data-ir-id`.
- Produces: runtime đặt `data-c-active="<i>"` trên gốc carousel/tabs mỗi khi đổi item (QA hành vi Task 9 đọc nó); `postMessage({ type: "aiwc:show", root: <rootId>, index: <n> })` chỉ có tác dụng ở `runtime.js?edit=1` và chỉ khi `event.source === window.parent`; cảnh báo lỗi cấu hình `console.warn("aiwc runtime: component skipped", id, message)`. Test helper `tests/e2e/component-site.ts`: `n`, `t`, `css`, `siteOf(root: IRNodeV2): IRV2`, `carouselRoot(over?: Partial<CarouselSpec>): IRNodeV2`, `emitAndServe(ir: IRV2, tmp: string): Promise<{ url: string; outDir: string; close(): Promise<void> }>`.

- [ ] **Step 1: Viết helper + test đỏ**

`tests/e2e/component-site.ts`:

```ts
// Hand-built IR v2 pages with components, emitted and served for runtime / QA tests (E2 Tasks 3, 4, 9).
import { join } from "node:path";
import { emitHtml } from "@/core/emit-html";
import type { CarouselSpec } from "@/core/interactive";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";
import { serveDir } from "@/core/serve";

export const css = (base: Record<string, string> = {}) => ({ base, bp: {}, state: {}, pseudo: {} });
export const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: css(), children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
export const t = (id: string, text: string) => n(id, "#text", [], { text });
export function siteOf(...roots: IRNodeV2[]): IRV2 {
  const sections = roots.map((root, i) => ({ id: `s${i}`, pageId: "home", name: `s${i}`, role: "block", hash: `h${i}`, origin: "capture" as const, root }));
  return {
    version: 2, revision: 0,
    pages: [{ id: "home", path: "/", title: "R", meta: {}, sectionIds: sections.map((s) => s.id), shell: n("html", "html", [n("body", "body",
      sections.map((s) => n(`ph-${s.id}`, "#section", [], { attrs: { "data-section": s.id } })), { styles: css({ margin: "0px" }) })]) }],
    sections, layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
  };
}
const COLORS = ["rgb(200, 0, 0)", "rgb(0, 200, 0)", "rgb(0, 0, 200)"];
export function carouselRoot(over: Partial<CarouselSpec> = {}, prefix = ""): IRNodeV2 {
  const p = (id: string) => `${prefix}${id}`;
  const slides = [0, 1, 2].map((i) => n(p(`sl${i}`), "div", [t(p(`sl${i}t`), `Slide ${i + 1}`)], { styles: css({ height: "100px", "background-color": COLORS[i]! }) }));
  return n(p("root"), "section", [
    n(p("vp"), "div", [n(p("tr"), "div", slides, { styles: css({ display: "flex" }) })], { styles: css({ width: "300px" }) }),
    n(p("prev"), "button", [t(p("pt"), "Prev")]), n(p("next"), "button", [t(p("nt"), "Next")]),
    n(p("dots"), "div", [0, 1, 2].map((i) => n(p(`d${i}`), "span", [t(p(`d${i}t`), "•")], { styles: css({ opacity: i === 0 ? "1" : "0.4" }) }))),
  ], { interactive: {
    kind: "carousel", source: "swiper", confidence: "config", viewport: p("vp"), track: p("tr"), slides: slides.map((s) => s.id), active: 0,
    autoplay: false, interval: 1000, loop: false, direction: "horizontal", transition: "slide", speed: 0,
    slidesPerView: { "1440": 1 }, gap: { "1440": 0 }, arrows: { prev: p("prev"), next: p("next") }, pagination: { container: p("dots"), kind: "bullets" }, ...over,
  } });
}
export async function emitAndServe(ir: IRV2, dir: string): Promise<{ url: string; outDir: string; close(): Promise<void> }> {
  const outDir = join(dir, "out");
  await emitHtml(ir, { outDir, workspaceDir: dir, assetMap: {}, pageUrls: { home: "https://x.test/" } });
  const server = await serveDir(outDir);
  return { url: `${server.url}/index.html`, outDir, close: server.close };
}
```

`tests/unit/runtime-size.test.ts`:

```ts
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("js/runtime.js stays <= 15 KB (E2 §10)", () => {
  expect(statSync(fileURLToPath(new URL("../../src/core/runtime.js", import.meta.url))).size).toBeLessThanOrEqual(15 * 1024);
});
```

`tests/e2e/runtime-components.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import type { CarouselSpec } from "@/core/interactive";
import { carouselRoot, emitAndServe, n, siteOf, t } from "./component-site";

let handle: BrowserHandle;
let tmp = "";
const closers: (() => Promise<void>)[] = [];
beforeAll(async () => { handle = await openBrowser({ headed: false }); tmp = await mkdtemp(join(tmpdir(), "runtime-c-")); });
afterAll(async () => { await handle.close(); for (const close of closers) await close(); await rm(tmp, { recursive: true, force: true }); });

let seq = 0;
async function serve(...roots: Parameters<typeof siteOf>): Promise<{ url: string; outDir: string }> {
  const site = await emitAndServe(siteOf(...roots), join(tmp, `s${++seq}`));
  closers.push(site.close);
  return site;
}
const active = (page: Page, root = "root") => page.getAttribute(`[data-ir-id="${root}"]`, "data-c-active");
const warnings = (page: Page) => { const out: string[] = []; page.on("console", (m) => { if (m.type() === "warning") out.push(m.text()); }); return out; };

test("carousel: next/prev move one slide, ARIA set, prev disabled (aria) at the start without loop", async () => {
  const { url } = await serve(carouselRoot());
  await withPage(handle, async (page) => {
    await page.goto(url);
    expect(await active(page)).toBe("0");
    expect(await page.getAttribute('[data-ir-id="root"]', "aria-roledescription")).toBe("carousel");
    expect(await page.getAttribute('[data-ir-id="sl1"]', "aria-label")).toBe("2 / 3");
    expect(await page.getAttribute('[data-ir-id="prev"]', "aria-disabled")).toBe("true");
    await page.click('[data-ir-id="next"]');
    expect(await active(page)).toBe("1");
    expect(await page.$eval('[data-ir-id="tr"]', (el) => (el as HTMLElement).style.transform)).toBe("translate3d(-300px, 0px, 0px)");
    await page.click('[data-ir-id="prev"]');
    expect(await active(page)).toBe("0");
    await page.focus('[data-ir-id="next"]');
    await page.keyboard.press("ArrowRight");
    expect(await active(page)).toBe("1");
  });
});

test("carousel: loop wraps both ways; bullets go to a slide; fraction shows n / N", async () => {
  const { url } = await serve(carouselRoot({ loop: true }), carouselRoot({ pagination: { container: "f-dots", kind: "fraction" } }, "f-"));
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.click('[data-ir-id="prev"]');
    expect(await active(page)).toBe("2");
    await page.click('[data-ir-id="next"]');
    expect(await active(page)).toBe("0");
    const bullets = page.locator('[data-ir-id="dots"] > *');
    expect(await bullets.count()).toBe(3);
    await bullets.nth(2).click();
    expect(await active(page)).toBe("2");
    expect(await page.textContent('[data-ir-id="f-dots"]')).toBe("1 / 3");
  });
});

test("carousel: autoplay advances within 1.5 x interval, pauses on hover; reduced motion disables it", async () => {
  const { url } = await serve(carouselRoot({ autoplay: true, interval: 1000, loop: true }));
  await withPage(handle, async (page) => {
    await page.clock.install();
    await page.goto(url);
    await page.clock.runFor(1500);
    expect(await active(page)).toBe("1");
    await page.hover('[data-ir-id="vp"]');
    await page.clock.runFor(3000);
    expect(await active(page)).toBe("1");
  });
  await withPage(handle, async (page) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.install();
    await page.goto(url);
    await page.clock.runFor(5000);
    expect(await active(page)).toBe("0");
  });
});

test("Review Focus 4 — ?qa=1: capture state (active), no autoplay, no transition, identical screenshots", async () => {
  const { url } = await serve(carouselRoot({ autoplay: true, interval: 1000, loop: true, active: 2, speed: 400 }));
  await withPage(handle, async (page) => {
    await page.clock.install();
    await page.goto(`${url}?qa=1`);
    const first = await page.screenshot();
    await page.clock.runFor(5000);
    expect(await active(page)).toBe("2");
    expect(await page.$eval('[data-ir-id="tr"]', (el) => (el as HTMLElement).style.transition)).toBe("none");
    expect((await page.screenshot()).equals(first)).toBe(true);
  });
});

test("responsive: slidesPerView/gap per breakpoint (768/375 inherit from the next wider one)", async () => {
  const { url } = await serve(carouselRoot({ slidesPerView: { "1440": 2, "375": 1 }, gap: { "1440": 10 } }));
  await withPage(handle, async (page) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url);
    expect(await page.$eval('[data-ir-id="sl0"]', (el) => el.getBoundingClientRect().width)).toBe(145);
    await page.setViewportSize({ width: 800, height: 900 }); // 768 bucket inherits 1440
    await expect.poll(() => page.$eval('[data-ir-id="sl0"]', (el) => el.getBoundingClientRect().width)).toBe(145);
    await page.setViewportSize({ width: 375, height: 900 });
    await expect.poll(() => page.$eval('[data-ir-id="sl0"]', (el) => el.getBoundingClientRect().width)).toBe(300);
  });
});

test("a broken component is skipped with console.warn; the others still run", async () => {
  const broken = carouselRoot({ slides: ["b-sl0", "missing", "b-sl2"] }, "b-");
  const { url } = await serve(broken, carouselRoot());
  await withPage(handle, async (page) => {
    const warned = warnings(page);
    await page.goto(url);
    await page.click('[data-ir-id="next"]');
    expect(await active(page)).toBe("1");
    expect(warned.some((w) => w.includes("aiwc runtime: component skipped"))).toBe(true);
  });
});

test("?edit=1 (script src): no input handlers, no autoplay; postMessage from the parent shows the item", async () => {
  const { url, outDir } = await serve(carouselRoot({ autoplay: true, interval: 1000 }));
  const file = join(outDir, "index.html");
  await writeFile(file, (await readFile(file, "utf8")).replace('src="js/runtime.js"', 'src="js/runtime.js?edit=1"'));
  await withPage(handle, async (page) => {
    await page.clock.install();
    await page.goto(url);
    await page.click('[data-ir-id="next"]');
    await page.clock.runFor(3000);
    expect(await active(page)).toBeNull(); // not initialised until the editor asks
    await page.evaluate(() => window.postMessage({ type: "aiwc:show", root: "root", index: 2 }, "*"));
    await expect.poll(() => active(page)).toBe("2");
  });
});
```

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/runtime-components.test.ts`
Expected: FAIL — `data-c-active` là `null` (runtime cũ không biết `data-c`).

- [ ] **Step 3: Viết runtime (lõi + carousel)**

`src/core/runtime.js` — thay toàn bộ phần đầu, giữ nội dung cũ trong một IIFE thứ hai ở cuối file với dòng chú thích `// legacy [data-behavior] for E1 documents: removed in E2 Task 6`:

```js
// AI Web Clone runtime (E2 §4): plain browser JS copied verbatim to out/js/runtime.js — no dependency, no bundling,
// works on file://. Each [data-c] root is one component; data-c-cfg names its parts by data-ir-id. A component whose
// config is broken is skipped with console.warn; the others still run.
// Modes: ?qa=1 on the page (QA: capture state, no autoplay, no motion); runtime.js?edit=1 (editor canvas: only shows
// the item the panel picks through postMessage — no autoplay, no input handlers).
(function () {
  "use strict";
  var me = document.currentScript;
  var MODE = /[?&]edit=1(&|$)/.test(me ? me.src : "") ? "edit" : /[?&]qa=1(&|$)/.test(location.search) ? "qa" : "live";
  var still = MODE !== "live" || !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  var esc = function (s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"); };
  var byId = function (id) { return id ? document.querySelector('[data-ir-id="' + esc(id) + '"]') : null; };
  var need = function (id) { var el = byId(id); if (!el) throw new Error("missing node " + id); return el; };
  var on = function (el, type, fn) { if (MODE !== "edit") el.addEventListener(type, fn); };
  var bp = function () { return matchMedia("(max-width: 767.98px)").matches ? "375" : matchMedia("(max-width: 1439.98px)").matches ? "768" : "1440"; };
  // a breakpoint value inherits from the next wider one, like the styles
  function at(map, fallback) {
    var order = { "375": ["375", "768", "1440"], "768": ["768", "1440"], "1440": ["1440"] }[bp()];
    for (var k = 0; k < order.length; k++) if (map && map[order[k]] != null) return map[order[k]];
    return fallback;
  }
  // R13: shown / hidden the way the capture had it ([hidden], display, visibility or opacity)
  function shown(el) { var cs = getComputedStyle(el); return !el.hasAttribute("hidden") && cs.display !== "none" && cs.visibility !== "hidden" && cs.opacity !== "0"; }
  function show(el) { el.removeAttribute("hidden"); var cs = getComputedStyle(el); if (cs.display === "none") el.style.display = "block"; if (cs.visibility === "hidden") el.style.visibility = "visible"; if (cs.opacity === "0") el.style.opacity = "1"; }
  function hide(el) { el.style.removeProperty("display"); el.style.removeProperty("visibility"); el.style.removeProperty("opacity"); if (shown(el)) el.setAttribute("hidden", ""); }
  var kinds = {};

  kinds.carousel = function (root, c) {
    var vp = need(c.viewport), track = need(c.track), slides = c.slides.map(need), n = slides.length;
    var vertical = c.direction === "vertical", fade = c.transition === "fade", native = vp === track;
    var prev = c.arrows ? byId(c.arrows.prev) : null, next = c.arrows ? byId(c.arrows.next) : null;
    var pag = c.pagination ? byId(c.pagination.container) : null, dots = [], dotOn = "", dotOff = "";
    var i = Math.min(c.active, n - 1), L = { step: 0, max: 0, end: false }, hold = false;
    root.setAttribute("aria-roledescription", "carousel");
    vp.setAttribute("aria-live", c.autoplay && !still ? "off" : "polite");
    slides.forEach(function (s, k) { s.setAttribute("role", "group"); s.setAttribute("aria-roledescription", "slide"); s.setAttribute("aria-label", k + 1 + " / " + n); });
    if (prev && !prev.hasAttribute("aria-label")) prev.setAttribute("aria-label", "Slide trước");
    if (next && !next.hasAttribute("aria-label")) next.setAttribute("aria-label", "Slide sau");
    if (pag && c.pagination.kind === "bullets") {
      // reuse the captured bullets' classes: the active one and an idle one
      var kids = Array.prototype.filter.call(pag.children, function (e) { return e.nodeType === 1; });
      var cur = kids[i] || kids[0], idle = kids.filter(function (e) { return e !== cur; })[0] || cur;
      dotOn = cur ? cur.getAttribute("class") || "" : ""; dotOff = idle ? idle.getAttribute("class") || "" : "";
      var proto = idle || document.createElement("button");
      pag.textContent = "";
      for (var k = 0; k < n; k++) (function (k) {
        var d = proto.cloneNode(true);
        d.removeAttribute("data-ir-id"); d.removeAttribute("data-c-role");
        if (d.tagName !== "BUTTON") { d.setAttribute("role", "button"); d.tabIndex = 0; }
        d.setAttribute("aria-label", "Tới slide " + (k + 1));
        on(d, "click", function (e) { e.preventDefault(); go(k); });
        pag.appendChild(d); dots.push(d);
      })(k);
    }
    function layout() {
      var per = fade ? 1 : at(c.slidesPerView, 1), gap = fade ? 0 : at(c.gap, 0);
      var box = vertical ? vp.clientHeight : vp.clientWidth, w = (box - gap * (per - 1)) / per;
      if (!fade) {
        track.style.columnGap = track.style.rowGap = "0px";
        slides.forEach(function (s, k) {
          s.style.flex = "0 0 " + w + "px";
          s.style[vertical ? "height" : "width"] = w + "px";
          s.style[vertical ? "marginBottom" : "marginRight"] = (k < n - 1 ? gap : 0) + "px";
        });
      }
      return { step: w + gap, max: Math.max(0, n * (w + gap) - gap - box) };
    }
    function go(k, instant) {
      i = c.loop ? ((k % n) + n) % n : Math.max(0, Math.min(k, n - 1));
      var m = layout(), quick = still || instant;
      var off = Math.min(native ? (vertical ? slides[i].offsetTop - slides[0].offsetTop : slides[i].offsetLeft - slides[0].offsetLeft) : i * m.step, m.max);
      L = { step: m.step, max: m.max, end: off >= m.max - 0.5 };
      if (fade) slides.forEach(function (s, j) { s.style.transition = quick ? "none" : "opacity " + c.speed + "ms"; s.style.opacity = j === i ? "1" : "0"; s.style.pointerEvents = j === i ? "" : "none"; });
      else if (native) vp.scrollTo(vertical ? { top: off, behavior: quick ? "instant" : "smooth" } : { left: off, behavior: quick ? "instant" : "smooth" });
      else {
        track.style.transition = quick ? "none" : "transform " + c.speed + "ms ease";
        track.style.transform = vertical ? "translate3d(0px, " + -off + "px, 0px)" : "translate3d(" + -off + "px, 0px, 0px)";
      }
      root.setAttribute("data-c-active", String(i));
      if (prev) prev.setAttribute("aria-disabled", String(!c.loop && i === 0)); // aria only: no UA :disabled look (QA pixels)
      if (next) next.setAttribute("aria-disabled", String(!c.loop && L.end));
      dots.forEach(function (d, j) { d.setAttribute("class", j === i ? dotOn : dotOff); d.setAttribute("aria-current", String(j === i)); });
      if (pag && c.pagination.kind === "fraction") pag.textContent = i + 1 + " / " + n;
    }
    if (prev) on(prev, "click", function (e) { e.preventDefault(); go(i - 1); });
    if (next) on(next, "click", function (e) { e.preventDefault(); go(i + 1); });
    on(root, "keydown", function (e) {
      var back = vertical ? "ArrowUp" : "ArrowLeft", fwd = vertical ? "ArrowDown" : "ArrowRight";
      if (e.key !== back && e.key !== fwd) return;
      e.preventDefault(); go(e.key === fwd ? i + 1 : i - 1);
    });
    var from = null;
    on(vp, "pointerdown", function (e) { from = vertical ? e.clientY : e.clientX; });
    on(vp, "pointerup", function (e) {
      if (from === null) return;
      var d = (vertical ? e.clientY : e.clientX) - from; from = null;
      if (Math.abs(d) > 40) go(d < 0 ? i + 1 : i - 1);
    });
    if (native) { var settle = 0; on(vp, "scroll", function () { clearTimeout(settle); settle = setTimeout(function () { var p = vertical ? vp.scrollTop : vp.scrollLeft; if (L.step) { i = Math.min(n - 1, Math.round(p / L.step)); root.setAttribute("data-c-active", String(i)); } }, 120); }); }
    if (c.autoplay && !still) {
      setInterval(function () { if (!hold && !document.hidden) go(c.loop || !L.end ? i + 1 : 0); }, c.interval);
      on(root, "mouseenter", function () { hold = true; }); on(root, "mouseleave", function () { hold = false; });
      on(root, "focusin", function () { hold = true; }); on(root, "focusout", function () { hold = false; });
    }
    if (MODE !== "edit") addEventListener("resize", function () { go(i, true); });
    go(i, true);
    return { show: function (k) { go(k, true); } };
  };

  function init(root) {
    if (root.__aiwc) return root.__aiwc;
    var id = root.getAttribute("data-ir-id") || "?";
    try {
      var kind = root.getAttribute("data-c"), c = JSON.parse(root.getAttribute("data-c-cfg") || "null");
      if (!c || c.kind !== kind || !Object.prototype.hasOwnProperty.call(kinds, kind)) throw new Error("unknown component " + kind);
      root.__aiwc = kinds[kind](root, c) || {};
    } catch (e) {
      console.warn("aiwc runtime: component skipped", id, e && e.message);
      root.__aiwc = {};
    }
    return root.__aiwc;
  }
  if (MODE === "edit") addEventListener("message", function (e) {
    var d = e.data, root = d && d.type === "aiwc:show" && e.source === window.parent ? byId(d.root) : null;
    var api = root && root.hasAttribute("data-c") ? init(root) : null;
    if (api && api.show) api.show(Number(d.index) || 0);
  });
  else Array.prototype.forEach.call(document.querySelectorAll("[data-c]"), init);
})();
```

`tests/e2e/emit-render.test.ts:90`: `toBeLessThan(3_500)` → `toBeLessThanOrEqual(15 * 1024)`.

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run tests/unit/runtime-size.test.ts; npx vitest run -c vitest.e2e.config.ts tests/e2e/runtime-components.test.ts tests/e2e/emit-render.test.ts tests/e2e/files-csp.test.ts`
Expected: PASS (menu test của emit-render vẫn chạy bằng khối legacy).

- [ ] **Step 5: Commit**

```bash
git add -- src/core/runtime.js tests/e2e/component-site.ts tests/e2e/runtime-components.test.ts tests/unit/runtime-size.test.ts tests/e2e/emit-render.test.ts
git commit -m "feat(e2): component runtime core and carousel (loop, autoplay, arrows, pagination, swipe, keys, ARIA, qa/edit modes)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Runtime tabs/accordion/modal/dropdown/menu/video, embed + CSP

**Files:**
- Modify: `src/core/runtime.js` (thêm `kinds.tabs`, `kinds.accordion`, `kinds.modal`, `kinds.dropdown = kinds.menu`, `kinds.video` trước `function init`), `src/core/emit-html.ts` (`compileV2` attr video/embed, `renderPage` meta CSP), `src/core/interactive.ts` (`videoAttrs`, `embedSrc`)
- Test: `tests/e2e/runtime-components.test.ts` (thêm), `tests/unit/emit-components.test.ts` (thêm)

**Interfaces:**
- Consumes: Task 3 helpers (`show`, `hide`, `shown`, `on`, `need`, `byId`, `MODE`, `still`), `component-site.ts`.
- Produces: `videoAttrs(spec: VideoSpec): Record<string, string | null>` (cờ boolean, `null` = bỏ), `embedSrc(raw: string, spec: VideoSpec): string | undefined` (chỉ host trong `EMBED_HOSTS`, YouTube → `www.youtube-nocookie.com`), hằng `EMBED_CSP` export từ `emit-html.ts`. Modal đặt `data-c-open="true|false"` trên gốc khi mở/đóng.

- [ ] **Step 1: Viết test đỏ**

Thêm vào `tests/e2e/runtime-components.test.ts`:

```ts
const tabsRoot = () => n("tabs", "section", [
  n("tl", "div", [n("tab0", "button", [t("a", "One")]), n("tab1", "button", [t("b", "Two")])]),
  n("p0", "div", [t("c", "Panel one")]),
  n("p1", "div", [t("d", "Panel two")], { attrs: { hidden: "" }, styles: { base: { display: "none" }, bp: {}, state: {}, pseudo: {} } }),
], { interactive: { kind: "tabs", source: "aria", confidence: "guessed", tabs: [{ trigger: "tab0", panel: "p0" }, { trigger: "tab1", panel: "p1" }], active: 0 } });

test("tabs: click and arrow keys select, aria-selected/tabindex follow, panels shown the way the capture hid them", async () => {
  const { url } = await serve(tabsRoot());
  await withPage(handle, async (page) => {
    await page.goto(url);
    expect(await page.isVisible('[data-ir-id="p1"]')).toBe(false);
    await page.click('[data-ir-id="tab1"]');
    expect(await page.isVisible('[data-ir-id="p1"]')).toBe(true);
    expect(await page.isVisible('[data-ir-id="p0"]')).toBe(false);
    expect(await page.getAttribute('[data-ir-id="tab1"]', "aria-selected")).toBe("true");
    expect(await page.getAttribute('[data-ir-id="tab0"]', "tabindex")).toBe("-1");
    await page.keyboard.press("Home");
    expect(await page.isVisible('[data-ir-id="p0"]')).toBe(true);
  });
});

test("accordion: <details> stays native (multiple=false closes the others); ARIA items toggle aria-expanded", async () => {
  const det = (i: number) => n(`dt${i}`, "details", [n(`sm${i}`, "summary", [t(`smt${i}`, `Q${i}`)]), n(`an${i}`, "p", [t(`ant${i}`, `A${i}`)])]);
  const native = n("acc", "section", [det(0), det(1)], { interactive: { kind: "accordion", source: "details", confidence: "guessed", multiple: false, items: [0, 1].map((i) => ({ trigger: `sm${i}`, panel: `an${i}`, open: false })) } });
  const aria = n("acc2", "section", [n("q", "button", [t("qt", "Q")]), n("a", "div", [t("at", "A")], { styles: { base: { display: "none" }, bp: {}, state: {}, pseudo: {} } })],
    { interactive: { kind: "accordion", source: "aria", confidence: "guessed", multiple: true, items: [{ trigger: "q", panel: "a", open: false }] } });
  const { url } = await serve(native, aria);
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.click('[data-ir-id="sm0"]');
    await page.click('[data-ir-id="sm1"]');
    await expect.poll(() => page.$eval('[data-ir-id="dt0"]', (d) => (d as HTMLDetailsElement).open)).toBe(false);
    await page.click('[data-ir-id="q"]');
    expect(await page.isVisible('[data-ir-id="a"]')).toBe(true);
    expect(await page.getAttribute('[data-ir-id="q"]', "aria-expanded")).toBe("true");
  });
});

test("Review Focus 5 — modal: a trigger in another section opens it; focus moves in, stays in (Tab), Esc closes, scroll lock, focus returns", async () => {
  const dialog = n("dlg", "div", [t("dt", "Body "), n("ok", "button", [t("okt", "OK")]), n("x", "button", [t("xt", "Đóng")])],
    { attrs: { hidden: "" }, styles: { base: { display: "none" }, bp: {}, state: {}, pseudo: {} },
      interactive: { kind: "modal", source: "aria", confidence: "guessed", triggers: ["open"], dialog: "dlg", closeOn: ["esc", "backdrop", "button"], closeButton: "x" } });
  const { url } = await serve(n("head-sec", "section", [n("open", "button", [t("ot", "Open")])]), n("foot", "section", [dialog]));
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.click('[data-ir-id="open"]');
    expect(await page.isVisible('[data-ir-id="dlg"]')).toBe(true);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-ir-id"))).toBe("ok");
    expect(await page.evaluate(() => document.documentElement.style.overflow)).toBe("hidden");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab"); // wraps from the last focusable back to the first
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-ir-id"))).toBe("ok");
    await page.keyboard.press("Escape");
    expect(await page.isVisible('[data-ir-id="dlg"]')).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-ir-id"))).toBe("open");
    await page.click('[data-ir-id="open"]');
    await page.click('[data-ir-id="x"]');
    expect(await page.isVisible('[data-ir-id="dlg"]')).toBe(false);
  });
});

test("dropdown: hover opens, closes 150 ms after leaving; click-kind opens on click, outside click and Esc close", async () => {
  const hidden = { base: { visibility: "hidden" }, bp: {}, state: {}, pseudo: {} };
  const hover = n("dd", "nav", [n("dt-a", "a", [t("x1", "Menu")], { attrs: { href: "#" } }), n("dp", "ul", [n("li", "li", [t("x2", "Item")])], { styles: hidden })],
    { interactive: { kind: "menu", source: "aria", confidence: "observed", trigger: "dt-a", panel: "dp", openOn: "hover" } });
  const click = n("dc", "div", [n("ct", "button", [t("x3", "Account")]), n("cp", "ul", [n("cli", "li", [t("x4", "Profile")])], { styles: hidden })],
    { interactive: { kind: "dropdown", source: "aria", confidence: "guessed", trigger: "ct", panel: "cp", openOn: "click" } });
  const { url } = await serve(hover, click);
  await withPage(handle, async (page) => {
    await page.goto(url);
    await page.hover('[data-ir-id="dt-a"]');
    expect(await page.isVisible('[data-ir-id="dp"]')).toBe(true);
    await page.mouse.move(1000, 800);
    await expect.poll(() => page.isVisible('[data-ir-id="dp"]')).toBe(false);
    await page.click('[data-ir-id="ct"]');
    expect(await page.getAttribute('[data-ir-id="ct"]', "aria-expanded")).toBe("true");
    await page.mouse.click(1000, 800);
    expect(await page.isVisible('[data-ir-id="cp"]')).toBe(false);
    await page.click('[data-ir-id="ct"]');
    await page.keyboard.press("Escape");
    expect(await page.isVisible('[data-ir-id="cp"]')).toBe(false);
  });
});

test("video: native attributes follow the spec (autoplay forces muted); ?qa=1 keeps it paused", async () => {
  const v = n("vid", "video", [], { attrs: { controls: "" }, interactive: { kind: "video", source: "native", confidence: "guessed", node: "vid", mode: "native", autoplay: true, muted: true, loop: true, controls: false } });
  const { url } = await serve(n("vs", "section", [v]));
  await withPage(handle, async (page) => {
    await page.goto(`${url}?qa=1`);
    const state = await page.$eval('[data-ir-id="vid"]', (el) => { const v = el as HTMLVideoElement; return { muted: v.muted, loop: v.loop, controls: v.controls, paused: v.paused }; });
    expect(state).toEqual({ muted: true, loop: true, controls: false, paused: true });
  });
});
```

Thêm vào `tests/unit/emit-components.test.ts`:

```ts
import { EMBED_CSP } from "@/core/emit-html";
import { embedSrc, type VideoSpec } from "@/core/interactive";

const embed: VideoSpec = { kind: "video", source: "native", confidence: "guessed", node: "if", mode: "embed", autoplay: true, muted: true, loop: false, controls: true };
test("embed: only allowlisted hosts, YouTube goes to youtube-nocookie; the page gets the frame-src meta CSP", () => {
  expect(embedSrc("https://www.youtube.com/embed/abc123?rel=0", embed)).toBe("https://www.youtube-nocookie.com/embed/abc123?autoplay=1&mute=1");
  expect(embedSrc("https://player.vimeo.com/video/42", { ...embed, autoplay: false, muted: false })).toBe("https://player.vimeo.com/video/42");
  expect(embedSrc("https://evil.test/embed/abc", embed)).toBeUndefined();
  const ir = site();
  ir.sections[0]!.root.children.push({ id: "if", parentId: "root", tag: "iframe", type: "media", attrs: { src: "https://www.youtube.com/embed/abc123" }, styles: css(), children: [] });
  ir.sections[0]!.root.children.at(-1)!.interactive = embed;
  const html = renderSite(ir, opts)["index.html"]!;
  expect(html).toContain('src="https://www.youtube-nocookie.com/embed/abc123?autoplay=1&amp;mute=1"');
  expect(html).not.toContain("www.youtube.com");
  expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${EMBED_CSP}">`);
  expect(renderSite(site(), opts)["index.html"]).not.toContain("Content-Security-Policy");
});
```

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run tests/unit/emit-components.test.ts; npx vitest run -c vitest.e2e.config.ts tests/e2e/runtime-components.test.ts`
Expected: FAIL — `embedSrc`/`EMBED_CSP` chưa có; tabs/modal `console.warn ... unknown component`.

- [ ] **Step 3: Implement**

`runtime.js` (trước `function init`):

```js
  kinds.tabs = function (root, c) {
    var list = c.tabs.map(function (x) { return { tab: need(x.trigger), panel: need(x.panel) }; }), i = Math.min(c.active, list.length - 1);
    function go(k, focus) {
      i = (k + list.length) % list.length;
      list.forEach(function (x, j) {
        x.tab.setAttribute("role", "tab"); x.tab.setAttribute("aria-selected", String(j === i)); x.tab.tabIndex = j === i ? 0 : -1;
        x.panel.setAttribute("role", "tabpanel"); j === i ? show(x.panel) : hide(x.panel);
      });
      root.setAttribute("data-c-active", String(i));
      if (focus) list[i].tab.focus();
    }
    list.forEach(function (x, j) {
      on(x.tab, "click", function (e) { e.preventDefault(); go(j); });
      on(x.tab, "keydown", function (e) {
        var k = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: list.length - 1 }[e.key];
        if (k !== undefined) { e.preventDefault(); go(k, true); }
      });
    });
    go(i);
    return { show: function (k) { go(k); } };
  };

  kinds.accordion = function (root, c) {
    var items = c.items.map(function (x) { return { t: need(x.trigger), p: need(x.panel), open: x.open }; });
    var det = function (x) { var d = x.t.parentElement; return x.t.tagName === "SUMMARY" && d && d.tagName === "DETAILS" ? d : null; };
    function set(x, open) { var d = det(x); if (d) d.open = open; else { open ? show(x.p) : hide(x.p); x.t.setAttribute("aria-expanded", String(open)); } }
    function others(j) { if (!c.multiple) items.forEach(function (o, k) { if (k !== j) set(o, false); }); }
    items.forEach(function (x, j) {
      var d = det(x);
      if (d) on(d, "toggle", function () { if (d.open) others(j); });
      else {
        x.t.setAttribute("aria-expanded", String(shown(x.p)));
        on(x.t, "click", function (e) { e.preventDefault(); var open = !shown(x.p); if (open) others(j); set(x, open); });
      }
    });
    if (MODE === "qa") items.forEach(function (x) { set(x, x.open); });
    return { show: function (j) { items.forEach(function (x, k) { set(x, k === j); }); } };
  };

  var FOCUSABLE = "a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex='-1'])";
  kinds.modal = function (root, c) {
    var dialog = need(c.dialog), triggers = c.triggers.map(need), close = c.closeButton ? byId(c.closeButton) : null, opener = null, lock = "";
    var can = function (k) { return c.closeOn.indexOf(k) >= 0; };
    if (!dialog.getAttribute("role")) dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    if (!dialog.hasAttribute("tabindex")) dialog.tabIndex = -1;
    function open(from) {
      opener = from; show(dialog);
      lock = document.documentElement.style.overflow; document.documentElement.style.overflow = "hidden";
      (dialog.querySelector(FOCUSABLE) || dialog).focus();
      root.setAttribute("data-c-open", "true");
    }
    function shut() {
      if (!shown(dialog)) return;
      hide(dialog); document.documentElement.style.overflow = lock; root.setAttribute("data-c-open", "false");
      if (opener) opener.focus(); opener = null;
    }
    triggers.forEach(function (x) { on(x, "click", function (e) { e.preventDefault(); open(x); }); });
    if (close && can("button")) on(close, "click", function (e) { e.preventDefault(); shut(); });
    if (can("backdrop")) on(dialog, "click", function (e) { if (e.target === dialog) shut(); });
    on(document, "keydown", function (e) {
      if (!shown(dialog)) return;
      if (e.key === "Escape" && can("esc")) return shut();
      if (e.key !== "Tab") return;
      var f = dialog.querySelectorAll(FOCUSABLE);
      if (!f.length) return e.preventDefault();
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    return { show: function () { open(null); } };
  };

  kinds.dropdown = kinds.menu = function (root, c) {
    var t = need(c.trigger), p = need(c.panel), timer = 0;
    function set(open) { clearTimeout(timer); open ? show(p) : hide(p); t.setAttribute("aria-expanded", String(open)); }
    if (c.openOn === "hover") {
      on(root, "mouseenter", function () { set(true); });
      on(root, "mouseleave", function () { clearTimeout(timer); timer = setTimeout(function () { set(false); }, 150); });
      on(t, "focus", function () { set(true); });
    } else on(t, "click", function (e) { e.preventDefault(); set(!shown(p)); });
    on(document, "click", function (e) { if (!root.contains(e.target) && shown(p)) set(false); });
    on(document, "keydown", function (e) { if (e.key === "Escape" && shown(p)) { set(false); t.focus(); } });
    t.setAttribute("aria-expanded", String(shown(p)));
    return { show: function () { set(true); } };
  };

  kinds.video = function (root, c) {
    var v = need(c.node);
    if (c.mode !== "native" || v.tagName !== "VIDEO") return {}; // embed: the iframe as emitted
    v.muted = c.muted || c.autoplay; v.loop = c.loop; v.controls = c.controls; v.autoplay = c.autoplay && !still;
    if (v.autoplay) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } else v.pause();
    return {};
  };
```

`interactive.ts`:

```ts
export function videoAttrs(spec: VideoSpec): Record<string, string | null> {
  const flag = (on: boolean) => (on ? "" : null);
  return { autoplay: flag(spec.autoplay), muted: flag(spec.muted || spec.autoplay), loop: flag(spec.loop), controls: flag(spec.controls), playsinline: flag(spec.autoplay) };
}
// E2 §4/§11: an embed keeps its iframe only on an allowlisted host; YouTube is served from youtube-nocookie.
export function embedSrc(raw: string, spec: VideoSpec): string | undefined {
  let u: URL;
  try { u = new URL(raw); } catch { return undefined; }
  const yt = /^(www\.|m\.)?youtube(-nocookie)?\.com$/.test(u.hostname) && /^\/embed\/[\w-]{1,64}$/.test(u.pathname);
  const vimeo = u.hostname === "player.vimeo.com" && /^\/video\/\d{1,20}$/.test(u.pathname);
  if (!yt && !vimeo) return undefined;
  const out = new URL(`https://${yt ? "www.youtube-nocookie.com" : "player.vimeo.com"}${u.pathname}`);
  if (spec.autoplay) out.searchParams.set("autoplay", "1");
  if (spec.muted || spec.autoplay) out.searchParams.set(yt ? "mute" : "muted", "1");
  if (spec.loop) out.searchParams.set("loop", "1");
  if (!spec.controls) out.searchParams.set("controls", "0");
  return out.href;
}
```

`emit-html.ts`: `export const EMBED_CSP = \`frame-src ${EMBED_HOSTS.map((h) => \`https://${h}\`).join(" ")}\`;`. Trong `toV1` sau khối `c`:

```ts
    const video = n.interactive?.kind === "video" ? n.interactive : undefined;
    if (video?.mode === "native") Object.assign(c, videoAttrs(video));
    if (video?.mode === "embed") {
      const src = embedSrc(n.attrs.src ?? "", video);
      c.src = src ?? null; // checkInteractives/guess only make allowlisted embeds; anything else loses its src
      if (src) out.embed = true;
    }
    if (Object.keys(c).length) out.c = c;
```

`renderPage`: render body trước, rồi `const embeds = (x: IRNode): boolean => !!x.embed || (x.tag === "#section" ? !!ctx.sections.get(x.attrs["data-section"] ?? "") && embeds(ctx.sections.get(x.attrs["data-section"] ?? "")!.root) : x.children.some(embeds));` và đầu `head`: `...(embeds(page.shell) ? [\`<meta http-equiv="Content-Security-Policy" content="${EMBED_CSP}">\`] : [])`.

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run tests/unit/emit-components.test.ts tests/unit/runtime-size.test.ts tests/unit/emit.test.ts; npx vitest run -c vitest.e2e.config.ts tests/e2e/runtime-components.test.ts tests/e2e/emit-render.test.ts tests/e2e/files-csp.test.ts; npm run typecheck`
Expected: PASS; `runtime.js` ≤ 15 KB.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/runtime.js src/core/emit-html.ts src/core/interactive.ts tests/e2e/runtime-components.test.ts tests/unit/emit-components.test.ts
git commit -m "feat(e2): runtime tabs, accordion, modal (focus trap, scroll lock), dropdown/menu, video; allowlisted embeds with frame-src meta CSP" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Fidelity cho component

**Files:**
- Modify: `src/core/fidelity.ts:14-25` (hằng, `Index`), `:38-49` (`indexIR`), `:149-176` (vòng interactions), `:184-224` (`analyze`, `buildFidelity`, `refreshFidelity`), `:118` (ghi chú script)
- Test: `tests/unit/fidelity-components.test.ts`

**Interfaces:**
- Consumes: Task 1 `InteractiveSpec`; Task 2 `roleIndex`.
- Produces: `COMPONENT_FEATURE = "component"` (suy lại mỗi lần từ IR), `COMPONENT_NOTE = "component-note"` (mang theo như item E1 không-analyzer), `componentFidelity(ir: IRV2, before: FidelityItem[]): FidelityItem[]`, `type BehaviorResult = { pageId: string; nodeId: string; kind: InteractiveKind; ok: boolean; reason?: string }` (export từ `fidelity.ts`, Task 9 dùng lại), `withBehavior(items: FidelityItem[], results: BehaviorResult[]): FidelityItem[]`. Interaction scan cũ (carousel/menu/tab/accordion/modal) có trigger là thành viên một component thì không còn item riêng.

- [ ] **Step 1: Viết test đỏ**

```ts
import { expect, test } from "vitest";
import { COMPONENT_FEATURE, COMPONENT_NOTE, componentFidelity, refreshFidelity, withBehavior } from "@/core/fidelity";
import type { InteractiveSpec } from "@/core/interactive";
import type { FidelityItem, IRNodeV2, IRV2 } from "@/core/ir-v2";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 =>
  ({ id, tag, type: "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra });
const tabs = (confidence: InteractiveSpec["confidence"]): InteractiveSpec => ({ kind: "tabs", source: "aria", confidence, tabs: [{ trigger: "a", panel: "b" }], active: 0 });
const ir = (spec?: InteractiveSpec, fidelity: FidelityItem[] = []): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "p", path: "/", title: "", meta: {}, sectionIds: ["s"], shell: n("html", "html", [n("ph", "#section", [], { attrs: { "data-section": "s" } })]) }],
  sections: [{ id: "s", pageId: "p", name: "s", role: "block", hash: "h", origin: "capture", root: n("r", "div", [n("a", "button"), n("b", "div")], spec ? { interactive: spec } : {}) }],
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity,
});

test("config -> supported, observed/guessed/manual -> partial; guessed asks for a re-clone; a partial note keeps config partial", () => {
  expect(componentFidelity(ir(tabs("config")), [])).toEqual([expect.objectContaining({ feature: COMPONENT_FEATURE, status: "supported", nodeId: "r", sourceRef: "r" })]);
  expect(componentFidelity(ir(tabs("observed")), [])[0]!.status).toBe("partial");
  expect(componentFidelity(ir(tabs("guessed")), [])[0]!.note).toContain("Clone lại để đọc cấu hình thật");
  const note: FidelityItem = { pageId: "p", feature: COMPONENT_NOTE, status: "partial", nodeId: "r", sourceRef: "r", note: "hiệu ứng coverflow không tái tạo" };
  expect(componentFidelity(ir(tabs("config"), [note]), [note])[0]!.status).toBe("partial");
});

test("unwrap: the node keeps an unsupported 'bỏ hành vi theo yêu cầu' item, carried until the interactive comes back", () => {
  const before = componentFidelity(ir(tabs("config")), []);
  const unwrapped = refreshFidelity(before, ir(), []);
  expect(unwrapped.find((x) => x.feature === COMPONENT_FEATURE)).toMatchObject({ status: "unsupported", nodeId: "r", note: expect.stringContaining("bỏ hành vi theo yêu cầu") });
  expect(refreshFidelity(unwrapped, ir(), []).filter((x) => x.feature === COMPONENT_FEATURE)).toHaveLength(1);
  expect(refreshFidelity(unwrapped, ir(tabs("config")), []).find((x) => x.feature === COMPONENT_FEATURE)!.status).toBe("supported");
});

test("withBehavior: a passed check lifts the component item, a failed one says why; notes are untouched", () => {
  const items = [...componentFidelity(ir(tabs("guessed")), []), { pageId: "p", feature: COMPONENT_NOTE, status: "partial" as const, nodeId: "r", note: "interval suy đoán" }];
  const ok = withBehavior(items, [{ pageId: "p", nodeId: "r", kind: "tabs", ok: true }]);
  expect(ok.find((x) => x.feature === COMPONENT_FEATURE)).toMatchObject({ status: "supported", note: expect.stringContaining("đã kiểm chứng") });
  expect(ok.find((x) => x.feature === COMPONENT_NOTE)!.status).toBe("partial");
  const bad = withBehavior(items, [{ pageId: "p", nodeId: "r", kind: "tabs", ok: false, reason: "panel 2 không hiện" }]);
  expect(bad.find((x) => x.feature === COMPONENT_FEATURE)).toMatchObject({ status: "partial", note: expect.stringContaining("panel 2 không hiện") });
});
```

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run tests/unit/fidelity-components.test.ts`
Expected: FAIL — `componentFidelity` không export.

- [ ] **Step 3: Implement**

```ts
export const COMPONENT_FEATURE = "component";
export const COMPONENT_NOTE = "component-note";
export type BehaviorResult = { pageId: string; nodeId: string; kind: InteractiveKind; ok: boolean; reason?: string };
const KIND_LABEL: Record<InteractiveKind, string> = { carousel: "Carousel", tabs: "Tabs", accordion: "Accordion", modal: "Modal", dropdown: "Dropdown", menu: "Menu", video: "Video" };
const CONFIDENCE_LABEL: Record<InteractiveSpec["confidence"], string> = {
  config: "đọc từ cấu hình thư viện", observed: "quan sát trên trang gốc", guessed: "suy từ cấu trúc — Clone lại để đọc cấu hình thật", manual: "gắn tay, chưa kiểm chứng",
};

// E2 §3: one item per component, re-derived from the document on every refresh. A component the user unwrapped keeps
// an unsupported item (from `before`) until its interactive comes back (Undo).
export function componentFidelity(ir: IRV2, before: FidelityItem[]): FidelityItem[] {
  const out: FidelityItem[] = [], live = new Set<string>(), nodes = new Map<string, IRNodeV2>();
  const notes = new Set((ir.fidelity ?? []).concat(before).filter((x) => x.feature === COMPONENT_NOTE && x.status !== "supported").map((x) => x.nodeId));
  const pageOf = new Map<string, string>();
  const visit = (pageId: string) => (node: IRNodeV2): void => {
    nodes.set(node.id, node); pageOf.set(node.id, pageId);
    const spec = node.interactive;
    if (spec) {
      live.add(node.id);
      const status = spec.confidence === "config" && !notes.has(node.id) ? "supported" : "partial";
      out.push({ pageId, feature: COMPONENT_FEATURE, status, nodeId: node.id, sourceRef: node.id, note: clip(`${KIND_LABEL[spec.kind]} · nguồn ${spec.source} · ${CONFIDENCE_LABEL[spec.confidence]}`) });
    }
    node.children.forEach(visit(pageId));
  };
  ir.pages.forEach((p) => visit(p.id)(p.shell));
  ir.sections.forEach((s) => visit(s.pageId)(s.root));
  for (const x of before) {
    if (x.feature !== COMPONENT_FEATURE || !x.nodeId || live.has(x.nodeId) || !nodes.has(x.nodeId)) continue;
    out.push({ pageId: x.pageId, feature: COMPONENT_FEATURE, status: "unsupported", nodeId: x.nodeId, sourceRef: x.sourceRef ?? x.nodeId, note: "Đã bỏ hành vi theo yêu cầu (Bỏ hành vi); giữ HTML tĩnh" });
  }
  return out;
}

// E2 §5 (R5): applied when the Preview reads a fresh qa.json; never stored.
export function withBehavior(items: FidelityItem[], results: BehaviorResult[]): FidelityItem[] {
  const byNode = new Map(results.map((r) => [`${r.pageId}|${r.nodeId}`, r]));
  return items.map((x) => {
    const r = x.feature === COMPONENT_FEATURE && x.status !== "unsupported" ? byNode.get(`${x.pageId}|${x.nodeId}`) : undefined;
    if (!r) return x;
    return r.ok ? { ...x, status: "supported", note: clip(`${x.note} · đã kiểm chứng hành vi trên bản clone`) } : { ...x, status: "partial", note: clip(`${x.note} · QA hành vi không đạt: ${r.reason ?? "không rõ"}`) };
  });
}
```

`indexIR`: thêm `members: Set<string>` (mọi id có trong `roleIndex(ir)` cộng gốc có `interactive`). Vòng interactions: trước nhánh `carousel || REVEAL`: `if ((it.kind === "carousel" || REVEAL.has(it.kind)) && anchor.nodeId && index.members.has(anchor.nodeId)) continue; // the component item covers it`. `analyze` giữ nguyên (chỉ bằng chứng capture). Hai điểm gọi:

```ts
export function buildFidelity(captures: PageCapture[], ir: IRV2): FidelityItem[] {
  return capFidelity([...analyze(captures, ir), ...componentFidelity(ir, [])]);
}
// refreshFidelity: `kept` also drops COMPONENT_FEATURE (re-derived), then
  for (const x of [...analyze(captures, after), ...componentFidelity(after, before), ...kept]) { /* same dedupe as today */ }
```

Dòng script: `"... không chạy trong clone; component có cấu trúc chạy bằng runtime của tool"`.

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run tests/unit/fidelity-components.test.ts tests/unit/fidelity.test.ts tests/unit/ir-store.test.ts tests/unit/preview-model.test.ts; npm run typecheck`
Expected: PASS (chưa có component thật, item cũ giữ nguyên).

- [ ] **Step 5: Commit**

```bash
git add -- src/core/fidelity.ts tests/unit/fidelity-components.test.ts
git commit -m "feat(e2): component Fidelity derived from the document, unwrap marker, behaviour QA upgrade" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Suy cấu trúc `guessed` + migration hành vi v1 (§9), bỏ `data-behavior`

**Files:**
- Create: `src/core/interactive-guess.ts`
- Modify: `src/core/ir-migrate.ts` (cả hai nhánh trả `upgradeDocument(...)`), `src/core/ir-store.ts:22-29,43-117` (hook `upgrade` khi parse `ir_json`), `src/core/jobs.ts:340-374` (`projectDocuments` truyền `upgrade: upgradeDocument`), `src/core/emit-html.ts:24-31,52,127-131,180` (xoá `BEHAVIOR_ATTR`, `kinds`, khối `data-behavior`), `src/core/runtime.js` (xoá IIFE legacy)
- Test: `tests/unit/interactive-guess.test.ts`; sửa `tests/unit/emit.test.ts:163-180`, `tests/unit/emit-v2.test.ts:42-58`, `tests/unit/fidelity.test.ts:35-55`, `tests/unit/ir-store.test.ts` (thêm 1 test)

**Interfaces:**
- Consumes: Task 1 `checkInteractives`, `parseSpec`, `INTERACTIVE_LIMITS`; Task 5 `COMPONENT_NOTE`; `capFidelity`; `IRV2.interactions` (`{ id, kind, trigger, status, pageId }`).
- Produces (dùng ở Task 8, 10, 13):

```ts
export type PageNodes = { pageId: string; byId: Map<string, IRNodeV2>; parent: Map<string, string>; tree: Map<string, string>; htmlId: Map<string, string>; order: string[] };
// notes: partial Fidelity notes (guessed/defaulted fields); info: supported notes (e.g. "Bỏ 4 slide clone do loop");
// hide: loop clones to mark hidden; snapshotActive: `active` came from an active class in the 1440 snapshot
export type Guess = { root: string; spec: InteractiveSpec; notes: string[]; info?: string[]; hide?: string[]; snapshotActive?: true };
export function pageNodes(ir: IRV2, pageId: string): PageNodes;
export function guessAt(p: PageNodes, nodeId: string, hint: "carousel" | "tab" | "accordion" | "modal" | "menu"): Guess | undefined;
export function guessAll(p: PageNodes): Guess[];                                   // tablist, details, aria-expanded/haspopup, dialog, video/iframe
export function measureCarousel(p: PageNodes, viewport: string, slides: string[]): { slidesPerView: Partial<Record<Bp, number>>; gap: Partial<Record<Bp, number>>; direction: "horizontal" | "vertical" } | undefined;
export function placeGuesses(ir: IRV2, pageId: string, guesses: Guess[], origin: string): IRV2; // mutates a clone it owns; skips taken roots/members; limit 50; notes -> Fidelity
export function migrateBehaviors(ir: IRV2): IRV2;                                  // same object when no node has `behavior`
export function upgradeDocument(ir: IRV2): IRV2;                                   // migrateBehaviors + checkInteractives
// StoreHooks (ir-store.ts) gets: upgrade?: (ir: IRV2) => IRV2
```

- [ ] **Step 1: Viết test đỏ**

`tests/unit/interactive-guess.test.ts`:

```ts
import { expect, test } from "vitest";
import { documentStore } from "@/core/ir-store";
import { guessAll, guessAt, measureCarousel, migrateBehaviors, pageNodes, upgradeDocument } from "@/core/interactive-guess";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const n = (id: string, tag: string, children: IRNodeV2[] = [], attrs: Record<string, string> = {}, extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const c of children) c.parentId = id;
  return node;
};
const page = (...roots: IRNodeV2[]): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "p", path: "/", title: "", meta: {}, sectionIds: roots.map((_, i) => `s${i}`), shell: n("html", "html", [n("body", "body", roots.map((_, i) => n(`ph${i}`, "#section", [], { "data-section": `s${i}` })))]) }],
  sections: roots.map((root, i) => ({ id: `s${i}`, pageId: "p", name: `s${i}`, role: "block", hash: `h${i}`, origin: "capture" as const, root })),
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
});
// site2 in IR form: header menu, two sibling dropdowns, tabs, modal (trigger + dialog in one section), details, scroll-snap carousel
const site2 = () => page(
  n("hdr", "header", [n("menu-btn", "button", [], { "aria-expanded": "false", "aria-controls": "main-nav" }), n("nav", "nav", [], { id: "main-nav" })]),
  n("dd", "section", [n("vis", "button", [], { "aria-expanded": "false" }), n("vism", "ul"), n("fade", "button", [], { "aria-expanded": "false" }), n("fadem", "ul")]),
  n("tabs", "section", [n("tl", "div", [n("t1", "button", [], { role: "tab", "aria-selected": "true", "aria-controls": "panel-1" }), n("t2", "button", [], { role: "tab", "aria-selected": "false", "aria-controls": "panel-2" })], { role: "tablist" }),
    n("pn1", "div", [], { role: "tabpanel", id: "panel-1" }), n("pn2", "div", [], { role: "tabpanel", id: "panel-2", hidden: "" })]),
  n("mod", "section", [n("open", "button", [], { "aria-haspopup": "dialog", "data-modal": "#dialog" }), n("dlg", "div", [n("x", "button", [], { "data-close": "" })], { id: "dialog", role: "dialog" })]),
  n("faq", "section", [n("det", "details", [n("sum", "summary"), n("ans", "p")])]),
  n("car", "section", [n("cv", "div", [n("c1", "div", [], {}, { box: { 1440: [0, 0, 300, 120] } }), n("c2", "div", [], {}, { box: { 1440: [300, 0, 300, 120] } })], {},
    { box: { 1440: [0, 0, 300, 120] }, styles: { base: { "scroll-snap-type": "x mandatory", "overflow-x": "auto" }, bp: {}, state: {}, pseudo: {} } }),
    n("cnext", "button", [], { "aria-label": "Next slide" })]),
  n("vid", "section", [n("v", "video", [], { autoplay: "", muted: "", loop: "" }), n("yt", "iframe", [], { src: "https://www.youtube.com/embed/abc123?autoplay=1" })]),
);

test("guessAll on site2: tabs, modal, details accordion, menu, video + embed; sibling dropdowns: first wins (R2)", () => {
  const p = pageNodes(site2(), "p");
  const by = (kind: string) => guessAll(p).filter((g) => g.spec.kind === kind);
  expect(by("tabs")[0]).toMatchObject({ root: "tabs", spec: { tabs: [{ trigger: "t1", panel: "pn1" }, { trigger: "t2", panel: "pn2" }], active: 0, source: "aria", confidence: "guessed" } });
  expect(by("modal")[0]).toMatchObject({ root: "dlg", spec: { triggers: ["open"], dialog: "dlg", closeButton: "x", closeOn: ["esc", "backdrop", "button"] } });
  expect(by("accordion")[0]).toMatchObject({ root: "faq", spec: { source: "details", items: [{ trigger: "sum", panel: "ans", open: false }] } });
  expect(by("menu")[0]).toMatchObject({ root: "hdr", spec: { trigger: "menu-btn", panel: "nav", openOn: "click" } });
  expect(by("video").map((g) => g.spec)).toEqual([
    expect.objectContaining({ node: "v", mode: "native", autoplay: true, muted: true, loop: true, controls: false }),
    expect.objectContaining({ node: "yt", mode: "embed", autoplay: true, muted: true }), // autoplay always muted (schema)
  ]);
  const doc = site2();
  expect(migrateBehaviors(doc)).toBe(doc); // nothing to migrate: the same object
});

test("guessAt carousel (scroll-snap): viewport = track, slides, next arrow, root = LCA; slidesPerView/gap measured from box", () => {
  const p = pageNodes(site2(), "p");
  const g = guessAt(p, "cv", "carousel")!;
  expect(g).toMatchObject({ root: "car", spec: { kind: "carousel", source: "scroll-snap", viewport: "cv", track: "cv", slides: ["c1", "c2"], arrows: { next: "cnext" }, slidesPerView: { "1440": 1 }, gap: { "1440": 0 }, autoplay: false } });
  expect(g.notes.join(" ")).toContain("giá trị mặc định");
  expect(measureCarousel(p, "cv", ["c1", "c2"])).toEqual({ slidesPerView: { "1440": 1 }, gap: { "1440": 0 }, direction: "horizontal" });
});

test("§9: behaviors become guessed interactives (defaults noted), unresolved stays out, idempotent, no behavior left", () => {
  const ir = site2();
  ir.interactions = [
    { id: "ix-car", kind: "carousel", trigger: "#x", status: "captured", pageId: "p" },
    { id: "ix-tab", kind: "tab", trigger: "#t1", status: "captured", pageId: "p" },
  ];
  const sec = (id: string) => ir.sections.find((s) => s.root.id === id)!.root;
  sec("car").children[0]!.behavior = "ix-car";
  sec("tabs").children[0]!.children[0]!.behavior = "ix-tab";
  sec("mod").children[0]!.behavior = "unresolved";
  const once = migrateBehaviors(ir);
  expect(JSON.stringify(once)).not.toContain('"behavior"');
  const find = (doc: IRV2, id: string): IRNodeV2 | undefined => { let hit: IRNodeV2 | undefined; const v = (x: IRNodeV2) => { if (x.id === id) hit = x; x.children.forEach(v); }; doc.sections.forEach((s) => v(s.root)); return hit; };
  expect(find(once, "car")!.interactive).toMatchObject({ kind: "carousel", confidence: "guessed" });
  expect(find(once, "tabs")!.interactive).toMatchObject({ kind: "tabs" });
  expect(find(once, "dlg")!.interactive).toBeUndefined(); // only behaviors migrate (§9); unresolved -> nothing
  expect(once.fidelity.some((x) => x.feature === "component-note" && x.note.includes("giá trị mặc định"))).toBe(true);
  expect(migrateBehaviors(once)).toBe(once);
  expect(upgradeDocument(once)).toBe(once);
});

test("the store upgrades an adopted document on read: no History row, same revision", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE document_state(project_id TEXT PRIMARY KEY, ir_json TEXT NOT NULL, revision INTEGER NOT NULL, cursor INTEGER NOT NULL, materialized_revision INTEGER NOT NULL); CREATE TABLE document_history(project_id TEXT NOT NULL, seq INTEGER NOT NULL, forward_json TEXT NOT NULL, inverse_json TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(project_id,seq));");
  const ir = site2();
  ir.interactions = [{ id: "ix-tab", kind: "tab", trigger: "#t1", status: "captured", pageId: "p" }];
  ir.sections.find((s) => s.root.id === "tabs")!.root.children[0]!.children[0]!.behavior = "ix-tab";
  db.prepare("INSERT INTO document_state VALUES('x', ?, 3, 0, 3)").run(JSON.stringify({ ...ir, revision: 3 })); // as change() stores it
  const store = documentStore(db, async () => {}, { loadInitial: async () => ir, upgrade: upgradeDocument });
  const doc = await store.loadDocument("x");
  expect(doc.revision).toBe(3);
  expect(JSON.stringify(doc)).not.toContain('"behavior"');
  expect((db.prepare("SELECT COUNT(*) c FROM document_history").get() as { c: number }).c).toBe(0);
});
```

Sửa test cũ (cùng task):
- `tests/unit/emit.test.ts:163-180` → tên `"menu interaction -> guessed dropdown component (data-c), failed -> nothing; data-behavior is gone"`: assert `html` chứa `data-c="menu"` hoặc `data-c="dropdown"` trên `nav` và `data-c-role="trigger"` trên `#menu`, `not.toContain("data-behavior")`.
- `tests/unit/emit-v2.test.ts:42-58`: `normalize` bỏ thêm `/ data-c(-cfg|-role)?="[^"]*"/g`, so sánh CSS sau khi bỏ dòng `HIDDEN_RULE`; dòng 53 → `expect(files["index.html"]).toMatch(/data-c="(menu|dropdown)"/)`.
- `tests/unit/fidelity.test.ts:35-42`: carousel `captured` trên `#car` giờ ra item `component` partial anchored `p1:0.1.0.0` (nút "next" không có aria-label/class nên không mở rộng gốc) và không còn item `carousel`; dòng 50: `tab` captured trên `#car` không có tablist → không thành component, không còn runtime nào chạy nó → `expect(find(items, "tab")[0]!.status).toBe("unsupported")` (trước E2 là partial nhờ `data-behavior="tabs"` chung).

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run tests/unit/interactive-guess.test.ts`
Expected: FAIL — module `@/core/interactive-guess` không tồn tại.

- [ ] **Step 3: Implement**

`src/core/interactive-guess.ts` (điểm neo; mỗi hàm `guess*` trả `undefined` khi không dựng được, không throw):

```ts
// E2 §3 step 3 + §9: structure-only inference over IR v2 page trees, and the one-time v1 behavior migration. Pure.
import { capFidelity, COMPONENT_NOTE } from "./fidelity";
import { checkInteractives, INTERACTIVE_LIMITS, parseSpec, rolesOf, type Bp, type CarouselSpec, type InteractiveSpec } from "./interactive";
import type { FidelityItem, IRNodeV2, IRV2 } from "./ir-v2";

const BPS = [1440, 768, 375] as const;
const classes = (n: IRNodeV2) => new Set((n.attrs.class ?? "").split(/\s+/).filter(Boolean));
const elementKids = (n: IRNodeV2) => n.children.filter((c) => c.tag !== "#text");
const CLONE = /(^|\s)(swiper-slide-duplicate|slick-cloned|splide__slide--clone)(\s|$)/;

export function pageNodes(ir: IRV2, pageId: string): PageNodes {
  const p: PageNodes = { pageId, byId: new Map(), parent: new Map(), tree: new Map(), htmlId: new Map(), order: [] };
  const trees: [string, IRNodeV2][] = [[`page:${pageId}`, ir.pages.find((x) => x.id === pageId)!.shell], ...ir.sections.filter((s) => s.pageId === pageId).map((s): [string, IRNodeV2] => [`section:${s.id}`, s.root])];
  for (const [tree, root] of trees) {
    const visit = (node: IRNodeV2): void => {
      p.byId.set(node.id, node); p.tree.set(node.id, tree); p.order.push(node.id);
      if (node.attrs.id && !p.htmlId.has(node.attrs.id)) p.htmlId.set(node.attrs.id, node.id);
      for (const c of node.children) { p.parent.set(c.id, node.id); visit(c); }
    };
    visit(root);
  }
  return p;
}
const chain = (p: PageNodes, id: string) => { const out = [id]; for (let c = p.parent.get(id); c; c = p.parent.get(c)) out.push(c); return out; };
// lowest common ancestor inside one section/shell tree; never html/body
function lca(p: PageNodes, ids: string[]): string | undefined {
  if (new Set(ids.map((id) => p.tree.get(id))).size !== 1) return undefined;
  const chains = ids.map((id) => chain(p, id));
  const hit = chains[0]!.find((a) => chains.every((c) => c.includes(a)));
  const tag = hit && p.byId.get(hit)!.tag;
  return tag === "html" || tag === "body" ? undefined : hit;
}
const target = (p: PageNodes, ref: string | undefined) => (ref ? p.htmlId.get(ref.replace(/^#/, "")) : undefined);
const nextElement = (p: PageNodes, id: string) => {
  const kids = p.byId.get(p.parent.get(id) ?? "")?.children ?? [];
  return kids.slice(kids.findIndex((c) => c.id === id) + 1).find((c) => c.tag !== "#text")?.id;
};

function guessTabs(p: PageNodes, tablist: IRNodeV2): Guess | undefined {
  const tabs: IRNodeV2[] = [];
  const visit = (x: IRNodeV2) => { if (x.attrs.role === "tab") tabs.push(x); else x.children.forEach(visit); };
  tablist.children.forEach(visit);
  const pairs = tabs.flatMap((t) => { const panel = target(p, t.attrs["aria-controls"]); return panel ? [{ trigger: t.id, panel }] : []; });
  if (!pairs.length || pairs.length !== tabs.length || pairs.length > INTERACTIVE_LIMITS.items) return undefined;
  const root = lca(p, [tablist.id, ...pairs.map((x) => x.panel)]);
  return root ? { root, spec: { kind: "tabs", source: "aria", confidence: "guessed", tabs: pairs, active: Math.max(0, tabs.findIndex((t) => t.attrs["aria-selected"] === "true")) }, notes: [] } : undefined;
}
const DEFAULTED = (fields: string[]) => `${fields.join(", ")}: giá trị mặc định`;
function firstBelow(from: IRNodeV2, hit: (x: IRNodeV2) => boolean): IRNodeV2 | undefined {
  let found: IRNodeV2 | undefined;
  const visit = (x: IRNodeV2) => { if (found) return; if (hit(x)) found = x; else x.children.forEach(visit); };
  from.children.forEach(visit);
  return found;
}

function guessModal(p: PageNodes, trigger: IRNodeV2): Guess | undefined {
  const ref = (t: IRNodeV2) => target(p, t.attrs["aria-controls"] ?? t.attrs["data-modal"] ?? t.attrs["data-target"]);
  const dialog = p.byId.get(ref(trigger) ?? "");
  if (!dialog) return undefined;
  const triggers = p.order.filter((id) => id !== dialog.id && ref(p.byId.get(id)!) === dialog.id).slice(0, INTERACTIVE_LIMITS.items);
  const close = firstBelow(dialog, (x) => x.attrs["data-close"] !== undefined || /close|đóng/i.test(`${x.attrs["aria-label"] ?? ""} ${x.attrs.class ?? ""}`))?.id;
  return { root: dialog.id, notes: [DEFAULTED(["closeOn"])], spec: { kind: "modal", source: "aria", confidence: "guessed", triggers, dialog: dialog.id,
    closeOn: ["esc", "backdrop", ...(close ? (["button"] as const) : [])], ...(close && { closeButton: close }) } };
}

function guessToggle(p: PageNodes, t: IRNodeV2, hint: "menu" | "accordion"): Guess | undefined {
  const panel = p.byId.get(target(p, t.attrs["aria-controls"]) ?? nextElement(p, t.id) ?? "");
  const root = panel && lca(p, [t.id, panel.id]);
  if (!panel || !root) return undefined;
  const list = ["nav", "ul", "ol"].includes(panel.tag) || panel.attrs.role === "menu";
  const menuish = list || t.attrs["aria-haspopup"] !== undefined || chain(p, t.id).some((a) => ["nav", "header"].includes(p.byId.get(a)!.tag));
  if (hint === "accordion" && !menuish) return { root, notes: [DEFAULTED(["multiple"])], spec: { kind: "accordion", source: "aria", confidence: "guessed", multiple: true, items: [{ trigger: t.id, panel: panel.id, open: t.attrs["aria-expanded"] === "true" }] } };
  return { root, notes: [DEFAULTED(["openOn"])], spec: { kind: list ? "menu" : "dropdown", source: "aria", confidence: "guessed", trigger: t.id, panel: panel.id, openOn: "click" } };
}

function guessDetails(p: PageNodes, parent: IRNodeV2): Guess | undefined {
  const dets = elementKids(parent).filter((c) => c.tag === "details");
  const items = dets.flatMap((d) => { const [s, panel] = elementKids(d); return s?.tag === "summary" && panel ? [{ trigger: s.id, panel: panel.id, open: d.attrs.open !== undefined }] : []; });
  if (!items.length || items.length > INTERACTIVE_LIMITS.items) return undefined;
  const root = ["html", "body"].includes(parent.tag) ? (dets.length === 1 ? dets[0]!.id : undefined) : parent.id;
  return root ? { root, notes: [], spec: { kind: "accordion", source: "details", confidence: "guessed", multiple: true, items } } : undefined; // native <details> are independent
}

function guessVideo(n: IRNodeV2): Guess | undefined {
  const has = (k: string) => n.attrs[k] !== undefined;
  if (n.tag === "video") return { root: n.id, notes: [], spec: { kind: "video", source: "native", confidence: "guessed", node: n.id, mode: "native",
    autoplay: has("autoplay"), muted: has("muted") || has("autoplay"), loop: has("loop"), controls: has("controls"), ...(n.attrs.poster && { poster: n.attrs.poster }) } };
  if (n.tag !== "iframe" || !URL.canParse(n.attrs.src ?? "")) return undefined;
  const u = new URL(n.attrs.src!), on = (k: string) => u.searchParams.get(k) === "1";
  if (!/^((www\.|m\.)?youtube(-nocookie)?\.com|player\.vimeo\.com)$/.test(u.hostname)) return undefined; // §11 allowlist
  const autoplay = on("autoplay");
  return { root: n.id, notes: ["Video nhúng: chỉ giữ iframe trên host được phép, phát do trang nhúng"], spec: { kind: "video", source: "native", confidence: "guessed", node: n.id, mode: "embed",
    autoplay, muted: autoplay || on("mute") || on("muted"), loop: on("loop"), controls: u.searchParams.get("controls") !== "0" } };
}

// [root class, source, track class, pagination class, prev class, next class]
const LIBS = [
  ["swiper", "swiper", "swiper-wrapper", "swiper-pagination", "swiper-button-prev", "swiper-button-next"],
  ["slick-slider", "slick", "slick-track", "slick-dots", "slick-prev", "slick-next"],
  ["splide", "splide", "splide__list", "splide__pagination", "splide__arrow--prev", "splide__arrow--next"],
] as const;
const ACTIVE = /(^|\s)(swiper-slide-active|slick-current|is-active)(\s|$)/;
const slideKey = (n: IRNodeV2): string => JSON.stringify([n.tag, n.text ?? null, n.attrs.src ?? null, n.attrs.href ?? null, n.children.map(slideKey)]);
// [last k | real … | first k]: the loop clones of a library-less track (same content at both ends)
function endClones(kids: IRNodeV2[]): string[] {
  const key = kids.map(slideKey), n = kids.length;
  for (let k = Math.floor(n / 3); k >= 1; k--) {
    if (key.slice(0, k).every((x, i) => x === key[n - 2 * k + i]) && key.slice(n - k).every((x, i) => x === key[k + i])) return [...kids.slice(0, k), ...kids.slice(n - k)].map((c) => c.id);
  }
  return [];
}
function guessCarousel(p: PageNodes, node: IRNodeV2): Guess | undefined {
  const cls = classes(node), lib = LIBS.find(([c]) => cls.has(c) || (c === "swiper" && cls.has("swiper-container")));
  const byClass = (c: string) => firstBelow(node, (x) => classes(x).has(c));
  const track = lib ? byClass(lib[2]) : node;
  if (!track) return undefined;
  const viewport = lib?.[1] === "slick" ? byClass("slick-list") ?? node : lib?.[1] === "splide" ? byClass("splide__track") ?? node : node;
  const kids = elementKids(track), marked = kids.filter((c) => CLONE.test(c.attrs.class ?? ""));
  const hide = marked.length ? marked.map((c) => c.id) : endClones(kids);
  const real = kids.filter((c) => !hide.includes(c.id));
  if (!real.length || real.length > INTERACTIVE_LIMITS.items) return undefined;
  // arrows: library classes, else /next/ /prev|previous|back/ in aria-label or class, within 3 ancestor levels (like the scan)
  const arrow = (re: RegExp, c?: string) => {
    for (let s: string | undefined = node.id, d = 0; s && d < 3; s = p.parent.get(s), d++) {
      const hit = firstBelow(p.byId.get(s)!, (x) => (c !== undefined && classes(x).has(c)) || ((["button", "a"].includes(x.tag) || x.attrs.role === "button") && re.test(`${x.attrs["aria-label"] ?? ""} ${x.attrs.class ?? ""}`)));
      if (hit) return hit.id;
    }
    return undefined;
  };
  const prev = arrow(/prev|previous|back/i, lib?.[4]), next = arrow(/next/i, lib?.[5]);
  const dots = lib ? byClass(lib[3]) : undefined;
  const measured = measureCarousel(p, viewport.id, real.map((s) => s.id));
  const at = real.findIndex((s) => ACTIVE.test(s.attrs.class ?? "") || s.attrs["aria-current"] === "true");
  const root = lca(p, [viewport.id, track.id, ...[prev, next, dots?.id].filter((x): x is string => !!x)]) ?? node.id;
  const spec: CarouselSpec = {
    kind: "carousel", source: lib ? lib[1] : node.styles.base["scroll-snap-type"] && node.styles.base["scroll-snap-type"] !== "none" ? "scroll-snap" : "generic", confidence: "guessed",
    viewport: viewport.id, track: track.id, slides: real.map((s) => s.id), active: Math.max(0, at),
    autoplay: false, interval: 5000, loop: hide.length > 0, direction: measured?.direction ?? "horizontal", transition: "slide", speed: 300,
    slidesPerView: measured?.slidesPerView ?? { "1440": 1 }, gap: measured?.gap ?? { "1440": 0 },
    ...((prev || next) && { arrows: { ...(prev && { prev }), ...(next && { next }) } }),
    ...(dots && { pagination: { container: dots.id, kind: classes(dots).has("swiper-pagination-fraction") ? "fraction" : "bullets" } }),
  };
  const defaulted = ["autoplay", "interval", "speed", ...(hide.length ? [] : ["loop"]), ...(measured ? [] : ["slidesPerView", "gap"])];
  return { root, spec, notes: [DEFAULTED(defaulted)], ...(hide.length && { hide, info: [`Bỏ ${hide.length} slide clone do loop`] }), ...(at >= 0 && { snapshotActive: true as const }) };
}

export function guessAt(p: PageNodes, nodeId: string, hint: "carousel" | "tab" | "accordion" | "modal" | "menu"): Guess | undefined {
  const node = p.byId.get(nodeId);
  if (!node) return undefined;
  if (hint === "carousel") return guessCarousel(p, node);
  if (hint === "modal") return guessModal(p, node);
  if (hint === "tab") {
    const list = chain(p, nodeId).map((id) => p.byId.get(id)!).find((x) => x.attrs.role === "tablist");
    return list && guessTabs(p, list);
  }
  const details = node.tag === "summary" ? p.byId.get(p.parent.get(nodeId) ?? "") : undefined;
  if (details?.tag === "details") return guessDetails(p, p.byId.get(p.parent.get(details.id) ?? "")!);
  return guessToggle(p, node, hint === "accordion" ? "accordion" : "menu");
}

// §3 step 3 over the whole page (structure only), in document order.
export function guessAll(p: PageNodes): Guess[] {
  const out: Guess[] = [], detailParents = new Set<string>();
  for (const id of p.order) {
    const n = p.byId.get(id)!, parent = p.parent.get(id) ?? "";
    let g: Guess | undefined;
    if (n.attrs.role === "tablist") g = guessTabs(p, n);
    else if (n.tag === "details") { if (!detailParents.has(parent)) { detailParents.add(parent); g = guessDetails(p, p.byId.get(parent)!); } }
    else if (n.attrs["aria-haspopup"] === "dialog" || n.attrs["data-modal"] !== undefined) g = guessModal(p, n);
    else if (n.attrs.role !== "tab" && (n.attrs["aria-haspopup"] !== undefined || n.attrs["aria-expanded"] !== undefined))
      g = guessToggle(p, n, n.attrs["aria-controls"] !== undefined && n.attrs["aria-haspopup"] === undefined ? "accordion" : "menu");
    else g = guessVideo(n);
    if (g) out.push(g);
  }
  return out;
}

export function measureCarousel(p: PageNodes, viewport: string, slides: string[]) {
  const vp = p.byId.get(viewport), real = slides.map((s) => p.byId.get(s)!).filter(Boolean);
  if (!vp || real.length === 0) return undefined;
  const spv: Partial<Record<Bp, number>> = {}, gap: Partial<Record<Bp, number>> = {};
  const a = real[0]!.box?.[1440], b = real[1]?.box?.[1440];
  const direction = a && b && Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]) ? "vertical" : "horizontal";
  const along = direction === "vertical" ? [1, 3] as const : [0, 2] as const;
  for (const bp of BPS) {
    const box = vp.box?.[bp], sizes = real.map((s) => s.box?.[bp]).filter((x): x is [number, number, number, number] => !!x);
    if (!box || !sizes.length) continue;
    const size = [...sizes.map((s) => s[along[1]])].sort((x, y) => x - y)[Math.floor(sizes.length / 2)]!;
    const gaps = sizes.slice(1).map((s, k) => s[along[0]] - (sizes[k]![along[0]] + sizes[k]![along[1]])).filter((g) => g >= 0);
    const g = Math.min(200, Math.round(gaps.length ? [...gaps].sort((x, y) => x - y)[Math.floor(gaps.length / 2)]! : 0));
    if (size <= 0) continue;
    spv[String(bp) as Bp] = Math.min(10, Math.max(1, Math.round(((box[along[1]] + g) / (size + g)) * 100) / 100));
    gap[String(bp) as Bp] = g;
  }
  return Object.keys(spv).length ? { slidesPerView: spv, gap, direction } as const : undefined;
}
```

`placeGuesses(ir, pageId, guesses, origin)`: một `structuredClone(ir)` duy nhất do caller sở hữu; với mỗi guess (theo thứ tự trang): bỏ nếu root đã có `interactive` hoặc một role trùng thành viên đã đặt (Fidelity `component-note` unsupported "trùng node gốc với component khác" — R2), bỏ nếu đã đủ 50 trên trang ("vượt giới hạn 50 component/trang"), `parseSpec` (lỗi → note unsupported "không dựng được spec"), đặt `node.interactive = spec`, với node instance thêm `"interactive"` vào `component.overrides` (R12), đánh `hidden = true` cho `hide`, thêm một item `component-note` **partial** `${origin}: ${notes.join("; ")}` khi có `notes` và một item `component-note` **supported** cho mỗi dòng `info` (cả hai `nodeId = sourceRef = root`, để `componentFidelity` biết config nào còn partial). `migrateBehaviors`: trả nguyên `ir` khi không node nào có `behavior`; ngược lại clone, xoá mọi `behavior` (cả trong `ir.components`), với behavior là id interaction `captured` kind `carousel|tab|accordion|modal|menu` gọi `guessAt` rồi `placeGuesses(..., "Chuyển từ hành vi cũ (v1)")`; `"unresolved"`/`sticky`/`hover` không chuyển. `upgradeDocument = (ir) => { const out = migrateBehaviors(ir); checkInteractives(out); return out; }`.

`ir-migrate.ts`: nhánh v2 `return upgradeDocument(input as IRV2);` (thay `checkInteractives` của Task 1); nhánh v1 `return upgradeDocument(ir);`.

`ir-store.ts`: `StoreHooks` thêm `upgrade?: (ir: IRV2) => IRV2; // pure, idempotent (E2 §9): applied to every snapshot read, persisted by the next step`; thêm `const parse = (json: string): IRV2 => { const ir = JSON.parse(json) as IRV2; return hooks.upgrade ? hooks.upgrade(ir) : ir; };` và thay mọi `JSON.parse(s.ir_json) as IRV2` / `JSON.parse(found.ir_json) as IRV2` / `JSON.parse((stateOf(id) ?? ...).ir_json) as IRV2` bằng `parse(...)`. `jobs.ts` `projectDocuments`: thêm `upgrade: upgradeDocument,` vào hooks.

`emit-html.ts`: xoá `BEHAVIOR_ATTR`, `Ctx.kinds`, dòng `kinds:` trong `makeCtx`, khối `if (node.behavior) {...}` trong `renderAttrs`, import `Interaction` nếu thừa. `runtime.js`: xoá IIFE legacy.

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run tests/unit/interactive-guess.test.ts tests/unit/emit.test.ts tests/unit/emit-v2.test.ts tests/unit/fidelity.test.ts tests/unit/ir-store.test.ts tests/unit/ir-migrate.test.ts tests/unit/ir.test.ts tests/unit/grapes-adapter.test.ts; npx vitest run -c vitest.e2e.config.ts tests/e2e/emit-render.test.ts; npm run typecheck`
Expected: PASS (menu e2e của emit-render giờ chạy bằng component `menu`/`dropdown`).

- [ ] **Step 5: Commit**

```bash
git add -- src/core/interactive-guess.ts src/core/ir-migrate.ts src/core/ir-store.ts src/core/jobs.ts src/core/emit-html.ts src/core/runtime.js tests/unit/interactive-guess.test.ts tests/unit/emit.test.ts tests/unit/emit-v2.test.ts tests/unit/fidelity.test.ts tests/unit/ir-store.test.ts
git commit -m "feat(e2): guessed structure inference and v1 behavior migration on load; data-behavior and the legacy runtime are gone" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Capture — đọc config, quan sát, hover; fixture site4

**Files:**
- Create: `src/core/interactive-eval.ts`, `src/core/interactive-scan.ts`, `tests/fixtures/site4/index.html`, `tests/fixtures/site4/swiper-mini.js`, `tests/fixtures/site4/slick-mini.js`, `tests/fixtures/site4/poster.png` (chép `tests/fixtures/assets-download/a.png`)
- Modify: `src/core/capture.ts:204-217` (`PageCapture.interactives?`), `:291-296` (gọi scan ngay sau `captureResponsive`, viewport đang 1440)
- Test: `tests/unit/interactive-scan.test.ts`, `tests/e2e/interactive-scan.test.ts`

**Interfaces:**
- Consumes: `withPage`, `BrowserHandle`, `capturePage`.
- Produces:

```ts
// interactive-eval.ts (self-contained page functions)
export type CarouselRead = { perBp: Partial<Record<"1440" | "768" | "375", { spv?: number; gap?: number }>>; loop?: boolean; autoplay?: boolean; interval?: number; effect?: string; speed?: number; direction?: "horizontal" | "vertical"; active?: number };
export type CarouselHit = { selector: string; source: "swiper" | "slick" | "splide" | "scroll-snap" };
export function listCarouselsInPage(arg: { max: number }): CarouselHit[];                        // structure only, no instance read
export function readCarouselConfigInPage(hits: CarouselHit[]): (CarouselRead | null)[];          // the one config evaluate (30 s)
export function observeCarouselsInPage(arg: { selectors: string[]; durationMs: number; stepMs: number }): Promise<{ selector: string; changes: number[] }[]>;
export function hoverCandidatesInPage(arg: { max: number }): { trigger: string; panel: string }[];
export function visibleInPage(selector: string): boolean;
// interactive-scan.ts
export type CapturedInteractive =
  | { kind: "carousel"; selector: string; source: CarouselHit["source"]; confidence: "config" | "observed" | "guessed"; read?: CarouselRead; autoplay?: boolean; interval?: number }
  | { kind: "dropdown"; selector: string; panel: string; openOn: "hover" };
export const INTERACTIVE_SCAN_LIMITS: { max: number; configMs: number; observeMs: number; pageMs: number; hoverMs: number; stepMs: number }; // 50, 30_000, 6_000, 30_000, 2_000, 100
export function intervalOf(changes: number[]): number | undefined;   // median gap, clamped 1000..60000, rounded to 100 ms
export async function scanInteractives(page: Page, opts?: { limits?: Partial<typeof INTERACTIVE_SCAN_LIMITS> }): Promise<CapturedInteractive[]>; // never throws
// PageCapture.interactives?: CapturedInteractive[]  (absent in captures written before E2)
```

- [ ] **Step 1: Viết fixture site4 + test đỏ**

`tests/fixtures/site4/swiper-mini.js` (mô phỏng bề mặt Swiper mà E2 đọc — R10):

```js
// Fixture stand-in for Swiper (E2 R10): the DOM classes, el.swiper.params, loop duplicates per breakpoint (count =
// slidesPerView, like Swiper < 9), autoplay. `expose: false` keeps el.swiper undefined (bundled builds).
window.MiniSwiper = function (el, params, expose) {
  var wrapper = el.querySelector(".swiper-wrapper"), real = Array.prototype.slice.call(wrapper.children), i = 0;
  var pick = function () { var p = { slidesPerView: params.slidesPerView, spaceBetween: params.spaceBetween }; Object.keys(params.breakpoints || {}).map(Number).sort(function (a, b) { return a - b; }).forEach(function (w) { if (innerWidth >= w) Object.assign(p, params.breakpoints[w]); }); return p; };
  function render() {
    var p = pick(), per = p.slidesPerView, gap = p.spaceBetween, w = (el.clientWidth - gap * (per - 1)) / per;
    wrapper.querySelectorAll(".swiper-slide-duplicate").forEach(function (d) { d.remove(); });
    if (params.loop) for (var k = 0; k < per; k++) {
      var head = real[real.length - 1 - k].cloneNode(true), tail = real[k].cloneNode(true);
      head.classList.add("swiper-slide-duplicate"); tail.classList.add("swiper-slide-duplicate");
      wrapper.insertBefore(head, wrapper.firstChild); wrapper.appendChild(tail);
    }
    Array.prototype.forEach.call(wrapper.children, function (s) { s.style.width = w + "px"; s.style.marginRight = gap + "px"; });
    var lead = params.loop ? per : 0;
    wrapper.style.transform = "translate3d(" + -(lead + i) * (w + gap) + "px, 0px, 0px)";
    real.forEach(function (s, k) { s.classList.toggle("swiper-slide-active", k === i); });
    el.querySelectorAll(".swiper-pagination-bullet").forEach(function (b, k) { b.classList.toggle("swiper-pagination-bullet-active", k === i); });
  }
  real.forEach(function (s, k) { s.setAttribute("data-swiper-slide-index", String(k)); });
  var next = el.querySelector(".swiper-button-next"), prev = el.querySelector(".swiper-button-prev");
  if (next) next.addEventListener("click", function () { i = (i + 1) % real.length; render(); });
  if (prev) prev.addEventListener("click", function () { i = (i - 1 + real.length) % real.length; render(); });
  if (params.autoplay) setInterval(function () { i = (i + 1) % real.length; render(); }, params.autoplay.delay);
  addEventListener("resize", render);
  render();
  if (expose !== false) el.swiper = { params: params, get realIndex() { return i; } };
};
```

`tests/fixtures/site4/slick-mini.js`:

```js
// Fixture stand-in for jQuery + Slick (E2 R10): $(el).slick('getSlick').options and the slick DOM classes.
window.jQuery = function (el) { return { slick: function (cmd) { return cmd === "getSlick" && el.__slick ? { options: el.__slick } : undefined; } }; };
window.miniSlick = function (el, options) { el.__slick = options; el.classList.add("slick-slider", "slick-initialized"); };
```

`tests/fixtures/site4/index.html` (các vùng bắt buộc; CSS tối thiểu, mỗi vùng một `<section>`):

```html
<!DOCTYPE html>
<html lang="vi"><head><meta charset="utf-8"><title>Site Four</title><link rel="icon" href="data:,">
<style>
  body { margin: 0; font-family: sans-serif; } section { padding: 16px; }
  .swiper { width: 900px; overflow: hidden; } .swiper-wrapper { display: flex; } .swiper-slide { flex-shrink: 0; height: 120px; background: rgb(220, 220, 255); }
  .swiper-pagination-bullet { display: inline-block; width: 8px; height: 8px; background: #999; } .swiper-pagination-bullet-active { background: #000; }
  .slick-list { overflow: hidden; width: 600px; } .slick-track { display: flex; } .slick-slide { width: 300px; height: 80px; flex-shrink: 0; }
  .snap { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; width: 300px; } .snap > div { flex: 0 0 300px; height: 80px; scroll-snap-align: start; }
  [role=tabpanel][hidden] { display: none; } .sub { display: none; } .has-sub:hover .sub { display: block; }
  #dlg[hidden] { display: none; } #dlg { position: fixed; inset: 20%; background: #fff; border: 1px solid #000; }
</style></head>
<body>
<header id="top"><button id="open-dlg" aria-haspopup="dialog" aria-controls="dlg">Mở hộp thoại</button>
  <nav><ul><li class="has-sub"><a href="#x" aria-haspopup="true">Sản phẩm</a><ul class="sub"><li>A</li><li>B</li></ul></li></ul></nav></header>
<section id="sw"><div class="swiper" id="swiper-a"><div class="swiper-wrapper">
  <div class="swiper-slide">S1</div><div class="swiper-slide">S2</div><div class="swiper-slide">S3</div><div class="swiper-slide">S4</div></div>
  <button class="swiper-button-prev">‹</button><button class="swiper-button-next">›</button>
  <div class="swiper-pagination"><span class="swiper-pagination-bullet"></span><span class="swiper-pagination-bullet"></span><span class="swiper-pagination-bullet"></span><span class="swiper-pagination-bullet"></span></div></div></section>
<section id="sw2"><div class="swiper" id="swiper-hidden"><div class="swiper-wrapper"><div class="swiper-slide">H1</div><div class="swiper-slide">H2</div></div></div></section>
<section id="sl"><div id="slick-a"><div class="slick-list"><div class="slick-track">
  <div class="slick-slide slick-cloned" data-slick-index="-1">K3</div><div class="slick-slide slick-current" data-slick-index="0">K1</div>
  <div class="slick-slide" data-slick-index="1">K2</div><div class="slick-slide" data-slick-index="2">K3</div>
  <div class="slick-slide slick-cloned" data-slick-index="3">K1</div></div></div>
  <button class="slick-prev">Prev</button><button class="slick-next">Next</button></div></section>
<section id="sn"><div class="snap" id="snap"><div>N1</div><div>N2</div><div>N3</div></div><button aria-label="Next slide">›</button></section>
<section id="tb"><div role="tablist"><button role="tab" aria-selected="true" aria-controls="tp1">Một</button><button role="tab" aria-selected="false" aria-controls="tp2">Hai</button></div>
  <div role="tabpanel" id="tp1">Nội dung một</div><div role="tabpanel" id="tp2" hidden>Nội dung hai</div></section>
<section id="ac"><div class="faq"><details><summary>Hỏi 1</summary><p>Đáp 1</p></details><details><summary>Hỏi 2</summary><p>Đáp 2</p></details></div>
  <div class="more"><button aria-expanded="false" aria-controls="ap">Thêm</button><div id="ap" hidden>Nội dung thêm</div></div></section>
<section id="vd"><video poster="poster.png" muted loop controls></video><iframe title="Video" src="https://www.youtube.com/embed/abc123" width="320" height="180"></iframe></section>
<footer id="ft"><div id="dlg" role="dialog" hidden><p>Hộp thoại</p><button data-close aria-label="Đóng">×</button></div></footer>
<script src="swiper-mini.js"></script><script src="slick-mini.js"></script>
<script>
  MiniSwiper(document.getElementById("swiper-a"), { slidesPerView: 1, spaceBetween: 10, loop: true, speed: 400, effect: "slide", direction: "horizontal",
    autoplay: { delay: 3000 }, breakpoints: { 768: { slidesPerView: 2, spaceBetween: 20 }, 1440: { slidesPerView: 3, spaceBetween: 30 } } });
  MiniSwiper(document.getElementById("swiper-hidden"), { slidesPerView: 1, spaceBetween: 0, loop: false, autoplay: { delay: 1500 } }, false);
  miniSlick(document.getElementById("slick-a"), { slidesToShow: 2, autoplay: false, infinite: true, speed: 300, fade: false, vertical: false, responsive: [{ breakpoint: 768, settings: { slidesToShow: 1 } }] });
  const dlg = document.getElementById("dlg");
  document.getElementById("open-dlg").addEventListener("click", () => { dlg.hidden = false; });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") dlg.hidden = true; });
</script></body></html>
```

`tests/unit/interactive-scan.test.ts`:

```ts
import { expect, test } from "vitest";
import { intervalOf } from "@/core/interactive-scan";

test("intervalOf: median gap between observed changes, clamped to the schema range, 100 ms steps", () => {
  expect(intervalOf([])).toBeUndefined();
  expect(intervalOf([1490])).toBe(1500);
  expect(intervalOf([1500, 3010, 4490])).toBe(1500);
  expect(intervalOf([200, 400, 600])).toBe(1000);
});
```

`tests/e2e/interactive-scan.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { scanInteractives, type CapturedInteractive } from "@/core/interactive-scan";
import { serveDir } from "@/core/serve";

let handle: BrowserHandle;
let site: { url: string; close(): Promise<void> };
beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  await handle.context.route("https://www.youtube.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<html></html>" })); // local fake embed, no network
  site = await serveDir(fileURLToPath(new URL("../fixtures/site4", import.meta.url)));
});
afterAll(async () => { await handle.close(); await site.close(); });

const scan = (limits?: Parameters<typeof scanInteractives>[1]) => withPage(handle, async (page) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${site.url}/index.html`, { waitUntil: "networkidle" });
  return scanInteractives(page, limits);
});
const carousel = (all: CapturedInteractive[], id: string) => all.find((x) => x.kind === "carousel" && x.selector.startsWith(`#${id}`));

test("config: Swiper params per breakpoint, Slick options (max-width responsive)", { timeout: 60_000 }, async () => {
  const all = await scan();
  expect(carousel(all, "swiper-a")).toMatchObject({ source: "swiper", confidence: "config", read: {
    loop: true, autoplay: true, interval: 3000, speed: 400, effect: "slide", direction: "horizontal",
    perBp: { "1440": { spv: 3, gap: 30 }, "768": { spv: 2, gap: 20 }, "375": { spv: 1, gap: 10 } } } });
  expect(carousel(all, "slick-a")).toMatchObject({ source: "slick", confidence: "config", read: { loop: true, autoplay: false, perBp: { "1440": { spv: 2 }, "768": { spv: 1 }, "375": { spv: 1 } } } });
  expect(all).toContainEqual(expect.objectContaining({ kind: "dropdown", openOn: "hover" }));
});

test("Review Focus 2 — el.swiper not exposed: observed autoplay + interval, never config; scroll-snap observed without autoplay", { timeout: 60_000 }, async () => {
  const all = await scan();
  const hidden = carousel(all, "swiper-hidden")!;
  expect(hidden).toMatchObject({ source: "swiper", confidence: "observed", autoplay: true });
  expect((hidden as { interval: number }).interval).toBeGreaterThanOrEqual(1200);
  expect((hidden as { interval: number }).interval).toBeLessThanOrEqual(1800);
  expect(carousel(all, "snap")).toMatchObject({ source: "scroll-snap", confidence: "observed", autoplay: false });
});

test("budgets: a config read that times out falls back to observed; no page budget left -> guessed; never throws", { timeout: 60_000 }, async () => {
  expect(carousel(await scan({ limits: { configMs: 1 } }), "swiper-a")?.confidence).toBe("observed");
  const none = await scan({ limits: { configMs: 1, pageMs: 0 } });
  expect(carousel(none, "swiper-hidden")?.confidence).toBe("guessed");
});
```

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run tests/unit/interactive-scan.test.ts; npx vitest run -c vitest.e2e.config.ts tests/e2e/interactive-scan.test.ts`
Expected: FAIL — module `@/core/interactive-scan` không tồn tại.

- [ ] **Step 3: Implement**

`interactive-eval.ts` (mỗi hàm tự chứa: `page.evaluate` chỉ gửi mã nguồn của chính hàm; `selectorFor` chép nguyên thuật toán của `interactions-eval.ts:15-28` để selector khớp `findTrigger`; chỉ đọc số/boolean/enum, không đọc hàm hay chuỗi tự do):

```ts
export function listCarouselsInPage(arg: { max: number }): CarouselHit[] {
  const isUniqueId = (id: string) => document.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
  const selectorFor = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && isUniqueId(cur.id)) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
      let n = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.localName === cur.localName) n++;
      parts.unshift(`${cur.localName}:nth-of-type(${n})`);
    }
    return parts.join(" > ");
  };
  const out: CarouselHit[] = [], seen = new Set<Element>();
  const add = (el: Element, source: CarouselHit["source"]) => { if (!seen.has(el) && out.length < arg.max) { seen.add(el); out.push({ selector: selectorFor(el), source }); } };
  document.querySelectorAll(".swiper, .swiper-container").forEach((el) => add(el, "swiper"));
  document.querySelectorAll(".slick-slider, [data-slick]").forEach((el) => add(el, "slick"));
  document.querySelectorAll(".splide").forEach((el) => add(el, "splide"));
  for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 20_000)) {
    const cs = getComputedStyle(el);
    if (cs.scrollSnapType !== "none" && /auto|scroll/.test(cs.overflowX + cs.overflowY) && el.getBoundingClientRect().width > 0) add(el, "scroll-snap");
  }
  return out;
}

export function readCarouselConfigInPage(hits: CarouselHit[]): (CarouselRead | null)[] {
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const px = (v: unknown) => num(v) ?? (typeof v === "string" && /^\d+(\.\d+)?(px)?$/.test(v.trim()) ? parseFloat(v) : undefined);
  const EFFECTS = ["slide", "fade", "cube", "coverflow", "flip", "cards", "creative"];
  const WIDTHS = [["1440", 1440], ["768", 768], ["375", 375]] as const;
  // min-width breakpoints (Swiper): every key <= width applies in order; max-width (Slick, Splide): the smallest key >= width wins
  const perBp = (base: { spv?: number; gap?: number }, table: Record<string, { spv?: number; gap?: number }>, max: boolean) =>
    Object.fromEntries(WIDTHS.map(([bp, w]) => {
      const keys = Object.keys(table).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
      const hit = max ? keys.filter((k) => k >= w).slice(0, 1) : keys.filter((k) => k <= w);
      return [bp, Object.assign({}, base, ...hit.map((k) => table[String(k)]))];
    }));
  return hits.map(({ selector, source }) => {
    const el = document.querySelector(selector) as any;
    if (!el) return null;
    if (source === "swiper") {
      const p = el.swiper?.params;
      if (!p) return null; // bundled build without el.swiper: observed instead (Review Focus 2)
      const table = Object.fromEntries(Object.entries(p.breakpoints ?? {}).map(([k, v]: [string, any]) => [k, { spv: num(v?.slidesPerView), gap: px(v?.spaceBetween) }]));
      return { perBp: perBp({ spv: num(p.slidesPerView), gap: px(p.spaceBetween) }, table, false), loop: !!p.loop, autoplay: !!(p.autoplay && (p.autoplay.enabled ?? true)),
        interval: num(p.autoplay?.delay), effect: EFFECTS.includes(p.effect) ? p.effect : undefined, speed: num(p.speed),
        direction: p.direction === "vertical" ? "vertical" : "horizontal", active: num(el.swiper.realIndex) };
    }
    if (source === "slick") {
      let o: any = (window as any).jQuery?.(el)?.slick?.("getSlick")?.options;
      if (!o) try { o = JSON.parse(el.getAttribute("data-slick") ?? "null"); } catch { o = null; }
      if (!o) return null;
      const table = Object.fromEntries((Array.isArray(o.responsive) ? o.responsive : []).map((r: any) => [String(num(r?.breakpoint)), { spv: num(r?.settings?.slidesToShow) }]));
      return { perBp: perBp({ spv: num(o.slidesToShow) }, table, true), loop: o.infinite !== false, autoplay: !!o.autoplay, interval: num(o.autoplaySpeed),
        effect: o.fade ? "fade" : "slide", speed: num(o.speed), direction: o.vertical ? "vertical" : "horizontal" };
    }
    if (source === "splide") {
      const o = el.splide?.options;
      if (!o) return null;
      const table = Object.fromEntries(Object.entries(o.breakpoints ?? {}).map(([k, v]: [string, any]) => [k, { spv: num(v?.perPage), gap: px(v?.gap) }]));
      return { perBp: perBp({ spv: num(o.perPage), gap: px(o.gap) }, table, true), loop: o.type === "loop", autoplay: !!o.autoplay, interval: num(o.interval),
        effect: o.type === "fade" ? "fade" : "slide", speed: num(o.speed), direction: o.direction === "ttb" ? "vertical" : "horizontal" };
    }
    return null; // scroll-snap: no library config
  });
}

// Polls every carousel at once: a change of the track transform, scroll position or active child is one timestamp.
export function observeCarouselsInPage(arg: { selectors: string[]; durationMs: number; stepMs: number }): Promise<{ selector: string; changes: number[] }[]> {
  const els = arg.selectors.map((s) => document.querySelector(s));
  const keyOf = (el: Element | null) => {
    if (!el) return "";
    const track = (el.querySelector(".swiper-wrapper, .slick-track, .splide__list") ?? el) as HTMLElement;
    const kids = Array.from(track.children);
    const active = kids.findIndex((k) => /active|current/.test(k.getAttribute("class") ?? "") || k.getAttribute("aria-current") === "true");
    return `${getComputedStyle(track).transform}|${(el as HTMLElement).scrollLeft}|${(el as HTMLElement).scrollTop}|${active}`;
  };
  const last = els.map(keyOf), changes = els.map((): number[] => []), start = performance.now();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const t = Math.round(performance.now() - start);
      els.forEach((el, i) => { const k = keyOf(el); if (k !== last[i]) { last[i] = k; changes[i]!.push(t); } });
      if (t >= arg.durationMs) { clearInterval(timer); resolve(arg.selectors.map((selector, i) => ({ selector, changes: changes[i]! }))); }
    }, arg.stepMs);
  });
}

// Visible menu triggers whose panel (aria-controls, else the next element sibling) is hidden now.
export function hoverCandidatesInPage(arg: { max: number }): { trigger: string; panel: string }[] {
  const isUniqueId = (id: string) => document.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
  const selectorFor = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && isUniqueId(cur.id)) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
      let n = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.localName === cur.localName) n++;
      parts.unshift(`${cur.localName}:nth-of-type(${n})`);
    }
    return parts.join(" > ");
  };
  const visible = (el: Element) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const out: { trigger: string; panel: string }[] = [];
  for (const t of Array.from(document.querySelectorAll("[aria-haspopup]:not([aria-haspopup=dialog]), [aria-expanded]"))) {
    if (out.length >= arg.max || !visible(t) || t.getAttribute("role") === "tab") continue;
    const id = t.getAttribute("aria-controls");
    const panel = (id && document.getElementById(id)) || t.nextElementSibling;
    if (panel && !visible(panel)) out.push({ trigger: selectorFor(t), panel: selectorFor(panel) });
  }
  return out;
}

export function visibleInPage(selector: string): boolean {
  const el = document.querySelector(selector);
  return !!el && el.checkVisibility({ visibilityProperty: true, opacityProperty: true });
}
```

`interactive-scan.ts`:

```ts
// E2 §3 steps 1-2 on the live page (viewport 1440, right after the responsive snapshots). Bounded: one config evaluate
// (30 s), one observation window for every non-config carousel at once (<= 6 s each, <= 30 s per page), hover probes
// inside the same page budget. Never throws: a failure only lowers the confidence (config -> observed -> guessed).
export const INTERACTIVE_SCAN_LIMITS = { max: 50, configMs: 30_000, observeMs: 6_000, pageMs: 30_000, hoverMs: 2_000, stepMs: 100 };
const LIST_MS = 10_000; // the structure-only listing (same bound class as the DOM walks of capture-eval)
const within = <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); })]).finally(() => clearTimeout(timer));
};
export function intervalOf(changes: number[]): number | undefined {
  if (!changes.length) return undefined;
  const gaps = changes.length === 1 ? [changes[0]!] : changes.slice(1).map((t, i) => t - changes[i]!);
  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]!;
  return Math.min(60_000, Math.max(1_000, Math.round(median / 100) * 100));
}
export async function scanInteractives(page: Page, opts: { limits?: Partial<typeof INTERACTIVE_SCAN_LIMITS> } = {}): Promise<CapturedInteractive[]> {
  const limits = { ...INTERACTIVE_SCAN_LIMITS, ...opts.limits };
  const deadline = Date.now() + limits.pageMs;
  const out: CapturedInteractive[] = [];
  try {
    const hits = await within(page.evaluate(listCarouselsInPage, { max: limits.max }), LIST_MS).catch((): CarouselHit[] => []); // structure only: no instance read
    // §10: the one config evaluate per page, 30 s; a failure (or a timeout) reads nothing -> observed
    const reads = await within(page.evaluate(readCarouselConfigInPage, hits), limits.configMs).catch(() => hits.map(() => null));
    hits.forEach((h, i) => { const read = reads[i]; if (read) out.push({ kind: "carousel", selector: h.selector, source: h.source, confidence: "config", read }); });
    const rest = hits.filter((_, i) => !reads[i]);
    const window = Math.min(limits.observeMs, deadline - Date.now());
    const seen = window > 0 && rest.length
      ? await within(page.evaluate(observeCarouselsInPage, { selectors: rest.map((h) => h.selector), durationMs: window, stepMs: limits.stepMs }), window + 5_000).catch(() => undefined)
      : undefined;
    for (const h of rest) {
      const changes = seen?.find((s) => s.selector === h.selector)?.changes;
      out.push(changes ? { kind: "carousel", selector: h.selector, source: h.source, confidence: "observed", autoplay: changes.length > 0, ...(intervalOf(changes) && { interval: intervalOf(changes) }) }
        : { kind: "carousel", selector: h.selector, source: h.source, confidence: "guessed" });
    }
    const candidates = await page.evaluate(hoverCandidatesInPage, { max: limits.max }).catch(() => []);
    for (const c of candidates) {
      if (Date.now() >= deadline) break;
      const opened = await page.hover(c.trigger, { timeout: limits.hoverMs }).then(() => page.waitForTimeout(150)).then(() => page.evaluate(visibleInPage, c.panel)).catch(() => false);
      await page.mouse.move(0, 0).catch(() => undefined);
      if (opened) out.push({ kind: "dropdown", selector: c.trigger, panel: c.panel, openOn: "hover" });
    }
  } catch {
    // E2 §11: capture never fails because of E2
  }
  return out;
}
```

`capture.ts`: `PageCapture` thêm `interactives?: CapturedInteractive[]; // absent in captures written before E2`; sau `const breakpoints = await captureResponsive(page);` thêm `const interactives = await scanInteractives(page);` và đưa `interactives` vào `data`.

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run tests/unit/interactive-scan.test.ts; npx vitest run -c vitest.e2e.config.ts tests/e2e/interactive-scan.test.ts tests/e2e/capture-page.test.ts tests/e2e/interactions.test.ts; npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/interactive-eval.ts src/core/interactive-scan.ts src/core/capture.ts tests/fixtures/site4 tests/unit/interactive-scan.test.ts tests/e2e/interactive-scan.test.ts
git commit -m "feat(e2): capture reads Swiper/Slick/Splide config, observes autoplay, probes hover menus (bounded); site4 fixture" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: IR build — record capture → spec, loop clone, ghép bp theo khoá, giới hạn

**Files:**
- Create: `src/core/interactive-build.ts`
- Modify: `src/core/ir-build.ts:249-277` (`toDraft` dùng `alignChildren`; con thiếu ở bp nhận `display:none`), `src/core/fidelity.ts:95-110` (dùng `alignChildren`, ghi chú khi đã ghép theo khoá), `src/core/ir.ts:150-152` (`buildIR` gọi `attachInteractives`)
- Test: `tests/unit/interactive-build.test.ts`

**Interfaces:**
- Consumes: Task 6 `pageNodes`, `guessAll`, `guessAt`, `measureCarousel`, `placeGuesses`; Task 7 `CapturedInteractive`, `CarouselRead`; `findTrigger`, `indexById` (`ir-build.ts`); Task 5 `componentFidelity`, `COMPONENT_NOTE`.
- Produces: `attachInteractives(ir: IRV2, captures: PageCapture[]): IRV2`; `alignChildren<N extends { tag: string; attrs: Record<string, string>; children: N[] }>(node: N, other: N | undefined): { kids: (N | undefined)[]; keyed: boolean } | undefined` (export từ `ir-build.ts`). `buildIR(captures)` trả tài liệu đã có `interactive`.

- [ ] **Step 1: Viết test đỏ**

```ts
import { expect, test } from "vitest";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { buildIR } from "@/core/ir";
import type { CarouselSpec } from "@/core/interactive";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const el = (tag: string, attrs: Record<string, string> = {}, children: CaptureNode[] = [], bbox: CaptureNode["bbox"] = [0, 0, 100, 20], style: Record<string, string> = {}): CaptureNode => ({ tag, attrs, bbox, style, children });
const txt = (text: string): CaptureNode => ({ tag: "#text", text, attrs: {}, bbox: [0, 0, 10, 10], style: {}, children: [] });
const doc = (...body: CaptureNode[]) => el("html", {}, [el("head"), el("body", {}, body)]);
// a Swiper track at one breakpoint: `dups` duplicates at each end around 3 real slides of width w + gap g
function swiper(dups: number, w: number, g: number, fontSize: string): CaptureNode {
  const slide = (k: number, clone: boolean, x: number) => el("div", { class: `swiper-slide${clone ? " swiper-slide-duplicate" : ""}${!clone && k === 0 ? " swiper-slide-active" : ""}`, "data-swiper-slide-index": String(k) }, [txt(`S${k}`)], [x, 0, w, 100], { "font-size": fontSize });
  const real = [0, 1, 2], head = real.slice(-dups), tail = real.slice(0, dups);
  const kids = [...head.map((k) => slide(k, true, 0)), ...real.map((k) => slide(k, false, 0)), ...tail.map((k) => slide(k, true, 0))].map((s, i) => ({ ...s, bbox: [i * (w + g), 0, w, 100] as CaptureNode["bbox"] }));
  return el("section", {}, [el("div", { class: "swiper", id: "sw" }, [el("div", { class: "swiper-wrapper" }, kids, [0, 0, 3000, 100]), el("button", { class: "swiper-button-next" }, [txt(">")])], [0, 0, 3 * w + 2 * g, 100])]);
}
function capture(extra: Partial<PageCapture> = {}): PageCapture {
  return {
    url: "https://x.test/", pageId: "p1", capturedAt: "2026-10-02T00:00:00.000Z", title: "t", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [{ bp: 1440, dom: doc(swiper(2, 300, 30, "20px")), truncated: false }, { bp: 768, dom: doc(swiper(1, 300, 20, "16px")), truncated: false }, { bp: 375, dom: doc(swiper(3, 300, 10, "14px")), truncated: false }],
    interactions: [], assets: {}, skippedAssets: [], dynamic: [], ...extra,
  };
}
const walk = (ir: IRV2): IRNodeV2[] => { const out: IRNodeV2[] = []; const v = (n: IRNodeV2) => { out.push(n); n.children.forEach(v); }; ir.sections.forEach((s) => v(s.root)); return out; };
const carouselOf = (ir: IRV2) => walk(ir).find((n) => n.interactive?.kind === "carousel")!;

test("Review Focus 1 — loop clones + per-bp duplicate counts: real slides only, clones hidden, bp styles kept by key, spv/gap per bp", () => {
  const ir = buildIR([capture({ interactives: [{ kind: "carousel", selector: "#sw", source: "swiper", confidence: "observed", autoplay: false }] })]);
  const root = carouselOf(ir), spec = root.interactive as CarouselSpec;
  const nodes = new Map(walk(ir).map((n) => [n.id, n]));
  expect(spec.slides.map((id) => nodes.get(id)!.children[0]!.text)).toEqual(["S0", "S1", "S2"]);
  const track = nodes.get(spec.track)!;
  expect(track.children.filter((c) => c.hidden).length).toBe(4); // 2 + 2 at 1440
  expect(spec.active).toBe(0);
  expect(nodes.get(spec.slides[1]!)!.styles.bp[375]).toMatchObject({ "font-size": "14px" }); // aligned by data-swiper-slide-index
  expect(nodes.get(spec.slides[1]!)!.styles.bp[768]).toMatchObject({ "font-size": "16px" });
  expect(spec.slidesPerView).toEqual({ "1440": 3, "768": 3, "375": 3 });
  expect(spec.gap).toEqual({ "1440": 30, "768": 20, "375": 10 });
  expect(spec).toMatchObject({ source: "swiper", confidence: "observed", loop: true, arrows: { next: expect.any(String) } });
  expect(ir.fidelity.some((x) => x.feature === "component-note" && x.note.includes("slide clone"))).toBe(true);
});

test("config record wins over measurement; an unreproducible effect stays partial; >100 slides is unsupported, not truncated", () => {
  const read = { perBp: { "1440": { spv: 2.5, gap: 12 } }, loop: true, autoplay: true, interval: 4000, effect: "coverflow", speed: 600, direction: "horizontal" as const };
  const ir = buildIR([capture({ interactives: [{ kind: "carousel", selector: "#sw", source: "swiper", confidence: "config", read }] })]);
  const spec = carouselOf(ir).interactive as CarouselSpec;
  expect(spec).toMatchObject({ confidence: "config", autoplay: true, interval: 4000, speed: 600, transition: "slide", slidesPerView: { "1440": 2.5 }, gap: { "1440": 12 } });
  expect(ir.fidelity.find((x) => x.feature === "component")!.status).toBe("partial");
  expect(ir.fidelity.some((x) => x.note.includes("coverflow"))).toBe(true);
});

test("limits: 51 tablists on a page -> 50 components, the rest unsupported 'vượt giới hạn'", () => {
  const tablist = (i: number) => el("div", {}, [el("div", { role: "tablist" }, [el("button", { role: "tab", "aria-controls": `p${i}`, "aria-selected": "true" }, [txt("t")])]), el("div", { role: "tabpanel", id: `p${i}` }, [txt("x")])]);
  const dom = doc(el("main", {}, Array.from({ length: 51 }, (_, i) => tablist(i))));
  const ir = buildIR([capture({ breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom, truncated: false })) as PageCapture["breakpoints"] })]);
  expect(walk(ir).filter((n) => n.interactive).length).toBe(50);
  expect(ir.fidelity.some((x) => x.status === "unsupported" && x.note.includes("vượt giới hạn"))).toBe(true);
});

test("a hover record turns the guessed dropdown at that trigger into openOn hover (observed)", () => {
  const nav = el("nav", {}, [el("ul", {}, [el("li", { class: "has-sub" }, [el("a", { href: "#x", "aria-haspopup": "true" }, [txt("Sản phẩm")]), el("ul", { class: "sub" }, [el("li", {}, [txt("A")])], [0, 0, 0, 0], { display: "none" })])])]);
  const dom = doc(el("header", {}, [nav]));
  const ir = buildIR([capture({
    breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom, truncated: false })) as PageCapture["breakpoints"],
    interactives: [{ kind: "dropdown", selector: "html:nth-of-type(1) > body:nth-of-type(1) > header:nth-of-type(1) > nav:nth-of-type(1) > ul:nth-of-type(1) > li:nth-of-type(1) > a:nth-of-type(1)", panel: "x", openOn: "hover" }],
  })]);
  expect(walk(ir).find((n) => n.interactive)!.interactive).toMatchObject({ kind: "menu", openOn: "hover", confidence: "observed" });
});
```

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run tests/unit/interactive-build.test.ts`
Expected: FAIL — chưa có component trong `buildIR` (record bị bỏ qua, style 375 thiếu).

- [ ] **Step 3: Implement**

`ir-build.ts`:

```ts
const KEY_ATTRS = ["data-swiper-slide-index", "data-slick-index", "data-index", "id"];
const CLONE_CLASS = /(^|\s)(swiper-slide-duplicate|slick-cloned|splide__slide--clone)(\s|$)/;
type Keyed = { tag: string; attrs: Record<string, string>; children: Keyed[] };
const keyOf = (c: Keyed): string | undefined => {
  for (const a of KEY_ATTRS) if (c.attrs[a] !== undefined) return `${c.tag}|${a}=${c.attrs[a]}|${CLONE_CLASS.test(c.attrs.class ?? "") ? "clone" : ""}`;
  return undefined;
};
// The counterpart children at another breakpoint: by position when the counts match (as before), else by slide key
// when every element child on both sides has one (E2 §4 responsive); undefined when neither holds.
export function alignChildren<N extends Keyed>(node: N, other: N | undefined): { kids: (N | undefined)[]; keyed: boolean } | undefined {
  if (other?.tag !== node.tag) return undefined;
  if (other.children.length === node.children.length) return { kids: other.children as N[], keyed: false };
  const els = (list: N[]) => list.filter((c) => c.tag !== "#text");
  if (![...els(node.children as N[]), ...els(other.children as N[])].every((c) => keyOf(c) !== undefined)) return undefined;
  const byKey = new Map<string, N>();
  for (const c of els(other.children as N[])) if (!byKey.has(keyOf(c)!)) byKey.set(keyOf(c)!, c);
  return { kids: (node.children as N[]).map((c) => (c.tag === "#text" ? undefined : byKey.get(keyOf(c)!))), keyed: true };
}
```

trong `toDraft` thay `aligned(...)`:

```ts
  const a768 = alignChildren(node, at768), a375 = alignChildren(node, at375);
  draft.children = node.children.map((child, i) => {
    const d = toDraft(child, `${path}.${i}`, a768?.kids[i], a375?.kids[i], walk);
    // R7: keyed alignment and no counterpart -> the node does not exist at that breakpoint
    for (const [bp, a] of [["768", a768], ["375", a375]] as const) if (a?.keyed && !a.kids[i] && child.tag !== "#text") d.style.media = { ...d.style.media, [bp]: { display: "none" } };
    return d;
  });
```

`fidelity.ts` vòng visit: `kids.push(alignChildren(node, other)?.kids)`; khi `keyed` thì note `"Số phần tử con ở ${bp} khác 1440; đã ghép theo khoá slide, phần tử chỉ có ở 1440 bị ẩn ở ${bp}"`.

`interactive-build.ts`:

```ts
// E2 §3 -> IR: capture records (config / observed / hover) become specs on the node their selector names (the 1440
// capture path is the IR id), then structural guesses fill the rest. Pure; one clone of the document.
export function attachInteractives(ir: IRV2, captures: PageCapture[]): IRV2 {
  let out = ir;
  const failed: FidelityItem[] = []; // detected but no spec could be built (§3: unsupported)
  for (const capture of captures) {
    const dom = capture.breakpoints.find((b) => b.bp === 1440)?.dom ?? capture.breakpoints[0]?.dom;
    if (!dom || !out.pages.some((p) => p.id === capture.pageId)) continue;
    const paths = new Map<CaptureNode, string>();
    const index = (n: CaptureNode, path: string): void => { paths.set(n, path); n.children.forEach((c, i) => index(c, `${path}.${i}`)); };
    index(dom, "0");
    const byId = indexById(dom, new Map());
    const idOf = (selector: string) => { const hit = findTrigger(dom, byId, selector); return hit ? `${capture.pageId}:${paths.get(hit)}` : undefined; };
    const p = pageNodes(out, capture.pageId);
    const guesses: Guess[] = [];
    for (const rec of capture.interactives ?? []) {
      const id = idOf(rec.selector);
      if (!id || !p.byId.has(id)) continue;
      if (rec.kind === "carousel") {
        const g = fromRecord(p, id, rec);
        if (g) guesses.push(g);
        else failed.push({ pageId: capture.pageId, feature: COMPONENT_NOTE, status: "unsupported", nodeId: id, sourceRef: id, note: `Carousel ${rec.source} không dựng được spec (không thấy slide hoặc vượt giới hạn ${INTERACTIVE_LIMITS.items} item)` });
        continue;
      }
      const g = guessAt(p, id, "menu");
      if (g && (g.spec.kind === "dropdown" || g.spec.kind === "menu")) guesses.push({ ...g, spec: { ...g.spec, openOn: "hover", confidence: "observed" } });
    }
    // a record replaces a migrated/guessed carousel on the same track; structural guesses never overwrite
    out = placeGuesses(dropCarouselsOnTracks(out, capture.pageId, guesses), capture.pageId, [...guesses, ...guessAll(pageNodes(out, capture.pageId))], "Nhận diện khi clone");
  }
  return { ...out, fidelity: capFidelity([...out.fidelity.filter((x) => x.feature !== COMPONENT_FEATURE), ...failed, ...componentFidelity(out, [])]) };
}
```

```ts
const UNREPRODUCIBLE = new Set(["coverflow", "cube", "flip", "cards", "creative"]);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
type CarouselRecord = Extract<CapturedInteractive, { kind: "carousel" }>;
// structure from the IR (guessCarousel: track, real slides, clones, arrows, pagination, bbox measure), values from the record
function fromRecord(p: PageNodes, id: string, rec: CarouselRecord): Guess | undefined {
  const g = guessAt(p, id, "carousel");
  if (!g || g.spec.kind !== "carousel") return undefined;
  const spec: CarouselSpec = { ...g.spec, source: rec.source, confidence: rec.confidence };
  const notes: string[] = [];
  const r = rec.read;
  if (r) {
    for (const bp of ["1440", "768", "375"] as const) {
      const v = r.perBp[bp];
      if (v?.spv !== undefined) spec.slidesPerView = { ...spec.slidesPerView, [bp]: clamp(Math.round(v.spv * 100) / 100, 1, 10) };
      if (v?.gap !== undefined) spec.gap = { ...spec.gap, [bp]: clamp(Math.round(v.gap), 0, 200) };
    }
    if (r.loop !== undefined) spec.loop = r.loop;
    if (r.autoplay !== undefined) spec.autoplay = r.autoplay;
    if (r.interval !== undefined) spec.interval = clamp(Math.round(r.interval), 1000, 60000);
    if (r.speed !== undefined) spec.speed = clamp(Math.round(r.speed), 0, 5000);
    if (r.direction) spec.direction = r.direction;
    spec.transition = r.effect === "fade" ? "fade" : "slide";
    if (r.effect && UNREPRODUCIBLE.has(r.effect)) notes.push(`hiệu ứng ${r.effect} không tái tạo; dùng trượt`);
    if (r.active !== undefined && !g.snapshotActive) spec.active = clamp(r.active, 0, spec.slides.length - 1); // the snapshot's own active slide matches its pixels
  } else if (rec.confidence === "observed") {
    spec.autoplay = rec.autoplay ?? false;
    if (rec.interval !== undefined) spec.interval = rec.interval;
    notes.push("loop, speed, slidesPerView, gap suy từ cấu trúc và bbox; autoplay/interval quan sát trên trang gốc");
  } else notes.push(...g.notes);
  return { ...g, spec, notes };
}
// a capture record replaces the carousel a v1 behavior migration (or an earlier guess) put on the same track
function dropCarouselsOnTracks(ir: IRV2, pageId: string, guesses: Guess[]): IRV2 {
  const tracks = new Set(guesses.flatMap((g) => (g.spec.kind === "carousel" ? [g.spec.track] : [])));
  if (!tracks.size) return ir;
  const out = structuredClone(ir);
  for (const node of pageNodes(out, pageId).byId.values()) if (node.interactive?.kind === "carousel" && tracks.has(node.interactive.track)) delete node.interactive;
  return out;
}
```

`slides.length > 100` không dựng được ở `guessCarousel` → `attachInteractives` thêm item `component-note` unsupported "vượt giới hạn 100 item" cho node của record. `ir.ts`: `return attachInteractives(migrateIR(buildLegacyIR(captures), captures), captures);`.

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run tests/unit/interactive-build.test.ts tests/unit/ir.test.ts tests/unit/ir-v2.test.ts tests/unit/emit.test.ts tests/unit/emit-v2.test.ts tests/unit/fidelity.test.ts tests/unit/dedupe.test.ts; npx vitest run -c vitest.e2e.config.ts tests/e2e/capture-responsive.test.ts tests/e2e/emit-render.test.ts; npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/interactive-build.ts src/core/ir-build.ts src/core/fidelity.ts src/core/ir.ts tests/unit/interactive-build.test.ts
git commit -m "feat(e2): build components from capture records (loop clones, active, slidesPerView/gap, effects), keyed breakpoint alignment, 50/100 limits" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: QA `?qa=1`, QA hành vi, `qa.json.behavior[]`, Preview

**Files:**
- Create: `src/core/qa-behavior.ts`
- Modify: `src/core/qa.ts:133-140` (`prepareClonePage` thêm `qa=1`), `src/core/jobs.ts:49,206-212,395-400` (`QaFile.behavior`, `JobDeps.checkBehavior`, `scoreAll`), `src/app/api/projects/[id]/preview/route.ts:34-53` (`behavior`, `withBehavior`), `src/app/p/[id]/preview/preview-view.tsx:30-40,448-485` (type `Data.behavior`, khối "Hành vi component" trong Checklist), `docs/superpowers/design/stitch-screens.md` (dòng `ui_qa_preview_behavior_list`)
- Test: `tests/e2e/qa-behavior.test.ts`

**Interfaces:**
- Consumes: Task 3/4 runtime (`data-c-active`, `data-c-open`), Task 5 `BehaviorResult`, `withBehavior`; `component-site.ts`.
- Produces: `BEHAVIOR_LIMITS = { perCheckMs: 5_000, perPage: 50 }`; `checkBehavior(handle: BrowserHandle, opts: { outDir: string; ir: IRV2; limits?: Partial<typeof BEHAVIOR_LIMITS> }): Promise<BehaviorResult[]>`; `QaFile = { scores: SectionScore[]; behavior?: BehaviorResult[]; stale?: true }`; GET preview thêm `behavior: BehaviorResult[]` (rỗng khi `stale`).

- [ ] **Step 1: Viết test đỏ**

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { emitHtml } from "@/core/emit-html";
import { checkBehavior } from "@/core/qa-behavior";
import { prepareClonePage } from "@/core/qa";
import { serveDir } from "@/core/serve";
import { carouselRoot, n, siteOf, t } from "./component-site";

let handle: BrowserHandle;
let tmp = "";
beforeAll(async () => { handle = await openBrowser({ headed: false }); tmp = await mkdtemp(join(tmpdir(), "qa-beh-")); });
afterAll(async () => { await handle.close(); await rm(tmp, { recursive: true, force: true }); });

const hidden = { base: { display: "none" }, bp: {}, state: {}, pseudo: {} };
const tabs = n("tabs", "section", [n("tl", "div", [n("t0", "button", [t("a", "1")]), n("t1", "button", [t("b", "2")])]), n("p0", "div", [t("c", "one")]), n("p1", "div", [t("d", "two")], { styles: hidden })],
  { interactive: { kind: "tabs", source: "aria", confidence: "guessed", tabs: [{ trigger: "t0", panel: "p0" }, { trigger: "t1", panel: "p1" }], active: 0 } });
// the dialog is the component root; the section around it holds the trigger (outside the subtree, same page)
const modal = (k: "esc" | "backdrop") => n(`sec-${k}`, "section", [n(`o-${k}`, "button", [t(`ot-${k}`, "Open")]),
  n(`m-${k}`, "div", [t(`dt-${k}`, "Dialog")], { styles: hidden, interactive: { kind: "modal", source: "aria", confidence: "guessed", triggers: [`o-${k}`], dialog: `m-${k}`, closeOn: [k] } })]);

test("checkBehavior: carousel next + autoplay (fake clock) + pagination, tabs, modal Esc pass; a modal Esc cannot close fails with a reason", { timeout: 60_000 }, async () => {
  const ir = siteOf(carouselRoot({ autoplay: true, interval: 60_000, loop: true }), tabs, modal("esc"), modal("backdrop"));
  const outDir = join(tmp, "a");
  await emitHtml(ir, { outDir, workspaceDir: tmp, assetMap: {}, pageUrls: { home: "https://x.test/" } });
  const started = Date.now();
  const results = await checkBehavior(handle, { outDir, ir });
  expect(Date.now() - started).toBeLessThan(4 * 5_000); // 1.5 x 60 s autoplay is checked on the fake clock (R4)
  const by = (id: string) => results.find((r) => r.nodeId === id)!;
  expect(by("root")).toMatchObject({ kind: "carousel", ok: true });
  expect(by("tabs")).toMatchObject({ ok: true });
  expect(by("m-esc")).toMatchObject({ ok: true });
  expect(by("m-backdrop")).toMatchObject({ ok: false, reason: expect.stringMatching(/đóng/) }); // no Esc, no close button: the check cannot close it
});

test("limits: a check over its timeout fails as 'quá thời gian'; components past 50 on a page are not checked", { timeout: 60_000 }, async () => {
  const many = siteOf(...Array.from({ length: 3 }, (_, i) => carouselRoot({}, `c${i}-`)));
  const outDir = join(tmp, "b");
  await emitHtml(many, { outDir, workspaceDir: tmp, assetMap: {}, pageUrls: { home: "https://x.test/" } });
  const timed = await checkBehavior(handle, { outDir, ir: many, limits: { perCheckMs: 1 } });
  expect(timed.every((r) => !r.ok && r.reason?.includes("quá thời gian"))).toBe(true);
  const capped = await checkBehavior(handle, { outDir, ir: many, limits: { perPage: 2 } });
  expect(capped.filter((r) => r.reason?.includes("vượt giới hạn"))).toHaveLength(1);
});

test("Review Focus 4 — prepareClonePage (scoring + fix inspector) loads ?qa=1: the autoplay carousel stays at its capture state", { timeout: 60_000 }, async () => {
  const ir = siteOf(carouselRoot({ autoplay: true, interval: 1000, loop: true, speed: 300, active: 1 }));
  const outDir = join(tmp, "c");
  await emitHtml(ir, { outDir, workspaceDir: tmp, assetMap: {}, pageUrls: { home: "https://x.test/" } });
  const server = await serveDir(outDir);
  try {
    await withPage(handle, async (page) => {
      await prepareClonePage(page, `${server.url}/index.html`, 1440);
      expect(new URL(page.url()).searchParams.get("qa")).toBe("1");
      await page.waitForTimeout(2_500); // real time: 2+ intervals
      expect(await page.getAttribute('[data-ir-id="root"]', "data-c-active")).toBe("1");
    });
  } finally {
    await server.close();
  }
});
```

(Baseline pixel site1–3 không cần test mới: `tests/e2e/qa-baseline.test.ts` của Task 1 chạy lại ở Step 4, giờ trên `?qa=1` và với component đã gắn.)

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/qa-behavior.test.ts`
Expected: FAIL — module `@/core/qa-behavior` không tồn tại.

- [ ] **Step 3: Implement**

`qa.ts` (`prepareClonePage`): `await page.goto(withQa(url), { waitUntil: "load" });` với `const withQa = (url: string) => \`${url}${url.includes("?") ? "&" : "?"}qa=1\`; // E2 §4: capture state, no autoplay, no motion`.

`qa-behavior.ts`:

```ts
// E2 §5: behaviour QA on the clone (live mode, fake clock), after the pixel pass. Bounded: <= 5 s per component,
// <= 50 components per page, pages sequential on one browser page each, no AI. A check never throws: it fails with a reason.
import type { Page } from "playwright";
import { withPage, type BrowserHandle } from "./browser";
import { pageFileNames } from "./emit-html";
import type { BehaviorResult } from "./fidelity";
import type { InteractiveSpec } from "./interactive";
import type { IRNodeV2, IRV2 } from "./ir-v2";
import { serveDir } from "./serve";
import { sameOrigin } from "./url";

export const BEHAVIOR_LIMITS = { perCheckMs: 5_000, perPage: 50 };
const sel = (id: string) => `[data-ir-id=${JSON.stringify(id)}]`;
const fail = (reason: string): never => { throw new Error(reason); };

async function check(page: Page, root: string, spec: InteractiveSpec): Promise<void> {
  const active = () => page.getAttribute(sel(root), "data-c-active");
  const visible = (id: string) => page.isVisible(sel(id));
  switch (spec.kind) {
    case "carousel": {
      const start = await active();
      if (spec.arrows?.next) await page.click(sel(spec.arrows.next));
      else await page.dispatchEvent(sel(root), "keydown", { key: spec.direction === "vertical" ? "ArrowDown" : "ArrowRight", bubbles: true }); // no next arrow: the keyboard path
      if ((await active()) === start) fail("bấm next không đổi slide");
      if (spec.autoplay) {
        const before = await active();
        // hover and focus-within pause autoplay (E2 §4): leave the component first
        await page.mouse.move(0, 0);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.clock.runFor(Math.ceil(spec.interval * 1.5));
        if ((await active()) === before) fail("autoplay không đổi slide trong 1.5 × interval");
      }
      if (spec.pagination?.kind === "bullets") {
        const target = String(spec.slides.length - 1);
        await page.locator(`${sel(spec.pagination.container)} > *`).nth(spec.slides.length - 1).click();
        if ((await active()) !== target) fail("bấm pagination không tới đúng slide");
      }
      return;
    }
    case "tabs": {
      const k = spec.tabs.length > 1 ? (spec.active + 1) % spec.tabs.length : 0;
      await page.click(sel(spec.tabs[k]!.trigger));
      if (!(await visible(spec.tabs[k]!.panel))) fail(`bấm tab ${k + 1} không hiện panel ${k + 1}`);
      return;
    }
    case "accordion": {
      const it = spec.items[0]!, was = await visible(it.panel);
      await page.click(sel(it.trigger));
      if ((await visible(it.panel)) === was) fail("bấm mục không đổi trạng thái mở/đóng");
      return;
    }
    case "modal": {
      await page.click(sel(spec.triggers[0]!));
      if (!(await visible(spec.dialog))) fail("bấm trigger không mở dialog");
      if (spec.closeOn.includes("esc")) await page.keyboard.press("Escape");
      else if (spec.closeButton) await page.click(sel(spec.closeButton));
      if (await visible(spec.dialog)) fail("không đóng được dialog (Esc / nút đóng)");
      return;
    }
    case "video": {
      const ok = await page.$eval(sel(spec.node), (el, s) => el.tagName === "IFRAME" ? /^https:\/\/(www\.youtube-nocookie\.com|player\.vimeo\.com)\//.test((el as HTMLIFrameElement).src)
        : (el as HTMLVideoElement).loop === s.loop && (el as HTMLVideoElement).controls === s.controls && (el as HTMLVideoElement).muted === (s.muted || s.autoplay), spec);
      if (!ok) fail("thuộc tính video không khớp spec");
      return;
    }
    default: {
      if (spec.openOn === "hover") await page.hover(sel(spec.trigger)); else await page.click(sel(spec.trigger));
      if (!(await visible(spec.panel))) fail(`${spec.openOn === "hover" ? "hover" : "bấm"} trigger không mở panel`);
    }
  }
}

export async function checkBehavior(handle: BrowserHandle, opts: { outDir: string; ir: IRV2; limits?: Partial<typeof BEHAVIOR_LIMITS> }): Promise<BehaviorResult[]> {
  const limits = { ...BEHAVIOR_LIMITS, ...opts.limits };
  const files = pageFileNames(opts.ir.pages), results: BehaviorResult[] = [];
  const server = await serveDir(opts.outDir);
  try {
    for (const page of opts.ir.pages) {
      const roots: IRNodeV2[] = [];
      const visit = (n: IRNodeV2) => { if (n.interactive) roots.push(n); n.children.forEach(visit); };
      [page.shell, ...opts.ir.sections.filter((s) => s.pageId === page.id).map((s) => s.root)].forEach(visit);
      if (!roots.length) continue;
      const url = `${server.url}/${files.get(page.id)}`;
      await withPage(handle, async (p) => {
        await p.route("**/*", (r) => (sameOrigin(r.request().url(), url) ? r.fallback() : r.abort()));
        await p.clock.install();
        for (const [i, root] of roots.entries()) {
          const base = { pageId: page.id, nodeId: root.id, kind: root.interactive!.kind };
          if (i >= limits.perPage) { results.push({ ...base, ok: false, reason: `vượt giới hạn ${limits.perPage} component/trang` }); continue; }
          // a fresh load per component: one check's state never leaks into the next
          const run = p.goto(url, { waitUntil: "load" }).then(() => check(p, root.id, root.interactive!));
          let timer: NodeJS.Timeout | undefined;
          const outcome = await Promise.race([run.then(() => "ok" as const), new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), limits.perCheckMs); })])
            .catch((e: unknown) => (e instanceof Error ? e.message : String(e))).finally(() => clearTimeout(timer));
          if (outcome === "timeout") await run.catch(() => undefined); // never overlap the next check
          results.push(outcome === "ok" ? { ...base, ok: true } : { ...base, ok: false, reason: outcome === "timeout" ? `quá thời gian ${limits.perCheckMs / 1000}s` : outcome.slice(0, 200) });
        }
      });
    }
  } finally {
    await server.close();
  }
  return results;
}
```

`jobs.ts`: `export type QaFile = { scores: SectionScore[]; behavior?: BehaviorResult[]; stale?: true };` — `JobDeps.checkBehavior?: typeof checkBehavior;` và default `checkBehavior` trong `runProject` deps; `scoreAll`:

```ts
async function scoreAll(run: Run, ir: IR): Promise<SectionScore[]> {
  const outDir = join(run.ws, "out");
  const scores = await run.deps.scoreSections(run.handle, { workspaceDir: run.ws, outDir, ir, captures: await loadCaptures(run) });
  const behavior = await run.deps.checkBehavior(run.handle, { outDir, ir }); // R3: the behaviour pass of the same qa task
  if (behavior.length) log(run, "info", `QA hành vi: ${behavior.filter((b) => b.ok).length}/${behavior.length} component đạt`);
  await writeJsonAtomic(join(run.ws, "qa.json"), { scores, behavior } satisfies QaFile);
  return scores;
}
```

(`resumeProject` dùng chung `deps` mặc định: thêm `checkBehavior` ở cùng chỗ với `scoreSections`.) Preview route: `const behavior = qa.stale ? [] : qa.behavior ?? [];` và trả `behavior`, `fidelity: withBehavior(fidelity, behavior)`. `preview-view.tsx`: `Data.behavior: { pageId: string; nodeId: string; kind: string; ok: boolean; reason?: string }[]`; trong `Checklist` sau `<ul className="checklist">` thêm:

```tsx
        {data.behavior.length > 0 && (
          <ul className="checklist" data-ui="ui_qa_preview_behavior_list" aria-label="QA hành vi component">
            {data.behavior.filter((b) => b.pageId === pageId).map((b) => (
              <li key={`${b.pageId}:${b.nodeId}`} className={`check-row check-${b.ok ? "captured" : "failed"}`}>
                <Icon name={b.ok ? "check" : "close"} />
                <span className="check-label">{b.kind} · {b.nodeId.slice(-24)}</span>
                <span className="t-label-sm check-status">{b.ok ? "hành vi đạt" : b.reason ?? "không đạt"}</span>
              </li>
            ))}
          </ul>
        )}
```

(`Checklist` nhận thêm prop `pageId`). `stitch-screens.md` bảng `/p/[id]/preview`: `| \`ui_qa_preview_behavior_list\` | E2 §5 QA hành vi | \`behavior\` trong \`GET …/preview\` (rỗng khi stale) — trong tab Checklist | không có trong mockup, dùng token/component sẵn có | build |`.

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/qa-behavior.test.ts tests/e2e/qa-score.test.ts tests/e2e/qa-fixloop.test.ts tests/e2e/rescore.test.ts tests/e2e/qa-baseline.test.ts; npx vitest run tests/unit/jobs.test.ts tests/unit/preview-model.test.ts; npm run typecheck`
Expected: PASS — baseline site1–3 không tụt (site2 giờ có component).

- [ ] **Step 5: Commit**

```bash
git add -- src/core/qa-behavior.ts src/core/qa.ts src/core/jobs.ts "src/app/api/projects/[id]/preview/route.ts" "src/app/p/[id]/preview/preview-view.tsx" docs/superpowers/design/stitch-screens.md tests/e2e/qa-behavior.test.ts
git commit -m "feat(e2): QA page loads ?qa=1; bounded behaviour QA after the pixel pass, qa.json behavior[], Preview list and Fidelity upgrade" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Command A — `updateComponent`, `convertToComponent`, `unwrapComponent`, bảo vệ vai trò

**Files:**
- Modify: `src/core/ir-command.ts:25-53` (union), `:287-332` (`applyTree` gọi `guardRoles`, `duplicateNode` bỏ `interactive`), `:425-452` (`applyOne`), `:455-483` (`prepareCommands`), `:506-519` (`applyCommands` gọi `checkInteractives` sau mỗi bước khi tài liệu có component), `src/core/interactive.ts` (`patchSpec`, `specFromRoles`), `src/app/api/projects/[id]/editor/commands/route.ts:14-26`
- Test: `tests/unit/ir-command-interactive.test.ts`, `tests/unit/editor-api.test.ts` (thêm 1 test)

**Interfaces:**
- Consumes: Task 1 `parseSpec`, `checkInteractives`, `isOverridePath`; Task 2 `roleIndex`.
- Produces:

```ts
// EditorCommand / NormalizedCommand (Edit) additions
| { op: "updateComponent"; id: string; patch: Record<string, unknown> }
| { op: "convertToComponent"; id: string; kind: InteractiveKind; roles: Record<string, unknown> }
| { op: "unwrapComponent"; id: string }
// HistoryCommand (private inverse)
| { op: "restoreSpec"; id: string; interactive?: InteractiveSpec; overrides?: string[] }
// interactive.ts
export function patchSpec(spec: InteractiveSpec, patch: Record<string, unknown>): InteractiveSpec; // config fields only; id lists must stay equal
export function specFromRoles(kind: InteractiveKind, roles: Record<string, unknown>): InteractiveSpec; // confidence "manual", source "manual", safe defaults
export const PATCHABLE: Record<InteractiveKind, readonly string[]>;
```

`PATCHABLE`: carousel `active, autoplay, interval, loop, direction, transition, speed, slidesPerView, gap, arrows, pagination`; tabs `active`; accordion `multiple, items` (chỉ `open` được đổi); modal `closeOn, closeButton`; dropdown/menu `openOn`; video `autoplay, muted, loop, controls`. Field optional nhận `null` = bỏ.

- [ ] **Step 1: Viết test đỏ**

```ts
import { expect, test } from "vitest";
import { refreshFidelity } from "@/core/fidelity";
import { applyCommands, prepareCommands, type EditorCommand } from "@/core/ir-command";
import { resolveComponents } from "@/core/ir-component";
import type { CarouselSpec, InteractiveSpec } from "@/core/interactive";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const c of children) c.parentId = id;
  return node;
};
const spec: CarouselSpec = { kind: "carousel", source: "swiper", confidence: "config", viewport: "vp", track: "tr", slides: ["s0", "s1"], active: 0,
  autoplay: false, interval: 5000, loop: false, direction: "horizontal", transition: "slide", speed: 300, slidesPerView: { "1440": 1 }, gap: { "1440": 0 } };
const fixture = (): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "pg", path: "/", title: "", meta: {}, sectionIds: ["a", "b"], shell: n("html", "html", [n("body", "body", [n("pa", "#section", [], { attrs: { "data-section": "a" } }), n("pb", "#section", [], { attrs: { "data-section": "b" } })])]) }],
  sections: [
    { id: "a", pageId: "pg", name: "a", role: "block", hash: "h", origin: "capture", root: n("sec", "section", [
      n("root", "div", [n("vp", "div", [n("tr", "div", [n("s0", "div"), n("s1", "div")])])], { interactive: spec }),
      n("dlg", "div", [n("x", "button")], { interactive: { kind: "modal", source: "aria", confidence: "guessed", triggers: ["open"], dialog: "dlg", closeOn: ["esc"] } }),
      n("tabs", "div", [n("t1", "button"), n("p1", "div")]),
    ]) },
    { id: "b", pageId: "pg", name: "b", role: "block", hash: "h2", origin: "capture", root: n("sec2", "section", [n("open", "button")]) },
  ],
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
});
const ids = () => { let i = 0; return () => `new${++i}`; };
const run = (ir: IRV2, commands: EditorCommand[]) => applyCommands(ir, prepareCommands(ir, commands, ids()));
const node = (ir: IRV2, id: string): IRNodeV2 | undefined => { let hit: IRNodeV2 | undefined; const v = (x: IRNodeV2) => { if (x.id === id) hit = x; x.children.forEach(v); }; ir.sections.forEach((s) => v(s.root)); return hit; };
const roundTrip = (ir: IRV2, commands: EditorCommand[]) => { const out = run(ir, commands); expect(applyCommands(out.ir, out.inverse).ir).toEqual(ir); return out; };

test("updateComponent: schema per kind, exact inverse; foreign fields, bad values and id-list changes are refused", () => {
  const { ir } = roundTrip(fixture(), [{ op: "updateComponent", id: "root", patch: { autoplay: true, interval: 4000, slidesPerView: { "1440": 1, "768": 2 } } }]);
  expect(node(ir, "root")!.interactive).toMatchObject({ autoplay: true, interval: 4000, slidesPerView: { "768": 2 }, confidence: "config" });
  for (const patch of [{ tabs: [] }, { interval: 10 }, { slides: ["s1", "s0"] }, { kind: "tabs" }, { confidence: "manual" }])
    expect(() => run(fixture(), [{ op: "updateComponent", id: "root", patch }])).toThrow(/IR_PATCH_INVALID|not allowed|invalid/);
  expect(() => run(fixture(), [{ op: "updateComponent", id: "tabs", patch: { active: 0 } }])).toThrow(/no interactive/);
});

test("updateComponent on an instance writes interactive.<field> overrides", () => {
  const ir = fixture();
  const inst = node(ir, "root")!;
  inst.component = { id: "c", role: "instance", sourceId: "m", overrides: ["interactive"] };
  ir.components = [{ id: "c", root: n("m", "div", [n("mvp", "div", [n("mtr", "div", [n("m0", "div"), n("m1", "div")])])], { component: { id: "c", role: "main" } }), instanceIds: ["root"] }];
  for (const x of [["vp", "mvp"], ["tr", "mtr"], ["s0", "m0"], ["s1", "m1"]] as const) node(ir, x[0])!.component = { id: "c", role: "instance", sourceId: x[1], overrides: [] };
  const out = run(ir, [{ op: "updateComponent", id: "root", patch: { loop: true } }]).ir;
  expect(node(out, "root")!.component!.overrides).toEqual(expect.arrayContaining(["interactive", "interactive.loop"]));
  expect(node(resolveComponents(out), "root")!.interactive).toMatchObject({ loop: true });
});

test("convertToComponent (manual) validates like load; unwrapComponent removes it, Undo restores, Fidelity marks the unwrap", () => {
  const { ir } = roundTrip(fixture(), [{ op: "convertToComponent", id: "tabs", kind: "tabs", roles: { tabs: [{ trigger: "t1", panel: "p1" }] } }]);
  expect(node(ir, "tabs")!.interactive).toEqual({ kind: "tabs", source: "manual", confidence: "manual", tabs: [{ trigger: "t1", panel: "p1" }], active: 0 });
  expect(() => run(fixture(), [{ op: "convertToComponent", id: "tabs", kind: "tabs", roles: { tabs: [{ trigger: "t1", panel: "open" }] } }])).toThrow(/outside/);
  expect(() => run(fixture(), [{ op: "convertToComponent", id: "root", kind: "tabs", roles: { tabs: [{ trigger: "s0", panel: "s1" }] } }])).toThrow(/already/);
  const unwrapped = roundTrip(fixture(), [{ op: "unwrapComponent", id: "root" }]).ir;
  expect(node(unwrapped, "root")!.interactive).toBeUndefined();
  const before = refreshFidelity([], fixture(), []);
  expect(refreshFidelity(before, unwrapped, []).some((x) => x.nodeId === "root" && x.note.includes("bỏ hành vi theo yêu cầu"))).toBe(true);
});

test("Review Focus 3 — tree commands cannot break a component: slide / outside modal trigger refused by role, whole component fine", () => {
  expect(() => run(fixture(), [{ op: "deleteNode", id: "s1" }])).toThrow(/slide.*removeComponentItem/);
  expect(() => run(fixture(), [{ op: "deleteNode", id: "open" }])).toThrow(/trigger/);
  expect(() => run(fixture(), [{ op: "moveNode", id: "s1", parentId: "tr", index: 0 }])).toThrow(/moveComponentItem/);
  expect(() => run(fixture(), [{ op: "createNode", parentId: "tr", index: 0, draft: { tag: "div" } }])).toThrow(/addComponentItem/);
  expect(() => run(fixture(), [{ op: "deleteNode", id: "root" }])).not.toThrow();
  const copy = run(fixture(), [{ op: "duplicateNode", id: "root", parentId: "sec", index: 3 }]).ir;
  expect(node(copy, "new1")!.interactive).toBeUndefined(); // R12: a copy is static
  expect(() => run(fixture(), [{ op: "setHidden", id: "s1", hidden: true }])).not.toThrow();
});
```

`tests/unit/editor-api.test.ts` (thêm, dùng `seed` + `post` có sẵn):

```ts
test("commands route accepts the E2 component ops; private restoreSpec is refused as an unknown op", async () => {
  const id = await seed();
  const doc = await projectDocuments(getDb()).loadDocument(id);
  const bad = await post(commandsRoute, id, { baseRevision: doc.revision, commands: [{ op: "restoreSpec", id: "x" }] });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as { code: string }).code).toBe("VALIDATION"); // zod: unknown op
  const root = doc.sections[0]!.root.id;
  const shape = await post(commandsRoute, id, { baseRevision: doc.revision, commands: [{ op: "unwrapComponent", id: root }] });
  expect(((await shape.json()) as { code: string }).code).toBe("IR_PATCH_INVALID"); // accepted by zod, refused by the core: no component there
});
```

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run tests/unit/ir-command-interactive.test.ts`
Expected: FAIL — `command 0 (updateComponent): unknown command`.

- [ ] **Step 3: Implement**

`interactive.ts`:

```ts
export const PATCHABLE: Record<InteractiveKind, readonly string[]> = {
  carousel: ["active", "autoplay", "interval", "loop", "direction", "transition", "speed", "slidesPerView", "gap", "arrows", "pagination"],
  tabs: ["active"], accordion: ["multiple", "items"], modal: ["closeOn", "closeButton"], dropdown: ["openOn"], menu: ["openOn"], video: ["autoplay", "muted", "loop", "controls"],
};
const OPTIONAL = new Set(["arrows", "pagination", "closeButton"]);
export function patchSpec(spec: InteractiveSpec, patch: Record<string, unknown>): InteractiveSpec {
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || !Object.keys(patch).length) invalid("patch must be a non-empty object");
  const next: Record<string, unknown> = { ...spec };
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE[spec.kind].includes(key)) invalid(`field not allowed on ${spec.kind}: ${key.slice(0, 40)}`);
    if (value === null && OPTIONAL.has(key)) delete next[key]; else next[key] = value;
  }
  if (spec.kind === "accordion" && Array.isArray(next.items)) {
    const items = next.items as { trigger?: unknown; panel?: unknown }[];
    if (items.length !== spec.items.length || items.some((x, i) => x?.trigger !== spec.items[i]!.trigger || x?.panel !== spec.items[i]!.panel)) invalid("accordion items: only `open` can change (use add/remove/moveComponentItem)");
  }
  return parseSpec(next);
}
const DEFAULTS: Record<InteractiveKind, Record<string, unknown>> = {
  carousel: { active: 0, autoplay: false, interval: 5000, loop: false, direction: "horizontal", transition: "slide", speed: 300, slidesPerView: { "1440": 1 }, gap: { "1440": 0 } },
  tabs: { active: 0 }, accordion: { multiple: true }, modal: { closeOn: ["esc", "backdrop"] }, dropdown: { openOn: "click" }, menu: { openOn: "click" },
  video: { mode: "native", autoplay: false, muted: false, loop: false, controls: true },
};
export function specFromRoles(kind: InteractiveKind, roles: Record<string, unknown>): InteractiveSpec {
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) invalid("roles must be an object");
  const items = kind === "accordion" && Array.isArray(roles.items) ? { items: (roles.items as object[]).map((x) => ({ open: false, ...x })) } : {};
  return parseSpec({ ...DEFAULTS[kind], ...roles, ...items, kind, source: "manual", confidence: "manual" });
}
```

`ir-command.ts`:

```ts
type Spec = Extract<Edit, { op: "updateComponent" | "convertToComponent" | "unwrapComponent" }>;
function applySpec(ir: IRV2, c: Spec | Extract<HistoryCommand, { op: "restoreSpec" }>, fail: Fail): Step {
  const found = need(ir, c.id, fail);
  if (found.tree.kind === "components") fail(`${c.op} on a component main: edit a page node (main components are not supported in E2)`);
  const old = found.node, ref = old.component;
  let interactive: InteractiveSpec | undefined, overrides = ref?.overrides;
  if (c.op === "restoreSpec") { interactive = c.interactive; overrides = c.overrides ?? overrides; }
  else if (c.op === "updateComponent") {
    if (!old.interactive) return fail(`node ${old.id} has no interactive`);
    interactive = guard(() => patchSpec(old.interactive!, c.patch), fail);
    if (ref?.role === "instance") overrides = [...new Set([...(ref.overrides ?? []), ...Object.keys(c.patch).map((k) => `interactive.${k}`)])];
  } else if (c.op === "convertToComponent") {
    if (old.interactive) return fail(`node ${old.id} already holds a ${old.interactive.kind}`);
    interactive = guard(() => specFromRoles(c.kind, c.roles), fail);
    if (ref?.role === "instance") overrides = [...new Set([...(ref.overrides ?? []), "interactive"])];
  } else {
    if (!old.interactive) return fail(`node ${old.id} has no interactive`);
    overrides = ref?.overrides?.filter((p) => !p.startsWith("interactive"));
  }
  const { interactive: _was, ...rest } = old;
  const node: IRNodeV2 = { ...rest, ...(interactive && { interactive }), ...(ref && { component: { ...ref, ...(overrides && { overrides }) } }) };
  const inverse: HistoryCommand = { op: "restoreSpec", id: old.id, ...(old.interactive && { interactive: old.interactive }), ...(ref?.overrides && { overrides: ref.overrides }) };
  return { ir: withRoot(ir, found.tree, update(rootOf(ir, found.tree), old.id, () => node)!), inverse };
}

// E2 §2: a node holding a role (slide, trigger, panel…) leaves only with its component (removeComponentItem /
// unwrapComponent); the whole component (its root in the subtree) may go.
const ROLE_LABEL: Record<Role, string> = { viewport: "viewport", track: "track", slide: "slide", prev: "nút prev", next: "nút next", pagination: "pagination", tab: "tab", panel: "panel", trigger: "trigger", dialog: "dialog", close: "nút đóng", video: "video" };
function guardRoles(ir: IRV2, c: Extract<Plain, { op: "createNode" | "moveNode" | "deleteNode" | "duplicateNode" }>, fail: Fail): void {
  const members = roleIndex(ir);
  if (!members.size) return;
  if (c.op === "createNode" || c.op === "duplicateNode") {
    const track = (members.get(c.parentId) ?? []).find((m) => m.role === "track");
    if (track) fail(`node ${c.parentId} là track của carousel ${track.root}: dùng addComponentItem`);
    return;
  }
  const subtree = new Set(preorder(need(ir, c.id, fail).node).map((x) => x.id));
  for (const id of subtree) for (const m of members.get(id) ?? []) {
    if (subtree.has(m.root)) continue;
    fail(`node ${id} đang là ${ROLE_LABEL[m.role]} của ${m.spec.kind} ${m.root}: dùng ${c.op === "moveNode" ? "moveComponentItem" : "removeComponentItem hoặc unwrapComponent"}`);
  }
}
```

Nối: `applyTree` gọi `guardRoles(ir, c, fail)` cho `createNode | moveNode | deleteNode | duplicateNode` (không cho `restoreNode`); `copy` trong `duplicateNode`: `const copy = ({ box: _box, interactive: _i, ...n }: IRNodeV2): IRNodeV2 => ...`. `applyOne`: `case "updateComponent": case "convertToComponent": case "unwrapComponent": case "restoreSpec": return applySpec(ir, c, fail);`. `prepareCommands`: ba case chuẩn hoá chép đúng field (`patch` chép nông, `roles` chép nông). `applyCommands`: sau mỗi bước `if (hasInteractive(current)) guard(() => checkInteractives(current), failer(i, command));` với `hasInteractive` là một lần duyệt có điểm dừng sớm.

Route zod (thêm vào `command`):

```ts
  z.strictObject({ op: z.literal("updateComponent"), id: nodeId, patch: z.record(z.string(), z.unknown()) }),
  z.strictObject({ op: z.literal("convertToComponent"), id: nodeId, kind: z.enum(["carousel", "tabs", "accordion", "modal", "dropdown", "menu", "video"]), roles: z.record(z.string(), z.unknown()) }),
  z.strictObject({ op: z.literal("unwrapComponent"), id: nodeId }),
```

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run tests/unit/ir-command-interactive.test.ts tests/unit/ir-command.test.ts tests/unit/ir-component.test.ts tests/unit/ir-store.test.ts tests/unit/editor-api.test.ts tests/unit/grapes-adapter.test.ts tests/unit/qa-fix.test.ts; npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/ir-command.ts src/core/interactive.ts "src/app/api/projects/[id]/editor/commands/route.ts" tests/unit/ir-command-interactive.test.ts tests/unit/editor-api.test.ts
git commit -m "feat(e2): updateComponent / convertToComponent / unwrapComponent with exact inverses; tree commands refuse to break a component" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Command B — thêm / xoá / đổi thứ tự item, alias AI

**Files:**
- Modify: `src/core/ir-command.ts` (union + `applyItems` + `restoreItems` + chuẩn hoá alias), `src/core/interactive.ts` (`itemsOf`, `withItem`, `withoutItem`, `withItemMoved`), `src/app/api/projects/[id]/editor/commands/route.ts`
- Test: `tests/unit/ir-command-interactive.test.ts` (thêm), `tests/unit/editor-api.test.ts` (thêm)

**Interfaces:**
- Consumes: Task 10 `applySpec`, `guardRoles`, fixture test; E1 `insert`, `checkSubtree`, `checkFreshIds`.
- Produces:

```ts
// EditorCommand
| { op: "addComponentItem"; id: string; from?: string; index: number }
| { op: "removeComponentItem"; id: string; itemId: string }
| { op: "moveComponentItem"; id: string; itemId: string; index: number }
| { op: "updateCarousel"; id: string; patch: Record<string, unknown> }               // alias -> updateComponent (carousel only)
| { op: "addCarouselSlide"; id: string; from?: string; index: number }              // alias -> addComponentItem
| { op: "removeCarouselSlide"; id: string; itemId: string }                         // alias -> removeComponentItem
// NormalizedCommand: addComponentItem gains `newIds: string[]` (preorder of the copied nodes, like duplicateNode)
// HistoryCommand (private)
| { op: "restoreItems"; id: string; interactive: InteractiveSpec; remove: string[]; insert: { parentId: string; index: number; node: IRNodeV2 }[]; order: { parentId: string; ids: string[] }[] }
// interactive.ts
export type Item = { id: string; nodes: string[] };   // id: slide id / trigger id; nodes: DOM nodes moved/removed with it (slide | container | trigger+panel)
export function itemsOf(spec: InteractiveSpec, parentOf: (id: string) => string | undefined, rootId: string): Item[]; // [] for modal/dropdown/menu/video
```

Container rule: trigger và panel cùng cha, cha khác gốc và không chứa trigger của item khác → item là cha đó (vd. `<details>`); ngược lại item = [trigger, panel] trong cha riêng của mỗi cái.

- [ ] **Step 1: Viết test đỏ**

```ts
const texted = (): IRV2 => {
  const ir = fixture();
  node(ir, "s0")!.children = [n("s0t", "#text", [], { text: "A", parentId: "s0" }), n("s0i", "img", [], { attrs: { src: "https://x.test/a.png", alt: "a" }, parentId: "s0" })];
  node(ir, "s1")!.children = [n("s1t", "#text", [], { text: "B", parentId: "s1" })];
  return ir;
};
const slides = (ir: IRV2) => (node(ir, "root")!.interactive as CarouselSpec).slides;

test("addComponentItem: blank slide (text/img emptied) or a duplicate of `from`; server ids; active follows; Undo/Redo exact", () => {
  const ir = texted();
  const forward = prepareCommands(ir, [{ op: "addComponentItem", id: "root", index: 0 }], ids());
  const done = applyCommands(ir, forward);
  expect(slides(done.ir)).toEqual(["new1", "s0", "s1"]);
  expect(node(done.ir, "new1")!.children.map((c) => [c.tag, c.text, c.attrs.src])).toEqual([["#text", "", undefined], ["img", undefined, undefined]]);
  expect(applyCommands(done.ir, done.inverse).ir).toEqual(ir);
  expect(applyCommands(applyCommands(done.ir, done.inverse).ir, forward).ir).toEqual(done.ir); // redo: same ids
  const dup = run(texted(), [{ op: "addComponentItem", id: "root", from: "s1", index: 2 }]).ir;
  expect(node(dup, slides(dup)[2]!)!.children[0]!.text).toBe("B");
  const moved = run(texted(), [{ op: "updateComponent", id: "root", patch: { active: 1 } }, { op: "addComponentItem", id: "root", index: 0 }]).ir;
  expect((node(moved, "root")!.interactive as CarouselSpec).active).toBe(2);
});

test("tabs/accordion items: trigger + panel copied (no duplicate html ids); <details> container copied as one", () => {
  const ir = fixture();
  node(ir, "tabs")!.interactive = { kind: "tabs", source: "aria", confidence: "guessed", tabs: [{ trigger: "t1", panel: "p1" }], active: 0 };
  node(ir, "t1")!.attrs = { id: "tab-1", "aria-controls": "panel-1" };
  const out = run(ir, [{ op: "addComponentItem", id: "tabs", from: "t1", index: 1 }]).ir;
  const tabs = (node(out, "tabs")!.interactive as InteractiveSpec & { tabs: { trigger: string; panel: string }[] }).tabs;
  expect(tabs).toHaveLength(2);
  expect(node(out, tabs[1]!.trigger)!.attrs).toEqual({});
  expect(node(out, "tabs")!.children.map((c) => c.id)).toEqual(["t1", tabs[1]!.trigger, "p1", tabs[1]!.panel]);
});

test("removeComponentItem: active adjusts, the last item cannot go, Undo puts the node back at its place", () => {
  const ir = run(texted(), [{ op: "updateComponent", id: "root", patch: { active: 1 } }]).ir;
  const { ir: out, inverse } = applyCommands(ir, prepareCommands(ir, [{ op: "removeComponentItem", id: "root", itemId: "s0" }], ids()));
  expect(slides(out)).toEqual(["s1"]);
  expect((node(out, "root")!.interactive as CarouselSpec).active).toBe(0);
  expect(applyCommands(out, inverse).ir).toEqual(ir);
  expect(() => run(out, [{ op: "removeComponentItem", id: "root", itemId: "s1" }])).toThrow(/last item/);
});

test("moveComponentItem: spec and DOM reorder together, hidden loop clones keep their slots, active follows its item", () => {
  const ir = texted();
  node(ir, "tr")!.children = [n("clone", "div", [], { hidden: true, parentId: "tr" }), ...node(ir, "tr")!.children];
  const out = roundTrip(ir, [{ op: "moveComponentItem", id: "root", itemId: "s0", index: 1 }]).ir;
  expect(slides(out)).toEqual(["s1", "s0"]);
  expect(node(out, "tr")!.children.map((c) => c.id)).toEqual(["clone", "s1", "s0"]);
  expect((node(out, "root")!.interactive as CarouselSpec).active).toBe(1);
});

test("limits and instances: 100 items max; item commands on an instance are refused; aliases normalize", () => {
  const big = texted();
  const hundred = Array.from({ length: 100 }, (_, i) => n(`k${i}`, "div", [], { parentId: "tr" }));
  node(big, "tr")!.children = hundred;
  (node(big, "root")!.interactive as CarouselSpec).slides = hundred.map((x) => x.id);
  expect(() => run(big, [{ op: "addComponentItem", id: "root", index: 0 }])).toThrow(/100/);
  const inst = texted();
  node(inst, "root")!.component = { id: "c", role: "instance", sourceId: "m", overrides: ["interactive"] };
  expect(() => run(inst, [{ op: "removeComponentItem", id: "root", itemId: "s0" }])).toThrow(/main|detach/);
  expect(prepareCommands(texted(), [{ op: "addCarouselSlide", id: "root", index: 0 }], ids())[0]).toMatchObject({ op: "addComponentItem" });
  expect(() => prepareCommands(texted(), [{ op: "updateCarousel", id: "dlg", patch: { closeOn: [] } }], ids())).toThrow(/carousel/);
});
```

`tests/unit/editor-api.test.ts` thêm:

```ts
test("commands route: item ops and carousel aliases pass zod (the core judges them); restoreItems is refused", async () => {
  const id = await seed();
  const doc = await projectDocuments(getDb()).loadDocument(id);
  const root = doc.sections[0]!.root.id;
  for (const command of [{ op: "addCarouselSlide", id: root, index: 0 }, { op: "moveComponentItem", id: root, itemId: root, index: 0 }, { op: "removeComponentItem", id: root, itemId: root }]) {
    const res = await post(commandsRoute, id, { baseRevision: doc.revision, commands: [command] });
    expect(((await res.json()) as { code: string }).code).toBe("IR_PATCH_INVALID");
  }
  const bad = await post(commandsRoute, id, { baseRevision: doc.revision, commands: [{ op: "restoreItems", id: root }] });
  expect(((await bad.json()) as { code: string }).code).toBe("VALIDATION");
});
```

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run tests/unit/ir-command-interactive.test.ts`
Expected: FAIL — `addComponentItem: unknown command`.

- [ ] **Step 3: Implement**

`interactive.ts`:

```ts
export type Item = { id: string; nodes: string[] };
export function itemsOf(spec: InteractiveSpec, parentOf: (id: string) => string | undefined, rootId: string): Item[] {
  if (spec.kind === "carousel") return spec.slides.map((s) => ({ id: s, nodes: [s] }));
  const pairs = spec.kind === "tabs" ? spec.tabs : spec.kind === "accordion" ? spec.items : [];
  const triggers = new Set(pairs.map((x) => x.trigger));
  return pairs.map((x) => {
    const box = parentOf(x.trigger);
    const own = box && box !== rootId && box === parentOf(x.panel) && pairs.every((o) => o === x || parentOf(o.trigger) !== box) && !triggers.has(box);
    return { id: x.trigger, nodes: own ? [box!] : [x.trigger, x.panel] };
  });
}
// pure spec edits; `active` (carousel/tabs) keeps pointing at the same item, remove clamps it (E2 §6)
type Entry = string | { trigger: string; panel: string; open?: boolean };
const entries = (spec: InteractiveSpec): Entry[] =>
  spec.kind === "carousel" ? spec.slides : spec.kind === "tabs" ? spec.tabs : spec.kind === "accordion" ? spec.items : invalid(`${spec.kind} has no items`);
const keyOfEntry = (x: Entry) => (typeof x === "string" ? x : x.trigger);
const withEntries = (spec: InteractiveSpec, list: Entry[], active?: number): InteractiveSpec => parseSpec({
  ...spec, ...(spec.kind === "carousel" ? { slides: list } : spec.kind === "tabs" ? { tabs: list } : { items: list }), ...(active !== undefined && { active }),
});
const activeOf = (spec: InteractiveSpec) => (spec.kind === "carousel" || spec.kind === "tabs" ? spec.active : undefined);
const at = (list: Entry[], itemId: string) => { const i = list.findIndex((x) => keyOfEntry(x) === itemId); return i >= 0 ? i : invalid(`item ${itemId.slice(0, 200)} is not in the component`); };
export function withoutItem(spec: InteractiveSpec, itemId: string): InteractiveSpec {
  const list = [...entries(spec)], i = at(list, itemId), active = activeOf(spec);
  if (list.length === 1) invalid("cannot remove the last item");
  list.splice(i, 1);
  return withEntries(spec, list, active === undefined ? undefined : i < active ? active - 1 : Math.min(active, list.length - 1));
}
export function withItem(spec: InteractiveSpec, index: number, ids: { trigger: string; panel?: string }): InteractiveSpec {
  const list = [...entries(spec)], active = activeOf(spec);
  list.splice(index, 0, spec.kind === "carousel" ? ids.trigger : { trigger: ids.trigger, panel: ids.panel!, ...(spec.kind === "accordion" && { open: false }) });
  return withEntries(spec, list, active === undefined ? undefined : index <= active ? active + 1 : active);
}
export function withItemMoved(spec: InteractiveSpec, itemId: string, index: number): InteractiveSpec {
  const before = entries(spec), list = [...before], i = at(list, itemId), active = activeOf(spec);
  if (!Number.isInteger(index) || index < 0 || index >= list.length) invalid(`index out of range 0..${list.length - 1}`);
  list.splice(index, 0, ...list.splice(i, 1));
  return withEntries(spec, list, active === undefined ? undefined : list.findIndex((x) => keyOfEntry(x) === keyOfEntry(before[active]!)));
}
```

`ir-command.ts`:

```ts
const STRIP_ON_COPY = ["id", "aria-controls", "aria-labelledby", "for"]; // R12: no duplicate html ids
// the subtree(s) an add copies: `from`'s item (a duplicate) or the first item emptied (E2 §6)
function copyItem(nodes: IRNodeV2[], newIds: Iterator<string>, blank: boolean): IRNodeV2[] {
  const copy = ({ box: _b, interactive: _i, component: _c, ...x }: IRNodeV2): IRNodeV2 => ({
    ...x, id: newIds.next().value as string,
    attrs: Object.fromEntries(Object.entries(x.attrs).filter(([k]) => !STRIP_ON_COPY.includes(k) && !(blank && (k === "src" || k === "srcset")))),
    ...(x.tag === "#text" && { text: blank ? "" : x.text ?? "" }),
    children: x.children.map(copy),
  });
  return nodes.map(copy);
}
type ItemCommand = Extract<NormalizedCommand, { op: "addComponentItem" | "removeComponentItem" | "moveComponentItem" }>;
function applyItems(ir: IRV2, c: ItemCommand, fail: Fail): Step {
  const found = need(ir, c.id, fail), spec = found.node.interactive;
  if (!spec) return fail(`node ${c.id} has no interactive`);
  if (found.node.component?.role === "instance") fail(`${c.op} on component instance ${c.id}: sửa ở main hoặc detach trước`);
  const parentOf = (id: string) => find(ir, id)?.parent?.id;
  const items = itemsOf(spec, parentOf, c.id);
  if (!items.length) fail(`${spec.kind} has no items`);
  const snapshot = (pid: string) => ({ parentId: pid, ids: need(ir, pid, fail).node.children.map((x) => x.id) });
  if (c.op === "removeComponentItem") {
    const at = items.findIndex((x) => x.id === c.itemId);
    if (at < 0) fail(`item ${c.itemId} is not in ${c.id}`);
    if (items.length === 1) fail("cannot remove the last item");
    const next = guard(() => withoutItem(spec, c.itemId), fail);
    const insert = items[at]!.nodes.map((id) => { const f = need(ir, id, fail); return { parentId: f.parent!.id, index: f.index, node: f.node }; });
    let out = ir;
    for (const id of items[at]!.nodes) out = removeNode(out, id, fail);
    out = setSpec(out, c.id, next, fail);
    return { ir: out, inverse: { op: "restoreItems", id: c.id, interactive: spec, remove: [], insert, order: [] } };
  }
  if (c.op === "moveComponentItem") {
    const next = guard(() => withItemMoved(spec, c.itemId, c.index), fail);
    const order = [...new Set(items.flatMap((x) => x.nodes.map((id) => parentOf(id)!)))].map(snapshot);
    const after = itemsOf(next, parentOf, c.id);
    let out = ir;
    for (const { parentId } of order) out = reorderSlots(out, parentId, after.flatMap((x) => x.nodes).filter((id) => parentOf(id) === parentId), fail);
    return { ir: setSpec(out, c.id, next, fail), inverse: { op: "restoreItems", id: c.id, interactive: spec, remove: [], insert: [], order } };
  }
  // addComponentItem
  if (items.length >= INTERACTIVE_LIMITS.items) fail(`${spec.kind} already has ${INTERACTIVE_LIMITS.items} items`);
  checkIndex(c.index, items.length, fail);
  const source = c.from === undefined ? items[0]! : items.find((x) => x.id === c.from) ?? fail(`item ${String(c.from)} is not in ${c.id}`);
  const originals = source.nodes.map((id) => need(ir, id, fail).node);
  originals.forEach((x) => checkSubtree(x, fail));
  const copies = copyItem(originals, c.newIds.values(), c.from === undefined);
  // each copy goes before the item at `index` (same parent), or after the last one
  let out = ir;
  for (const [k, copy] of copies.entries()) {
    const anchor = (items[c.index] ?? items[items.length - 1]!).nodes[k]!, f = need(out, anchor, fail);
    out = insert(out, f.parent!.id, c.index < items.length ? f.index : f.index + 1, copy, fail).ir;
  }
  const ids = spec.kind === "carousel" ? { trigger: copies[0]!.id }
    : copies.length === 2 ? { trigger: copies[0]!.id, panel: copies[1]!.id }
    : mapIds(originals[0]!, copies[0]!, pairOf(spec, source.id)); // one container (<details>): same preorder positions
  const next = guard(() => withItem(spec, c.index, ids), fail);
  return { ir: setSpec(out, c.id, next, fail), inverse: { op: "restoreItems", id: c.id, interactive: spec, remove: copies.map((x) => x.id), insert: [], order: [] }, created: copies[0]!.id };
}
```

```ts
const pairOf = (spec: TabsSpec | AccordionSpec, trigger: string) => (spec.kind === "tabs" ? spec.tabs : spec.items).find((x) => x.trigger === trigger)!;
// the copy's trigger/panel sit at the same preorder positions inside the copied container as the originals do
function mapIds(original: IRNodeV2, copy: IRNodeV2, pair: { trigger: string; panel: string }): { trigger: string; panel: string } {
  const from = preorder(original).map((x) => x.id), to = preorder(copy).map((x) => x.id);
  return { trigger: to[from.indexOf(pair.trigger)]!, panel: to[from.indexOf(pair.panel)]! };
}
```

Helper nội bộ (dùng `update`/`withRoot`/`splice`/`insert` hiện có) và inverse:

```ts
const removeNode = (ir: IRV2, id: string, fail: Fail): IRV2 => {
  const f = need(ir, id, fail);
  return withRoot(ir, f.tree, update(rootOf(ir, f.tree), f.parent!.id, (p) => ({ ...p, children: splice(p.children, f.index, 1) }))!);
};
const setSpec = (ir: IRV2, id: string, spec: InteractiveSpec | undefined, fail: Fail): IRV2 => {
  const f = need(ir, id, fail);
  return withRoot(ir, f.tree, update(rootOf(ir, f.tree), id, ({ interactive: _old, ...n }) => (spec ? { ...n, interactive: spec } : n))!);
};
// `ids` take the slots those ids hold now, in the given order; every other child (loop clone, text) keeps its slot
function reorderSlots(ir: IRV2, parentId: string, ids: string[], fail: Fail): IRV2 {
  const p = need(ir, parentId, fail), want = new Set(ids), queue = [...ids];
  const children = p.node.children.map((c) => (want.has(c.id) ? p.node.children.find((x) => x.id === queue.shift())! : c));
  return withRoot(ir, p.tree, update(rootOf(ir, p.tree), parentId, (n) => ({ ...n, children }))!);
}
function restoreItems(ir: IRV2, c: Extract<HistoryCommand, { op: "restoreItems" }>, fail: Fail): Step {
  const bad = () => fail("invalid item restore");
  if (!Array.isArray(c.remove) || !Array.isArray(c.insert) || !Array.isArray(c.order) || !isObject(c.interactive)) return bad();
  const old = need(ir, c.id, fail).node.interactive;
  const removed = c.remove.map((id) => { const f = need(ir, id, fail); return { parentId: f.parent!.id, index: f.index, node: f.node }; });
  const order = c.order.map(({ parentId }) => ({ parentId, ids: need(ir, parentId, fail).node.children.map((x) => x.id) }));
  let out = ir;
  for (const id of c.remove) out = removeNode(out, id, fail);
  for (const x of [...c.insert].sort((a, b) => a.index - b.index)) { checkSubtree(x.node, fail); out = insert(out, x.parentId, x.index, x.node, fail).ir; }
  for (const { parentId, ids } of c.order) {
    const now = need(out, parentId, fail).node.children.map((x) => x.id);
    if (now.length !== ids.length || [...now].sort().join("\u0000") !== [...ids].sort().join("\u0000")) bad();
    out = reorderSlots(out, parentId, ids, fail);
  }
  out = setSpec(out, c.id, c.interactive, fail);
  return { ir: out, inverse: { op: "restoreItems", id: c.id, interactive: old ?? c.interactive, remove: c.insert.map((x) => x.node.id), insert: removed, order } };
}
```

`applyOne`: `case "addComponentItem": case "removeComponentItem": case "moveComponentItem": return applyItems(ir, c, fail); case "restoreItems": return restoreItems(ir, c, fail);`. `prepareCommands`: `addComponentItem` cấp `newIds` = số node preorder của item nguồn (`from` hoặc item đầu) bằng `allocateId`; alias: `updateCarousel` → `updateComponent`, `addCarouselSlide` → `addComponentItem`, `removeCarouselSlide` → `removeComponentItem`, mỗi alias kiểm `interactive.kind === "carousel"` (sai → `fail("updateCarousel needs a carousel")`). Route zod thêm 6 strictObject tương ứng (`index` = `z.number().int().min(0)`, `from: nodeId.optional()`, `itemId: nodeId`).

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run tests/unit/ir-command-interactive.test.ts tests/unit/ir-command.test.ts tests/unit/editor-api.test.ts tests/unit/ir-store.test.ts; npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/ir-command.ts src/core/interactive.ts "src/app/api/projects/[id]/editor/commands/route.ts" tests/unit/ir-command-interactive.test.ts tests/unit/editor-api.test.ts
git commit -m "feat(e2): add / remove / move component items with exact inverses, 100-item cap, carousel aliases" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: AI vòng QA fix — chỉ `updateComponent`

**Files:**
- Modify: `src/core/qa-fix.ts:68-117` (prompt, `commandSchema`, `parseCommands`), `:246-283` (`proposeCommands` thêm `COMPONENTS`)
- Test: `tests/unit/qa-fix.test.ts` (thêm)

**Interfaces:**
- Consumes: Task 10 `updateComponent`, `PATCHABLE`, `cfgOf`.
- Produces: `parseCommands(text: string, allowed: Set<string>, components: Set<string> = new Set()): EditorCommand[]` (gọi cũ 2 tham số giữ nguyên); `componentContext(root: IRNodeV2): { id: string; kind: InteractiveKind; config: Record<string, unknown> }[]` (export, chỉ field `PATCHABLE`, không id list).

- [ ] **Step 1: Viết test đỏ**

```ts
import { componentContext } from "@/core/qa-fix";

test("AI fix: updateComponent only for a component of the section; item / convert / unwrap ops never reach the AI", () => {
  const ok = parseCommands('{"commands":[{"op":"updateComponent","id":"car","patch":{"slidesPerView":{"1440":2}}}]}', new Set(["car", "x"]), new Set(["car"]));
  expect(ok).toEqual([{ op: "updateComponent", id: "car", patch: { slidesPerView: { "1440": 2 } } }]);
  expect(() => parseCommands('{"commands":[{"op":"updateComponent","id":"x","patch":{"speed":1}}]}', new Set(["car", "x"]), new Set(["car"]))).toThrow(/component/);
  for (const op of ["addComponentItem", "removeComponentItem", "moveComponentItem", "convertToComponent", "unwrapComponent", "addCarouselSlide"])
    expect(() => parseCommands(`{"commands":[{"op":"${op}","id":"car","itemId":"s","index":0}]}`, new Set(["car", "s"]), new Set(["car"]))).toThrow();
  const root = { id: "car", tag: "div", type: "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children: [],
    interactive: { kind: "carousel", source: "swiper", confidence: "config", viewport: "car", track: "car", slides: ["s"], active: 0, autoplay: false, interval: 5000, loop: false, direction: "horizontal", transition: "slide", speed: 300, slidesPerView: { "1440": 1 }, gap: {} } } as const;
  const ctx = componentContext(root as never);
  expect(ctx).toEqual([{ id: "car", kind: "carousel", config: expect.objectContaining({ speed: 300, slidesPerView: { "1440": 1 } }) }]);
  expect(JSON.stringify(ctx)).not.toContain('"slides"');
});
```

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run tests/unit/qa-fix.test.ts`
Expected: FAIL — `componentContext` không export / `updateComponent` bị schema từ chối.

- [ ] **Step 3: Implement**

`SYSTEM_PROMPT` thêm dòng (trước "Every id and parentId…"): `{"op":"updateComponent","id":string,"patch":{field:value}} — only for an id listed in COMPONENTS, only its listed config fields (e.g. slidesPerView/gap per "1440"|"768"|"375", speed, direction): fix a visual mismatch, never add/remove/reorder items.` `commandSchema` thêm `z.object({ op: z.literal("updateComponent"), id: nodeId, patch: z.record(z.string(), z.unknown()) })`. `parseCommands(text, allowed, components = new Set<string>())`: sau vòng `outside`, `if (c.op === "updateComponent" && !components.has(c.id)) throw bad(\`updateComponent targets ${c.id}, not a component of the section\`);`. `componentContext(root)`: duyệt subtree, mỗi node có `interactive` → `{ id, kind, config: pick(spec, PATCHABLE[kind]) }` (tối đa 50). `proposeCommands`: thêm dòng `` `COMPONENTS ${JSON.stringify(componentContext(section.root))}` `` vào `text`, gọi `parseCommands(text, collectIds(section.root, new Set()), new Set(componentContext(section.root).map((x) => x.id)))`.

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run tests/unit/qa-fix.test.ts; npx vitest run -c vitest.e2e.config.ts tests/e2e/qa-fixloop.test.ts; npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/qa-fix.ts tests/unit/qa-fix.test.ts
git commit -m "feat(e2): QA fix AI may updateComponent on the section's components (config only, never items)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Panel "Component" + nối editor (canvas `?edit=1`, postMessage)

**Files:**
- Create: `src/app/p/[id]/editor/component-panel/component-panel.tsx`, `component-form.tsx`, `convert-wizard.tsx`, `panel-model.ts`
- Modify: `src/core/interactive.ts` (`panelComponents`), `src/app/api/projects/[id]/editor/route.ts:65` (thêm `components`, `shot`), `src/app/p/[id]/editor/editor-view.tsx:20,53-117,121-137,232-270`, `src/app/globals.css` (sau `.editor-sections`), `docs/superpowers/design/stitch-screens.md` (bảng `/p/[id]/editor`)
- Test: `tests/unit/component-panel-model.test.ts`, `tests/e2e/editor-components.test.ts`

**Interfaces:**
- Consumes: Task 10/11 commands (POST `…/editor/commands`), Task 3 `aiwc:show`, Task 5 `COMPONENT_FEATURE`.
- Produces:

```ts
// interactive.ts
export type PanelComponent = { rootId: string; spec: InteractiveSpec; members: string[]; items: { id: string; label: string; box?: [number, number, number, number] }[]; fidelity?: "supported" | "partial" | "unsupported"; instance: boolean };
export function panelComponents(ir: IRV2, pageId: string): PanelComponent[];
// panel-model.ts (client-safe, pure)
export type PanelDocument = { components: PanelComponent[]; ancestors: string[]; outline: { id: string; label: string; depth: number }[]; shot?: string };
export function componentFor(doc: PanelDocument, selectedId: string | null): PanelComponent | undefined; // the nearest component whose root or member is the node or an ancestor
export function moveCommand(c: PanelComponent, itemId: string, delta: -1 | 1): EditorCommand | undefined;
export function thumbStyle(box: [number, number, number, number] | undefined, shot: string | undefined, size?: number): Record<string, string> | undefined;
// component-panel.tsx
export function ComponentPanel(props: { document: PanelDocument; selectedId: string | null; revision: number; onCommands(commands: EditorCommand[]): void; onShow(rootId: string, index: number): void }): JSX.Element | null;
```

`data-ui` mới (ghi vào `stitch-screens.md`, bảng editor, trạng thái `build`, cột mockup "không có trong mockup, dùng token/component sẵn có"): `ui_editor_component_panel`, `ui_editor_component_header`, `ui_editor_component_items`, `ui_editor_component_item`, `ui_editor_component_form`, `ui_editor_component_unwrap`, `ui_editor_component_convert`, `ui_editor_component_wizard`.

- [ ] **Step 1: Viết test đỏ**

`tests/unit/component-panel-model.test.ts`:

```ts
import { expect, test } from "vitest";
import { componentFor, moveCommand, thumbStyle, type PanelDocument } from "@/app/p/[id]/editor/component-panel/panel-model";
import type { PanelComponent } from "@/core/interactive";

const car = { rootId: "root", members: ["vp", "tr", "s0", "s1", "s2"], instance: false, items: [{ id: "s0", label: "Slide 1" }, { id: "s1", label: "Slide 2" }, { id: "s2", label: "Slide 3" }],
  spec: { kind: "carousel", source: "swiper", confidence: "guessed", viewport: "vp", track: "tr", slides: ["s0", "s1", "s2"], active: 0, autoplay: false, interval: 5000, loop: false, direction: "horizontal", transition: "slide", speed: 300, slidesPerView: {}, gap: {} } } as PanelComponent;
const doc = (ancestors: string[]): PanelDocument => ({ components: [car], ancestors, outline: [] });

test("componentFor: a node inside a slide (or the root itself) finds the carousel; an unrelated node finds none", () => {
  expect(componentFor(doc(["txt", "s1", "tr", "vp", "root", "sec"]), "txt")?.rootId).toBe("root");
  expect(componentFor(doc(["root", "sec"]), "root")?.rootId).toBe("root");
  expect(componentFor(doc(["p", "sec"]), "p")).toBeUndefined();
});

test("moveCommand: ↑/↓ become moveComponentItem within bounds", () => {
  expect(moveCommand(car, "s1", -1)).toEqual({ op: "moveComponentItem", id: "root", itemId: "s1", index: 0 });
  expect(moveCommand(car, "s0", -1)).toBeUndefined();
  expect(moveCommand(car, "s2", 1)).toBeUndefined();
});

test("thumbStyle: a crop of the 1440 shot scaled into the thumbnail box", () => {
  expect(thumbStyle([100, 200, 300, 150], "/shot.png", 48)).toEqual({ backgroundImage: 'url("/shot.png")', backgroundSize: "230.4px auto", backgroundPosition: "-16px -32px", width: "48px", height: "24px" });
  expect(thumbStyle(undefined, "/shot.png")).toBeUndefined();
});
```

`tests/e2e/editor-components.test.ts` (theo khung `editor-smoke.test.ts`: `seedCompleted` chạy pipeline offline trên **site4**, `startNextApp`, Chromium thật):

```ts
// E2 §7: the Component panel over a real site4 clone in the GrapesJS editor of a `next build` app.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type Page } from "playwright";
import { serveDir } from "@/core/serve";
import { offline } from "./offline-deps";
import { startNextApp } from "./next-app";
import { expectUi } from "./ui-checks";

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let site: { url: string; close(): Promise<void> } | undefined;
let db: DatabaseSync | undefined;
let tmp = "";
let projectId = "";

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "editor-components-"));
  const env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  process.env.WORKSPACE_ROOT = env.WORKSPACE_ROOT;
  const [{ openDb }, { createProject, enqueue, runProject }, { settled }] = await Promise.all([import("@/core/db"), import("@/core/jobs"), import("@/core/event-log")]);
  site = await serveDir(fileURLToPath(new URL("../fixtures/site4", import.meta.url)));
  db = openDb(env.DB_PATH);
  projectId = createProject(db, { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0 } });
  await enqueue(db, projectId, [`${site.url}/index.html`]);
  await runProject(db, projectId, { deps: offline });
  await settled(projectId);
  browser = await chromium.launch();
  app = await startNextApp(env);
}, 600_000);
afterAll(async () => { await browser?.close(); await site?.close(); app?.stop(); db?.close(); if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const slideCount = async (base: string) => ((await (await fetch(`${base}/api/projects/${projectId}/files/out/index.html`)).text()).match(/data-c-role="slide"/g) ?? []).length;
const status = (page: Page) => page.getByRole("status");

test("panel: select a slide -> Carousel panel; add, duplicate, delete, reorder; Undo/Redo; reload keeps it; 409 asks to reload", { timeout: 240_000 }, async () => {
  const base = app!.base;
  const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
  await page.goto(`${base}/p/${projectId}/editor`);
  const canvas = page.frameLocator("iframe.gjs-frame");
  await canvas.locator('[data-c="carousel"] [data-c-role="slide"]').first().click();
  const panel = page.locator('[data-ui="ui_editor_component_panel"]');
  await expect.poll(() => panel.isVisible(), { timeout: 30_000 }).toBe(true);
  await expectUi(page, ["ui_editor_component_header", "ui_editor_component_items", "ui_editor_component_form", "ui_editor_component_unwrap"]);
  expect(await panel.innerText()).toMatch(/Carousel/);
  const before = await slideCount(base);
  await panel.getByRole("button", { name: "Thêm" }).click();
  await expect.poll(() => status(page).innerText(), { timeout: 30_000 }).toBe("Đã cập nhật component — điểm QA cần chạy lại");
  expect(await slideCount(base)).toBe(before + 1);
  await panel.getByRole("button", { name: /Nhân bản/ }).first().click();
  await expect.poll(() => slideCount(base), { timeout: 30_000 }).toBe(before + 2);
  await panel.getByRole("button", { name: /Xoá/ }).first().click();
  await expect.poll(() => slideCount(base), { timeout: 30_000 }).toBe(before + 1);
  await panel.getByRole("button", { name: /Xuống/ }).first().click();
  await expect.poll(() => status(page).innerText(), { timeout: 30_000 }).toBe("Đã cập nhật component — điểm QA cần chạy lại");
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await expect.poll(() => status(page).innerText(), { timeout: 30_000 }).toBe("Đã hoàn tác — điểm QA cần chạy lại");
  await page.getByRole("button", { name: "Làm lại" }).click();
  await expect.poll(() => status(page).innerText(), { timeout: 30_000 }).toBe("Đã làm lại — điểm QA cần chạy lại");
  await page.reload();
  await expect.poll(() => slideCount(base), { timeout: 30_000 }).toBe(before + 1);
  // another tab commits first: the panel's next command gets 409 and the editor's "Tải lại" banner
  await canvas.locator('[data-c="carousel"] [data-c-role="slide"]').first().click();
  const { revision } = (await (await fetch(`${base}/api/projects/${projectId}/editor`)).json()) as { revision: number };
  const rootId = (await canvas.locator('[data-c="carousel"]').first().getAttribute("data-ir-id"))!;
  expect((await fetch(`${base}/api/projects/${projectId}/editor/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: revision, commands: [{ op: "updateComponent", id: rootId, patch: { speed: 500 } }] }) })).status).toBe(200);
  await panel.getByRole("button", { name: "Thêm" }).click();
  await expect.poll(() => page.getByRole("button", { name: "Tải lại" }).isVisible(), { timeout: 30_000 }).toBe(true);
  await page.close();
});

test("panel: a plain node offers 'Đánh dấu là component…'; parity — no horizontal scroll at 375 and 1440", { timeout: 120_000 }, async () => {
  for (const width of [375, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`${app!.base}/p/${projectId}/editor`);
    const plain = page.frameLocator("iframe.gjs-frame").locator("section#sw").first(); // wraps the swiper root but is no part of it
    await plain.waitFor({ timeout: 30_000 });
    await plain.click({ position: { x: 4, y: 4 } }); // in the section's 16px padding: selects the section itself
    await expect.poll(() => page.locator('[data-ui="ui_editor_component_convert"]').isVisible(), { timeout: 30_000 }).toBe(true);
    expect(await page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth)).toBe(true);
    await page.close();
  }
});
```

- [ ] **Step 2: Chạy test đỏ**

Run: `npx vitest run tests/unit/component-panel-model.test.ts`
Expected: FAIL — module `component-panel/panel-model` không tồn tại.

- [ ] **Step 3: Implement**

`panelComponents(ir, pageId)` (core, thuần): mỗi gốc có `interactive` trên trang (shell + section của trang) → `members` = id trong `rolesOf`, `items` từ `itemsOf` với `label` = `node.name` ?? text đầu tiên (≤ 40 ký tự) ?? `${KIND_ITEM[kind]} ${k + 1}` ("Slide", "Tab", "Mục"), `box` = `node.box?.[1440]` của item, `fidelity` = status item `component` của gốc trong `ir.fidelity`, `instance` = `component?.role === "instance"`. GET editor: `components: panelComponents(doc, pageId)`, `shot: \`/api/projects/${encodeURIComponent(id)}/files/pages/${encodeURIComponent(pageId)}/shots/1440.png\``.

`panel-model.ts`:

```ts
import type { EditorCommand } from "@/core/ir-command";
import type { PanelComponent } from "@/core/interactive";

export type PanelDocument = { components: PanelComponent[]; ancestors: string[]; outline: { id: string; label: string; depth: number }[]; shot?: string };
export function componentFor(doc: PanelDocument, selectedId: string | null): PanelComponent | undefined {
  if (!selectedId) return undefined;
  for (const id of doc.ancestors) {
    const hit = doc.components.find((c) => c.rootId === id || c.members.includes(id));
    if (hit) return hit;
  }
  return undefined;
}
export function moveCommand(c: PanelComponent, itemId: string, delta: -1 | 1): EditorCommand | undefined {
  const at = c.items.findIndex((x) => x.id === itemId), to = at + delta;
  return at < 0 || to < 0 || to >= c.items.length ? undefined : { op: "moveComponentItem", id: c.rootId, itemId, index: to };
}
export function thumbStyle(box: [number, number, number, number] | undefined, shot: string | undefined, size = 48): Record<string, string> | undefined {
  if (!box || !shot || box[2] <= 0) return undefined;
  const scale = size / box[2];
  return { backgroundImage: `url("${shot}")`, backgroundSize: `${1440 * scale}px auto`, backgroundPosition: `${-box[0] * scale}px ${-box[1] * scale}px`, width: `${size}px`, height: `${Math.min(size, Math.round(box[3] * scale))}px` };
}
```

`component-panel.tsx` (điểm neo; copy tiếng Việt; chỉ `_ui`):

```tsx
"use client";
import { useState } from "react";
import { Badge } from "@/app/_ui/Badge";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { IconButton } from "@/app/_ui/IconButton";
import { ComponentForm } from "./component-form";
import { ConvertWizard } from "./convert-wizard";
import { componentFor, moveCommand, thumbStyle, type PanelDocument } from "./panel-model";
import type { EditorCommand } from "@/core/ir-command";

const KIND: Record<string, string> = { carousel: "Carousel", tabs: "Tabs", accordion: "Accordion", modal: "Modal", dropdown: "Dropdown", menu: "Menu", video: "Video" };
const CONF: Record<string, string> = { config: "cấu hình thư viện", observed: "quan sát", guessed: "suy đoán", manual: "gắn tay" };
const TONE = { supported: "success", partial: "warn", unsupported: "danger" } as const;

// E2 §7: plain React over the document + commands (no GrapesJS import); E3 reuses it as is. Only edit-time state here.
export function ComponentPanel({ document: doc, selectedId, revision: _revision, onCommands, onShow }: { document: PanelDocument; selectedId: string | null; revision: number; onCommands(commands: EditorCommand[]): void; onShow(rootId: string, index: number): void }) {
  const [wizard, setWizard] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const c = componentFor(doc, selectedId);
  if (!selectedId) return null;
  if (!c) return (
    <Card title="Component" data-ui="ui_editor_component_panel">
      {wizard ? <ConvertWizard rootId={selectedId} outline={doc.outline} onCancel={() => setWizard(false)} onSubmit={(cmd) => { setWizard(false); onCommands([cmd]); }} />
        : <Button data-ui="ui_editor_component_convert" onClick={() => setWizard(true)}>Đánh dấu là component…</Button>}
    </Card>
  );
  const add = (from?: string, index = c.items.length) => onCommands([{ op: "addComponentItem", id: c.rootId, index, ...(from && { from }) }]);
  return (
    <Card title="Component" data-ui="ui_editor_component_panel">
      <div className="cmp-head" data-ui="ui_editor_component_header">
        <strong>{KIND[c.spec.kind]}</strong> <span className="text-2">nguồn {c.spec.source} · {CONF[c.spec.confidence]}</span>
        {c.fidelity && <Badge tone={TONE[c.fidelity]}>{c.fidelity === "supported" ? "hỗ trợ" : c.fidelity === "partial" ? "một phần" : "không hỗ trợ"}</Badge>}
        {c.spec.confidence === "guessed" && <p className="t-body-sm text-2">Clone lại để đọc cấu hình thật.</p>}
      </div>
      {c.items.length > 0 && (
        <ol className="cmp-items" data-ui="ui_editor_component_items">
          {c.items.map((item, k) => (
            <li key={item.id} className="cmp-item" data-ui="ui_editor_component_item" draggable={!c.instance}
              onDragStart={() => setDrag(item.id)} onDragOver={(e) => e.preventDefault()}
              onDrop={() => { if (drag && drag !== item.id) onCommands([{ op: "moveComponentItem", id: c.rootId, itemId: drag, index: k }]); setDrag(null); }}>
              <button type="button" className="cmp-item-pick" onClick={() => onShow(c.rootId, k)}>
                <span className="cmp-thumb" style={thumbStyle(item.box, doc.shot)} aria-hidden="true" />
                <span className="ellipsis">{item.label}</span>
              </button>
              <IconButton icon="arrow_upward" label={`Lên: ${item.label}`} onClick={() => { const m = moveCommand(c, item.id, -1); if (m) onCommands([m]); }} disabled={c.instance || k === 0} />
              <IconButton icon="arrow_downward" label={`Xuống: ${item.label}`} onClick={() => { const m = moveCommand(c, item.id, 1); if (m) onCommands([m]); }} disabled={c.instance || k === c.items.length - 1} />
              <IconButton icon="content_copy" label={`Nhân bản: ${item.label}`} onClick={() => add(item.id, k + 1)} disabled={c.instance} />
              <IconButton icon="delete" label={`Xoá: ${item.label}`} onClick={() => onCommands([{ op: "removeComponentItem", id: c.rootId, itemId: item.id }])} disabled={c.instance || c.items.length === 1} />
            </li>
          ))}
        </ol>
      )}
      {c.items.length > 0 && <Button icon="add" onClick={() => add()} disabled={c.instance}>Thêm</Button>}
      {c.instance && <p className="t-body-sm text-2">Instance: sửa danh sách ở main hoặc tách (detach) trước.</p>}
      <ComponentForm component={c} onPatch={(patch) => onCommands([{ op: "updateComponent", id: c.rootId, patch }])} />
      <Button data-ui="ui_editor_component_unwrap" onClick={() => onCommands([{ op: "unwrapComponent", id: c.rootId }])}>Bỏ hành vi</Button>
    </Card>
  );
}
```

(`Button`/`IconButton` nhận `data-ui`, `icon`, `label` như các dùng hiện có; nếu `Button` chưa forward `data-ui` thì bọc phần tử trong `<div data-ui=…>`. Icon mới phải có trong `icons.gen.ts`; nếu thiếu chạy `npm run icons` sau khi thêm tên vào danh sách của `scripts/gen-icons.mjs`.)

`component-form.tsx`: một `<div data-ui="ui_editor_component_form">` với control theo kind, mỗi thay đổi gọi `onPatch({ field: value })`: carousel — checkbox "Tự chạy" + number "Khoảng thời gian (ms)" 1000–60000, checkbox "Lặp", `SegmentedControl` "Hướng" (Ngang/Dọc), `SegmentedControl` "Chuyển cảnh" (Trượt/Mờ dần) + number "Tốc độ (ms)" 0–5000, ba hàng Desktop/Tablet/Mobile cho "Số slide hiển thị" (1–10, bước 0.01) và "Khoảng cách (px)" (0–200) gửi `slidesPerView`/`gap` cả map, checkbox "Mũi tên" (bỏ chọn gửi `arrows: null`; chỉ bật được khi spec đang có), `SegmentedControl` "Pagination" Chấm/Phân số/Tắt; tabs — select "Tab mặc định" → `active`; accordion — checkbox "Cho mở nhiều mục" → `multiple`, checkbox mỗi mục "Mở sẵn" → `items` (giữ trigger/panel); modal — checkbox "Esc", "Bấm nền", "Nút đóng" → `closeOn`; dropdown/menu — `SegmentedControl` "Mở bằng" Click/Hover → `openOn`; video — "Tự chạy", "Tắt tiếng", "Lặp", "Điều khiển" (bật Tự chạy gửi kèm `muted: true`). `convert-wizard.tsx` (`data-ui="ui_editor_component_wizard"`): select kind, rồi chọn vai trò từ `outline` (nút con của node đang chọn, ≤ 100) theo kind; "Tạo component" gửi `{ op: "convertToComponent", id: rootId, kind, roles }`; "Huỷ".

`editor-view.tsx`:
- `type EditorData = GrapesProject & { revision: number; canUndo: boolean; canRedo: boolean; components: PanelComponent[]; shot: string };`
- `grapesjs.init({ ..., canvas: { scripts: [new URL(\`/api/projects/${id}/files/out/js/runtime.js?edit=1\`, window.location.href).href] } })` (R8).
- sau `editorRef.current = editor;`: `editor.on("component:selected", (cmp) => setSelection(selectionOf(cmp)))` và `editor.on("component:deselected", () => setSelection(null))`, với `selectionOf` đi lên `cmp.parent()` gom `getAttributes()["data-ir-id"]` (ancestors) và gom ≤ 100 con cháu `{ id, label: tagName + text ≤ 30, depth }` (outline).
- `const show = (root: string, index: number) => editorRef.current?.Canvas.getWindow()?.postMessage({ type: "aiwc:show", root, index }, "*");`
- `const commands = (list: EditorCommand[]) => run("Đang cập nhật component…", async () => { await requireSaved(); await api(\`/api/projects/${id}/editor/commands\`, { body: { baseRevision: project?.revision, commands: list } }); return "Đã cập nhật component — điểm QA cần chạy lại"; });` (409 đi qua `run` → banner "Tải lại" có sẵn).
- trong `<aside className="stack">` đặt đầu tiên: `{project && <ComponentPanel document={{ components: project.components, ancestors: selection?.ancestors ?? [], outline: selection?.outline ?? [], shot: project.shot }} selectedId={selection?.ancestors[0] ?? null} revision={project.revision} onCommands={(list) => void commands(list)} onShow={show} />}`.

`globals.css`:

```css
.cmp-items { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; max-height: 40vh; overflow: auto; }
.cmp-item { display: grid; grid-template-columns: minmax(0, 1fr) repeat(4, auto); align-items: center; gap: 4px; }
.cmp-item-pick { display: flex; align-items: center; gap: var(--s-sm); min-width: 0; background: none; border: 0; padding: 0; color: inherit; font: inherit; text-align: start; cursor: pointer; }
.cmp-thumb { flex: none; border-radius: 4px; background-color: var(--c-surface-high); background-repeat: no-repeat; width: 48px; height: 32px; }
.cmp-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-sm); }
```

- [ ] **Step 4: Chạy test xanh**

Run: `npx vitest run tests/unit/component-panel-model.test.ts tests/unit/editor-api.test.ts tests/unit/ui-components.test.ts; npm run typecheck; npm run build; npx vitest run -c vitest.e2e.config.ts tests/e2e/editor-components.test.ts tests/e2e/editor-smoke.test.ts`
Expected: PASS, build 0 warning.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/interactive.ts "src/app/api/projects/[id]/editor/route.ts" "src/app/p/[id]/editor/component-panel" "src/app/p/[id]/editor/editor-view.tsx" src/app/globals.css docs/superpowers/design/stitch-screens.md tests/unit/component-panel-model.test.ts tests/e2e/editor-components.test.ts
git commit -m "feat(e2): Component panel (items, per-kind form, convert wizard, unwrap) wired to the editor; canvas runs the runtime in edit mode" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

(Nếu `npm run icons` sinh lại `src/app/_ui/icons.gen.ts`, stage file đó cùng commit.)

---

### Task 14: E2E site4 đầu-cuối, baseline site1–3, parity

**Files:**
- Create: `tests/e2e/site4.test.ts`
- Test: `tests/e2e/qa-baseline.test.ts` (chạy lại, không sửa)

**Interfaces:**
- Consumes: mọi task trước: `capturePage`, `buildIR`, `emitHtml`, `checkBehavior`, `scoreSections`, `withBehavior`, `previewDocument` qua API.
- Produces: không API mới; khoá hành vi end-to-end của spec §12.

- [ ] **Step 1: Viết test (đỏ nếu một mắt xích còn hở)**

```ts
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser, withPage, type BrowserHandle } from "@/core/browser";
import { capturePage, type PageCapture } from "@/core/capture";
import { emitHtml } from "@/core/emit-html";
import { buildIR } from "@/core/ir";
import { rolesOf, type CarouselSpec } from "@/core/interactive";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";
import { checkBehavior } from "@/core/qa-behavior";
import { serveDir } from "@/core/serve";

let handle: BrowserHandle;
let tmp = "";
let ir: IRV2;
let outDir = "";
const servers: { close(): Promise<void> }[] = [];
const all = (doc: IRV2): IRNodeV2[] => { const out: IRNodeV2[] = []; const v = (n: IRNodeV2) => { out.push(n); n.children.forEach(v); }; doc.sections.forEach((s) => v(s.root)); return out; };
const byAttr = (doc: IRV2, name: string, value: string) => all(doc).find((n) => n.attrs[name] === value);

beforeAll(async () => {
  handle = await openBrowser({ headed: false });
  await handle.context.route("https://www.youtube.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<html></html>" }));
  await handle.context.route("https://www.youtube-nocookie.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<html></html>" }));
  tmp = await mkdtemp(join(tmpdir(), "site4-"));
  const site = await serveDir(fileURLToPath(new URL("../fixtures/site4", import.meta.url)));
  servers.push(site);
  const workspaceDir = join(tmp, "ws"), url = `${site.url}/index.html`;
  const meta = await capturePage(handle, { url, pageId: "home", workspaceDir });
  const cap = JSON.parse(await readFile(join(workspaceDir, meta.capturePath), "utf8")) as PageCapture;
  ir = buildIR([cap]);
  outDir = join(tmp, "out");
  await emitHtml(ir, { outDir, workspaceDir, assetMap: cap.assets, pageUrls: { home: url } });
}, 180_000);
afterAll(async () => { await handle.close(); for (const s of servers) await s.close(); await rm(tmp, { recursive: true, force: true }); });

test("site4 clones to the right kinds and confidences", () => {
  // the component whose root, or one of whose parts, is the element with that html id
  const spec = (htmlId: string) => {
    const node = byAttr(ir, "id", htmlId)!;
    return all(ir).find((n) => n.interactive && (n.id === node.id || rolesOf(n.interactive).some(([ref]) => ref === node.id)))?.interactive;
  };
  expect(spec("swiper-a")).toMatchObject({ kind: "carousel", source: "swiper", confidence: "config", loop: true, autoplay: true, interval: 3000, slidesPerView: { "1440": 3, "768": 2, "375": 1 } });
  expect((spec("swiper-a") as CarouselSpec).slides).toHaveLength(4); // duplicates excluded
  expect(spec("swiper-hidden")).toMatchObject({ kind: "carousel", confidence: "observed", autoplay: true });
  expect(spec("slick-a")).toMatchObject({ kind: "carousel", source: "slick", confidence: "config" });
  expect(spec("snap")).toMatchObject({ kind: "carousel", source: "scroll-snap", confidence: "observed" });
  const kinds = all(ir).flatMap((n) => (n.interactive ? [n.interactive.kind] : []));
  for (const kind of ["tabs", "accordion", "modal", "menu", "video"]) expect(kinds).toContain(kind);
  expect(all(ir).find((n) => n.interactive?.kind === "menu")!.interactive).toMatchObject({ openOn: "hover" });
  expect(all(ir).filter((n) => n.interactive?.kind === "video").map((n) => (n.interactive as { mode: string }).mode).sort()).toEqual(["embed", "native"]);
});

test("on the clone: next changes slide, autoplay changes slide, Esc closes the modal, hover opens the menu, a tab switches", { timeout: 60_000 }, async () => {
  const server = await serveDir(outDir);
  servers.push(server);
  await withPage(handle, async (page) => {
    await page.clock.install();
    await page.goto(`${server.url}/index.html`);
    const swiper = page.locator('[data-c="carousel"]').first();
    const start = await swiper.getAttribute("data-c-active");
    await swiper.locator('[data-c-role~="next"]').click();
    expect(await swiper.getAttribute("data-c-active")).not.toBe(start);
    const auto = await swiper.getAttribute("data-c-active");
    await page.mouse.move(0, 0); // hover / focus-within pause autoplay
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.clock.runFor(4500);
    expect(await swiper.getAttribute("data-c-active")).not.toBe(auto);
    await page.click("#open-dlg");
    expect(await page.isVisible("#dlg")).toBe(true);
    await page.keyboard.press("Escape");
    expect(await page.isVisible("#dlg")).toBe(false);
    await page.hover('a[aria-haspopup="true"]');
    expect(await page.isVisible(".has-sub ul")).toBe(true);
    await page.click('[role="tab"]:nth-of-type(2)');
    expect(await page.isVisible("#tp2")).toBe(true);
  });
});

test("behaviour QA passes for every site4 component and lifts its Fidelity item", { timeout: 120_000 }, async () => {
  const { withBehavior } = await import("@/core/fidelity");
  const results = await checkBehavior(handle, { outDir, ir });
  expect(results.filter((r) => !r.ok)).toEqual([]);
  const lifted = withBehavior(ir.fidelity, results).filter((x) => x.feature === "component");
  expect(lifted.length).toBeGreaterThanOrEqual(9);
  expect(lifted.every((x) => x.status === "supported" || x.note.includes("đã kiểm chứng"))).toBe(true);
});
```

- [ ] **Step 2: Chạy test**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/site4.test.ts`
Expected: PASS nếu Task 1–13 đúng; FAIL chỉ ra mắt xích hở (sửa trong file của task sở hữu, thêm test tái hiện vào test file của task đó, commit riêng `fix(e2): …`).

- [ ] **Step 3: Chạy baseline và parity**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/qa-baseline.test.ts tests/e2e/editor-components.test.ts tests/e2e/editor-smoke.test.ts tests/e2e/ui-smoke.test.ts`
Expected: PASS — site1–3 ≥ baseline − 0.001; editor/preview không cuộn ngang ở 375/1440.

- [ ] **Step 4: Chạy toàn bộ cổng**

Run: `npm run typecheck; npm test; npm run build; npm run test:e2e`
Expected: PASS, build 0 warning.

- [ ] **Step 5: Commit**

```bash
git add -- tests/e2e/site4.test.ts
git commit -m "test(e2): site4 end to end — kinds/confidence, runtime on the clone, behaviour QA lifts Fidelity" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Tài liệu, traceability, review cuối

**Files:**
- Modify: `README.md` (mục fixture: `npx serve tests/fixtures/site4 -l 5054   # swiper / slick / scroll-snap / tabs / accordion / modal / dropdown hover / video`; mục an toàn: runtime component, CSP embed, `data-c-cfg`), `docs/superpowers/specs/2026-10-02-e2-interactive-components-design.md` (chỉ thêm phụ lục "Rulings khi triển khai" chép R1–R13 nếu người dùng đồng ý), `.superpowers/visual-editor-handoff.md` (không stage — ghi bàn giao cục bộ)
- Test: không có test mới

**Interfaces:**
- Consumes: toàn bộ.
- Produces: không API mới.

- [ ] **Step 1: Đối chiếu spec**

So từng §2–§12 với code/test: model §2 (Task 1, 2, 10, 11), nhận diện §3 (Task 6, 7, 8), emit/runtime/mode/responsive §4 (Task 2, 3, 4, 8), QA §5 (Task 9, 14), commands §6 (Task 10, 11), panel §7 (Task 13), AI §8 (Task 12), migration §9 (Task 6), giới hạn §10 (bảng Global Constraints, test ở Task 1, 3, 7, 8, 9, 11), an toàn §11 (Task 4, 7, 12), test §12 (Task 3, 4, 7, 9, 13, 14). Kiểm 5 dòng Review Focus có test ở task sở hữu.

- [ ] **Step 2: Traceability graph**

Run: `/graphify explain feat_interaction_scan` rồi `/graphify docs --update`. Nếu CLI báo thiếu API key (như E1), ghi rõ "graph chưa đồng bộ E2" trong bàn giao; không sửa tay `graphify-out/graph.json`.

- [ ] **Step 3: Cổng cuối**

Run: `npm run typecheck; npm test; npm run build; npm run test:e2e; git diff --check; git status --short`
Expected: PASS; `git status` không có `next-env.d.ts`, `passcaptchar/`, `rules.md`, `.playwright-mcp/`, `.superpowers/` trong staged.

- [ ] **Step 4: Review toàn nhánh**

Dispatch một reviewer mới (model mạnh nhất) trên `git diff 0f71994..HEAD`; xử lý issue được xác nhận bằng test tái hiện + commit `fix(e2): …` với trailer. Không push/merge.

- [ ] **Step 5: Commit tài liệu**

```bash
git add -- README.md
git commit -m "docs(e2): site4 fixture, component runtime and embed CSP in the README" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

## Execution gate

Plan cần người dùng review trước khi triển khai. Sau khi duyệt: tạo nhánh `e2-interactive-components` từ `main` (`0f71994` + commit plan), dùng `superpowers:subagent-driven-development` (một subagent mỗi task, reviewer mới trước task kế tiếp, review toàn nhánh ở Task 15). Không bắt đầu Task 1 trong lượt viết plan.
