# Graph Report - docs  (2026-09-23)

## Corpus Check
- 25 files · ~166,203 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 222 nodes · 657 edges · 10 communities
- Extraction: 82% EXTRACTED · 17% INFERRED · 2% AMBIGUOUS · INFERRED: 111 edges (avg confidence: 0.93)
- Token cost: 211,869 input · 0 output

## Community Hubs (Navigation)
- Stitch Drift: Anti-bot & Fake Telemetry
- Capture & Browser Layer
- New Clone, Crawl & Auth
- QA Preview & Interaction Coverage
- IR, Graph & HTML Emit
- UI Shell, Editor & Export
- AI Gateway Settings
- Inspector & Fix Loop
- Foundation: DB, Jobs, Gateway Core
- Planned SP2/SP3 Scope

## God Nodes (most connected - your core abstractions)
1. `SP1 Clone Engine + UI` - 67 edges
2. `/ — Project History` - 38 edges
3. `Project history + checkpoint resume` - 27 edges
4. `/p/[id]/preview — QA Preview & Compare (variant: Visual Diff & QA Compare 9410f8b12f0940bfa715f530a09abdfd)` - 27 edges
5. `AI Gateway (Anthropic/OpenAI compatible providers)` - 25 edges
6. `Bounded job queue + task checkpoint + SSE progress` - 24 edges
7. `/new — New Clone Configuration` - 24 edges
8. `QA pixel-diff score per section × breakpoint` - 23 edges
9. `Auth detection + manual/auto login + session` - 22 edges
10. `/settings/ai — AI Gateway & Provider Settings` - 21 edges

## Surprising Connections (you probably didn't know these)
- `Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers)` --conceptually_related_to--> `Every workload bounded (hard limits, warn not hang)`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt1.html → docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md
- `Token budget + est. cost` --references--> `AI Gateway (Anthropic/OpenAI compatible providers)`  [INFERRED]
  docs/superpowers/design/stitch/new-clone.html → docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md
- `Action Required: page needs login + Open Window / Continue` --references--> `Auth detection + manual/auto login + session`  [INFERRED]
  docs/superpowers/design/stitch/progress.html → docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md
- `Breakpoint switch 375/768/1440px` --references--> `Responsive capture 375/768/1440 + screenshots`  [INFERRED]
  docs/superpowers/design/stitch/qa-preview.html → docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md
- `Export / Approve & Deploy action` --references--> `Code view + export ZIP / folder`  [INFERRED]
  docs/superpowers/design/stitch/qa-preview.html → docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **QA gate pipeline: score → mandatory inspector → AI patch → revert on regression → preview** — feat_inspector, feat_qa_score, feat_fix_loop, screen_qa_preview, mod_qa, mod_inspector, rule_no_score_regression, task_T19, task_T20, task_T21 [EXTRACTED 1.00]
- **Checkpoint + resume flow** — feat_history_resume, feat_job_queue_sse, mod_jobs, mod_db, screen_history, screen_progress, task_T22, rule_no_progress_loss [EXTRACTED 1.00]
- **Auth flow: detect → needs_auth banner → manual window / auto-login → continue** — feat_auth, mod_auth, mod_browser, screen_progress, screen_new_clone, task_T8, rule_no_captcha_bypass, rule_secret_encryption [EXTRACTED 1.00]
- **End-to-end clone flow: new clone -> sitemap -> progress -> QA preview -> code viewer** — screen_new_clone, screen_sitemap, screen_progress, screen_qa_preview, screen_code_viewer [INFERRED 0.85]
- **Auth handoff controls across screens** — ui_new_clone_auth_select, ui_sitemap_protected_banner, ui_progress_auth_banner, ui_history_inject_auth, feat_auth [INFERRED 0.85]
- **Anti-bot / Turnstile wording drift vs no-captcha-bypass rule** — drift_sitemap_turnstile_bypass, drift_progress_turnstile_wording, drift_history_cloudflare_bot, rule_no_captcha_bypass [AMBIGUOUS 0.30]
- **QA review loop: scores + heatmap -> fix request -> editor** — ui_qa_preview_section_scores, ui_qa_preview_heatmap_toggle, ui_qa_preview_fix_request, feat_qa_score, feat_fix_loop, screen_editor [INFERRED 0.85]
- **History resume flow: status filter, progress, resume action** — ui_history_status_filter, ui_history_progress_bar, ui_history_interrupted_resume, feat_history_resume, feat_job_queue_sse [INFERRED 0.85]

## Communities (10 total, 0 thin omitted)

### Community 0 - "Stitch Drift: Anti-bot & Fake Telemetry"
Cohesion: 0.08
Nodes (39): Drift: "Cloudflare Bot Management Challenge" failed row wording, Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers), Drift: Engine filter (Playwright DOM / Puppeteer / Static Wget AST), Fake engine filter (Chromium Headless, Playwright Spider, Wasm Synthesizer) / Engine Pool, 'Inject Auth' button on Cloudflare Turnstile challenge row, Invented nav (Engines, DOM Rules, Tokens & Budget, Telemetry, Keyring & Auth, Run Test, Deploy Clone, CLONE//ARCH branding), Drift: Extra nav items: Configure/Pipeline/Artifacts/Audit, Deploy Clone, 'Puppeteer Stealth' engine filter option (anti-bot evasion) (+31 more)

### Community 1 - "Capture & Browser Layer"
Cohesion: 0.20
Nodes (29): Asset download + sha256 dedupe, DOM + computed style capture, Responsive capture 375/768/1440 + screenshots, src/core/assets.ts, src/core/auth.ts, src/core/browser.ts, src/core/capture.ts (+capture-eval.ts), src/core/crawl.ts (+21 more)

### Community 2 - "New Clone, Crawl & Auth"
Cohesion: 0.12
Nodes (27): Drift: Fake footer telemetry (PIPELINE SYNTH_CHROMIUM_V8, cluster us-east-1a, DNS IP), Drift: Output format "Figma Tokens (DTCG schema)" and "Markdown" options, Drift: Extra nav items: Configure/Pipeline/Artifacts/Audit, Deploy Clone, Engine Pool, Drift: Capture telemetry columns (cached, asset KB) and Engine DOM v3 + Tailwind JIT, Drift: Extra nav: Projects/Pipelines/Diff QA/Templates/Execution IR/Asset Store, Auth detection + manual/auto login + session, Crawl (single page / same-origin BFS + sitemap), Stitch mockup: New Clone Configuration (+19 more)

### Community 3 - "QA Preview & Interaction Coverage"
Cohesion: 0.14
Nodes (22): 'Auto-reconcile CSS' / Approve & Deploy one-click buttons, Fake engine labels (Puppeteer Headless, Vite + Tailwind JIT, AST v3.1, DPR 2.0x), Fake status-bar telemetry (AST Worker Node #4, DOM nodes, latency, memory), Invented nav/sidebar (Projects, Pipelines, Templates, Execution IR, Asset Store, System Logs, Terminal CLI, PID), Hidden interaction scan (hover/menu/tab/accordion/modal/carousel/sticky/form), QA pixel-diff score per section × breakpoint, Measure instead of trust: pixel diff per section×bp is mandatory gate; coverage checklist, /p/[id]/preview — QA Preview & Compare (variant: Visual Diff & QA Compare 9410f8b12f0940bfa715f530a09abdfd) (+14 more)

### Community 4 - "IR, Graph & HTML Emit"
Cohesion: 0.23
Nodes (22): HTML/CSS/runtime JS emitter, Graph store (SQLite nodes/edges) + bounded context queries, IR build + section split + style dedupe + applyPatch, AI section naming (1 call/page), src/core/dedupe.ts, src/core/emit-html.ts, src/core/graph.ts, src/core/ir.ts (+14 more)

### Community 5 - "UI Shell, Editor & Export"
Cohesion: 0.19
Nodes (21): Stitch design system (dark, Space Grotesk/Inter/JetBrains Mono, indigo #6366F1), Drift: "DevBrowser static generator" branding and nav, Drift: Git tab / "main branch" / Synced 2m ago, GrapesJS visual editor + IR adapter, Code view + export ZIP / folder, Stitch mockup: Export - Source Browser, src/core/grapes-adapter.ts, src/app/**/page.tsx (7 screens) (+13 more)

### Community 6 - "AI Gateway Settings"
Cohesion: 0.16
Nodes (19): Drift: "Session Cookie Vault" / Save as preset, Drift: "Stored with AES-256 GCM in local daemon vault" wording, Drift: Audit Logs / Export Config (JSON) footer links, Drift: Failover strategy / fallback router to local vLLM, Drift: Hardcoded model ids (claude-3-7-sonnet-20250219, gpt-4o, qwen-2.5-coder), Drift: Upstream Telemetry panel (requests/error rate/latency, uptime, gateway port), AI Gateway (Anthropic/OpenAI compatible providers), Stitch mockup: AI Gateway & Providers (+11 more)

### Community 7 - "Inspector & Fix Loop"
Cohesion: 0.26
Nodes (15): Drift: Cluster us-east-core / concurrency 8 jobs / telemetry / Tokens & Budget sidebar, AI fix loop (JSON patch IR), Inspector commands (a11y, screenshot, hover, click, readStyle), src/core/inspector.ts, src/core/qa.ts, Every workload bounded (hard limits, warn not hang), Fix patch that lowers score is reverted, Keep best-scoring version across fix rounds (+7 more)

### Community 8 - "Foundation: DB, Jobs, Gateway Core"
Cohesion: 0.32
Nodes (12): src/app/api/* + next.config.ts + layout.tsx, src/core/config.ts, src/core/crypto.ts, src/core/db.ts, src/core/gateway.ts, src/core/jobs.ts, Dependency direction app→core; jobs→(crawl|capture|qa|emit)→(browser|graph|ir|gateway); core never imports app, §2 AI Gateway (+4 more)

### Community 9 - "Planned SP2/SP3 Scope"
Cohesion: 0.29
Nodes (11): Frontend architecture selection (SP2, planned), Design web/mobile with ui-ux-pro-max + rule gate (SP3, planned), Framework emitters React/Next/Vue/WordPress + templates (SP2, planned), Architecture rules in graph + lint, graphify + SETUP.md (SP2, planned), No progress loss: small-task checkpoints, power-loss-safe writes, resumable, /p/[id]/export — Export + architecture selection (SP2, planned, not yet designed), SP2 Framework emitters + frontend architecture (planned), SP3 Design web/mobile (planned) (+3 more)

## Ambiguous Edges - Review These
- `Every workload bounded (hard limits, warn not hang)` → `Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers)`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt1.html · relation: conceptually_related_to
- `Every workload bounded (hard limits, warn not hang)` → `Drift: Cluster us-east-core / concurrency 8 jobs / telemetry / Tokens & Budget sidebar`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history.html · relation: conceptually_related_to
- `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` → `Drift: "Cloudflare Bot Management Challenge" failed row wording`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history.html · relation: conceptually_related_to
- `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` → `'Inject Auth' button on Cloudflare Turnstile challenge row`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt1.html · relation: conceptually_related_to
- `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` → `'Puppeteer Stealth' engine filter option (anti-bot evasion)`  [AMBIGUOUS]
  docs/superpowers/design/stitch/history-alt3.html · relation: conceptually_related_to
- `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` → `Drift: "Cloudflare Turnstile detected / headless browser clearance" banner + log wording`  [AMBIGUOUS]
  docs/superpowers/design/stitch/progress.html · relation: conceptually_related_to
- `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` → `Drift: "Configure Turnstile Bypass" button / "Turnstile pass" wording`  [AMBIGUOUS]
  docs/superpowers/design/stitch/sitemap.html · relation: conceptually_related_to
- `Secrets AES-256-GCM, key file outside workspace; never logged/sent to AI/in graph/output` → `Drift: "Session Cookie Vault" / Save as preset`  [AMBIGUOUS]
  docs/superpowers/design/stitch/new-clone.html · relation: conceptually_related_to
- `Secrets AES-256-GCM, key file outside workspace; never logged/sent to AI/in graph/output` → `Drift: "Stored with AES-256 GCM in local daemon vault" wording`  [AMBIGUOUS]
  docs/superpowers/design/stitch/settings-ai.html · relation: conceptually_related_to
- `Fix patch that lowers score is reverted` → `'Auto-reconcile CSS' / Approve & Deploy one-click buttons`  [AMBIGUOUS]
  docs/superpowers/design/stitch/qa-preview.html · relation: conceptually_related_to

## Knowledge Gaps
- **5 isolated node(s):** `Stitch mockup: AI Gateway & Providers`, `Stitch mockup: New Clone Configuration`, `Stitch mockup: Sitemap Scope Configuration`, `Stitch mockup: Clone Progress`, `Stitch mockup: Export - Source Browser`
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 25 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Every workload bounded (hard limits, warn not hang)` and `Fake cluster metrics (us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Every workload bounded (hard limits, warn not hang)` and `Drift: Cluster us-east-core / concurrency 8 jobs / telemetry / Tokens & Budget sidebar`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` and `Drift: "Cloudflare Bot Management Challenge" failed row wording`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` and `'Inject Auth' button on Cloudflare Turnstile challenge row`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` and `'Puppeteer Stealth' engine filter option (anti-bot evasion)`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` and `Drift: "Cloudflare Turnstile detected / headless browser clearance" banner + log wording`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `No CAPTCHA solving / fingerprint spoofing / anti-bot bypass; user solves manually` and `Drift: "Configure Turnstile Bypass" button / "Turnstile pass" wording`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._