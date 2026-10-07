# E3b Visual Editor Advanced Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hoàn thiện visual editor E3 (đợt E3b): Style Manager đầy đủ theo breakpoint/trạng thái, kéo theo luồng (kể cả sang section khác, giữ ID), Alt+kéo tự do có snap/guide và đo khoảng cách, resize + chỉnh padding/gap trực tiếp, panel "Thêm" (kể cả Carousel/Tabs/Accordion/Modal mẫu), zoom 25–200% + pan, drawer ở 768 / chỉ xem ở 375, rồi gỡ hẳn GrapesJS.

**Architecture:** Ba thay đổi lõi nhỏ đi trước (moveNode qua section, tham chiếu node mới trong cùng batch, gộp bước History cho cùng ô style), mỗi cái có test riêng trên `ir-command`/`ir-store`. Phía client, mọi phép hình học là hàm thuần (`style-model.ts`, `gestures.ts`, `snap.ts`, `templates.ts`); component React chỉ đo DOM iframe, vẽ overlay và đẩy batch qua `CommandBus` của E3a. Mọi kéo dùng pointer event + một lớp phủ bắt chuột ở cửa sổ cha + `elementFromPoint` trong iframe (không HTML5 DnD xuyên iframe).

**Tech Stack:** TypeScript, Next.js 16 App Router, React 19, Zod 4, `node:sqlite`, Playwright 1.63, Vitest 5. Không thêm dependency; E3b **gỡ** `grapesjs`.

**Spec:** `docs/superpowers/specs/2026-10-07-e3-visual-editor-design.md` (E3b = §3, phần còn lại của §6/§9, §4 drawer 768 / chỉ xem 375). Tiền đề: plan E3a `docs/superpowers/plans/2026-10-07-e3a-visual-editor-core.md` đã xong (Task 1–14 commit trên nhánh).

## Global Constraints

- Nhánh `e3-visual-editor`, tiếp tục ngay sau commit cuối của E3a. Không push/merge.
- Chỉ stage file của task bằng `git add -- <paths>` (xoá file: `git rm -- <paths>`); không bao giờ `git add -A`; không stage `next-env.d.ts`, `passcaptchar/`, `rules.md`, `.playwright-mcp/`, `.superpowers/`. Trailer mọi commit: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Trước Task 1: `/graphify explain feat_editor`, `/graphify explain screen_editor`. Không build `drift_*` (đặc biệt không có "Auto-reconcile CSS", "Approve & Deploy", telemetry giả); không giải CAPTCHA/stealth (`rule_no_captcha_bypass`).
- Giới hạn cứng (spec §6, chép nguyên): Batch command **50**; Clipboard **1 subtree, ≤ 500 node**; Upload **≤ 25 MB/file; tổng asset ≤ 500 MB/project**; Section thay trên canvas mỗi phản hồi **≤ 20 (vượt thì nạp lại trang)**; Request đang bay **1; hàng đợi ≤ 20 thao tác**; Debounce style **300 ms; gộp Undo trong 1,5 s cùng ô**; Zoom **25–200%**; Layer tree **virtualized, render ≤ ~200 dòng**.
- Hằng E3b từ spec §3: snap **ngưỡng 4 px**; zoom **25–200%** bằng Ctrl+lăn chuột hoặc Ctrl±, nút "Vừa khung", pan Space+kéo, iframe `transform: scale()`; resize **8 handle**, Shift khoá tỉ lệ, handle trên/trái chỉ cho node absolute; Alt+kéo → `position:absolute` (+ cha `relative` nếu static), cùng một batch, ghi ở breakpoint hiện tại; style qua `isSafeCss`.
- Style Manager (spec §3): nhóm Layout (display, flex direction/wrap/justify/align/gap, grid template cols/rows/gap, position + top/right/bottom/left, overflow, z-index), Size (width, height, min/max), Spacing (sơ đồ hộp margin/padding, kéo trên số), Typography (font-family từ font của trang, size, weight, line-height, letter-spacing, align, color), Appearance (background màu/ảnh/gradient dạng text, border, radius, opacity, box-shadow), Transform (translate, scale, rotate); nguồn "đặt ở bp này" / "kế thừa từ Desktop" / "từ main component"; nút "↺ bỏ"; trạng thái Mặc định / :hover / :focus / :active; ô "Thuộc tính khác".
- Panel "Thêm" (spec §3, đúng danh sách): Text, Tiêu đề, Đoạn văn, Ảnh, Nút, Link, Khung trống, Flex hàng, Flex cột, Grid 2/3 cột, Section trống, Carousel/Tabs/Accordion/Modal mẫu (`createNode` rồi `convertToComponent`); nội dung mẫu tiếng Việt, style tối thiểu, không class; kéo vào canvas (vạch chèn) hoặc click để chèn sau node đang chọn.
- `core/` không import `app/`; `ir-command.ts` thuần; client chỉ `import type` từ core trừ `@/core/safe-names`. Không `Promise.all` trên mảng không bounded.
- UI: copy tiếng Việt, `_ui` + token Stitch, mọi phần tử mới `data-ui="ui_editor_*"` + dòng trong `stitch-screens.md` ("không có trong mockup, dùng token/component sẵn có"); nút icon có `aria-label` + `title`; không cuộn ngang ở 1440; ở 768 panel là drawer; ở 375 chỉ xem và chọn, thông báo "Dùng màn hình ≥ 768px để chỉnh sửa".
- Mỗi task: test đỏ → code tối thiểu → test xanh → `npm run typecheck` → review diff → commit riêng.

**Rulings đã chốt khi viết plan:**
- R1 `moveNode` giữa hai **section** (không phải shell, không phải main) được phép và giữ ID cả cây con (spec §3 "ID giữ nguyên kể cả khi chuyển section" — ghi đè luật ranh giới section của E1 §2; ranh giới shell/main giữ nguyên). Trần node của trang đích được kiểm lại; inverse là `moveNode` ngược. Client bỏ guard "section khác" của E3a.
- R2 Tham chiếu node mới trong cùng batch: `convertToComponent` (cả `id` và mọi chuỗi trong `roles`) được ghi `new:<k>/<path>` — `k` là chỉ số một `createNode` đứng trước trong batch, `path` là chỉ số con ngăn bởi `.` tính từ gốc vừa tạo (`""` = gốc). `prepareCommands` thay bằng ID server cấp nên History lưu ID thật. Nhờ đó "mẫu + component" là **một** batch = một bước Undo (client không biết ID trước khi server cấp).
- R3 Gộp Undo 1,5 s: body `commands` có `coalesce?: true`; `commitCommands(..., { coalesce })` **thay** bước History mới nhất (giữ inverse cũ, forward = batch mới) chỉ khi bước tại cursor là bước mới nhất (không có nhánh Redo) và cả hai batch đều chỉ gồm `setStyle` cùng danh sách (id, target, tập prop); ngược lại thành bước mới — không bao giờ lỗi. Client (bus) chỉ gửi `coalesce` khi thao tác trước cùng `coalesceKey` (`<id>|<target>|<prop>`) được **đẩy** ≤ 1 500 ms trước, đã xong và revision chưa đổi (cửa sổ trượt). Máy chủ không cần đồng hồ.
- R4 Giá trị ở 375 kế thừa thẳng Desktop (base), không qua 768: emitter "revert" prop chỉ có ở 768 dưới 768px (`renderCss` eff375). Nhãn "kế thừa từ Desktop" dùng cho cả 768 và 375.
- R5 Trạng thái :hover/:focus/:active ghi vào `target` state và áp mọi breakpoint (E1 không có state × bp); khi chọn trạng thái, panel ghi chú "Trạng thái áp cho mọi breakpoint".
- R6 Alt+kéo: top/left tính từ padding box của **cha trực tiếp** (cha static được đặt `relative` trước — tương đương "cha gần nhất có position khác static" sau bước đó), trừ margin của node, cộng scroll của cha; khoá `width` bằng độ rộng tính toán hiện tại để node không co lại khi thành absolute.
- R7 "Section trống" chèn một `<section>` (min-height + padding) **bên trong** section đang chọn: Command API không tạo được một IR section mới (shell chỉ nhận move/delete placeholder) — không khả thi đúng nghĩa đen, ghi nhận.
- R8 Zoom: Ctrl± và nút đi theo mốc 25, 33, 50, 67, 75, 100, 125, 150, 200 %; Ctrl+lăn nhân ×1,1 mỗi nấc; Ctrl+0 về 100 %; "Vừa khung" = (độ rộng pane − 16) / breakpoint, kẹp 25–200 %.
- R9 Drawer khi cửa sổ app ≤ 1099px (cùng mốc `editor-grid` hiện có, nên 768 là drawer); chỉ xem khi < 768px (spec nói "ở 375").
- R10 "Gộp thành layout" chuyển vào card Section (`ui_editor_sections_panel`) ở cuối tab Layers, gửi lệnh `promoteLayout` qua command bus; `GET /editor` thêm `allSections` (mọi trang) thay cho `sections` của GrapesJS.
- R11 Snap ngưỡng 4 px **màn hình** = 4 / zoom px tài liệu; mục tiêu snap: anh em, cha, vùng nhìn của iframe.
- R12 Mọi thao tác kéo (luồng, Alt, resize, padding/gap, chèn từ panel, pan) dùng pointer event: khi bắt đầu, một lớp phủ `position:fixed` ở cửa sổ cha nhận chuột; điểm tài liệu = (client − rect iframe) / zoom; node dưới chuột = `contentDocument.elementFromPoint`.
- R13 Node không absolute chỉ có handle e / s / se (handle trên/trái là của absolute); resize ghi `width`/`height` px vào target bp hiện tại; Shift khoá tỉ lệ.
- R14 Ô Style hiện giá trị IR đang có hiệu lực; trống thì placeholder là giá trị computed của iframe (không nhãn nguồn).
- R15 Gỡ GrapesJS: xoá `grapes-adapter.ts`, route `editor/save` + `editor/promote-layout`, `editor-view.tsx`, `?legacy=1`, CSS `.editor-shell .gjs-*`, dependency `grapesjs`, `styleTargetFidelity` (chỉ route save dùng) và test của chúng; e2e GrapesJS chuyển sang editor mới.

**Không khả thi / lệch so với code thật (đã xử lý):** E1 cấm chuyển qua section (R1, đổi lõi); client không thể gọi `convertToComponent` cho node vừa tạo trong cùng bước (R2, đổi lõi); server History không có cơ chế gộp (R3, đổi store); "Section trống" không thể là IR section mới (R7).

## Review Focus

1. Kéo một node vào chính con cháu của nó, vào track carousel, vào trong instance, hoặc kéo section root lên một node: vạch chèn đỏ kèm lý do, thả ra không gửi gì (Task 5 unit E3a đã có guard; Task 7 e2e vạch đỏ + revision không đổi).
2. Gõ giá trị CSS phá rule (`red; } body{display:none`, ngoặc kép mở) vào Style Manager: báo lỗi tại ô, không gửi, canvas hoàn lại giá trị cũ (Task 4 unit `setField`, Task 5 e2e).
3. Sửa liên tục cùng một ô (nhiều lần debounce) rồi Undo: một lần Undo về giá trị trước chuỗi sửa; sửa ô khác, chờ > 1,5 s, hoặc tab khác commit giữa chừng thì không gộp (Task 3 unit store + bus).
4. Canvas ở zoom 50 % và 200 % có cuộn trong iframe: hover/chọn/kéo/resize vẫn trúng phần tử và đúng px (Task 10 e2e chọn + resize ở 50 %).
5. Sau khi gỡ GrapesJS: URL cũ `?legacy=1` vẫn mở editor mới, `POST …/editor/save` và `…/editor/promote-layout` trả 404 (không 500), "Gộp thành layout" qua `promoteLayout` Undo được (Task 12).

## File Structure

| File | Trách nhiệm |
|---|---|
| `src/core/ir-command.ts` | R1 moveNode qua section; R2 `resolveRefs` cho `convertToComponent`. |
| `src/core/ir-store.ts` | R3 `commitCommands(…, { coalesce })`, `INSERT OR REPLACE` bước History. |
| `src/app/api/projects/[id]/editor/commands/route.ts` | `coalesce?: boolean`. |
| `src/app/api/projects/[id]/editor/route.ts` | bỏ `irToGrapes`; thêm `allSections`. |
| `src/app/p/[id]/editor/visual/command-bus.ts` | `coalesceKey`, đồng hồ tiêm vào. |
| `src/app/p/[id]/editor/visual/model.ts` | bỏ guard section khác; `keyAction` thêm zoom. |
| `src/app/p/[id]/editor/visual/style-model.ts` (mới) | Thuần: `fieldOf`, `setField`, `clearField`, `GROUPS`, `CHOICES`, `otherProps`, `scrub`, `styleKey`. |
| `src/app/p/[id]/editor/visual/style-panel.tsx` (mới) | Style Manager UI. |
| `src/app/p/[id]/editor/visual/gestures.ts` (mới) | Thuần: `dropZone`, `indicator`, `axisOf`, `freeCommands`, `resizeCommands`, `handlesFor`, `spacingCommand`, zoom helpers. |
| `src/app/p/[id]/editor/visual/snap.ts` (mới) | Thuần: `snap`, `gaps`, `SNAP_PX`. |
| `src/app/p/[id]/editor/visual/templates.ts` (mới) | Thuần: `TEMPLATES`, `insertBatch`, `dropPosition`. |
| `src/app/p/[id]/editor/visual/insert-panel.tsx` (mới) | Panel "Thêm". |
| `src/app/p/[id]/editor/visual/{canvas,overlay,visual-editor}.tsx` | zoom, lớp phủ kéo, handle, guide, đo, drawer, view-only, card Section. |
| Xoá | `src/core/grapes-adapter.ts`, `src/app/p/[id]/editor/editor-view.tsx`, `src/app/api/projects/[id]/editor/{save,promote-layout}/route.ts`, `tests/unit/grapes-adapter.test.ts`, `tests/e2e/grapes-textnode.test.ts`. |
| Tests | `tests/unit/{ir-command,ir-store,command-bus,editor-model,style-model,gestures,snap,templates,editor-api,emit-components,fidelity,icons}.test.ts`, `tests/e2e/visual-editor-advanced.test.ts` (mới), `tests/e2e/{editor-smoke,editor-components}.test.ts` (chuyển). |

Interface dùng chung (bổ sung cho E3a):

```ts
// command-bus.ts
export type Op = | { kind: "commands"; label: string; commands: EditorCommand[]; done?: string; coalesceKey?: string; apply?(): void; rollback?(): void } | { kind: "undo" | "redo"; label: string; done?: string };
export type SendBody = { baseRevision: number; pageId: string; commands?: EditorCommand[]; coalesce?: true };
// ir-store.ts
commitCommands(id: string, baseRevision: number, commands: EditorCommand[], source: EditSource, opts?: { coalesce?: boolean }): Promise<EditResult>;
// gestures.ts / snap.ts use model.Box = { x; y; w; h } (document px of the canvas frame)
```

---

### Task 1: `moveNode` giữa hai section, giữ ID (R1)

**Files:**
- Modify: `src/core/ir-command.ts:476-497` (`applyTree`), `src/app/p/[id]/editor/visual/model.ts` (`dropCommand`)
- Test: `tests/unit/ir-command.test.ts`, `tests/unit/editor-model.test.ts`

**Interfaces:**
- Consumes: `applyTree`, `withRoot`, `update`, `splice`, `withParent`, `pageTrees`, `checkIndex`, `checkDepth`, `MAX_CAPTURE_NODES` (đã có).
- Produces: `moveNode` chấp nhận `parentId` ở section khác (cả hai cây `kind === "sections"`); inverse `{ op: "moveNode", id, parentId: <cha cũ>, index: <index cũ> }`. `dropCommand` không còn lỗi "section khác".

- [ ] **Step 1: Viết test đỏ**

`tests/unit/ir-command.test.ts`: trong test `"protected roots, cycles and owner boundaries are refused"` xoá phần tử `{ op: "moveNode", id: "d", parentId: "p", index: 0 }` khỏi mảng `refused`, rồi append:

```ts
test("E3b R1: moveNode between two sections keeps the ids of the whole subtree and inverts exactly; shell and main boundaries still hold", () => {
  const ir = fixture();
  const out = roundTrip(ir, [{ op: "moveNode", id: "d", parentId: "p", index: 1 }]).ir;
  expect(kids(out).map((x) => x.id)).toEqual(["a", "d", "b", "c"]);
  expect(kids(out)[1]!.parentId).toBe("p");
  expect(kids(out, 1)).toEqual([]);
  const back = roundTrip(out, [{ op: "moveNode", id: "a", parentId: "q", index: 0 }]).ir; // with its #text child
  expect(kids(back, 1)[0]).toMatchObject({ id: "a", parentId: "q", children: [{ id: "ta", parentId: "a" }] });
  expect(() => applyCommands(ir, [{ op: "moveNode", id: "b", parentId: "body", index: 0 }])).toThrow(/boundaries/);
  expect(() => applyCommands(ir, [{ op: "moveNode", id: "d", parentId: "p", index: 9 }])).toThrow(/index out of range/);
  expect(() => applyCommands(ir, [{ op: "moveNode", id: "d", parentId: "ta", index: 0 }])).toThrow(/cannot have children/);
});
```

`tests/unit/editor-model.test.ts`: trong test `"drop: …"` đổi dòng `"track", "after"` thành:

```ts
  expect(dropCommand(index, [], "h", "track", "after")).toEqual({ commands: [{ op: "moveNode", id: "h", parentId: "r2", index: 2 }] }); // E3b R1
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `npx vitest run tests/unit/ir-command.test.ts tests/unit/editor-model.test.ts`
Expected: FAIL — `nodes cannot move across section/shell/main boundaries`; model trả lỗi "section khác".

- [ ] **Step 3: Cài đặt**

`applyTree` — thay hai dòng `const target = …; if (!sameTree(tree, target.tree)) fail(…)` và phần moveNode:

```ts
  const target = need(ir, c.parentId, fail, "parent");
  // E3 §3 (R1): a move may cross from one section to another; never into / out of a shell or a component main
  const across = !sameTree(tree, target.tree);
  if (across && !(c.op === "moveNode" && tree.kind === "sections" && target.tree.kind === "sections")) fail("nodes cannot move across section/shell/main boundaries");
  checkParent(target.node, fail);
  if (c.op === "duplicateNode") { /* unchanged */ }
  // moveNode: the index counts after the node is lifted out of its current parent.
  if (preorder(node).some((n) => n.id === target.node.id)) fail("cannot move a node into itself (cycle)");
  if (across) {
    checkIndex(c.index, target.node.children.length, fail);
    checkDepth(target, node, fail);
    const lifted = withRoot(ir, tree, update(rootOf(ir, tree), parent.id, (p) => ({ ...p, children: splice(p.children, found.index, 1) }))!);
    const next = withRoot(lifted, target.tree, update(rootOf(lifted, target.tree), target.node.id, (p) => ({ ...p, children: splice(p.children, c.index, 0, withParent(node, p.id)) }))!);
    // the subtree may join another page's section (a shared layout): that page stays loadable by migrateIR
    if (pageTrees(next, target.tree).reduce((sum, r) => sum + preorder(r).length, 0) > MAX_CAPTURE_NODES) fail(`page node limit exceeded (${MAX_CAPTURE_NODES})`);
    return { ir: next, tree, inverse: { op: "moveNode", id: node.id, parentId: parent.id, index: found.index } };
  }
  // (same-tree path unchanged)
```

`model.ts` `dropCommand`: xoá dòng `if (index.get(parentId)!.sectionId !== drag.sectionId) return { error: "Chưa chuyển được phần tử sang section khác." }; // R11 (E3b lifts it)`.

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/ir-command.test.ts tests/unit/ir-command-interactive.test.ts tests/unit/editor-model.test.ts tests/unit/ir-store.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/ir-command.ts "src/app/p/[id]/editor/visual/model.ts" tests/unit/ir-command.test.ts tests/unit/editor-model.test.ts
git commit -m "feat(e3b): moveNode across sections keeps ids (shell/main boundaries kept); editor drop allows it

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Tham chiếu node vừa tạo trong cùng batch cho `convertToComponent` (R2)

**Files:**
- Modify: `src/core/ir-command.ts:790-837` (`prepareCommands`)
- Test: `tests/unit/ir-command.test.ts`

**Interfaces:**
- Consumes: `createNode` normalize (`node` có ID server).
- Produces: trong batch, `convertToComponent.id` và chuỗi trong `roles` dạng `new:<k>/<path>` được thay bằng ID thật; tham chiếu sai → `IR_PATCH_INVALID` "command i (convertToComponent): …".

- [ ] **Step 1: Viết test đỏ** — append `tests/unit/ir-command.test.ts`:

```ts
test("E3b R2: convertToComponent names nodes an earlier createNode of the batch made (new:<k>/<path>); History keeps real ids; bad refs are refused", () => {
  const ir = fixture();
  const draft: NodeDraft = { tag: "div", children: [{ tag: "div", styles: { base: { overflow: "hidden" } }, children: [{ tag: "div", children: [{ tag: "div" }, { tag: "div" }] }] }] };
  const forward = prepareCommands(ir, [
    { op: "createNode", parentId: "p", index: 0, draft },
    { op: "convertToComponent", id: "new:0/", kind: "carousel", roles: { viewport: "new:0/0", track: "new:0/0.0", slides: ["new:0/0.0.0", "new:0/0.0.1"] } },
  ], ids());
  expect(forward[1]).toEqual({ op: "convertToComponent", id: "new1", kind: "carousel", roles: { viewport: "new2", track: "new3", slides: ["new4", "new5"] } });
  const done = roundTrip(ir, forward);
  expect(kids(done.ir)[0]!.interactive).toMatchObject({ kind: "carousel", viewport: "new2", track: "new3", slides: ["new4", "new5"] });
  expect(done.createdIds).toEqual(["new1"]);
  for (const ref of ["new:1/", "new:0/9", "new:0/0.0.0.0", "new:7/"]) {
    expect(() => prepareCommands(ir, [{ op: "createNode", parentId: "p", index: 0, draft }, { op: "convertToComponent", id: ref, kind: "carousel", roles: {} }], ids()), ref).toThrow(/command 1/);
  }
  // a plain id that only looks alike is left alone (and then simply not found)
  expect(() => prepareCommands(ir, [{ op: "convertToComponent", id: "new:x", kind: "carousel", roles: {} }], ids())).toThrow(/not found/);
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `npx vitest run tests/unit/ir-command.test.ts -t "R2"`
Expected: FAIL — `node not found: new:0/`.

- [ ] **Step 3: Cài đặt** — trong `ir-command.ts` (cạnh `fromDraft`):

```ts
// E3b R2: a later command of the batch may name a node an earlier createNode made as `new:<k>/<path>` (k: that
// command's index, path: child indexes from its root, "" = the root): the client cannot know server ids yet, and a
// template + its component stay one batch (one Undo). Resolved here, so History stores real ids.
const NEW_REF = /^new:(\d{1,2})\/((?:\d{1,4}(?:\.\d{1,4})*)?)$/;
function resolveRefs<T>(value: T, created: ReadonlyMap<number, IRNodeV2>, fail: Fail): T {
  if (typeof value === "string") {
    const m = NEW_REF.exec(value);
    if (!m) return value;
    let node = created.get(Number(m[1])) ?? fail(`${value}: no createNode at index ${m[1]} earlier in this batch`);
    for (const step of m[2] ? m[2].split(".") : []) node = node.children[Number(step)] ?? fail(`${value}: no such child`);
    return node.id as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, created, fail)) as T;
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveRefs(v, created, fail)])) as T;
  return value;
}
```

Trong `prepareCommands`: thêm `const created = new Map<number, IRNodeV2>();` trước `return commands.map(...)`; nhánh `convertToComponent`:

```ts
      case "convertToComponent": normalized = { op: command.op, id: resolveRefs(command.id, created, fail), kind: command.kind, roles: isObject(command.roles) ? resolveRefs({ ...command.roles }, created, fail) : command.roles }; break;
```

và sau `switch`, trước `current = applyOne(...)`: `if (normalized.op === "createNode") created.set(i, normalized.node);`

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/ir-command.test.ts tests/unit/ir-command-interactive.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/ir-command.ts tests/unit/ir-command.test.ts
git commit -m "feat(e3b): convertToComponent may reference nodes created earlier in the same batch (new:<k>/<path>)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Gộp bước Undo cho cùng ô style (R3) — store, route, bus

**Files:**
- Modify: `src/core/ir-store.ts:117-142,185-190`, `src/app/api/projects/[id]/editor/commands/route.ts`, `src/app/p/[id]/editor/visual/command-bus.ts`
- Test: `tests/unit/ir-store.test.ts`, `tests/unit/command-bus.test.ts`, `tests/unit/editor-api.test.ts`

**Interfaces:**
- Consumes: `prepareCommands`, `applyCommands`, `stepAt` (closure của store).
- Produces: `commitCommands(id, baseRevision, commands, source, opts?: { coalesce?: boolean })`; body `{ …, coalesce?: boolean }`; `BUS_LIMITS = { queue: 20, coalesceMs: 1500 }`; `Op.coalesceKey`; `new CommandBus(revision, pageId, send, emit, now?)`.

- [ ] **Step 1: Viết test đỏ**

`tests/unit/ir-store.test.ts` append:

```ts
test("E3b R3: coalesce folds a repeat of the latest step's style fields into that step — one Undo restores the value before both; anything else is a new step", async () => {
  const { db, store } = setup();
  const color = (c: string) => [{ op: "setStyle" as const, id: "r", target: "base" as const, changes: { color: c } }];
  const colorOf = async () => (await store.loadDocument("p")).sections[0]!.root.styles.base.color;
  await store.commitCommands("p", 0, color("red"), "user");
  expect(await store.commitCommands("p", 1, color("blue"), "user", { coalesce: true })).toEqual({ revision: 2, createdIds: [], canUndo: true, canRedo: false });
  expect([historyRows(db, "p"), stateOf(db, "p")]).toEqual([1, { revision: 2, cursor: 1, materialized_revision: 2 }]);
  await store.undoDocument("p", 2);
  expect(await colorOf()).toBeUndefined();
  await store.redoDocument("p", 3);
  expect(await colorOf()).toBe("blue");
  // another property: a new step
  await store.commitCommands("p", 4, [{ op: "setStyle", id: "r", target: "base", changes: { "font-size": "20px" } }], "user", { coalesce: true });
  expect(historyRows(db, "p")).toBe(2);
  // a Redo branch (the latest step undone) is never rewritten: a new step that drops the branch
  await store.undoDocument("p", 5);
  await store.commitCommands("p", 6, color("green"), "user", { coalesce: true });
  expect([historyRows(db, "p"), stateOf(db, "p")!.cursor]).toEqual([2, 2]);
  // a non-style batch never coalesces
  await store.commitCommands("p", 7, setText("x"), "user", { coalesce: true });
  expect(historyRows(db, "p")).toBe(3);
});
```

(Sau Undo ở revision 6 cursor = 1 và bước seq 2 tồn tại → nhánh Redo → không gộp: bước mới thay nhánh, cursor 2, vẫn 2 dòng.)

`tests/unit/command-bus.test.ts` append:

```ts
test("E3b R3: the same coalesceKey pushed within 1.5 s of the previous one, at the revision it produced, asks the server to coalesce; another key, a slower edit or a revision moved by another step does not", async () => {
  let now = 0;
  const calls: SendBody[] = [];
  let next = 1;
  const bus = new CommandBus(1, "pg", async (_op, body) => { calls.push(body); return ok(++next); }, () => {}, () => now);
  const style = (key: string): Op => ({ kind: "commands", label: key, commands: [{ op: "setStyle", id: "a", target: "base", changes: { color: key } }], coalesceKey: key });
  bus.push(style("a|base|color")); await tick();
  now = 1000; bus.push(style("a|base|color")); await tick();
  now = 2400; bus.push(style("a|base|color")); await tick();
  now = 4000; bus.push(style("a|base|color")); await tick();
  now = 4100; bus.push(style("a|base|font-size")); await tick();
  now = 4200; bus.push({ kind: "undo", label: "Hoàn tác" }); await tick();
  now = 4300; bus.push(style("a|base|font-size")); await tick();
  expect(calls.map((c) => c.coalesce ?? false)).toEqual([false, true, true, false, false, false, false]);
});
```

`tests/unit/editor-api.test.ts` append:

```ts
test("E3b R3: commands route accepts coalesce and folds a repeated style edit into one History step", async () => {
  const id = await seed();
  const root = await rootId(id);
  const color = (c: string) => [{ op: "setStyle", id: root, target: "base", changes: { color: c } }];
  expect((await post(commandsRoute, id, { baseRevision: 0, commands: color("red") })).status).toBe(200);
  expect((await post(commandsRoute, id, { baseRevision: 1, commands: color("blue"), coalesce: true })).status).toBe(200);
  expect((await post(undoRoute, id, { baseRevision: 2 })).status).toBe(200);
  expect((await projectDocuments(getDb()).loadDocument(id)).sections[0]!.root.styles.base.color).toBeUndefined();
  expect((await post(commandsRoute, id, { baseRevision: 3, commands: color("x"), coalesce: "yes" })).status).toBe(400);
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `npx vitest run tests/unit/ir-store.test.ts tests/unit/command-bus.test.ts tests/unit/editor-api.test.ts -t "R3"`
Expected: FAIL — 2 dòng History thay vì 1; `coalesce` luôn undefined; route 400 (unknown key `coalesce`).

- [ ] **Step 3: Cài đặt**

`ir-store.ts`:

```ts
// E3b R3: `next` repeats the latest step's style fields exactly (same nodes, targets and property sets, nothing else)
function sameStyleFields(prev: unknown, next: readonly unknown[]): boolean {
  const key = (c: unknown) => {
    const s = c as { op?: unknown; id?: unknown; target?: unknown; changes?: unknown };
    return s?.op === "setStyle" && s.changes && typeof s.changes === "object" ? JSON.stringify([s.id, s.target, Object.keys(s.changes).sort()]) : undefined;
  };
  return Array.isArray(prev) && prev.length === next.length && next.every((c, i) => { const a = key(prev[i]); return a !== undefined && a === key(c); });
}
```

Trong `change()` đổi câu INSERT thành `INSERT OR REPLACE INTO document_history(...) VALUES(...)` (bước thường: seq = cursor + 1 sau khi xoá nhánh Redo → không đụng dòng nào; bước gộp: thay đúng dòng tại cursor).

`commitCommands`:

```ts
    // New node IDs come from randomUUID here; the normalized forward is stored, so Redo re-creates the same IDs.
    // E3b R3 `coalesce`: the same style fields again (the client's 1.5 s window) replace the latest step's forward and
    // keep its inverse — one Undo returns to the value before both; anything else is a normal new step.
    commitCommands: (id: string, baseRevision: number, commands: EditorCommand[], source: EditSource, opts: { coalesce?: boolean } = {}) =>
      change(id, baseRevision, source, (ir, cursor) => {
        const forward = prepareCommands(ir, commands, randomUUID);
        const done = applyCommands(ir, forward); // refuses a step over 8 MB (forward + inverse)
        const last = opts.coalesce && !stepAt(id, cursor + 1) ? stepAt(id, cursor) : undefined;
        const fold = last !== undefined && sameStyleFields(JSON.parse(last.forward_json), forward);
        return {
          ir: clearNotedFields(done.ir, forward), createdIds: done.createdIds, cursor: fold ? cursor : cursor + 1,
          step: { forward: JSON.stringify(forward), inverse: fold ? last!.inverse_json : JSON.stringify(done.inverse) },
        };
      }),
```

`commands/route.ts`: `bodySchema` thêm `coalesce: z.boolean().optional()`; gọi `store.commitCommands(id, baseRevision, commands, "user", { coalesce })`.

`command-bus.ts` — type và lớp sau thay bản E3a (nhánh lỗi giữ nguyên, chỉ thêm `this.last = undefined`):

```ts
export const BUS_LIMITS = { queue: 20, coalesceMs: 1500 } as const;
export type Op =
  | { kind: "commands"; label: string; commands: EditorCommand[]; done?: string; coalesceKey?: string; apply?(): void; rollback?(): void }
  | { kind: "undo" | "redo"; label: string; done?: string };
export type SendBody = { baseRevision: number; pageId: string; commands?: EditorCommand[]; coalesce?: true };

export class CommandBus {
  private queue: Op[] = [];
  private busy = false;
  private stop: "none" | "retry" | "reload" = "none";
  // R3: the last committed op with a coalesce key — its key, the revision it produced, when the user pushed it
  private last: { key: string; revision: number; at: number } | undefined;
  private readonly pushedAt = new WeakMap<Op, number>();
  constructor(private rev: number, private readonly pageId: string, private readonly send: Send, private readonly emit: (e: BusEvent) => void, private readonly now: () => number = Date.now) {}
  get pending(): number { return this.queue.length + (this.busy ? 1 : 0); }
  get revision(): number { return this.rev; }

  push(op: Op): boolean {
    if (this.stop === "reload") return false;
    if (this.queue.length >= BUS_LIMITS.queue) { this.emit({ type: "full" }); return false; }
    if (op.kind === "commands") op.apply?.();
    this.pushedAt.set(op, this.now());
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
    const at = this.pushedAt.get(op) ?? this.now(), key = op.kind === "commands" ? op.coalesceKey : undefined;
    const coalesce = key !== undefined && this.last?.key === key && this.last.revision === this.rev && at - this.last.at <= BUS_LIMITS.coalesceMs;
    try {
      const result = await this.send(op, { baseRevision: this.rev, pageId: this.pageId, ...(op.kind === "commands" && { commands: op.commands }), ...(coalesce && { coalesce: true as const }) });
      this.rev = result.revision;
      this.last = key !== undefined ? { key, revision: result.revision, at } : undefined;
      this.busy = false;
      this.emit({ type: "done", op, result });
    } catch (e) {
      this.busy = false;
      this.last = undefined;
      // ... the E3a error branches, unchanged (RELOAD / DOCUMENT_MATERIALIZE_FAILED / REFUSED / retry)
    }
    void this.pump();
  }
}
```

(Khối `catch` giữ nguyên bốn nhánh của E3a Task 7 sau dòng `this.last = undefined;`.)

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/ir-store.test.ts tests/unit/command-bus.test.ts tests/unit/editor-api.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- src/core/ir-store.ts "src/app/api/projects/[id]/editor/commands/route.ts" "src/app/p/[id]/editor/visual/command-bus.ts" tests/unit/ir-store.test.ts tests/unit/command-bus.test.ts tests/unit/editor-api.test.ts
git commit -m "feat(e3b): one Undo step per style field edited within 1.5 s (bus coalesceKey + store folds the latest step)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Model Style Manager (thuần)

**Files:**
- Create: `src/app/p/[id]/editor/visual/style-model.ts`
- Test: `tests/unit/style-model.test.ts`

**Interfaces:**
- Consumes: `styleTarget`, `GENERATED`, `Batch`, `Bp` (model); `isSafeCss`.
- Produces:

```ts
export type StateName = "hover" | "focus" | "active";
export type Source = "here" | "desktop" | "main";
export type Field = { value: string; source: Source; path: string };
export const SOURCE_VI: Record<Source, string>;
export const GROUPS: readonly { id: string; label: string; props: readonly string[] }[];
export const CHOICES: Readonly<Partial<Record<string, readonly string[]>>>;
export function layerPath(bp: Bp, state: StateName | undefined, prop: string): string;
export function fieldOf(node: IRNodeV2, bp: Bp, state: StateName | undefined, prop: string): Field | undefined;
export function setField(node: IRNodeV2, bp: Bp, state: StateName | undefined, prop: string, value: string): Batch;
export function clearField(node: IRNodeV2, bp: Bp, state: StateName | undefined, prop: string): Batch;
export function otherProps(node: IRNodeV2, bp: Bp, state: StateName | undefined): string[];
export function scrub(value: string, delta: number): string | undefined;
export const styleKey: (id: string, bp: Bp, state: StateName | undefined, prop: string) => string;
```

- [ ] **Step 1: Viết test đỏ** — `tests/unit/style-model.test.ts`:

```ts
import { expect, test } from "vitest";
import type { IRNodeV2 } from "@/core/ir-v2";
import { clearField, fieldOf, GROUPS, otherProps, scrub, setField, styleKey } from "@/app/p/[id]/editor/visual/style-model";

const node = (extra: Partial<IRNodeV2> = {}): IRNodeV2 => ({
  id: "n", tag: "h1", type: "text", attrs: {}, children: [],
  styles: { base: { color: "red", "font-size": "48px", "outline-offset": "2px" }, bp: { 768: { color: "blue" } }, state: { hover: { color: "green" } }, pseudo: {} }, ...extra,
});

test("value sources: the layer itself; 768 and 375 inherit Desktop (375 never 768, R4); states own their layer; an instance shows main values it does not override", () => {
  expect(fieldOf(node(), 1440, undefined, "color")).toEqual({ value: "red", source: "here", path: "styles.base.color" });
  expect(fieldOf(node(), 768, undefined, "color")).toEqual({ value: "blue", source: "here", path: "styles.bp.768.color" });
  expect(fieldOf(node(), 768, undefined, "font-size")).toEqual({ value: "48px", source: "desktop", path: "styles.base.font-size" });
  expect(fieldOf(node(), 375, undefined, "color")).toEqual({ value: "red", source: "desktop", path: "styles.base.color" });
  expect(fieldOf(node(), 1440, "hover", "color")).toEqual({ value: "green", source: "here", path: "styles.state.hover.color" });
  expect(fieldOf(node(), 1440, "hover", "font-size")).toBeUndefined();
  expect(fieldOf(node(), 1440, undefined, "width")).toBeUndefined();
  const inst = node({ component: { id: "c", role: "instance", sourceId: "m", overrides: ["styles.base.color"] } });
  expect(fieldOf(inst, 1440, undefined, "color")!.source).toBe("here");
  expect(fieldOf(inst, 1440, undefined, "font-size")!.source).toBe("main");
  expect(fieldOf(inst, 768, undefined, "font-size")!.source).toBe("main");
});

test("setField / clearField: one setStyle at the bp/state target; unsafe CSS refused before anything is sent; ↺ removes exactly that layer (resetOverride on an instance)", () => {
  expect(setField(node(), 768, undefined, "width", " 50% ")).toEqual({ commands: [{ op: "setStyle", id: "n", target: 768, changes: { width: "50%" } }] });
  expect(setField(node(), 1440, "focus", "color", "black")).toEqual({ commands: [{ op: "setStyle", id: "n", target: "focus", changes: { color: "black" } }] });
  for (const bad of ["red; } body{display:none", 'url("x', "a\nb", "/* x */"]) expect(setField(node(), 1440, undefined, "color", bad)).toEqual({ error: expect.stringMatching(/không hợp lệ/) });
  expect(setField(node(), 1440, undefined, "Bad Prop", "1px")).toEqual({ error: expect.any(String) });
  expect(setField(node(), 768, undefined, "color", "")).toEqual({ commands: [{ op: "setStyle", id: "n", target: 768, changes: { color: null } }] });
  expect(clearField(node(), 768, undefined, "font-size")).toEqual({ error: expect.stringMatching(/không đặt/) });
  const inst = node({ component: { id: "c", role: "instance", sourceId: "m", overrides: ["styles.base.color"] } });
  expect(clearField(inst, 1440, undefined, "color")).toEqual({ commands: [{ op: "resetOverride", instanceId: "n", path: "styles.base.color" }] });
  expect(clearField(inst, 1440, undefined, "font-size")).toEqual({ error: expect.stringMatching(/main/) });
  expect(setField({ ...node(), id: "instance:1:x:n" }, 1440, undefined, "color", "red")).toEqual({ error: expect.stringMatching(/instance/) });
});

test("catalog, other properties, scrubbing numbers, coalesce keys", () => {
  expect(GROUPS.map((g) => g.label)).toEqual(["Layout", "Kích thước", "Khoảng cách", "Chữ", "Hiển thị", "Biến đổi"]);
  expect(GROUPS.flatMap((g) => g.props)).toEqual(expect.arrayContaining(["display", "flex-direction", "grid-template-columns", "z-index", "min-width", "padding-left", "letter-spacing", "box-shadow", "rotate"]));
  expect(otherProps(node(), 1440, undefined)).toEqual(["outline-offset"]);
  expect([scrub("12px", 3), scrub("1.5em", 1), scrub("", 2), scrub("-4px", -1), scrub("auto", 1)]).toEqual(["15px", "2.5em", "2px", "-5px", undefined]);
  expect(styleKey("n", 768, undefined, "color")).toBe("n|768|color");
  expect(styleKey("n", 1440, "hover", "color")).toBe("n|hover|color");
});
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `npx vitest run tests/unit/style-model.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Cài đặt** — `src/app/p/[id]/editor/visual/style-model.ts`:

```ts
// E3 §3 Style Manager model (pure): the value a property shows at (breakpoint, state), where it comes from (R4, R5),
// and the one command that sets or removes exactly that layer.
import type { IRNodeV2 } from "@/core/ir-v2";
import { isSafeCss } from "@/core/safe-names";
import { GENERATED, styleTarget, type Batch, type Bp } from "./model";

export type StateName = "hover" | "focus" | "active";
export type Source = "here" | "desktop" | "main";
export type Field = { value: string; source: Source; path: string };
export const SOURCE_VI: Record<Source, string> = { here: "đặt ở bp này", desktop: "kế thừa từ Desktop", main: "từ main component" };
export const GROUPS = [
  { id: "layout", label: "Layout", props: ["display", "flex-direction", "flex-wrap", "justify-content", "align-items", "gap", "grid-template-columns", "grid-template-rows", "position", "top", "right", "bottom", "left", "overflow", "z-index"] },
  { id: "size", label: "Kích thước", props: ["width", "height", "min-width", "max-width", "min-height", "max-height"] },
  { id: "spacing", label: "Khoảng cách", props: ["margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left"] },
  { id: "typography", label: "Chữ", props: ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-align", "color"] },
  { id: "appearance", label: "Hiển thị", props: ["background-color", "background-image", "border", "border-radius", "opacity", "box-shadow"] },
  { id: "transform", label: "Biến đổi", props: ["translate", "scale", "rotate"] },
] as const satisfies readonly { id: string; label: string; props: readonly string[] }[];
export const CHOICES: Readonly<Partial<Record<string, readonly string[]>>> = {
  display: ["block", "inline", "inline-block", "flex", "inline-flex", "grid", "none"],
  "flex-direction": ["row", "row-reverse", "column", "column-reverse"],
  "flex-wrap": ["nowrap", "wrap", "wrap-reverse"],
  "justify-content": ["flex-start", "center", "flex-end", "space-between", "space-around", "space-evenly"],
  "align-items": ["stretch", "flex-start", "center", "flex-end", "baseline"],
  position: ["static", "relative", "absolute", "fixed", "sticky"],
  overflow: ["visible", "hidden", "auto", "scroll"],
  "text-align": ["left", "center", "right", "justify"],
  "font-weight": ["100", "200", "300", "400", "500", "600", "700", "800", "900"],
};
const GEN_MSG = "Phần tử này thuộc component instance — sửa ở main hoặc Tách khỏi component (Detach).";
export const layerPath = (bp: Bp, state: StateName | undefined, prop: string): string =>
  state ? `styles.state.${state}.${prop}` : bp === 1440 ? `styles.base.${prop}` : `styles.bp.${bp}.${prop}`;
const layer = (n: IRNodeV2, bp: Bp, state?: StateName) => (state ? n.styles.state[state] : bp === 1440 ? n.styles.base : n.styles.bp[bp]);
export const styleKey = (id: string, bp: Bp, state: StateName | undefined, prop: string): string => `${id}|${styleTarget(bp, state)}|${prop}`;

export function fieldOf(node: IRNodeV2, bp: Bp, state: StateName | undefined, prop: string): Field | undefined {
  const instance = node.component?.role === "instance", overrides = node.component?.overrides ?? [];
  const at = (value: string, path: string, own: Source): Field => ({ value, path, source: instance && !overrides.includes(path) ? "main" : own });
  const own = layer(node, bp, state)?.[prop];
  if (own !== undefined) return at(own, layerPath(bp, state, prop), "here");
  if (state || bp === 1440) return undefined;
  const base = node.styles.base[prop]; // R4: 768 and 375 both fall back to Desktop
  return base !== undefined ? at(base, layerPath(1440, undefined, prop), "desktop") : undefined;
}
export function clearField(node: IRNodeV2, bp: Bp, state: StateName | undefined, prop: string): Batch {
  if (node.id.startsWith(GENERATED)) return { error: GEN_MSG };
  const f = fieldOf(node, bp, state, prop);
  if (!f || f.source === "desktop") return { error: "Lớp này không đặt giá trị để bỏ." };
  if (f.source === "main") return { error: "Giá trị lấy từ main component — sửa ở main." };
  if (node.component?.role === "instance") return { commands: [{ op: "resetOverride", instanceId: node.id, path: f.path }] };
  return { commands: [{ op: "setStyle", id: node.id, target: styleTarget(bp, state), changes: { [prop]: null } }] };
}
export function setField(node: IRNodeV2, bp: Bp, state: StateName | undefined, prop: string, value: string): Batch {
  if (node.id.startsWith(GENERATED)) return { error: GEN_MSG };
  const v = value.trim();
  if (v === "") return own(node, bp, state, prop) ? { commands: [{ op: "setStyle", id: node.id, target: styleTarget(bp, state), changes: { [prop]: null } }] } : { commands: [] };
  if (!isSafeCss(prop, v)) return { error: `Giá trị CSS không hợp lệ cho ${prop}.` };
  return { commands: [{ op: "setStyle", id: node.id, target: styleTarget(bp, state), changes: { [prop]: v } }] };
}
const own = (node: IRNodeV2, bp: Bp, state: StateName | undefined, prop: string) => layer(node, bp, state)?.[prop] !== undefined;
export function otherProps(node: IRNodeV2, bp: Bp, state: StateName | undefined): string[] {
  const known = new Set<string>(GROUPS.flatMap((g) => g.props));
  return Object.keys(layer(node, bp, state) ?? {}).filter((p) => !known.has(p)).sort();
}
const NUMBER = /^(-?\d*\.?\d+)([a-z%]*)$/i;
// "kéo trực tiếp trên số": the number moves by `delta`, the unit stays (px when there is none)
export function scrub(value: string, delta: number): string | undefined {
  const m = NUMBER.exec(value.trim() || "0px");
  if (!m) return undefined;
  return `${Math.round((Number(m[1]) + delta) * 100) / 100}${m[2] || "px"}`;
}
```

(`setField` với chuỗi rỗng khi lớp có giá trị = xoá prop ở lớp đó; khi lớp không có = không gì: test dòng `768 … color, ""` mong `null` vì 768 có `color: blue`.)

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/style-model.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/style-model.ts" tests/unit/style-model.test.ts
git commit -m "feat(e3b): pure Style Manager model — value sources per bp/state/main, set/clear one layer, catalog, scrub

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Style Manager UI (lạc quan, debounce 300 ms, gộp Undo)

**Files:**
- Create: `src/app/p/[id]/editor/visual/style-panel.tsx`, `tests/e2e/visual-editor-advanced.test.ts`
- Modify: `src/app/p/[id]/editor/visual/visual-editor.tsx`, `src/app/globals.css`, `docs/superpowers/design/stitch-screens.md`

**Interfaces:**
- Consumes: Task 3 (`coalesceKey`), Task 4 (toàn bộ), `Disclosure`, `SegmentedControl`, `Badge`, `IconButton`, `Field`.
- Produces: `export const STYLE_DEBOUNCE_MS = 300; export function StylePanel(props: { node: IRNodeV2; element: HTMLElement | null; bp: Bp; fonts: string[]; onBatch(b: Batch, label: string, extra: { coalesceKey?: string; rollback?: () => void }): void; onMessage(text: string): void }): JSX.Element`.

- [ ] **Step 1: Viết e2e đỏ** — `tests/e2e/visual-editor-advanced.test.ts` (khung giống `visual-editor.test.ts` của E3a: cùng `beforeAll` pipeline site1, `afterAll`, các helper `canvas`, `payload`, `outHtml`, `status`, `saved`, `walk`, `allNodes`, `noSideScroll`, `open`, `countSwaps` — chép nguyên từ file E3a, đổi prefix tmp thành `"visual-advanced-"`), rồi:

```ts
const nodeById = async (nid: string) => (await allNodes()).find((x) => x.id === nid) as (Tree & { styles: { base: Record<string, string>; bp: Record<string, Record<string, string>>; state: Record<string, Record<string, string>> } }) | undefined;
const fieldIn = (page: Page, prop: string) => page.locator(`[data-ui="ui_editor_style_field"][data-prop="${prop}"]`);

test("E3b Style Manager: values with their source (inherited at 768), optimistic at once, one section swapped, several edits on one field = one Undo; unsafe values never sent; ↺ removes the layer; :hover; free property", { timeout: 240_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  const h1Id = (await h1.getAttribute("data-ir-id"))!;
  await h1.click();
  await page.getByRole("tab", { name: "Style" }).click();
  const color = fieldIn(page, "color");
  await expect.poll(() => color.locator("input").inputValue()).toBe("rgb(200, 30, 60)");
  expect(await color.innerText()).toContain("đặt ở bp này");
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "768" }).click();
  await expect.poll(() => color.innerText()).toContain("kế thừa từ Desktop");
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "1440" }).click();
  // two edits 500 ms apart: optimistic, one section swapped per step, one Undo restores the original
  const swaps = await countSwaps(page);
  const rev = (await payload()).revision;
  await color.locator("input").fill("rgb(0, 128, 0)");
  expect(await h1.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(0, 128, 0)");
  await page.waitForTimeout(500);
  await color.locator("input").fill("rgb(0, 0, 255)");
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.base.color, { timeout: 30_000 }).toBe("rgb(0, 0, 255)");
  expect((await payload()).revision).toBe(rev + 2);
  expect(await swaps()).toBe(2);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.base.color, { timeout: 30_000 }).toBe("rgb(200, 30, 60)");
  // unsafe: inline error, nothing sent, the canvas back to the stored value
  const before = (await payload()).revision;
  await color.locator("input").fill("red; } body{display:none");
  await expect.poll(() => color.locator('[role="alert"]').innerText()).toMatch(/không hợp lệ/);
  await page.waitForTimeout(600);
  expect((await payload()).revision).toBe(before);
  expect(await h1.evaluate((el) => getComputedStyle(el).color)).toBe("rgb(200, 30, 60)");
  // ↺ at 768 (switching breakpoint drops the refused draft): set, then removed again
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "768" }).click();
  await color.locator("input").fill("rgb(10, 10, 10)");
  await saved(page);
  await expect.poll(() => color.innerText()).toContain("đặt ở bp này");
  await color.getByRole("button", { name: "Bỏ color ở lớp này" }).click();
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.bp["768"]?.color).toBeUndefined();
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "1440" }).click();
  // :hover and a free property
  await page.getByRole("group", { name: "Trạng thái" }).getByRole("button", { name: ":hover" }).click();
  await expect.poll(() => page.getByText("Trạng thái áp cho mọi breakpoint").isVisible()).toBe(true);
  await color.locator("input").fill("rgb(1, 2, 3)");
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.state.hover?.color, { timeout: 30_000 }).toBe("rgb(1, 2, 3)");
  await page.getByRole("group", { name: "Trạng thái" }).getByRole("button", { name: "Mặc định" }).click();
  const free = page.locator('[data-ui="ui_editor_style_free"]');
  await free.getByRole("textbox", { name: "Thuộc tính" }).fill("outline-offset");
  await free.getByRole("textbox", { name: "Giá trị" }).fill("3px");
  await free.getByRole("button", { name: "Thêm" }).click();
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.base["outline-offset"], { timeout: 30_000 }).toBe("3px");
  for (let i = 0; i < 4; i++) { await page.getByRole("button", { name: "Hoàn tác" }).click(); await saved(page); } // free, hover, ↺, 768 set
  await expectUi(page, ["ui_editor_style_panel", "ui_editor_style_group", "ui_editor_style_state"]);
  await page.close();
});
```

(Import `expectUi` từ `./ui-checks`; type `Tree` như file E3a.)

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts -t "Style Manager"`
Expected: FAIL — không có `ui_editor_style_field`.

- [ ] **Step 2: Cài đặt `style-panel.tsx`**

```tsx
"use client";
// E3 §3 Style Manager: the selected node's properties at the open breakpoint and state, each with its value source and
// "↺ bỏ"; applied to the canvas at once (inline, optimistic), sent 300 ms after typing stops with a coalesce key so
// edits on one field within 1.5 s are one Undo step (R3). Unsafe CSS never leaves the panel.
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { IRNodeV2 } from "@/core/ir-v2";
import { Badge } from "@/app/_ui/Badge";
import { Button } from "@/app/_ui/Button";
import { Disclosure } from "@/app/_ui/Disclosure";
import { IconButton } from "@/app/_ui/IconButton";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import type { Batch, Bp } from "./model";
import { CHOICES, clearField, fieldOf, GROUPS, otherProps, scrub, setField, SOURCE_VI, styleKey, type StateName } from "./style-model";

export const STYLE_DEBOUNCE_MS = 300;
type Extra = { coalesceKey?: string; rollback?: () => void };
type Props = { node: IRNodeV2; element: HTMLElement | null; bp: Bp; fonts: string[]; onBatch(b: Batch, label: string, extra: Extra): void; onMessage(text: string): void };
const SPACING_LABEL: Record<string, string> = { top: "trên", right: "phải", bottom: "dưới", left: "trái" };

export function StylePanel({ node, element, bp, fonts, onBatch, onMessage }: Props) {
  const [state, setState] = useState<"" | StateName>("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [freeProp, setFreeProp] = useState("");
  const [freeValue, setFreeValue] = useState("");
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const burst = useRef(new Map<string, string>()); // the inline value before this field's current burst of edits
  const st = state || undefined;
  useEffect(() => { setDrafts({}); setErrors({}); }, [node.id, bp, state]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const inline = (prop: string, value: string | null) => {
    if (!element || st) return; // states are not previewed inline
    if (value === null || value === "") element.style.removeProperty(prop); else element.style.setProperty(prop, value);
  };
  const send = (prop: string, value: string) => {
    const b = setField(node, bp, st, prop, value);
    const prev = burst.current.get(prop) ?? "";
    burst.current.delete(prop);
    const rollback = () => inline(prop, prev);
    if ("error" in b) { rollback(); setErrors((e) => ({ ...e, [prop]: b.error })); return; }
    if (b.commands.length) onBatch(b, `Style ${prop}`, { coalesceKey: styleKey(node.id, bp, st, prop), rollback });
  };
  const edit = (prop: string, value: string) => {
    setDrafts((d) => ({ ...d, [prop]: value }));
    setErrors((e) => { const { [prop]: _gone, ...rest } = e; return rest; });
    if (!burst.current.has(prop)) burst.current.set(prop, element?.style.getPropertyValue(prop) ?? "");
    const check = setField(node, bp, st, prop, value);
    if ("error" in check) setErrors((e) => ({ ...e, [prop]: check.error }));
    else inline(prop, value.trim());
    clearTimeout(timers.current.get(prop));
    timers.current.set(prop, setTimeout(() => send(prop, value), STYLE_DEBOUNCE_MS));
  };
  const computed = (prop: string) => (element ? element.ownerDocument.defaultView!.getComputedStyle(element).getPropertyValue(prop) : "");
  const scrubbing = (prop: string, start: string) => (e: ReactPointerEvent<HTMLElement>) => {
    const x0 = e.clientX;
    const move = (m: PointerEvent) => { const next = scrub(start, Math.round(m.clientX - x0)); if (next) edit(prop, next); };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const field = (prop: string, label = prop, compact = false) => {
    const f = fieldOf(node, bp, st, prop);
    const value = drafts[prop] ?? f?.value ?? "";
    const choices = prop === "font-family" ? fonts : CHOICES[prop];
    const listId = `ve-${prop}-choices`;
    return (
      <div key={prop} className={`ve-field${compact ? " is-compact" : ""}`} data-ui="ui_editor_style_field" data-prop={prop}>
        <label className="ve-field-name" onPointerDown={compact ? scrubbing(prop, value || computed(prop)) : undefined} title={compact ? "Kéo ngang để đổi số" : undefined}>{label}</label>
        <input value={value} placeholder={computed(prop)} aria-label={label} list={choices ? listId : undefined} onChange={(e) => edit(prop, e.target.value)} />
        {choices && <datalist id={listId}>{choices.map((c) => <option key={c} value={c} />)}</datalist>}
        {!compact && f && <Badge tone={f.source === "here" ? "primary" : "neutral"}>{SOURCE_VI[f.source]}</Badge>}
        {!compact && <IconButton icon="replay" label={`Bỏ ${prop} ở lớp này`} disabled={f?.source !== "here"} onClick={() => onBatch(clearField(node, bp, st, prop), `Bỏ ${prop}`, {})} />}
        {errors[prop] && <span role="alert" className="cmp-error t-body-sm">{errors[prop]}</span>}
      </div>
    );
  };
  return (
    <div className="stack" data-ui="ui_editor_style_panel">
      <SegmentedControl<"" | StateName> label="Trạng thái" data-ui="ui_editor_style_state" value={state} onChange={setState}
        options={[{ value: "", label: "Mặc định" }, { value: "hover", label: ":hover" }, { value: "focus", label: ":focus" }, { value: "active", label: ":active" }]} />
      {st && <p className="t-body-sm text-2">Trạng thái áp cho mọi breakpoint.</p>}
      {GROUPS.map((g) => (
        <Disclosure key={g.id} summary={g.label} defaultOpen={g.id === "typography" || g.id === "layout"} data-ui="ui_editor_style_group">
          {g.id === "spacing" ? (
            <div className="ve-box">
              <span className="t-label-sm text-3">margin</span>
              {(["top", "right", "bottom", "left"] as const).map((s) => <div key={s} className={`ve-box-${s}`}>{field(`margin-${s}`, SPACING_LABEL[s], true)}</div>)}
              <div className="ve-box-inner">
                <span className="t-label-sm text-3">padding</span>
                {(["top", "right", "bottom", "left"] as const).map((s) => <div key={s} className={`ve-box-${s}`}>{field(`padding-${s}`, SPACING_LABEL[s], true)}</div>)}
              </div>
            </div>
          ) : g.props.map((p) => field(p))}
        </Disclosure>
      ))}
      <Disclosure summary="Thuộc tính khác" data-ui="ui_editor_style_free">
        {otherProps(node, bp, st).map((p) => field(p))}
        <div className="ve-free">
          <input aria-label="Thuộc tính" placeholder="vd. outline-offset" value={freeProp} onChange={(e) => setFreeProp(e.target.value.trim())} />
          <input aria-label="Giá trị" placeholder="vd. 2px" value={freeValue} onChange={(e) => setFreeValue(e.target.value)} />
          <Button onClick={() => { const b = setField(node, bp, st, freeProp, freeValue); if ("error" in b) return onMessage(b.error); onBatch(b, `Style ${freeProp}`, {}); setFreeProp(""); setFreeValue(""); }} disabled={!freeProp || !freeValue}>Thêm</Button>
        </div>
      </Disclosure>
    </div>
  );
}
```

`visual-editor.tsx`: trong tab Style, trước `<ElementPanel …>`:

```tsx
            <StylePanel key={selection[0]} node={index.get(selection[0])!.node} element={canvas.current?.element(selection[0]) ?? null} bp={bp} fonts={data.fonts}
              onBatch={(b, label, extra) => batch(b, label, extra)} onMessage={setMsg} />
```

`globals.css`:

```css
.ve-field { display: grid; grid-template-columns: 92px minmax(0, 1fr) auto auto; align-items: center; gap: 4px; }
.ve-field > [role="alert"] { grid-column: 1 / -1; }
.ve-field-name { font: var(--t-label-sm); color: var(--c-text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ve-field.is-compact { grid-template-columns: minmax(0, 1fr); justify-items: center; }
.ve-field.is-compact .ve-field-name { cursor: ew-resize; }
.ve-field.is-compact input { width: 56px; text-align: center; }
.ve-box, .ve-box-inner { display: grid; grid-template-areas: ". t ." "l c r" ". b ."; grid-template-columns: 1fr minmax(0, 1.4fr) 1fr; gap: 4px; padding: 6px; border: 1px dashed var(--c-border); border-radius: var(--r-sm); }
.ve-box-top { grid-area: t; } .ve-box-right { grid-area: r; } .ve-box-bottom { grid-area: b; } .ve-box-left { grid-area: l; }
.ve-box-inner { grid-area: c; background: var(--c-surface); }
.ve-free { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 4px; }
```

`stitch-screens.md`: thêm `ui_editor_style_panel` (E3 §3 Style Manager theo node + bp + trạng thái — `setStyle`/`resetOverride`, `coalesce`), `ui_editor_style_group` (6 nhóm), `ui_editor_style_field` (ô + nguồn giá trị + ↺), `ui_editor_style_state` (Mặc định / :hover / :focus / :active), `ui_editor_style_free` (Thuộc tính khác).

- [ ] **Step 3: Chạy test, xác nhận xanh**

Run: `npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/style-panel.tsx" "src/app/p/[id]/editor/visual/visual-editor.tsx" src/app/globals.css docs/superpowers/design/stitch-screens.md tests/e2e/visual-editor-advanced.test.ts
git commit -m "feat(e3b): Style Manager — six groups, value sources, reset layer, states, free property, debounced optimistic edits

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Hình học thao tác (thuần): vạch chèn, absolute, resize, padding/gap, zoom

**Files:**
- Create: `src/app/p/[id]/editor/visual/gestures.ts`
- Modify: `src/app/p/[id]/editor/visual/model.ts` (`keyAction` thêm `zoomIn`/`zoomOut`/`zoomReset`)
- Test: `tests/unit/gestures.test.ts`, `tests/unit/editor-model.test.ts`

**Interfaces:**
- Consumes: `Box`, `Zone`, `KeyAction` (model); type `EditorCommand`, `StyleTarget`.
- Produces:

```ts
export type Axis = "x" | "y";
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export function dropZone(box: Box, point: { x: number; y: number }, axis: Axis, container: boolean): Zone;
export function indicator(box: Box, zone: Zone, axis: Axis): Box;
export function axisOf(display: string, direction: string): Axis;
export type FreeInput = { id: string; parentId: string; parentStatic: boolean; target: StyleTarget; box: Box; width: number; parentBox: Box; parentBorder: { top: number; left: number }; parentScroll: { top: number; left: number }; margin: { top: number; left: number } };
export function freeCommands(i: FreeInput): EditorCommand[];
export function handlesFor(absolute: boolean): Handle[];
export type ResizeInput = { id: string; target: StyleTarget; handle: Handle; start: { w: number; h: number; top: number; left: number }; dx: number; dy: number; keepRatio: boolean };
export function resizeCommands(i: ResizeInput): EditorCommand[];
export type Side = "top" | "right" | "bottom" | "left";
export function spacingCommand(id: string, target: StyleTarget, what: Side | "gap", start: number, delta: number): EditorCommand;
export const ZOOM: { min: 0.25; max: 2; presets: readonly number[] };
export function clampZoom(z: number): number;
export function zoomStep(z: number, dir: 1 | -1): number;
export function wheelZoom(z: number, deltaY: number): number;
export function fitZoom(paneWidth: number, bp: number): number;
// model.ts KeyAction += "zoomIn" | "zoomOut" | "zoomReset"   (Ctrl/⌘ + "=" or "+", "-", "0")
```

- [ ] **Step 1: Viết test đỏ** — `tests/unit/gestures.test.ts`:

```ts
import { expect, test } from "vitest";
import { axisOf, clampZoom, dropZone, fitZoom, freeCommands, handlesFor, indicator, resizeCommands, spacingCommand, wheelZoom, ZOOM, zoomStep } from "@/app/p/[id]/editor/visual/gestures";

const box = { x: 100, y: 100, w: 200, h: 40 };

test("dropZone: outer quarters insert before/after along the parent's axis; the middle half of a container drops inside; indicator geometry", () => {
  expect(dropZone(box, { x: 150, y: 105 }, "y", true)).toBe("before");
  expect(dropZone(box, { x: 150, y: 120 }, "y", true)).toBe("inside");
  expect(dropZone(box, { x: 150, y: 120 }, "y", false)).toBe("after");
  expect(dropZone(box, { x: 150, y: 139 }, "y", true)).toBe("after");
  expect(dropZone(box, { x: 110, y: 120 }, "x", true)).toBe("before");
  expect(indicator(box, "before", "y")).toEqual({ x: 100, y: 99, w: 200, h: 2 });
  expect(indicator(box, "after", "x")).toEqual({ x: 299, y: 100, w: 2, h: 40 });
  expect(indicator(box, "inside", "y")).toEqual(box);
  expect([axisOf("flex", "row"), axisOf("inline-flex", "row-reverse"), axisOf("flex", "column"), axisOf("block", "row"), axisOf("grid", "row")]).toEqual(["x", "x", "y", "y", "y"]);
});

test("freeCommands (R6): absolute at the dropped place from the parent's padding box (border, scroll, margin); a static parent made relative first; all at the breakpoint target; width locked", () => {
  const input = { id: "n", parentId: "p", parentStatic: true, target: 768 as const, box: { x: 150, y: 120, w: 100, h: 40 }, width: 98, parentBox: { x: 100, y: 100, w: 500, h: 300 }, parentBorder: { top: 2, left: 3 }, parentScroll: { top: 10, left: 0 }, margin: { top: 5, left: 4 } };
  expect(freeCommands(input)).toEqual([
    { op: "setStyle", id: "p", target: 768, changes: { position: "relative" } },
    { op: "setStyle", id: "n", target: 768, changes: { position: "absolute", left: "43px", top: "23px", width: "98px" } },
  ]);
  expect(freeCommands({ ...input, parentStatic: false, target: "base" })).toEqual([{ op: "setStyle", id: "n", target: "base", changes: { position: "absolute", left: "43px", top: "23px", width: "98px" } }]);
});

test("resize (R13): e/s/se for flow nodes, 8 handles for absolute; width/height px at the target; Shift keeps the ratio; w/n move left/top", () => {
  expect(handlesFor(false)).toEqual(["e", "s", "se"]);
  expect(handlesFor(true)).toHaveLength(8);
  const start = { w: 100, h: 50, top: 10, left: 20 };
  expect(resizeCommands({ id: "n", target: 768, handle: "se", start, dx: 20, dy: 10, keepRatio: false })).toEqual([{ op: "setStyle", id: "n", target: 768, changes: { width: "120px", height: "60px" } }]);
  expect(resizeCommands({ id: "n", target: "base", handle: "e", start, dx: 50, dy: 0, keepRatio: false })).toEqual([{ op: "setStyle", id: "n", target: "base", changes: { width: "150px" } }]);
  expect(resizeCommands({ id: "n", target: "base", handle: "e", start, dx: 50, dy: 0, keepRatio: true })).toEqual([{ op: "setStyle", id: "n", target: "base", changes: { width: "150px", height: "75px" } }]);
  expect(resizeCommands({ id: "n", target: "base", handle: "nw", start, dx: -10, dy: -10, keepRatio: false })).toEqual([{ op: "setStyle", id: "n", target: "base", changes: { width: "110px", height: "60px", left: "10px", top: "0px" } }]);
  expect(resizeCommands({ id: "n", target: "base", handle: "s", start, dx: 0, dy: -80, keepRatio: false })).toEqual([{ op: "setStyle", id: "n", target: "base", changes: { height: "1px" } }]);
});

test("padding / gap handles and zoom helpers (R8)", () => {
  expect(spacingCommand("n", 375, "top", 8, 12)).toEqual({ op: "setStyle", id: "n", target: 375, changes: { "padding-top": "20px" } });
  expect(spacingCommand("n", "base", "gap", 16, -30)).toEqual({ op: "setStyle", id: "n", target: "base", changes: { gap: "0px" } });
  expect([clampZoom(0.1), clampZoom(3), clampZoom(0.506)]).toEqual([0.25, 2, 0.51]);
  expect([zoomStep(1, 1), zoomStep(1, -1), zoomStep(0.6, -1), zoomStep(2, 1), zoomStep(0.25, -1)]).toEqual([1.25, 0.75, 0.5, 2, 0.25]);
  expect([wheelZoom(1, -100), wheelZoom(1, 100), wheelZoom(1.95, -1)]).toEqual([1.1, 0.91, 2]);
  expect([fitZoom(736, 1440), fitZoom(616, 375), fitZoom(100, 1440)]).toEqual([0.5, 1.6, 0.25]);
  expect(ZOOM.presets).toEqual([0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2]);
});
```

`tests/unit/editor-model.test.ts`, trong test `"keys, …"` thêm:

```ts
  expect([k("=", { ctrlKey: true }), k("+", { ctrlKey: true, shiftKey: true }), k("-", { metaKey: true }), k("0", { ctrlKey: true })]).toEqual(["zoomIn", "zoomIn", "zoomOut", "zoomReset"]);
```

- [ ] **Step 2: Chạy test, xác nhận đỏ**

Run: `npx vitest run tests/unit/gestures.test.ts tests/unit/editor-model.test.ts`
Expected: FAIL — module not found; `keyAction` trả undefined cho zoom.

- [ ] **Step 3: Cài đặt** — `gestures.ts`:

```ts
// E3 §3 gestures (pure): pointer geometry -> command batches. Boxes are document px of the canvas frame (model.Box).
import type { EditorCommand, StyleTarget } from "@/core/ir-command";
import type { Box, Zone } from "./model";

export type Axis = "x" | "y";
export type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export type Side = "top" | "right" | "bottom" | "left";

// the outer quarters (along the parent's main axis) insert before / after; the middle half of a container drops inside
export function dropZone(box: Box, point: { x: number; y: number }, axis: Axis, container: boolean): Zone {
  const [start, size, at] = axis === "x" ? [box.x, box.w, point.x] : [box.y, box.h, point.y];
  const f = size > 0 ? (at - start) / size : 0.5;
  if (container && f > 0.25 && f < 0.75) return "inside";
  return f < 0.5 ? "before" : "after";
}
export function indicator(box: Box, zone: Zone, axis: Axis): Box {
  if (zone === "inside") return box;
  const edge = zone === "before" ? 0 : 1;
  return axis === "y" ? { x: box.x, y: box.y + edge * box.h - 1, w: box.w, h: 2 } : { x: box.x + edge * box.w - 1, y: box.y, w: 2, h: box.h };
}
export const axisOf = (display: string, direction: string): Axis => (display.includes("flex") && direction.startsWith("row") ? "x" : "y");

export type FreeInput = { id: string; parentId: string; parentStatic: boolean; target: StyleTarget; box: Box; width: number; parentBox: Box; parentBorder: { top: number; left: number }; parentScroll: { top: number; left: number }; margin: { top: number; left: number } };
// R6: from the parent's padding box (its border box minus the border, plus its scroll), the node's margin removed
export function freeCommands(i: FreeInput): EditorCommand[] {
  const left = Math.round(i.box.x - i.parentBox.x - i.parentBorder.left + i.parentScroll.left - i.margin.left);
  const top = Math.round(i.box.y - i.parentBox.y - i.parentBorder.top + i.parentScroll.top - i.margin.top);
  return [
    ...(i.parentStatic ? [{ op: "setStyle" as const, id: i.parentId, target: i.target, changes: { position: "relative" } }] : []),
    { op: "setStyle", id: i.id, target: i.target, changes: { position: "absolute", left: `${left}px`, top: `${top}px`, width: `${Math.round(i.width)}px` } },
  ];
}

export const handlesFor = (absolute: boolean): Handle[] => (absolute ? ["n", "s", "e", "w", "ne", "nw", "se", "sw"] : ["e", "s", "se"]);
export type ResizeInput = { id: string; target: StyleTarget; handle: Handle; start: { w: number; h: number; top: number; left: number }; dx: number; dy: number; keepRatio: boolean };
export function resizeCommands(i: ResizeInput): EditorCommand[] {
  const east = i.handle.includes("e"), west = i.handle.includes("w"), south = i.handle.includes("s"), north = i.handle.includes("n");
  let w = i.start.w + (east ? i.dx : west ? -i.dx : 0), h = i.start.h + (south ? i.dy : north ? -i.dy : 0);
  const horizontal = east || west, vertical = north || south;
  if (i.keepRatio && i.start.w > 0 && i.start.h > 0) {
    const ratio = i.start.w / i.start.h;
    if (horizontal && (!vertical || Math.abs(w / i.start.w - 1) >= Math.abs(h / i.start.h - 1))) h = w / ratio; else w = h * ratio;
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const changes: Record<string, string> = {};
  if (horizontal || i.keepRatio) changes.width = `${w}px`;
  if (vertical || i.keepRatio) changes.height = `${h}px`;
  if (west) changes.left = `${Math.round(i.start.left + i.start.w - w)}px`;
  if (north) changes.top = `${Math.round(i.start.top + i.start.h - h)}px`;
  return [{ op: "setStyle", id: i.id, target: i.target, changes }];
}
export function spacingCommand(id: string, target: StyleTarget, what: Side | "gap", start: number, delta: number): EditorCommand {
  return { op: "setStyle", id, target, changes: { [what === "gap" ? "gap" : `padding-${what}`]: `${Math.max(0, Math.round(start + delta))}px` } };
}

export const ZOOM = { min: 0.25, max: 2, presets: [0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2] } as const;
export const clampZoom = (z: number): number => Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(z * 100) / 100));
export function zoomStep(z: number, dir: 1 | -1): number {
  const p = ZOOM.presets;
  return dir > 0 ? (p.find((x) => x > z + 1e-9) ?? ZOOM.max) : ([...p].reverse().find((x) => x < z - 1e-9) ?? ZOOM.min);
}
export const wheelZoom = (z: number, deltaY: number): number => clampZoom(z * (deltaY < 0 ? 1.1 : 1 / 1.1));
export const fitZoom = (paneWidth: number, bp: number): number => clampZoom((paneWidth - 16) / bp);
```

`model.ts` — `KeyAction` thêm `"zoomIn" | "zoomOut" | "zoomReset"`; trong `keyAction`, ngay sau `if (mod && key === "Enter") return "child";`:

```ts
  if (mod && (key === "=" || key === "+")) return "zoomIn";
  if (mod && key === "-") return "zoomOut";
  if (mod && key === "0") return "zoomReset";
```

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/gestures.test.ts tests/unit/editor-model.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/gestures.ts" "src/app/p/[id]/editor/visual/model.ts" tests/unit/gestures.test.ts tests/unit/editor-model.test.ts
git commit -m "feat(e3b): pure gesture geometry — drop zones, absolute placement, resize, padding/gap, zoom steps

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Kéo theo luồng trên canvas (vạch chèn xanh/đỏ, `moveNode`)

**Files:**
- Modify: `src/app/p/[id]/editor/visual/canvas.tsx` (sự kiện `onPress`, handle `toDoc`/`hit`), `overlay.tsx` (export `at`), `visual-editor.tsx` (state gesture + lớp phủ), `src/app/globals.css`, `docs/superpowers/design/stitch-screens.md`
- Test: `tests/e2e/visual-editor-advanced.test.ts` (append)

**Interfaces:**
- Consumes: `dropZone`, `indicator`, `axisOf` (Task 6); `dropCommand`, `guardParent`, `pickTarget` (model); `measure`, `Overlay` (E3a).
- Produces:

```ts
// canvas.tsx — Props thêm: onPress(id: string, e: PointerEvent): void; zoom: number (Task 10 dùng, ở đây = 1)
// CanvasHandle thêm:
toDoc(clientX: number, clientY: number): { x: number; y: number }; // parent client px -> frame document px (÷ zoom)
hit(x: number, y: number): string | null;                          // data-ir-id under a document point
// overlay.tsx
export const at: (b: Box, zoom: number) => CSSProperties;
// visual-editor.tsx
type Gesture = { kind: "flow"; id: string } | { kind: "free"; … } | { kind: "resize"; … } | { kind: "spacing"; … } | { kind: "insert"; … } | { kind: "pan"; … };
```

- [ ] **Step 1: Viết e2e đỏ** — append:

```ts
// drags with the real mouse: down on the element, a few moves (past the 4 px start threshold), up at the target
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, opts: { alt?: boolean; shift?: boolean } = {}) {
  if (opts.alt) await page.keyboard.down("Alt");
  if (opts.shift) await page.keyboard.down("Shift");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) await page.mouse.move(from.x + ((to.x - from.x) * k) / 8, from.y + ((to.y - from.y) * k) / 8);
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up("Shift");
  if (opts.alt) await page.keyboard.up("Alt");
}
const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

test("E3b flow drag: the h1 dropped into the features section keeps its id (moveNode across sections, one Undo); dragging a section root onto a node shows a red indicator with its reason and sends nothing", { timeout: 240_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  const h1Id = (await h1.getAttribute("data-ir-id"))!;
  const features = canvas(page).locator("#features");
  const featuresId = (await features.getAttribute("data-ir-id"))!;
  await h1.click();
  await features.scrollIntoViewIfNeeded();
  await h1.scrollIntoViewIfNeeded();
  const fb = (await features.boundingBox())!;
  // into the section's own 24 px left padding (its cards may be component instances, which refuse children)
  await drag(page, centre((await h1.boundingBox())!), { x: fb.x + 6, y: fb.y + fb.height / 2 });
  await saved(page);
  await expect.poll(async () => (await allNodes()).find((x) => x.id === featuresId)?.children.some((c) => c.id === h1Id), { timeout: 30_000 }).toBe(true);
  expect(await canvas(page).locator(`[data-ir-id="${h1Id}"]`).count()).toBe(1);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await saved(page);
  await expect.poll(async () => (await allNodes()).find((x) => x.id === featuresId)?.children.some((c) => c.id === h1Id), { timeout: 30_000 }).toBe(false);
  // a section root (Esc from the h1) dragged onto the paragraph: red, reasoned, nothing sent
  await canvas(page).locator("h1").click();
  await page.keyboard.press("Escape");
  const rev = (await payload()).revision;
  const para = canvas(page).getByText("Plain paragraph text.");
  const pb = (await para.boundingBox())!, hb = (await canvas(page).locator("h1").boundingBox())!;
  await page.mouse.move(hb.x + 4, hb.y + 4);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) await page.mouse.move(hb.x + 4, hb.y + 4 + ((pb.y + pb.height / 2 - hb.y - 4) * k) / 6);
  const bad = page.locator('[data-ui="ui_editor_drop_indicator"].is-bad');
  await expect.poll(() => bad.isVisible()).toBe(true);
  expect(await bad.innerText()).toMatch(/Section chỉ đổi thứ tự|chính nó/); // the hero is a section root (or, if not, the p is inside it)
  await page.mouse.up();
  await page.waitForTimeout(500);
  expect((await payload()).revision).toBe(rev);
  await page.close();
});
```

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts -t "flow drag"`
Expected: FAIL — h1 không đổi cha.

- [ ] **Step 2: Cài đặt canvas** — `canvas.tsx`: Props thêm `zoom: number` và `onPress(id: string, e: PointerEvent): void`; trong `onLoad` thêm:

```ts
    d.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; const id = idOf(e.target); if (id) events.current.onPress(id, e); }, true);
```

handle thêm:

```ts
    toDoc: (cx, cy) => { const r = frame.current!.getBoundingClientRect(); return { x: (cx - r.left) / zoomRef.current, y: (cy - r.top) / zoomRef.current }; },
    hit: (x, y) => idOf(doc()?.elementFromPoint(x, y) ?? null),
```

(`const zoomRef = useRef(zoom); zoomRef.current = zoom;` — ở task này `zoom` luôn 1; Task 10 nối giá trị thật.)

`overlay.tsx`: `export const at = …` (đổi `const` thành `export const`).

- [ ] **Step 3: Cài đặt gesture trong `visual-editor.tsx`** (import `dropZone`, `indicator`, `axisOf` từ `./gestures`; `ancestorsOf`, `dropCommand`, `guardParent`, `type Box` từ `./model`; `at` từ `./overlay`):

```tsx
  type Drop = { box: Box; ok: boolean; reason?: string; batch?: Batch };
  type Gesture = { kind: "flow"; id: string; drop?: Drop };
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const press = useRef<{ id: string; x: number; y: number; alt: boolean } | null>(null);
  // a press on a selected node (or inside one: the selected ancestor is dragged) becomes a drag after 4 px (R12);
  // without moving, the click still selects
  const onPress = (raw: string, e: PointerEvent) => {
    const target = ancestorsOf(live.current.index, raw).find((a) => live.current.selection.includes(a));
    if (!target) return;
    press.current = { id: target, x: e.clientX, y: e.clientY, alt: e.altKey };
    const d = canvas.current?.doc();
    const move = (m: PointerEvent) => {
      if (!press.current || Math.hypot(m.clientX - press.current.x, m.clientY - press.current.y) < 4) return;
      d?.removeEventListener("pointermove", move);
      d?.getSelection()?.removeAllRanges();
      setGesture({ kind: "flow", id: press.current.id }); // Task 8: alt -> "free"
      press.current = null;
    };
    d?.addEventListener("pointermove", move);
    d?.addEventListener("pointerup", () => { press.current = null; d.removeEventListener("pointermove", move); }, { once: true });
  };
  const flowOver = (g: Extract<Gesture, { kind: "flow" }>, cx: number, cy: number): Drop | undefined => {
    const c = canvas.current, ix = live.current.index, comps = live.current.data?.interactives ?? [];
    if (!c) return undefined;
    const p = c.toDoc(cx, cy), raw = c.hit(p.x, p.y), over = raw ? pickTarget(ix, raw) : undefined;
    const el = over ? c.element(over) : null;
    if (!over || !el) return undefined;
    const m = measure(el), parentEl = ix.get(over)?.parent ? c.element(ix.get(over)!.parent!) : null;
    const cs = parentEl ? parentEl.ownerDocument.defaultView!.getComputedStyle(parentEl) : null;
    const axis = cs ? axisOf(cs.display, cs.flexDirection) : "y";
    const zone = dropZone(m.box, p, axis, guardParent(ix, comps, over) === undefined && over !== g.id);
    const b = dropCommand(ix, comps, g.id, over, zone);
    return { box: indicator(m.box, zone, axis), ok: !("error" in b), ...("error" in b ? { reason: b.error } : { batch: b }) };
  };
  const gestureMove = (e: React.PointerEvent) => {
    if (gesture?.kind === "flow") setGesture({ ...gesture, drop: flowOver(gesture, e.clientX, e.clientY) });
  };
  const gestureUp = () => {
    if (gesture?.kind === "flow" && gesture.drop?.batch) batch(gesture.drop.batch, "Di chuyển");
    setGesture(null);
  };
```

Truyền `onPress={onPress}` và `zoom={1}` cho `<Canvas>`; trong children của `<Overlay>`:

```tsx
            {gesture?.kind === "flow" && gesture.drop && (
              <div className={`ve-drop${gesture.drop.ok ? "" : " is-bad"}`} data-ui="ui_editor_drop_indicator" style={at(gesture.drop.box, 1)}>
                {!gesture.drop.ok && <span className="ve-label">{gesture.drop.reason}</span>}
              </div>
            )}
```

và ngay trong `<div className="ve">` (cuối): `{gesture && <div className="ve-capture" onPointerMove={gestureMove} onPointerUp={gestureUp} onPointerCancel={() => setGesture(null)} />}`

`globals.css`:

```css
.ve-capture { position: fixed; inset: 0; z-index: 50; cursor: grabbing; }
.ve-drop { position: absolute; background: var(--c-primary); outline: 2px solid var(--c-primary); }
.ve-drop.is-bad { background: var(--c-danger); outline-color: var(--c-danger); }
.ve-drop.is-bad .ve-label { background: var(--c-danger-strong); color: var(--c-on-danger); }
```

`stitch-screens.md`: `ui_editor_drop_indicator` ("E3 §3 vạch chèn trước/sau / khung thả vào trong; đỏ + lý do khi bị cấm — `moveNode`").

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/canvas.tsx" "src/app/p/[id]/editor/visual/overlay.tsx" "src/app/p/[id]/editor/visual/visual-editor.tsx" src/app/globals.css docs/superpowers/design/stitch-screens.md tests/e2e/visual-editor-advanced.test.ts
git commit -m "feat(e3b): flow drag on the canvas — insertion bar / drop frame, red with the reason when refused, moveNode keeps ids

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Alt+kéo đặt tự do, snap/guide, đo khoảng cách

**Files:**
- Create: `src/app/p/[id]/editor/visual/snap.ts`
- Modify: `src/app/p/[id]/editor/visual/canvas.tsx` (`onHover(id, alt)`), `visual-editor.tsx`, `src/app/globals.css`, `docs/superpowers/design/stitch-screens.md`
- Test: `tests/unit/snap.test.ts`, `tests/e2e/visual-editor-advanced.test.ts` (append)

**Interfaces:**
- Consumes: `freeCommands` (Task 6); `guard`, `styleTarget` (model); gesture (Task 7).
- Produces:

```ts
export const SNAP_PX = 4;
export type Guide = { axis: "x" | "y"; at: number; from: number; to: number };
export type Gap = { x1: number; y1: number; x2: number; y2: number; value: number };
export function snap(moving: Box, others: readonly Box[], threshold: number): { dx: number; dy: number; guides: Guide[] };
export function gaps(a: Box, b: Box): Gap[];
// canvas.tsx: onHover(id: string | null, alt: boolean)
```

- [ ] **Step 1: Viết test đỏ** — `tests/unit/snap.test.ts`:

```ts
import { expect, test } from "vitest";
import { gaps, snap } from "@/app/p/[id]/editor/visual/snap";

test("snap: within the threshold the moving box's left/centre/right and top/middle/bottom jump to the nearest line of a sibling, the parent or the viewport, with the guide spanning both boxes", () => {
  const sib = { x: 100, y: 0, w: 50, h: 50 };
  expect(snap({ x: 103, y: 200, w: 30, h: 30 }, [sib], 4)).toEqual({ dx: -3, dy: 0, guides: [{ axis: "x", at: 100, from: 0, to: 230 }] });
  expect(snap({ x: 160, y: 200, w: 30, h: 30 }, [sib], 4)).toEqual({ dx: 0, dy: 0, guides: [] });
  const parent = { x: 0, y: 0, w: 400, h: 300 };
  expect(snap({ x: 200, y: 298, w: 10, h: 10 }, [parent], 4)).toEqual({ dx: 0, dy: 2, guides: [{ axis: "x", at: 200, from: 0, to: 310 }, { axis: "y", at: 300, from: 0, to: 400 }] });
  expect(snap({ x: 103, y: 200, w: 30, h: 30 }, [sib], 2).dx).toBe(0); // 4 screen px at 200 % = 2 document px (R11)
});

test("gaps: the free space on each axis where two boxes do not overlap; the four inner distances when one holds the other", () => {
  const a = { x: 0, y: 0, w: 10, h: 10 };
  expect(gaps(a, { x: 30, y: 0, w: 10, h: 10 })).toEqual([{ x1: 10, y1: 5, x2: 30, y2: 5, value: 20 }]);
  expect(gaps(a, { x: 0, y: 25, w: 10, h: 10 })).toEqual([{ x1: 5, y1: 10, x2: 5, y2: 25, value: 15 }]);
  expect(gaps({ x: 10, y: 10, w: 10, h: 10 }, { x: 0, y: 0, w: 100, h: 50 }).map((g) => g.value)).toEqual([10, 80, 30, 10]);
});
```

- [ ] **Step 2: Viết e2e đỏ** — append:

```ts
test("E3b Alt+drag: the paragraph becomes absolute where dropped (its static parent relative), one batch at the current breakpoint; Alt+hover measures px to another node", { timeout: 240_000 }, async () => {
  const page = await open();
  const para = canvas(page).getByText("Plain paragraph text.");
  const paraId = (await para.getAttribute("data-ir-id"))!;
  const heroId = (await para.evaluate((el) => el.parentElement!.getAttribute("data-ir-id")))!;
  await para.click();
  // Alt+hover the h1: a px distance to the selection
  await page.keyboard.down("Alt");
  await canvas(page).locator("h1").hover();
  await expect.poll(() => page.locator('[data-ui="ui_editor_measure"]').first().innerText()).toMatch(/^\d+$/);
  await page.keyboard.up("Alt");
  const rev = (await payload()).revision;
  const b = (await para.boundingBox())!;
  await drag(page, { x: b.x + 10, y: b.y + 5 }, { x: b.x + 70, y: b.y + 45 }, { alt: true });
  await saved(page);
  await expect.poll(async () => (await nodeById(paraId))?.styles.base.position, { timeout: 30_000 }).toBe("absolute");
  const p = (await nodeById(paraId))!.styles.base;
  expect([p.left, p.top, p.width].every((v) => /^-?\d+px$/.test(v ?? ""))).toBe(true);
  expect((await nodeById(heroId))!.styles.base.position).toBe("relative");
  expect((await payload()).revision).toBe(rev + 1);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await saved(page);
  await expect.poll(async () => (await nodeById(paraId))?.styles.base.position).toBeUndefined();
  await page.close();
});
```

Run: `npx vitest run tests/unit/snap.test.ts && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts -t "Alt\\+drag"`
Expected: FAIL — module not found; không có `ui_editor_measure`.

- [ ] **Step 3: Cài đặt `snap.ts`**

```ts
// E3 §3 free placement aids (pure): snapping the moving box to its siblings / parent / viewport (4 px, R11) with guide
// lines, and the Alt+hover distances between the selection and another node.
import type { Box } from "./model";

export const SNAP_PX = 4;
export type Guide = { axis: "x" | "y"; at: number; from: number; to: number };
export type Gap = { x1: number; y1: number; x2: number; y2: number; value: number };
const xs = (b: Box) => [b.x, b.x + b.w / 2, b.x + b.w];
const ys = (b: Box) => [b.y, b.y + b.h / 2, b.y + b.h];

export function snap(moving: Box, others: readonly Box[], threshold: number): { dx: number; dy: number; guides: Guide[] } {
  const best = (mine: number[], lines: (b: Box) => number[]) => {
    let hit: { d: number; at: number } | undefined;
    for (const o of others) for (const line of lines(o)) for (const m of mine) {
      const d = line - m;
      if (Math.abs(d) <= threshold && (!hit || Math.abs(d) < Math.abs(hit.d))) hit = { d, at: line };
    }
    return hit;
  };
  const bx = best(xs(moving), xs), by = best(ys(moving), ys);
  const moved = { ...moving, x: moving.x + (bx?.d ?? 0), y: moving.y + (by?.d ?? 0) };
  const span = (at: number, lines: (b: Box) => number[], lo: (b: Box) => number, hi: (b: Box) => number) => {
    const boxes = [moved, ...others.filter((o) => lines(o).some((l) => Math.abs(l - at) < 0.5))];
    return { from: Math.min(...boxes.map(lo)), to: Math.max(...boxes.map(hi)) };
  };
  const guides: Guide[] = [];
  if (bx) guides.push({ axis: "x", at: bx.at, ...span(bx.at, xs, (b) => b.y, (b) => b.y + b.h) });
  if (by) guides.push({ axis: "y", at: by.at, ...span(by.at, ys, (b) => b.x, (b) => b.x + b.w) });
  return { dx: bx?.d ?? 0, dy: by?.d ?? 0, guides };
}

export function gaps(a: Box, b: Box): Gap[] {
  const holds = (o: Box, i: Box) => i.x >= o.x && i.y >= o.y && i.x + i.w <= o.x + o.w && i.y + i.h <= o.y + o.h;
  if (holds(b, a) || holds(a, b)) {
    const [o, i] = holds(b, a) ? [b, a] : [a, b];
    const cx = i.x + i.w / 2, cy = i.y + i.h / 2;
    return [
      { x1: cx, y1: o.y, x2: cx, y2: i.y, value: i.y - o.y },
      { x1: i.x + i.w, y1: cy, x2: o.x + o.w, y2: cy, value: o.x + o.w - (i.x + i.w) },
      { x1: cx, y1: i.y + i.h, x2: cx, y2: o.y + o.h, value: o.y + o.h - (i.y + i.h) },
      { x1: o.x, y1: cy, x2: i.x, y2: cy, value: i.x - o.x },
    ].map((g) => ({ ...g, value: Math.round(g.value) }));
  }
  const out: Gap[] = [];
  const overlapY = Math.max(a.y, b.y) < Math.min(a.y + a.h, b.y + b.h), overlapX = Math.max(a.x, b.x) < Math.min(a.x + a.w, b.x + b.w);
  const y = overlapY ? (Math.max(a.y, b.y) + Math.min(a.y + a.h, b.y + b.h)) / 2 : a.y + a.h / 2;
  const x = overlapX ? (Math.max(a.x, b.x) + Math.min(a.x + a.w, b.x + b.w)) / 2 : a.x + a.w / 2;
  if (b.x >= a.x + a.w) out.push({ x1: a.x + a.w, y1: y, x2: b.x, y2: y, value: Math.round(b.x - a.x - a.w) });
  else if (a.x >= b.x + b.w) out.push({ x1: b.x + b.w, y1: y, x2: a.x, y2: y, value: Math.round(a.x - b.x - b.w) });
  if (b.y >= a.y + a.h) out.push({ x1: x, y1: a.y + a.h, x2: x, y2: b.y, value: Math.round(b.y - a.y - a.h) });
  else if (a.y >= b.y + b.h) out.push({ x1: x, y1: b.y + b.h, x2: x, y2: a.y, value: Math.round(a.y - b.y - b.h) });
  return out;
}
```

- [ ] **Step 4: Cài đặt Alt+kéo và đo** — `canvas.tsx`: `onHover(id: string | null, alt: boolean)`; trong `mousemove` gọi `events.current.onHover(id, e.altKey)` mỗi khi `id` hoặc `altKey` đổi (lưu `lastAlt`). `visual-editor.tsx`:

```tsx
  const [alt, setAlt] = useState(false);
  // onHover={(hid, a) => { setHover(hid); setAlt(a); }}
  type Free = { kind: "free"; id: string; el: HTMLElement; start: { x: number; y: number }; box: Box; width: number; parent: HTMLElement; others: Box[]; guides: Guide[]; dx: number; dy: number; prevTranslate: string };
  // Gesture = Flow | Free
  const startFree = (nid: string, cx: number, cy: number) => {
    const c = canvas.current, ix = live.current.index, e = ix.get(nid);
    const why = guard(ix, live.current.data?.interactives ?? [], nid, "move");
    if (why) return setMsg(why);
    const el = c?.element(nid), parent = e?.parent ? c?.element(e.parent) : null;
    if (!c || !el || !parent || !e) return;
    const win = el.ownerDocument.defaultView!;
    const siblings = (ix.get(e.parent!)?.children ?? []).filter((s) => s !== nid).flatMap((s) => { const se = c.element(s); return se ? [measure(se).box] : []; });
    const viewport = { x: 0, y: 0, w: win.innerWidth, h: win.innerHeight };
    setGesture({ kind: "free", id: nid, el, start: c.toDoc(cx, cy), box: measure(el).box, width: parseFloat(win.getComputedStyle(el).width) || measure(el).box.w, parent, others: [...siblings, measure(parent).box, viewport], guides: [], dx: 0, dy: 0, prevTranslate: el.style.translate });
  };
  const freeMove = (g: Free, cx: number, cy: number): Free => {
    const p = canvas.current!.toDoc(cx, cy);
    const raw = { ...g.box, x: g.box.x + p.x - g.start.x, y: g.box.y + p.y - g.start.y };
    const s = snap(raw, g.others, SNAP_PX / zoomNow());
    const dx = raw.x + s.dx - g.box.x, dy = raw.y + s.dy - g.box.y;
    g.el.style.translate = `${dx}px ${dy}px`; // optimistic: layout untouched until the server's section arrives
    return { ...g, dx, dy, guides: s.guides };
  };
  const freeUp = (g: Free) => {
    const win = g.parent.ownerDocument.defaultView!, pcs = win.getComputedStyle(g.parent), cs = win.getComputedStyle(g.el), px = (v: string) => parseFloat(v) || 0;
    const commands = freeCommands({
      id: g.id, parentId: live.current.index.get(g.id)!.parent!, parentStatic: pcs.position === "static", target: styleTarget(bpNow()),
      box: { ...g.box, x: g.box.x + g.dx, y: g.box.y + g.dy }, width: g.width, parentBox: measure(g.parent).box,
      parentBorder: { top: px(pcs.borderTopWidth), left: px(pcs.borderLeftWidth) }, parentScroll: { top: g.parent.scrollTop, left: g.parent.scrollLeft },
      margin: { top: px(cs.marginTop), left: px(cs.marginLeft) },
    });
    if (!commands.length || (g.dx === 0 && g.dy === 0)) { g.el.style.translate = g.prevTranslate; return; }
    batch({ commands }, "Đặt tự do", { rollback: () => { g.el.style.translate = g.prevTranslate; } });
  };
```

Import `snap`, `gaps`, `SNAP_PX`, `type Guide` từ `./snap`; `freeCommands` từ `./gestures`; `guard`, `styleTarget` từ `./model`. `live.current` thêm `zoom: 1` (Task 10 thay bằng state) và `bp`; hai hàm đọc:

```tsx
  const zoomNow = () => live.current.zoom;
  const bpNow = () => live.current.bp;
```

Trong `onPress`: khi vượt 4 px, `press.current.alt ? startFree(id, m.clientX, m.clientY) : setGesture({ kind: "flow", id })`. `gestureMove`: thêm nhánh `if (gesture?.kind === "free") setGesture(freeMove(gesture, e.clientX, e.clientY));`. `gestureUp`: thêm `if (gesture?.kind === "free") freeUp(gesture);`. Overlay children thêm guide và đo:

```tsx
            {gesture?.kind === "free" && gesture.guides.map((g, i) => (
              <div key={i} className="ve-guide" data-ui="ui_editor_guides" style={g.axis === "x" ? at({ x: g.at, y: g.from, w: 0, h: g.to - g.from }, 1) : at({ x: g.from, y: g.at, w: g.to - g.from, h: 0 }, 1)} />
            ))}
            {alt && hoverInfo && selectedBoxes.length === 1 && hoverInfo.id !== selectedBoxes[0]!.id && gaps(selectedBoxes[0]!.m.box, hoverInfo.m.box).map((g, i) => (
              <div key={i} className="ve-measure" style={at({ x: Math.min(g.x1, g.x2), y: Math.min(g.y1, g.y2), w: Math.abs(g.x2 - g.x1), h: Math.abs(g.y2 - g.y1) }, 1)}>
                <span className="ve-label" data-ui="ui_editor_measure">{g.value}</span>
              </div>
            ))}
```

`globals.css`:

```css
.ve-guide { position: absolute; outline: 1px solid var(--c-danger); }
.ve-measure { position: absolute; outline: 1px dashed var(--c-warn); }
.ve-measure .ve-label { background: var(--c-warn); color: var(--c-on-warn); bottom: auto; top: 50%; left: 50%; transform: translate(-50%, -50%); }
```

`stitch-screens.md`: `ui_editor_guides` ("E3 §3 đường guide khi snap 4 px — Alt+kéo, `setStyle` absolute + cha relative"), `ui_editor_measure` ("E3 §3 giữ Alt + hover: px tới node đang chọn").

- [ ] **Step 5: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/snap.test.ts && npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/snap.ts" "src/app/p/[id]/editor/visual/canvas.tsx" "src/app/p/[id]/editor/visual/visual-editor.tsx" src/app/globals.css docs/superpowers/design/stitch-screens.md tests/unit/snap.test.ts tests/e2e/visual-editor-advanced.test.ts
git commit -m "feat(e3b): Alt+drag free placement (absolute + relative parent, one batch) with 4 px snap guides; Alt+hover distances

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Resize 8 handle + kéo padding/gap

**Files:**
- Modify: `src/app/p/[id]/editor/visual/overlay.tsx` (render handle, nhận callback), `visual-editor.tsx`, `src/app/globals.css`, `docs/superpowers/design/stitch-screens.md`
- Test: `tests/e2e/visual-editor-advanced.test.ts` (append)

**Interfaces:**
- Consumes: `handlesFor`, `resizeCommands`, `spacingCommand` (Task 6).
- Produces: `Overlay` props thêm `handles?: { id: string; list: Handle[]; onHandle(h: Handle, e: React.PointerEvent): void; onSpacing(side: Side | "gap", e: React.PointerEvent): void; gap?: Box }`.

- [ ] **Step 1: Viết e2e đỏ** — append:

```ts
test("E3b resize: the e handle at 768 writes width in the 768 layer only (1440 unchanged); a padding handle writes padding-top at the breakpoint; one Undo each", { timeout: 240_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  const h1Id = (await h1.getAttribute("data-ir-id"))!;
  const width1440 = await h1.evaluate((el) => el.getBoundingClientRect().width);
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "768" }).click();
  await h1.click();
  const e = page.locator('[data-ui="ui_editor_resize_handle"][data-handle="e"]');
  await expect.poll(() => e.isVisible()).toBe(true);
  expect(await page.locator('[data-ui="ui_editor_resize_handle"]').count()).toBe(3); // flow node: e, s, se (R13)
  const hb = (await e.boundingBox())!;
  const before = await h1.evaluate((el) => el.getBoundingClientRect().width);
  await drag(page, centre(hb), { x: hb.x + hb.width / 2 - 120, y: hb.y + hb.height / 2 });
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.bp["768"]?.width, { timeout: 30_000 }).toBe(`${Math.round(before - 120)}px`);
  expect((await nodeById(h1Id))!.styles.base.width).toBeUndefined();
  const top = page.locator('[data-ui="ui_editor_spacing_handle"][data-side="top"]');
  const tb = (await top.boundingBox())!;
  await drag(page, centre(tb), { x: tb.x + tb.width / 2, y: tb.y + tb.height / 2 + 12 });
  await saved(page);
  await expect.poll(async () => (await nodeById(h1Id))?.styles.bp["768"]?.["padding-top"], { timeout: 30_000 }).toBe("12px");
  await page.getByRole("group", { name: "Thiết bị" }).getByRole("button", { name: "1440" }).click();
  await expect.poll(() => h1.evaluate((el) => el.getBoundingClientRect().width)).toBe(width1440);
  for (let i = 0; i < 2; i++) { await page.getByRole("button", { name: "Hoàn tác" }).click(); await saved(page); }
  await page.close();
});
```

(Padding-top ban đầu của h1 là 0 → 0 + 12 = `12px`.)

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts -t "resize"`
Expected: FAIL — không có `ui_editor_resize_handle`.

- [ ] **Step 2: Cài đặt overlay** — `overlay.tsx` thêm vào props `handles?: { id: string; list: Handle[]; onHandle(h: Handle, e: ReactPointerEvent): void; onSpacing(side: Side | "gap", e: ReactPointerEvent): void; gap?: Box }` và render sau các selection box (chỉ khi `selected.length === 1`):

```tsx
      {handles && selected[0] && (() => {
        const { box: b, padding: [pt, pr, pb, pl] } = selected[0].m;
        const point: Record<Handle, [number, number]> = { n: [b.x + b.w / 2, b.y], s: [b.x + b.w / 2, b.y + b.h], e: [b.x + b.w, b.y + b.h / 2], w: [b.x, b.y + b.h / 2], ne: [b.x + b.w, b.y], nw: [b.x, b.y], se: [b.x + b.w, b.y + b.h], sw: [b.x, b.y + b.h] };
        const bars: Record<Side, Box> = { top: { x: b.x + b.w / 2 - 12, y: b.y + pt - 2, w: 24, h: 4 }, bottom: { x: b.x + b.w / 2 - 12, y: b.y + b.h - pb - 2, w: 24, h: 4 }, left: { x: b.x + pl - 2, y: b.y + b.h / 2 - 12, w: 4, h: 24 }, right: { x: b.x + b.w - pr - 2, y: b.y + b.h / 2 - 12, w: 4, h: 24 } };
        return (
          <>
            {handles.list.map((h) => <div key={h} className={`ve-handle is-${h}`} data-ui="ui_editor_resize_handle" data-handle={h} style={{ left: point[h][0] * zoom - 4, top: point[h][1] * zoom - 4 }} onPointerDown={(e) => handles.onHandle(h, e)} />)}
            {(Object.keys(bars) as Side[]).map((s) => <div key={s} className="ve-spacing-handle" data-ui="ui_editor_spacing_handle" data-side={s} style={at(bars[s], zoom)} onPointerDown={(e) => handles.onSpacing(s, e)} />)}
            {handles.gap && <div className="ve-spacing-handle is-gap" data-ui="ui_editor_spacing_handle" data-side="gap" style={at(handles.gap, zoom)} onPointerDown={(e) => handles.onSpacing("gap", e)} />}
          </>
        );
      })()}
```

- [ ] **Step 3: Cài đặt gesture** — `visual-editor.tsx` (import `handlesFor`, `resizeCommands`, `spacingCommand`, `type Handle`, `type Side`):

```tsx
  type Resize = { kind: "resize"; id: string; el: HTMLElement; handle: Handle; start: { x: number; y: number }; size: { w: number; h: number; top: number; left: number }; prev: Record<string, string>; dx: number; dy: number; shift: boolean };
  type Spacing = { kind: "spacing"; id: string; el: HTMLElement; what: Side | "gap"; start: { x: number; y: number }; from: number; prev: string; delta: number };
  const PROPS = ["width", "height", "top", "left"] as const;
  const startResize = (h: Handle, e: React.PointerEvent) => {
    e.stopPropagation();
    const nid = selection[0], el = nid ? canvas.current?.element(nid) : null;
    if (!nid || !el) return;
    const cs = el.ownerDocument.defaultView!.getComputedStyle(el), px = (v: string) => parseFloat(v) || 0;
    setGesture({ kind: "resize", id: nid, el, handle: h, start: canvas.current!.toDoc(e.clientX, e.clientY), size: { w: px(cs.width), h: px(cs.height), top: px(cs.top), left: px(cs.left) },
      prev: Object.fromEntries(PROPS.map((p) => [p, el.style.getPropertyValue(p)])), dx: 0, dy: 0, shift: e.shiftKey });
  };
  const startSpacing = (what: Side | "gap", e: React.PointerEvent) => {
    e.stopPropagation();
    const nid = selection[0], el = nid ? canvas.current?.element(nid) : null;
    if (!nid || !el) return;
    const prop = what === "gap" ? "column-gap" : `padding-${what}`;
    setGesture({ kind: "spacing", id: nid, el, what, start: canvas.current!.toDoc(e.clientX, e.clientY), from: parseFloat(el.ownerDocument.defaultView!.getComputedStyle(el).getPropertyValue(prop)) || 0, prev: el.style.getPropertyValue(what === "gap" ? "gap" : prop), delta: 0 });
  };
  const changesOf = (cmd: EditorCommand) => (cmd.op === "setStyle" ? cmd.changes : {});
```

`gestureMove` thêm:

```tsx
    if (gesture?.kind === "resize") {
      const p = canvas.current!.toDoc(e.clientX, e.clientY), dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
      const [cmd] = resizeCommands({ id: gesture.id, target: styleTarget(bp), handle: gesture.handle, start: gesture.size, dx, dy, keepRatio: e.shiftKey });
      for (const [prop, value] of Object.entries(changesOf(cmd!))) if (value) gesture.el.style.setProperty(prop, value); // optimistic
      setGesture({ ...gesture, dx, dy, shift: e.shiftKey });
    }
    if (gesture?.kind === "spacing") {
      const p = canvas.current!.toDoc(e.clientX, e.clientY);
      const delta = gesture.what === "top" ? p.y - gesture.start.y : gesture.what === "bottom" ? gesture.start.y - p.y : gesture.what === "left" ? p.x - gesture.start.x : gesture.what === "right" ? gesture.start.x - p.x : p.x - gesture.start.x;
      const cmd = spacingCommand(gesture.id, styleTarget(bp), gesture.what, gesture.from, delta);
      for (const [prop, value] of Object.entries(changesOf(cmd))) if (value) gesture.el.style.setProperty(prop, value);
      setGesture({ ...gesture, delta });
    }
```

`gestureUp` thêm:

```tsx
    if (gesture?.kind === "resize") {
      const g = gesture, restore = () => { for (const p of PROPS) g.el.style.setProperty(p, g.prev[p] ?? ""); };
      if (g.dx === 0 && g.dy === 0) restore();
      else batch({ commands: resizeCommands({ id: g.id, target: styleTarget(bp), handle: g.handle, start: g.size, dx: g.dx, dy: g.dy, keepRatio: g.shift }) }, "Đổi kích thước", { rollback: restore });
    }
    if (gesture?.kind === "spacing") {
      const g = gesture, prop = g.what === "gap" ? "gap" : `padding-${g.what}`, restore = () => g.el.style.setProperty(prop, g.prev);
      if (Math.round(g.delta) === 0) restore();
      else batch({ commands: [spacingCommand(g.id, styleTarget(bp), g.what, g.from, g.delta)] }, "Khoảng cách", { rollback: restore });
    }
```

Truyền cho `<Overlay>`:

```tsx
            handles={selection.length === 1 && editable ? (() => {
              const el = canvas.current?.element(selection[0]!), cs = el ? el.ownerDocument.defaultView!.getComputedStyle(el) : null;
              const kids = (index.get(selection[0]!)?.children ?? []).flatMap((k) => { const ke = canvas.current?.element(k); return ke ? [measure(ke).box] : []; });
              const gap = cs && /flex|grid/.test(cs.display) && kids.length >= 2 ? (axisOf(cs.display, cs.flexDirection) === "x"
                ? { x: kids[0]!.x + kids[0]!.w, y: kids[0]!.y, w: Math.max(4, kids[1]!.x - kids[0]!.x - kids[0]!.w), h: kids[0]!.h }
                : { x: kids[0]!.x, y: kids[0]!.y + kids[0]!.h, w: kids[0]!.w, h: Math.max(4, kids[1]!.y - kids[0]!.y - kids[0]!.h) }) : undefined;
              return { id: selection[0]!, list: handlesFor(cs?.position === "absolute" || cs?.position === "fixed"), onHandle: startResize, onSpacing: startSpacing, ...(gap && { gap }) };
            })() : undefined}
```

Thêm `const editable = true;` cạnh state của `VisualEditor` (Task 13 thay bằng `!viewOnly`).

`globals.css`:

```css
.ve-handle { position: absolute; width: 8px; height: 8px; background: var(--c-bg); border: 2px solid var(--c-primary); pointer-events: auto; }
.ve-handle.is-n, .ve-handle.is-s { cursor: ns-resize; } .ve-handle.is-e, .ve-handle.is-w { cursor: ew-resize; }
.ve-handle.is-ne, .ve-handle.is-sw { cursor: nesw-resize; } .ve-handle.is-nw, .ve-handle.is-se { cursor: nwse-resize; }
.ve-spacing-handle { position: absolute; background: var(--c-success); border-radius: 2px; pointer-events: auto; cursor: grab; }
.ve-spacing-handle.is-gap { background: color-mix(in srgb, var(--c-accent) 60%, transparent); }
```

`stitch-screens.md`: `ui_editor_resize_handle` (8 handle; e/s/se cho node theo luồng; Shift khoá tỉ lệ — `setStyle width/height[/top/left]` ở bp hiện tại), `ui_editor_spacing_handle` (kéo mép trong: padding-top/right/bottom/left, gap).

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/overlay.tsx" "src/app/p/[id]/editor/visual/visual-editor.tsx" src/app/globals.css docs/superpowers/design/stitch-screens.md tests/e2e/visual-editor-advanced.test.ts
git commit -m "feat(e3b): resize handles (Shift keeps ratio, top/left only when absolute) and padding/gap handles at the breakpoint

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Zoom 25–200 % và pan

**Files:**
- Modify: `src/app/p/[id]/editor/visual/canvas.tsx` (scale, wheel, keyup), `visual-editor.tsx` (state zoom, nút, phím, pan), `scripts/gen-icons.mjs` + `src/app/_ui/icons.gen.ts` + `tests/unit/icons.test.ts` (+3: `zoom_in`, `zoom_out`, `fit_screen` → 86), `src/app/globals.css`, `docs/superpowers/design/stitch-screens.md`
- Test: `tests/e2e/visual-editor-advanced.test.ts` (append)

**Interfaces:**
- Consumes: `ZOOM`, `zoomStep`, `wheelZoom`, `fitZoom`, `clampZoom` (Task 6); `keyAction` zoom (Task 6).
- Produces: `Canvas` props `zoom: number`, `onZoomWheel(deltaY: number): void`, `onKeyUp(e: KeyboardEvent): void`; handle `pane(): HTMLDivElement | null`.

- [ ] **Step 1: Icon** — `NAMES` thêm `// visual editor E3b (zoom)` `"zoom_in", "zoom_out", "fit_screen",`; `icons.test.ts` 83 → 86; `npm run icons` (Expected: `gen-icons: 86 icons`).

- [ ] **Step 2: Viết e2e đỏ** — append:

```ts
test("E3b zoom: Ctrl+- to 50 % scales the frame and the overlay, a click still selects the right node; Vừa khung fits; Ctrl+0 back to 100 %; Space+drag pans", { timeout: 180_000 }, async () => {
  const page = await open();
  const frame = page.locator('[data-ui="ui_editor_canvas_frame"]');
  const label = page.locator('[data-ui="ui_editor_zoom"] output');
  await canvas(page).locator("body").click({ position: { x: 5, y: 5 } }); // focus the canvas
  for (let i = 0; i < 3; i++) await page.keyboard.press("Control+-"); // 100 -> 75 -> 67 -> 50
  await expect.poll(() => label.innerText()).toBe("50%");
  await expect.poll(() => frame.evaluate((f) => getComputedStyle(f).transform)).toBe("matrix(0.5, 0, 0, 0.5, 0, 0)");
  const h1 = canvas(page).locator("h1");
  await h1.click();
  const sel = page.locator('[data-ui="ui_editor_selection_box"]').first();
  await expect.poll(() => sel.getAttribute("data-for")).toBe(await h1.getAttribute("data-ir-id"));
  const [hb, sb] = [(await h1.boundingBox())!, (await sel.boundingBox())!];
  expect(Math.abs(hb.x - sb.x) + Math.abs(hb.y - sb.y) + Math.abs(hb.width - sb.width)).toBeLessThan(3);
  await page.getByRole("button", { name: "Vừa khung" }).click();
  const pane = page.locator('[data-ui="ui_editor_canvas_chrome"]');
  // zoom is kept to 2 decimals: at 1440 that is within 8 px of the pane
  await expect.poll(async () => Math.abs((await frame.boundingBox())!.width - ((await pane.evaluate((p) => p.clientWidth)) - 16))).toBeLessThan(8);
  await page.keyboard.press("Control+0");
  await expect.poll(() => label.innerText()).toBe("100%");
  // pan: the 1440 frame is wider than the pane
  const sx = await pane.evaluate((p) => p.scrollLeft);
  await page.keyboard.down(" ");
  const fb = (await frame.boundingBox())!;
  await drag(page, { x: fb.x + 400, y: fb.y + 200 }, { x: fb.x + 100, y: fb.y + 200 });
  await page.keyboard.up(" ");
  await expect.poll(() => pane.evaluate((p) => p.scrollLeft)).toBeGreaterThan(sx);
  await page.close();
});
```

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts -t "zoom"`
Expected: FAIL — không có `ui_editor_zoom`.

- [ ] **Step 3: Cài đặt canvas** — `canvas.tsx`: thêm props `zoom`, `onZoomWheel`, `onKeyUp`; handle thêm `pane: () => pane.current`; khung:

```tsx
    <div className="ve-pane" data-ui="ui_editor_canvas_chrome" ref={pane}
      onWheel={(e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); events.current.onZoomWheel(e.deltaY); } }}>
      <div className="ve-stage" style={{ width: width * zoom, height }}>
        <iframe key={frameKey} ref={frame} data-ui="ui_editor_canvas_frame" title="Canvas" sandbox="allow-same-origin allow-scripts" srcDoc={html} onLoad={onLoad}
          style={{ width, height: height / zoom, transform: `scale(${zoom})`, transformOrigin: "0 0" }} />
        {children}
      </div>
    </div>
```

(React gắn `onWheel` passive: đặt listener thật trong `useEffect` — `pane.current.addEventListener("wheel", h, { passive: false })` — thay cho prop `onWheel`, cùng thân hàm.) Trong `onLoad` thêm `d.addEventListener("wheel", (e) => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); events.current.onZoomWheel(e.deltaY); } }, { passive: false });` và `d.addEventListener("keyup", (e) => events.current.onKeyUp(e));`.

- [ ] **Step 4: Cài đặt editor** — `visual-editor.tsx`:

```tsx
  const [zoom, setZoom] = useState(1);
  const space = useRef(false);
  // live.current = { data, index, selection, editable, zoom, bp }: Task 8's zoomNow() / bpNow() read live.current.zoom / .bp
  const fit = () => { const w = canvas.current?.pane()?.clientWidth; if (w) setZoom(fitZoom(w, bp)); };
  const onKeyUp = (e: KeyboardEvent) => { if (e.key === " ") space.current = false; };
  type Pan = { kind: "pan"; x: number; y: number; left: number; top: number };
```

Trong `onKey`, dòng đầu tiên (trước `keyAction`):

```tsx
    if (e.key === " " && !typingIn(e.target)) { space.current = true; e.preventDefault(); return; }
```

và thêm vào `switch (action)`:

```tsx
      case "zoomIn": e.preventDefault(); setZoom((z) => zoomStep(z, 1)); return;
      case "zoomOut": e.preventDefault(); setZoom((z) => zoomStep(z, -1)); return;
      case "zoomReset": e.preventDefault(); setZoom(1); return;
```

`useEffect` lắng nghe phím của cửa sổ đăng ký thêm `window.addEventListener("keyup", (e) => keyUpRef.current(e))` (`keyUpRef` như `keyRef`). Ở **đầu** `onPress` (trước khi tìm node đã chọn) — tọa độ của sự kiện iframe đổi sang cửa sổ cha:

```tsx
    if (space.current) {
      const c = canvas.current!, r = c.frame()!.getBoundingClientRect(), z = live.current.zoom;
      setGesture({ kind: "pan", x: r.left + e.clientX * z, y: r.top + e.clientY * z, left: c.pane()!.scrollLeft, top: c.frame()!.contentWindow!.scrollY });
      return;
    }
```

`gestureMove` thêm:

```tsx
    if (gesture?.kind === "pan") {
      canvas.current!.pane()!.scrollLeft = gesture.left - (e.clientX - gesture.x);
      canvas.current!.frame()!.contentWindow!.scrollTo({ top: gesture.top - (e.clientY - gesture.y) / zoom });
    }
```

Toolbar (sau `ui_editor_bp_switch`):

```tsx
        <div className="ve-zoom" data-ui="ui_editor_zoom" role="group" aria-label="Zoom">
          <IconButton icon="zoom_out" label="Thu nhỏ" onClick={() => setZoom((z) => zoomStep(z, -1))} disabled={zoom <= ZOOM.min} />
          <output className="t-label-md" aria-live="polite">{Math.round(zoom * 100)}%</output>
          <IconButton icon="zoom_in" label="Phóng to" onClick={() => setZoom((z) => zoomStep(z, 1))} disabled={zoom >= ZOOM.max} />
          <IconButton icon="fit_screen" label="Vừa khung" onClick={fit} />
        </div>
```

`<Canvas … zoom={zoom} onZoomWheel={(dy) => setZoom((z) => wheelZoom(z, dy))} onKeyUp={onKeyUp}>` và mọi `at(…, 1)` / `<Overlay zoom={1}>` của Task 7–9 đổi thành `zoom`.

`globals.css`: `.ve-zoom { display: inline-flex; align-items: center; gap: 2px; } .ve-zoom output { min-width: 44px; text-align: center; }`

`stitch-screens.md`: `ui_editor_zoom` ("E3 §3 zoom 25–200 %: Thu nhỏ / % / Phóng to / Vừa khung; Ctrl+lăn, Ctrl±, Ctrl+0; pan Space+kéo — chỉ hiển thị, không lưu").

- [ ] **Step 5: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/icons.test.ts && npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts`
Expected: PASS (mọi test drag/resize trước vẫn xanh ở zoom 100 %).

- [ ] **Step 6: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/canvas.tsx" "src/app/p/[id]/editor/visual/visual-editor.tsx" scripts/gen-icons.mjs src/app/_ui/icons.gen.ts tests/unit/icons.test.ts src/app/globals.css docs/superpowers/design/stitch-screens.md tests/e2e/visual-editor-advanced.test.ts
git commit -m "feat(e3b): canvas zoom 25-200% (buttons, Ctrl+wheel, Ctrl+/-/0, fit) with scaled overlay; Space+drag pan

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Panel "Thêm" (mẫu + component mẫu, click hoặc kéo)

**Files:**
- Create: `src/app/p/[id]/editor/visual/templates.ts`, `src/app/p/[id]/editor/visual/insert-panel.tsx`
- Modify: `src/app/p/[id]/editor/visual/visual-editor.tsx` (tab trái Layers / Thêm, gesture insert), `scripts/gen-icons.mjs` + `src/app/_ui/icons.gen.ts` + `tests/unit/icons.test.ts` (+10 → 96), `src/app/globals.css`, `docs/superpowers/design/stitch-screens.md`
- Test: `tests/unit/templates.test.ts`, `tests/e2e/visual-editor-advanced.test.ts` (append)

**Interfaces:**
- Consumes: R2 (Task 2); `insertAt`, `guardParent`, `Batch`, `DocIndex`, `Zone` (model); `dropZone`, `indicator` (Task 6).
- Produces:

```ts
export type Template = { id: string; label: string; icon: IconName; draft: NodeDraft; kind?: InteractiveKind; roles?: Record<string, unknown> };
export const TEMPLATES: readonly Template[];
export function insertBatch(t: Template, at: { parentId: string; index: number }): Batch;
export function dropPosition(index: DocIndex, components: readonly PanelComponent[], overId: string, zone: Zone): { parentId: string; index: number } | { error: string };
export function InsertPanel(props: { onInsert(t: Template): void; onDragStart(t: Template, e: React.PointerEvent): void }): JSX.Element;
```

- [ ] **Step 1: Icon** — `NAMES` thêm `// visual editor E3b (insert panel)` `"text_fields", "text_snippet", "add_box", "view_week", "view_agenda", "grid_view", "view_carousel", "tab", "expand_circle_down", "web_asset",`; `icons.test.ts` 86 → 96; `npm run icons`.

- [ ] **Step 2: Viết test đỏ** — `tests/unit/templates.test.ts`:

```ts
import { expect, test } from "vitest";
import { applyCommands, prepareCommands } from "@/core/ir-command";
import type { IRNodeV2, IRV2 } from "@/core/ir-v2";
import { indexPage } from "@/app/p/[id]/editor/visual/model";
import { dropPosition, insertBatch, TEMPLATES } from "@/app/p/[id]/editor/visual/templates";

const n = (id: string, tag: string, children: IRNodeV2[] = [], extra: Partial<IRNodeV2> = {}): IRNodeV2 => {
  const node: IRNodeV2 = { id, tag, type: tag === "#text" ? "text" : "container", attrs: {}, styles: { base: {}, bp: {}, state: {}, pseudo: {} }, children, ...extra };
  for (const c of children) c.parentId = id;
  return node;
};
const doc = (): IRV2 => ({
  version: 2, revision: 0,
  pages: [{ id: "pg", path: "/", title: "", meta: {}, sectionIds: ["s1"], shell: n("html", "html", [n("body", "body", [n("ph", "#section", [], { attrs: { "data-section": "s1" } })])]) }],
  sections: [{ id: "s1", pageId: "pg", name: "S", role: "main", hash: "h", origin: "capture", root: n("r", "section", [n("a", "p"), n("b", "div")]) }],
  layouts: [], components: [], tokens: {}, cssom: { keyframes: [], fontFace: [], vars: {} }, interactions: [], fidelity: [],
});
let k = 0;
const ids = () => `x${++k}`;

test("every template of spec §3 is one valid batch (createNode [+ convertToComponent]) the core accepts; component samples become their kind; Vietnamese text, no class", () => {
  expect(TEMPLATES.map((t) => t.label)).toEqual(["Text", "Tiêu đề", "Đoạn văn", "Ảnh", "Nút", "Link", "Khung trống", "Flex hàng", "Flex cột", "Grid 2 cột", "Grid 3 cột", "Section trống", "Carousel", "Tabs", "Accordion", "Modal"]);
  for (const t of TEMPLATES) {
    const b = insertBatch(t, { parentId: "r", index: 1 });
    if ("error" in b) throw new Error(b.error);
    const forward = prepareCommands(doc(), b.commands, ids);
    const done = applyCommands(doc(), forward);
    const made = done.ir.sections[0]!.root.children[1]!;
    expect(done.createdIds, t.id).toEqual([made.id]);
    if (t.kind) expect(made.interactive?.kind, t.id).toBe(t.kind); else expect(b.commands, t.id).toHaveLength(1);
    expect(JSON.stringify(t.draft), t.id).not.toMatch(/"class"/);
  }
});

test("dropPosition: before / after a node in its parent, inside a container at the end; a void tag or the shell refuses", () => {
  const index = indexPage({ shell: doc().pages[0]!.shell, sections: [{ id: "s1", name: "S", root: doc().sections[0]!.root }] });
  expect(dropPosition(index, [], "b", "before")).toEqual({ parentId: "r", index: 1 });
  expect(dropPosition(index, [], "a", "after")).toEqual({ parentId: "r", index: 1 });
  expect(dropPosition(index, [], "b", "inside")).toEqual({ parentId: "b", index: 0 });
  expect(dropPosition(index, [], "r", "before")).toEqual({ error: expect.any(String) });
});
```

Run: `npx vitest run tests/unit/templates.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Cài đặt `templates.ts`**

```ts
// E3 §3 "Thêm": the insertable templates (Vietnamese sample content, minimal inline-free styles, no class) and the
// batch each one is — createNode, plus convertToComponent naming the new nodes (R2) for the component samples.
import type { InteractiveKind, PanelComponent } from "@/core/interactive";
import type { NodeDraft } from "@/core/ir-command";
import type { IconName } from "@/app/_ui/icons.gen";
import { guardParent, type Batch, type DocIndex, type Zone } from "./model";

export type Template = { id: string; label: string; icon: IconName; draft: NodeDraft; kind?: InteractiveKind; roles?: Record<string, unknown> };
const text = (t: string): NodeDraft => ({ tag: "#text", text: t });
const base = (decl: Record<string, string>) => ({ base: decl });
const item = (t: string): NodeDraft => ({ tag: "div", styles: base({ padding: "16px", "background-color": "#f2f2f2" }), children: [{ tag: "p", children: [text(t)] }] });
const PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E%3Crect width='100%25' height='100%25' fill='%23d9d9d9'/%3E%3C/svg%3E";
const grid = (cols: number): NodeDraft => ({ tag: "div", styles: base({ display: "grid", "grid-template-columns": `repeat(${cols}, minmax(0, 1fr))`, gap: "16px", padding: "16px" }), children: Array.from({ length: cols }, (_, i) => item(`Cột ${i + 1}`)) });
const slide = (i: number): NodeDraft => ({ tag: "div", styles: base({ padding: "48px 16px", "text-align": "center", "background-color": "#eeeeee" }), children: [{ tag: "p", children: [text(`Slide ${i}`)] }] });
const button = (t: string, label?: string): NodeDraft => ({ tag: "button", attrs: { type: "button", ...(label && { "aria-label": label }) }, children: [text(t)] });

export const TEMPLATES: readonly Template[] = [
  { id: "text", label: "Text", icon: "text_fields", draft: { tag: "span", children: [text("Văn bản mới")] } },
  { id: "heading", label: "Tiêu đề", icon: "title", draft: { tag: "h2", children: [text("Tiêu đề mới")] } },
  { id: "paragraph", label: "Đoạn văn", icon: "text_snippet", draft: { tag: "p", children: [text("Đoạn văn mới. Nhấp đúp để sửa nội dung.")] } },
  { id: "image", label: "Ảnh", icon: "image", draft: { tag: "img", attrs: { src: PLACEHOLDER, alt: "Ảnh mới", width: "320", height: "180" } } },
  { id: "button", label: "Nút", icon: "touch_app", draft: { ...button("Nút bấm"), styles: base({ padding: "8px 16px", "border-radius": "4px" }) } },
  { id: "link", label: "Link", icon: "link", draft: { tag: "a", attrs: { href: "#" }, children: [text("Liên kết")] } },
  { id: "box", label: "Khung trống", icon: "add_box", draft: { tag: "div", styles: base({ "min-height": "80px", padding: "16px" }) } },
  { id: "row", label: "Flex hàng", icon: "view_week", draft: { tag: "div", styles: base({ display: "flex", gap: "16px", padding: "16px" }), children: [item("Mục 1"), item("Mục 2")] } },
  { id: "column", label: "Flex cột", icon: "view_agenda", draft: { tag: "div", styles: base({ display: "flex", "flex-direction": "column", gap: "16px", padding: "16px" }), children: [item("Mục 1"), item("Mục 2")] } },
  { id: "grid2", label: "Grid 2 cột", icon: "grid_view", draft: grid(2) },
  { id: "grid3", label: "Grid 3 cột", icon: "grid_view", draft: grid(3) },
  // R7: a <section> inside the current section (the Command API cannot add an IR section)
  { id: "section", label: "Section trống", icon: "crop_square", draft: { tag: "section", styles: base({ "min-height": "160px", padding: "48px 16px" }) } },
  {
    id: "carousel", label: "Carousel", icon: "view_carousel", kind: "carousel",
    draft: { tag: "div", styles: base({ position: "relative" }), children: [
      { tag: "div", styles: base({ overflow: "hidden" }), children: [{ tag: "div", styles: base({ display: "flex" }), children: [slide(1), slide(2), slide(3)] }] },
      button("‹", "Slide trước"), button("›", "Slide sau"),
    ] },
    roles: { viewport: "new:0/0", track: "new:0/0.0", slides: ["new:0/0.0.0", "new:0/0.0.1", "new:0/0.0.2"], arrows: { prev: "new:0/1", next: "new:0/2" } },
  },
  {
    id: "tabs", label: "Tabs", icon: "tab", kind: "tabs",
    draft: { tag: "div", children: [{ tag: "div", attrs: { role: "tablist" }, children: [button("Tab 1"), button("Tab 2")] }, { tag: "div", children: [{ tag: "p", children: [text("Nội dung tab 1")] }] }, { tag: "div", children: [{ tag: "p", children: [text("Nội dung tab 2")] }] }] },
    roles: { tabs: [{ trigger: "new:0/0.0", panel: "new:0/1" }, { trigger: "new:0/0.1", panel: "new:0/2" }] },
  },
  {
    id: "accordion", label: "Accordion", icon: "expand_circle_down", kind: "accordion",
    draft: { tag: "div", children: [button("Câu hỏi 1"), { tag: "div", children: [{ tag: "p", children: [text("Trả lời 1")] }] }, button("Câu hỏi 2"), { tag: "div", children: [{ tag: "p", children: [text("Trả lời 2")] }] }] },
    roles: { items: [{ trigger: "new:0/0", panel: "new:0/1" }, { trigger: "new:0/2", panel: "new:0/3" }] },
  },
  {
    id: "modal", label: "Modal", icon: "web_asset", kind: "modal",
    draft: { tag: "div", children: [button("Mở hộp thoại"), { tag: "div", attrs: { role: "dialog" }, styles: base({ display: "none", padding: "24px", "background-color": "#ffffff" }), children: [{ tag: "p", children: [text("Nội dung hộp thoại")] }, button("Đóng")] }] },
    roles: { triggers: ["new:0/0"], dialog: "new:0/1", closeButton: "new:0/1.1", closeOn: ["esc", "backdrop", "button"] },
  },
];

export function insertBatch(t: Template, at: { parentId: string; index: number }): Batch {
  return { commands: [
    { op: "createNode", parentId: at.parentId, index: at.index, draft: t.draft },
    ...(t.kind ? [{ op: "convertToComponent" as const, id: "new:0/", kind: t.kind, roles: t.roles! }] : []),
  ] };
}
// a new node dropped on `overId`: before / after it in its parent, or last inside it
export function dropPosition(index: DocIndex, components: readonly PanelComponent[], overId: string, zone: Zone): { parentId: string; index: number } | { error: string } {
  const over = index.get(overId);
  if (!over) return { error: "Không tìm thấy vị trí thả." };
  const parentId = zone === "inside" ? over.node.id : over.sectionName !== undefined ? undefined : over.parent;
  if (parentId === undefined) return { error: "Thả vào trong section, không đặt cạnh section." };
  const why = guardParent(index, components, parentId);
  if (why) return { error: why };
  return { parentId, index: zone === "inside" ? over.node.children.length : over.index + (zone === "after" ? 1 : 0) };
}
```

(Nếu test core báo một mẫu sai — ví dụ tabs cần panel ẩn — sửa draft cho tới khi `prepareCommands` + `applyCommands` chấp nhận; test đầu là chuẩn.)

`insert-panel.tsx`:

```tsx
"use client";
// E3 §3 panel "Thêm": click inserts after the selection; dragging onto the canvas uses the insertion bar.
import type { PointerEvent as ReactPointerEvent } from "react";
import { Icon } from "@/app/_ui/Icon";
import { TEMPLATES, type Template } from "./templates";

export function InsertPanel({ onInsert, onDragStart }: { onInsert(t: Template): void; onDragStart(t: Template, e: ReactPointerEvent): void }) {
  return (
    <ul className="ve-insert" data-ui="ui_editor_insert_panel">
      {TEMPLATES.map((t) => (
        <li key={t.id}>
          <button type="button" className="ve-insert-item" data-ui="ui_editor_insert_item" onClick={() => onInsert(t)}
            onPointerDown={(e) => { if (e.button === 0) onDragStart(t, e); }}>
            <Icon name={t.icon} size={20} />
            <span>{t.label}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Viết e2e đỏ** — append:

```ts
test("E3b insert: Flex hàng after the selection (click) and a Carousel sample dragged under the h1 — one batch each (Carousel = node + component), one Undo removes both", { timeout: 240_000 }, async () => {
  const page = await open();
  const h1 = canvas(page).locator("h1");
  await h1.click();
  await page.getByRole("tab", { name: "Thêm" }).click();
  const before = (await payload()).revision;
  await page.getByRole("button", { name: "Flex hàng" }).click();
  await saved(page);
  await expect.poll(() => h1.evaluate((el) => el.nextElementSibling && getComputedStyle(el.nextElementSibling).display), { timeout: 30_000 }).toBe("flex");
  expect((await payload()).revision).toBe(before + 1);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await saved(page);
  const item = (await page.getByRole("button", { name: "Carousel" }).boundingBox())!;
  const hb = (await h1.boundingBox())!;
  await drag(page, centre(item), { x: hb.x + hb.width / 2, y: hb.y + hb.height - 2 });
  await saved(page);
  await expect.poll(() => canvas(page).locator('[data-c="carousel"]').count(), { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await canvas(page).locator('[data-c="carousel"] [data-c-role="slide"]').count()).toBe(3);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await saved(page);
  await expect.poll(() => canvas(page).locator('[data-c="carousel"]').count(), { timeout: 30_000 }).toBe(0);
  await page.close();
});
```

Run: `npx vitest run tests/unit/templates.test.ts && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts -t "insert"`
Expected: unit PASS sau Step 3; e2e FAIL — không có tab "Thêm".

- [ ] **Step 5: Nối vào editor** — `visual-editor.tsx`: state `const [left, setLeft] = useState<"layers" | "insert">("layers");`; trong `<aside data-ui="ui_editor_layers">` thay tiêu đề bằng

```tsx
          <SegmentedControl<"layers" | "insert"> label="Bảng bên trái" semantics="tabs" data-ui="ui_editor_left_tabs" value={left} onChange={setLeft}
            options={[{ value: "layers", label: "Layers" }, { value: "insert", label: "Thêm" }]} />
          {left === "layers" && data && <LayerTree … />}
          {left === "insert" && <InsertPanel onInsert={insert} onDragStart={dragTemplate} />}
```

với

```tsx
  type Insert = { kind: "insert"; template: Template; start: { x: number; y: number }; drop?: Drop & { at?: { parentId: string; index: number } } };
  const insert = (t: Template) => {
    const at = insertAt(index, data?.interactives ?? [], selection[0]);
    if ("error" in at) return setMsg(at.error);
    batch(insertBatch(t, at), `Thêm ${t.label}`);
  };
  // a press on a template becomes a drag after 4 px; a plain click keeps the button's onClick (insert after the selection)
  const dragTemplate = (t: Template, e: React.PointerEvent) => {
    const x = e.clientX, y = e.clientY;
    const move = (m: PointerEvent) => {
      if (Math.hypot(m.clientX - x, m.clientY - y) < 4) return;
      done();
      setGesture({ kind: "insert", template: t, start: { x, y } });
    };
    const done = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", done); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
  };
```

`gestureMove` thêm:

```tsx
    if (gesture?.kind === "insert") {
      const c = canvas.current, ix = live.current.index, comps = live.current.data?.interactives ?? [];
      const r = c?.frame()?.getBoundingClientRect();
      const inside = !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      const p = inside ? c!.toDoc(e.clientX, e.clientY) : undefined;
      const raw = p ? c!.hit(p.x, p.y) : null, over = raw ? pickTarget(ix, raw) : undefined, el = over ? c!.element(over) : null;
      if (!p || !over || !el) return setGesture({ ...gesture, drop: undefined });
      const m = measure(el), parentEl = ix.get(over)?.parent ? c!.element(ix.get(over)!.parent!) : null;
      const cs = parentEl ? parentEl.ownerDocument.defaultView!.getComputedStyle(parentEl) : null;
      const axis = cs ? axisOf(cs.display, cs.flexDirection) : "y";
      const zone = dropZone(m.box, p, axis, guardParent(ix, comps, over) === undefined);
      const pos = dropPosition(ix, comps, over, zone);
      setGesture({ ...gesture, drop: { box: indicator(m.box, zone, axis), ok: !("error" in pos), ...("error" in pos ? { reason: pos.error } : { at: pos }) } });
    }
```

`gestureUp` thêm: `if (gesture?.kind === "insert" && gesture.drop?.at) batch(insertBatch(gesture.template, gesture.drop.at), `Thêm ${gesture.template.label}`);`. Vạch chèn của Task 7 render cho cả `gesture.kind === "insert"` (điều kiện `(gesture?.kind === "flow" || gesture?.kind === "insert") && gesture.drop`). Import thêm `insertAt` từ `./model`; `InsertPanel` từ `./insert-panel`; `insertBatch`, `dropPosition`, `type Template` từ `./templates`.

`globals.css`:

```css
.ve-insert { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.ve-insert-item { width: 100%; display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 10px 4px; border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-surface); color: var(--c-text); font: var(--t-label-sm); cursor: grab; }
.ve-insert-item:hover { background: var(--c-surface-high); }
```

`stitch-screens.md`: `ui_editor_left_tabs` (Layers / Thêm), `ui_editor_insert_panel` (E3 §3 16 mẫu — `createNode` (+ `convertToComponent` cùng batch, R2)), `ui_editor_insert_item`.

- [ ] **Step 6: Chạy test, xác nhận xanh**

Run: `npx vitest run tests/unit/templates.test.ts tests/unit/icons.test.ts && npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/templates.ts" "src/app/p/[id]/editor/visual/insert-panel.tsx" "src/app/p/[id]/editor/visual/visual-editor.tsx" scripts/gen-icons.mjs src/app/_ui/icons.gen.ts tests/unit/icons.test.ts src/app/globals.css docs/superpowers/design/stitch-screens.md tests/unit/templates.test.ts tests/e2e/visual-editor-advanced.test.ts
git commit -m "feat(e3b): insert panel — 16 templates incl. carousel/tabs/accordion/modal samples as one batch; click or drag in

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: "Gộp thành layout" trong editor mới, gỡ GrapesJS, chuyển e2e

**Files:**
- Delete: `src/core/grapes-adapter.ts`, `src/app/p/[id]/editor/editor-view.tsx`, `src/app/api/projects/[id]/editor/save/route.ts`, `src/app/api/projects/[id]/editor/promote-layout/route.ts`, `tests/unit/grapes-adapter.test.ts`, `tests/e2e/grapes-textnode.test.ts`
- Modify: `src/app/api/projects/[id]/editor/route.ts`, `src/core/editor-canvas.ts` (`allSections`), `src/core/fidelity.ts` (xoá `styleTargetFidelity`), `src/app/p/[id]/editor/page.tsx`, `src/app/p/[id]/editor/visual/visual-editor.tsx`, `src/app/p/[id]/editor/component-panel/component-panel.tsx` (comment), `src/app/globals.css` (xoá `.editor-shell .gjs-*`, `.editor-grid`, `.editor-rail`, `.editor-shell`), `package.json` + `package-lock.json` (`npm uninstall grapesjs`), `docs/superpowers/design/stitch-screens.md`
- Test: `tests/unit/editor-api.test.ts`, `tests/unit/emit-components.test.ts`, `tests/unit/fidelity.test.ts`, `tests/e2e/editor-smoke.test.ts`, `tests/e2e/editor-components.test.ts`, `tests/e2e/visual-editor.test.ts`

**Interfaces:**
- Consumes: `promoteLayout` command (E1), command bus.
- Produces: `CanvasPayload.allSections: { id: string; pageId: string; name: string; layoutId?: string }[]`; `GET /editor` = `{ revision, canUndo, canRedo, interactives, shot, ...CanvasPayload, assets }` (không còn trường GrapesJS).

- [ ] **Step 1: Viết test đỏ**

`tests/unit/editor-api.test.ts`: xoá import `saveRoute`, `promoteRoute`; xoá các test `"Lưu (legacy save URL)…"`, `"Lưu whose materialization fails…"`, `"Lưu: a slide deleted on the canvas…"` (tính năng GrapesJS); đổi test `"Gộp layout (legacy promote URL)…"` thành:

```ts
test("Gộp layout is the promoteLayout command through the commands route: stale -> 409, invalid -> 400; the old save / promote-layout URLs are gone", async () => {
  const id = await seed();
  const stale = await post(commandsRoute, id, { baseRevision: 5, commands: [{ op: "promoteLayout", sectionIds: ["a", "b"] }] });
  expect([stale.status, await stale.json()]).toEqual([409, expect.objectContaining({ code: "STALE_REVISION", revision: 0 })]);
  const invalid = await post(commandsRoute, id, { baseRevision: 0, commands: [{ op: "promoteLayout", sectionIds: ["a", "b"] }] });
  expect([invalid.status, (await invalid.json()).code]).toEqual([400, "IR_PATCH_INVALID"]);
  expect((await projectDocuments(getDb()).historyState(id)).revision).toBe(0);
  const { existsSync } = await import("node:fs");
  expect(existsSync("src/app/api/projects/[id]/editor/save/route.ts") || existsSync("src/app/api/projects/[id]/editor/promote-layout/route.ts")).toBe(false);
});

test("deleting a carousel slide through commands is refused naming the role and the panel action; nothing committed", async () => {
  const slides = ["A", "B", "C"].map((t) => el("div", [el("#text", [], t)]));
  const id = await seed(el("html", [el("head"), el("body", [el("header", [el("#text", [], "Top")]), el("main", [el("section", [el("div", [el("div", slides)])])])])]));
  const doc = await projectDocuments(getDb()).loadDocument(id);
  type N = IRV2["sections"][number]["root"];
  const walkN = (x: N): N[] => [x, ...x.children.flatMap(walkN)];
  const all = doc.sections.flatMap((s) => walkN(s.root));
  const slideNode = all.find((x) => x.children[0]?.text === "A")!;
  const track = all.find((x) => x.children.includes(slideNode))!;
  const viewport = all.find((x) => x.children.includes(track))!;
  const root = all.find((x) => x.children.includes(viewport))!;
  expect((await post(commandsRoute, id, { baseRevision: doc.revision, commands: [{ op: "convertToComponent", id: root.id, kind: "carousel", roles: { viewport: viewport.id, track: track.id, slides: track.children.map((c) => c.id) } }] })).status).toBe(200);
  const res = await post(commandsRoute, id, { baseRevision: doc.revision + 1, commands: [{ op: "deleteNode", id: slideNode.id }] });
  const body = (await res.json()) as { code: string; message: string };
  expect([res.status, body.code]).toEqual([400, "IR_PATCH_INVALID"]);
  expect(body.message).toContain(`slide ${slideNode.id} thuộc carousel ${root.id} — dùng nút Xoá trong panel Component hoặc Bỏ hành vi`);
  expect((await projectDocuments(getDb()).historyState(id)).revision).toBe(doc.revision + 1);
});
```

Test `"GET editor: the page's components …"`: đổi `res.pageId` → `res.page.id` (type `{ interactives: unknown[]; shot: string; page: { id: string } }`). Test GET E3a (Task 4 E3a) đổi dòng cuối `expect(Array.isArray(data.components)).toBe(true)` thành:

```ts
  expect(data).not.toHaveProperty("components"); // GrapesJS payload gone (E3b R15)
  expect((data as unknown as { allSections: { id: string; pageId: string }[] }).allSections.length).toBeGreaterThan(0);
```

`tests/unit/emit-components.test.ts`: bỏ import `grapes-adapter`; thêm `import { canvasPayload } from "@/core/editor-canvas";` và helper `const canvasHtml = (ir: IRV2) => canvasPayload(ir, "p1", opts, () => ({ base: "http://127.0.0.1/out/index.html", runtime: "http://127.0.0.1/out/js/runtime.js?edit=1" })).page.html;`; test `"canvas: data-c* attributes shown, clone hidden, an untouched save diffs to no command"` thành:

```ts
test("canvas: the editor frame carries the data-c* attributes the edit-mode runtime reads; the loop clone is not in it", () => {
  const html = canvasHtml(site());
  expect(html).toMatch(/<section[^>]*data-c="carousel"/);
  expect(html.match(/data-c-role="slide"/g)).toHaveLength(2);
  expect(html).not.toContain('data-ir-id="clone"');
});
```

và test video `"canvas shows the spec's video flags …"`:

```ts
  const html = canvasHtml(ir);
  const video = /<video[^>]*data-ir-id="v"[^>]*>/.exec(html)![0];
  expect(video).toContain('autoplay=""');
  expect(video).toContain('muted=""');
  expect(video).toContain('playsinline=""');
  expect(video).not.toMatch(/\scontrols|\sloop/);
  expect(html).toContain('src="https://www.youtube-nocookie.com/embed/abc123?autoplay=1&amp;mute=1"');
```

`tests/unit/fidelity.test.ts`: xoá import `styleTargetFidelity` và test dùng nó (dòng ~150–160).

Run: `npx vitest run tests/unit/editor-api.test.ts tests/unit/emit-components.test.ts`
Expected: FAIL — `data.components` vẫn có; file route save còn.

- [ ] **Step 2: Gỡ và nối**

```bash
git rm -- src/core/grapes-adapter.ts "src/app/p/[id]/editor/editor-view.tsx" "src/app/api/projects/[id]/editor/save/route.ts" "src/app/api/projects/[id]/editor/promote-layout/route.ts" tests/unit/grapes-adapter.test.ts tests/e2e/grapes-textnode.test.ts
npm uninstall grapesjs
```

`editor-canvas.ts`: `CanvasPayload` thêm `allSections`; trong `canvasPayload` thêm `allSections: doc.sections.map((s) => ({ id: s.id, pageId: s.pageId, name: s.name, ...(s.layoutId !== undefined && { layoutId: s.layoutId }) })),`.

`editor/route.ts`: bỏ import/spread `irToGrapes`; comment đầu hàm: "One page of the document for the visual editor (E3 §5): the canvas payload, the Component panel's view, the 1440 shot, the asset library, the revision and the Undo/Redo flags.".

`fidelity.ts`: xoá `styleTargetFidelity` và comment của nó.

`page.tsx`: bỏ `legacy` và `EditorView`; luôn `<VisualEditor …/>` (`?legacy=1` bị bỏ qua — vẫn mở editor mới).

`visual-editor.tsx`: xoá link "Editor cũ"; ở cuối tab Layers (dưới `LayerTree`) thêm card Section:

```tsx
          {left === "layers" && data && (
            <Card title="Section" variant="section" data-ui="ui_editor_sections_panel">
              <p className="t-body-sm text-2">Chọn section ở các trang khác nhau; section chọn đầu tiên thành layout chung.</p>
              <ul className="editor-sections">
                {data.allSections.map((s) => (
                  <li key={s.id}>
                    <label className="check">
                      <input type="checkbox" checked={picked.includes(s.id)} onChange={() => setPicked((p) => (p.includes(s.id) ? p.filter((x) => x !== s.id) : [...p, s.id]))} />
                      <span className="mono">{s.name}</span> <span className="text-3">{data.pages.find((p) => p.id === s.pageId)?.path}</span>
                      {s.layoutId && <Badge tone="primary">Layout chung</Badge>}
                    </label>
                  </li>
                ))}
              </ul>
              <Button onClick={() => { if (commands([{ op: "promoteLayout", sectionIds: picked }], "Gộp layout", { done: "Đã gộp thành layout chung" })) setPicked([]); }} disabled={picked.length < 2 || pending > 0}>Gộp thành layout</Button>
            </Card>
          )}
```

(`const [picked, setPicked] = useState<string[]>([]);`; import `Card`, `Badge`.)

`globals.css`: xoá `.editor-grid`, `@media … .editor-grid`, `.editor-rail`, `.editor-shell` và mọi `.editor-shell .gjs-*` (giữ `.editor-toolbar`, `.editor-sections`, `.cmp-*`).

`stitch-screens.md`: tiêu đề mục editor đổi thành "visual editor E3, không có mockup Stitch (chỉ token + chrome)"; xoá dòng `ui_editor_legacy_link`; `ui_editor_canvas_chrome` bỏ chữ GrapesJS; `ui_editor_sections_panel` API → `promoteLayout` qua `POST …/editor/commands`, vị trí: cuối tab Layers.

- [ ] **Step 3: Chuyển e2e**

`tests/e2e/visual-editor.test.ts` (E3a Task 8): xoá đoạn "Editor cũ"/"Editor mới" và `ui_editor_legacy_link` khỏi `expectUi`; thêm: `await page.goto(`${app!.base}/p/${projectId}/editor?legacy=1`); await canvas(page).locator("h1").waitFor({ timeout: 30_000 });` (URL cũ vẫn ra editor mới).

`tests/e2e/editor-components.test.ts`: `?legacy=1` → bỏ; `iframe.gjs-frame` → `[data-ui="ui_editor_canvas_frame"]` (3 chỗ: `shownSlide`, `canvas`, `plain`); ngay sau mỗi `page.goto(...)` thêm `await page.getByRole("tab", { name: "Component" }).click();`. Các chuỗi trạng thái ("Đã cập nhật component — …", "Đã hoàn tác — …", "Đã làm lại — …") và khoá `.cmp-fieldset` ([true, false]) giữ nguyên — editor mới phát đúng các chuỗi đó (R17 E3a).

`tests/e2e/editor-smoke.test.ts`:
- Test `"editor: edit one heading in the canvas, save -> …"` thay thân (từ sau `page.waitForURL(/\/editor$/)`, bỏ dòng `goto ?legacy=1`) bằng:

```ts
  const canvasFrame = page.frameLocator('[data-ui="ui_editor_canvas_frame"]');
  const heading = canvasFrame.locator("h1");
  await expect.poll(() => heading.innerText(), { timeout: 30_000 }).toBe("Build faster sites");
  expect(await heading.evaluate(() => document.baseURI)).toBe(`${base}/api/projects/${projectId}/files/out/index.html`);
  const status = page.getByRole("status");
  const outHtml = async () => (await fetch(`${base}/api/projects/${projectId}/files/out/index.html`)).text();
  await heading.dblclick();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Edited headline");
  await page.keyboard.press("Enter");
  await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe("Đã lưu — điểm QA cần chạy lại");
  expect(await page.getByRole("link", { name: "Mở Preview" }).getAttribute("href")).toBe(`/p/${projectId}/preview`);
  expect(await outHtml()).toMatch(/<h1[^>]*>Edited headline<\/h1>/);
  expect(await outHtml()).not.toContain("Build faster sites");
  const preview = (await (await fetch(`${base}/api/projects/${projectId}/preview`)).json()) as { stale: boolean; scores: unknown[] };
  expect(preview.stale).toBe(true);
  expect(preview.scores.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Hoàn tác" }).click();
  await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe("Đã hoàn tác — điểm QA cần chạy lại");
  await expect.poll(() => heading.innerText(), { timeout: 30_000 }).toBe("Build faster sites");
  expect(await outHtml()).toContain("Build faster sites");
  await expect.poll(() => page.getByRole("button", { name: "Làm lại" }).isEnabled(), { timeout: 30_000 }).toBe(true);
  await page.getByRole("button", { name: "Làm lại" }).click();
  await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe("Đã làm lại — điểm QA cần chạy lại");
  await expect.poll(() => heading.innerText(), { timeout: 30_000 }).toBe("Edited headline");
  // another tab commits first: this tab's edit gets 409 and asks for a reload, nothing is overwritten
  const { revision } = (await (await fetch(`${base}/api/projects/${projectId}/editor`)).json()) as { revision: number };
  const irId = (await heading.getAttribute("data-ir-id"))!;
  const other = await fetch(`${base}/api/projects/${projectId}/editor/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: revision, commands: [{ op: "setAttribute", id: irId, name: "title", value: "other tab" }] }) });
  expect(other.status).toBe(200);
  await heading.dblclick();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Lost update");
  await page.keyboard.press("Enter");
  await expect.poll(() => status.innerText(), { timeout: 30_000 }).toBe(`Dự án đã thay đổi ở nơi khác (revision ${revision + 1}). Tải lại để tiếp tục.`);
  expect(await outHtml()).not.toContain("Lost update");
  expect(await outHtml()).toContain('title="other tab"');
  await page.getByRole("button", { name: "Tải lại" }).click();
  await expect.poll(() => heading.getAttribute("title"), { timeout: 30_000 }).toBe("other tab");
  expect(await heading.innerText()).toBe("Edited headline");
  expect(await page.getByRole("button", { name: "Tải lại" }).count()).toBe(0);
  // Esc leaves an inline edit without a request
  const rev = ((await (await fetch(`${base}/api/projects/${projectId}/editor`)).json()) as { revision: number }).revision;
  await heading.dblclick();
  await page.keyboard.type(" unsaved");
  await page.keyboard.press("Escape");
  expect(await heading.innerText()).toBe("Edited headline");
  expect(((await (await fetch(`${base}/api/projects/${projectId}/editor`)).json()) as { revision: number }).revision).toBe(rev);
  await page.close();
```

  (tên test đổi thành `"editor: edit one heading inline (one setText), out/index.html has the new text; server Undo/Redo; a stale tab is told to reload; Esc cancels"`).
- Test `"editor: ?page= …"`: bỏ `&legacy=1`; `expectUi` thành `["ui_editor_page_header", "ui_editor_toolbar", "ui_editor_canvas_chrome", "ui_editor_canvas_frame", "ui_editor_sections_panel"]`; xoá các assertion `.gjs-one-bg`, `gjsButtons`, `.gjs-pn-devices-c`; tên test bỏ "+ GrapesJS on the tokens".
- Test `"editor API: recovery …"`: ba dòng `post("save", …)` / `post("promote-layout", …)` thay bằng

```ts
  expect((await post("commands", { baseRevision: revision, commands: [{ op: "promoteLayout", sectionIds: ["x"] }] })).status).toBe(400);
  expect((await post("commands", { commands: [{ op: "promoteLayout", sectionIds: ["x"] }] })).status).toBe(400); // no baseRevision
  expect((await post("save", { baseRevision: revision, pageId: "nope", project: { components: [] } })).status).toBe(404); // GrapesJS save is gone
```

- Test `"recovery (fix round 1 review): editor save …"`: thân `try` (tới hết assertion `fixTask`/`stillOpen`) thay phần GrapesJS bằng một lệnh qua commands (bỏ phần style-target Fidelity — tính năng đó đi cùng route save):

```ts
    type Tree = { id: string; tag: string; text?: string; children: Tree[] };
    const walkT = (x: Tree): Tree[] => [x, ...x.children.flatMap(walkT)];
    const data = (await (await fetch(`${base}/api/projects/${projectId}/editor?page=${pageId}`)).json()) as { revision: number; page: { sections: { root: Tree }[] } };
    const text = data.page.sections.flatMap((s) => walkT(s.root)).find((x) => x.tag === "#text" && x.text?.trim() && !x.id.startsWith("instance:"))!;
    const res = await fetch(`${base}/api/projects/${projectId}/editor/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: data.revision, pageId, commands: [{ op: "setText", id: text.id, text: "Sửa tay" }] }) });
    expect(res.status).toBe(200);
```

  (giữ nguyên các assertion `fixTask` và `stillOpen` cùng khối `finally`; tên test đổi "editor save" → "an editor edit").
- Comment đầu file `editor-smoke.test.ts` / `editor-components.test.ts` đổi "the real GrapesJS editor" / "the GrapesJS editor" thành "the visual editor"; comment dòng ~65 của `editor-components.test.ts` bỏ cụm "(GrapesJS' own Style Manager buttons are not ours)". `src/app/p/[id]/editor/component-panel/component-panel.tsx` dòng comment đầu đổi "(no GrapesJS import); E3 reuses it as is" thành "; the visual editor (E3) uses it as is".
- Test `"v1 → v2 …"`: `?legacy=1` bỏ; `page.frameLocator("iframe.gjs-frame")` → `page.frameLocator('[data-ui="ui_editor_canvas_frame"]')`; đoạn Lưu thay bằng `heading.dblclick()` + Ctrl+A + gõ + `Enter`, status mong `"Đã lưu — điểm QA cần chạy lại"`; phần còn lại giữ nguyên (docRow revision 3 / cursor 1 vẫn đúng: sửa = 1, Hoàn tác = 2, Làm lại = 3).

- [ ] **Step 4: Chạy test, xác nhận xanh**

Run: `npm run typecheck && npx vitest run && npm run build && npx vitest run -c vitest.e2e.config.ts tests/e2e/editor-smoke.test.ts tests/e2e/editor-components.test.ts tests/e2e/visual-editor.test.ts tests/e2e/visual-editor-advanced.test.ts`
Expected: PASS; `grep -rniI "grapes" src tests` không còn kết quả.

- [ ] **Step 5: Commit** (`git rm` ở Step 2 đã stage các file xoá)

```bash
git add -- "src/app/api/projects/[id]/editor/route.ts" src/core/editor-canvas.ts src/core/fidelity.ts "src/app/p/[id]/editor/page.tsx" "src/app/p/[id]/editor/visual/visual-editor.tsx" "src/app/p/[id]/editor/component-panel/component-panel.tsx" src/app/globals.css package.json package-lock.json docs/superpowers/design/stitch-screens.md tests/unit/editor-api.test.ts tests/unit/emit-components.test.ts tests/unit/fidelity.test.ts tests/e2e/editor-smoke.test.ts tests/e2e/editor-components.test.ts tests/e2e/visual-editor.test.ts
git commit -m "feat(e3b): layout merge as promoteLayout in the new editor; remove GrapesJS, its adapter and the save/promote routes

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Drawer ở 768, chỉ xem ở 375

**Files:**
- Modify: `src/app/p/[id]/editor/visual/visual-editor.tsx`, `src/app/globals.css`, `docs/superpowers/design/stitch-screens.md`
- Test: `tests/e2e/visual-editor-advanced.test.ts` (append)

**Interfaces:**
- Consumes: mọi đường sửa của `VisualEditor` (`run`, `startEdit`, `onPress`, handles).
- Produces: `const editable: boolean` (false khi `max-width: 767.98px`); hai drawer `ve-left`/`ve-right` có `is-open`.

- [ ] **Step 1: Viết e2e đỏ** — append:

```ts
test("E3b responsive: no sideways scroll at 1440; at 768 the panels are drawers opened from the toolbar; at 375 view and select only, with the notice", { timeout: 180_000 }, async () => {
  const page = await open(1440, 900);
  expect(await noSideScroll(page)).toBe(true);
  await page.setViewportSize({ width: 768, height: 900 });
  expect(await noSideScroll(page)).toBe(true);
  const leftPanel = page.locator(".ve-left");
  expect(await leftPanel.isVisible()).toBe(false);
  await page.getByRole("button", { name: "Mở Layers" }).click();
  await expect.poll(() => leftPanel.isVisible()).toBe(true);
  await page.getByRole("button", { name: "Đóng Layers" }).click();
  await page.getByRole("button", { name: "Mở bảng Style" }).click();
  await expect.poll(() => page.locator(".ve-right").isVisible()).toBe(true);
  await page.getByRole("button", { name: "Đóng bảng Style" }).click();
  await page.setViewportSize({ width: 375, height: 800 });
  await expect.poll(() => page.locator('[data-ui="ui_editor_viewonly_notice"]').innerText()).toContain("Dùng màn hình ≥ 768px để chỉnh sửa");
  expect(await noSideScroll(page)).toBe(true);
  const h1 = canvas(page).locator("h1");
  await h1.click();
  await expect.poll(() => page.locator('[data-ui="ui_editor_selection_box"]').first().getAttribute("data-for")).toBe(await h1.getAttribute("data-ir-id"));
  const rev = (await payload()).revision;
  await page.keyboard.press("Delete");
  await h1.dblclick();
  expect(await h1.evaluate((el) => (el as HTMLElement).isContentEditable)).toBe(false);
  await page.waitForTimeout(500);
  expect((await payload()).revision).toBe(rev);
  expect(await page.locator('[data-ui="ui_editor_resize_handle"]').count()).toBe(0);
  await page.close();
});
```

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts -t "responsive"`
Expected: FAIL — không có nút "Mở Layers".

- [ ] **Step 2: Cài đặt** — `visual-editor.tsx`:

```tsx
// a media query as state (client only: false on the server render)
function useMedia(query: string): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const m = window.matchMedia(query);
    const sync = () => setOn(m.matches);
    sync();
    m.addEventListener("change", sync);
    return () => m.removeEventListener("change", sync);
  }, [query]);
  return on;
}
// trong VisualEditor:
  const viewOnly = useMedia("(max-width: 767.98px)"); // R9
  const editable = !viewOnly;
  const [drawer, setDrawer] = useState<"left" | "right" | null>(null);
```

- `run`: `if (!editable) { setMsg("Dùng màn hình ≥ 768px để chỉnh sửa"); return false; }` ở đầu (Undo/Redo cũng qua `run`).
- `startEdit`: `if (!live.current.editable) return true;` ở đầu (thêm `editable` vào `live.current`).
- `onPress`: `if (!live.current.editable) return;` ở đầu (chọn vẫn chạy qua `onPick`).
- `handles={… && editable ? … : undefined}` (Task 9 đã có điều kiện `editable`).
- Toolbar thêm (trước link "Mở Preview"):

```tsx
        <span className="ve-drawer-toggle" data-ui="ui_editor_drawer_toggle">
          <IconButton icon="layers" label={drawer === "left" ? "Đóng Layers" : "Mở Layers"} pressed={drawer === "left"} onClick={() => setDrawer((d) => (d === "left" ? null : "left"))} />
          {editable && <IconButton icon="edit" label={drawer === "right" ? "Đóng bảng Style" : "Mở bảng Style"} pressed={drawer === "right"} onClick={() => setDrawer((d) => (d === "right" ? null : "right"))} />}
        </span>
```

- Sau toolbar: `{viewOnly && <Banner tone="info" icon="phone_iphone" data-ui="ui_editor_viewonly_notice" title="Dùng màn hình ≥ 768px để chỉnh sửa">Ở màn hình này chỉ xem và chọn phần tử.</Banner>}`
- `<aside className={`ve-left panel${drawer === "left" ? " is-open" : ""}`} …>`; `<aside className={`ve-right panel${drawer === "right" ? " is-open" : ""}`} …>` và chỉ render nội dung bảng phải khi `editable`; ở chế độ chỉ xem, tab Thêm bị ẩn (`options` chỉ còn Layers).

`globals.css` — thay khối `@media (max-width: 1099px)` của `.ve-grid` (E3a) bằng:

```css
.ve-drawer-toggle { display: none; gap: 2px; }
@media (max-width: 1099px) {
  .ve-grid { grid-template-columns: minmax(0, 1fr); }
  .ve-drawer-toggle { display: inline-flex; }
  .ve-left, .ve-right { position: fixed; top: var(--shell-pad-top); bottom: 0; width: min(320px, 85vw); z-index: 40; background: var(--c-surface-low); visibility: hidden; transition: transform 0.15s, visibility 0.15s; }
  .ve-left { left: 0; transform: translateX(-100%); }
  .ve-right { right: 0; transform: translateX(100%); }
  .ve-left.is-open, .ve-right.is-open { visibility: visible; transform: none; box-shadow: 0 0 24px rgb(0 0 0 / 0.5); }
}
@media (prefers-reduced-motion: reduce) { .ve-left, .ve-right { transition: none; } }
```

`stitch-screens.md`: `ui_editor_drawer_toggle` ("E3 §4 ≤ 1099px: nút mở drawer Layers / Style"), `ui_editor_viewonly_notice` ("E3 §4 < 768px: chỉ xem và chọn — 'Dùng màn hình ≥ 768px để chỉnh sửa'").

- [ ] **Step 3: Chạy test, xác nhận xanh**

Run: `npm run typecheck && npx vitest run -c vitest.e2e.config.ts tests/e2e/visual-editor-advanced.test.ts tests/e2e/editor-smoke.test.ts`
Expected: PASS (test `?page=` của editor-smoke kiểm thêm không cuộn ngang ở 768).

- [ ] **Step 4: Commit**

```bash
git add -- "src/app/p/[id]/editor/visual/visual-editor.tsx" src/app/globals.css docs/superpowers/design/stitch-screens.md tests/e2e/visual-editor-advanced.test.ts
git commit -m "feat(e3b): panels become drawers up to 1099px; below 768px the editor is view-and-select only

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Rulings E3b vào spec, graph, kiểm toàn bộ

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-e3-visual-editor-design.md` (§12), `docs/superpowers/design/stitch-screens.md` (errata icon), `graphify-out/*`
- Test: toàn bộ

**Interfaces:**
- Consumes: mọi task.
- Produces: spec + graph khớp code E3 hoàn chỉnh.

- [ ] **Step 1: §12 spec** — append:

```markdown
## 12. Rulings khi triển khai E3b (2026-10-07)

Từ plan `docs/superpowers/plans/2026-10-07-e3b-visual-editor-advanced.md` (R1–R15):
- `moveNode` được chuyển giữa hai section và giữ ID (ghi đè luật ranh giới section của E1 §2; shell/main giữ nguyên).
- Trong một batch, `convertToComponent` gọi node vừa tạo bằng `new:<k>/<path>`; mẫu component = một bước Undo.
- Gộp Undo 1,5 s: client gửi `coalesce` khi cùng ô được đẩy lại trong 1,5 s (cửa sổ trượt) và revision chưa đổi; server thay bước mới nhất chỉ khi cùng tập (id, target, prop) và không có nhánh Redo.
- 375 kế thừa thẳng Desktop; trạng thái :hover/:focus/:active áp mọi breakpoint.
- Alt+kéo: top/left theo padding box của cha trực tiếp (cha static → relative), khoá width; snap 4 px màn hình.
- "Section trống" là `<section>` bên trong section hiện tại (Command API không tạo IR section).
- Zoom theo mốc 25/33/50/67/75/100/125/150/200 %, Ctrl+lăn ×1,1; drawer ≤ 1099px; chỉ xem < 768px.
- GrapesJS, `grapes-adapter`, route `editor/save` và `editor/promote-layout` đã gỡ; "Gộp thành layout" là `promoteLayout` từ card Section.
```

`stitch-screens.md` Errata: **E3b icons** `zoom_in`, `zoom_out`, `fit_screen`, `text_fields`, `text_snippet`, `add_box`, `view_week`, `view_agenda`, `grid_view`, `view_carousel`, `tab`, `expand_circle_down`, `web_asset` (83 → 96).

- [ ] **Step 2: Graph**

Run: `/graphify docs --update`
Expected: các `ui_editor_*` E3b gắn `screen_editor`; không còn node/edge nào trỏ `grapes-adapter`.

- [ ] **Step 3: Kiểm toàn bộ**

Run: `npm run typecheck && npx vitest run && npm run build && npx vitest run -c vitest.e2e.config.ts`
Expected: tất cả PASS (gồm `qa-baseline`, `ui-smoke`, `editor-smoke`, `editor-components`, `visual-editor`, `visual-editor-perf`, `visual-editor-advanced`).

- [ ] **Step 4: Commit**

```bash
git add -- docs/superpowers/specs/2026-10-07-e3-visual-editor-design.md docs/superpowers/design/stitch-screens.md graphify-out
git commit -m "docs(e3b): E3b rulings in the spec, icon errata, graph refreshed

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

1. **Spec coverage (E3b):** §3 Style Manager (6 nhóm, nguồn, ↺, state, Thuộc tính khác, isSafeCss, lạc quan + 300 ms + 1,5 s) — Task 3, 4, 5; Kéo theo luồng + vạch chèn + ID giữ qua section + cấm (shell/instance/vai trò, đỏ + lý do) — Task 1, 7 (guard của E3a Task 5); Alt+kéo absolute + cha relative + bp + một batch — Task 6, 8; Resize 8 handle, Shift, trên/trái chỉ absolute, padding/gap — Task 6, 9; Chèn phần tử (danh sách đủ 16, component mẫu, kéo/click, tiếng Việt, không class) — Task 2, 11; Snap 4 px + guide, Alt đo — Task 8; Zoom 25–200 %, Ctrl+lăn/Ctrl±, Vừa khung, Space+kéo, `scale()`, overlay quy đổi — Task 6, 10; Gỡ GrapesJS + `promoteLayout` — Task 12. §4 drawer 768 / chỉ xem 375 / không cuộn ngang 1440 — Task 13. §6 debounce/gộp/zoom — Task 3, 5, 6. §9 unit: kéo → moveNode (E3a T5 + T1), Alt → setStyle absolute + relative (T6), resize theo bp (T6), snap thuần (T8), nguồn giá trị (T4); e2e: kéo sang section giữ ID (T7), Alt+kéo absolute (T8), resize 768 không ảnh hưởng 1440 (T9), Style Manager kế thừa (T5), chèn Flex/Carousel (T11), zoom 50 % chọn đúng (T10), một lần sửa style chỉ thay một section (T5: 2 bước = 2 lần thay), drawer 768 (T13).
2. **Placeholder scan:** đã thay các dòng chỉ dẫn dạng comment ở Task 3 (bus) và Task 10 (`onKey`, pan) bằng code đầy đủ; Task 11 kéo mẫu có ngưỡng 4 px để click vẫn chèn; khối `catch` của bus ghi rõ là bốn nhánh E3a giữ nguyên. Không còn "tương tự Task N".
3. **Type consistency:** `Gesture` mở rộng dần: Flow (T7) → Free (T8) → Resize/Spacing (T9) → Pan (T10) → Insert (T11), cùng `gestureMove`/`gestureUp`; `Drop` dùng chung T7/T11; `Op.coalesceKey` (T3) ↔ `StylePanel.onBatch extra` (T5) ↔ `batch(b, label, extra)` (E3a T8 `Partial<CommandsOp>`); `CanvasHandle` thêm `toDoc`, `hit` (T7), `pane` (T10) — dùng đúng tên ở T8–T11; `CanvasPayload.allSections` (T12) ↔ card Section; `KeyAction` thêm zoom (T6) ↔ `onKey` (T10).
4. **Review Focus:** (1) T7 e2e vạch đỏ + revision không đổi (+ guard unit E3a T5); (2) T4 unit `setField` chuỗi phá rule + T5 e2e lỗi tại ô, không gửi; (3) T3 unit store (ô khác, nhánh Redo, batch không phải style) + bus (key khác, > 1,5 s, Undo chen giữa); (4) T10 e2e chọn ở 50 % khớp khung (resize ở 50 % dùng cùng `toDoc` ÷ zoom); (5) T12 unit URL cũ không còn + `?legacy=1` mở editor mới (e2e) + `promoteLayout` qua commands.
