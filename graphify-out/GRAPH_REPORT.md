# Graph Report - docs  (2026-10-09)

## Corpus Check
- 38 files · ~353,192 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 459 nodes · 2027 edges · 12 communities
- Extraction: 84% EXTRACTED · 16% INFERRED · 0% AMBIGUOUS · INFERRED: 319 edges (avg confidence: 0.73)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- SP1 Engine Tasks & Modules
- History Screen
- SP1 Real-run Hardening
- New Clone Screen
- AI Settings Screen
- QA Preview Screen
- Editor & Parity Decisions
- Sitemap Screen
- Progress Screen
- Code Viewer Screen
- SP2/SP3 Future Scope
- E4 AI Chat

## God Nodes (most connected - your core abstractions)
1. `SP1 Clone Engine + UI` - 76 edges
2. `/ — Project History` - 65 edges
3. `AI chat in the visual editor: one request -> one validated batch of editor commands (source ai_editor), one Undo step` - 54 edges
4. `/p/[id]/preview — QA Preview & Compare (variant: Visual Diff & QA Compare 9410f8b12f0940bfa715f530a09abdfd)` - 52 edges
5. `/new — New Clone Configuration` - 49 edges
6. `/p/[id] — Clone Progress (phase stepper + SSE log + auth banner)` - 49 edges
7. `/settings/ai — AI Gateway & Provider Settings` - 47 edges
8. `/p/[id]/sitemap — Select Pages to Clone` - 47 edges
9. `Project history + checkpoint resume` - 45 edges
10. `Crawl (single page / same-origin BFS + sitemap)` - 41 edges

## Surprising Connections (you probably didn't know these)
- `Every workload bounded (hard limits, warn not hang)` --conceptually_related_to--> `Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers)`  [AMBIGUOUS]
  docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md → docs/superpowers/design/stitch/history-alt1.html
- `Fix patch that lowers score is reverted` --conceptually_related_to--> `'Auto-reconcile CSS' / Approve & Deploy one-click buttons`  [AMBIGUOUS]
  docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md → docs/superpowers/design/stitch/qa-preview.html
- `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` --conceptually_related_to--> `Drift: "Cloudflare Turnstile detected / headless browser clearance" banner + log wording`  [AMBIGUOUS]
  docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md → docs/superpowers/design/stitch/progress.html
- `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` --conceptually_related_to--> `Drift: "Configure Turnstile Bypass" button / "Turnstile pass" wording`  [AMBIGUOUS]
  docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md → docs/superpowers/design/stitch/sitemap.html
- `Drift: "Session Cookie Vault" / Save as preset` --conceptually_related_to--> `Secrets AES-256-GCM, key file outside workspace; never logged/sent to AI/in graph/output`  [AMBIGUOUS]
  docs/superpowers/design/stitch/new-clone.html → docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Anti-bot / Turnstile wording drift vs no-captcha-bypass rule** — drift_sitemap_turnstile_bypass, drift_progress_turnstile_wording, drift_history_cloudflare_bot, rule_no_captcha_bypass [AMBIGUOUS 0.30]
- **Auth flow: detect → needs_auth banner → manual window / auto-login → continue** — feat_auth, mod_auth, mod_browser, screen_progress, screen_new_clone, task_T8, rule_no_captcha_bypass, rule_secret_encryption [EXTRACTED 1.00]
- **QA gate pipeline: score → mandatory inspector → AI patch → revert on regression → preview** — feat_inspector, feat_qa_score, feat_fix_loop, screen_qa_preview, mod_qa, mod_inspector, rule_no_score_regression, task_T19, task_T20, task_T21 [EXTRACTED 1.00]
- **Checkpoint + resume flow** — feat_history_resume, feat_job_queue_sse, mod_jobs, mod_db, screen_history, screen_progress, task_T22, rule_no_progress_loss [EXTRACTED 1.00]
- **Auth handoff controls across screens** — ui_new_clone_auth_select, ui_sitemap_protected_banner, ui_progress_auth_banner, ui_history_inject_auth, feat_auth [INFERRED 0.85]
- **End-to-end clone flow: new clone -> sitemap -> progress -> QA preview -> code viewer** — screen_new_clone, screen_sitemap, screen_progress, screen_qa_preview, screen_code_viewer [INFERRED 0.85]
- **History resume flow: status filter, progress, resume action** — ui_history_status_filter, ui_history_progress_bar, ui_history_interrupted_resume, feat_history_resume, feat_job_queue_sse [INFERRED 0.85]
- **QA review loop: scores + heatmap -> fix request -> editor** — ui_qa_preview_section_scores, ui_qa_preview_heatmap_toggle, ui_qa_preview_fix_request, feat_qa_score, feat_fix_loop, screen_editor [INFERRED 0.85]
- **E4 chat turn: scope -> AI reply -> dry-run -> exclusiveEdit commit -> chat row** — mod_ai_chat_scope, mod_ai_chat, mod_chat_server, mod_chat_store, mod_chat_routes, mod_chat_panel [EXTRACTED 0.90]

## Communities (12 total, 0 thin omitted)

### Community 0 - "SP1 Engine Tasks & Modules"
Cohesion: 0.10
Nodes (51): src/core/assets.ts, src/core/auth.ts, src/core/browser.ts, src/core/capture.ts (+capture-eval.ts), src/core/crawl.ts, src/core/db.ts, src/core/dedupe.ts, src/core/emit-html.ts (+43 more)

### Community 1 - "History Screen"
Cohesion: 0.14
Nodes (30): §3 Tung man: bang element ui_* theo 8 man (settings-ai, history, new-clone, sitemap, progress, qa-preview, code-viewer, editor) + ma tran phu gap, §7 Kiem chung: so sanh thi giac, UI smoke, unit (Vitest), e2e backend, bao mat, cong hoan thanh, / — Project History, Delete project action, Download bundle action on completed job, ui_history_empty, Failed status with Error Log action, Inject Auth action on needs_auth job (+22 more)

### Community 10 - "SP1 Real-run Hardening"
Cohesion: 0.11
Nodes (18): §0 Bằng chứng lần chạy thật: E1 402→AI_BAD_CONFIG fail, E2 fix treo (fonts.ready không timeout), E3 editor 409 khi failed, E4 không log/lý do, E5 không xem được browser, E6 request AI 5.1 MB + section rác, §1 Lỗi AI: AI_QUOTA (402, không retry), thông báo gateway có provider/model/status/≤300 ký tự body đã lọc key; AI_AUTH/AI_QUOTA/AI_BAD_CONFIG dừng AI như BUDGET_EXCEEDED, project vẫn completed; breaker giữ nguyên; onRetry, §2 Không treo, dừng ngay: fonts.ready ≤10 s, page.evaluate ≤30 s → BROWSER_CRASH, trang clone chặn request ngoài loopback; Tạm dừng = dừng ngay (abort AI + đóng browser, running→pending); Xoá khi chạy chờ ≤15 s rồi 409 PROJECT_BUSY, §3 Khôi phục: Editor/Lưu/Gộp layout/Chạy lại QA nhận completed|failed|interrupted|paused khi emit done và không chạy; sitemap non-draft hiện dòng giải thích, §4 Hiển thị lỗi và log: projects.status_reason, error_msg cho task done kèm mã, workspace/<id>/run.log (redact, xoay 5 MB → run.prev.log, xoá cùng project), GET /api/projects/[id]/log, console [job <id8>], log vòng fix, banner lý do, panel Lỗi & cảnh báo, Tải log, bảng gợi ý error-hints.ts, §5 Hiện trình duyệt khi chạy: projectConfigSchema.headed (mặc định false), checkbox ở /new, mọi openBrowser của project truyền headed; CDP_URL vẫn ưu tiên; không liên quan anti-bot, §6 Độ trung thực + cỡ request AI: tải asset @font-face, splitSections đi vào wrapper chứa main + lọc node rác, ảnh AI rộng ≤1024 px tổng ≤1.5 MB, prompt đặt tên ≤24 000 ký tự, cảnh báo ngưỡng QA > 98%, §7 Không làm: không giải CAPTCHA/stealth, không drift_*, không giữ log sau khi xoá project, không SP2/SP3 (+10 more)

### Community 2 - "New Clone Screen"
Cohesion: 0.13
Nodes (37): icon copy/docs trên hàng completed, badge thumbnail DOM/SPA/AUTH/DOCS/HTML/ERR, "Target: DOM + CSS Assets", "Target: Full SPAs • SSR hydration dump", "HTML+Tailwind export • 18.4MB bundle • Zero diff errors", "ready • bundle exported", "Allocated for AST layout synthesis, multi-pass stylesheet reconciliation, and icon vectorization.", "Target AST dialect", "HIGH FIDELITY", "Polite rate limiting active", hint "limit/hops/workers", hậu tố "PGS/LVL/THRD", "TASK CONFIG 0X88F", "READY", "DOM v3 Parser • Headless Chromium", avatar "DX"/"WC"/"CL" (+29 more)

### Community 3 - "AI Settings Screen"
Cohesion: 0.14
Nodes (34): src/app/api/* + next.config.ts + layout.tsx, src/core/config.ts, src/core/crypto.ts, src/core/gateway.ts, "ID: prov_anthropic_v1 // status: 200 OK", badge "VLLM/OAI", "OLLAMA", "Cached 4 mins ago", "Sync: OK", "High Precision", "Low Latency", "Token Extractor" + mô tả vai trò sai (+26 more)

### Community 4 - "QA Preview Screen"
Cohesion: 0.17
Nodes (26): "Pixel QA 1 Diff", "card-hero.tsx:42" (output là HTML thuần), "SYNTHESIS COVERAGE CHECKLIST", "verified", "untriggered", QA rescore endpoint (POST …/qa/rescore), /p/[id]/preview — QA Preview & Compare (variant: Visual Diff & QA Compare 9410f8b12f0940bfa715f530a09abdfd), §14 Tiêu chí hoàn thành SP1, T26: Fixtures + full E2E, Breakpoint switch 375/768/1440px (+18 more)

### Community 5 - "Editor & Parity Decisions"
Cohesion: 0.11
Nodes (34): src/core/grapes-adapter.ts, src/app/**/page.tsx (7 screens), src/app/_ui/icons.gen.ts (commit) + scripts/gen-icons.mjs - subset Material Symbols Outlined sinh luc build tu @material-symbols/svg-400, src/app/_ui (Shell.tsx, icons.gen.ts, shared UI), §0 Boi canh, muc tieu, pham vi (UI parity): dua UI SP1 ve ngang Stitch bo cuc + he thi giac, giu nguyen bat bien ky thuat SP1, §1 Design tokens: mau (--c-*), chu (--t-*), radius (--r-*), spacing (--s-*), mat do, motion, focus, icon self-host, §2 App shell (header 56px + sidebar 224px) + component dung chung src/app/_ui/*, §6 Cap nhat tai lieu + graph: viet lai stitch-screens.md muc element, dong bo drift-list.md, spec SP1 §10 tro qua, plan rieng, chay /graphify docs --update (+26 more)

### Community 6 - "Sitemap Screen"
Cohesion: 0.17
Nodes (27): "Inject Cookies (.har)" (bản hợp lệ = cookie/storageState JSON), "Stage 3: AST Scoping", Cost/runtime estimation (estimateRun, core/estimate.ts), Stitch mockup: Sitemap Scope Configuration, src/core/estimate.ts, src/app/p/[id]/sitemap/route-tree.ts (thuan) - buildRouteTree(pages), folder ao + tri-state, /p/[id]/sitemap — Select Pages to Clone, "Cancel" (+19 more)

### Community 7 - "Progress Screen"
Cohesion: 0.17
Nodes (33): src/app/_ui/error-hints.ts - ERROR_HINTS + hintFor(code), đúng bảng spec §4, src/core/run-log.ts - appendRunLog/readRunLog, workspace/<id>/run.log, xoay 5 MB → run.prev.log, không tạo lại thư mục, "[worker#01]", "Thread #04", "stdout & ast-worker.log PID 4921", Error surfacing: status_reason, run.log + download, reason banner, Lỗi & cảnh báo panel, hint table, Persisted SSE event log (core/event-log.ts), Stitch mockup: Clone Progress, src/core/event-log.ts, src/core/jobs-base.ts - JobEvent/StampedEvent (at epoch ms), redact dung chung chuyen tu jobs.ts (+25 more)

### Community 8 - "Code Viewer Screen"
Cohesion: 0.29
Nodes (17): "Build Successful", "HTML5/UTF-8", nút "Export Package" (trùng Export ZIP), Stitch mockup: Export - Source Browser, /p/[id]/code — Export - Source Browser, Build status footer (files, size), Read-only code pane with line numbers, Copy file button (+9 more)

### Community 9 - "SP2/SP3 Future Scope"
Cohesion: 0.33
Nodes (3): /p/[id]/export — Export + architecture selection (SP2, planned, not yet designed), §0 Bối cảnh và phạm vi, §12 Phác thảo SP3 — Design

### Community 11 - "E4 AI Chat"
Cohesion: 0.10
Nodes (27): E4 §0 Mục tiêu và quyết định đã chốt, E4 §1 Kiến trúc và luồng một lượt, E4 §2 Phạm vi, context và tool, E4 §3 Trả lời của AI và quy tắc lệnh, E4 §4 Lưu chat và API, E4 §5 UI — tab "AI", E4 §6 Giới hạn cứng, E4 §7 Lỗi (+19 more)

## Ambiguous Edges - Review These
- `Drift: Cluster us-east-core / concurrency 8 jobs / telemetry / Tokens & Budget sidebar` → `Every workload bounded (hard limits, warn not hang)`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history.html · relation: conceptually_related_to
- `Every workload bounded (hard limits, warn not hang)` → `Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers)`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt1.html · relation: conceptually_related_to
- `Fix patch that lowers score is reverted` → `'Auto-reconcile CSS' / Approve & Deploy one-click buttons`  [AMBIGUOUS]
  docs/superpowers/design/stitch/qa-preview.html · relation: conceptually_related_to
- `Drift: "Cloudflare Bot Management Challenge" failed row wording` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history.html · relation: conceptually_related_to
- `'Inject Auth' button on Cloudflare Turnstile challenge row` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt1.html · relation: conceptually_related_to
- `'Puppeteer Stealth' engine filter option (anti-bot evasion)` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt3.html · relation: conceptually_related_to
- `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` → `Drift: "Cloudflare Turnstile detected / headless browser clearance" banner + log wording`  [AMBIGUOUS]
  docs/superpowers/design/stitch/progress.html · relation: conceptually_related_to
- `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` → `Drift: "Configure Turnstile Bypass" button / "Turnstile pass" wording`  [AMBIGUOUS]
  docs/superpowers/design/stitch/sitemap.html · relation: conceptually_related_to
- `Drift: "Session Cookie Vault" / Save as preset` → `Secrets AES-256-GCM, key file outside workspace; never logged/sent to AI/in graph/output`  [AMBIGUOUS]
  docs/superpowers/design/stitch/new-clone.html · relation: conceptually_related_to
- `Drift: "Stored with AES-256 GCM in local daemon vault" wording` → `Secrets AES-256-GCM, key file outside workspace; never logged/sent to AI/in graph/output`  [AMBIGUOUS]
  docs/superpowers/design/stitch/settings-ai.html · relation: conceptually_related_to

## Knowledge Gaps
- **3 isolated node(s):** `E4 §0 Mục tiêu và quyết định đã chốt`, `E4 §7 Lỗi`, `E4 §9 Test`
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 7 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Drift: Cluster us-east-core / concurrency 8 jobs / telemetry / Tokens & Budget sidebar` and `Every workload bounded (hard limits, warn not hang)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `SP1 Clone Engine + UI` connect `SP1 Engine Tasks & Modules` to `History Screen`, `New Clone Screen`, `AI Settings Screen`, `QA Preview Screen`, `Editor & Parity Decisions`, `Sitemap Screen`, `Progress Screen`, `Code Viewer Screen`, `SP2/SP3 Future Scope`, `SP1 Real-run Hardening`, `E4 AI Chat`?**
  _High betweenness centrality (0.274) - this node is a cross-community bridge._
- **Are the 7 inferred relationships involving `/ — Project History` (e.g. with `Stitch design system (dark, Space Grotesk/Inter/JetBrains Mono, indigo #6366F1)` and `header h-14`) actually correct?**
  _`/ — Project History` has 7 INFERRED edges - model-reasoned connections that need verification._
- **What connects `E4 §0 Mục tiêu và quyết định đã chốt`, `E4 §7 Lỗi`, `E4 §9 Test` to the rest of the system?**
  _3 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `SP1 Engine Tasks & Modules` be split into smaller, more focused modules?**
  _Cohesion score 0.09769335142469471 - nodes in this community are weakly interconnected._
- **What is the exact relationship between `Every workload bounded (hard limits, warn not hang)` and `Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `AI chat in the visual editor: one request -> one validated batch of editor commands (source ai_editor), one Undo step` connect `E4 AI Chat` to `SP1 Engine Tasks & Modules`, `History Screen`, `AI Settings Screen`, `Editor & Parity Decisions`?**
  _High betweenness centrality (0.161) - this node is a cross-community bridge._