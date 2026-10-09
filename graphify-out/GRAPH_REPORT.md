# Graph Report - docs  (2026-10-09)

## Corpus Check
- 38 files · ~353,376 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 766 nodes · 2789 edges · 27 communities (25 shown, 2 thin omitted)
- Extraction: 76% EXTRACTED · 23% INFERRED · 0% AMBIGUOUS · INFERRED: 646 edges (avg confidence: 0.77)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- SP1 Clone Engine Core
- QA Preview & Export Screens
- Command API & Server History
- E2 Interactive Spec Model
- E3b Edit Main In Place
- Fidelity Report & Behavior QA
- E3 Command Contract Rulings
- E3b Free Drag, Resize & Snap
- E3b Style Manager
- E2 Component Panel
- E3a Canvas API & Affected
- Canvas Overlay & Flow Drag
- Editor Screen & E4 AI Chat
- Editor Model & Layer Tree
- Command Bus, Zoom & Limits
- Editor Shell & Canvas Doc
- Insert Panel & Templates
- Component Commands
- Responsive Drawer & View-only
- E3b Wrap-up Task
- New Clone, Crawl & Auth
- Project History Screen
- Progress, Jobs & Logs
- E2 Interactive Components
- E3a Visual Editor Core
- AI Gateway Settings
- E1 Document Model & Migration

## God Nodes (most connected - your core abstractions)
1. `E3 Visual editor React kiểu Figma/Webflow trên IR v2, thay GrapesJS` - 88 edges
2. `SP1 Clone Engine + UI` - 76 edges
3. `E2 Interactive components: carousel/tabs/accordion/modal/dropdown/menu/video là component có cấu trúc trong IR v2 + runtime riêng + QA hành ` - 72 edges
4. `/ — Project History` - 65 edges
5. `AI chat in the visual editor: one request -> one validated batch of editor commands (source ai_editor), one Undo step` - 54 edges
6. `/p/[id]/preview — QA Preview & Compare (variant: Visual Diff & QA Compare 9410f8b12f0940bfa715f530a09abdfd)` - 52 edges
7. `/new — New Clone Configuration` - 49 edges
8. `/p/[id] — Clone Progress (phase stepper + SSE log + auth banner)` - 49 edges
9. `/p/[id]/sitemap — Select Pages to Clone` - 47 edges
10. `/settings/ai — AI Gateway & Provider Settings` - 47 edges

## Surprising Connections (you probably didn't know these)
- `Every workload bounded (hard limits, warn not hang)` --conceptually_related_to--> `Drift: Cluster us-east-core / concurrency 8 jobs / telemetry / Tokens & Budget sidebar`  [AMBIGUOUS]
  docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md → docs/superpowers/design/stitch/history.html
- `Every workload bounded (hard limits, warn not hang)` --conceptually_related_to--> `Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers)`  [AMBIGUOUS]
  docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md → docs/superpowers/design/stitch/history-alt1.html
- `Fix patch that lowers score is reverted` --conceptually_related_to--> `'Auto-reconcile CSS' / Approve & Deploy one-click buttons`  [AMBIGUOUS]
  docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md → docs/superpowers/design/stitch/qa-preview.html
- `Chuyển breakpoint 1440/768/375 trong toolbar` --implements--> `E3 Visual editor React kiểu Figma/Webflow trên IR v2, thay GrapesJS`  [INFERRED]
  docs/superpowers/plans/2026-10-07-e3a-visual-editor-core.md → docs/superpowers/specs/2026-10-07-e3-visual-editor-design.md
- `Tab bảng phải: Style / Component / Hiệu ứng` --implements--> `E3 Visual editor React kiểu Figma/Webflow trên IR v2, thay GrapesJS`  [INFERRED]
  docs/superpowers/plans/2026-10-07-e3a-visual-editor-core.md → docs/superpowers/specs/2026-10-07-e3-visual-editor-design.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Lõi client thuần: model + inline-text + command-bus** — mod_model, mod_inline_text, mod_command_bus [EXTRACTED 1.00]
- **Lõi client thuần: model + inline-text + command-bus** — mod_model, mod_inline_text, mod_command_bus [EXTRACTED 1.00]
- **Ba thay đổi lõi E3b đi trước: moveNode qua section, new:<k> refs, gộp Undo** — e3btask_T1, e3btask_T2, e3btask_T3, mod_ir_command, mod_ir_store [EXTRACTED 1.00]
- **Ba thay đổi lõi E3b đi trước: moveNode qua section, new:<k> refs, gộp Undo** — e3btask_T1, e3btask_T2, e3btask_T3, mod_ir_command, mod_ir_store [EXTRACTED 1.00]
- **Sửa main tại chỗ: mô hình thuần + chế độ canvas + R16–R18** — e3btask_T14, e3btask_T15, e3bruling_R16, e3bruling_R17, e3bruling_R18, feat_edit_main [EXTRACTED 1.00]
- **Sửa main tại chỗ: mô hình thuần + chế độ canvas + R16–R18** — e3btask_T14, e3btask_T15, e3bruling_R16, e3bruling_R17, e3bruling_R18, feat_edit_main [EXTRACTED 1.00]
- **Họ thao tác pointer trên canvas: kéo luồng, Alt+kéo, resize/padding, zoom/pan, chèn từ panel** — e3btask_T7, e3btask_T8, e3btask_T9, e3btask_T10, e3btask_T11, mod_gestures, e3bruling_R12 [EXTRACTED 1.00]
- **Họ thao tác pointer trên canvas: kéo luồng, Alt+kéo, resize/padding, zoom/pan, chèn từ panel** — e3btask_T7, e3btask_T8, e3btask_T9, e3btask_T10, e3btask_T11, mod_gestures, e3bruling_R12 [EXTRACTED 1.00]
- **E2 sửa component: Command A/B + guardRoles + panel Component + AI fix** — mod_ir_command, mod_interactive, mod_component_panel, mod_qa_fix [INFERRED 0.75]
- **E2 sửa component: Command A/B + guardRoles + panel Component + AI fix** — mod_ir_command, mod_interactive, mod_component_panel, mod_qa_fix [INFERRED 0.75]
- **E2 pipeline: capture scan, IR attach, emit data-c*, runtime, QA hành vi** — mod_interactive_scan, mod_interactive_build, mod_qa_behavior [INFERRED 0.75]
- **E2 pipeline: capture scan, IR attach, emit data-c*, runtime, QA hành vi** — mod_interactive_scan, mod_interactive_build, mod_qa_behavior [INFERRED 0.75]
- **E2 chuỗi nhận diện config → observed → guessed** — e2spec_s3, mod_interactions_eval [INFERRED 0.75]
- **E2 chuỗi nhận diện config → observed → guessed** — e2spec_s3, mod_interactions_eval [INFERRED 0.75]
- **E2 emit data-c + runtime.js + QA hành vi** — e2spec_s4, e2concept_behavior_qa [INFERRED 0.75]
- **E2 emit data-c + runtime.js + QA hành vi** — e2spec_s4, e2concept_behavior_qa [INFERRED 0.75]
- **E3 vòng sửa: canvas iframe + command bus + server History** — mod_editor_canvas, mod_command_bus, feat_server_history, feat_visual_editor [INFERRED 0.75]
- **E3 vòng sửa: canvas iframe + command bus + server History** — mod_editor_canvas, mod_command_bus, feat_server_history, feat_visual_editor [INFERRED 0.75]
- **Cập nhật canvas theo từng section: editor-canvas + server withAffected + canvas client** — mod_editor_canvas, mod_editor_server, mod_canvas [INFERRED 0.85]
- **Cập nhật canvas theo từng section: editor-canvas + server withAffected + canvas client** — mod_editor_canvas, mod_editor_server, mod_canvas [INFERRED 0.85]
- **Upload ảnh: sniff/sanitize + route multipart + asset map** — mod_upload, mod_http, e3atask_T3 [INFERRED 0.85]
- **Upload ảnh: sniff/sanitize + route multipart + asset map** — mod_upload, mod_http, e3atask_T3 [INFERRED 0.85]
- **E1 command stack: ir-command + ir-component + ir-store** — mod_ir_command, mod_ir_component, mod_ir_store, feat_command_api, feat_server_history [INFERRED 0.85]
- **E1 command stack: ir-command + ir-component + ir-store** — mod_ir_command, mod_ir_component, mod_ir_store, feat_command_api, feat_server_history [INFERRED 0.85]
- **E1 migration path: ir-legacy → ir-v2 → ir-migrate** — mod_ir_legacy, mod_ir_v2, mod_ir_migrate, e1task_T1, e1task_T2 [INFERRED 0.85]
- **E1 migration path: ir-legacy → ir-v2 → ir-migrate** — mod_ir_legacy, mod_ir_v2, mod_ir_migrate, e1task_T1, e1task_T2 [INFERRED 0.85]

## Communities (27 total, 2 thin omitted)

### Community 0 - "SP1 Clone Engine Core"
Cohesion: 0.07
Nodes (74): src/core/assets.ts, src/core/auth.ts, src/core/browser.ts, src/core/capture.ts (+capture-eval.ts), src/core/config.ts, src/core/crawl.ts, src/core/crypto.ts, src/core/db.ts (+66 more)

### Community 1 - "QA Preview & Export Screens"
Cohesion: 0.09
Nodes (59): "Build Successful", "HTML5/UTF-8", nút "Export Package" (trùng Export ZIP), icon copy/docs trên hàng completed, badge thumbnail DOM/SPA/AUTH/DOCS/HTML/ERR, "Target: DOM + CSS Assets", "Target: Full SPAs • SSR hydration dump", "HTML+Tailwind export • 18.4MB bundle • Zero diff errors", "ready • bundle exported", "Pixel QA 1 Diff", "card-hero.tsx:42" (output là HTML thuần) (+51 more)

### Community 10 - "Command API & Server History"
Cohesion: 0.18
Nodes (9): src/core/ir-store.ts - commitCommands(opts.coalesce) thay bước History mới nhất (R3), INSERT OR REPLACE, E1 §2 Command API, E1 §3 History chung trên server, E1 Task 10: QA fix loop dùng cùng command core, E1 Task 7: SQLite snapshot, History và recovery, E1 Task 8: Command/History API và output gate, E1 Task 9: GrapesJS adapter và UI dùng server History, E3b Task 3: Gộp bước Undo cho cùng ô style (R3) — store, route, bus (+1 more)

### Community 11 - "E2 Interactive Spec Model"
Cohesion: 0.21
Nodes (9): src/core/interactive.ts - type + zod schema theo kind, validate tham chiếu, roleIndex, cfgOf, item helpers, panelComponents (thuần), src/core/interactive-guess.ts - suy cấu trúc guessed, measureCarousel, migrateBehaviors, upgradeDocument (thuần), src/core/ir-migrate.ts - migrateIR thuần v1→v2, validate, không ghi file, E2 §10 Giới hạn cứng, E2 §14 Rulings khi triển khai (2026-10-03), E2 §2 Model IR v2 (InteractiveSpec), E2 §3 Nhận diện capture: config/observed/guessed, E2 Task 1: Model, schema, validate tham chiếu, baseline QA (+1 more)

### Community 12 - "E3b Edit Main In Place"
Cohesion: 0.15
Nodes (6): tests/fixtures/site5/index.html - ba thẻ cùng cấu trúc → một component cho e2e sửa main, E3a Task 14: Ghi rulings vào spec, graph, kiểm toàn bộ, E3b Task 14: Sửa main — mô hình thuần: viewOnly, instanceRootOf, mainView, toMain, viewIdOf (R16–R18), E3b Task 15: Sửa main — chế độ trên canvas: nút, thanh + khung, batch qua toMain, thoát (R17–R18), E3 §11 Rulings khi triển khai E3a (2026-10-07), E3 §2 E3a — chọn, layer tree, sửa chữ, thay ảnh, phím tắt

### Community 13 - "Fidelity Report & Behavior QA"
Cohesion: 0.20
Nodes (8): src/core/fidelity.ts - buildFidelity/refreshFidelity từ capture inventory + IR, src/core/interactions-eval.ts - nhận diện .swiper/.slick-slider/.splide/scroll-snap lúc quét, E1 §5 Fidelity report, E1 Task 11: Capture inventory và Fidelity analyzer, E1 Task 12: Preview & QA báo cáo Fidelity, E2 §0 Bối cảnh và bằng chứng (audit carousel chưa clone được), E2 §5 QA pixel + QA hành vi, E2 Task 5: Fidelity cho component

### Community 14 - "E3 Command Contract Rulings"
Cohesion: 0.13
Nodes (3): E3 §12 Rulings khi triển khai E3b, E3 §3 E3b — Style Manager, kéo/resize, chèn, guide/zoom, E3 §5 API bổ sung

### Community 15 - "E3b Free Drag, Resize & Snap"
Cohesion: 0.21
Nodes (5): src/app/p/[id]/editor/visual/gestures.ts - hình học thao tác thuần: dropZone, freeCommands, resizeCommands, spacingCommand, zoom, src/app/p/[id]/editor/visual/snap.ts - snap/gaps thuần, SNAP_PX = 4, E3b Task 6: Hình học thao tác (thuần): vạch chèn, absolute, resize, padding/gap, zoom, E3b Task 8: Alt+kéo đặt tự do, snap/guide, đo khoảng cách, E3b Task 9: Resize 8 handle + kéo padding/gap

### Community 16 - "E3b Style Manager"
Cohesion: 0.22
Nodes (4): src/app/p/[id]/editor/visual/style-model.ts - Style Manager thuần: fieldOf/setField/clearField/GROUPS/CHOICES/scrub, src/app/p/[id]/editor/visual/style-panel.tsx - Style Manager UI (lạc quan, debounce 300 ms), E3b Task 4: Model Style Manager (thuần), E3b Task 5: Style Manager UI (lạc quan, debounce 300 ms, gộp Undo)

### Community 17 - "E2 Component Panel"
Cohesion: 0.19
Nodes (5): src/app/p/[id]/editor/component-panel/component-panel.tsx - panel Component trong editor (+component-form, convert-wizard), src/app/p/[id]/editor/component-panel/panel-model.ts - componentFor, moveCommand, thumbStyle (thuần, client-safe), E2 §7 Panel Component (React thuần), E2 Task 13: Panel Component + nối editor (canvas ?edit=1, postMessage), data-ui ui_editor_component_* - các phần tử panel Component (ghi vào stitch-screens.md, không có trong mockup)

### Community 18 - "E3a Canvas API & Affected"
Cohesion: 0.21
Nodes (8): src/app/_server/editor.ts - withAffected dưới exclusiveEdit, canvasUrlsFor, E3a Task 4: API — affected cho commands/Undo/Redo, payload canvas trong GET /editor, E3a Task 8: Khung editor mới + canvas iframe + 'Editor cũ', Chuyển breakpoint 1440/768/375 trong toolbar, Panel trái: layer tree, Tab bảng phải: Style / Component / Hiệu ứng, Chỉ báo lưu 'Đã lưu' / 'Đang lưu…' (không role=status), Banner 'Tải lại' khi 409 STALE / PROJECT_BUSY

### Community 19 - "Canvas Overlay & Flow Drag"
Cohesion: 0.20
Nodes (8): src/app/p/[id]/editor/visual/canvas.tsx - iframe srcdoc sandbox, replace section, CanvasHandle, src/app/p/[id]/editor/visual/overlay.tsx - lớp phủ: handle resize/spacing, guide, khung sửa main, E3a Task 9: Overlay hover/chọn/spacing + hiệu năng 5 000 node, E3b Task 1: moveNode giữa hai section, giữ ID (R1), E3b Task 7: Kéo theo luồng trên canvas (vạch chèn xanh/đỏ, moveNode), Overlay hộp hover, Overlay hộp phần tử cha, Overlay margin/padding

### Community 2 - "Editor Screen & E4 AI Chat"
Cohesion: 0.08
Nodes (47): src/core/ai-chat.ts - systemPrompt, parseChatReply, runChatTurn (≤8 lần gọi model), chatErrorText, src/core/ai-chat-scope.ts - chatScope, outline/nodeDetail/componentList, CHAT_TOOLS (findText ≤20 kết quả), SCOPE_LIMITS, thuần, src/app/p/[id]/editor/visual/chat-model.ts - scopeLabel, chatLock, canUndoTurn, selectionAfter, STATUS_VI (thuần) + CommandBus.settled/adopt, src/app/p/[id]/editor/visual/chat-panel.tsx - tab AI trong editor, src/app/api/projects/[id]/editor/chat/{route,cancel/route}.ts - GET/POST/DELETE + cancel, POST trả 200 cho mọi lượt đã chạy, src/app/_server/chat.ts - một lượt mỗi project (beginTurn/endTurn/cancelTurn), chatBudget, runTurn, src/core/chat-store.ts - bảng chat_messages tạo lười, appendTurn/listMessages/recentTurns/clearChat, src/core/grapes-adapter.ts (+39 more)

### Community 20 - "Editor Model & Layer Tree"
Cohesion: 0.27
Nodes (6): src/app/p/[id]/editor/visual/layer-tree.tsx - layer tree ảo hoá, tìm, đổi tên, mắt, kéo thả, src/app/p/[id]/editor/visual/model.ts - model thuần editor: dropCommand, keyAction zoom, viewOnly/mainView/toMain/viewIdOf, E3a Task 10: Layer tree (ảo hoá, tìm, đổi tên, mắt, kéo thả), E3a Task 11: Phím tắt sửa, chọn nhiều thành một batch, clipboard nội bộ, Dòng layer (đổi tên, mắt, kéo thả), Ô tìm layer

### Community 21 - "Command Bus, Zoom & Limits"
Cohesion: 0.22
Nodes (5): src/app/p/[id]/editor/visual/command-bus.ts - bus lệnh: 1 request bay, hàng đợi ≤20, áp lạc quan + rollback, E3b Task 10: Zoom 25–200% và pan, E3 §6 Giới hạn cứng, iframe canvas srcdoc (sandbox allow-same-origin allow-scripts), Overlay hộp chọn

### Community 22 - "Editor Shell & Canvas Doc"
Cohesion: 0.31
Nodes (5): src/core/editor-canvas.ts - canvasPayload/affectedOf: tài liệu canvas của trang và các section bị một batch chạm tới (thuần), src/app/p/[id]/editor/visual/visual-editor.tsx - editor chính: gesture state, zoom, drawer, card Section, chế độ sửa main, E3a Task 2: Tài liệu canvas và affected (lõi thuần), E3b Task 12: 'Gộp thành layout' trong editor mới, gỡ GrapesJS, chuyển e2e, E3 §1 Kiến trúc và luồng dữ liệu

### Community 23 - "Insert Panel & Templates"
Cohesion: 0.29
Nodes (3): src/app/p/[id]/editor/visual/insert-panel.tsx - panel 'Thêm', src/app/p/[id]/editor/visual/templates.ts - TEMPLATES, insertBatch, dropPosition (thuần), E3b Task 11: Panel 'Thêm' (mẫu + component mẫu, click hoặc kéo)

### Community 24 - "Component Commands"
Cohesion: 0.52
Nodes (5): src/core/ir-command.ts - Command API thuần; E3b: moveNode qua section (R1), resolveRefs new:<k>/<path> (R2), E2 §6 Commands bổ sung Command API, E2 Task 10: Command A — updateComponent, convertToComponent, unwrapComponent, bảo vệ vai trò, E2 Task 11: Command B — thêm / xoá / đổi thứ tự item, alias AI, E3b Task 2: Tham chiếu node vừa tạo trong cùng batch cho convertToComponent (R2)

### Community 3 - "New Clone, Crawl & Auth"
Cohesion: 0.10
Nodes (49): "Allocated for AST layout synthesis, multi-pass stylesheet reconciliation, and icon vectorization.", "Target AST dialect", "HIGH FIDELITY", "Polite rate limiting active", hint "limit/hops/workers", hậu tố "PGS/LVL/THRD", "TASK CONFIG 0X88F", "READY", "DOM v3 Parser • Headless Chromium", "Inject Cookies (.har)" (bản hợp lệ = cookie/storageState JSON), "Stage 3: AST Scoping", Cost/runtime estimation (estimateRun, core/estimate.ts), Stitch mockup: New Clone Configuration (+41 more)

### Community 4 - "Project History Screen"
Cohesion: 0.10
Nodes (42): src/app/api/* + next.config.ts + layout.tsx, src/app/_ui/icons.gen.ts (commit) + scripts/gen-icons.mjs - subset Material Symbols Outlined sinh luc build tu @material-symbols/svg-400, src/app/_ui (Shell.tsx, icons.gen.ts, shared UI), §1 Design tokens: mau (--c-*), chu (--t-*), radius (--r-*), spacing (--s-*), mat do, motion, focus, icon self-host, §2 App shell (header 56px + sidebar 224px) + component dung chung src/app/_ui/*, §3 Tung man: bang element ui_* theo 8 man (settings-ai, history, new-clone, sitemap, progress, qa-preview, code-viewer, editor) + ma tran phu gap, / — Project History, Delete project action (+34 more)

### Community 5 - "Progress, Jobs & Logs"
Cohesion: 0.11
Nodes (42): src/app/_ui/error-hints.ts - ERROR_HINTS + hintFor(code), đúng bảng spec §4, src/core/run-log.ts - appendRunLog/readRunLog, workspace/<id>/run.log, xoay 5 MB → run.prev.log, không tạo lại thư mục, "[worker#01]", "Thread #04", "stdout & ast-worker.log PID 4921", E4 §10 Không làm ở E4, E4 §8 Bảo mật, Error surfacing: status_reason, run.log + download, reason banner, Lỗi & cảnh báo panel, hint table, Headed browser toggle per project (Hiện trình duyệt khi chạy), Persisted SSE event log (core/event-log.ts) (+34 more)

### Community 6 - "E2 Interactive Components"
Cohesion: 0.15
Nodes (21): src/core/interactive-build.ts - attachInteractives: record capture → spec, loop clone, giới hạn 50/100 (thuần), src/core/interactive-eval.ts - hàm chạy trong trang: đọc config Swiper/Slick/Splide, quan sát, tìm trigger hover, src/core/interactive-scan.ts - scanInteractives(page): config → observed → hover, có ngân sách, src/core/ir-build.ts - dựng IR từ capture, alignChildren ghép theo khoá, src/core/qa-behavior.ts - checkBehavior: QA hành vi có giới hạn, không AI, src/core/qa-fix.ts - AI fix loop, thêm updateComponent, E2 §1 Phạm vi và quyết định đã chốt, E2 §11 Lỗi và an toàn (+13 more)

### Community 7 - "E3a Visual Editor Core"
Cohesion: 0.14
Nodes (19): src/app/p/[id]/editor/visual/element-panel.tsx - bảng phải: Phần tử, ảnh/upload, Component, Hiệu ứng, src/app/_server/http.ts - readCapped, multipartBody, handle multipart, status 413/400 cho mã upload, src/app/p/[id]/editor/visual/inline-text.ts - thuần: textBatch (DOM-like -> command), src/core/upload.ts - sniffImage/sanitizeSvg (thuần) + storeUpload/readUploads/assetLibrary, E2 §13 Không làm trong E2, E3a Task 1: Lệnh setName, E3a Task 12: Sửa chữ trực tiếp trong canvas, E3a Task 13: Bảng phải — Phần tử (ảnh/upload/alt/href/Detach), Component (E2), Hiệu ứng (+11 more)

### Community 8 - "AI Gateway Settings"
Cohesion: 0.20
Nodes (24): "ID: prov_anthropic_v1 // status: 200 OK", badge "VLLM/OAI", "OLLAMA", "Cached 4 mins ago", "Sync: OK", "High Precision", "Low Latency", "Token Extractor" + mô tả vai trò sai, "v2.4-gateway", "ROUTER ACTIVE", "MATRIX v1.2", "GATEWAY", Stitch mockup: AI Gateway & Providers, /settings/ai — AI Gateway & Provider Settings, Add Anthropic/OpenAI Compatible buttons (+16 more)

### Community 9 - "E1 Document Model & Migration"
Cohesion: 0.11
Nodes (18): src/core/ir-component.ts - main/instance, resolveComponents, resetOverride, detachComponent, src/core/ir-legacy.ts - LegacyIRNode view-only (thêm c/skip/keepId/embed), src/core/ir-v2.ts - type IRV2/IRNodeV2/NodeStyles/FidelityItem và toV2, E1 §0 Mục tiêu và ranh giới, E1 §1 IR v2, E1 §4 Component main/instance và override, E1 §6 Migration, lỗi và kiểm thử, E1 §7 Điều kiện bàn giao E1 (+10 more)

## Ambiguous Edges - Review These
- `Every workload bounded (hard limits, warn not hang)` → `Drift: Cluster us-east-core / concurrency 8 jobs / telemetry / Tokens & Budget sidebar`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history.html · relation: conceptually_related_to
- `Every workload bounded (hard limits, warn not hang)` → `Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers)`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt1.html · relation: conceptually_related_to
- `Fix patch that lowers score is reverted` → `'Auto-reconcile CSS' / Approve & Deploy one-click buttons`  [AMBIGUOUS]
  docs/superpowers/design/stitch/qa-preview.html · relation: conceptually_related_to
- `Drift: "Session Cookie Vault" / Save as preset` → `Secrets AES-256-GCM, key file outside workspace; never logged/sent to AI/in graph/output`  [AMBIGUOUS]
  docs/superpowers/design/stitch/new-clone.html · relation: conceptually_related_to
- `Drift: "Configure Turnstile Bypass" button / "Turnstile pass" wording` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/sitemap.html · relation: conceptually_related_to
- `'Inject Auth' button on Cloudflare Turnstile challenge row` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt1.html · relation: conceptually_related_to
- `'Puppeteer Stealth' engine filter option (anti-bot evasion)` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt3.html · relation: conceptually_related_to
- `Drift: "Cloudflare Bot Management Challenge" failed row wording` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history.html · relation: conceptually_related_to
- `Drift: "Cloudflare Turnstile detected / headless browser clearance" banner + log wording` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/progress.html · relation: conceptually_related_to
- `Secrets AES-256-GCM, key file outside workspace; never logged/sent to AI/in graph/output` → `Drift: "Stored with AES-256 GCM in local daemon vault" wording`  [AMBIGUOUS]
  docs/superpowers/design/stitch/settings-ai.html · relation: conceptually_related_to

## Knowledge Gaps
- **15 isolated node(s):** `tests/fixtures/site5/index.html - ba thẻ cùng cấu trúc → một component cho e2e sửa main`, `src/core/interactions-eval.ts - nhận diện .swiper/.slick-slider/.splide/scroll-snap lúc quét`, `src/app/p/[id]/editor/visual/gestures.ts - hình học thao tác thuần: dropZone, freeCommands, resizeCommands, spacingCommand, zoom`, `src/app/p/[id]/editor/visual/snap.ts - snap/gaps thuần, SNAP_PX = 4`, `data-ui ui_editor_component_* - các phần tử panel Component (ghi vào stitch-screens.md, không có trong mockup)` (+10 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 67 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Every workload bounded (hard limits, warn not hang)` and `Drift: Cluster us-east-core / concurrency 8 jobs / telemetry / Tokens & Budget sidebar`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `SP1 Clone Engine + UI` connect `SP1 Clone Engine Core` to `QA Preview & Export Screens`, `Editor Screen & E4 AI Chat`, `New Clone, Crawl & Auth`, `Project History Screen`, `Progress, Jobs & Logs`, `AI Gateway Settings`?**
  _High betweenness centrality (0.098) - this node is a cross-community bridge._
- **Are the 51 inferred relationships involving `E3 Visual editor React kiểu Figma/Webflow trên IR v2, thay GrapesJS` (e.g. with `E3a Ruling R1: Tên thật trong code: renderSectionsHtml compile một lần, emitSection dùng lại (spec viết emitSectionV2/renderSiteV2)` and `E3a Ruling R10: Layer tree không hiện dòng #text; dòng section dùng id placeholder trong shell`) actually correct?**
  _`E3 Visual editor React kiểu Figma/Webflow trên IR v2, thay GrapesJS` has 51 INFERRED edges - model-reasoned connections that need verification._
- **What connects `tests/fixtures/site5/index.html - ba thẻ cùng cấu trúc → một component cho e2e sửa main`, `src/core/interactions-eval.ts - nhận diện .swiper/.slick-slider/.splide/scroll-snap lúc quét`, `src/app/p/[id]/editor/visual/gestures.ts - hình học thao tác thuần: dropZone, freeCommands, resizeCommands, spacingCommand, zoom` to the rest of the system?**
  _15 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `SP1 Clone Engine Core` be split into smaller, more focused modules?**
  _Cohesion score 0.07434343434343435 - nodes in this community are weakly interconnected._
- **What is the exact relationship between `Every workload bounded (hard limits, warn not hang)` and `Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `E3 Visual editor React kiểu Figma/Webflow trên IR v2, thay GrapesJS` connect `E3a Visual Editor Core` to `E2 Interactive Components`, `E1 Document Model & Migration`, `Command API & Server History`, `E3b Edit Main In Place`, `E3 Command Contract Rulings`, `E2 Component Panel`, `E3a Canvas API & Affected`, `Canvas Overlay & Flow Drag`, `Editor Model & Layer Tree`, `Command Bus, Zoom & Limits`, `Editor Shell & Canvas Doc`, `Component Commands`, `Responsive Drawer & View-only`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._