# E3a Visual Editor Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thay canvas GrapesJS bằng visual editor React chạy thẳng trên IR v2 (E3a = lõi): chọn/hover có overlay, layer tree ảo hoá, sửa chữ trực tiếp, thay ảnh có upload, phím tắt + chọn nhiều + clipboard, đổi breakpoint, cập nhật canvas theo từng section (`affected`), xử lý 409/400/503 — GrapesJS vẫn ở tab "Editor cũ".

**Architecture:** Server giữ nguồn sự thật (IR v2 + History E1). `GET /editor` trả thêm tài liệu canvas của một trang (HTML compile có `data-ir-id`, CSS, cây đã resolve); mỗi batch command / Undo / Redo có `pageId` trả `affected` (section đổi + CSS) để client thay đúng `outerHTML` từng section trong iframe `srcdoc` (sandbox, CSP chỉ cho `runtime.js?edit=1`). Client: `model.ts` (thuần: index cây, layer rows, guard, batch command, clipboard, phím), `inline-text.ts` (thuần), `command-bus.ts` (1 request đang bay, hàng đợi ≤ 20, lạc quan + rollback), các component React (`canvas`, `overlay`, `layer-tree`, `element-panel`, `visual-editor`) chỉ đọc DOM iframe cùng origin và phát command.

**Tech Stack:** TypeScript, Next.js 16 App Router, React 19 (`ref` prop, `flushSync`), Zod 4, `node:sqlite`, Playwright 1.63 (e2e Chromium), Vitest 5. Không thêm dependency.

**Spec:** `docs/superpowers/specs/2026-10-07-e3-visual-editor-design.md` (đã duyệt 2026-10-07; E3a = §1, §2, §4 khung, §5, §6–§9 phần E3a). Nền: `2026-09-27-e1-document-model-design.md`, `2026-10-02-e2-interactive-components-design.md` (§14 rulings), `2026-09-24-sp1-ui-stitch-parity-design.md`, `docs/superpowers/design/stitch-screens.md`, `CLAUDE.md`.

## Global Constraints

- Nhánh `e3-visual-editor` (đã tạo, HEAD `88db810` = commit spec). Làm toàn bộ E3a trên nhánh này; E3b tiếp tục trên cùng nhánh sau Task 14. Không push/merge.
- Chỉ stage file của task bằng `git add -- <paths>`; không bao giờ `git add -A`; không stage `next-env.d.ts`, `passcaptchar/`, `rules.md`, `.playwright-mcp/`, `.superpowers/`. Trailer mọi commit: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Trước Task 1: `/graphify explain feat_editor`, `/graphify explain screen_editor`, `/graphify explain feat_ir`. E3 là phần mở rộng editor SP1 đã duyệt (như E1/E2), không phải SP2/SP3. Không build `drift_*` (mockup Stitch chỉ tham khảo bố cục). Không giải CAPTCHA, không stealth/fingerprint (`rule_no_captcha_bypass`) — E3 không chạm capture.
- Giới hạn cứng (spec §6, chép nguyên): Batch command **50**; Clipboard **1 subtree, ≤ 500 node**; Upload **≤ 25 MB/file; tổng asset ≤ 500 MB/project**; Section thay trên canvas mỗi phản hồi **≤ 20 (vượt thì nạp lại trang)**; Request đang bay **1; hàng đợi ≤ 20 thao tác**; Debounce style **300 ms; gộp Undo trong 1,5 s cùng ô** (E3b); Zoom **25–200%** (E3b); Layer tree **virtualized, render ≤ ~200 dòng**.
- Upload (spec §5): multipart, **một file mỗi request, ≤ 25 MB**; chỉ **png/jpg/webp/gif/svg/avif**, kiểm tra **cả đuôi file lẫn magic bytes**; SVG bỏ `script`, `foreignObject`, thuộc tính `on*`, `href`/`xlink:href` dạng `javascript:`/`data:` (trừ `data:image` raster); lưu tên theo hash vào `assets/`, cập nhật asset map, trả `{ key, url }`; guard loopback/CSRF + `exclusiveEdit`; tổng asset ≤ 500 MB.
- `setName(id, name)`: **1–80 ký tự, trim**, có lệnh đảo ngược, client gửi được (zod union).
- Lỗi (spec §7): 409 STALE / PROJECT_BUSY → huỷ lạc quan, banner "Tải lại"; 400 IR_PATCH_INVALID → hoàn lạc quan, báo lý do tiếng Việt; 503 materialize → giữ trạng thái, cho thử lại; thay section lỗi / iframe lệch → nạp lại trang; hàng đợi đầy → "Đang lưu… chờ chút".
- Bảo mật (spec §8): iframe `sandbox="allow-same-origin allow-scripts"`; chặn điều hướng link/form; không script nào ngoài `runtime.js`; `contenteditable` làm sạch ở client, server kiểm lại (E1); upload kiểm magic bytes + làm sạch SVG, không ghi ngoài `assets/`; không gửi gì ra AI/mạng ngoài; secret không vào editor state.
- `core/` không import `app/`. Thuần (không fs/network/db/Date/random/DOM): `ir-command.ts`, `editor-canvas.ts`, phần `sniffImage`/`sanitizeSvg` của `upload.ts`, và phía client `model.ts`, `inline-text.ts`, `command-bus.ts` (bus nhận transport tiêm vào). Không `Promise.all` trên mảng không bounded (dùng `mapLimit`).
- Client chỉ `import type` từ module server của core (`editor-canvas`, `ir-command`, `ir-v2`, `interactive`, `upload`); value import duy nhất được phép từ core là `@/core/safe-names` (chỉ phụ thuộc zod). Giới hạn server mà client cần được chép thành hằng và test ghim bằng giá trị gốc.
- UI: copy tiếng Việt; dùng `_ui` (`Button`, `IconButton`, `SegmentedControl`, `Banner`, `Badge`, `Card`, `Field`, `SearchInput`, `Icon`) và token Stitch sẵn có; mọi phần tử mới có `data-ui="ui_editor_*"` và một dòng trong `docs/superpowers/design/stitch-screens.md` ghi "không có trong mockup, dùng token/component sẵn có"; không cuộn ngang ở 1440; nút chỉ có icon có `aria-label` + `title`; không render chuỗi drift (`tests/e2e/ui-checks.ts` `DRIFT`, có cả "Figma").
- Mỗi task: test đỏ → code tối thiểu → test xanh → `npm run typecheck` → review diff → commit riêng. Code dưới đây là điểm neo + assertion bắt buộc; edge case thêm vào cùng file test của task.

**Rulings đã chốt khi viết plan (chỗ spec mơ hồ hoặc không khớp code thật):**
- R1 Tên thật trong code: spec §5 viết `emitSectionV2`/`renderSiteV2`, code có `emitSection`/`renderSite`. Thêm `renderSectionsHtml(view, ids, opts)` (compile **một lần** mỗi batch rồi render nhiều section) và `emitSection` dùng lại nó.
- R2 `affected.sections[i] = { id: <sectionId>, html, root }` — `root` là gốc section **đã resolve** để layer tree/panel của client luôn là bản server; `affected.interactives` = `panelComponents(doc, pageId)` cho panel Component. `affected` chỉ có khi body gửi `pageId` (trường tuỳ chọn mới); AI/GrapesJS/caller cũ không đổi.
- R3 Undo/Redo cũng nhận `pageId` tuỳ chọn và trả `affected` (spec §0 "không nạp lại toàn bộ HTML sau mỗi thay đổi").
- R4 Section "bị chạm" = JSON gốc section đã resolve khác nhau trước/sau batch (tên class là hash nội dung nên một sửa style chỉ đổi HTML của chính section đó). Shell / title / meta / thứ tự section đổi, hoặc > 20 section → `shellChanged: true`, `sections: []` (client nạp lại trang). Một main component đổi làm mọi section chứa instance của nó đổi theo đúng quy tắc này.
- R5 Tài liệu canvas do server dựng (`renderCanvasPage`): như trang xuất nhưng `<base href=…/files/out/<page>.html>` ngay sau `<meta charset>`, meta CSP `default-src 'self' data: blob: http: https:; script-src <URL runtime đúng>; style-src 'self' 'unsafe-inline' data: http: https:; object-src 'none'; form-action 'none'; base-uri 'self'`, `<style data-aiwc-css></style>` (CSS thay theo batch) và `<script src=".../runtime.js?edit=1">`. CSS canvas đổi `../assets/` → `assets/` (như `irToGrapes`). Parent gắn sự kiện qua `contentDocument` cùng origin — không chèn script nào vào iframe.
- R6 `GET /editor` thêm `pages`, `page: { id, file, html, shell, sections[] }`, `css`, `fonts`, `effects`, `assets` (≤ 500, chỉ ảnh) bên cạnh payload GrapesJS (giữ cho "Editor cũ" tới E3b).
- R7 Asset map của upload: key `https://upload.aiwc.invalid/<sha256>.<ext>` (http(s) để emitter map được, `.invalid` không bao giờ resolve) ghi vào `<ws>/uploads.json`, gộp vào `emitOpts().assetMap` (canvas, out/, export, graph cùng thấy). Files route phục vụ thêm `assets/<sha64>.<ảnh>` với CSP trơ (`FILE_CSP`) cho thư viện asset.
- R8 CSRF upload: multipart chỉ nhận khi có header `Origin` trùng host (trình duyệt luôn gửi Origin khi POST); body đếm khi stream, trần 25 MB + 64 KB (khung multipart).
- R9 Nút mắt / phím H = một batch `setHidden` + `setStyle(base, display:none)`; hiện lại = `setHidden false` + `display:null` chỉ khi base đang `none` (như adapter GrapesJS — cờ `hidden` một mình không đổi output).
- R10 Layer tree không hiện dòng `#text` (chữ nằm trong nhãn của cha); `setName` trên `#text` bị core từ chối. Dòng section = gốc section, tên = `name` ?? tên section; lệnh cấu trúc của nó dùng id placeholder trong shell (đổi thứ tự / xoá section).
- R11 E3a giữ luật E1 "không chuyển node qua ranh giới section": kéo trong cây sang section khác bị từ chối bằng tiếng Việt; E3b Task 1 gỡ.
- R12 Sửa chữ: cấu trúc inline không đổi → `setText` từng `#text` đổi; cấu trúc đổi mà chỉ còn chữ + `b`/`i`/`a`/`br` → thay con của phần tử trong **một** batch (≤ 50 lệnh); còn phần tử khác (span có style…) → từ chối "Esc để huỷ". `strong`→`b`, `em`→`i`, thẻ lạ bị gỡ vỏ, `href` qua `isSafeAttr`.
- R13 Thay ảnh `img`: `src = key`, xoá `srcset` của nó, và mỗi `<source>` anh em trong `<picture>` nhận `srcset = key` (cùng batch). `source`: `srcset = key`. Nền: `setStyle(<target bp>, background-image: url("<key>"))`.
- R14 Bảng phải E3a: tab Style = card "Phần tử" (tag/tên/kích thước, ảnh + alt, href, Tách khỏi component / Bỏ override cho instance); nhóm Style Manager vào ở E3b. Tab Component = panel E2 nguyên vẹn; tab Hiệu ứng = preset hiện có ghi `setStyle(<target bp>, animation)`. "Edit main" (E1 §4 hứa cho E3) không có trong spec E3 → không build (hỏi người dùng).
- R15 "Editor cũ": `/p/[id]/editor?legacy=1` render `EditorView` GrapesJS như cũ (+ link "Editor mới"); các e2e GrapesJS hiện có chuyển sang URL đó.
- R16 Bus: STALE_REVISION / PROJECT_BUSY / BAD_STATE → rollback mọi thao tác lạc quan (mới nhất trước), bỏ hàng đợi, dừng tới khi Tải lại; IR_PATCH_INVALID / VALIDATION / PAYLOAD_TOO_LARGE / NOTHING_TO_* / NOT_FOUND → rollback đúng thao tác đó, báo lý do, đi tiếp; DOCUMENT_MATERIALIZE_FAILED (500 có `revision`) → bước đã commit: nhận revision, rollback + bỏ hàng đợi, banner "Thử lại" (nạp lại trang → 503 retry); lỗi khác (mạng/5xx) → giữ thao tác ở đầu hàng, dừng, "Thử lại" gửi lại.
- R17 Chuỗi trạng thái dùng lại bản cũ: "Đã lưu — điểm QA cần chạy lại", "Đã hoàn tác — điểm QA cần chạy lại", "Đã làm lại — điểm QA cần chạy lại", "Đã cập nhật component — điểm QA cần chạy lại", stale `Dự án đã thay đổi ở nơi khác (revision N). Tải lại để tiếp tục.`; chỉ báo lưu `Đã lưu`/`Đang lưu…` (không phải `role=status`).
- R18 Nhấp đúp: node chữ → sửa chữ; container → chọn con phần tử đầu tiên (click thường đã chọn node sâu nhất).
- R19 Clipboard giữ một subtree (phần tử chọn đầu tiên), bỏ id/box/component/interactive/behavior và mọi thứ `checkNewNode` từ chối (cây con có tag không an toàn, attr/CSS không an toàn); dán = `createNode` ngay sau phần tử đang chọn (server cấp id mới).
- R20 Thao tác nhiều node: chỉ lấy node "cao nhất" (bỏ con của node đã chọn); duplicate/reorder sắp thứ tự để index vẫn đúng trên IR đang biến đổi trong batch; > 50 lệnh bị từ chối ở client.

**Không khả thi / lệch so với code thật (đã xử lý bằng ruling):** tên hàm §5 (R1); chưa có file asset map riêng cho upload (R7); `hidden` không đổi output (R9); route mutation chỉ nhận JSON (R8); E1 cấm chuyển qua section (R11, gỡ ở E3b).

## Review Focus

1. Chữ capture chứa markup (`<img src=x onerror=…>`) hoặc link `javascript:` trong iframe cùng origin: canvas hiện chữ đã escape, chỉ đúng một `<script>` (runtime), không handler nào chạy; dán HTML vào ô đang sửa chỉ ra chữ thuần (Task 2 unit, Task 8 e2e, Task 12 e2e).
2. Thao tác thứ hai bấm khi thao tác đầu còn đang bay, trong lúc tab khác vừa commit: không thao tác nào gửi với revision cũ đè lên; banner "Tải lại", chữ lạc quan bị hoàn (Task 7 unit, Task 12 e2e).
3. Delete / Ctrl+D / kéo trên slide carousel, trong instance, trên section root hoặc node shell: bị từ chối bằng tiếng Việt trước khi gửi (hoặc 400 → rollback), không bước History nào (Task 5 unit).
4. File đổi đuôi (HTML đặt tên `.png`, PNG đặt tên `.jpg`) hoặc SVG có script: 400 `UPLOAD_INVALID` hoặc bản đã làm sạch; ảnh phục vụ ra trơ (`sandbox` CSP), không ghi ngoài `assets/` (Task 3 unit + route test).
5. Xoá cả một section từ layer tree (đổi shell): `shellChanged` → nạp lại trang, giữ lựa chọn còn tồn tại, không thay một phần trên DOM cũ (Task 2 unit, Task 10 e2e).

## File Structure

| File | Trách nhiệm |
|---|---|
| `src/core/ir-command.ts` | + lệnh `setName` (Edit union, `applyProps`, override path `name`, normalize). |
| `src/core/emit-html.ts` | + `CanvasUrls`, `canvasCsp`, `renderCanvasPage`, `renderCanvasCss`, `renderSectionsHtml`; `renderPage` nhận tuỳ chọn canvas; `emitSection` dùng `renderSectionsHtml`. |
| `src/core/editor-canvas.ts` (mới) | Thuần: `canvasPayload`, `affectedOf`, `pageSectionIds`, `pageFonts`, `pageEffects`, type `CanvasPage`/`CanvasPayload`/`Affected`, `MAX_AFFECTED_SECTIONS`. |
| `src/core/upload.ts` (mới) | `sniffImage`, `sanitizeSvg` (thuần) + `storeUpload`, `readUploads`, `assetLibrary` (fs); `UPLOAD_ORIGIN`, `LibraryAsset`. |
| `src/core/assets.ts`, `errors.ts`, `jobs.ts` | export `MAX_FILE_BYTES`/`DEFAULT_BUDGET_BYTES`; code `UPLOAD_INVALID`; `emitOpts` gộp `uploads.json`; `editorEmit(db,id)`. |
| `src/app/_server/http.ts` | `readCapped`, `multipartBody`, `handle(req, fn, { body: "multipart" })`, status 413/400 cho mã upload. |
| `src/app/_server/editor.ts` (mới) | `withAffected` (đọc trước/sau dưới `exclusiveEdit`), `canvasUrlsFor(req, id)`. |
| `src/app/api/projects/[id]/editor/{route,commands/route,undo/route,redo/route}.ts` | `pageId` → `affected`; GET thêm payload canvas; zod `setName`. |
| `src/app/api/projects/[id]/assets/route.ts` (mới) | `POST` upload. |
| `src/app/api/projects/[id]/files/[...path]/route.ts` | phục vụ `assets/<sha>.<ảnh>` trơ. |
| `src/app/p/[id]/editor/visual/model.ts` (mới) | Thuần: `indexPage`, `labelOf`, `layerRows`, `rowWindow`, `bands`, chọn, guard, batch, clipboard, `keyAction`, `imageBatch`, `outlineOf`. |
| `src/app/p/[id]/editor/visual/inline-text.ts` (mới) | Thuần: `textBatch` (DOM-like → command). |
| `src/app/p/[id]/editor/visual/command-bus.ts` (mới) | `CommandBus` (1 bay, ≤ 20 chờ, lạc quan/rollback, phân loại lỗi). |
| `src/app/p/[id]/editor/visual/{canvas,overlay,layer-tree,element-panel,visual-editor}.tsx` (mới) | UI. |
| `src/app/p/[id]/editor/page.tsx`, `editor-view.tsx` | `?legacy=1` → GrapesJS; link "Editor mới". |
| `src/app/globals.css` | `.ve*`. |
| `scripts/gen-icons.mjs`, `src/app/_ui/icons.gen.ts`, `tests/unit/icons.test.ts` | +9 icon (74 → 83). |
| `docs/superpowers/design/stitch-screens.md`, spec E3 | dòng `ui_editor_*` mới; §11 rulings E3a. |
| Tests | `tests/unit/{ir-command,editor-canvas,upload,editor-api,editor-model,inline-text,command-bus}.test.ts`, `tests/e2e/{visual-editor,visual-editor-perf}.test.ts`, e2e GrapesJS cũ đổi URL. |

Interface dùng chung (các task sau dùng đúng tên này):

```ts
// src/core/editor-canvas.ts
export const MAX_AFFECTED_SECTIONS = 20;
export type CanvasSection = { id: string; name: string; layoutId?: string; root: IRNodeV2 };
export type CanvasPage = { id: string; file: string; html: string; shell: IRNodeV2; sections: CanvasSection[] };
export type CanvasPayload = { pages: { id: string; path: string }[]; page: CanvasPage; css: string; fonts: string[]; effects: string[] };
export type Affected = { sections: { id: string; html: string; root: IRNodeV2 }[]; css: string; shellChanged: boolean; interactives: PanelComponent[] };
// src/core/upload.ts
export type LibraryAsset = { key: string; url: string; size: number; type: string };
// commands / undo / redo response: EditResult & { affected?: Affected }  (EditResult = ir-store)
// src/app/p/[id]/editor/visual/model.ts
export type Bp = 1440 | 768 | 375;
export type Batch = { commands: EditorCommand[] } | { error: string };
// src/app/p/[id]/editor/visual/command-bus.ts
export type StepResult = { revision: number; createdIds: string[]; canUndo: boolean; canRedo: boolean; affected?: Affected };
```

---

### Task 1: Lệnh `setName`

**Files:**
- Modify: `src/core/ir-command.ts:176-190` (Edit union), `:381-427` (`applyProps`, `overridden`), `:757-766` (`applyOne`), `:798-803` (`prepareCommands`)
- Modify: `src/app/api/projects/[id]/editor/commands/route.ts:309-330` (zod)
- Test: `tests/unit/ir-command.test.ts` (append), `tests/unit/editor-api.test.ts` (append)

**Interfaces:**
- Consumes: `applyProps`, `overridden`, `isOverridePath` (đã có; `name` là override field hợp lệ trong `ir-component.ts` `fields`).
- Produces: `EditorCommand` thêm `{ op: "setName"; id: string; name: string }`; `export const MAX_NAME = 80`. Inverse = `restoreProps` (có sẵn). Trên instance ghi override path `"name"`.

- [ ] **Step 1: Viết test đỏ** — append vào `tests/unit/ir-command.test.ts` (dùng `fixture`, `kids`, `ids`, `roundTrip`, `cardsIr`, `card`, `overridesOf` đã có trong file):

```ts
test("setName trims, holds 1–80 characters, inverts exactly; an instance records a name override; #text and placeholders are refused", () => {
  const ir = fixture();
  const named = roundTrip(ir, [{ op: "setName", id: "a", name: "  Tiêu đề chính  " }]).ir;
  expect(kids(named)[0]!.name).toBe("Tiêu đề chính");
  expect(prepareCommands(ir, [{ op: "setName", id: "a", name: "x".repeat(80) }], ids())).toEqual([{ op: "setName", id: "a", name: "x".repeat(80) }]);
  for (const name of ["", "   ", "x".repeat(81)]) expect(() => prepareCommands(ir, [{ op: "setName", id: "a", name }], ids()), JSON.stringify(name)).toThrow(/1–80/);
  expect(() => applyCommands(ir, [{ op: "setName", id: "a", name: 5 as never }])).toThrow(/string/);
  expect(() => applyCommands(ir, [{ op: "setName", id: "ta", name: "t" }])).toThrow(/#text/);
  expect(() => applyCommands(ir, [{ op: "setName", id: "ph1", name: "t" }])).toThrow(/placeholder/);
  const cards = cardsIr();
  const out = roundTrip(cards, [{ op: "setName", id: "card1", name: "Thẻ giữa" }]).ir;
  expect(overridesOf(out, "card1")).toContain("name");
  expect(card(out, 1).name).toBe("Thẻ giữa");
});
```

Append vào `tests/unit/editor-api.test.ts`:

```ts
test("E3 §5: setName passes zod and commits; a non-string name is a 400 VALIDATION", async () => {
  const id = await seed();
  const root = await rootId(id);
  const ok = await post(commandsRoute, id, { baseRevision: 0, commands: [{ op: "setName", id: root, name: "Đầu trang" }] });
  expect([ok.status, await ok.json()]).toEqual([200, { revision: 1, createdIds: [], canUndo: true, canRedo: false }]);
  expect((await projectDocuments(getDb()).loadDocument(id)).sections[0]!.root.name).toBe("Đầu trang");
  const bad = await post(commandsRoute, id, { baseRevision: 1, commands: [{ op: "setName", id: root, name: 5 }] });
  expect([bad.status, ((await bad.json()) as { code: string }).code]).toEqual([400, "VALIDATION"]);
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `npx vitest run tests/unit/ir-command.test.ts tests/unit/editor-api.test.ts -t "setName"`
Expected: FAIL — `command 0 (setName): unknown command` và route trả 400 `VALIDATION` cho lệnh hợp lệ.

- [ ] **Step 3: Cài đặt**

`src/core/ir-command.ts`:

```ts
export const MAX_NAME = 80; // E3 §5: a layer name, trimmed
type Edit =
  | { op: "setStyle"; id: string; target: StyleTarget; changes: Record<string, string | null> }
  | { op: "setText"; id: string; text: string }
  | { op: "setAttribute"; id: string; name: string; value: string | null }
  | { op: "setHidden"; id: string; hidden: boolean }
  | { op: "setName"; id: string; name: string }
  // ... (giữ nguyên các nhánh còn lại)
```

Trong `applyProps` đổi kiểu tham số thành `Extract<Plain, { op: "setStyle" | "setText" | "setAttribute" | "setHidden" | "setName" | "restoreProps" }>` và thêm nhánh **sau** dòng `else if (found.node.tag === "#text") return fail(...)`:

```ts
  else if (c.op === "setName") {
    if (typeof c.name !== "string") fail("name must be a string");
    const name = c.name.trim();
    if (name.length < 1 || name.length > MAX_NAME) fail(`name must be 1–${MAX_NAME} characters`);
    props = { ...old, name };
  }
```

`overridden`: kiểu tham số `Extract<Edit, { op: "setStyle" | "setText" | "setAttribute" | "setHidden" | "setName" }>`, thêm `else if (c.op === "setName") paths = ["name"];` trước nhánh `setAttribute`.

`applyOne`: `case "setStyle": case "setText": case "setAttribute": case "setHidden": case "setName": case "restoreProps": return applyProps(ir, c, fail);`

`prepareCommands`: `case "setName": normalized = { op: command.op, id: command.id, name: command.name }; break;`

`commands/route.ts`, thêm vào `discriminatedUnion` (sau `setHidden`):

```ts
  z.strictObject({ op: z.literal("setName"), id: nodeId, name: z.string() }),
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/ir-command.test.ts tests/unit/editor-api.test.ts && npm run typecheck`
Expected: PASS, typecheck sạch.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/ir-command.ts "src/app/api/projects/[id]/editor/commands/route.ts" tests/unit/ir-command.test.ts tests/unit/editor-api.test.ts
git commit -m "feat(e3): setName command (trimmed 1-80 chars, instance name override) in the command core and zod union

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Tài liệu canvas và `affected` (lõi thuần)

**Files:**
- Modify: `src/core/emit-html.ts:183-206` (`renderPage`), `:398-406` (`emitSection`), thêm khối "editor canvas"
- Create: `src/core/editor-canvas.ts`
- Test: `tests/unit/editor-canvas.test.ts`

**Interfaces:**
- Consumes: `compileV2`, `pageFileNames`, `renderViewStylesheet`, `makeCtx`/`renderNode`/`renderPage` (private trong emit-html), `resolveComponents`, `panelComponents`, `EFFECT_PRESETS`.
- Produces:

```ts
// emit-html.ts
export type CanvasUrls = { base: string; runtime: string };
export function canvasCsp(runtime: string): string;
export function renderCanvasPage(view: LegacyIR, pageId: string, opts: RenderOpts, urls: CanvasUrls): string;
export function renderCanvasCss(view: LegacyIR, opts: RenderOpts): string;
export function renderSectionsHtml(view: LegacyIR, sectionIds: readonly string[], opts: RenderOpts): Map<string, string>;
// editor-canvas.ts (+ các type ở khối interface chung)
export function pageSectionIds(ir: Pick<IRV2, "pages">, pageId: string): string[];
export function canvasPayload(doc: IRV2, pageId: string, opts: RenderOpts, urls: (file: string) => CanvasUrls, view?: LegacyIR): CanvasPayload;
export function affectedOf(before: IRV2, after: IRV2, pageId: string, opts: RenderOpts): Affected;
export function pageFonts(doc: IRV2): string[];
export function pageEffects(view: LegacyIR): string[];
```

- [ ] **Step 1: Viết test đỏ** — `tests/unit/editor-canvas.test.ts`:

```ts
import { expect, test } from "vitest";
import { affectedOf, canvasPayload, MAX_AFFECTED_SECTIONS, pageSectionIds } from "@/core/editor-canvas";
import { applyCommands } from "@/core/ir-command";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
const SHA = "a".repeat(64);
const doc = (count = 2): IRV2 => {
  const ks = Array.from({ length: count }, (_, i) => i);
  return {
    version: 2, revision: 0,
    pages: [{ id: "pg", path: "/", title: "T", meta: {}, sectionIds: ks.map((i) => `s${i}`), shell: n("html", "html", [n("body", "body", ks.map((i) => n(`ph${i}`, "#section", [], { attrs: { "data-section": `s${i}` } })))]) }],
    sections: ks.map((i) => ({
      id: `s${i}`, pageId: "pg", name: `S${i}`, role: "main", hash: `h${i}`, origin: "capture" as const,
      root: n(`r${i}`, "section", [
        n(`h${i}`, "h2", [n(`t${i}`, "#text", [], { text: i === 0 ? '<img src=x onerror="window.top.__pwned=1">' : `Title ${i}` })],
          { type: "text", styles: { base: { color: "red", "font-family": '"Inter", sans-serif', "background-image": 'url("http://x.test/a.png")' }, bp: {}, state: {}, pseudo: {} } }),
        n(`img${i}`, "img", [], { type: "image", attrs: { src: "http://x.test/a.png" } }),
      ]),
    })),
    layouts: [], components: [], tokens: {},
    cssom: { keyframes: ["@keyframes spin{to{transform:rotate(1turn)}}"], fontFace: ['@font-face{font-family:"Brand Sans";src:url("http://x.test/f.woff2")}'], vars: {} },
    interactions: [], fidelity: [],
  };
};
const opts = { assetMap: { "http://x.test/a.png": `assets/${SHA}.png` }, pageUrls: { pg: "http://x.test/" } };
const files = "http://127.0.0.1:3000/api/projects/p1/files";
const urls = (file: string) => ({ base: `${files}/out/${file}`, runtime: `${files}/out/js/runtime.js?edit=1` });

test("canvas document: based on out/<page>, a meta CSP that lets only the runtime run, one inline stylesheet slot, the edit-mode runtime, data-ir-id kept, text escaped", () => {
  const out = canvasPayload(doc(), "pg", opts, urls);
  const html = out.page.html;
  expect(out.page.file).toBe("index.html");
  const charset = html.indexOf('<meta charset="utf-8">'), base = html.indexOf(`<base href="${files}/out/index.html">`), csp = html.indexOf('http-equiv="Content-Security-Policy"');
  expect(charset).toBeGreaterThan(-1);
  expect(base).toBeGreaterThan(charset);
  expect(csp).toBeGreaterThan(base);
  expect(html).toContain(`script-src ${files}/out/js/runtime.js;`);
  expect(html).toContain("object-src 'none'; form-action 'none'; base-uri 'self'");
  expect(html).toContain("<style data-aiwc-css></style>");
  expect(html.match(/<script/g)).toHaveLength(1);
  expect(html).toContain(`<script src="${files}/out/js/runtime.js?edit=1"></script>`);
  expect(html).not.toContain("css/styles.css");
  expect(html).toContain('data-ir-id="h0"');
  expect(html).toContain(`src="assets/${SHA}.png"`);
  expect(html).toContain("&lt;img src=x onerror=");
  expect(out.css).toContain("color:red");
  expect(out.css).toContain(`url("assets/${SHA}.png")`);
  expect(out.css).not.toContain("../assets/");
  expect(out.page.sections.map((s) => [s.id, s.name, s.root.id])).toEqual([["s0", "S0", "r0"], ["s1", "S1", "r1"]]);
  expect(out.page.shell.id).toBe("html");
  expect(out.fonts).toEqual(["Brand Sans", "Inter"]);
  expect(out.effects).toEqual(expect.arrayContaining(["spin", "sp1-fade-in", "sp1-slide-up"]));
  expect(out.pages).toEqual([{ id: "pg", path: "/" }]);
  expect(pageSectionIds(doc(), "pg")).toEqual(["s0", "s1"]);
  expect(() => canvasPayload(doc(), "nope", opts, urls)).toThrow(/unknown page/);
});

test("affected: a style edit in one section returns only that section (html + resolved root), the new stylesheet and the page's components", () => {
  const before = doc();
  const after = applyCommands(before, [{ op: "setStyle", id: "h1", target: "base", changes: { color: "blue" } }]).ir;
  const a = affectedOf(before, after, "pg", opts);
  expect(a.shellChanged).toBe(false);
  expect(a.sections.map((s) => s.id)).toEqual(["s1"]);
  expect(a.sections[0]!.html.startsWith("<section")).toBe(true);
  expect(a.sections[0]!.html).toContain('data-ir-id="r1"');
  expect(a.sections[0]!.root.children[0]!.styles.base.color).toBe("blue");
  expect(a.css).toContain("color:blue");
  expect(a.css).not.toContain("../assets/");
  expect(a.interactives).toEqual([]);
  expect(affectedOf(before, before, "pg", opts).sections).toEqual([]);
});

test("affected: a shell change (section order) or more than 20 changed sections asks for a page reload", () => {
  const before = doc();
  const moved = applyCommands(before, [{ op: "moveNode", id: "ph1", parentId: "body", index: 0 }]).ir;
  expect(affectedOf(before, moved, "pg", opts)).toMatchObject({ shellChanged: true, sections: [], css: "" });
  const many = doc(MAX_AFFECTED_SECTIONS + 1);
  const restyle = (ks: number[]) => applyCommands(many, ks.map((i) => ({ op: "setStyle" as const, id: `r${i}`, target: "base" as const, changes: { color: "blue" } }))).ir;
  expect(affectedOf(many, restyle([...Array(21).keys()]), "pg", opts)).toMatchObject({ shellChanged: true, sections: [] });
  expect(affectedOf(many, restyle([...Array(20).keys()]), "pg", opts).sections).toHaveLength(20);
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `npx vitest run tests/unit/editor-canvas.test.ts`
Expected: FAIL — `Cannot find module '@/core/editor-canvas'`.

- [ ] **Step 3: Cài đặt**

`src/core/emit-html.ts` — `renderPage` nhận `canvas?: CanvasUrls` (bản xuất không đổi khi không truyền):

```ts
// --- editor canvas (E3 §1, §8) ---------------------------------------------------------------
// The srcdoc frame shares the app origin: its meta CSP lets nothing but the exact runtime URL run (CSP source
// matching ignores the ?edit=1 query), no plugins, no form posts, no foreign <base>.
export type CanvasUrls = { base: string; runtime: string };
export const canvasCsp = (runtime: string): string =>
  `default-src 'self' data: blob: http: https:; script-src ${runtime.split("?")[0]}; style-src 'self' 'unsafe-inline' data: http: https:; object-src 'none'; form-action 'none'; base-uri 'self'`;

function renderPage(page: IR["pages"][number], ctx: Ctx, canvas?: CanvasUrls): string {
  const base = ctx.opts.pageUrls[page.id];
  const embeds = (x: IRNode | undefined): boolean =>
    !!x && (!!x.embed || (x.tag === "#section" ? embeds(ctx.sections.get(x.attrs["data-section"] ?? "")?.root) : x.children.some(embeds)));
  const head = [
    '<meta charset="utf-8">',
    // the canvas resolves assets like out/<page>.html; <base> precedes the CSP so base-uri never blocks it
    ...(canvas ? [`<base href="${escAttr(canvas.base)}">`, `<meta http-equiv="Content-Security-Policy" content="${escAttr(canvasCsp(canvas.runtime))}">`] : []),
    ...(embeds(page.shell) ? [`<meta http-equiv="Content-Security-Policy" content="${EMBED_CSP}">`] : []),
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escText(page.title)}</title>`,
    ...Object.entries(page.meta)
      .filter(([key]) => !HEAD_META_SKIP.has(key))
      .map(([key, content]) => `<meta ${PROPERTY_META.test(key) ? "property" : "name"}="${escAttr(key)}" content="${escAttr(content)}">`),
    canvas ? "<style data-aiwc-css></style>" : '<link rel="stylesheet" href="css/styles.css">',
    canvas ? `<script src="${escAttr(canvas.runtime)}"></script>` : '<script src="js/runtime.js" defer></script>',
  ];
  const body: string[] = [];
  for (const child of page.shell.children) renderNode(child, base, ctx, body);
  return `<!DOCTYPE html>\n<html${renderAttrs(page.shell, base, ctx)}><head>\n${head.join("\n")}\n</head>${body.join("")}</html>\n`;
}

export function renderCanvasPage(view: IR, pageId: string, opts: RenderOpts, urls: CanvasUrls): string {
  const page = view.pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`emit: unknown page ${pageId}`);
  return renderPage(page, makeCtx(view, opts, pageFileNames(view.pages)), urls);
}
// renderViewStylesheet writes asset urls relative to out/css/; the canvas reads its stylesheet inline beside out/<page>
const CSS_ASSET = /\.\.\/(assets\/[0-9a-f]{64}\.[a-z0-9]{1,8})/g;
export const renderCanvasCss = (view: IR, opts: RenderOpts): string => renderViewStylesheet(view, opts).replace(CSS_ASSET, "$1");

// HTML of several sections from one compiled view (the editor's partial update: one compile per batch, R1).
export function renderSectionsHtml(view: IR, sectionIds: readonly string[], opts: RenderOpts): Map<string, string> {
  const ctx = makeCtx(view, opts, pageFileNames(view.pages));
  const out = new Map<string, string>();
  for (const id of sectionIds) {
    const section = ctx.sections.get(id);
    if (!section) throw new Error(`emit: unknown section ${id}`);
    const html: string[] = [];
    renderNode(section.root, opts.pageUrls[section.pageId], ctx, html);
    out.set(id, html.join(""));
  }
  return out;
}
```

`renderView` gọi `renderPage(page, ctx)` như cũ. `emitSection` đổi thân thành `return renderSectionsHtml(compileV2(doc), [sectionId], opts).get(sectionId)!;` (giữ thông báo lỗi "emit: unknown section").

`src/core/editor-canvas.ts`:

```ts
// E3 §1/§5: what the visual editor reads for one page (the canvas document, the resolved page tree, fonts, effects,
// the page list) and the partial update after a step (the sections of that page a batch changed, R2–R4).
// Pure: compile + render, no I/O.
import { compileV2, EFFECT_PRESETS, pageFileNames, renderCanvasCss, renderCanvasPage, renderSectionsHtml, type CanvasUrls, type RenderOpts } from "./emit-html";
import { panelComponents, type PanelComponent } from "./interactive";
import { resolveComponents } from "./ir-component";
import type { LegacyIR } from "./ir-legacy";
import type { IRNodeV2, IRV2 } from "./ir-v2";

export const MAX_AFFECTED_SECTIONS = 20;
const MAX_FONTS = 50;
export type CanvasSection = { id: string; name: string; layoutId?: string; root: IRNodeV2 };
export type CanvasPage = { id: string; file: string; html: string; shell: IRNodeV2; sections: CanvasSection[] };
export type CanvasPayload = { pages: { id: string; path: string }[]; page: CanvasPage; css: string; fonts: string[]; effects: string[] };
export type Affected = { sections: { id: string; html: string; root: IRNodeV2 }[]; css: string; shellChanged: boolean; interactives: PanelComponent[] };

// The sections a page shows, in shell order (its placeholders), each once.
export function pageSectionIds(ir: Pick<IRV2, "pages">, pageId: string): string[] {
  const out: string[] = [];
  const visit = (n: IRNodeV2): void => {
    const ref = n.tag === "#section" ? n.attrs["data-section"] : undefined;
    if (ref && !out.includes(ref)) out.push(ref);
    n.children.forEach(visit);
  };
  const page = ir.pages.find((p) => p.id === pageId);
  if (page) visit(page.shell);
  return out;
}

const sectionsOf = (resolved: IRV2, pageId: string): CanvasSection[] => {
  const byId = new Map(resolved.sections.map((s) => [s.id, s]));
  return pageSectionIds(resolved, pageId).flatMap((sid) => {
    const s = byId.get(sid);
    return s ? [{ id: s.id, name: s.name, ...(s.layoutId !== undefined && { layoutId: s.layoutId }), root: s.root }] : [];
  });
};

export function canvasPayload(doc: IRV2, pageId: string, opts: RenderOpts, urls: (file: string) => CanvasUrls, view: LegacyIR = compileV2(doc)): CanvasPayload {
  const resolved = resolveComponents(doc);
  const page = resolved.pages.find((p) => p.id === pageId);
  if (!page) throw new Error(`canvas: unknown page ${pageId}`);
  const file = pageFileNames(doc.pages).get(pageId)!;
  return {
    pages: doc.pages.map((p) => ({ id: p.id, path: p.path })),
    page: { id: pageId, file, html: renderCanvasPage(view, pageId, opts, urls(file)), shell: page.shell, sections: sectionsOf(resolved, pageId) },
    css: renderCanvasCss(view, opts),
    fonts: pageFonts(doc),
    effects: pageEffects(view),
  };
}

// R4: a section changed when its resolved root differs; the page itself (shell, title, meta, section order) changing or
// more than 20 sections -> the client reloads the page.
export function affectedOf(before: IRV2, after: IRV2, pageId: string, opts: RenderOpts): Affected {
  const a = resolveComponents(before), b = resolveComponents(after);
  const json = (x: unknown) => JSON.stringify(x);
  const interactives = panelComponents(after, pageId);
  const pa = a.pages.find((p) => p.id === pageId), pb = b.pages.find((p) => p.id === pageId);
  const reload: Affected = { sections: [], css: "", shellChanged: true, interactives };
  if (!pa || !pb || json(pa) !== json(pb)) return reload;
  const rootIn = (ir: IRV2, id: string) => ir.sections.find((s) => s.id === id)?.root;
  const changed = pageSectionIds(b, pageId).filter((id) => json(rootIn(a, id)) !== json(rootIn(b, id)));
  if (changed.length > MAX_AFFECTED_SECTIONS) return reload;
  const view = compileV2(after);
  const html = renderSectionsHtml(view, changed, opts);
  return { sections: changed.map((id) => ({ id, html: html.get(id)!, root: rootIn(b, id)! })), css: renderCanvasCss(view, opts), shellChanged: false, interactives };
}

const FAMILY = /font-family\s*:\s*([^;}]+)/gi;
const firstFamily = (value: string) => value.split(",")[0]!.trim().replace(/^["']|["']$/g, "");
// The font families the page knows (@font-face + node styles), for the Style Manager's typography (E3b). Bounded.
export function pageFonts(doc: IRV2): string[] {
  const out = new Set<string>();
  for (const rule of doc.cssom.fontFace) for (const m of rule.matchAll(FAMILY)) out.add(firstFamily(m[1]!));
  const visit = (n: IRNodeV2): void => {
    for (const d of [n.styles.base, ...Object.values(n.styles.bp)]) if (d?.["font-family"]) out.add(firstFamily(d["font-family"]));
    n.children.forEach(visit);
  };
  doc.sections.forEach((s) => visit(s.root));
  doc.pages.forEach((p) => visit(p.shell));
  return [...out].filter(Boolean).sort().slice(0, MAX_FONTS);
}
// captured @keyframes names + the editor presets (the Hiệu ứng tab)
export const pageEffects = (view: LegacyIR): string[] => [
  ...new Set([...view.cssom.keyframes.map((k) => /@keyframes\s+([^\s{]+)/.exec(k)?.[1]).filter((x) => x !== undefined), ...Object.keys(EFFECT_PRESETS)]),
];
```

- [ ] **Step 4: Chạy test, xác nhận xanh** (cả emit cũ không đổi)

Run: `npx vitest run tests/unit/editor-canvas.test.ts tests/unit/emit.test.ts tests/unit/emit-v2.test.ts tests/unit/emit-components.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/emit-html.ts src/core/editor-canvas.ts tests/unit/editor-canvas.test.ts
git commit -m "feat(e3): canvas document (base, CSP, inline css slot, edit runtime) and per-section affected after a batch

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Upload ảnh — lõi, route, asset map

**Files:**
- Create: `src/core/upload.ts`, `src/app/api/projects/[id]/assets/route.ts`
- Modify: `src/core/assets.ts:139-140` (export `MAX_FILE_BYTES`, `DEFAULT_BUDGET_BYTES`), `src/core/errors.ts:28` (`UPLOAD_INVALID`), `src/core/jobs.ts:280-286` (`emitOpts` gộp uploads), `src/app/_server/http.ts:19-32,54-75,107-131`, `src/app/api/projects/[id]/files/[...path]/route.ts:14`
- Test: `tests/unit/upload.test.ts`, `tests/unit/editor-api.test.ts` (append)

**Interfaces:**
- Consumes: `writeFileAtomic`, `writeJsonAtomic`, `fileExists` (`fsx.ts`), `mapLimit`, `isScriptValue`, `exclusiveEdit`, `requireEditable`, `workspaceOf`.
- Produces:

```ts
// src/core/upload.ts
export const UPLOAD_ORIGIN = "https://upload.aiwc.invalid/";
export type ImageKind = "png" | "jpg" | "gif" | "webp" | "avif" | "svg";
export type LibraryAsset = { key: string; url: string; size: number; type: string };
export function sniffImage(bytes: Uint8Array): ImageKind | undefined;
export function sanitizeSvg(text: string): string;                // throws AppError(UPLOAD_INVALID) without <svg>
export async function storeUpload(ws: string, fileName: string, bytes: Uint8Array, budget?: number): Promise<{ key: string; file: string }>;
export async function readUploads(ws: string): Promise<Record<string, string>>;
export async function assetLibrary(ws: string, assetMap: Record<string, string>, urlOf: (file: string) => string): Promise<LibraryAsset[]>;
// src/app/_server/http.ts
export async function multipartBody(req: Request, max: number): Promise<FormData>;
export async function handle(req: Request, fn: () => Promise<Response> | Response, opts?: { body?: "json" | "multipart" }): Promise<Response>;
// POST /api/projects/[id]/assets -> { key: string; url: string }   (url = /api/projects/<id>/files/assets/<sha>.<ext>)
```

- [ ] **Step 1: Viết test đỏ** — `tests/unit/upload.test.ts`:

```ts
import { expect, test } from "vitest";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@/core/errors";
import { assetLibrary, readUploads, sanitizeSvg, sniffImage, storeUpload, UPLOAD_ORIGIN } from "@/core/upload";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPG = Buffer.from("ffd8ffe000104a464946", "hex");
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
const AVIF = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypavif"), Buffer.alloc(4)]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
const codeOf = async (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof AppError ? e.code : String(e)));

test("sniffImage reads png/jpg/gif/webp/avif/svg magic bytes and nothing else", () => {
  expect([PNG, JPG, GIF, WEBP, AVIF, SVG].map(sniffImage)).toEqual(["png", "jpg", "gif", "webp", "avif", "svg"]);
  for (const other of [Buffer.from("<html><body>hi</body></html>"), Buffer.from("%PDF-1.7"), Buffer.alloc(0), Buffer.from("RIFF\0\0\0\0WAVE")]) expect(sniffImage(other)).toBeUndefined();
});

test("sanitizeSvg drops script, foreignObject, on* handlers, javascript:/data: hrefs (keeps data:image raster), DOCTYPE/ENTITY; keeps the drawing", () => {
  const dirty = `<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)">
<script>alert(2)</script><foreignObject><div onclick="x"><script>alert(3)</script></div></foreignObject>
<a href="javascript:alert(4)"><text>link</text></a><a xlink:href=" JaVa&#x09;script:alert(5)"/>
<image href="data:text/html,&lt;b&gt;x"/><image href="data:image/png;base64,AAAA"/>
<animate attributeName="href" values="#a;javascript:alert(6)"/><rect ONMOUSEOVER='y' width="1"/></svg>`;
  const clean = sanitizeSvg(dirty);
  expect(clean).not.toMatch(/<script|foreignObject|onload|onclick|onmouseover|DOCTYPE|ENTITY|data:text|javascript|alert\(/i);
  expect(clean).toContain('<image href="data:image/png;base64,AAAA"/>');
  expect(clean).toContain("<a><text>link</text></a>");
  expect(clean).toContain('<rect width="1"/>');
  expect(clean).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
  expect(() => sanitizeSvg("<html><body></body></html>")).toThrow(/svg/i);
});

test("storeUpload: assets/<sha>.<ext> + uploads.json key, idempotent; extension and bytes must agree; svg sanitized; 25 MB and the project budget hold", async () => {
  const ws = await mkdtemp(join(tmpdir(), "upload-"));
  const a = await storeUpload(ws, "Logo.PNG", PNG);
  expect(a.file).toMatch(/^assets\/[0-9a-f]{64}\.png$/);
  expect(a.key).toBe(`${UPLOAD_ORIGIN}${a.file.slice("assets/".length)}`);
  expect(await readFile(join(ws, a.file))).toEqual(PNG);
  expect(await readUploads(ws)).toEqual({ [a.key]: a.file });
  expect(await storeUpload(ws, "again.png", PNG)).toEqual(a);
  expect((await storeUpload(ws, "photo.jpeg", JPG)).file).toMatch(/\.jpg$/);
  const svg = await storeUpload(ws, "x.svg", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'));
  expect(await readFile(join(ws, svg.file), "utf8")).toBe('<svg xmlns="http://www.w3.org/2000/svg"/>');
  expect(await codeOf(storeUpload(ws, "fake.jpg", PNG))).toBe("UPLOAD_INVALID");
  expect(await codeOf(storeUpload(ws, "page.png", Buffer.from("<html>")))).toBe("UPLOAD_INVALID");
  expect(await codeOf(storeUpload(ws, "x.bmp", PNG))).toBe("UPLOAD_INVALID");
  expect(await codeOf(storeUpload(ws, "bad.svg", Buffer.from([0x3c, 0x73, 0x76, 0x67, 0xff, 0xfe])))).toBe("UPLOAD_INVALID");
  expect(await codeOf(storeUpload(ws, "big.png", Buffer.concat([PNG, Buffer.alloc(25 * 1024 * 1024)])))).toBe("ASSET_TOO_LARGE");
  expect(await codeOf(storeUpload(ws, "g.gif", GIF, 10))).toBe("PROJECT_SIZE_LIMIT");
  expect((await readdir(join(ws, "assets"))).filter((f) => f.includes(".tmp-"))).toEqual([]);
});

test("assetLibrary: image files of the asset map once each (uploads first) with size and type; fonts and missing files are left out", async () => {
  const ws = await mkdtemp(join(tmpdir(), "library-"));
  const up = await storeUpload(ws, "a.png", PNG);
  await writeFile(join(ws, "assets", `${"b".repeat(64)}.woff2`), "font");
  await writeFile(join(ws, "assets", `${"c".repeat(64)}.jpg`), JPG);
  const map = {
    "http://x.test/f.woff2": `assets/${"b".repeat(64)}.woff2`,
    "http://x.test/c.jpg": `assets/${"c".repeat(64)}.jpg`,
    "http://x.test/c2.jpg": `assets/${"c".repeat(64)}.jpg`,
    "http://x.test/gone.png": `assets/${"d".repeat(64)}.png`,
    [up.key]: up.file,
  };
  expect(await assetLibrary(ws, map, (f) => `/files/${f}`)).toEqual([
    { key: up.key, url: `/files/${up.file}`, size: PNG.length, type: "png" },
    { key: "http://x.test/c.jpg", url: `/files/assets/${"c".repeat(64)}.jpg`, size: JPG.length, type: "jpg" },
  ]);
});
```

Append vào `tests/unit/editor-api.test.ts` (thêm `import * as assetsRoute from "@/app/api/projects/[id]/assets/route";` cạnh các import route):

```ts
const upload = (id: string, form: FormData, headers: Record<string, string> = { origin: "http://127.0.0.1" }) =>
  assetsRoute.POST(new Request("http://127.0.0.1/api/projects/x/assets", { method: "POST", body: form, headers }), { params: Promise.resolve({ id }) });
const fileForm = (...files: File[]) => { const f = new FormData(); for (const x of files) f.append("file", x); return f; };
const PNG_BYTES = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

test("E3 §5 upload: one image per request -> { key, url }; served inert; an <img> naming the key is emitted with the local file", async () => {
  const id = await seed();
  const res = await upload(id, fileForm(new File([PNG_BYTES], "logo.png", { type: "image/png" })));
  expect(res.status).toBe(200);
  const { key, url } = (await res.json()) as { key: string; url: string };
  expect(key).toMatch(/^https:\/\/upload\.aiwc\.invalid\/[0-9a-f]{64}\.png$/);
  expect(url).toMatch(new RegExp(`^/api/projects/${id}/files/assets/[0-9a-f]{64}\\.png$`));
  const rel = url.split("/files/")[1]!;
  const served = await getFile(id, ...rel.split("/"));
  expect([served.status, served.headers.get("content-type")]).toEqual([200, "image/png"]);
  expect(served.headers.get("content-security-policy")).toContain("sandbox");
  expect((await getFile(id, "assets", "x.html")).status).toBe(404);
  const root = await rootId(id);
  const created = await post(commandsRoute, id, { baseRevision: 0, commands: [{ op: "createNode", parentId: root, index: 0, draft: { tag: "img", attrs: { src: key, alt: "logo" } } }] });
  expect(created.status).toBe(200);
  expect(await readFile(join(config.workspaceRoot, id, "out", "index.html"), "utf8")).toContain(`src="${rel}"`);
  expect(await readFile(join(config.workspaceRoot, id, "out", rel))).toEqual(PNG_BYTES);
});

test("E3 §5 upload guards: no Origin or a JSON body -> 403; two files, no file, a disguised file -> 400; a busy project -> 409", async () => {
  const id = await seed();
  const png = () => new File([PNG_BYTES], "a.png");
  expect((await upload(id, fileForm(png()), {})).status).toBe(403);
  expect((await upload(id, fileForm(png()), { origin: "http://evil.test" })).status).toBe(403);
  expect((await post(assetsRoute, id, { file: "x" })).status).toBe(403);
  const fake = await upload(id, fileForm(new File(["hello"], "a.png")));
  expect([fake.status, ((await fake.json()) as { code: string }).code]).toEqual([400, "UPLOAD_INVALID"]);
  expect((await upload(id, fileForm(png(), png()))).status).toBe(400);
  expect((await upload(id, new FormData())).status).toBe(400);
  busy.add(id);
  try { expect((await upload(id, fileForm(png()))).status).toBe(409); } finally { busy.delete(id); }
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `npx vitest run tests/unit/upload.test.ts tests/unit/editor-api.test.ts -t "upload|sniff|sanitize|storeUpload|assetLibrary"`
Expected: FAIL — `Cannot find module '@/core/upload'` / `.../assets/route`.

- [ ] **Step 3: Cài đặt**

`src/core/errors.ts`: thêm `UPLOAD_INVALID: "UPLOAD_INVALID",` vào `Codes`. `src/core/assets.ts`: `export const MAX_FILE_BYTES = …; export const DEFAULT_BUDGET_BYTES = …;` (giá trị giữ nguyên).

`src/core/upload.ts`:

```ts
// E3 §5: one uploaded image -> assets/<sha256>.<ext> + uploads.json (the asset map entry the emitter merges, R7).
// The type comes from the extension AND the magic bytes; an SVG is sanitized first; 25 MB per file, 500 MB per project.
// sniffImage / sanitizeSvg are pure; the rest touches only <ws>/assets and <ws>/uploads.json.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_BUDGET_BYTES, MAX_FILE_BYTES } from "./assets";
import { AppError, Codes } from "./errors";
import { fileExists, writeFileAtomic, writeJsonAtomic } from "./fsx";
import { mapLimit } from "./limit";
import { isScriptValue } from "./safe-names";

export const UPLOAD_ORIGIN = "https://upload.aiwc.invalid/"; // http(s) so the emitter maps it; .invalid never resolves
export type ImageKind = "png" | "jpg" | "gif" | "webp" | "avif" | "svg";
export type LibraryAsset = { key: string; url: string; size: number; type: string };
const EXT: Record<string, ImageKind> = { png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", webp: "webp", avif: "avif", svg: "svg" };
const LIBRARY_LIMIT = 500;
const STAT_CONCURRENCY = 8;
const invalid = (message: string): never => { throw new AppError(Codes.UPLOAD_INVALID, message); };

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
export function sniffImage(b: Uint8Array): ImageKind | undefined {
  if (b.length >= 8 && ascii(b, 0, 8) === "\x89PNG\r\n\x1a\n") return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 6 && /^GIF8[79]a$/.test(ascii(b, 0, 6))) return "gif";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "webp";
  if (b.length >= 12 && ascii(b, 4, 8) === "ftyp") {
    const size = Math.min(b.length, ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0 || 12);
    for (let at = 8; at + 4 <= size; at += 4) if (/^avi[fs]$/.test(ascii(b, at, at + 4))) return "avif"; // major + compatible brands
  }
  const head = new TextDecoder().decode(b.subarray(0, 1024)).replace(/^﻿/, "");
  if (/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>/]/i.test(head)) return "svg";
  return undefined;
}

// A tag-level rebuild (no DOM on the server): comments, DOCTYPE/ENTITY and processing instructions dropped (no entity
// expansion), script/foreignObject dropped with their content, on* attributes dropped, href/xlink:href with a
// javascript:/data: URL dropped unless data:image raster, animation values naming javascript: dropped (isScriptValue).
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<\/?[A-Za-z][^\s/>]*(?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|[^<]+|</g;
const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const DROP = new Set(["script", "foreignobject"]);
const RASTER = /^data:image\/(png|jpe?g|gif|webp|avif)[;,]/i;
const decodeRefs = (v: string) => v.replace(/&#x([0-9a-f]+);?/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);?/g, (_, d: string) => String.fromCodePoint(Number(d)));
const quote = (v: string) => v.replace(/&(?!(#\d+|#x[0-9a-f]+|amp|lt|gt|quot|apos);)/gi, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
export function sanitizeSvg(text: string): string {
  const out: string[] = [];
  let skip = 0, sawSvg = false;
  for (const [tok] of text.matchAll(TOKEN)) {
    if (tok.startsWith("<!--") || (tok.startsWith("<!") && !tok.startsWith("<![CDATA[")) || tok.startsWith("<?")) continue;
    if (tok === "<") { if (!skip) out.push("&lt;"); continue; }
    if (!tok.startsWith("<") || tok.startsWith("<![CDATA[")) { if (!skip) out.push(tok); continue; }
    const close = tok.startsWith("</"), self = tok.endsWith("/>");
    const name = /^<\/?([^\s/>]+)/.exec(tok)![1]!, lower = name.toLowerCase();
    if (skip) { if (close) skip--; else if (!self) skip++; continue; }
    if (DROP.has(lower)) { if (!close && !self) skip = 1; continue; }
    if (close) { out.push(`</${name}>`); continue; }
    if (lower === "svg") sawSvg = true;
    const attrs: string[] = [];
    for (const m of tok.slice(name.length + 1).replace(/\/?>$/, "").matchAll(ATTR)) {
      const attr = m[1]!, key = attr.toLowerCase(), raw = m[2] ?? m[3] ?? m[4] ?? "", value = decodeRefs(raw);
      if (key.startsWith("on")) continue;
      const bare = value.replace(/[\u0000- ]/g, "").toLowerCase();
      if ((key === "href" || key === "xlink:href") && (bare.startsWith("javascript:") || bare.startsWith("data:")) && !RASTER.test(value.trim())) continue;
      if (isScriptValue(lower, key, value)) continue;
      attrs.push(` ${attr}="${quote(raw)}"`);
    }
    out.push(`<${name}${attrs.join("")}${self ? "/>" : ">"}`);
  }
  if (!sawSvg) invalid("Tệp .svg không có thẻ <svg>.");
  return out.join("");
}

export async function readUploads(ws: string): Promise<Record<string, string>> {
  const text = await readFile(join(ws, "uploads.json"), "utf8").catch((e: unknown) => {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "{}";
    throw e;
  });
  return JSON.parse(text) as Record<string, string>;
}

async function assetBytes(ws: string): Promise<number> {
  const names = await readdir(join(ws, "assets")).catch(() => [] as string[]);
  const sizes = await mapLimit(names, STAT_CONCURRENCY, async (n) => (await stat(join(ws, "assets", n)).catch(() => null))?.size ?? 0);
  return sizes.reduce((a, b) => a + b, 0);
}

export async function storeUpload(ws: string, fileName: string, bytes: Uint8Array, budget = DEFAULT_BUDGET_BYTES): Promise<{ key: string; file: string }> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new AppError(Codes.ASSET_TOO_LARGE, `Ảnh vượt ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
  const ext = EXT[/\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? ""];
  const kind = sniffImage(bytes);
  if (!ext || kind !== ext) invalid("Chỉ nhận ảnh png/jpg/webp/gif/svg/avif — đuôi file và nội dung phải khớp.");
  let body = Buffer.from(bytes);
  if (kind === "svg") {
    let text = "";
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { invalid("Tệp .svg không phải UTF-8 hợp lệ."); }
    body = Buffer.from(sanitizeSvg(text));
  }
  const sha = createHash("sha256").update(body).digest("hex");
  const file = `assets/${sha}.${kind}`;
  if (!(await fileExists(join(ws, file)))) {
    if ((await assetBytes(ws)) + body.byteLength > budget) throw new AppError(Codes.PROJECT_SIZE_LIMIT, `Tổng asset của project vượt ${Math.round(budget / 1024 / 1024)} MB.`);
    await writeFileAtomic(join(ws, file), body);
  }
  const key = `${UPLOAD_ORIGIN}${sha}.${kind}`;
  const map = await readUploads(ws);
  if (map[key] !== file) await writeJsonAtomic(join(ws, "uploads.json"), { ...map, [key]: file });
  return { key, file };
}

// The editor's asset library (E3 §5 GET): each image file of the asset map once (first key wins, uploads first),
// files still on disk, at most 500. Fonts / media are not offered.
export async function assetLibrary(ws: string, assetMap: Record<string, string>, urlOf: (file: string) => string): Promise<LibraryAsset[]> {
  const byFile = new Map<string, string>();
  const entries = Object.entries(assetMap).sort(([a], [b]) => Number(b.startsWith(UPLOAD_ORIGIN)) - Number(a.startsWith(UPLOAD_ORIGIN)));
  for (const [key, file] of entries) {
    const type = /^assets\/[0-9a-f]{64}\.([a-z]+)$/.exec(file)?.[1];
    if (type && Object.hasOwn(EXT, type) && !byFile.has(file)) byFile.set(file, key);
  }
  const picked = [...byFile].slice(0, LIBRARY_LIMIT);
  const rows = await mapLimit(picked, STAT_CONCURRENCY, async ([file, key]) => {
    const info = await stat(join(ws, file)).catch(() => null);
    return info?.isFile() ? { key, url: urlOf(file), size: info.size, type: file.slice(file.lastIndexOf(".") + 1) } : null;
  });
  return rows.filter((x): x is LibraryAsset => x !== null);
}
```

`src/core/jobs.ts` `emitOpts`:

```ts
async function emitOpts(run: EmitSource): Promise<Pick<RenderOpts, "assetMap" | "pageUrls">> {
  const [captures, uploads] = await Promise.all([loadCaptures(run), readUploads(run.ws)]);
  return {
    // R7: editor uploads (uploads.json) join the captured asset map: canvas, out/, export and graph all map them
    assetMap: Object.assign({}, ...captures.map((c) => c.assets), uploads) as Record<string, string>,
    pageUrls: Object.fromEntries(captures.map((c) => [c.pageId, c.url])),
  };
}
```

`src/app/_server/http.ts` — `STATUS` thêm `UPLOAD_INVALID: 400, ASSET_TOO_LARGE: 413, PROJECT_SIZE_LIMIT: 413`; tách vòng đọc của `jsonBody` thành `readCapped`, thêm `multipartBody`, `guardMutation` có chế độ multipart:

```ts
function guardMutation(req: Request, host: string, body: "json" | "multipart"): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (origin && (!URL.canParse(origin) || new URL(origin).host !== host)) throw new ApiError(403, "FORBIDDEN", "cross-origin request refused");
  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (body === "multipart") {
    // R8: a form post skips the CORS preflight: an upload needs the editor's own Origin (browsers always send it on POST)
    if (!origin) throw new ApiError(403, "FORBIDDEN", "an upload needs the Origin header");
    if (type !== "multipart/form-data") throw new ApiError(403, "FORBIDDEN", "an upload must be multipart/form-data");
    return;
  }
  const hasBody = Number(req.headers.get("content-length") ?? 0) > 0 || req.headers.has("transfer-encoding");
  if (hasBody && type !== "application/json") throw new ApiError(403, "FORBIDDEN", "request body must be application/json");
}

export async function handle(req: Request, fn: () => Promise<Response> | Response, opts: { body?: "json" | "multipart" } = {}): Promise<Response> {
  try {
    guardMutation(req, hostOf(req), opts.body ?? "json");
    return await fn();
  } catch (e) {
    return errorResponse(e);
  }
}

async function readCapped(req: Request, max: number): Promise<Buffer> {
  const tooLarge = new ApiError(413, "PAYLOAD_TOO_LARGE", `request body over ${max} bytes`);
  if (Number(req.headers.get("content-length") ?? 0) > max) throw tooLarge;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  for (let r = await reader?.read(); r && !r.done; r = await reader!.read()) {
    size += r.value.byteLength;
    if (size > max) {
      await reader!.cancel();
      throw tooLarge;
    }
    chunks.push(r.value);
  }
  return Buffer.concat(chunks);
}
// jsonBody: `const text = (await readCapped(req, max)).toString("utf8");` rồi JSON.parse + schema như cũ.
export async function multipartBody(req: Request, max: number): Promise<FormData> {
  const buf = await readCapped(req, max);
  try {
    return await new Response(buf, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    throw new ApiError(400, "VALIDATION", "request body is not valid multipart/form-data");
  }
}
```

`src/app/api/projects/[id]/assets/route.ts`:

```ts
import { MAX_FILE_BYTES } from "@/core/assets";
import { storeUpload } from "@/core/upload";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, multipartBody, requireProject, workspaceOf, type IdCtx } from "@/app/_server/http";
import { exclusiveEdit, requireEditable } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY = MAX_FILE_BYTES + 64 * 1024; // the file + multipart framing

// E3 §5: one image (field `file`) -> assets/<sha>.<ext> + the uploads map; { key (asset map key), url (files route) }.
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    const files = (await multipartBody(req, MAX_BODY)).getAll("file");
    const file = files[0];
    if (files.length !== 1 || typeof file === "string" || !file) throw new ApiError(400, "VALIDATION", "send exactly one file in the `file` field");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const { key, file: rel } = await exclusiveEdit(db, id, () => storeUpload(workspaceOf(id), file.name, bytes));
    return Response.json({ key, url: `/api/projects/${encodeURIComponent(id)}/files/${rel}` });
  }, { body: "multipart" });
}
```

Files route: `const ALLOWED = /^(out|qa)\/.+|^pages\/[^/]+\/shots\/.+|^assets\/[0-9a-f]{64}\.(?:png|jpe?g|gif|webp|avif|svg)$/;` (comment: "R7: the editor's asset library — inert like every non-page file").

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/upload.test.ts tests/unit/editor-api.test.ts tests/unit/assets.test.ts tests/unit/jobs.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/upload.ts src/core/assets.ts src/core/errors.ts src/core/jobs.ts src/app/_server/http.ts "src/app/api/projects/[id]/assets/route.ts" "src/app/api/projects/[id]/files/[...path]/route.ts" tests/unit/upload.test.ts tests/unit/editor-api.test.ts
git commit -m "feat(e3): image upload (ext + magic bytes, sanitized svg, 25 MB / 500 MB caps) into the asset map via uploads.json

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: API — `affected` cho commands/Undo/Redo, payload canvas trong `GET /editor`

**Files:**
- Create: `src/app/_server/editor.ts`
- Modify: `src/core/jobs.ts` (export `editorEmit`), `src/app/api/projects/[id]/editor/route.ts`, `commands/route.ts:331-341`, `undo/route.ts`, `redo/route.ts`
- Test: `tests/unit/editor-api.test.ts` (append)

**Interfaces:**
- Consumes: `affectedOf`, `canvasPayload` (Task 2), `assetLibrary` (Task 3), `DocumentStore.readDocument`, `EditResult`.
- Produces:

```ts
// src/core/jobs.ts
export async function editorEmit(db: DatabaseSync, projectId: string): Promise<Pick<RenderOpts, "assetMap" | "pageUrls">>;
// src/app/_server/editor.ts
export function canvasUrlsFor(req: Request, projectId: string): (file: string) => CanvasUrls;
export async function withAffected(db: DatabaseSync, projectId: string, store: DocumentStore, pageId: string | undefined, step: () => Promise<EditResult>): Promise<EditResult & { affected?: Affected }>;
// body schemas: commands { baseRevision, commands, pageId? }, undo/redo { baseRevision, pageId? }  (pageId: string 1..200)
// GET /editor: { ...irToGrapes, revision, canUndo, canRedo, interactives, shot, ...CanvasPayload, assets: LibraryAsset[] }
```

- [ ] **Step 1: Viết test đỏ** — append `tests/unit/editor-api.test.ts`:

```ts
type AffectedBody = { revision: number; affected: { sections: { id: string; html: string; root: { id: string } }[]; css: string; shellChanged: boolean; interactives: unknown[] } };

test("E3 §5: commands / Undo with pageId return the changed sections (html + resolved root), the stylesheet and the panel components; without it the response is unchanged", async () => {
  const id = await seed();
  const doc = await projectDocuments(getDb()).loadDocument(id);
  const section = doc.sections[0]!, root = section.root.id;
  const res = await post(commandsRoute, id, { baseRevision: 0, pageId: "home", commands: [{ op: "setStyle", id: root, target: "base", changes: { color: "rgb(1, 2, 3)" } }] });
  expect(res.status).toBe(200);
  const body = (await res.json()) as AffectedBody;
  expect(body.revision).toBe(1);
  expect(body.affected.shellChanged).toBe(false);
  expect(body.affected.sections.map((s) => s.id)).toEqual([section.id]);
  expect(body.affected.sections[0]!.html).toContain(`data-ir-id="${root}"`);
  expect(body.affected.sections[0]!.root.id).toBe(root);
  expect(body.affected.css).toContain("color:rgb(1, 2, 3)");
  expect(body.affected.interactives).toEqual([]);
  const undo = (await (await post(undoRoute, id, { baseRevision: 1, pageId: "home" })).json()) as AffectedBody;
  expect(undo.affected.sections.map((s) => s.id)).toEqual([section.id]);
  expect(undo.affected.css).not.toContain("rgb(1, 2, 3)");
  const plain = await post(commandsRoute, id, { baseRevision: 2, commands: [{ op: "setName", id: root, name: "Đầu trang" }] });
  expect(await plain.json()).toEqual({ revision: 3, createdIds: [], canUndo: true, canRedo: false });
  expect((await post(commandsRoute, id, { baseRevision: 3, pageId: "", commands: [{ op: "setName", id: root, name: "x" }] })).status).toBe(400);
  expect((await post(redoRoute, id, { baseRevision: 3, pageId: 7 })).status).toBe(400);
});

test("E3 §5: GET editor adds the canvas page (html + resolved tree), css, fonts, effects, pages and the asset library; the GrapesJS payload stays for Editor cũ", async () => {
  const id = await seed();
  const res = await editorRoute.GET(new Request("http://127.0.0.1/api/projects/x/editor?page=home"), { params: Promise.resolve({ id }) });
  expect(res.status).toBe(200);
  const data = (await res.json()) as { page: { id: string; file: string; html: string; shell: { tag: string }; sections: { id: string; root: { id: string } }[] }; css: string; fonts: string[]; effects: string[]; pages: unknown[]; assets: unknown[]; components: unknown[] };
  expect(data.page.id).toBe("home");
  expect(data.page.file).toBe("index.html");
  expect(data.page.html).toContain(`<base href="http://127.0.0.1/api/projects/${id}/files/out/index.html">`);
  expect(data.page.html).toContain(`<script src="http://127.0.0.1/api/projects/${id}/files/out/js/runtime.js?edit=1"></script>`);
  expect(data.page.html).toContain("<style data-aiwc-css></style>");
  expect(data.page.shell.tag).toBe("html");
  expect(data.page.sections.length).toBeGreaterThan(0);
  expect(data.page.html).toContain(`data-ir-id="${data.page.sections[0]!.root.id}"`);
  expect(typeof data.css).toBe("string");
  expect(data.effects).toEqual(expect.arrayContaining(["sp1-fade-in"]));
  expect([Array.isArray(data.fonts), Array.isArray(data.assets), data.pages.length]).toEqual([true, true, 1]);
  expect(Array.isArray(data.components)).toBe(true); // irToGrapes, for ?legacy=1
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `npx vitest run tests/unit/editor-api.test.ts -t "E3 §5: commands|E3 §5: GET"`
Expected: FAIL — 400 `VALIDATION` (unknown key `pageId`) và `data.page` undefined.

- [ ] **Step 3: Cài đặt**

`src/core/jobs.ts` (cạnh `loadEditable`):

```ts
// The emit options the editor renders its canvas and partial updates with (asset map incl. uploads, page urls).
export async function editorEmit(db: DatabaseSync, projectId: string): Promise<Pick<RenderOpts, "assetMap" | "pageUrls">> {
  return emitOpts(await editSource(db, projectId));
}
```

`src/app/_server/editor.ts`:

```ts
// E3 §5 route helpers: the canvas URLs of a request and a step's result plus the page sections it changed.
import type { DatabaseSync } from "node:sqlite";
import { affectedOf, type Affected } from "@/core/editor-canvas";
import type { CanvasUrls } from "@/core/emit-html";
import type { DocumentStore, EditResult } from "@/core/ir-store";
import { editorEmit } from "@/core/jobs";

// absolute (the srcdoc frame has no URL of its own); handle() already refused a non-loopback Host
export function canvasUrlsFor(req: Request, projectId: string): (file: string) => CanvasUrls {
  const files = `http://${req.headers.get("host") ?? new URL(req.url).host}/api/projects/${encodeURIComponent(projectId)}/files`;
  return (file) => ({ base: `${files}/out/${encodeURIComponent(file)}`, runtime: `${files}/out/js/runtime.js?edit=1` });
}

// Runs under exclusiveEdit: nothing else writes the document between the read before and the read after the step.
// A failed step (stale, invalid, materialize) throws before `affected` is computed.
export async function withAffected(db: DatabaseSync, projectId: string, store: DocumentStore, pageId: string | undefined, step: () => Promise<EditResult>): Promise<EditResult & { affected?: Affected }> {
  if (pageId === undefined) return step();
  const before = await store.readDocument(projectId);
  const result = await step();
  const [after, emit] = await Promise.all([store.readDocument(projectId), editorEmit(db, projectId)]);
  return { ...result, affected: affectedOf(before, after, pageId, emit) };
}
```

`commands/route.ts`:

```ts
const pageId = z.string().min(1).max(200);
const bodySchema = z.strictObject({ baseRevision: z.number().int().min(0), commands: z.array(command).min(1).max(COMMAND_LIMITS.commands), pageId: pageId.optional() });

// One batch = one History step. Stale baseRevision -> 409 {revision}; returns { revision, createdIds, canUndo, canRedo }
// (+ `affected` when the editor names its page, E3 §5).
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { baseRevision, commands, pageId: page } = await jsonBody(req, bodySchema);
    const db = getDb();
    requireEditable(db, requireProject(db, id));
    return Response.json(await exclusiveEdit(db, id, (store) => withAffected(db, id, store, page, () => store.commitCommands(id, baseRevision, commands, "user"))));
  });
}
```

`undo/route.ts` (và `redo/route.ts` y hệt với `redoDocument`):

```ts
const bodySchema = z.strictObject({ baseRevision: z.number().int().min(0), pageId: z.string().min(1).max(200).optional() });
// ...
    const { baseRevision, pageId } = await jsonBody(req, bodySchema);
    // ...
    return Response.json(await exclusiveEdit(db, id, (store) => withAffected(db, id, store, pageId, () => store.undoDocument(id, baseRevision))));
```

`editor/route.ts` GET (thêm import `canvasPayload`, `assetLibrary`, `canvasUrlsFor`, `workspaceOf`):

```ts
    const shot = `/api/projects/${encodeURIComponent(id)}/files/pages/${encodeURIComponent(pageId)}/shots/1440.png`;
    const canvas = canvasPayload(doc, pageId, emit, canvasUrlsFor(req, id), ir); // ir: loadEditable's compiled view
    const assets = await assetLibrary(workspaceOf(id), emit.assetMap, (file) => `/api/projects/${encodeURIComponent(id)}/files/${file}`);
    return Response.json({ ...irToGrapes(ir, pageId, emit), ...(await store.historyState(id)), revision: doc.revision, interactives: panelComponents(doc, pageId), shot, ...canvas, assets });
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/editor-api.test.ts && npm run typecheck`
Expected: PASS (mọi test cũ của file vẫn xanh).

- [ ] **Step 5: Commit**

```bash
git add -- src/core/jobs.ts src/app/_server/editor.ts "src/app/api/projects/[id]/editor/route.ts" "src/app/api/projects/[id]/editor/commands/route.ts" "src/app/api/projects/[id]/editor/undo/route.ts" "src/app/api/projects/[id]/editor/redo/route.ts" tests/unit/editor-api.test.ts
git commit -m "feat(e3): commands/undo/redo return affected sections for the editor's page; GET editor serves the canvas payload

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Model client thuần — cây, layer rows, chọn, guard, batch, clipboard, phím

**Files:**
- Create: `src/app/p/[id]/editor/visual/model.ts`
- Test: `tests/unit/editor-model.test.ts`

**Interfaces:**
- Consumes: type `CanvasPage` (Task 2), `PanelComponent`, `EditorCommand`, `NodeDraft`, `StyleTarget`, `IRNodeV2`; value `isSafeAttr`, `isSafeCss`, `tagSchema` từ `@/core/safe-names`.
- Produces (các task sau dùng đúng tên):

```ts
export type Bp = 1440 | 768 | 375;
export const BPS: readonly Bp[];
export const LIMITS: { batch: 50; clipboard: 500; depth: 20 };
export const GENERATED = "instance:";
export const ROW_HEIGHT = 24; export const MAX_ROWS = 200;
export type Batch = { commands: EditorCommand[] } | { error: string };
export type Entry = { node: IRNodeV2; parent?: string; subject: string; index: number; depth: number; children: string[]; sectionId?: string; sectionName?: string; layout?: boolean; shell: boolean; hidden: boolean };
export type DocIndex = Map<string, Entry>;
export type Row = { id: string; depth: number; label: string; type: IRNodeV2["type"]; section: boolean; hasChildren: boolean; open: boolean; hidden: boolean; dimmed: boolean; role?: "main" | "instance"; kind?: string };
export type Zone = "before" | "after" | "inside";
export type Box = { x: number; y: number; w: number; h: number };
export type Clip = { draft: NodeDraft; count: number };
export type KeyAction = "undo" | "redo" | "delete" | "duplicate" | "hide" | "copy" | "paste" | "up" | "down" | "child" | "parent" | "siblings";
export function indexPage(page: Pick<CanvasPage, "shell" | "sections">): DocIndex;
export function bodyOf(page: Pick<CanvasPage, "shell">): string;
export function labelOf(e: Entry): string;
export function ancestorsOf(index: DocIndex, id: string): string[];            // [id, parent, …]
export function layerRows(index: DocIndex, rootId: string, open: ReadonlySet<string>, query: string, components: readonly PanelComponent[]): Row[];
export function rowWindow(total: number, scrollTop: number, height: number, overscan?: number): { start: number; end: number };
export function bands(box: Box, sides: readonly [number, number, number, number], inside: boolean): Box[];
export function pickTarget(index: DocIndex, id: string): string | undefined;
export function parentOf(index: DocIndex, id: string): string | undefined;      // selectable parent (never html/body)
export function siblingsOf(index: DocIndex, id: string): string[];
export function topMost(index: DocIndex, ids: readonly string[]): string[];
export function isTextHost(node: IRNodeV2): boolean;
export function guard(index: DocIndex, components: readonly PanelComponent[], id: string, op: "delete" | "move" | "duplicate" | "edit"): string | undefined;
export function guardParent(index: DocIndex, components: readonly PanelComponent[], parentId: string): string | undefined;
export function deleteBatch(index: DocIndex, components: readonly PanelComponent[], ids: readonly string[]): Batch;
export function duplicateBatch(index: DocIndex, components: readonly PanelComponent[], ids: readonly string[]): Batch;
export function hideBatch(index: DocIndex, ids: readonly string[], hidden: boolean): Batch;
export function reorderBatch(index: DocIndex, components: readonly PanelComponent[], ids: readonly string[], delta: -1 | 1): Batch;
export function dropCommand(index: DocIndex, components: readonly PanelComponent[], dragId: string, overId: string, zone: Zone): Batch;
export function copyClip(index: DocIndex, id: string): Clip | { error: string };
export function insertAt(index: DocIndex, components: readonly PanelComponent[], afterId: string | undefined): { parentId: string; index: number } | { error: string };
export function pasteBatch(index: DocIndex, components: readonly PanelComponent[], clip: Clip, afterId: string | undefined): Batch;
export function renameBatch(index: DocIndex, id: string, name: string): Batch;
export function styleTarget(bp: Bp, state?: "hover" | "focus" | "active"): StyleTarget;
export function keyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, typing: boolean): KeyAction | undefined;
export function imageBatch(index: DocIndex, id: string, kind: "img" | "source" | "background", key: string, bp: Bp): Batch;
export function outlineOf(index: DocIndex, id: string, max?: number): { id: string; label: string; depth: number }[];
```

- [ ] **Step 1: Viết test đỏ** — `tests/unit/editor-model.test.ts`:

```ts
import { expect, test } from "vitest";
import { COMMAND_LIMITS } from "@/core/ir-command";
import type { PanelComponent } from "@/core/interactive";
import type { IRNodeV2 } from "@/core/ir-v2";
import {
  ancestorsOf, bands, bodyOf, copyClip, deleteBatch, dropCommand, duplicateBatch, guard, hideBatch, imageBatch, indexPage, isTextHost, keyAction,
  labelOf, layerRows, LIMITS, MAX_ROWS, parentOf, pasteBatch, pickTarget, renameBatch, reorderBatch, rowWindow, siblingsOf, styleTarget, topMost,
} from "@/app/p/[id]/editor/visual/model";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const child of children) child.parentId = id;
  return node;
};
const page = () => ({
  shell: n("html", "html", [n("body", "body", [
    n("ph1", "#section", [], { attrs: { "data-section": "s1" } }), n("ph2", "#section", [], { attrs: { "data-section": "s2" } }), n("nav", "nav"),
  ])]),
  sections: [
    { id: "s1", name: "Hero", root: n("r1", "section", [
      n("h", "h1", [n("t", "#text", [], { text: "Xin chào thế giới" })], { type: "text" }),
      n("p", "p", [n("pt", "#text", [], { text: "Đoạn " }), n("b", "b", [n("bt", "#text", [], { text: "đậm" })])], { type: "text" }),
      n("box", "div", [n("img", "img", [], { type: "image", attrs: { src: "a.png", srcset: "a.png 1x" } })]),
      n("pic", "picture", [n("src1", "source", [], { attrs: { srcset: "b.webp" } }), n("img2", "img", [], { type: "image", attrs: { src: "b.png" } })]),
      n("gone", "div", [n("inner", "span")], { hidden: true }),
      n("bad", "div", [n("frame", "iframe", [], { type: "media" }), n("ok", "em", [], { attrs: { onclick: "x", title: "t" }, styles: { base: { color: "red", width: "1px;}" }, bp: {}, state: {}, pseudo: {} } })]),
    ]) },
    { id: "s2", name: "Footer", layoutId: "L", root: n("r2", "footer", [
      n("inst", "div", [n("instance:4:inst:m1", "span"), n("ic", "span")], { component: { id: "c", role: "instance", sourceId: "m" } }),
      n("track", "div", [n("slide", "div")]),
    ]) },
  ],
});
const carousel = { rootId: "r2", spec: { kind: "carousel", track: "track" }, members: ["track", "slide"], items: [], instance: false } as unknown as PanelComponent;
const ix = () => indexPage(page());

test("index: section roots carry their placeholder (subject) and shell parent; depth, children, hidden and shell flags; labels", () => {
  const index = ix();
  expect(bodyOf(page())).toBe("body");
  expect(index.get("r1")).toMatchObject({ subject: "ph1", parent: "body", index: 0, depth: 2, sectionId: "s1", sectionName: "Hero", shell: false });
  expect(index.get("r2")).toMatchObject({ subject: "ph2", index: 1, layout: true });
  expect(index.get("body")!.children).toEqual(["r1", "r2", "nav"]);
  expect(index.get("h")).toMatchObject({ parent: "r1", subject: "h", index: 0, depth: 3, sectionId: "s1" });
  expect(index.get("inner")!.hidden).toBe(true);
  expect(index.get("nav")!.shell).toBe(true);
  expect(labelOf(index.get("r1")!)).toBe("Hero");
  expect(labelOf(index.get("h")!)).toBe("Chữ Xin chào thế giới");
  expect(labelOf(index.get("box")!)).toBe("Khung <div>");
  expect(labelOf({ ...index.get("h")!, node: { ...index.get("h")!.node, name: "Tiêu đề" } })).toBe("Tiêu đề");
  expect(ancestorsOf(index, "bt")).toEqual(["bt", "b", "p", "r1", "body", "html"]);
});

test("layer rows: no #text rows, open state, search keeps matches + ancestors, badges; the window renders at most 200 rows", () => {
  const index = ix();
  expect(layerRows(index, "body", new Set(["body"]), "", []).map((r) => r.id)).toEqual(["body", "r1", "r2", "nav"]);
  const rows = layerRows(index, "body", new Set(["body", "r1", "r2"]), "", [carousel]);
  expect(rows.map((r) => r.id)).toEqual(["body", "r1", "h", "p", "box", "pic", "gone", "bad", "r2", "inst", "track", "nav"]);
  expect(rows.find((r) => r.id === "r2")).toMatchObject({ kind: "carousel", section: true });
  expect(rows.find((r) => r.id === "inst")).toMatchObject({ role: "instance" });
  expect(rows.find((r) => r.id === "gone")).toMatchObject({ hidden: true, dimmed: true });
  expect(layerRows(index, "body", new Set(), "thế giới", []).map((r) => r.id)).toEqual(["body", "r1", "h"]);
  expect(rowWindow(10_000, 0, 600)).toEqual({ start: 0, end: 45 });
  const w = rowWindow(10_000, 24 * 5000, 100_000);
  expect(w.end - w.start).toBe(MAX_ROWS);
  expect(rowWindow(3, 0, 600)).toEqual({ start: 0, end: 3 });
});

test("selection: #text and hidden nodes resolve to a pickable ancestor; parent never html/body; siblings; top-most; text hosts", () => {
  const index = ix();
  expect(pickTarget(index, "t")).toBe("h");
  expect(pickTarget(index, "inner")).toBeUndefined();
  expect(pickTarget(index, "body")).toBeUndefined();
  expect(parentOf(index, "h")).toBe("r1");
  expect(parentOf(index, "r1")).toBeUndefined();
  expect(siblingsOf(index, "h")).toEqual(["h", "p", "box", "pic", "bad"]);
  expect(topMost(index, ["bt", "p", "h"])).toEqual(["p", "h"]);
  expect([isTextHost(index.get("h")!.node), isTextHost(index.get("p")!.node), isTextHost(index.get("box")!.node)]).toEqual([true, true, false]);
  expect(bands({ x: 10, y: 10, w: 100, h: 50 }, [1, 2, 3, 4], false)).toEqual([
    { x: 6, y: 9, w: 106, h: 1 }, { x: 110, y: 10, w: 2, h: 50 }, { x: 6, y: 60, w: 106, h: 3 }, { x: 6, y: 10, w: 4, h: 50 },
  ]);
});

test("guards: generated instance ids, instance structure, component roles, shell nodes, carousel track — Vietnamese reasons, nothing sent", () => {
  const index = ix();
  expect(guard(index, [], "instance:4:inst:m1", "edit")).toMatch(/instance/);
  expect(guard(index, [], "ic", "delete")).toMatch(/instance.*main|Detach/);
  expect(guard(index, [carousel], "slide", "delete")).toMatch(/Carousel.*panel Component/);
  expect(guard(index, [carousel], "r2", "delete")).toBeUndefined(); // the whole component may go
  expect(guard(index, [], "nav", "delete")).toMatch(/shell/);
  expect(guard(index, [], "inst", "duplicate")).toMatch(/component/);
  expect(deleteBatch(index, [carousel], ["slide"])).toEqual({ error: expect.stringMatching(/Carousel/) });
  expect(dropCommand(index, [carousel], "h", "track", "inside")).toEqual({ error: expect.stringMatching(/track.*panel Component/) });
});

test("batches: delete top-most (a section by its placeholder), duplicate in descending index order, hide = setHidden + display, reorder, rename", () => {
  const index = ix();
  expect(deleteBatch(index, [], ["bt", "p", "r2"])).toEqual({ commands: [{ op: "deleteNode", id: "p" }, { op: "deleteNode", id: "ph2" }] });
  expect(duplicateBatch(index, [], ["h", "box"])).toEqual({ commands: [
    { op: "duplicateNode", id: "box", parentId: "r1", index: 3 }, { op: "duplicateNode", id: "h", parentId: "r1", index: 1 },
  ] });
  expect(hideBatch(index, ["h"], true)).toEqual({ commands: [{ op: "setHidden", id: "h", hidden: true }, { op: "setStyle", id: "h", target: "base", changes: { display: "none" } }] });
  expect(hideBatch(index, ["gone"], false)).toEqual({ commands: [{ op: "setHidden", id: "gone", hidden: false }] });
  expect(hideBatch(index, ["body"], true)).toEqual({ error: expect.any(String) });
  expect(reorderBatch(index, [], ["p", "box"], 1)).toEqual({ commands: [{ op: "moveNode", id: "box", parentId: "r1", index: 3 }, { op: "moveNode", id: "p", parentId: "r1", index: 2 }] });
  expect(reorderBatch(index, [], ["h"], -1)).toEqual({ error: expect.any(String) });
  expect(renameBatch(index, "h", "  Tiêu đề  ")).toEqual({ commands: [{ op: "setName", id: "h", name: "Tiêu đề" }] });
  expect(renameBatch(index, "h", " ")).toEqual({ error: expect.stringMatching(/1–80/) });
  const many = Array.from({ length: 26 }, (_, i) => `x${i}`);
  const wide = indexPage({ shell: n("html", "html", [n("body", "body", [n("ph", "#section", [], { attrs: { "data-section": "s" } })])]), sections: [{ id: "s", name: "S", root: n("r", "div", many.map((x) => n(x, "div"))) }] });
  expect(hideBatch(wide, many, true)).toEqual({ error: expect.stringMatching(/50/) });
});

test("drop: before/after/inside with the index counted after lifting; into itself, void tags, the shell and (E3a) another section are refused; a section row only reorders sections", () => {
  const index = ix();
  expect(dropCommand(index, [], "h", "box", "after")).toEqual({ commands: [{ op: "moveNode", id: "h", parentId: "r1", index: 2 }] });
  expect(dropCommand(index, [], "box", "h", "before")).toEqual({ commands: [{ op: "moveNode", id: "box", parentId: "r1", index: 0 }] });
  expect(dropCommand(index, [], "h", "box", "inside")).toEqual({ commands: [{ op: "moveNode", id: "h", parentId: "box", index: 1 }] });
  expect(dropCommand(index, [], "p", "b", "inside")).toEqual({ error: expect.stringMatching(/chính nó/) });
  expect(dropCommand(index, [], "h", "img", "inside")).toEqual({ error: expect.stringMatching(/img/) });
  expect(dropCommand(index, [], "h", "nav", "after")).toEqual({ error: expect.stringMatching(/shell/) });
  expect(dropCommand(index, [], "h", "track", "after")).toEqual({ error: expect.stringMatching(/section khác/) });
  expect(dropCommand(index, [], "r2", "r1", "before")).toEqual({ commands: [{ op: "moveNode", id: "ph2", parentId: "body", index: 0 }] });
  expect(dropCommand(index, [], "r2", "h", "after")).toEqual({ error: expect.stringMatching(/section/) });
});

test("clipboard: one subtree as a draft without ids, unsafe tags/attrs/CSS dropped, ≤ 500 nodes; paste right after the selection (inside a section root)", () => {
  expect(LIMITS).toEqual({ batch: COMMAND_LIMITS.commands, clipboard: COMMAND_LIMITS.nodes, depth: COMMAND_LIMITS.depth });
  const index = ix();
  const clip = copyClip(index, "bad");
  expect(clip).toEqual({ count: 2, draft: { tag: "div", type: "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children: [
    { tag: "em", type: "container", attrs: { title: "t" }, styles: { base: { color: "red" }, bp: {}, state: {}, pseudo: {} }, children: [] },
  ] } });
  expect(JSON.stringify(clip)).not.toMatch(/"id"|parentId|iframe|onclick/);
  expect(copyClip(index, "nav")).toEqual({ error: expect.any(String) });
  if ("error" in clip) throw new Error("clip");
  expect(pasteBatch(index, [], clip, "h")).toEqual({ commands: [{ op: "createNode", parentId: "r1", index: 1, draft: clip.draft }] });
  expect(pasteBatch(index, [], clip, "r1")).toEqual({ commands: [{ op: "createNode", parentId: "r1", index: 6, draft: clip.draft }] });
  expect(pasteBatch(index, [], clip, undefined)).toEqual({ error: expect.any(String) });
  const big = indexPage({ shell: n("html", "html", [n("body", "body", [n("ph", "#section", [], { attrs: { "data-section": "s" } })])]), sections: [{ id: "s", name: "S", root: n("r", "div", Array.from({ length: 501 }, (_, i) => n(`k${i}`, "i"))) }] });
  expect(copyClip(big, "r")).toEqual({ error: expect.stringMatching(/500/) });
});

test("keys, style targets, images", () => {
  const k = (key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => keyAction({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods }, false);
  expect([k("z", { ctrlKey: true }), k("Z", { ctrlKey: true, shiftKey: true }), k("y", { ctrlKey: true }), k("z", { metaKey: true })]).toEqual(["undo", "redo", "redo", "undo"]);
  expect([k("Delete"), k("d", { ctrlKey: true }), k("h"), k("H"), k("c", { ctrlKey: true }), k("v", { ctrlKey: true })]).toEqual(["delete", "duplicate", "hide", "hide", "copy", "paste"]);
  expect([k("ArrowUp", { altKey: true }), k("ArrowDown", { altKey: true }), k("Enter", { ctrlKey: true }), k("Escape"), k("a", { ctrlKey: true })]).toEqual(["up", "down", "child", "parent", "siblings"]);
  expect([k("h", { ctrlKey: true }), k("x"), keyAction({ key: "Delete", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, true)]).toEqual([undefined, undefined, undefined]);
  expect([styleTarget(1440), styleTarget(768), styleTarget(375), styleTarget(768, "hover")]).toEqual(["base", 768, 375, "hover"]);
  const index = ix();
  expect(imageBatch(index, "img", "img", "K", 1440)).toEqual({ commands: [{ op: "setAttribute", id: "img", name: "src", value: "K" }, { op: "setAttribute", id: "img", name: "srcset", value: null }] });
  expect(imageBatch(index, "img2", "img", "K", 1440)).toEqual({ commands: [{ op: "setAttribute", id: "img2", name: "src", value: "K" }, { op: "setAttribute", id: "src1", name: "srcset", value: "K" }] });
  expect(imageBatch(index, "src1", "source", "K", 1440)).toEqual({ commands: [{ op: "setAttribute", id: "src1", name: "srcset", value: "K" }] });
  expect(imageBatch(index, "box", "background", "https://u/x.png", 768)).toEqual({ commands: [{ op: "setStyle", id: "box", target: 768, changes: { "background-image": 'url("https://u/x.png")' } }] });
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `npx vitest run tests/unit/editor-model.test.ts`
Expected: FAIL — `Cannot find module '@/app/p/[id]/editor/visual/model'`.

- [ ] **Step 3: Cài đặt** — `src/app/p/[id]/editor/visual/model.ts`:

```ts
// E3 client model (pure: no DOM, no React — unit-tested in node): the page tree the editor shows, the layer rows,
// the selection rules and the command batches user actions become. Server rules are mirrored only to answer early
// in Vietnamese (spec §2 "Bảo vệ"); the server judges every command again.
import type { CanvasPage } from "@/core/editor-canvas";
import type { PanelComponent } from "@/core/interactive";
import type { EditorCommand, NodeDraft, StyleTarget } from "@/core/ir-command";
import type { IRNodeV2, NodeStyles } from "@/core/ir-v2";
import { isSafeAttr, isSafeCss, tagSchema } from "@/core/safe-names";

export type Bp = 1440 | 768 | 375;
export const BPS: readonly Bp[] = [1440, 768, 375];
// mirrors COMMAND_LIMITS (ir-command imports server modules; the unit test pins the values)
export const LIMITS = { batch: 50, clipboard: 500, depth: 20 } as const;
export const GENERATED = "instance:"; // resolveComponents' view-only ids of a main's nodes inside an instance
export const ROW_HEIGHT = 24;
export const MAX_ROWS = 200;
export type Batch = { commands: EditorCommand[] } | { error: string };
export type Entry = {
  node: IRNodeV2;
  parent?: string; // the node commands move it within: its IR parent, or (a section root) its placeholder's shell parent
  subject: string; // the id tree commands name: the node, or a section root's placeholder
  index: number; // the subject's index in `parent`'s IR children
  depth: number;
  children: string[]; // element children shown (placeholders as their section roots, no #text)
  sectionId?: string;
  sectionName?: string; // only on a section root
  layout?: boolean;
  shell: boolean; // a page-shell node: only placeholders move or go there
  hidden: boolean; // the node or an ancestor is hidden
};
export type DocIndex = Map<string, Entry>;
export type Row = { id: string; depth: number; label: string; type: IRNodeV2["type"]; section: boolean; hasChildren: boolean; open: boolean; hidden: boolean; dimmed: boolean; role?: "main" | "instance"; kind?: string };
export type Zone = "before" | "after" | "inside";
export type Box = { x: number; y: number; w: number; h: number };
export type Clip = { draft: NodeDraft; count: number };
export type KeyAction = "undo" | "redo" | "delete" | "duplicate" | "hide" | "copy" | "paste" | "up" | "down" | "child" | "parent" | "siblings";

const GEN_MSG = "Phần tử này thuộc component instance — sửa ở main hoặc Tách khỏi component (Detach).";
const INSTANCE_MSG = "Cấu trúc bên trong instance lấy từ main — sửa ở main hoặc Tách khỏi component (Detach).";
const SHELL_MSG = "Khung trang (shell) chỉ cho đổi thứ tự hoặc xoá section.";
const KIND_VI: Record<string, string> = { carousel: "Carousel", tabs: "Tabs", accordion: "Accordion", modal: "Modal", dropdown: "Dropdown", menu: "Menu", video: "Video" };
const TYPE_VI: Record<IRNodeV2["type"], string> = { container: "Khung", text: "Chữ", image: "Ảnh", link: "Link", button: "Nút", input: "Ô nhập", media: "Media", svg: "SVG", "component-root": "Component" };
const VOID = new Set(["area", "br", "col", "embed", "hr", "img", "input", "source", "track", "wbr"]);
const INLINE = new Set(["#text", "b", "i", "strong", "em", "a", "br", "span", "small", "code", "u", "s", "sub", "sup"]);

export function indexPage(page: Pick<CanvasPage, "shell" | "sections">): DocIndex {
  const index: DocIndex = new Map();
  const sections = new Map(page.sections.map((s) => [s.id, s]));
  const visit = (node: IRNodeV2, parent: string | undefined, i: number, depth: number, section: string | undefined, hidden: boolean): string | undefined => {
    let entry: Entry, kids: IRNodeV2[], sid = section;
    if (node.tag === "#section") {
      const s = sections.get(node.attrs["data-section"] ?? "");
      if (!s) return undefined;
      entry = { node: s.root, parent, subject: node.id, index: i, depth, children: [], sectionId: s.id, sectionName: s.name, layout: s.layoutId !== undefined, shell: false, hidden: hidden || !!s.root.hidden };
      kids = s.root.children;
      sid = s.id;
    } else {
      entry = { node, parent, subject: node.id, index: i, depth, children: [], shell: section === undefined, hidden: hidden || !!node.hidden, ...(section !== undefined && { sectionId: section }) };
      kids = node.children;
    }
    index.set(entry.node.id, entry);
    kids.forEach((c, k) => {
      const id = visit(c, entry.node.id, k, depth + 1, sid, entry.hidden);
      if (id && c.tag !== "#text") entry.children.push(id);
    });
    return entry.node.id;
  };
  visit(page.shell, undefined, 0, 0, undefined, false);
  return index;
}
export const bodyOf = (page: Pick<CanvasPage, "shell">): string => page.shell.children.find((c) => c.tag === "body")?.id ?? page.shell.id;

const firstText = (n: IRNodeV2): string | undefined => (n.tag === "#text" ? n.text?.trim() || undefined : n.children.map(firstText).find(Boolean));
export function labelOf(e: Entry): string {
  if (e.node.name) return e.node.name;
  if (e.sectionName !== undefined) return e.sectionName;
  const text = firstText(e.node);
  return text ? `${TYPE_VI[e.node.type]} ${text.slice(0, 30)}` : `${TYPE_VI[e.node.type]} <${e.node.tag}>`;
}
export function ancestorsOf(index: DocIndex, id: string): string[] {
  const out: string[] = [];
  for (let at: string | undefined = id; at !== undefined && index.has(at); at = index.get(at)!.parent) out.push(at);
  return out;
}
const inside = (index: DocIndex, id: string, root: string) => ancestorsOf(index, id).includes(root);

export function layerRows(index: DocIndex, rootId: string, open: ReadonlySet<string>, query: string, components: readonly PanelComponent[]): Row[] {
  const q = query.trim().toLowerCase();
  const kinds = new Map(components.map((c) => [c.rootId, c.spec.kind as string]));
  let keep: Set<string> | undefined;
  if (q) {
    keep = new Set();
    for (const [id, e] of index) if (e.node.tag !== "#text" && (labelOf(e).toLowerCase().includes(q) || (firstText(e.node) ?? "").toLowerCase().includes(q))) for (const a of ancestorsOf(index, id)) keep.add(a);
  }
  const rows: Row[] = [];
  const walk = (id: string, depth: number): void => {
    const e = index.get(id);
    if (!e || (keep && !keep.has(id))) return;
    const isOpen = keep ? true : open.has(id);
    rows.push({
      id, depth, label: labelOf(e), type: e.node.type, section: e.sectionName !== undefined, hasChildren: e.children.length > 0, open: isOpen,
      hidden: !!e.node.hidden, dimmed: e.hidden, ...(e.node.component && { role: e.node.component.role }), ...(kinds.has(id) && { kind: kinds.get(id) }),
    });
    if (isOpen) for (const c of e.children) walk(c, depth + 1);
  };
  walk(rootId, 0);
  return rows;
}
export function rowWindow(total: number, scrollTop: number, height: number, overscan = 10): { start: number; end: number } {
  const start = Math.max(0, Math.min(total, Math.floor(scrollTop / ROW_HEIGHT) - overscan));
  return { start, end: Math.min(total, start + Math.min(MAX_ROWS, Math.ceil(height / ROW_HEIGHT) + 2 * overscan)) };
}
// the four bands of a margin (outside the border box) or a padding (inside it): top, right, bottom, left
export function bands(box: Box, [t, r, b, l]: readonly [number, number, number, number], insideBox: boolean): Box[] {
  const o = insideBox ? box : { x: box.x - l, y: box.y - t, w: box.w + l + r, h: box.h + t + b };
  return [{ x: o.x, y: o.y, w: o.w, h: t }, { x: o.x + o.w - r, y: o.y + t, w: r, h: o.h - t - b }, { x: o.x, y: o.y + o.h - b, w: o.w, h: b }, { x: o.x, y: o.y + t, w: l, h: o.h - t - b }];
}

const pageRoot = (e: Entry) => e.shell && (e.node.tag === "html" || e.node.tag === "body");
// spec §2: the deepest node under the pointer, never a #text, a hidden node (or inside one) or html/body
export function pickTarget(index: DocIndex, id: string): string | undefined {
  for (const a of ancestorsOf(index, id)) {
    const e = index.get(a)!;
    if (e.hidden || pageRoot(e)) return undefined;
    if (e.node.tag !== "#text") return a;
  }
  return undefined;
}
export function parentOf(index: DocIndex, id: string): string | undefined {
  const p = index.get(id)?.parent;
  return p !== undefined && !pageRoot(index.get(p)!) ? p : undefined;
}
export function siblingsOf(index: DocIndex, id: string): string[] {
  const p = index.get(id)?.parent;
  return p === undefined ? [id] : index.get(p)!.children.filter((c) => !index.get(c)!.hidden);
}
export function topMost(index: DocIndex, ids: readonly string[]): string[] {
  const set = new Set(ids);
  return ids.filter((id) => !ancestorsOf(index, id).slice(1).some((a) => set.has(a)));
}
export function isTextHost(node: IRNodeV2): boolean {
  const inline = (c: IRNodeV2): boolean => INLINE.has(c.tag) && c.children.every(inline);
  return node.tag !== "#text" && node.children.some((c) => c.tag === "#text" && (c.text ?? "").trim() !== "") && node.children.every(inline);
}

function roleOwner(index: DocIndex, components: readonly PanelComponent[], id: string): PanelComponent | undefined {
  return components.find((c) => !inside(index, c.rootId, id) && c.members.some((m) => index.has(m) && inside(index, m, id)));
}
const holdsComponent = (n: IRNodeV2): boolean => !!n.component || n.children.some(holdsComponent);
export function guard(index: DocIndex, components: readonly PanelComponent[], id: string, op: "delete" | "move" | "duplicate" | "edit"): string | undefined {
  const e = index.get(id);
  if (!e) return "Không tìm thấy phần tử (trang vừa đổi) — tải lại.";
  if (id.startsWith(GENERATED)) return GEN_MSG;
  if (op === "edit") return undefined;
  if (e.shell) return SHELL_MSG;
  if (e.parent !== undefined && index.get(e.parent)!.node.component?.role === "instance") return INSTANCE_MSG;
  if (op === "duplicate") {
    if (e.sectionName !== undefined) return "Chưa nhân bản được cả section.";
    if (holdsComponent(e.node)) return "Chưa nhân bản được phần tử thuộc component (main/instance).";
    return undefined;
  }
  const owner = roleOwner(index, components, id);
  if (owner) return `Phần tử là một phần của ${KIND_VI[owner.spec.kind]} — dùng panel Component (Lên/Xuống, Xoá, Bỏ hành vi).`;
  return undefined;
}
export function guardParent(index: DocIndex, components: readonly PanelComponent[], parentId: string): string | undefined {
  const p = index.get(parentId);
  if (!p) return "Không tìm thấy vị trí thả.";
  if (parentId.startsWith(GENERATED) || p.node.component?.role === "instance") return INSTANCE_MSG;
  if (p.shell) return "Không thả phần tử vào khung trang (shell).";
  if (p.node.tag === "#text" || VOID.has(p.node.tag)) return `Phần tử <${p.node.tag}> không chứa con được.`;
  if (components.some((c) => c.spec.kind === "carousel" && c.spec.track === parentId)) return "Đây là track của carousel — thêm slide bằng nút Thêm trong panel Component.";
  return undefined;
}
const capped = (commands: EditorCommand[]): Batch =>
  commands.length === 0 ? { error: "Chưa chọn phần tử." } : commands.length > LIMITS.batch ? { error: `Tối đa ${LIMITS.batch} lệnh mỗi thao tác — chọn ít phần tử hơn.` } : { commands };
const first = (index: DocIndex, components: readonly PanelComponent[], ids: string[], op: "delete" | "move" | "duplicate") => {
  for (const id of ids) { const why = guard(index, components, id, op); if (why) return why; }
  return undefined;
};

export function deleteBatch(index: DocIndex, components: readonly PanelComponent[], ids: readonly string[]): Batch {
  const top = topMost(index, ids), why = first(index, components, top, "delete");
  return why ? { error: why } : capped(top.map((id) => ({ op: "deleteNode", id: index.get(id)!.subject })));
}
// later siblings first: the earlier indexes stay right while the batch inserts copies
export function duplicateBatch(index: DocIndex, components: readonly PanelComponent[], ids: readonly string[]): Batch {
  const top = topMost(index, ids), why = first(index, components, top, "duplicate");
  if (why) return { error: why };
  const order = [...top].sort((a, b) => index.get(b)!.index - index.get(a)!.index);
  return capped(order.map((id) => { const e = index.get(id)!; return { op: "duplicateNode", id: e.subject, parentId: e.parent!, index: e.index + 1 }; }));
}
// R9: the hidden flag + display:none on the base rule (show: display dropped only when the base hides it)
export function hideBatch(index: DocIndex, ids: readonly string[], hidden: boolean): Batch {
  const commands: EditorCommand[] = [];
  for (const id of topMost(index, ids)) {
    const e = index.get(id);
    if (!e) return { error: "Không tìm thấy phần tử." };
    if (id.startsWith(GENERATED)) return { error: GEN_MSG };
    if (pageRoot(e)) return { error: "Không ẩn được khung trang." };
    commands.push({ op: "setHidden", id, hidden });
    if (hidden) commands.push({ op: "setStyle", id, target: "base", changes: { display: "none" } });
    else if (e.node.styles.base.display === "none") commands.push({ op: "setStyle", id, target: "base", changes: { display: null } });
  }
  return capped(commands);
}
// moveNode's index counts after lifting: ±1 lands next to the neighbour; moving down goes last-first, up first-first
export function reorderBatch(index: DocIndex, components: readonly PanelComponent[], ids: readonly string[], delta: -1 | 1): Batch {
  const top = topMost(index, ids), why = first(index, components, top, "move");
  if (why) return { error: why };
  const order = [...top].sort((a, b) => (index.get(a)!.index - index.get(b)!.index) * -delta);
  const commands: EditorCommand[] = [];
  for (const id of order) {
    const e = index.get(id)!, count = index.get(e.parent!)!.node.children.length, to = e.index + delta;
    if (to >= 0 && to < count) commands.push({ op: "moveNode", id: e.subject, parentId: e.parent!, index: to });
  }
  return commands.length ? capped(commands) : { error: "Đã ở đầu / cuối danh sách." };
}
export function dropCommand(index: DocIndex, components: readonly PanelComponent[], dragId: string, overId: string, zone: Zone): Batch {
  const drag = index.get(dragId), over = index.get(overId);
  if (!drag || !over) return { error: "Không tìm thấy phần tử." };
  if (drag.sectionName !== undefined) { // a section row: reorder its placeholder among the others
    if (over.sectionName === undefined || zone === "inside") return { error: "Section chỉ đổi thứ tự với section khác." };
    let at = over.index + (zone === "after" ? 1 : 0);
    if (drag.index < at) at -= 1;
    return { commands: [{ op: "moveNode", id: drag.subject, parentId: drag.parent!, index: at }] };
  }
  const why = guard(index, components, dragId, "move");
  if (why) return { error: why };
  const parentId = zone === "inside" ? over.node.id : over.sectionName !== undefined ? undefined : over.parent;
  if (parentId === undefined) return { error: "Thả vào trong section, không đặt cạnh section." };
  const parentWhy = guardParent(index, components, parentId);
  if (parentWhy) return { error: parentWhy };
  if (inside(index, parentId, dragId)) return { error: "Không thả phần tử vào chính nó." };
  if (index.get(parentId)!.sectionId !== drag.sectionId) return { error: "Chưa chuyển được phần tử sang section khác." }; // R11 (E3b lifts it)
  let at = zone === "inside" ? over.node.children.length : over.index + (zone === "after" ? 1 : 0);
  if (parentId === drag.parent && drag.index < at) at -= 1;
  return { commands: [{ op: "moveNode", id: drag.subject, parentId, index: at }] };
}

// R19: a draft checkNewNode accepts — no ids, no box/component/interactive/behavior, unsafe subtrees/attrs/CSS left out
const cleanDecl = (d: Record<string, string> | undefined) => Object.fromEntries(Object.entries(d ?? {}).filter(([p, v]) => isSafeCss(p, v)));
const cleanStyles = (s: NodeStyles): NodeStyles => ({
  base: cleanDecl(s.base),
  bp: Object.fromEntries(Object.entries(s.bp).map(([k, d]) => [k, cleanDecl(d)])),
  state: Object.fromEntries(Object.entries(s.state).map(([k, d]) => [k, cleanDecl(d)])),
  pseudo: Object.fromEntries(Object.entries(s.pseudo).map(([k, d]) => [k, cleanDecl(d)])),
});
export function copyClip(index: DocIndex, id: string): Clip | { error: string } {
  const e = index.get(id);
  if (!e) return { error: "Không tìm thấy phần tử." };
  if (e.shell) return { error: "Không sao chép khung trang (shell)." };
  let count = 0, deep = false;
  const draftOf = (n: IRNodeV2, depth: number): NodeDraft | null => {
    if (n.tag === "#section" || !tagSchema.safeParse(n.tag).success) return null;
    count++;
    if (depth > LIMITS.depth) deep = true;
    if (n.tag === "#text") return { tag: "#text", text: n.text ?? "" };
    const d: NodeDraft = { tag: n.tag, ...(n.type !== "component-root" && { type: n.type }), attrs: Object.fromEntries(Object.entries(n.attrs).filter(([k, v]) => isSafeAttr(n.tag, k, v))), styles: cleanStyles(n.styles), children: n.children.map((c) => draftOf(c, depth + 1)).filter((c): c is NodeDraft => c !== null) };
    if (n.name) d.name = n.name;
    if (n.hidden) d.hidden = true;
    return d;
  };
  const draft = draftOf(e.node, 1);
  if (!draft) return { error: `Không sao chép được <${e.node.tag}>.` };
  if (count > LIMITS.clipboard) return { error: `Clipboard tối đa ${LIMITS.clipboard} phần tử (phần tử này có ${count}).` };
  if (deep) return { error: `Clipboard tối đa ${LIMITS.depth} tầng.` };
  return { draft, count };
}
// right after the node in its parent; after a section root: at the end inside it
export function insertAt(index: DocIndex, components: readonly PanelComponent[], afterId: string | undefined): { parentId: string; index: number } | { error: string } {
  const e = afterId ? index.get(afterId) : undefined;
  if (!e) return { error: "Chọn một phần tử để chèn / dán sau nó." };
  const [parentId, at] = e.sectionName !== undefined ? [e.node.id, e.node.children.length] : [e.parent, e.index + 1];
  if (parentId === undefined) return { error: SHELL_MSG };
  const why = guardParent(index, components, parentId);
  return why ? { error: why } : { parentId, index: at };
}
export function pasteBatch(index: DocIndex, components: readonly PanelComponent[], clip: Clip, afterId: string | undefined): Batch {
  const at = insertAt(index, components, afterId);
  return "error" in at ? at : { commands: [{ op: "createNode", parentId: at.parentId, index: at.index, draft: clip.draft }] };
}
export function renameBatch(index: DocIndex, id: string, name: string): Batch {
  if (id.startsWith(GENERATED)) return { error: GEN_MSG };
  const trimmed = name.trim();
  if (!index.has(id)) return { error: "Không tìm thấy phần tử." };
  if (trimmed.length < 1 || trimmed.length > 80) return { error: "Tên cần 1–80 ký tự." };
  return { commands: [{ op: "setName", id, name: trimmed }] };
}
export const styleTarget = (bp: Bp, state?: "hover" | "focus" | "active"): StyleTarget => state ?? (bp === 1440 ? "base" : bp);

export function keyAction(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, typing: boolean): KeyAction | undefined {
  if (typing) return undefined;
  const mod = e.ctrlKey || e.metaKey, key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && key === "z") return e.shiftKey ? "redo" : "undo";
  if (mod && key === "y") return "redo";
  if (mod && key === "d") return "duplicate";
  if (mod && key === "c") return "copy";
  if (mod && key === "v") return "paste";
  if (mod && key === "a") return "siblings";
  if (mod && key === "Enter") return "child";
  if (mod) return undefined;
  if (e.altKey && key === "ArrowUp") return "up";
  if (e.altKey && key === "ArrowDown") return "down";
  if (e.altKey) return undefined;
  if (key === "Delete") return "delete";
  if (key === "Escape") return "parent";
  if (key === "h") return "hide";
  return undefined;
}

// R13: an <img> loses its srcset and its <picture> sources show the same image; a <source> takes srcset; a background
// goes to the current breakpoint
export function imageBatch(index: DocIndex, id: string, kind: "img" | "source" | "background", key: string, bp: Bp): Batch {
  const e = index.get(id);
  if (!e) return { error: "Không tìm thấy phần tử." };
  if (id.startsWith(GENERATED)) return { error: GEN_MSG };
  if (kind === "background") return { commands: [{ op: "setStyle", id, target: styleTarget(bp), changes: { "background-image": `url("${key}")` } }] };
  if (kind === "source") return { commands: [{ op: "setAttribute", id, name: "srcset", value: key }] };
  const commands: EditorCommand[] = [{ op: "setAttribute", id, name: "src", value: key }];
  if (e.node.attrs.srcset !== undefined) commands.push({ op: "setAttribute", id, name: "srcset", value: null });
  const parent = e.parent !== undefined ? index.get(e.parent) : undefined;
  if (parent?.node.tag === "picture") for (const c of parent.node.children) if (c.tag === "source") commands.push({ op: "setAttribute", id: c.id, name: "srcset", value: key });
  return capped(commands);
}
// the Component panel's role choices: the node + descendants (≤ max), like the GrapesJS selectionOf
export function outlineOf(index: DocIndex, id: string, max = 100): { id: string; label: string; depth: number }[] {
  const out: { id: string; label: string; depth: number }[] = [];
  const walk = (nid: string, depth: number): void => {
    const e = index.get(nid);
    if (!e || out.length >= max) return;
    out.push({ id: nid, label: `${e.node.tag} ${(firstText(e.node) ?? "").slice(0, 30)}`.trim(), depth });
    e.children.forEach((c) => walk(c, depth + 1));
  };
  walk(id, 0);
  return out;
}
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/editor-model.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/model.ts" tests/unit/editor-model.test.ts
git commit -m "feat(e3): pure editor model — page index, layer rows, selection rules, guards, command batches, clipboard, keys

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Sửa chữ — DOM-like → batch (thuần)

**Files:**
- Create: `src/app/p/[id]/editor/visual/inline-text.ts`
- Test: `tests/unit/inline-text.test.ts`

**Interfaces:**
- Consumes: `Batch`, `LIMITS`, `GENERATED` (Task 5); `isSafeAttr`; type `IRNodeV2`, `NodeDraft`, `EditorCommand`.
- Produces:

```ts
export type DomLike = { nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<DomLike>; getAttribute?(name: string): string | null };
export function textBatch(ir: IRNodeV2, el: DomLike): Batch; // { commands: [] } = nothing changed
```

- [ ] **Step 1: Viết test đỏ** — `tests/unit/inline-text.test.ts`:

```ts
import { expect, test } from "vitest";
import type { IRNodeV2 } from "@/core/ir-v2";
import { textBatch, type DomLike } from "@/app/p/[id]/editor/visual/inline-text";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 =>
  ({ id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra });
const t = (text: string): DomLike => ({ nodeType: 3, nodeName: "#text", textContent: text, childNodes: [] });
const el = (name: string, children: DomLike[] = [], attrs: Record<string, string> = {}): DomLike =>
  ({ nodeType: 1, nodeName: name.toUpperCase(), textContent: null, childNodes: children, getAttribute: (k) => attrs[k] ?? null });
// <h1>Xin <b>chào</b> bạn</h1>
const ir = () => n("h", "h1", [n("t1", "#text", [], { text: "Xin " }), n("b1", "b", [n("t2", "#text", [], { text: "chào" })]), n("t3", "#text", [], { text: " bạn" })]);

test("same inline structure: setText only for the texts that changed; unchanged -> no command", () => {
  expect(textBatch(ir(), el("h1", [t("Xin "), el("b", [t("chào")], { "data-ir-id": "b1" }), t(" bạn")]))).toEqual({ commands: [] });
  expect(textBatch(ir(), el("h1", [t("Chào "), el("b", [t("chào")], { "data-ir-id": "b1" }), t(" các bạn")]))).toEqual({ commands: [
    { op: "setText", id: "t1", text: "Chào " }, { op: "setText", id: "t3", text: " các bạn" },
  ] });
  // the browser split a text node: merged again before comparing
  expect(textBatch(ir(), el("h1", [t("Xin"), t(" "), el("b", [t("chào")], { "data-ir-id": "b1" }), t(" bạn")]))).toEqual({ commands: [] });
});

test("changed structure with text + b/i/a/br only: the children are replaced in one batch (strong->b, em->i, unknown tags unwrapped, unsafe href dropped)", () => {
  const out = textBatch(ir(), el("h1", [t("Xin chào "), el("strong", [t("bạn")]), el("br"), el("em", [el("span", [t("ơi")])]), el("a", [t("x")], { href: "javascript:alert(1)" }), el("a", [t("y")], { href: "/lien-he" })]));
  expect(out).toEqual({ commands: [
    { op: "deleteNode", id: "t1" }, { op: "deleteNode", id: "b1" }, { op: "deleteNode", id: "t3" },
    { op: "createNode", parentId: "h", index: 0, draft: { tag: "#text", text: "Xin chào " } },
    { op: "createNode", parentId: "h", index: 1, draft: { tag: "b", attrs: {}, children: [{ tag: "#text", text: "bạn" }] } },
    { op: "createNode", parentId: "h", index: 2, draft: { tag: "br", attrs: {}, children: [] } },
    { op: "createNode", parentId: "h", index: 3, draft: { tag: "i", attrs: {}, children: [{ tag: "#text", text: "ơi" }] } },
    { op: "createNode", parentId: "h", index: 4, draft: { tag: "a", attrs: {}, children: [{ tag: "#text", text: "x" }] } },
    { op: "createNode", parentId: "h", index: 5, draft: { tag: "a", attrs: { href: "/lien-he" }, children: [{ tag: "#text", text: "y" }] } },
  ] });
  // a kept <a> keeps the document's href (the canvas shows the emitter's rewritten one)
  const link = n("p", "p", [n("a1", "a", [n("at", "#text", [], { text: "Liên hệ" })], { attrs: { href: "https://x.test/contact" } })]);
  expect(textBatch(link, el("p", [t("Gọi "), el("a", [t("Liên hệ")], { "data-ir-id": "a1", href: "contact.html" })]))).toMatchObject({ commands: expect.arrayContaining([
    { op: "createNode", parentId: "p", index: 1, draft: { tag: "a", attrs: { href: "https://x.test/contact" }, children: [{ tag: "#text", text: "Liên hệ" }] } },
  ]) });
});

test("refused: a styled span (kept element that is not b/i/a/br) whose structure changed, generated instance texts, a structure change inside an instance, more than 50 commands", () => {
  const styled = n("p", "p", [n("s1", "span", [n("st", "#text", [], { text: "Giá" })]), n("t9", "#text", [], { text: " tốt" })]);
  expect(textBatch(styled, el("p", [el("span", [t("Giá")], { "data-ir-id": "s1" })]))).toEqual({ error: expect.stringMatching(/Esc/) });
  expect(textBatch(styled, el("p", [el("span", [t("Giá mới")], { "data-ir-id": "s1" }), t(" tốt")]))).toEqual({ commands: [{ op: "setText", id: "st", text: "Giá mới" }] });
  const gen = n("instance:3:x:h", "h1", [n("instance:3:x:t", "#text", [], { text: "a" })]);
  expect(textBatch(gen, el("h1", [t("b")]))).toEqual({ error: expect.stringMatching(/instance/) });
  const inst = n("h", "h1", [n("t1", "#text", [], { text: "a" })], { component: { id: "c", role: "instance", sourceId: "m" } });
  expect(textBatch(inst, el("h1", [t("a"), el("b", [t("b")])]))).toEqual({ error: expect.stringMatching(/instance/) });
  const long = n("p", "p", Array.from({ length: 30 }, (_, i) => n(`k${i}`, "#text", [], { text: `${i}` })));
  expect(textBatch(long, el("p", Array.from({ length: 30 }, (_, i) => el("b", [t(`${i}`)]))))).toEqual({ error: expect.stringMatching(/50/) });
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `npx vitest run tests/unit/inline-text.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Cài đặt** — `src/app/p/[id]/editor/visual/inline-text.ts`:

```ts
// E3 §2 inline text editing (pure, R12): the edited element's DOM, read through a minimal node interface (unit-tested
// without a browser), becomes the smallest batch — setText per changed #text when the inline structure is unchanged,
// else the element's children replaced by text + b / i / a / br in one batch (one Undo). Anything else is refused.
import type { EditorCommand, NodeDraft } from "@/core/ir-command";
import type { IRNodeV2 } from "@/core/ir-v2";
import { isSafeAttr } from "@/core/safe-names";
import { GENERATED, LIMITS, type Batch } from "./model";

export type DomLike = { nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<DomLike>; getAttribute?(name: string): string | null };
type Inline = "b" | "i" | "a" | "br";
type Piece = { text: string } | { tag: string; id?: string; href?: string; children: Piece[] };
const RENAME: Record<string, Inline> = { B: "b", STRONG: "b", I: "i", EM: "i", A: "a", BR: "br" };
const SIMPLE = new Set<string>(["b", "i", "a", "br"]);

// texts merged; b/strong -> b, i/em -> i, a (safe href), br; an element the IR has (data-ir-id) kept with its own tag;
// any other element unwrapped: pasted or browser-inserted markup never reaches the document
function read(el: DomLike, known: ReadonlyMap<string, IRNodeV2>): Piece[] {
  const out: Piece[] = [];
  const add = (p: Piece) => {
    const last = out.at(-1);
    if ("text" in p && last && "text" in last) last.text += p.text;
    else if (!("text" in p) || p.text) out.push(p);
  };
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === 3) { add({ text: c.textContent ?? "" }); continue; }
    if (c.nodeType !== 1) continue;
    const id = c.getAttribute?.("data-ir-id") ?? undefined, own = id ? known.get(id) : undefined, tag = RENAME[c.nodeName];
    if (own) add({ tag: own.tag, id: own.id, ...(own.attrs.href !== undefined && { href: own.attrs.href }), children: read(c, known) });
    else if (tag) { const href = c.getAttribute?.("href") ?? undefined; add({ tag, ...(tag === "a" && href && isSafeAttr("a", "href", href) && { href }), children: tag === "br" ? [] : read(c, known) }); }
    else for (const p of read(c, known)) add(p);
  }
  return out;
}
const shapeOfIr = (n: IRNodeV2): string => n.children.map((c) => (c.tag === "#text" ? "#" : `<${c.id}>${shapeOfIr(c)}</>`)).join("");
const shapeOf = (ps: Piece[]): string => ps.map((p) => ("text" in p ? "#" : p.id ? `<${p.id}>${shapeOf(p.children)}</>` : "?")).join("");
const irTexts = (n: IRNodeV2, out: IRNodeV2[] = []): IRNodeV2[] => { for (const c of n.children) { if (c.tag === "#text") out.push(c); else irTexts(c, out); } return out; };
const texts = (ps: Piece[], out: string[] = []): string[] => { for (const p of ps) { if ("text" in p) out.push(p.text); else texts(p.children, out); } return out; };
const allIds = (n: IRNodeV2, out = new Map<string, IRNodeV2>()) => { for (const c of n.children) { out.set(c.id, c); allIds(c, out); } return out; };
const draft = (p: Piece): NodeDraft => ("text" in p ? { tag: "#text", text: p.text } : { tag: p.tag, attrs: p.tag === "a" && p.href ? { href: p.href } : {}, children: p.children.map(draft) });
const simpleOnly = (ps: Piece[]): boolean => ps.every((p) => "text" in p || (SIMPLE.has(p.tag) && simpleOnly(p.children)));

export function textBatch(ir: IRNodeV2, el: DomLike): Batch {
  const known = allIds(ir);
  if (ir.id.startsWith(GENERATED) || [...known.keys()].some((id) => id.startsWith(GENERATED))) return { error: "Chữ này thuộc component instance — sửa ở main hoặc Tách khỏi component (Detach)." };
  const pieces = read(el, known);
  if (shapeOf(pieces) === shapeOfIr(ir)) {
    const before = irTexts(ir), after = texts(pieces);
    return { commands: before.flatMap((node, k): EditorCommand[] => (node.text === after[k] ? [] : [{ op: "setText", id: node.id, text: after[k]! }])) };
  }
  if (ir.component?.role === "instance") return { error: "Đổi định dạng trong instance: sửa ở main hoặc Tách khỏi component (Detach)." };
  if (!simpleOnly(pieces)) return { error: "Không giữ được định dạng của đoạn này — chỉ sửa chữ, hoặc Esc để huỷ." };
  const commands: EditorCommand[] = [
    ...ir.children.map((c): EditorCommand => ({ op: "deleteNode", id: c.id })),
    ...pieces.map((p, i): EditorCommand => ({ op: "createNode", parentId: ir.id, index: i, draft: draft(p) })),
  ];
  return commands.length > LIMITS.batch ? { error: `Đoạn chữ cần hơn ${LIMITS.batch} lệnh — sửa từng phần, hoặc Esc để huỷ.` } : { commands };
}
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/inline-text.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/inline-text.ts" tests/unit/inline-text.test.ts
git commit -m "feat(e3): inline text edit -> setText per changed text, or one children-replacing batch of text/b/i/a/br

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Command bus (1 đang bay, hàng đợi ≤ 20, lạc quan + rollback)

**Files:**
- Create: `src/app/p/[id]/editor/visual/command-bus.ts`
- Test: `tests/unit/command-bus.test.ts`

**Interfaces:**
- Consumes: type `Affected`, `EditorCommand`.
- Produces:

```ts
export const BUS_LIMITS = { queue: 20 } as const;
export type StepResult = { revision: number; createdIds: string[]; canUndo: boolean; canRedo: boolean; affected?: Affected };
export type Op =
  | { kind: "commands"; label: string; commands: EditorCommand[]; done?: string; apply?(): void; rollback?(): void }
  | { kind: "undo" | "redo"; label: string; done?: string };
export type SendBody = { baseRevision: number; pageId: string; commands?: EditorCommand[] };
export type Send = (op: Op, body: SendBody) => Promise<StepResult>;
export type BusEvent =
  | { type: "saving"; pending: number } | { type: "done"; op: Op; result: StepResult } | { type: "refused"; op: Op; message: string }
  | { type: "stale"; revision?: number } | { type: "unwritten"; revision: number } | { type: "failed"; op: Op; message: string } | { type: "full" };
export class CommandBus {
  constructor(revision: number, pageId: string, send: Send, emit: (e: BusEvent) => void);
  readonly pending: number; readonly revision: number;
  push(op: Op): boolean; retry(): void;
}
```

- [ ] **Step 1: Viết test đỏ** — `tests/unit/command-bus.test.ts`:

```ts
import { expect, test } from "vitest";
import { CommandBus, type BusEvent, type Op, type SendBody, type StepResult } from "@/app/p/[id]/editor/visual/command-bus";

const deferred = () => {
  let resolve!: (v: StepResult) => void, reject!: (e: unknown) => void;
  const promise = new Promise<StepResult>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
function harness(revision = 5) {
  const calls: { op: Op; body: SendBody; d: ReturnType<typeof deferred> }[] = [];
  const events: BusEvent[] = [];
  const bus = new CommandBus(revision, "pg", (op, body) => { const d = deferred(); calls.push({ op, body, d }); return d.promise; }, (e) => events.push(e));
  return { bus, calls, events };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const ok = (revision: number): StepResult => ({ revision, createdIds: [], canUndo: true, canRedo: false });
const cmd = (label: string, log: string[] = []): Op => ({ kind: "commands", label, commands: [{ op: "setName", id: "a", name: label }], apply: () => log.push(`apply ${label}`), rollback: () => log.push(`rollback ${label}`) });
const fail = (code: string, revision?: number) => Object.assign(new Error(`${code} message`), { code, revision });

test("one request in flight; the next goes with the revision the previous produced; 20 may wait, the 22nd push is refused", async () => {
  const { bus, calls, events } = harness();
  expect(bus.push(cmd("a"))).toBe(true);
  for (let i = 0; i < 20; i++) expect(bus.push(cmd(`q${i}`))).toBe(true);
  expect(bus.push(cmd("over"))).toBe(false);
  expect(events.at(-1)).toEqual({ type: "full" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.body).toEqual({ baseRevision: 5, pageId: "pg", commands: [{ op: "setName", id: "a", name: "a" }] });
  expect(bus.pending).toBe(21);
  calls[0]!.d.resolve(ok(6));
  await tick();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body.baseRevision).toBe(6);
  expect(events).toContainEqual({ type: "done", op: calls[0]!.op, result: ok(6) });
  expect(bus.pending).toBe(20);
});

test("optimistic apply at push; a 400 rolls back only that op, reports it and the queue goes on", async () => {
  const log: string[] = [];
  const { bus, calls, events } = harness();
  bus.push(cmd("a", log));
  bus.push(cmd("b", log));
  expect(log).toEqual(["apply a", "apply b"]);
  calls[0]!.d.reject(fail("IR_PATCH_INVALID"));
  await tick();
  expect(log).toEqual(["apply a", "apply b", "rollback a"]);
  expect(events).toContainEqual({ type: "refused", op: calls[0]!.op, message: "IR_PATCH_INVALID message" });
  expect(calls[1]!.body.baseRevision).toBe(5);
});

test("409 rolls back the op in flight and every queued op (newest first), drops the queue and refuses pushes", async () => {
  const log: string[] = [];
  const { bus, calls, events } = harness();
  for (const x of ["a", "b", "c"]) bus.push(cmd(x, log));
  calls[0]!.d.reject(fail("STALE_REVISION", 9));
  await tick();
  expect(log.slice(3)).toEqual(["rollback c", "rollback b", "rollback a"]);
  expect(events.at(-1)).toEqual({ type: "stale", revision: 9 });
  expect(bus.pending).toBe(0);
  expect(bus.push(cmd("d"))).toBe(false);
  expect(calls).toHaveLength(1);
});

test("500 DOCUMENT_MATERIALIZE_FAILED: the step committed — its revision is taken, queued ops rolled back, halted (reload)", async () => {
  const log: string[] = [];
  const { bus, calls, events } = harness();
  bus.push(cmd("a", log));
  bus.push(cmd("b", log));
  calls[0]!.d.reject(fail("DOCUMENT_MATERIALIZE_FAILED", 6));
  await tick();
  expect(log).toEqual(["apply a", "apply b", "rollback b"]);
  expect(bus.revision).toBe(6);
  expect(events.at(-1)).toEqual({ type: "unwritten", revision: 6 });
  expect(bus.push(cmd("c"))).toBe(false);
});

test("a network error keeps the op at the head; retry() resends it with the same baseRevision; NOTHING_TO_UNDO is a refusal", async () => {
  const { bus, calls, events } = harness();
  bus.push({ kind: "undo", label: "Hoàn tác" });
  calls[0]!.d.reject(new TypeError("fetch failed"));
  await tick();
  expect(events.at(-1)).toMatchObject({ type: "failed", message: "fetch failed" });
  expect(bus.pending).toBe(1);
  bus.retry();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.body).toEqual({ baseRevision: 5, pageId: "pg" });
  calls[1]!.d.reject(fail("NOTHING_TO_UNDO"));
  await tick();
  expect(events.at(-1)).toMatchObject({ type: "refused" });
  expect(bus.push({ kind: "redo", label: "Làm lại" })).toBe(true);
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `npx vitest run tests/unit/command-bus.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Cài đặt** — `src/app/p/[id]/editor/visual/command-bus.ts`:

```ts
// E3 §1/§6/§7 command bus (pure: the transport is injected): one request in flight, at most 20 user actions waiting,
// each action one batch = one Undo step, sent with the revision the previous step produced. Light edits are applied
// optimistically at push and rolled back when the server refuses them (R16).
import type { Affected } from "@/core/editor-canvas";
import type { EditorCommand } from "@/core/ir-command";

export const BUS_LIMITS = { queue: 20 } as const;
export type StepResult = { revision: number; createdIds: string[]; canUndo: boolean; canRedo: boolean; affected?: Affected };
export type Op =
  | { kind: "commands"; label: string; commands: EditorCommand[]; done?: string; apply?(): void; rollback?(): void }
  | { kind: "undo" | "redo"; label: string; done?: string };
export type SendBody = { baseRevision: number; pageId: string; commands?: EditorCommand[] };
export type Send = (op: Op, body: SendBody) => Promise<StepResult>;
export type BusEvent =
  | { type: "saving"; pending: number }
  | { type: "done"; op: Op; result: StepResult }
  | { type: "refused"; op: Op; message: string }
  | { type: "stale"; revision?: number }
  | { type: "unwritten"; revision: number }
  | { type: "failed"; op: Op; message: string }
  | { type: "full" };
type SendError = { code?: string; revision?: number; message?: string };
const RELOAD = new Set(["STALE_REVISION", "PROJECT_BUSY", "BAD_STATE"]);
const REFUSED = new Set(["IR_PATCH_INVALID", "VALIDATION", "PAYLOAD_TOO_LARGE", "NOTHING_TO_UNDO", "NOTHING_TO_REDO", "NOT_FOUND"]);
const undo = (ops: Op[]) => [...ops].reverse().forEach((o) => o.kind === "commands" && o.rollback?.()); // newest first

export class CommandBus {
  private queue: Op[] = [];
  private busy = false;
  private stop: "none" | "retry" | "reload" = "none";
  constructor(private rev: number, private readonly pageId: string, private readonly send: Send, private readonly emit: (e: BusEvent) => void) {}
  get pending(): number { return this.queue.length + (this.busy ? 1 : 0); }
  get revision(): number { return this.rev; }

  push(op: Op): boolean {
    if (this.stop === "reload") return false;
    if (this.queue.length >= BUS_LIMITS.queue) { this.emit({ type: "full" }); return false; }
    if (op.kind === "commands") op.apply?.();
    this.queue.push(op);
    this.emit({ type: "saving", pending: this.pending });
    void this.pump();
    return true;
  }
  retry(): void {
    if (this.stop !== "retry") return;
    this.stop = "none";
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.busy || this.stop !== "none") return;
    const op = this.queue.shift();
    if (!op) return;
    this.busy = true;
    try {
      const result = await this.send(op, { baseRevision: this.rev, pageId: this.pageId, ...(op.kind === "commands" && { commands: op.commands }) });
      this.rev = result.revision;
      this.busy = false;
      this.emit({ type: "done", op, result });
    } catch (e) {
      this.busy = false;
      const err = e as SendError, message = err.message ?? String(e);
      if (err.code && RELOAD.has(err.code)) {
        undo([op, ...this.queue]);
        this.queue = [];
        this.stop = "reload";
        this.emit({ type: "stale", ...(typeof err.revision === "number" && { revision: err.revision }) });
      } else if (err.code === "DOCUMENT_MATERIALIZE_FAILED" && typeof err.revision === "number") {
        this.rev = err.revision; // committed: only the output is behind
        undo(this.queue);
        this.queue = [];
        this.stop = "reload";
        this.emit({ type: "unwritten", revision: err.revision });
      } else if (err.code && REFUSED.has(err.code)) {
        if (op.kind === "commands") op.rollback?.();
        this.emit({ type: "refused", op, message });
      } else {
        this.queue.unshift(op);
        this.stop = "retry";
        this.emit({ type: "failed", op, message });
      }
    }
    void this.pump();
  }
}
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/command-bus.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/command-bus.ts" tests/unit/command-bus.test.ts
git commit -m "feat(e3): command bus — one request in flight, 20 queued, optimistic apply + rollback per server answer

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Khung editor mới + canvas iframe + "Editor cũ"

**Files:**
- Create: `src/app/p/[id]/editor/visual/canvas.tsx`, `src/app/p/[id]/editor/visual/visual-editor.tsx`
- Modify: `src/app/p/[id]/editor/page.tsx`, `src/app/p/[id]/editor/editor-view.tsx` (link "Editor mới"), `src/app/globals.css` (khối `.ve`), `scripts/gen-icons.mjs` + `src/app/_ui/icons.gen.ts` + `tests/unit/icons.test.ts` (+9 icon), `docs/superpowers/design/stitch-screens.md`
- Modify (đổi URL sang `?legacy=1`): `tests/e2e/editor-smoke.test.ts:342,420,447,602`, `tests/e2e/editor-components.test.ts:59,121`
- Test: `tests/e2e/visual-editor.test.ts` (mới)

**Interfaces:**
- Consumes: `CommandBus`, `Op`, `StepResult`, `BusEvent` (Task 7); `indexPage`, `bodyOf`, `pickTarget`, `parentOf`, `siblingsOf`, `isTextHost`, `keyAction`, `BPS`, `Bp`, `Batch` (Task 5); payload GET (Task 4).
- Produces:

```ts
// canvas.tsx
export type CanvasHandle = { doc(): Document | null; element(id: string): HTMLElement | null; replace(a: Affected, rootOf: (sectionId: string) => string | undefined): boolean; post(message: unknown): void; frame(): HTMLIFrameElement | null };
export function Canvas(props: { ref?: Ref<CanvasHandle>; frameKey: number; html: string; css: string; width: number; showItems: { root: string; index: number }[]; children?: ReactNode; onPick(id: string, shift: boolean): void; onDouble(id: string): void; onHover(id: string | null): void; onKey(e: KeyboardEvent): void; onFrame(): void }): JSX.Element;
// visual-editor.tsx
export type EditorData = CanvasPayload & { revision: number; canUndo: boolean; canRedo: boolean; interactives: PanelComponent[]; shot: string; assets: LibraryAsset[] };
export function VisualEditor(props: { projectId: string; initialPage: string }): JSX.Element;
// inside VisualEditor (later tasks extend these): select(ids), run(op), commands(list, label, extra?), batch(b, label), onKey(e), double(id)
```

- [ ] **Step 1: Thêm icon và cập nhật test icon (đỏ trước)**

`scripts/gen-icons.mjs` — thêm dòng vào `NAMES` (trước `// sitemap`):

```js
  // visual editor E3a (layer tree types, upload)
  "title", "link", "touch_app", "input", "movie", "shapes", "widgets", "crop_square", "upload",
```

`tests/unit/icons.test.ts`: đổi `74` → `83` ở tên test và hai `expect`.

Run: `npx vitest run tests/unit/icons.test.ts`
Expected: FAIL — `ICONS` chưa có 9 tên mới. Rồi `npm run icons` → Expected: `gen-icons: 83 icons`; chạy lại test → PASS.

- [ ] **Step 2: Viết e2e đỏ** — `tests/e2e/visual-editor.test.ts`:

```ts
// E3a: the visual editor over a real site1 clone (pipeline, AI stubbed) in a `next build` app. Tests run in order on
// one project; each restores what it changed.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type FrameLocator, type Page } from "playwright";
import { serveDir } from "@/core/serve";
import { offline } from "./offline-deps";
import { startNextApp } from "./next-app";
import { expectIconButtonsLabelled, expectNoDrift, expectUi } from "./ui-checks";

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let site: { url: string; close(): Promise<void> } | undefined;
let db: DatabaseSync | undefined;
let tmp = "";
let projectId = "";

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "visual-editor-"));
  const env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  process.env.WORKSPACE_ROOT = env.WORKSPACE_ROOT;
  const [{ openDb }, { createProject, enqueue, runProject }, { settled }] = await Promise.all([import("@/core/db"), import("@/core/jobs"), import("@/core/event-log")]);
  site = await serveDir(fileURLToPath(new URL("../fixtures/site1", import.meta.url)));
  db = openDb(env.DB_PATH);
  projectId = createProject(db, { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0 } });
  await enqueue(db, projectId, [`${site.url}/index.html`]);
  await runProject(db, projectId, { deps: offline });
  await settled(projectId); // finished before next start: recoverOnStartup must not see it running
  browser = await chromium.launch();
  app = await startNextApp(env);
}, 600_000);
afterAll(async () => { await browser?.close(); await site?.close(); app?.stop(); db?.close(); if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

type Tree = { id: string; tag: string; name?: string; text?: string; children: Tree[] };
type Payload = { revision: number; page: { id: string; sections: { id: string; root: Tree }[] } };
const canvas = (page: Page): FrameLocator => page.frameLocator('[data-ui="ui_editor_canvas_frame"]');
const payload = async (): Promise<Payload> => (await (await fetch(`${app!.base}/api/projects/${projectId}/editor`)).json()) as Payload;
const outHtml = async () => (await fetch(`${app!.base}/api/projects/${projectId}/files/out/index.html`)).text();
const status = (page: Page) => page.getByRole("status");
const saved = (page: Page) => expect.poll(() => page.locator('[data-ui="ui_editor_save_state"]').innerText(), { timeout: 30_000 }).toBe("Đã lưu");
const walk = (n: Tree): Tree[] => [n, ...n.children.flatMap(walk)];
const allNodes = async () => (await payload()).page.sections.flatMap((s) => walk(s.root));
const noSideScroll = (page: Page) => page.evaluate(() => document.scrollingElement!.scrollWidth <= window.innerWidth);
async function open(width = 1440, height = 1000): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.goto(`${app!.base}/p/${projectId}/editor`);
  await canvas(page).locator("h1").waitFor({ timeout: 30_000 });
  return page;
}

test("E3a shell: the new editor by default — sandboxed srcdoc frame based on out/, one runtime script, CSP; links never navigate; breakpoints resize the frame; Editor cũ keeps GrapesJS; no sideways scroll at 1440", { timeout: 120_000 }, async () => {
  const page = await open();
  const frame = page.locator('[data-ui="ui_editor_canvas_frame"]');
  expect(await frame.getAttribute("sandbox")).toBe("allow-same-origin allow-scripts");
  const h1 = canvas(page).locator("h1");
  expect(await h1.innerText()).toBe("Build faster sites");
  expect(await h1.evaluate(() => document.baseURI)).toBe(`${app!.base}/api/projects/${projectId}/files/out/index.html`);
  expect(await h1.evaluate(() => [...document.scripts].map((s) => s.src))).toEqual([`${app!.base}/api/projects/${projectId}/files/out/js/runtime.js?edit=1`]);
  expect(await h1.evaluate(() => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "")).toContain("script-src ");
  await canvas(page).getByRole("link", { name: "Features" }).click();
  expect(await h1.evaluate(() => location.href)).toBe("about:srcdoc");
  await expectUi(page, ["ui_editor_page_header", "ui_editor_toolbar", "ui_editor_bp_switch", "ui_editor_save_state", "ui_editor_legacy_link", "ui_editor_layers", "ui_editor_canvas_chrome", "ui_editor_canvas_frame", "ui_editor_right_tabs"]);
  expect(await page.getByRole("group", { name: "Thiết bị" }).getByRole("button").allInnerTexts()).toEqual(["1440", "768", "375"]);
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "768" }).click();
  await expect.poll(() => frame.evaluate((f) => f.getBoundingClientRect().width)).toBe(768);
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "1440" }).click();
  expect(await noSideScroll(page)).toBe(true);
  await expectIconButtonsLabelled(page);
  await expectNoDrift(page);
  await page.getByRole("link", { name: "Editor cũ" }).click();
  await page.waitForURL(/legacy=1/);
  await page.frameLocator("iframe.gjs-frame").locator("h1").waitFor({ timeout: 30_000 });
  await page.getByRole("link", { name: "Editor mới" }).click();
  await canvas(page).locator("h1").waitFor({ timeout: 30_000 });
  await page.close();
});
```

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor.test.ts`
Expected: FAIL — `ui_editor_canvas_frame` không tồn tại (trang vẫn là GrapesJS).

- [ ] **Step 3: Cài đặt `canvas.tsx`**

```tsx
"use client";
// E3 §1 canvas: the server's canvas document in a sandboxed srcdoc frame (same origin: the parent reads its DOM and
// wires events; no script is injected). Clicks select instead of acting, links and forms never navigate (§8).
// Partial updates swap section roots by data-ir-id and the inline stylesheet; a missing root -> the caller reloads.
import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import type { Affected } from "@/core/editor-canvas";

export type CanvasHandle = {
  doc(): Document | null;
  element(id: string): HTMLElement | null;
  replace(a: Affected, rootOf: (sectionId: string) => string | undefined): boolean;
  post(message: unknown): void;
  frame(): HTMLIFrameElement | null;
};
type Props = {
  ref?: Ref<CanvasHandle>;
  frameKey: number;
  html: string;
  css: string;
  width: number;
  showItems: { root: string; index: number }[];
  children?: ReactNode;
  onPick(id: string, shift: boolean): void;
  onDouble(id: string): void;
  onHover(id: string | null): void;
  onKey(e: KeyboardEvent): void;
  onFrame(): void;
};
// cross-realm: frame nodes are not instances of this window's Element
const idOf = (t: EventTarget | null): string | null => {
  const node = t as (Node & Partial<Element>) | null;
  const el = node && typeof node.closest === "function" ? (node as Element) : node?.parentElement ?? null;
  return el?.closest("[data-ir-id]")?.getAttribute("data-ir-id") ?? null;
};

export function Canvas({ ref, frameKey, html, css, width, showItems, children, ...on }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(600);
  const events = useRef(on);
  events.current = on;
  const shown = useRef(showItems);
  shown.current = showItems;
  const doc = () => frame.current?.contentDocument ?? null;
  const setCss = (text: string) => {
    const style = doc()?.querySelector("style[data-aiwc-css]");
    if (style && style.textContent !== text) style.textContent = text;
  };
  // edit-mode runtime: lay carousels / tabs out at their captured item (R8 of E2)
  const show = () => { for (const s of shown.current) frame.current?.contentWindow?.postMessage({ type: "aiwc:show", root: s.root, index: s.index }, "*"); };
  useImperativeHandle(ref, () => ({
    doc,
    frame: () => frame.current,
    element: (id) => doc()?.querySelector<HTMLElement>(`[data-ir-id="${CSS.escape(id)}"]`) ?? null,
    replace(a, rootOf) {
      const d = doc();
      if (!d) return false;
      for (const s of a.sections) {
        const root = rootOf(s.id);
        const els = root ? d.querySelectorAll(`[data-ir-id="${CSS.escape(root)}"]`) : null;
        if (!els?.length) return false;
        els.forEach((el) => { el.outerHTML = s.html; });
      }
      setCss(a.css);
      show();
      events.current.onFrame();
      return true;
    },
    post: (m) => frame.current?.contentWindow?.postMessage(m, "*"),
  }));
  useEffect(() => setCss(css), [css]);
  useEffect(() => {
    const el = pane.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(Math.max(200, el.clientHeight - 2)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const onLoad = () => {
    const d = doc(), w = frame.current?.contentWindow;
    if (!d || !w) return;
    setCss(css);
    const stop = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
    d.addEventListener("click", (e) => { stop(e); const id = idOf(e.target); if (id) events.current.onPick(id, e.shiftKey); }, true);
    d.addEventListener("dblclick", (e) => { stop(e); const id = idOf(e.target); if (id) events.current.onDouble(id); }, true);
    d.addEventListener("auxclick", stop, true);
    d.addEventListener("submit", stop, true);
    let last: string | null = null;
    d.addEventListener("mousemove", (e) => { const id = idOf(e.target); if (id !== last) { last = id; events.current.onHover(id); } });
    d.documentElement.addEventListener("mouseleave", () => { last = null; events.current.onHover(null); });
    d.addEventListener("keydown", (e) => events.current.onKey(e));
    w.addEventListener("scroll", () => events.current.onFrame(), { passive: true });
    new ResizeObserver(() => events.current.onFrame()).observe(d.documentElement);
    show();
    events.current.onFrame();
  };
  return (
    <div className="ve-pane" data-ui="ui_editor_canvas_chrome" ref={pane}>
      <div className="ve-stage" style={{ width, height }}>
        <iframe key={frameKey} ref={frame} data-ui="ui_editor_canvas_frame" title="Canvas" sandbox="allow-same-origin allow-scripts" srcDoc={html} onLoad={onLoad} style={{ width, height }} />
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Cài đặt `visual-editor.tsx`** (khung; Task 9–13 thêm overlay, layer tree, phím sửa, sửa chữ, bảng phải)

```tsx
"use client";
// E3 visual editor (spec §1–§4): the server's page in a canvas frame, the command bus for every edit, partial canvas
// updates from `affected`. Selection lives here; panels render from the resolved page tree (model.indexPage).
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { CanvasPayload } from "@/core/editor-canvas";
import type { PanelComponent } from "@/core/interactive";
import type { EditorCommand } from "@/core/ir-command";
import type { LibraryAsset } from "@/core/upload";
import { api, errorText } from "@/app/_ui/api";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { IconButton } from "@/app/_ui/IconButton";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { Canvas, type CanvasHandle } from "./canvas";
import { CommandBus, type BusEvent, type Op, type StepResult } from "./command-bus";
import { BPS, indexPage, keyAction, parentOf, pickTarget, siblingsOf, type Batch, type Bp, type DocIndex } from "./model";

export type EditorData = CanvasPayload & { revision: number; canUndo: boolean; canRedo: boolean; interactives: PanelComponent[]; shot: string; assets: LibraryAsset[] };
type Halt = { kind: "stale" | "unwritten" | "failed"; text: string };
type RightTab = "style" | "component" | "effects";
type CommandsOp = Extract<Op, { kind: "commands" }>;
const DONE: Record<Op["kind"], string> = { commands: "Đã lưu — điểm QA cần chạy lại", undo: "Đã hoàn tác — điểm QA cần chạy lại", redo: "Đã làm lại — điểm QA cần chạy lại" };
const typingIn = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName ?? "")); };

export function VisualEditor({ projectId: id, initialPage }: { projectId: string; initialPage: string }) {
  const [pageId, setPageId] = useState(initialPage); // "" = the API's default page
  const [load, setLoad] = useState(0); // bumped: refetch + a fresh frame (shellChanged, Tải lại, a drifted frame)
  const [data, setData] = useState<EditorData | null>(null);
  const [bp, setBp] = useState<Bp>(1440);
  const [selection, setSelection] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [tick, setTick] = useState(0); // the frame scrolled / resized / changed: overlays re-measure
  const [msg, setMsg] = useState("");
  const [halt, setHalt] = useState<Halt | null>(null);
  const [pending, setPending] = useState(0);
  const [saved, setSaved] = useState(false);
  const [tab, setTab] = useState<RightTab>("style");
  const canvas = useRef<CanvasHandle>(null);
  const bus = useRef<CommandBus | null>(null);
  const index: DocIndex = useMemo(() => (data ? indexPage(data.page) : new Map()), [data]);
  const live = useRef({ data, index, selection });
  live.current = { data, index, selection };

  const send = (op: Op, body: object) => api<StepResult>(`/api/projects/${id}/editor/${op.kind}`, { body });
  const applyResult = (r: StepResult) => {
    const a = r.affected, d = live.current.data;
    if (!d) return;
    const roots = new Map(d.page.sections.map((s) => [s.id, s.root.id]));
    if (!a || a.shellChanged || !canvas.current?.replace(a, (sid) => roots.get(sid))) return setLoad((x) => x + 1);
    const fresh = new Map(a.sections.map((s) => [s.id, s.root]));
    setData((cur) => cur && {
      ...cur, css: a.css, interactives: a.interactives, revision: r.revision, canUndo: r.canUndo, canRedo: r.canRedo,
      page: { ...cur.page, sections: cur.page.sections.map((s) => (fresh.has(s.id) ? { ...s, root: fresh.get(s.id)! } : s)) },
    });
    setSelection((s) => (r.createdIds.length ? r.createdIds : s));
  };
  const onEvent = (e: BusEvent) => {
    setPending(bus.current?.pending ?? 0);
    switch (e.type) {
      case "saving": return;
      case "done": setSaved(true); setMsg(e.op.done ?? DONE[e.op.kind]); return applyResult(e.result);
      case "refused": return setMsg(e.message);
      case "full": return setMsg("Đang lưu… chờ chút");
      case "stale": {
        const text = `Dự án đã thay đổi ở nơi khác${e.revision !== undefined ? ` (revision ${e.revision})` : ""}. Tải lại để tiếp tục.`;
        setMsg(text);
        return setHalt({ kind: "stale", text });
      }
      case "unwritten": return setHalt({ kind: "unwritten", text: "Đã lưu nhưng chưa ghi được bản xuất — thử lại sau ít phút." });
      case "failed": return setHalt({ kind: "failed", text: `Chưa lưu được: ${e.message}` });
    }
  };

  useEffect(() => {
    let cancelled = false;
    api<EditorData>(`/api/projects/${id}/editor${pageId ? `?page=${encodeURIComponent(pageId)}` : ""}`).then(
      (d) => {
        if (cancelled) return;
        const next = indexPage(d.page);
        setData(d);
        setHalt(null);
        setSelection((s) => s.filter((x) => next.has(x)));
        bus.current = new CommandBus(d.revision, d.page.id, send, onEvent);
        setPending(0);
      },
      (e: unknown) => {
        if (cancelled) return;
        // a stale or mistyped ?page= falls back to the default page
        if (pageId !== "" && pageId === initialPage && (e as { code?: string }).code === "NOT_FOUND") return setPageId("");
        setMsg(errorText(e));
      },
    );
    return () => { cancelled = true; };
  }, [id, pageId, load, initialPage]); // send / onEvent read `live` and setters only: no stale state

  const run = (op: Op): boolean => { setMsg(""); return bus.current?.push(op) ?? false; };
  const commands = (list: EditorCommand[], label: string, extra: Partial<CommandsOp> = {}) => run({ kind: "commands", commands: list, label, ...extra });
  const batch = (b: Batch, label: string, extra: Partial<CommandsOp> = {}) => ("error" in b ? (setMsg(b.error), false) : commands(b.commands, label, extra));
  const select = (ids: string[]) => setSelection(ids);
  // spec §2: the deepest pickable node; Shift toggles it in the selection. flushSync: the overlay is drawn in the
  // same task as the click (§9 hiệu năng)
  const pick = (raw: string, shift: boolean) => {
    const target = pickTarget(live.current.index, raw);
    if (!target) return;
    flushSync(() => setSelection((s) => (shift ? (s.includes(target) ? s.filter((x) => x !== target) : [...s, target]) : [target])));
  };
  // R18: a container goes down to its first element child (a text host: Task 12 starts inline editing first)
  const double = (raw: string) => {
    const target = pickTarget(live.current.index, raw);
    const child = target ? live.current.index.get(target)?.children[0] : undefined;
    if (child) select([child]);
  };
  const onKey = (e: KeyboardEvent) => {
    const action = keyAction(e, typingIn(e.target));
    if (!action) return;
    const { index: ix, selection: sel } = live.current, first = sel[0];
    switch (action) {
      case "parent": { e.preventDefault(); const p = first ? parentOf(ix, first) : undefined; return select(p ? [p] : []); }
      case "child": { e.preventDefault(); const c = first ? ix.get(first)?.children[0] : undefined; if (c) select([c]); return; }
      case "siblings": { if (!first) return; e.preventDefault(); return select(siblingsOf(ix, first)); }
      default: return;
    }
  };
  const keyRef = useRef(onKey);
  keyRef.current = onKey;
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  const showItems = (data?.interactives ?? []).flatMap((c) => (c.spec.kind === "carousel" || c.spec.kind === "tabs" ? [{ root: c.rootId, index: c.spec.active }] : []));
  const reload = () => { setHalt(null); setMsg(""); setLoad((x) => x + 1); };
  return (
    <div className="ve">
      <div className="editor-toolbar" data-ui="ui_editor_toolbar">
        <label className="inline-field">
          <span className="field-label">Trang</span>
          <select value={data?.page.id ?? ""} onChange={(e) => setPageId(e.target.value)} disabled={pending > 0}>
            {data?.pages.map((p) => <option key={p.id} value={p.id}>{p.path}</option>)}
          </select>
        </label>
        <SegmentedControl<string> label="Thiết bị" data-ui="ui_editor_bp_switch" value={String(bp)} onChange={(v) => setBp(Number(v) as Bp)} options={BPS.map((w) => ({ value: String(w), label: String(w) }))} />
        <IconButton icon="undo" label="Hoàn tác" onClick={() => run({ kind: "undo", label: "Hoàn tác" })} disabled={!data?.canUndo || !!halt} />
        <IconButton icon="redo" label="Làm lại" onClick={() => run({ kind: "redo", label: "Làm lại" })} disabled={!data?.canRedo || !!halt} />
        <span className="t-label-md text-2" data-ui="ui_editor_save_state" aria-live="polite">{pending > 0 ? "Đang lưu…" : "Đã lưu"}</span>
        <span role="status" className="t-label-md text-2">{msg}</span>
        {saved && <Link href={`/p/${id}/preview`}>Mở Preview</Link>}
        <Link className="ve-legacy" data-ui="ui_editor_legacy_link" href={`/p/${id}/editor?legacy=1${data ? `&page=${encodeURIComponent(data.page.id)}` : ""}`}>Editor cũ</Link>
      </div>
      {halt && (
        <Banner tone={halt.kind === "stale" ? "warn" : "danger"} icon="warning" data-ui="ui_editor_stale_banner" title={halt.text}
          actions={halt.kind === "failed"
            ? <Button icon="refresh" onClick={() => { setHalt(null); bus.current?.retry(); }}>Thử lại</Button>
            : <Button icon="refresh" onClick={reload}>Tải lại</Button>} />
      )}
      <div className="ve-grid">
        <aside className="ve-left panel" data-ui="ui_editor_layers" aria-label="Layers">
          <h2 className="t-label-md upper">Layers</h2>
        </aside>
        {data ? (
          <Canvas ref={canvas} frameKey={load} html={data.page.html} css={data.css} width={bp} showItems={showItems}
            onPick={pick} onDouble={double} onHover={setHover} onKey={onKey} onFrame={() => setTick((t) => t + 1)} />
        ) : <div className="ve-pane" data-ui="ui_editor_canvas_chrome" />}
        <aside className="ve-right panel">
          <SegmentedControl<RightTab> label="Bảng bên phải" semantics="tabs" data-ui="ui_editor_right_tabs" value={tab} onChange={setTab}
            options={[{ value: "style", label: "Style" }, { value: "component", label: "Component" }, { value: "effects", label: "Hiệu ứng" }]} />
        </aside>
      </div>
    </div>
  );
}
```

(`hover`, `tick`, `batch`, `commands` được Task 9–13 dùng; `tsconfig` không bật `noUnusedLocals`, repo không có ESLint.)

- [ ] **Step 5: `page.tsx`, link "Editor mới", CSS**

`src/app/p/[id]/editor/page.tsx`:

```tsx
import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { loadProject } from "../data";
import { EditorView } from "./editor-view";
import { VisualEditor } from "./visual/visual-editor";

// ?page=<pageId> (the preview's "Sửa trong editor") opens that page; an unknown id falls back to the first page.
// ?legacy=1: the GrapesJS editor ("Editor cũ", E3a R15) until E3b removes it.
export default async function EditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string | string[]; legacy?: string | string[] }> }) {
  const [{ id }, { page, legacy }] = await Promise.all([params, searchParams]);
  const project = loadProject(id);
  const initialPage = typeof page === "string" ? page : "";
  return (
    <>
      <PageHeader data-ui="ui_editor_page_header" crumbs={projectCrumbs(project.url, id, "Editor")} title="Editor" />
      {legacy === "1" ? <EditorView projectId={id} initialPage={initialPage} /> : <VisualEditor projectId={id} initialPage={initialPage} />}
    </>
  );
}
```

`editor-view.tsx`: trong `editor-toolbar`, sau link "Mở Preview" thêm `<Link href={`/p/${id}/editor${project ? `?page=${encodeURIComponent(project.pageId)}` : ""}`}>Editor mới</Link>`.

`src/app/globals.css` — sau khối `/* === Screen: editor === */` thêm:

```css
/* === Screen: visual editor (E3) === */
.ve { display: flex; flex-direction: column; gap: var(--s-sm); min-width: 0; }
.ve-grid { display: grid; grid-template-columns: 240px minmax(0, 1fr) 300px; gap: var(--s-sm); height: calc(100vh - 210px); min-height: 480px; }
.ve-left, .ve-right { min-width: 0; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: var(--s-sm); padding: var(--s-sm); }
.ve-pane { position: relative; min-width: 0; min-height: 0; overflow: auto; background: var(--c-surface-lowest); border: 1px solid var(--c-border); border-radius: var(--r-md); }
.ve-stage { position: relative; margin: 0 auto; }
.ve-stage iframe { display: block; border: 0; background: #fff; }
.ve-legacy { margin-inline-start: auto; }
@media (max-width: 1099px) { .ve-grid { grid-template-columns: minmax(0, 1fr); height: auto; } .ve-pane { height: 70vh; } }
```

`docs/superpowers/design/stitch-screens.md` — đổi tiêu đề mục thành `` ## `/p/[id]/editor` ↔ `screen_editor` — visual editor E3 (GrapesJS ở "Editor cũ" tới hết E3a), không có mockup Stitch (chỉ token + chrome) ``; sửa dòng `ui_editor_toolbar` (API: `GET …/editor`, `POST …/editor/{commands,undo,redo}` + `pageId`, `?page=`, `?legacy=1`) và `ui_editor_canvas_chrome` (khung canvas E3; GrapesJS chỉ ở `?legacy=1`); thêm các dòng (cột Mockup ghi "không có trong mockup, dùng token/component sẵn có", trạng thái `build`):

```
| `ui_editor_canvas_frame` | `feat_editor`, `feat_ir` | E3 §1 iframe `srcdoc` sandbox (`page.html` của `GET …/editor`), click → chọn, link/form không điều hướng | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_bp_switch` | `feat_editor` | E3 §1 SegmentedControl "Thiết bị" 1440/768/375 = độ rộng iframe + `target` của setStyle | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_save_state` | `feat_editor` | E3 §4 "Đã lưu" / "Đang lưu…" theo command bus | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_legacy_link` | `feat_editor` | E3 §2 link "Editor cũ" → `?legacy=1` (chỉ E3a) | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_stale_banner` | `feat_editor` | E3 §7 Banner "Tải lại" (409) / "Thử lại" (lỗi mạng, 503) | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_layers` | `feat_editor`, `feat_ir` | E3 §4 cột trái Layers | không có trong mockup, dùng token/component sẵn có | build |
| `ui_editor_right_tabs` | `feat_editor` | E3 §4 tab Style / Component / Hiệu ứng | không có trong mockup, dùng token/component sẵn có | build |
```

- [ ] **Step 6: Chuyển e2e GrapesJS sang `?legacy=1`**

`tests/e2e/editor-components.test.ts` dòng 59 và 121: `/p/${projectId}/editor` → `/p/${projectId}/editor?legacy=1`. `tests/e2e/editor-smoke.test.ts`: dòng 342 thêm sau `waitForURL(/\/editor$/)`: `await page.goto(`${base}/p/${projectId}/editor?legacy=1`);`; dòng 420 `?page=${pageId}` → `?page=${pageId}&legacy=1`; dòng 447 `?page=nope` → `?page=nope&legacy=1`; dòng 602 `/p/${id}/editor` → `/p/${id}/editor?legacy=1`.

- [ ] **Step 7: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/icons.test.ts && npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor.test.ts tests/e2e/editor-smoke.test.ts tests/e2e/editor-components.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/canvas.tsx" "src/app/p/[id]/editor/visual/visual-editor.tsx" "src/app/p/[id]/editor/page.tsx" "src/app/p/[id]/editor/editor-view.tsx" src/app/globals.css scripts/gen-icons.mjs src/app/_ui/icons.gen.ts tests/unit/icons.test.ts docs/superpowers/design/stitch-screens.md tests/e2e/visual-editor.test.ts tests/e2e/editor-smoke.test.ts tests/e2e/editor-components.test.ts
git commit -m "feat(e3): visual editor shell — sandboxed srcdoc canvas, command bus wiring, breakpoints, Editor cũ link

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Overlay hover/chọn/spacing + hiệu năng 5 000 node

**Files:**
- Create: `src/app/p/[id]/editor/visual/overlay.tsx`, `tests/e2e/visual-editor-perf.test.ts`
- Modify: `src/app/p/[id]/editor/visual/visual-editor.tsx`, `src/app/globals.css`, `docs/superpowers/design/stitch-screens.md`
- Test: `tests/e2e/visual-editor.test.ts` (append), `tests/e2e/visual-editor-perf.test.ts`

**Interfaces:**
- Consumes: `bands`, `Box`, `labelOf` (Task 5); `CanvasHandle.element` (Task 8).
- Produces:

```ts
export type Measured = { box: Box; margin: [number, number, number, number]; padding: [number, number, number, number] };
export function measure(el: Element): Measured;
export function Overlay(props: { zoom: number; hover?: { id: string; m: Measured; label: string }; selected: { id: string; m: Measured }[]; parent?: Measured; children?: ReactNode }): JSX.Element;
```

- [ ] **Step 1: Viết e2e đỏ** — append `tests/e2e/visual-editor.test.ts`:

```ts
test("E3a select/hover: hover label tag · name · W×H; click selects the deepest node (box on it) with margin/padding bands and the parent outlined; Shift+click toggles; Esc parent, Ctrl+Enter child, Ctrl+A siblings", { timeout: 120_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  const h1Id = (await h1.getAttribute("data-ir-id"))!;
  await h1.hover();
  const hoverBox = page.locator('[data-ui="ui_editor_hover_box"]');
  await expect.poll(() => hoverBox.getAttribute("data-for")).toBe(h1Id);
  expect(await hoverBox.innerText()).toMatch(/^h1 · .+ · \d+×\d+$/);
  await h1.click();
  const sel = page.locator('[data-ui="ui_editor_selection_box"]');
  await expect.poll(() => sel.first().getAttribute("data-for")).toBe(h1Id);
  const [hb, sb] = [(await h1.boundingBox())!, (await sel.first().boundingBox())!];
  expect(Math.abs(sb.x - hb.x) + Math.abs(sb.y - hb.y) + Math.abs(sb.width - hb.width)).toBeLessThan(3);
  expect(await page.locator('[data-ui="ui_editor_spacing"]').count()).toBeGreaterThan(0);
  expect(await page.locator('[data-ui="ui_editor_parent_box"]').count()).toBe(1);
  const para = canvas(page).getByText("Plain paragraph text.");
  await para.click({ modifiers: ["Shift"] });
  await expect.poll(() => sel.count()).toBe(2);
  await para.click({ modifiers: ["Shift"] });
  await expect.poll(() => sel.count()).toBe(1);
  const heroId = await h1.evaluate((el) => el.parentElement!.getAttribute("data-ir-id"));
  await page.keyboard.press("Escape");
  await expect.poll(() => sel.first().getAttribute("data-for")).toBe(heroId);
  await page.keyboard.press("Control+Enter");
  await expect.poll(() => sel.first().getAttribute("data-for")).toBe(h1Id);
  await page.keyboard.press("Control+a");
  await expect.poll(() => sel.count()).toBe(2); // h1 + p of the hero
  // a hidden node (site1 .secret, display:none) is never selectable on the canvas
  expect(await canvas(page).locator(".secret").isVisible()).toBe(false);
  await page.close();
});
```

`tests/e2e/visual-editor-perf.test.ts`:

```ts
// E3 §9 hiệu năng: a page of 5 000+ nodes — from the click to the drawn selection overlay under 50 ms (median of 5).
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { chromium, type Browser } from "playwright";
import type { CaptureNode, PageCapture } from "@/core/capture";
import { startNextApp } from "./next-app";

let app: { base: string; stop(): void } | undefined;
let browser: Browser;
let db: DatabaseSync | undefined;
let tmp = "";
let projectId = "";
const el = (tag: string, children: CaptureNode[] = [], text?: string): CaptureNode => ({ tag, attrs: {}, bbox: [0, 0, 100, 20], style: {}, children, ...(text ? { text } : {}) });
const card = (i: number, j: number) => el("div", [el("h3", [el("#text", [], `Thẻ ${i}.${j}`)]), el("p", [el("#text", [], "Nội dung thẻ")]), el("span")]);
// 50 sections x 20 cards x 6 nodes + html/head/body = 6 053 nodes
const bigDom = () => el("html", [el("head"), el("body", Array.from({ length: 50 }, (_, i) => el("section", Array.from({ length: 20 }, (_, j) => card(i, j)))))]);

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "visual-perf-"));
  const env = { DB_PATH: join(tmp, "sp1.db"), WORKSPACE_ROOT: join(tmp, "workspace"), KEY_PATH: join(tmp, "secret.key") };
  process.env.WORKSPACE_ROOT = env.WORKSPACE_ROOT;
  const [{ openDb }, { createProject, enqueue }, { buildIR }, { emitHtml }] = await Promise.all([import("@/core/db"), import("@/core/jobs"), import("@/core/ir"), import("@/core/emit-html")]);
  db = openDb(env.DB_PATH);
  projectId = createProject(db, { url: "http://big.test/", mode: "single", config: {} });
  await enqueue(db, projectId, ["http://big.test/"]);
  const ws = join(env.WORKSPACE_ROOT, projectId);
  const capture = {
    url: "http://big.test/", pageId: "home", capturedAt: "2026-10-07T00:00:00.000Z", title: "big", meta: {},
    cssom: { keyframes: [], fontFace: [], media: [], vars: {}, stateSelectors: [] },
    breakpoints: [1440, 768, 375].map((bp) => ({ bp, dom: bigDom(), truncated: false })),
    interactions: [], assets: {}, skippedAssets: [], dynamic: [],
  } as PageCapture;
  await mkdir(join(ws, "pages", "home"), { recursive: true });
  await writeFile(join(ws, "pages", "home", "capture.json"), JSON.stringify(capture));
  const ir = buildIR([capture]);
  await writeFile(join(ws, "ir.json"), JSON.stringify(ir));
  await emitHtml(ir, { outDir: join(ws, "out"), workspaceDir: ws, assetMap: {}, pageUrls: { home: "http://big.test/" } });
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path=? WHERE project_id=? AND phase='capture'").run("pages/home/capture.json", projectId);
  db.prepare("UPDATE tasks SET status='done',attempts=1,output_path='x' WHERE project_id=? AND phase<>'capture'").run(projectId);
  db.prepare("UPDATE projects SET status='completed' WHERE id=?").run(projectId);
  browser = await chromium.launch();
  app = await startNextApp(env);
}, 600_000);
afterAll(async () => { await browser?.close(); app?.stop(); db?.close(); if (tmp) await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

test("5 000-node page: click -> selection overlay drawn in under 50 ms (median of 5)", { timeout: 180_000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto(`${app!.base}/p/${projectId}/editor`);
  const frame = page.frameLocator('[data-ui="ui_editor_canvas_frame"]');
  await frame.locator("h3").first().waitFor({ timeout: 60_000 });
  expect(await frame.locator("[data-ir-id]").count()).toBeGreaterThanOrEqual(4000); // elements (+ #text nodes: > 5 000)
  const times: number[] = [];
  for (let k = 0; k < 5; k++) {
    times.push(await page.evaluate(async (k) => {
      const doc = document.querySelector<HTMLIFrameElement>('[data-ui="ui_editor_canvas_frame"]')!.contentDocument!;
      const els = doc.querySelectorAll("h3[data-ir-id]");
      const target = els[Math.floor((els.length * (k + 1)) / 6)] as HTMLElement;
      target.scrollIntoView({ block: "center" });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const id = target.getAttribute("data-ir-id");
      const t0 = performance.now();
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      await new Promise<void>((r) => {
        const check = () => ((document.querySelector('[data-ui="ui_editor_selection_box"]') as HTMLElement | null)?.dataset.for === id ? r() : requestAnimationFrame(check));
        check();
      });
      return performance.now() - t0;
    }, k));
  }
  times.sort((a, b) => a - b);
  expect(times[2]).toBeLessThan(50);
  await page.close();
});
```

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor.test.ts tests/e2e/visual-editor-perf.test.ts -t "select/hover|5 000"`
Expected: FAIL — không có `ui_editor_hover_box` / `ui_editor_selection_box`.

- [ ] **Step 2: Cài đặt `overlay.tsx`**

```tsx
"use client";
// E3 §2 overlay (in the parent window, over the frame): hover box + "tag · tên · W×H", selection boxes with margin
// (outside) / padding (inside) bands, the parent outlined. Coordinates: the frame's viewport px × zoom.
import type { CSSProperties, ReactNode } from "react";
import { bands, type Box } from "./model";

export type Measured = { box: Box; margin: [number, number, number, number]; padding: [number, number, number, number] };
export function measure(el: Element): Measured {
  const r = el.getBoundingClientRect(), cs = el.ownerDocument.defaultView!.getComputedStyle(el), px = (v: string) => parseFloat(v) || 0;
  return {
    box: { x: r.left, y: r.top, w: r.width, h: r.height },
    margin: [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)],
    padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
  };
}
const at = (b: Box, z: number): CSSProperties => ({ left: b.x * z, top: b.y * z, width: Math.max(0, b.w * z), height: Math.max(0, b.h * z) });

export function Overlay({ zoom, hover, selected, parent, children }: { zoom: number; hover?: { id: string; m: Measured; label: string }; selected: { id: string; m: Measured }[]; parent?: Measured; children?: ReactNode }) {
  return (
    <div className="ve-overlay" aria-hidden="true">
      {parent && <div className="ve-parent" data-ui="ui_editor_parent_box" style={at(parent.box, zoom)} />}
      {selected.map(({ id, m }) => (
        <div key={id}>
          {bands(m.box, m.margin, false).map((b, i) => <div key={`m${i}`} className="ve-margin" data-ui="ui_editor_spacing" style={at(b, zoom)} />)}
          {bands(m.box, m.padding, true).map((b, i) => <div key={`p${i}`} className="ve-padding" data-ui="ui_editor_spacing" style={at(b, zoom)} />)}
          <div className="ve-selected" data-ui="ui_editor_selection_box" data-for={id} style={at(m.box, zoom)} />
        </div>
      ))}
      {hover && (
        <div className="ve-hover" data-ui="ui_editor_hover_box" data-for={hover.id} style={at(hover.m.box, zoom)}>
          <span className="ve-label">{hover.label}</span>
        </div>
      )}
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Nối overlay vào `visual-editor.tsx`** (thêm import `labelOf` từ `./model`, `measure`, `Overlay` từ `./overlay`); trước `return`:

```tsx
  // measured on every render the selection, hover or frame (tick) changes: cheap getBoundingClientRect + computed style
  void tick;
  const measured = (nid: string) => { const el = canvas.current?.element(nid); return el ? measure(el) : undefined; };
  const selectedBoxes = selection.flatMap((sid) => { const m = measured(sid); return m ? [{ id: sid, m }] : []; });
  const parentId = selection.length === 1 ? parentOf(index, selection[0]!) : undefined;
  const parentBox = parentId ? measured(parentId) : undefined;
  const hoverId = hover ? pickTarget(index, hover) : undefined;
  const hoverM = hoverId ? measured(hoverId) : undefined;
  const hoverInfo = hoverId && hoverM ? { id: hoverId, m: hoverM, label: `${index.get(hoverId)!.node.tag} · ${labelOf(index.get(hoverId)!)} · ${Math.round(hoverM.box.w)}×${Math.round(hoverM.box.h)}` } : undefined;
```

và trong `<Canvas …>` đặt con: `<Overlay zoom={1} hover={hoverInfo} selected={selectedBoxes} parent={parentBox} />` (Canvas đổi từ tự đóng sang có children).

`globals.css`:

```css
.ve-overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.ve-hover { position: absolute; outline: 1px solid var(--c-accent); }
.ve-label { position: absolute; left: 0; bottom: 100%; font: var(--t-label-sm); background: var(--c-accent); color: var(--c-on-accent); padding: 1px 4px; white-space: nowrap; }
.ve-selected { position: absolute; outline: 2px solid var(--c-primary); }
.ve-parent { position: absolute; outline: 1px dashed var(--c-text-3); }
.ve-margin { position: absolute; background: color-mix(in srgb, var(--c-warn) 25%, transparent); }
.ve-padding { position: absolute; background: color-mix(in srgb, var(--c-success) 25%, transparent); }
```

`stitch-screens.md` thêm 4 dòng (`ui_editor_hover_box` "E3 §2 khung hover + nhãn `tag · tên · W×H`", `ui_editor_selection_box` "khung chọn đậm (nhiều khi Shift)", `ui_editor_spacing` "vùng margin/padding của node đang chọn", `ui_editor_parent_box` "node cha highlight nhẹ"), cột mockup như Task 8.

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor.test.ts tests/e2e/visual-editor-perf.test.ts`
Expected: PASS (median < 50 ms).

- [ ] **Step 5: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/overlay.tsx" "src/app/p/[id]/editor/visual/visual-editor.tsx" src/app/globals.css docs/superpowers/design/stitch-screens.md tests/e2e/visual-editor.test.ts tests/e2e/visual-editor-perf.test.ts
git commit -m "feat(e3): canvas overlay — hover label, selection with margin/padding bands, parent outline; 5k-node click < 50 ms

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Layer tree (ảo hoá, tìm, đổi tên, mắt, kéo thả)

**Files:**
- Create: `src/app/p/[id]/editor/visual/layer-tree.tsx`
- Modify: `src/app/p/[id]/editor/visual/visual-editor.tsx`, `src/app/globals.css`, `docs/superpowers/design/stitch-screens.md`
- Test: `tests/e2e/visual-editor.test.ts` (append)

**Interfaces:**
- Consumes: `layerRows`, `rowWindow`, `ROW_HEIGHT`, `ancestorsOf`, `dropCommand`, `hideBatch`, `renameBatch`, `bodyOf`, `Zone`, `Batch` (Task 5).
- Produces: `export function LayerTree(props: { index: DocIndex; rootId: string; components: readonly PanelComponent[]; selection: string[]; onSelect(ids: string[]): void; onBatch(b: Batch, label: string): void }): JSX.Element`.

- [ ] **Step 1: Viết e2e đỏ** — append:

```ts
// site1's three cards may be component instances (cards 2-3 share a structure): these tests edit the hero's h1 / p,
// which are plain nodes.
test("E3a layers: canvas ⇄ tree selection (auto-scroll), search by text, rename = setName, eye = hidden + display:none, drag in the tree = moveNode (ids kept)", { timeout: 180_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  const h1Id = (await h1.getAttribute("data-ir-id"))!;
  await h1.click();
  const row = (nid: string) => page.locator(`[data-ui="ui_editor_layer_row"][data-id="${nid}"]`);
  await expect.poll(() => row(h1Id).getAttribute("aria-selected")).toBe("true");
  expect(await row(h1Id).isVisible()).toBe(true);
  const para = canvas(page).getByText("Plain paragraph text.");
  const paraId = (await para.getAttribute("data-ir-id"))!;
  await row(paraId).click();
  await expect.poll(() => page.locator('[data-ui="ui_editor_selection_box"]').first().getAttribute("data-for")).toBe(paraId);
  // search by text keeps the match and its ancestors
  await page.getByRole("searchbox", { name: "Tìm lớp" }).fill("Static");
  await expect.poll(() => page.locator('[data-ui="ui_editor_layer_row"]').allInnerTexts()).toEqual(expect.arrayContaining([expect.stringContaining("Static")]));
  await page.getByRole("searchbox", { name: "Tìm lớp" }).fill("");
  // rename
  await row(h1Id).locator(".ve-layer-name").dblclick();
  await page.getByRole("textbox", { name: "Tên lớp" }).fill("Tiêu đề chính");
  await page.keyboard.press("Enter");
  await saved(page);
  await expect.poll(async () => (await allNodes()).find((x) => x.id === h1Id)?.name).toBe("Tiêu đề chính");
  await expect.poll(() => row(h1Id).innerText()).toContain("Tiêu đề chính");
  // eye: hidden on the canvas, back again
  await page.getByRole("button", { name: "Ẩn: Tiêu đề chính" }).click();
  await expect.poll(() => h1.evaluate((el) => getComputedStyle(el).display)).toBe("none");
  await page.getByRole("button", { name: "Hiện: Tiêu đề chính" }).click();
  await expect.poll(() => h1.evaluate((el) => getComputedStyle(el).display)).not.toBe("none");
  // drag the paragraph's row above the h1's row: same id, new order in out/
  await row(paraId).dragTo(row(h1Id), { targetPosition: { x: 20, y: 2 } });
  await saved(page);
  await expect.poll(async () => { const html = await outHtml(); return html.indexOf("Plain paragraph text.") < html.indexOf("Build faster sites"); }, { timeout: 30_000 }).toBe(true);
  expect(await canvas(page).locator(`[data-ir-id="${paraId}"]`).count()).toBe(1);
  for (let i = 0; i < 4; i++) { await page.getByRole("button", { name: "Hoàn tác" }).click(); await saved(page); } // drag, show, hide, rename
  await expect.poll(async () => (await allNodes()).find((x) => x.id === h1Id)?.name).toBeUndefined();
  await page.close();
});
```

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor.test.ts -t "E3a layers"`
Expected: FAIL — không có `ui_editor_layer_row`.

- [ ] **Step 2: Cài đặt `layer-tree.tsx`**

```tsx
"use client";
// E3 §2 layer tree: shell -> sections -> nodes of one page, only the visible rows rendered (≤ ~200, spec §6), search
// by name or text, rename (setName), the eye (R9), drag a row (moveNode, dropCommand). Two-way with the canvas:
// the selection opens its ancestors and scrolls into view.
import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { PanelComponent } from "@/core/interactive";
import type { IRNodeV2 } from "@/core/ir-v2";
import { Badge } from "@/app/_ui/Badge";
import { Icon } from "@/app/_ui/Icon";
import type { IconName } from "@/app/_ui/icons.gen";
import { IconButton } from "@/app/_ui/IconButton";
import { SearchInput } from "@/app/_ui/SearchInput";
import { ancestorsOf, dropCommand, hideBatch, layerRows, renameBatch, ROW_HEIGHT, rowWindow, type Batch, type DocIndex, type Zone } from "./model";

const ICON: Record<IRNodeV2["type"], IconName> = { container: "crop_square", text: "title", image: "image", link: "link", button: "touch_app", input: "input", media: "movie", svg: "shapes", "component-root": "widgets" };
const KIND: Record<string, string> = { carousel: "Carousel", tabs: "Tabs", accordion: "Accordion", modal: "Modal", dropdown: "Dropdown", menu: "Menu", video: "Video" };
type Props = { index: DocIndex; rootId: string; components: readonly PanelComponent[]; selection: string[]; onSelect(ids: string[]): void; onBatch(b: Batch, label: string): void };

export function LayerTree({ index, rootId, components, selection, onSelect, onBatch }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set([rootId]));
  const [query, setQuery] = useState("");
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(400);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const first = selection[0];
  useEffect(() => {
    if (!first) return;
    setOpen((o) => { const next = new Set(o); for (const a of ancestorsOf(index, first).slice(1)) next.add(a); return next; });
  }, [first, index]);
  const rows = useMemo(() => layerRows(index, rootId, open, query, components), [index, rootId, open, query, components]);
  useEffect(() => {
    const el = list.current, at = rows.findIndex((r) => r.id === first);
    if (!el || at < 0) return;
    const top = at * ROW_HEIGHT;
    if (top < el.scrollTop || top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 2);
  }, [rows, first]);
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { start, end } = rowWindow(rows.length, scroll, height);
  const zoneOf = (e: DragEvent<HTMLElement>): Zone => { const r = e.currentTarget.getBoundingClientRect(), f = (e.clientY - r.top) / r.height; return f < 0.25 ? "before" : f > 0.75 ? "after" : "inside"; };
  const toggle = (rid: string) => setOpen((o) => { const n = new Set(o); if (n.has(rid)) n.delete(rid); else n.add(rid); return n; });
  return (
    <div className="ve-layers">
      <SearchInput label="Tìm lớp" placeholder="Tên hoặc chữ…" value={query} onChange={setQuery} data-ui="ui_editor_layer_search" />
      <div ref={list} className="ve-layer-list" role="tree" aria-label="Layers" aria-multiselectable="true" onScroll={(e) => setScroll(e.currentTarget.scrollTop)}>
        <div style={{ height: rows.length * ROW_HEIGHT, position: "relative" }}>
          {rows.slice(start, end).map((r, k) => {
            const on = selection.includes(r.id);
            return (
              <div key={r.id} role="treeitem" aria-selected={on} aria-level={r.depth + 1} {...(r.hasChildren && { "aria-expanded": r.open })}
                className={`ve-layer${on ? " is-selected" : ""}${r.dimmed ? " is-dimmed" : ""}`} data-ui="ui_editor_layer_row" data-id={r.id}
                style={{ top: (start + k) * ROW_HEIGHT, paddingInlineStart: 4 + r.depth * 12 }}
                draggable={renaming !== r.id}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", r.id); setDrag(r.id); }}
                onDragEnd={() => setDrag(null)} onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); if (drag && drag !== r.id) onBatch(dropCommand(index, components, drag, r.id, zoneOf(e)), "Di chuyển"); setDrag(null); }}
                onClick={(e) => onSelect(e.shiftKey ? (on ? selection.filter((x) => x !== r.id) : [...selection, r.id]) : [r.id])}>
                <IconButton icon={r.open ? "expand_more" : "chevron_right"} label={`${r.open ? "Thu gọn" : "Mở"}: ${r.label}`} disabled={!r.hasChildren} onClick={(e) => { e.stopPropagation(); toggle(r.id); }} />
                <Icon name={r.section ? "layers" : ICON[r.type]} size={14} />
                {renaming === r.id ? (
                  <input autoFocus defaultValue={r.label} aria-label="Tên lớp" maxLength={80} onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") { onBatch(renameBatch(index, r.id, e.currentTarget.value), "Đổi tên"); setRenaming(null); } if (e.key === "Escape") setRenaming(null); }}
                    onBlur={() => setRenaming(null)} />
                ) : (
                  <span className="ve-layer-name ellipsis" onDoubleClick={(e) => { e.stopPropagation(); setRenaming(r.id); }}>{r.label}</span>
                )}
                {r.kind && <Badge tone="accent">{KIND[r.kind] ?? r.kind}</Badge>}
                {r.role && <Badge tone={r.role === "main" ? "primary" : "neutral"}>{r.role}</Badge>}
                <IconButton icon={r.hidden ? "visibility_off" : "visibility"} label={`${r.hidden ? "Hiện" : "Ẩn"}: ${r.label}`}
                  onClick={(e) => { e.stopPropagation(); onBatch(hideBatch(index, [r.id], !r.hidden), r.hidden ? "Hiện" : "Ẩn"); }} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
```

`visual-editor.tsx`: import `LayerTree`, `bodyOf`; thay nội dung `<aside … data-ui="ui_editor_layers">` bằng:

```tsx
          {data && <LayerTree index={index} rootId={bodyOf(data.page)} components={data.interactives} selection={selection} onSelect={select} onBatch={(b, label) => batch(b, label)} />}
```

`globals.css`:

```css
.ve-layers { display: flex; flex-direction: column; gap: var(--s-sm); min-height: 0; flex: 1; }
.ve-layer-list { position: relative; flex: 1; min-height: 160px; overflow: auto; }
.ve-layer { position: absolute; left: 0; right: 0; height: 24px; display: flex; align-items: center; gap: 4px; font: var(--t-label-sm); border-radius: var(--r-sm); cursor: default; }
.ve-layer:hover { background: var(--c-surface-high); }
.ve-layer.is-selected { background: var(--c-surface-highest); color: var(--c-primary); }
.ve-layer.is-dimmed { opacity: 0.55; }
.ve-layer .icon-btn { width: 20px; height: 20px; flex: none; }
.ve-layer-name { flex: 1; min-width: 0; }
.ve-layer input { flex: 1; min-width: 0; min-height: 20px; padding: 0 4px; }
```

`stitch-screens.md` thêm `ui_editor_layer_search` ("E3 §2 ô tìm theo tên hoặc chữ") và `ui_editor_layer_row` ("E3 §2 dòng layer: icon theo type, badge kind + main/instance, mắt `setHidden`, nhấp đúp đổi tên `setName`, kéo thả `moveNode`; chỉ render dòng nhìn thấy").

- [ ] **Step 3: Chạy test, xác nhận xanh**

Run: `npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/layer-tree.tsx" "src/app/p/[id]/editor/visual/visual-editor.tsx" src/app/globals.css docs/superpowers/design/stitch-screens.md tests/e2e/visual-editor.test.ts
git commit -m "feat(e3): virtualized layer tree — two-way selection, search, rename, eye, drag to move

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Phím tắt sửa, chọn nhiều thành một batch, clipboard nội bộ

**Files:**
- Modify: `src/app/p/[id]/editor/visual/visual-editor.tsx`
- Test: `tests/e2e/visual-editor.test.ts` (append)

**Interfaces:**
- Consumes: `deleteBatch`, `duplicateBatch`, `hideBatch`, `reorderBatch`, `copyClip`, `pasteBatch`, `Clip` (Task 5); `run`, `batch` (Task 8).
- Produces: hành vi phím (spec §2) — không API mới.

- [ ] **Step 1: Viết e2e đỏ** — append (gồm đoạn "section row" chuyển từ Task 10):

```ts
// counts section roots swapped into the frame (outerHTML replacements) from now on
async function countSwaps(page: Page): Promise<() => Promise<number>> {
  const roots = (await payload()).page.sections.map((s) => s.root.id);
  await canvas(page).locator("body").evaluate((body, ids) => {
    const w = window as unknown as { __swaps: number };
    w.__swaps = 0;
    new MutationObserver((records) => { for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1 && ids.includes((n as Element).getAttribute("data-ir-id") ?? "")) w.__swaps++; }).observe(body, { childList: true, subtree: true });
  }, roots);
  return () => canvas(page).locator("body").evaluate(() => (window as unknown as { __swaps: number }).__swaps);
}

test("E3a shortcuts: Delete, Ctrl+Z / Ctrl+Y, Ctrl+D, Alt+↑, Ctrl+C / Ctrl+V — one step each; Shift-selected nodes deleted and restored by one Undo; H replaces exactly one section", { timeout: 240_000 }, async () => {
  const page = await open();
  const PARA = "Plain paragraph text.", HEAD = "Build faster sites";
  const count = async (text: string) => (await outHtml()).split(text).length - 1;
  const para = () => canvas(page).getByText(PARA);
  await para().click();
  await page.keyboard.press("Delete");
  await saved(page);
  await expect.poll(() => count(PARA), { timeout: 30_000 }).toBe(0);
  await page.keyboard.press("Control+z");
  await saved(page);
  await expect.poll(() => count(PARA), { timeout: 30_000 }).toBe(1);
  await page.keyboard.press("Control+y");
  await saved(page);
  await expect.poll(() => count(PARA), { timeout: 30_000 }).toBe(0);
  await page.keyboard.press("Control+z");
  await saved(page);
  // Ctrl+D: a copy right after it (the copy selected); one Undo
  await para().click();
  await page.keyboard.press("Control+d");
  await saved(page);
  await expect.poll(() => count(PARA), { timeout: 30_000 }).toBe(2);
  await page.keyboard.press("Control+z");
  await saved(page);
  // Alt+↑ moves the paragraph above the h1
  await para().click();
  await page.keyboard.press("Alt+ArrowUp");
  await saved(page);
  await expect.poll(async () => { const h = await outHtml(); return h.indexOf(PARA) < h.indexOf(HEAD); }, { timeout: 30_000 }).toBe(true);
  await page.keyboard.press("Control+z");
  await saved(page);
  // h1 + p selected with Shift: one Delete, one revision, one Undo restores both
  const rev = (await payload()).revision;
  await canvas(page).locator("h1").click();
  await para().click({ modifiers: ["Shift"] });
  await page.keyboard.press("Delete");
  await saved(page);
  await expect.poll(async () => [(await payload()).revision, await count(HEAD), await count(PARA)], { timeout: 30_000 }).toEqual([rev + 1, 0, 0]);
  await page.keyboard.press("Control+z");
  await saved(page);
  await expect.poll(async () => [await count(HEAD), await count(PARA)], { timeout: 30_000 }).toEqual([1, 1]);
  // copy + paste the h1 right after itself: a fresh id
  const h1Id = (await canvas(page).locator("h1").getAttribute("data-ir-id"))!;
  await canvas(page).locator("h1").click();
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  await saved(page);
  await expect.poll(() => canvas(page).locator("h1").count(), { timeout: 30_000 }).toBe(2);
  expect(await canvas(page).locator("h1").nth(1).getAttribute("data-ir-id")).not.toBe(h1Id);
  await page.keyboard.press("Control+z");
  await saved(page);
  // H on the paragraph: exactly one section swapped on the canvas
  const swaps = await countSwaps(page);
  await para().click();
  await page.keyboard.press("h");
  await saved(page);
  await expect.poll(swaps, { timeout: 30_000 }).toBe(1);
  await expect.poll(() => para().isVisible()).toBe(false);
  await page.keyboard.press("Control+z");
  await saved(page);
  // a section row deleted from the tree changes the shell: the page reloads, the other sections stay (Undo brings it back)
  const before = (await payload()).page;
  const footer = before.sections.at(-1)!;
  await page.locator(`[data-ui="ui_editor_layer_row"][data-id="${footer.root.id}"]`).click();
  await page.keyboard.press("Delete");
  await saved(page);
  await expect.poll(async () => (await payload()).page.sections.length, { timeout: 30_000 }).toBe(before.sections.length - 1);
  await expect.poll(() => canvas(page).locator(`[data-ir-id="${footer.root.id}"]`).count()).toBe(0);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await saved(page);
  await expect.poll(async () => (await payload()).page.sections.length, { timeout: 30_000 }).toBe(before.sections.length);
  await page.close();
});
```

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor.test.ts -t "E3a shortcuts"`
Expected: FAIL — Delete không làm gì.

- [ ] **Step 2: Cài đặt** — trong `VisualEditor` thêm `const clip = useRef<Clip | null>(null);` và mở rộng `switch (action)` của `onKey` (import thêm từ `./model`):

```tsx
      case "undo": case "redo": { e.preventDefault(); run({ kind: action, label: action === "undo" ? "Hoàn tác" : "Làm lại" }); return; }
      case "delete": {
        if (!sel.length) return;
        e.preventDefault();
        if (batch(deleteBatch(ix, live.current.data!.interactives, sel), "Xoá")) setSelection([]);
        return;
      }
      case "duplicate": { if (!sel.length) return; e.preventDefault(); batch(duplicateBatch(ix, live.current.data!.interactives, sel), "Nhân bản"); return; }
      case "hide": {
        if (!sel.length) return;
        e.preventDefault();
        const all = sel.every((x) => ix.get(x)?.node.hidden);
        batch(hideBatch(ix, sel, !all), all ? "Hiện" : "Ẩn");
        return;
      }
      case "up": case "down": { if (!sel.length) return; e.preventDefault(); batch(reorderBatch(ix, live.current.data!.interactives, sel, action === "up" ? -1 : 1), "Đổi thứ tự"); return; }
      case "copy": {
        if (!first) return;
        e.preventDefault();
        const c = copyClip(ix, first);
        if ("error" in c) return setMsg(c.error);
        clip.current = c;
        setMsg(`Đã sao chép ${c.count} phần tử`);
        return;
      }
      case "paste": { if (!clip.current) return; e.preventDefault(); batch(pasteBatch(ix, live.current.data!.interactives, clip.current, first), "Dán"); return; }
```

(Thứ tự case trong switch: các case chọn của Task 8 giữ nguyên; `default` vẫn ở cuối.)

- [ ] **Step 3: Chạy test, xác nhận xanh**

Run: `npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/visual-editor.tsx" tests/e2e/visual-editor.test.ts
git commit -m "feat(e3): editing shortcuts (Delete, Ctrl+D, H, Alt+arrows, undo/redo, copy/paste) as one batch per action

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Sửa chữ trực tiếp trong canvas

**Files:**
- Modify: `src/app/p/[id]/editor/visual/visual-editor.tsx`
- Test: `tests/e2e/visual-editor.test.ts` (append)

**Interfaces:**
- Consumes: `textBatch`, `DomLike` (Task 6); `isTextHost`, `guard` (Task 5); `CanvasHandle.element` (Task 8).
- Produces: `startEdit(id: string): boolean` trong `VisualEditor` (dùng bởi `double`).

- [ ] **Step 1: Viết e2e đỏ** — append:

```ts
test("E3a inline text: dblclick → edit → Enter saves one setText (a reload keeps it); Esc cancels; paste is plain text; a stale tab gets Tải lại and its text is rolled back", { timeout: 240_000 }, async () => {
  const page = await open(1280, 1080);
  const h1 = canvas(page).locator("h1");
  await h1.dblclick();
  await expect.poll(() => h1.evaluate((el) => (el as HTMLElement).isContentEditable)).toBe(true);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Edited headline");
  await page.keyboard.press("Enter");
  await saved(page);
  await expect.poll(() => status(page).innerText()).toBe("Đã lưu — điểm QA cần chạy lại");
  expect(await outHtml()).toMatch(/<h1[^>]*>Edited headline<\/h1>/);
  expect(await h1.evaluate((el) => (el as HTMLElement).isContentEditable)).toBe(false);
  await page.reload();
  await expect.poll(() => canvas(page).locator("h1").innerText(), { timeout: 30_000 }).toBe("Edited headline");
  // Esc: nothing sent
  const rev = (await payload()).revision;
  await h1.dblclick();
  await page.keyboard.type(" zzz");
  await page.keyboard.press("Escape");
  expect(await h1.innerText()).toBe("Edited headline");
  expect((await payload()).revision).toBe(rev);
  // paste: plain text only
  const para = canvas(page).getByText("Plain paragraph text.");
  await para.dblclick();
  await para.evaluate((el) => {
    const dt = new DataTransfer();
    dt.setData("text/html", '<img src=x onerror="window.top.__pwned=1"><b>Bold</b>');
    dt.setData("text/plain", " Bold");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  expect(await para.evaluate((el) => el.innerHTML)).not.toContain("<img");
  await page.keyboard.press("Enter");
  await saved(page);
  expect(await outHtml()).toContain(" Bold");
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  // another tab commits first: this edit is refused (409), rolled back, Tải lại shows the other tab's change
  const { revision } = await payload();
  const h1Id = (await h1.getAttribute("data-ir-id"))!;
  const other = await fetch(`${app!.base}/api/projects/${projectId}/editor/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: revision, commands: [{ op: "setAttribute", id: h1Id, name: "title", value: "other tab" }] }) });
  expect(other.status).toBe(200);
  await h1.dblclick();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Lost update");
  await page.keyboard.press("Enter");
  await expect.poll(() => status(page).innerText(), { timeout: 30_000 }).toBe(`Dự án đã thay đổi ở nơi khác (revision ${revision + 1}). Tải lại để tiếp tục.`);
  expect(await h1.innerText()).toBe("Edited headline");
  expect(await outHtml()).not.toContain("Lost update");
  await page.getByRole("button", { name: "Tải lại" }).click();
  await expect.poll(() => canvas(page).locator("h1").getAttribute("title"), { timeout: 30_000 }).toBe("other tab");
  expect(await page.getByRole("button", { name: "Tải lại" }).count()).toBe(0);
  // restore the fixture text for the next tests
  const text = (await allNodes()).find((x) => x.tag === "#text" && x.text === "Edited headline")!;
  await fetch(`${app!.base}/api/projects/${projectId}/editor/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: (await payload()).revision, commands: [{ op: "setText", id: text.id, text: "Build faster sites" }, { op: "setAttribute", id: h1Id, name: "title", value: null }] }) });
  await page.close();
});
```

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor.test.ts -t "E3a inline text"`
Expected: FAIL — `isContentEditable` vẫn false.

- [ ] **Step 2: Cài đặt** — trong `VisualEditor` (import `textBatch`, `DomLike` từ `./inline-text`; `guard`, `isTextHost` từ `./model`):

```tsx
  const editing = useRef<{ id: string; el: HTMLElement; before: string } | null>(null);
  // spec §2: contenteditable on a text host; Enter / click outside saves (one batch, R12), Esc cancels, paste is plain
  const startEdit = (nid: string): boolean => {
    const { index: ix, data: d } = live.current;
    const e = ix.get(nid), el = canvas.current?.element(nid);
    if (!e || !el || !d || !isTextHost(e.node)) return false;
    const why = guard(ix, d.interactives, nid, "edit");
    if (why) { setMsg(why); return true; }
    if (editing.current) return true;
    const before = el.innerHTML;
    editing.current = { id: nid, el, before };
    const finish = (save: boolean) => {
      if (editing.current?.el !== el) return;
      editing.current = null;
      el.removeAttribute("contenteditable");
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("blur", onBlur);
      el.removeEventListener("paste", onPaste);
      if (!save) { el.innerHTML = before; return; }
      const node = live.current.index.get(nid)?.node;
      if (!node) return;
      const b = textBatch(node, el as unknown as DomLike);
      if ("error" in b) { el.innerHTML = before; setMsg(b.error); return; }
      if (b.commands.length) run({ kind: "commands", commands: b.commands, label: "Sửa chữ", rollback: () => { el.innerHTML = before; } });
    };
    const onKeyDown = (k: KeyboardEvent) => {
      k.stopPropagation(); // the editor's shortcuts stay off while typing
      if (k.key === "Enter" && !k.shiftKey) { k.preventDefault(); finish(true); }
      else if (k.key === "Escape") { k.preventDefault(); finish(false); }
    };
    const onBlur = () => finish(true);
    const onPaste = (p: ClipboardEvent) => { p.preventDefault(); el.ownerDocument.execCommand("insertText", false, p.clipboardData?.getData("text/plain") ?? ""); };
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("blur", onBlur);
    el.addEventListener("paste", onPaste);
    el.contentEditable = "true";
    el.focus();
    return true;
  };
```

Đổi `double`:

```tsx
  const double = (raw: string) => {
    const target = pickTarget(live.current.index, raw);
    if (!target || startEdit(target)) return;
    const child = live.current.index.get(target)?.children[0];
    if (child) select([child]);
  };
```

Không cần CSS mới: ô đang sửa dùng outline mặc định của trình duyệt cho `[contenteditable]`.

- [ ] **Step 3: Chạy test, xác nhận xanh**

Run: `npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/visual-editor.tsx" tests/e2e/visual-editor.test.ts
git commit -m "feat(e3): inline text editing on the canvas — plain-text paste, Enter/blur saves one batch, Esc cancels, rollback on refusal

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Bảng phải — Phần tử (ảnh/upload/alt/href/Detach), Component (E2), Hiệu ứng

**Files:**
- Create: `src/app/p/[id]/editor/visual/element-panel.tsx`
- Modify: `src/app/p/[id]/editor/visual/visual-editor.tsx`, `src/app/globals.css`, `docs/superpowers/design/stitch-screens.md`
- Test: `tests/e2e/visual-editor.test.ts` (append)

**Interfaces:**
- Consumes: `imageBatch`, `styleTarget`, `ancestorsOf`, `outlineOf`, `GENERATED`, `labelOf`, `Entry`, `Bp`, `Batch` (Task 5); `ComponentPanel` (E2, không đổi); `LibraryAsset`; `POST /assets` (Task 3).
- Produces:

```ts
export function ElementPanel(props: { projectId: string; index: DocIndex; entry: Entry; element: HTMLElement | null; bp: Bp; assets: LibraryAsset[]; onBatch(b: Batch, label: string, rollback?: () => void): void; onUploaded(a: LibraryAsset): void; onMessage(text: string): void }): JSX.Element;
export function EffectsCard(props: { effects: string[]; disabled: boolean; onApply(animation: string): void }): JSX.Element;
```

- [ ] **Step 1: Viết e2e đỏ** — append:

```ts
test("E3a panels: upload replaces an <img> (uploads map, out/assets), alt saved; Component tab shows the E2 panel; Hiệu ứng applies a preset", { timeout: 240_000 }, async () => {
  const page = await open();
  const img = canvas(page).locator("img.lazy-img");
  await img.scrollIntoViewIfNeeded();
  await img.click();
  await page.getByRole("tab", { name: "Style" }).click();
  await expect.poll(() => page.locator('[data-ui="ui_editor_image_panel"]').isVisible()).toBe(true);
  await page.locator('[data-ui="ui_editor_upload"] input[type="file"]').setInputFiles(fileURLToPath(new URL("../fixtures/site4/poster.png", import.meta.url)));
  await saved(page);
  await expect.poll(() => img.getAttribute("src"), { timeout: 30_000 }).toMatch(/assets\/[0-9a-f]{64}\.png$/);
  const rel = (await img.getAttribute("src"))!.replace(/^.*?(assets\/)/, "$1");
  expect(await outHtml()).toContain(`src="${rel}"`);
  expect((await fetch(`${app!.base}/api/projects/${projectId}/files/out/${rel}`)).status).toBe(200);
  expect(await page.locator('[data-ui="ui_editor_asset_grid"] button').count()).toBeGreaterThan(0);
  const alt = page.getByRole("textbox", { name: "Alt" });
  await alt.fill("Ảnh mới");
  await alt.press("Enter");
  await saved(page);
  await expect.poll(() => outHtml(), { timeout: 30_000 }).toContain('alt="Ảnh mới"');
  // Component tab: the E2 panel for a plain node
  await page.getByRole("tab", { name: "Component" }).click();
  await expect.poll(() => page.locator('[data-ui="ui_editor_component_convert"]').isVisible()).toBe(true);
  // Hiệu ứng: a preset on the selected node at the current breakpoint
  await page.getByRole("tab", { name: "Hiệu ứng" }).click();
  await page.getByRole("combobox", { name: "Keyframes" }).selectOption("sp1-fade-in");
  await page.getByRole("button", { name: "Áp cho phần tử đang chọn" }).click();
  await saved(page);
  await expect.poll(async () => (await fetch(`${app!.base}/api/projects/${projectId}/files/out/css/styles.css`)).text(), { timeout: 30_000 }).toContain("sp1-fade-in");
  for (let i = 0; i < 3; i++) { await page.getByRole("button", { name: "Hoàn tác" }).click(); await saved(page); }
  await expectUi(page, ["ui_editor_effects_panel"]);
  await page.close();
});
```

(thêm `fileURLToPath` đã import ở đầu file.)

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor.test.ts -t "E3a panels"`
Expected: FAIL — không có `ui_editor_image_panel`.

- [ ] **Step 2: Cài đặt `element-panel.tsx`**

```tsx
"use client";
// E3 §2 right panel, tab Style (E3a, R14): the selected node — tag, name, size; replace an image from the project's
// asset library or an upload (§5), its alt; a link's href; Detach / reset overrides on an instance (E1 §4).
// Hiệu ứng: the existing presets as setStyle(animation) at the current breakpoint.
import { useState } from "react";
import type { LibraryAsset } from "@/core/upload";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { Field } from "@/app/_ui/Field";
import { GENERATED, imageBatch, labelOf, type Batch, type Bp, type Entry, type DocIndex } from "./model";

type Props = { projectId: string; index: DocIndex; entry: Entry; element: HTMLElement | null; bp: Bp; assets: LibraryAsset[]; onBatch(b: Batch, label: string, rollback?: () => void): void; onUploaded(a: LibraryAsset): void; onMessage(text: string): void };

export function ElementPanel({ projectId, index, entry, element, bp, assets, onBatch, onUploaded, onMessage }: Props) {
  const [busy, setBusy] = useState(false);
  const node = entry.node;
  const background = !!element && element.ownerDocument.defaultView!.getComputedStyle(element).backgroundImage !== "none";
  const kind = node.tag === "img" ? "img" : node.tag === "source" ? "source" : background ? "background" : undefined;
  const generated = node.id.startsWith(GENERATED);
  const apply = (asset: LibraryAsset) => {
    if (!kind) return;
    const el = element, prev = el && { src: el.getAttribute("src"), srcset: el.getAttribute("srcset"), bg: el.style.backgroundImage };
    // optimistic: the served file now, the section from the server after the step
    if (el && kind === "img") { el.removeAttribute("srcset"); el.setAttribute("src", asset.url); }
    if (el && kind === "background") el.style.backgroundImage = `url("${asset.url}")`;
    onBatch(imageBatch(index, node.id, kind, asset.key, bp), "Thay ảnh", () => {
      if (!el || !prev) return;
      if (prev.src === null) el.removeAttribute("src"); else el.setAttribute("src", prev.src);
      if (prev.srcset !== null) el.setAttribute("srcset", prev.srcset);
      el.style.backgroundImage = prev.bg;
    });
  };
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const res = await fetch(`/api/projects/${projectId}/assets`, { method: "POST", body: form });
      const body = (await res.json()) as { key?: string; url?: string; message?: string };
      if (!res.ok || !body.key || !body.url) return onMessage(body.message ?? `Tải ảnh lỗi (HTTP ${res.status}).`);
      const asset = { key: body.key, url: body.url, size: file.size, type: body.key.slice(body.key.lastIndexOf(".") + 1) };
      onUploaded(asset);
      apply(asset);
    } finally {
      setBusy(false);
    }
  };
  const attr = (name: string, value: string) => onBatch({ commands: [{ op: "setAttribute", id: node.id, name, value: value === "" ? null : value }] }, name === "alt" ? "Sửa alt" : "Sửa link");
  const rect = element?.getBoundingClientRect();
  return (
    <Card title="Phần tử" data-ui="ui_editor_element_card">
      <p className="t-label-md">{`${node.tag} · ${labelOf(entry)}${rect ? ` · ${Math.round(rect.width)}×${Math.round(rect.height)}` : ""}`}</p>
      {node.component?.role === "instance" && !generated && (
        <div className="cmp-actions">
          <Button onClick={() => onBatch({ commands: [{ op: "detachComponent", instanceId: node.id }] }, "Tách khỏi component")}>Tách khỏi component</Button>
          <Button variant="ghost" onClick={() => onBatch({ commands: [{ op: "resetOverride", instanceId: node.id }] }, "Bỏ override")}>Bỏ mọi override</Button>
        </div>
      )}
      {generated && <p className="t-body-sm text-2">Phần tử lấy từ main component: sửa ở main, hoặc Tách khỏi component ở instance gốc.</p>}
      {kind && !generated && (
        <div className="stack" data-ui="ui_editor_image_panel">
          <span className="field-label">Ảnh ({kind === "background" ? "nền" : kind})</span>
          <ul className="ve-assets" data-ui="ui_editor_asset_grid">
            {assets.map((a) => (
              <li key={a.key}>
                <button type="button" aria-label={`Dùng ảnh ${a.type}, ${Math.ceil(a.size / 1024)} KB`} title={`Dùng ảnh ${a.type}, ${Math.ceil(a.size / 1024)} KB`} onClick={() => apply(a)}>
                  <img src={a.url} alt="" loading="lazy" />
                </button>
              </li>
            ))}
          </ul>
          <Field label="Tải ảnh lên (png, jpg, webp, gif, svg, avif — tối đa 25 MB)" data-ui="ui_editor_upload">
            <input type="file" accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.avif" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
          </Field>
          {kind === "img" && (
            <Field label="Alt">
              <input key={`${node.id}-alt`} defaultValue={node.attrs.alt ?? ""} onKeyDown={(e) => { if (e.key === "Enter") attr("alt", e.currentTarget.value); }} onBlur={(e) => { if (e.currentTarget.value !== (node.attrs.alt ?? "")) attr("alt", e.currentTarget.value); }} />
            </Field>
          )}
        </div>
      )}
      {node.tag === "a" && !generated && (
        <Field label="Link (href)">
          <input key={`${node.id}-href`} defaultValue={node.attrs.href ?? ""} onKeyDown={(e) => { if (e.key === "Enter") attr("href", e.currentTarget.value); }} />
        </Field>
      )}
    </Card>
  );
}

const DEFAULT_EFFECT_MS = 600;
export function EffectsCard({ effects, disabled, onApply }: { effects: string[]; disabled: boolean; onApply(animation: string): void }) {
  const [effect, setEffect] = useState(effects[0] ?? "sp1-fade-in");
  const [ms, setMs] = useState(DEFAULT_EFFECT_MS);
  return (
    <Card title="Hiệu ứng" data-ui="ui_editor_effects_panel">
      <Field label="Keyframes">
        <select value={effect} onChange={(e) => setEffect(e.target.value)}>
          {effects.map((name) => <option key={name}>{name}</option>)}
        </select>
      </Field>
      <Field label="Thời lượng (ms)">
        <input type="number" min={100} max={10_000} step={100} value={ms} onChange={(e) => setMs(Number(e.target.value) || DEFAULT_EFFECT_MS)} />
      </Field>
      <Button onClick={() => onApply(`${effect} ${ms}ms ease-out both`)} disabled={disabled}>Áp cho phần tử đang chọn</Button>
    </Card>
  );
}
```

- [ ] **Step 3: Nối vào `visual-editor.tsx`** (import `ElementPanel`, `EffectsCard`, `ComponentPanel` từ `../component-panel/component-panel`, `ancestorsOf`, `outlineOf`, `styleTarget`); thay nội dung `<aside className="ve-right panel">` sau `SegmentedControl`:

```tsx
          {data && tab === "style" && (selection[0] && index.get(selection[0]) ? (
            <ElementPanel projectId={id} index={index} entry={index.get(selection[0])!} element={canvas.current?.element(selection[0]) ?? null} bp={bp} assets={data.assets}
              onBatch={(b, label, rollback) => batch(b, label, rollback ? { rollback } : {})}
              onUploaded={(a) => setData((d) => d && { ...d, assets: [a, ...d.assets.filter((x) => x.key !== a.key)] })} onMessage={setMsg} />
          ) : <p className="t-body-sm text-2">Chọn một phần tử trên canvas hoặc trong Layers.</p>)}
          {data && tab === "component" && (
            <fieldset className="cmp-fieldset" disabled={pending > 0}>
              <ComponentPanel
                document={{ components: data.interactives, ancestors: selection[0] ? ancestorsOf(index, selection[0]) : [], outline: selection[0] ? outlineOf(index, selection[0]) : [], shot: data.shot }}
                selectedId={selection[0] ?? null} revision={data.revision}
                onCommands={(list) => commands(list, "Component", { done: "Đã cập nhật component — điểm QA cần chạy lại" })}
                onShow={(root, k) => canvas.current?.post(k < 0 ? { type: "aiwc:hide", root } : { type: "aiwc:show", root, index: k })} />
            </fieldset>
          )}
          {data && tab === "effects" && (
            <EffectsCard effects={data.effects} disabled={!selection[0]}
              onApply={(animation) => selection[0] && commands([{ op: "setStyle", id: selection[0], target: styleTarget(bp), changes: { animation } }], "Hiệu ứng")} />
          )}
```

`globals.css`:

```css
.ve-assets { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; max-height: 240px; overflow: auto; }
.ve-assets button { width: 100%; aspect-ratio: 1; padding: 0; border: 1px solid var(--c-border); background: var(--c-surface); border-radius: var(--r-sm); cursor: pointer; }
.ve-assets img { width: 100%; height: 100%; object-fit: contain; display: block; }
```

`stitch-screens.md`: thêm `ui_editor_element_card` (tag/tên/W×H; Tách khỏi component / Bỏ mọi override cho instance — `detachComponent`/`resetOverride`), `ui_editor_image_panel` (thay ảnh img/source/nền — `setAttribute src/srcset`, `setStyle background-image`, alt), `ui_editor_asset_grid` (`assets[]` của `GET …/editor`), `ui_editor_upload` (`POST …/assets`); sửa `ui_editor_effects_panel` (API: `setStyle animation` ở bp hiện tại qua `…/editor/commands`) và `ui_editor_component_panel` (nằm ở tab Component của bảng phải).

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/element-panel.tsx" "src/app/p/[id]/editor/visual/visual-editor.tsx" src/app/globals.css docs/superpowers/design/stitch-screens.md tests/e2e/visual-editor.test.ts
git commit -m "feat(e3): right panel — element card with image replace/upload, alt, href, detach; E2 Component tab; effects tab

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Ghi rulings vào spec, graph, kiểm toàn bộ

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-e3-visual-editor-design.md` (thêm §11), `docs/superpowers/design/stitch-screens.md` (errata icon), `graphify-out/*` (qua `/graphify docs --update`)
- Test: toàn bộ suite

**Interfaces:**
- Consumes: mọi task trên.
- Produces: spec khớp code (E3a), graph không lệch docs.

- [ ] **Step 1: Ghi §11 vào spec** — append:

```markdown
## 11. Rulings khi triển khai E3a (2026-10-07)

Quyết định phát sinh khi viết plan E3a (R1–R20, `docs/superpowers/plans/2026-10-07-e3a-visual-editor-core.md`), chép lại để spec khớp code:
- `affected.sections[i] = { id, html, root }` (gốc section đã resolve) + `affected.interactives`; chỉ khi body có `pageId`; Undo/Redo cũng trả.
- Section "bị chạm" = gốc section đã resolve khác nhau; shell/title/meta/thứ tự section đổi hoặc > 20 → `shellChanged`.
- Tài liệu canvas: `<base>` về `out/<page>`, meta CSP chỉ cho `runtime.js`, `<style data-aiwc-css>`; tên hàm thật `renderSectionsHtml` / `emitSection` / `renderSite`.
- Upload: key `https://upload.aiwc.invalid/<sha>.<ext>` trong `uploads.json`, gộp vào asset map; multipart cần `Origin` trùng host.
- Mắt / H = `setHidden` + `display:none` ở base; layer tree không có dòng `#text`; E3a chưa cho chuyển node sang section khác.
- Sửa chữ: setText khi cấu trúc giữ nguyên, thay con trong một batch khi chỉ còn chữ + b/i/a/br, còn lại từ chối.
- "Editor cũ" = `?legacy=1`; "Edit main" của E1 không nằm trong E3.
```

`stitch-screens.md` mục Errata: thêm dòng **E3a icons**: `title`, `link`, `touch_app`, `input`, `movie`, `shapes`, `widgets`, `crop_square`, `upload` thêm vào subset (74 → 83), sinh lại bằng `npm run icons`.

- [ ] **Step 2: Cập nhật graph**

Run: `/graphify docs --update`
Expected: graph có các `ui_editor_*` mới gắn `screen_editor`/`feat_editor`; không node `drift_*` nào được nối vào code mới.

- [ ] **Step 3: Kiểm toàn bộ**

Run: `npm run typecheck && npx vitest run && npm run build && npx vitest run -c vitest.e2e.config.ts`
Expected: tất cả PASS (gồm `editor-smoke`, `editor-components`, `grapes-textnode` ở `?legacy=1`, `ui-smoke`, `visual-editor`, `visual-editor-perf`, `qa-baseline`).

- [ ] **Step 4: Commit**

```bash
git add -- docs/superpowers/specs/2026-10-07-e3-visual-editor-design.md docs/superpowers/design/stitch-screens.md graphify-out
git commit -m "docs(e3): E3a rulings in the spec, icon errata, graph refreshed

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

1. **Spec coverage (E3a):** §1 kiến trúc/luồng — Task 2, 4, 7, 8; cập nhật từng phần + `shellChanged` — Task 2, 4, 8 (`applyResult`); sandbox + chặn click/điều hướng — Task 8; overlay + ResizeObserver/scroll — Task 8, 9; breakpoint + `target.bp` — Task 8 (`width`), 5 (`styleTarget`), 13 (hiệu ứng/ảnh nền); Undo/Redo server — Task 4, 8, 11; 409 — Task 7, 8, 12. §2 chọn/hover — Task 8, 9; layer tree — Task 10; sửa chữ — Task 6, 12; thay ảnh — Task 3, 5, 13; phím tắt + batch ≤ 50 + clipboard — Task 5, 11; Bảo vệ — Task 5 (+ server); "Editor cũ" — Task 8. §4 khung — Task 8, 10, 13 (drawer 768 / 375 thuộc E3b). §5 — Task 1, 3, 4. §6 — Global Constraints + Task 5 (`LIMITS`, `MAX_ROWS`), 7 (`BUS_LIMITS`), 2 (20 section), 3 (25/500 MB). §7 — Task 7 + 8. §8 — Task 2 (CSP), 3, 6, 8, 12. §9 unit: affected (T2), setName (T1), clipboard đổi ID (T5 — draft không id; `createNode` cấp id, đã có test E1), SVG + magic bytes (T3); e2e chọn/hover/layer/sửa chữ/upload/phím/chọn nhiều/409/một section (T9–T13); hiệu năng (T9, T11). Hiện chưa có: drag/resize/Style Manager/zoom/drawer — E3b.
2. **Placeholder scan:** không còn "TBD"/"tương tự Task N"; mọi bước code có code. Đã sửa: đoạn "section row" của Task 10 chuyển hẳn sang Task 11 (dùng phím Delete); Task 12 không chạm `globals.css` (đã ghi bỏ khỏi Files).
3. **Type consistency:** `Batch`, `Entry`, `DocIndex`, `Bp`, `Zone`, `Clip` định nghĩa ở Task 5 và dùng nguyên tên ở Task 6, 10, 11, 13; `StepResult`/`Op`/`BusEvent` Task 7 ↔ Task 8; `CanvasHandle` (Task 8) có `element`, `replace`, `post`, `doc`, `frame` — Task 9/12/13 chỉ dùng các tên này; `Affected`/`CanvasPayload` Task 2 ↔ Task 4/8; `ElementPanel` nhận `index` (đã thêm vào Props cho `imageBatch`).
4. **Review Focus:** 5 dòng đều có test ở task sở hữu: (1) Task 2 escape + một script + CSP, Task 8 một script, Task 12 paste + `__pwned`; (2) Task 7 unit 409 + Task 12 e2e tab khác; (3) Task 5 guards; (4) Task 3 unit + route; (5) Task 2 unit shellChanged + Task 11 e2e xoá section row.
