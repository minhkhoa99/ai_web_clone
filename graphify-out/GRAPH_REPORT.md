# Graph Report - docs  (2026-09-26)

## Corpus Check
- 27 files · ~230,301 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 364 nodes · 1620 edges · 10 communities
- Extraction: 82% EXTRACTED · 18% INFERRED · 1% AMBIGUOUS · INFERRED: 285 edges (avg confidence: 0.72)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- SP1 Engine Tasks & Modules
- History Screen
- New Clone Screen
- AI Settings Screen
- QA Preview Screen
- Editor & Parity Decisions
- Sitemap Screen
- Progress Screen
- Code Viewer Screen
- SP2/SP3 Future Scope

## God Nodes (most connected - your core abstractions)
1. `SP1 Clone Engine + UI` - 67 edges
2. `/ — Project History` - 65 edges
3. `/p/[id]/preview — QA Preview & Compare (variant: Visual Diff & QA Compare 9410f8b12f0940bfa715f530a09abdfd)` - 52 edges
4. `/new — New Clone Configuration` - 47 edges
5. `/settings/ai — AI Gateway & Provider Settings` - 47 edges
6. `/p/[id] — Clone Progress (phase stepper + SSE log + auth banner)` - 46 edges
7. `/p/[id]/sitemap — Select Pages to Clone` - 46 edges
8. `Project history + checkpoint resume` - 41 edges
9. `Crawl (single page / same-origin BFS + sitemap)` - 39 edges
10. `Bounded job queue + task checkpoint + SSE progress` - 37 edges

## Surprising Connections (you probably didn't know these)
- `Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers)` --conceptually_related_to--> `Every workload bounded (hard limits, warn not hang)`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt1.html → docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md
- `Drift: "Cloudflare Turnstile detected / headless browser clearance" banner + log wording` --conceptually_related_to--> `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/progress.html → docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md
- `Drift: "Configure Turnstile Bypass" button / "Turnstile pass" wording` --conceptually_related_to--> `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/sitemap.html → docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md
- `'Auto-reconcile CSS' / Approve & Deploy one-click buttons` --conceptually_related_to--> `Fix patch that lowers score is reverted`  [AMBIGUOUS]
  docs/superpowers/design/stitch/qa-preview.html → docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md
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

## Communities (10 total, 0 thin omitted)

### Community 0 - "SP1 Engine Tasks & Modules"
Cohesion: 0.10
Nodes (67): Drift: Cluster us-east-core / concurrency 8 jobs / telemetry / Tokens & Budget sidebar, Asset download + sha256 dedupe, DOM + computed style capture, AI fix loop (JSON patch IR), Graph store (SQLite nodes/edges) + bounded context queries, Inspector commands (a11y, screenshot, hover, click, readStyle), IR build + section split + style dedupe + applyPatch, Responsive capture 375/768/1440 + screenshots (+59 more)

### Community 1 - "History Screen"
Cohesion: 0.14
Nodes (41): Drift: "Cloudflare Bot Management Challenge" failed row wording, Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers), Drift: Engine filter (Playwright DOM / Puppeteer / Static Wget AST), Fake engine filter (Chromium Headless, Playwright Spider, Wasm Synthesizer) / Engine Pool, 'Inject Auth' button on Cloudflare Turnstile challenge row, Invented nav (Engines, DOM Rules, Tokens & Budget, Telemetry, Keyring & Auth, Run Test, Deploy Clone, CLONE//ARCH branding), Drift: Extra nav items: Configure/Pipeline/Artifacts/Audit, Deploy Clone, 'Puppeteer Stealth' engine filter option (anti-bot evasion) (+33 more)

### Community 2 - "New Clone Screen"
Cohesion: 0.15
Nodes (40): icon copy/docs trên hàng completed, badge thumbnail DOM/SPA/AUTH/DOCS/HTML/ERR, "Target: DOM + CSS Assets", "Target: Full SPAs • SSR hydration dump", "HTML+Tailwind export • 18.4MB bundle • Zero diff errors", "ready • bundle exported", "Allocated for AST layout synthesis, multi-pass stylesheet reconciliation, and icon vectorization.", "Target AST dialect", Drift: "Session Cookie Vault" / Save as preset, Drift: Fake footer telemetry (PIPELINE SYNTH_CHROMIUM_V8, cluster us-east-1a, DNS IP), "HIGH FIDELITY", Drift: Output format "Figma Tokens (DTCG schema)" and "Markdown" options (+32 more)

### Community 3 - "AI Settings Screen"
Cohesion: 0.14
Nodes (42): Drift: "Stored with AES-256 GCM in local daemon vault" wording, Drift: Audit Logs / Export Config (JSON) footer links, "ID: prov_anthropic_v1 // status: 200 OK", badge "VLLM/OAI", "OLLAMA", Drift: Failover strategy / fallback router to local vLLM, Drift: Hardcoded model ids (claude-3-7-sonnet-20250219, gpt-4o, qwen-2.5-coder), "Cached 4 mins ago", "Sync: OK", "High Precision", "Low Latency", "Token Extractor" + mô tả vai trò sai (+34 more)

### Community 4 - "QA Preview Screen"
Cohesion: 0.17
Nodes (37): 'Auto-reconcile CSS' / Approve & Deploy one-click buttons, Fake engine labels (Puppeteer Headless, Vite + Tailwind JIT, AST v3.1, DPR 2.0x), Fake status-bar telemetry (AST Worker Node #4, DOM nodes, latency, memory), Invented nav/sidebar (Projects, Pipelines, Templates, Execution IR, Asset Store, System Logs, Terminal CLI, PID), "Pixel QA 1 Diff", "card-hero.tsx:42" (output là HTML thuần), "SYNTHESIS COVERAGE CHECKLIST", "verified", "untriggered", Hidden interaction scan (hover/menu/tab/accordion/modal/carousel/sticky/form) (+29 more)

### Community 5 - "Editor & Parity Decisions"
Cohesion: 0.14
Nodes (35): Stitch design system (dark, Space Grotesk/Inter/JetBrains Mono, indigo #6366F1), GrapesJS visual editor + IR adapter, src/core/grapes-adapter.ts, src/app/_ui/icons.gen.ts (commit) + scripts/gen-icons.mjs - subset Material Symbols Outlined sinh luc build tu @material-symbols/svg-400, src/app/_ui (Shell.tsx, icons.gen.ts, shared UI), src/app/**/page.tsx (7 screens), D1: tự host icon Material Symbols, D2: Nut filled primary = nen primary #c0c1ff + chu on-primary #1000a9 (hover primary-fixed); primary-container/on-primary-container dung cho accent fill (+27 more)

### Community 6 - "Sitemap Screen"
Cohesion: 0.18
Nodes (35): Drift: Capture telemetry columns (cached, asset KB) and Engine DOM v3 + Tailwind JIT, Drift: Extra nav: Projects/Pipelines/Diff QA/Templates/Execution IR/Asset Store, "Inject Cookies (.har)" (bản hợp lệ = cookie/storageState JSON), "Stage 3: AST Scoping", Drift: "Configure Turnstile Bypass" button / "Turnstile pass" wording, Auth detection + manual/auto login + session, Crawl (single page / same-origin BFS + sitemap), Cost/runtime estimation (estimateRun, core/estimate.ts) (+27 more)

### Community 7 - "Progress Screen"
Cohesion: 0.19
Nodes (31): Drift: Fake system telemetry (Mem/CPU/Network, socket :9422, worker threads), Drift: "Cloudflare Turnstile detected / headless browser clearance" banner + log wording, "[worker#01]", "Thread #04", "stdout & ast-worker.log PID 4921", Bounded job queue + task checkpoint + SSE progress, Persisted SSE event log (core/event-log.ts), Stitch mockup: Clone Progress, src/core/event-log.ts, src/core/jobs-base.ts - JobEvent/StampedEvent (at epoch ms), redact dung chung chuyen tu jobs.ts (+23 more)

### Community 8 - "Code Viewer Screen"
Cohesion: 0.29
Nodes (21): "Build Successful", Drift: "DevBrowser static generator" branding and nav, "HTML5/UTF-8", nút "Export Package" (trùng Export ZIP), Drift: Git tab / "main branch" / Synced 2m ago, HTML/CSS/runtime JS emitter, Code view + export ZIP / folder, Stitch mockup: Export - Source Browser (+13 more)

### Community 9 - "SP2/SP3 Future Scope"
Cohesion: 0.33
Nodes (10): Frontend architecture selection (SP2, planned), Design web/mobile with ui-ux-pro-max + rule gate (SP3, planned), Framework emitters React/Next/Vue/WordPress + templates (SP2, planned), Architecture rules in graph + lint, graphify + SETUP.md (SP2, planned), No progress loss: small-task checkpoints, power-loss-safe writes, resumable, /p/[id]/export — Export + architecture selection (SP2, planned, not yet designed), SP2 Framework emitters + frontend architecture (planned), SP3 Design web/mobile (planned) (+2 more)

## Ambiguous Edges - Review These
- `Drift: "Cloudflare Bot Management Challenge" failed row wording` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history.html · relation: conceptually_related_to
- `Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers)` → `Every workload bounded (hard limits, warn not hang)`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt1.html · relation: conceptually_related_to
- `'Inject Auth' button on Cloudflare Turnstile challenge row` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt1.html · relation: conceptually_related_to
- `'Puppeteer Stealth' engine filter option (anti-bot evasion)` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt3.html · relation: conceptually_related_to
- `Drift: "Cloudflare Turnstile detected / headless browser clearance" banner + log wording` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/progress.html · relation: conceptually_related_to
- `Drift: "Configure Turnstile Bypass" button / "Turnstile pass" wording` → `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`  [AMBIGUOUS]
  docs/superpowers/design/stitch/sitemap.html · relation: conceptually_related_to
- `'Auto-reconcile CSS' / Approve & Deploy one-click buttons` → `Fix patch that lowers score is reverted`  [AMBIGUOUS]
  docs/superpowers/design/stitch/qa-preview.html · relation: conceptually_related_to
- `Drift: "Session Cookie Vault" / Save as preset` → `Secrets AES-256-GCM, key file outside workspace; never logged/sent to AI/in graph/output`  [AMBIGUOUS]
  docs/superpowers/design/stitch/new-clone.html · relation: conceptually_related_to
- `Drift: "Stored with AES-256 GCM in local daemon vault" wording` → `Secrets AES-256-GCM, key file outside workspace; never logged/sent to AI/in graph/output`  [AMBIGUOUS]
  docs/superpowers/design/stitch/settings-ai.html · relation: conceptually_related_to
- `Drift: Cluster us-east-core / concurrency 8 jobs / telemetry / Tokens & Budget sidebar` → `Every workload bounded (hard limits, warn not hang)`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history.html · relation: conceptually_related_to

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Drift: "Cloudflare Bot Management Challenge" failed row wording` and `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers)` and `Every workload bounded (hard limits, warn not hang)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `'Inject Auth' button on Cloudflare Turnstile challenge row` and `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `'Puppeteer Stealth' engine filter option (anti-bot evasion)` and `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Drift: "Cloudflare Turnstile detected / headless browser clearance" banner + log wording` and `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Drift: "Configure Turnstile Bypass" button / "Turnstile pass" wording` and `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `'Auto-reconcile CSS' / Approve & Deploy one-click buttons` and `Fix patch that lowers score is reverted`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._