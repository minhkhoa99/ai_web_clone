# E1 Document Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nâng IR tại chỗ lên v2 để editor và AI dùng chung command, History server và báo cáo Fidelity.

**Architecture:** Giữ IR v1 chỉ như input chuyển đổi trong giai đoạn chuyển tiếp. IR v2 là document được lưu; lõi command và component resolver thuần, SQLite lưu snapshot hiện tại cùng 500 bước History, `ir.json`/`out/` là bản materialize có thể khôi phục. GrapesJS tạm dịch thay đổi sang command; E3 thay UI mà không đổi backend.

**Tech Stack:** TypeScript, Next.js 16 App Router, React 19, `node:sqlite`, Zod, GrapesJS 0.23, Vitest, Playwright. Không thêm dependency.

**Spec:** `docs/superpowers/specs/2026-09-27-e1-document-model-design.md` (đã duyệt 2026-09-27).

## Global Constraints

- Branch `sp1-clone-engine`. Không push/merge. Chỉ stage file của task; không commit `passcaptchar/`, `rules.md`, `next-env.d.ts`, `.playwright-mcp/`. Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- E1 là phần mở rộng SP1 đã duyệt, không phải SP2/SP3. Không xây carousel runtime, visual canvas mới hoặc AI chat trong plan này. Không xử lý CAPTCHA tự động, stealth, anti-bot bypass hoặc `drift_*`.
- 3 breakpoint cố định 1440/768/375. Tablet/mobile kế thừa base. `core/` không import `app/`. Không lưu GrapesJS JSON làm document.
- Tối đa 50 commands/batch, 500 node/subtree, 20 tầng/subtree, 8 MB/history step, 500 bước/project. Validation trả lỗi, không cắt input ngầm.
- Job active/queued chặn edit/Undo/Redo. Ghi file tmp→rename; giữ snapshot SQLite đủ để repair. Secret không vào log, graph, Fidelity hoặc request AI.
- `graphify explain feat_editor` đã kiểm tra. Sau thay đổi spec/plan chạy `graphify docs --update`; hiện CLI cần API key cho docs. Không sửa tay `graphify-out/graph.json` để giả kết quả extraction.
- Mỗi task: test đỏ → code tối thiểu → test xanh → review diff → commit riêng với trailer trên. Không dùng `git add -A`. Các đoạn code bên dưới là điểm neo và assertion cần có; giữ thêm edge case trong cùng test file của task.

## Review Focus

1. Capture cũ thiếu hoặc lệch breakpoint: migration giữ style có thể xác định, bỏ `box` thiếu và ghi Fidelity thay vì đoán (Task 2).
2. Reorder trong cùng parent: ID giữ nguyên, index tính sau khi nhấc node và inverse trả đúng thứ tự (Task 5).
3. Hai tab cùng revision và Undo lúc job queued: chỉ một thao tác được commit, thao tác còn lại nhận 409 có revision hiện tại (Task 8).
4. Main đổi property khi instance có override, hoặc xóa node main đang được override: property không override lan xuống; xóa xung đột bị từ chối (Task 3/6).
5. Crash sau SQLite commit trước khi emit xong: preview và file route không phục vụ bản `out/` dở; lần đọc sau repair từ snapshot (Task 7/8).

## File map và interfaces

| File | Trách nhiệm |
|---|---|
| `src/core/ir-legacy.ts` (mới), `ir-v2.ts` (mới), `ir-migrate.ts` (mới) | Type v1 riêng cho migration; type IR v2, `toV2(legacy, captures)`, validate/migrate. |
| `src/core/ir-component.ts` (mới) | Nâng nhóm lặp cũ lên main/instance, `resolveComponents(ir)`, override/reset/detach thuần. |
| `src/core/ir-command.ts` (mới) | Command union, cấp ID cho command ở server, limits, `applyCommands(ir, commands)` và inverse. |
| `src/core/ir-store.ts` (mới) | SQLite snapshot/history/cursor, materialization và recovery; I/O không nằm trong command core. |
| `src/core/fidelity.ts` (mới) | Suy Fidelity từ capture inventory + IR, giữ sourceRef sau edit. |
| `src/core/ir.ts`, `ir-build.ts`, `dedupe.ts`, `emit-html.ts` | Tích hợp v2 vào builder/emitter; v1 chỉ là conversion input. |
| `src/core/db.ts`, `jobs.ts`, `qa-fix.ts`, `grapes-adapter.ts`, `graph.ts` | Lưu document, chuyển các đường sửa cũ sang command, giữ pipeline. |
| `src/core/capture.ts`, `capture-eval.ts` | Inventory script/iframe/canvas và tình trạng capture, không giữ script text. |
| `src/app/api/projects/[id]/editor/**`, `preview/route.ts`, `files/[...path]/route.ts`, `src/app/_server/http.ts` | API revision/command/history, stale 409, gate output đang repair. |
| `src/app/p/[id]/editor/editor-view.tsx`, `preview/preview-view.tsx`, `preview/preview-model.ts`, `src/app/globals.css` | Save/Undo/Redo server, báo cáo Fidelity. |
| `tests/unit/*`, `tests/e2e/*` | Fixture migration, command/inverse, History/recovery, render/QA/UI. |

`IRV2` được export từ `ir-v2.ts` trong giai đoạn chuyển tiếp; Task 13 đổi `IR` public trong `ir.ts` thành alias của IRV2 và loại `cls[]` khỏi document đã lưu. `prepareCommands(ir, commands, allocateId)` cấp ID cho cây mới; `applyCommands` chỉ nhận command đã chuẩn hóa hoặc inverse nội bộ để luôn thuần. `DocumentStore` nhận callback materialize, không import app. Các task sau dùng đúng những interface này.

---

### Task 1: IR v2 type và style conversion

**Files:** Create `src/core/ir-legacy.ts`, `src/core/ir-v2.ts`; modify `src/core/ir.ts`, `src/core/ir-build.ts`; test `tests/unit/ir-v2.test.ts`.

**Interfaces:** `LegacyIR`/`LegacyIRNode` chuyển từ type hiện có trong `ir.ts` sang `ir-legacy.ts`; `IRV2`, `IRNodeV2`, `NodeStyles`, `toV2(legacy: LegacyIR, captures: PageCapture[]): IRV2`. ID v1 được giữ nguyên như seed định danh; lệnh move về sau không tái tính ID. `type` suy từ tag bằng bảng đóng; `box` chỉ lấy khi capture có node cùng path/tag.

- [ ] **Step 1: Viết test đỏ** với một v1 fixture có `.cls[0]`, hover class, media 768/375, pseudo và text. Assertion chính:

  ```ts
  const v2 = toV2(buildIR([capture]), [capture]);
  expect(v2.version).toBe(2);
  expect(v2.sections[0]!.root.styles.bp[768]?.color).toBe("red");
  expect(v2.sections[0]!.root.children[0]!.parentId).toBe(v2.sections[0]!.root.id);
  expect(v2.sections[0]!.root.id).toBe(buildIR([capture]).sections[0]!.root.id);
  ```

- [ ] **Step 2: Chạy** `npx vitest run tests/unit/ir-v2.test.ts`; kỳ vọng FAIL vì `toV2` chưa tồn tại.
- [ ] **Step 3: Tạo type và conversion**. Resolve từng class theo thứ tự `cls[]`; lỗi nếu class thiếu. `states` trỏ đến style set cũ được đưa vào `styles.state`; `media` và `before/after` sang các nhánh tương ứng. Duyệt cây một lần để gán parent và box. Dùng `Map<oldId,CaptureNode>` theo path, không tìm capture bằng N×M scan.

  ```ts
  export type NodeStyles = { base: Decl; bp: Partial<Record<768 | 375, Decl>>; state: Partial<Record<"hover" | "focus" | "active", Decl>>; pseudo: Partial<Record<"before" | "after", Decl>> };
  export type FidelityItem = { pageId: string; feature: string; status: "supported" | "partial" | "unsupported"; nodeId?: string; breakpoint?: 1440 | 768 | 375; sourceRef?: string; note: string };
  const classOf = (legacy: LegacyIR, name: string): StyleSet => {
    const style = legacy.classes[name];
    if (!style) throw new AppError(Codes.IR_PATCH_INVALID, `missing class: ${name}`);
    return style;
  };
  const baseOf = (legacy: LegacyIR, node: LegacyIRNode): Decl =>
    Object.assign({}, ...node.cls.map((name) => classOf(legacy, name).base));
  ```

- [ ] **Step 4: Chạy** `npx vitest run tests/unit/ir-v2.test.ts tests/unit/ir.test.ts`; kỳ vọng PASS. Không đổi output v1 ở task này.
- [ ] **Step 5: Commit** chỉ các file của task bằng `git add -- <paths>` rồi `git commit` với trailer bắt buộc.

### Task 2: Migration thuần và dữ liệu capture thiếu

**Files:** Modify `src/core/ir-v2.ts`; create `src/core/ir-migrate.ts`; test `tests/unit/ir-migrate.test.ts`.

**Interfaces:** `migrateIR(input: unknown, captures: PageCapture[]): IRV2`; v2 hợp lệ trả nguyên giá trị, v1 gọi `toV2`. `IR_VERSION_UNSUPPORTED`/`IR_PATCH_INVALID` dùng `AppError` ở `errors.ts` (modify file đó). Không ghi file trong hàm này.

- [ ] **Step 1: Viết test đỏ** cho migration hai lần, version >2, class thiếu, ID trùng, capture không có 375 và capture path lệch tag. Test thứ hai giữ `box` 1440/768 nhưng không bịa 375; thêm Fidelity `partial` về bằng chứng thiếu.

  ```ts
  const migrated = migrateIR(legacy, [cap1440And768]);
  expect(migrateIR(migrated, [])).toBe(migrated);
  expect(migrated.sections[0]!.root.box?.[375]).toBeUndefined();
  expect(migrated.fidelity.some((x) => x.status === "partial" && x.note.includes("capture"))).toBe(true);
  ```

- [ ] **Step 2: Chạy** `npx vitest run tests/unit/ir-migrate.test.ts`; kỳ vọng FAIL ở validation/missing capture.
- [ ] **Step 3: Thêm type guard v1/v2** và validate node count, depth, unique ID, class reference trước conversion. Bất kỳ lỗi fatal nào ném `AppError` và không mutate input. Legacy chưa có inventory để dành marker Fidelity ở Task 11.
- [ ] **Step 4: Chạy** test task và `npm run typecheck`; kỳ vọng PASS.
- [ ] **Step 5: Commit** các file của task.

### Task 3: Main/instance resolver và promotion

**Files:** Create `src/core/ir-component.ts`; modify `src/core/ir-v2.ts`, `src/core/ir-migrate.ts`; test `tests/unit/ir-component.test.ts`.

**Interfaces:** `promoteLegacyComponents(ir: IRV2, groups: LegacyComponent[]): IRV2`, `resolveComponents(ir: IRV2): IRV2`, `resetOverride(ir, instanceId, path?)`, `detachComponent(ir, instanceId)`. Main nằm trong `IRV2.components`, không phải một bản sao node trên page.

- [ ] **Step 1: Viết test đỏ**: ba card cùng structure nhưng text/colour khác nhau; promote rồi resolve phải giữ render value ban đầu. Sửa `main.styles.base.color` lan tới instance không override, không ghi đè instance có `styles.base.color` override. `children` override chặn lan thay đổi thứ tự con; Detach giữ ID và giá trị hiệu lực.

  ```ts
  const promoted = promoteLegacyComponents(v2, v1.components);
  const instance = promoted.sections[0]!.root.children[0]!;
  expect(instance.component?.role).toBe("instance");
  expect(resolveComponents(promoted).sections[0]!.root.children[0]!.text).toBe(beforeText);
  ```

- [ ] **Step 2: Chạy** `npx vitest run tests/unit/ir-component.test.ts`; kỳ vọng FAIL.
- [ ] **Step 3: Match subtree bằng position+tag một lần** khi tạo `sourceId`; nếu không chắc chắn, để nguyên node và thêm Fidelity `partial`. Resolver ghép bằng `sourceId`, dùng Set để chặn cycle; chỉ overlay path có trong override list. `resetOverride` xóa path; `detachComponent` materialize effective subtree rồi xóa component metadata. Nối `migrateIR(v1)` với `promoteLegacyComponents(v2, v1.components)`; v2 vốn có thì không promote lại.
- [ ] **Step 4: Chạy** task test và `npm run typecheck`; kỳ vọng PASS.
- [ ] **Step 5: Commit** các file của task.

### Task 4: Emit v2 với class chỉ suy ra lúc xuất

**Files:** Modify `src/core/emit-html.ts`, `src/core/dedupe.ts`; test `tests/unit/emit-v2.test.ts` và `tests/e2e/emit-render.test.ts`.

**Interfaces:** `renderSiteV2(ir: IRV2, opts: RenderOpts): Record<string,string>`, `renderStylesheetV2`, `emitSectionV2`; gọi `resolveComponents` trước khi dedupe, giữ API v1 chạy trong giai đoạn chuyển tiếp.

- [ ] **Step 1: Viết test đỏ**: cùng capture, output v1/v2 hiển thị cùng text/attribute và CSS tại 1440/768/375; override 768 rơi về base ở 375 khi thích hợp. `IRV2` không bị thêm `classes`/`cls` sau emit.

  ```ts
  const before = JSON.stringify(v2);
  const files = renderSiteV2(v2, opts);
  expect(files["css/styles.css"]).toContain("@media (max-width: 767.98px)");
  expect(JSON.stringify(v2)).toBe(before);
  ```

- [ ] **Step 2: Chạy** `npx vitest run tests/unit/emit-v2.test.ts`; kỳ vọng FAIL.
- [ ] **Step 3: Viết một bước compile thuần** từ NodeStyles sang `StyleSet` hiện có, dedupe để tạo class map tạm rồi gọi renderer hiện tại. Giữ escape, asset rewrite, CSP/runtime. Không lưu class map trong IR v2. `emitSectionV2` dùng đúng bước compile đó để QA không lệch site output.
- [ ] **Step 4: Chạy** `npx vitest run tests/unit/emit-v2.test.ts tests/unit/emit.test.ts` và e2e render fixture; kỳ vọng PASS.
- [ ] **Step 5: Commit** các file của task.

### Task 5: Property và tree commands thuần

**Files:** Create `src/core/ir-command.ts`; modify `src/core/safe-names.ts`; test `tests/unit/ir-command.test.ts`.

**Interfaces:** `EditorCommand` là input từ client/AI không chứa ID mới; `prepareCommands(ir: IRV2, commands: EditorCommand[], allocateId: () => string): NormalizedCommand[]` cấp ID cho create/duplicate. `applyCommands(ir: IRV2, commands: readonly (NormalizedCommand | HistoryCommand)[]): { ir: IRV2; inverse: HistoryCommand[]; createdIds: string[] }`. `HistoryCommand` gồm command chuẩn hóa hoặc restore payload private. `applyCommands` không gọi random/Date/I/O.

- [ ] **Step 1: Viết test đỏ** cho `setStyle` ở base/768 và `null`, setText chỉ `#text`, attribute xóa, create/move/delete/duplicate, inverse, input frozen, batch gồm một lệnh hợp lệ rồi một lệnh sai. Reorder `[a,b,c]` bằng `moveNode(b,parent,2)` phải là `[a,c,b]`, Undo trả `[a,b,c]` với cùng ID.

  ```ts
  const { ir: moved, inverse } = applyCommands(frozen, [{ op: "moveNode", id: "b", parentId: "p", index: 2 }]);
  expect(moved.sections[0]!.root.children.map((n) => n.id)).toEqual(["a", "c", "b"]);
  expect(applyCommands(moved, inverse).ir).toEqual(frozen);
  ```

- [ ] **Step 2: Chạy** `npx vitest run tests/unit/ir-command.test.ts`; kỳ vọng FAIL.
- [ ] **Step 3: Implement từng case bằng path-copy** trên đúng một cây section/shell/main, xác nhận `parentId` và owner. `prepareCommands` dùng allocator callback; không nhận ID mới từ JSON input. Dùng `tagSchema`/`attrsSchema` và `isScriptValue`; CSS prop/value phải qua regex/safe check hiện có. Cấm root, cycle, duplicate ID, chuyển owner, duplicate `#section`; sync section references sau thao tác shell. Kiểm tra 50/500/20/8 MB trước khi return.
- [ ] **Step 4: Chạy** task test và `npm run typecheck`; kỳ vọng PASS.
- [ ] **Step 5: Commit** các file của task.

### Task 6: Component và layout commands

**Files:** Modify `src/core/ir-command.ts`, `src/core/ir-component.ts`, `src/core/ir.ts`; test `tests/unit/ir-command.test.ts`, `tests/unit/ir-component.test.ts`.

**Interfaces:** Thêm `promoteLayout`, `resetOverride`, `detachComponent` vào `EditorCommand`. Inverse private `restoreLayout`/`restoreComponent` giữ đúng cây và metadata cũ trong limit 8 MB.

- [ ] **Step 1: Viết test đỏ**: promote hai section ở hai trang rồi Undo trả `sectionIds`, placeholder, layout, root. Reset một style override rồi Undo khôi phục override; Detach rồi Undo gắn lại. Xóa main node đang có override ở instance phải lỗi và giữ input nguyên.

  ```ts
  expect(() => applyCommands(ir, [{ op: "deleteNode", id: overriddenMainChildId }])).toThrow(/instance/);
  const result = applyCommands(ir, [{ op: "detachComponent", instanceId }]);
  expect(applyCommands(result.ir, result.inverse).ir).toEqual(ir);
  ```

- [ ] **Step 2: Chạy** hai test file; kỳ vọng FAIL.
- [ ] **Step 3: Chuyển `promoteLayout` hiện có thành case command** dùng chung logic ref update; component case gọi resolver/reset/detach của Task 3. Validate path override đóng, scope owner và xung đột main trước mutation. Serialize inverse để kiểm tra 8 MB.
- [ ] **Step 4: Chạy** hai test file và `npm run typecheck`; kỳ vọng PASS.
- [ ] **Step 5: Commit** các file của task.

### Task 7: SQLite snapshot, History và recovery

**Files:** Modify `src/core/db.ts`, `src/core/jobs.ts`; create `src/core/ir-store.ts`; test `tests/unit/ir-store.test.ts`, `tests/unit/db.test.ts`.

**Interfaces:** `documentStore(db, materialize)` trả `{ loadDocument(projectId), commitCommands(projectId, baseRevision, commands, source), undoDocument(projectId, baseRevision), redoDocument(projectId, baseRevision), ensureMaterialized(projectId) }`. `materialize(projectId, ir)` tái dùng `writeJsonAtomic`, `emitOut` và QA stale trong `jobs.ts`; không giữ transaction SQLite khi chờ file I/O. `EditResult` có `revision`, `createdIds`, `canUndo`, `canRedo`.

- [ ] **Step 1: Viết test đỏ** bằng DB/file tmp: batch commit tăng revision, Undo/Redo qua `openDb` mới, sửa sau Undo cắt redo, 501 bước còn 500 row; một exception của materializer giữ `materialized_revision < revision`, lần `ensureMaterialized` kế tiếp repair.

  ```ts
  const store = documentStore(db, materialize);
  await store.commitCommands(id, 0, [{ op: "setText", id: textId, text: "new" }], "user");
  expect((db.prepare("SELECT revision,materialized_revision FROM document_state WHERE project_id=?").get(id) as {revision:number;materialized_revision:number}).revision).toBe(1);
  await store.undoDocument(id, 1);
  expect((await store.loadDocument(id)).sections[0]!.root.children[0]!.text).toBe("old");
  ```

- [ ] **Step 2: Chạy** `npx vitest run tests/unit/ir-store.test.ts`; kỳ vọng FAIL.
- [ ] **Step 3: Thêm hai table/index** với `project_id`/`seq` key, transaction `BEGIN IMMEDIATE` để CAS revision và update IR+history+cursor. Gọi `prepareCommands` với `randomUUID` trên server, lưu forward đã chuẩn hóa để Redo dùng lại ID cũ. History chỉ có một snapshot hiện tại, prune redo tail rồi 500 row cũ. Sau commit materialize; chỉ update `materialized_revision` khi `ir.json`, `out/`, graph, QA xong. Lần đọc v1 idle initialize revision 0; lần đọc v2 idempotent. Giữ fix task closure hiện có.

  ```sql
  CREATE TABLE IF NOT EXISTS document_state(project_id TEXT PRIMARY KEY, ir_json TEXT NOT NULL, revision INTEGER NOT NULL, cursor INTEGER NOT NULL, materialized_revision INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS document_history(project_id TEXT NOT NULL, seq INTEGER NOT NULL, forward_json TEXT NOT NULL, inverse_json TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY(project_id,seq));
  ```

- [ ] **Step 4: Chạy** task tests, `tests/unit/jobs.test.ts`, `npm run typecheck`; kỳ vọng PASS.
- [ ] **Step 5: Commit** các file của task.

### Task 8: Command/History API và output gate

**Files:** Create `src/app/api/projects/[id]/editor/commands/route.ts`, `src/app/api/projects/[id]/editor/undo/route.ts`, `src/app/api/projects/[id]/editor/redo/route.ts`; modify `src/app/api/projects/[id]/editor/route.ts`, `src/app/api/projects/[id]/files/[...path]/route.ts`, `src/app/_server/http.ts`; test `tests/unit/editor-api.test.ts`.

**Interfaces:** `POST commands` body `{ baseRevision:number, commands:EditorCommand[] }`; `POST undo|redo` body `{ baseRevision:number }`; `GET editor` thêm `revision, canUndo, canRedo`. Route gọi `requireEditable`, `exclusive`, rồi `documentStore`; output file GET gọi `store.ensureMaterialized(id)` trước `stat` đối với `out/`.

- [ ] **Step 1: Viết test đỏ** bằng Request route trực tiếp: hai request cùng baseRevision 0, một thành công và một 409 `{ code: "STALE_REVISION", revision: 1 }`; Undo khi project queued/active trả 409; materializer lỗi thì `files/out/...` không trả 200/partial bytes. Test Origin/Host guard hiện có tiếp tục chạy.

  ```ts
  const stale = await POST(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ baseRevision: 0, commands }) }), ctx);
  expect(stale.status).toBe(409);
  expect((await stale.json()).revision).toBe(1);
  ```

- [ ] **Step 2: Chạy** `npx vitest run tests/unit/editor-api.test.ts`; kỳ vọng FAIL.
- [ ] **Step 3: Tạo route mỏng** dùng Zod discriminated union và body size cap trước parse; trả lỗi có mã nhưng không echo body. Thêm `STALE_REVISION`, `IR_VERSION_UNSUPPORTED`, `DOCUMENT_MATERIALIZE_FAILED` vào mapping HTTP. File route gate chỉ cho `out/`; shot/heat không cần repair. `GET editor` đọc state sau `ensureMaterialized`.
- [ ] **Step 4: Chạy** task tests, HTTP guard tests và `npm run typecheck`; kỳ vọng PASS.
- [ ] **Step 5: Commit** các file của task.

### Task 9: GrapesJS adapter và UI dùng server History

**Files:** Modify `src/core/grapes-adapter.ts`, `src/app/api/projects/[id]/editor/save/route.ts`, `src/app/api/projects/[id]/editor/promote-layout/route.ts`, `src/app/p/[id]/editor/editor-view.tsx`; test `tests/unit/grapes-adapter.test.ts`, `tests/e2e/editor-smoke.test.ts`.

**Interfaces:** `grapesToCommands(before: IRV2, pageId, json, opts): EditorCommand[]`; `save` route gọi `commitCommands` và nhận `baseRevision` (giữ URL cho UI cũ); promote route phát `promoteLayout` command. Nút Undo/Redo gọi API server và reload revision, không dùng `editor.UndoManager` làm history chính.

- [ ] **Step 1: Viết test đỏ**: reorder sibling qua Grapes giữ ID bằng `moveNode`; xóa/tạo node ra `deleteNode/createNode`; style bp 768 thành target bp 768; `null` attr/style loại bỏ; Save rồi reload/Undo/Redo vẫn còn lịch sử. JSON Grapes quá 60k node/400 depth bị từ chối như hiện tại.

  ```ts
  const commands = grapesToCommands(v2, pageId, reorderedJson, opts);
  expect(commands).toContainEqual({ op: "moveNode", id: secondId, parentId, index: 0 });
  expect(JSON.stringify(commands)).not.toContain("replaceSubtree");
  ```

- [ ] **Step 2: Chạy** adapter test; kỳ vọng FAIL vì `grapesToCommands` chưa tồn tại.
- [ ] **Step 3: Dùng ID từ `data-ir-id` để diff thứ tự/parent**, còn text node không có IR ID trong Grapes JSON thì match theo thứ tự an toàn hoặc tạo/xóa rõ ràng; không phát `replaceSubtree`. Đặt `widthMedia` cho device 768/375 để style edit có media target; đọc `mediaText`/state selectors của CSS rules thay vì bỏ qua, target không thể biểu diễn được ghi Fidelity. UI giữ revision từ GET, Save/Undo/Redo gọi server; 409 hiển thị yêu cầu tải lại thay vì ghi đè. Sau mutation reload một lần từ IR.
- [ ] **Step 4: Chạy** `npx vitest run tests/unit/grapes-adapter.test.ts`; chạy smoke editor sau build; kỳ vọng PASS.
- [ ] **Step 5: Commit** các file của task.

### Task 10: QA fix loop dùng cùng command core

**Files:** Modify `src/core/qa-fix.ts`, `src/core/jobs.ts`; test `tests/unit/qa-fix.test.ts`, `tests/e2e/qa-fixloop.test.ts`.

**Interfaces:** `parseCommands(text, allowed): EditorCommand[]`; `tryApply(ir, commands)` gọi `applyCommands`; không có `replaceSubtree` hoặc `setBehavior` trong prompt/schema E1. `ctx.ir` là IRV2 trong fix phase; accepted candidate vẫn reapply trên IR mới nhất như hiện tại.

- [ ] **Step 1: Viết test đỏ**: AI JSON với create/move/delete hợp lệ trong section được nhận; ID ngoài section hoặc parent ngoài section bị từ chối; replaceSubtree/setBehavior bị từ chối; candidate làm điểm giảm được revert và không ghi History tương tác.

  ```ts
  expect(() => parseCommands('{"commands":[{"op":"deleteNode","id":"outside"}]}', new Set(["inside"]))).toThrow();
  expect(() => parseCommands('{"commands":[{"op":"replaceSubtree","id":"inside"}]}', new Set(["inside"]))).toThrow();
  ```

- [ ] **Step 2: Chạy** QA unit/e2e tests; kỳ vọng FAIL ở parser/prompt.
- [ ] **Step 3: Đổi prompt JSON sang `commands`** với ≤50 command, giới hạn subtree 500/20 và context/ảnh theo hardening §8; validate cả target lẫn parent/source trong allowed set trước apply. Gọi `prepareCommands` một lần bằng allocator server và dùng lại command đã chuẩn hóa khi reapply lên `ctx.ir` mới nhất, để ID mới không đổi giữa hai lần thử. Giữ inspector, 3 vòng, score gate, retry/STOP_AI và reapply merge của hai section; pipeline checkpoint không insert `document_history`.
- [ ] **Step 4: Chạy** QA unit/e2e tests; kỳ vọng PASS.
- [ ] **Step 5: Commit** các file của task.

### Task 11: Capture inventory và Fidelity analyzer

**Files:** Modify `src/core/capture.ts`, `src/core/capture-eval.ts`, `src/core/ir-v2.ts`; create `src/core/fidelity.ts`; test `tests/unit/fidelity.test.ts`, `tests/e2e/capture-page.test.ts`.

**Interfaces:** `PageCapture.inventory? = { scripts:number, iframes:number, canvases:number, skippedNodes:number }`; `buildFidelity(captures:PageCapture[], ir:IRV2): FidelityItem[]`, `refreshFidelity(before, after, captures): FidelityItem[]`. Inventory chỉ có count/feature, không có script body, form value hoặc secret.

- [ ] **Step 1: Viết test đỏ**: interaction carousel `captured` vẫn `partial`; `failed/skipped` không thành supported; iframe/canvas static partial; skipped asset unsupported; legacy capture không inventory tạo partial “chưa đủ dữ liệu capture để xác nhận”; xóa clone node giữ item neo `sourceRef`.

  ```ts
  expect(buildFidelity([capWithCarousel], ir).find((x) => x.feature === "carousel")?.status).toBe("partial");
  expect(buildFidelity([legacyCap], ir).some((x) => x.note.includes("chưa đủ dữ liệu"))).toBe(true);
  ```

- [ ] **Step 2: Chạy** `npx vitest run tests/unit/fidelity.test.ts`; kỳ vọng FAIL.
- [ ] **Step 3: Thu inventory bounded trong một evaluate** ở capture, chỉ đếm/ghi trạng thái. Analyzer gắn `pageId`, `nodeId`/`sourceRef` khi định vị được; CSSOM media/pseudo/focus/sticky/subtreeHtml và capture gaps đi vào mục riêng. Không gán supported cho JS chỉ vì có markup hoặc pixel QA đạt. Khi edit, refresh theo nguồn; không xóa issue chỉ vì clone node bị delete.
- [ ] **Step 4: Chạy** fidelity unit và capture e2e; kỳ vọng PASS.
- [ ] **Step 5: Commit** các file của task.

### Task 12: Preview & QA báo cáo Fidelity

**Files:** Modify `src/app/api/projects/[id]/preview/route.ts`, `src/app/p/[id]/preview/preview-view.tsx`, `src/app/p/[id]/preview/preview-model.ts`, `src/app/globals.css`; test `tests/unit/preview-model.test.ts`, `tests/e2e/editor-smoke.test.ts`.

**Interfaces:** Preview JSON thêm `fidelity: FidelityItem[]`; UI lọc theo page/status, tổng theo status, link tới node nếu tồn tại, JSON export cùng dữ liệu. `meanScore` hiện tại không bị thay bằng Fidelity.

- [ ] **Step 1: Viết test đỏ**: 3 status count đúng, filter page/status đúng, item thiếu node vẫn hiển thị, điểm pixel QA giữ nguyên khi Fidelity `unsupported`.

  ```ts
  expect(fidelityCounts([{ pageId: "p", feature: "carousel", status: "partial", note: "runtime" }])).toEqual({ supported: 0, partial: 1, unsupported: 0 });
  expect(meanScore([{ score: 0.95 }])).toBe(0.95);
  ```

- [ ] **Step 2: Chạy** `npx vitest run tests/unit/preview-model.test.ts`; kỳ vọng FAIL vì `fidelityCounts` chưa có.
- [ ] **Step 3: Trả Fidelity từ IR v2 qua API**, thêm panel/tab trong rail Preview & QA với status badge, filter và link scroll qua `data-ir-id`; nếu node đã bị xóa, hiển thị sourceRef/note mà không tạo link chết. Giữ labels và keyboard accessibility của tabs/buttons.
- [ ] **Step 4: Chạy** preview unit và smoke e2e; kỳ vọng PASS.
- [ ] **Step 5: Commit** các file của task.

### Task 13: Pipeline dùng IR v2

**Files:** Modify `src/core/ir.ts`, `src/core/jobs.ts`, `src/core/graph.ts`, `src/core/emit-html.ts`; test `tests/unit/ir.test.ts`, `tests/unit/emit.test.ts`, `tests/e2e/jobs-resume.test.ts`, `tests/e2e/qa-fixloop.test.ts`.

**Interfaces:** Public `IR` trong `ir.ts` là `IRV2`; `buildIR(captures)` trả v2 (gọi legacy builder nội bộ rồi `migrateIR`); `loadIr`/`loadEditable` đi qua loader trung tâm. `ir.json` ghi `version:2` sau build/migration; SQLite state là nguồn sự thật từ lúc editor khởi tạo.

- [ ] **Step 1: Viết test đỏ**: buildIR trả v2, `ir.json.version === 2` sau clone; resume paused/fix dùng v2 và không ghi đè bản sửa; rerun migration không đổi ID/revision. So output ở cả ba breakpoint với fixture trước migration.

  ```ts
  const first = await store.loadDocument(id);
  const again = await store.loadDocument(id);
  expect(again.revision).toBe(first.revision);
  expect(again.sections[0]!.root.id).toBe(first.sections[0]!.root.id);
  ```

- [ ] **Step 2: Chạy** `npx vitest run tests/unit/ir.test.ts tests/unit/emit.test.ts`; kỳ vọng FAIL ở đường build/emit cũ.
- [ ] **Step 3: Cho build/jobs/graph dùng loader/emitter v2**, bỏ cast `JSON.parse(...) as IR` và `applyPatch`/`cls[]` khỏi đường pipeline sống. Chỉ giữ legacy builder/parser trong migrator. `graph.ts` đọc component main/instance mới, section/layout ID không đổi. `qa.json` được stale sau migration/edit, chấm lại qua rescore hiện có.
- [ ] **Step 4: Chạy** `npm run typecheck`, `npm test`, `npm run test:e2e -- tests/e2e/jobs-resume.test.ts tests/e2e/qa-fixloop.test.ts`; kỳ vọng PASS.
- [ ] **Step 5: Commit** các file của task.

### Task 14: Preview/export và luồng v1→v2 thực

**Files:** Modify `src/app/api/projects/[id]/preview/route.ts`, `src/app/api/projects/[id]/files/[...path]/route.ts`, `src/app/api/projects/[id]/export/route.ts`; test `tests/e2e/editor-smoke.test.ts`, `tests/e2e/emit-render.test.ts`.

**Interfaces:** Mọi GET đọc IR/output sau `store.ensureMaterialized(id)` nếu có `document_state`; clone chưa vào editor vẫn dùng checkpoint v2 từ job. `preview`/`export` không cast raw `ir.json` sang IR v1.

- [ ] **Step 1: Viết test đỏ**: đặt một v1 `ir.json` từ fixture vào project idle có emit, mở editor rồi Save/Undo/Redo, xác nhận v2 + History qua reload. Gây lỗi materialize rồi đọc Preview/file/export: không trả output dở; repair thành công thì trả revision mới. Capture thiếu `box` vẫn mở và có Fidelity.

  ```ts
  const preview = await fetch(`${app.base}/api/projects/${id}/preview`);
  expect(preview.status).toBe(200);
  expect((await preview.json()).fidelity.some((x: { status: string }) => x.status === "partial")).toBe(true);
  ```

- [ ] **Step 2: Chạy** `npm run test:e2e -- tests/e2e/editor-smoke.test.ts tests/e2e/emit-render.test.ts`; kỳ vọng FAIL ở đường đọc cũ hoặc gate.
- [ ] **Step 3: Chuyển Preview/file/export sang store** và gate repair; giữ ảnh shot/heat từ capture không qua emit. Kiểm tra CSP, asset path và HTML phục vụ đúng như trước. Không auto-resume job khi mở Preview.
- [ ] **Step 4: Chạy** hai e2e trên cùng bộ fixture ở 1440/768/375, `npm run typecheck`, `npm test`, `npm run build`; kỳ vọng PASS và QA pixel không tụt so với fixture v1.
- [ ] **Step 5: Commit** các file của task.

### Task 15: Review cuối và traceability

**Files:** Modify `docs/superpowers/specs/2026-09-27-e1-document-model-design.md` chỉ nếu implementation cần làm rõ quyết định đã duyệt; update graph bằng CLI khi có backend. Không đụng các file người dùng đã để untracked.

**Interfaces:** Không tạo API mới; kiểm tra các interface Task 1–14 khớp spec và đường gọi thực.

- [ ] **Step 1: So từng §0–§7 của spec với code/test**; kiểm tra 5 Review Focus, public API, server History, component Reset/Detach, Fidelity, migration và giới hạn 50/500/20/8 MB/500 bước.
- [ ] **Step 2: Chạy** `graphify explain feat_editor`, `graphify docs --update`. Nếu CLI vẫn báo thiếu API key, ghi rõ graph chưa đồng bộ trong bàn giao; không sửa graph thủ công.
- [ ] **Step 3: Chạy lại gate cuối** `npm run typecheck`, `npm test`, `npm run build`, targeted e2e; kiểm tra `git diff --check` và `git status --short` để không stage/commit `next-env.d.ts`, `.playwright-mcp/`, `passcaptchar/`, `rules.md`.
- [ ] **Step 4: Whole-branch review bằng subagent mới**, xử lý issue được xác nhận, chạy đúng test liên quan; commit các sửa cuối với trailer. Không push/merge.

## Execution gate

Plan này cần người dùng review trước khi triển khai. Sau khi duyệt, dùng `superpowers:subagent-driven-development`: một subagent implement từng task, một reviewer khác kiểm tra spec/quality trước khi sang task tiếp, rồi whole-branch review. Không bắt đầu Task 1 trong lượt viết plan.
