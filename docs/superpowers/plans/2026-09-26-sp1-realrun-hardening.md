# SP1 real-run hardening — implementation plan

**Spec:** `docs/superpowers/specs/2026-09-26-sp1-realrun-hardening-design.md` (binding; overrides the SP1 spec where they conflict). Read the sections each task names.
**Branch:** `sp1-clone-engine`. BASE for the plan: `6edc257`.

## Global Constraints

- TDD: failing test first, then code. Unit tests in `tests/unit/`, e2e (real Chromium / Next) in `tests/e2e/`. Run with `npx vitest run <file>` / `npx vitest run -c vitest.e2e.config.ts <file>`.
- Done criteria per task: `npx tsc --noEmit` clean; the task's new/changed tests green; full `npx vitest run` green. Tasks touching Next routes/UI also run the affected e2e files.
- `src/core/` never imports `src/app/`. `ir`, `emit-html`, dedupe, `applyPatch` stay pure.
- Every workload bounded; no `Promise.all` over an unbounded array.
- Secrets (API keys, login credentials) never appear in logs, events, error messages, `run.log`, or anything sent to AI. Everything written to logs goes through `redact(projectId, …)`.
- No CAPTCHA solving, stealth or fingerprint change (`rule_no_captcha_bypass`). No `drift_*`. No SP2/SP3 features.
- UI copy in Vietnamese exactly as the spec gives it. New UI reuses existing `_ui` components and `globals.css` tokens (Stitch parity spec). Every new visible element gets a `data-ui="ui_…"` id listed in the task.
- Commits: focused, message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Never `git add -A`. Never stage `next-env.d.ts`, `passcaptchar/`, `rules.md`, `.playwright-mcp/`. If `next-env.d.ts` changes after a dev/build run, `git checkout -- next-env.d.ts`.
- Keep the surrounding code style: short comments explaining why, no new dependencies.

## Task 1: Gateway — `AI_QUOTA`, informative errors, retry callback (spec §1)

Files: `src/core/errors.ts`, `src/core/gateway.ts`, `tests/unit/gateway.test.ts`, `tests/unit/errors.test.ts` if it enumerates codes.

- Add `AI_QUOTA: "AI_QUOTA"` to `Codes`.
- `mapHttpError`: 402 → `{ code: "AI_QUOTA", retryable: false }`; keep the rest (429 rate limit retryable; 401/403 AI_AUTH; other 4xx AI_BAD_CONFIG; else AI_BAD_RESPONSE retryable).
- On a non-ok final response in `generate`: read the body text (`await res.text().catch(() => "")`), build `excerpt` = body with the API key string removed (`split(apiKey).join("[redacted]")` when the key is non-empty), whitespace collapsed, cut to 300 chars. Message: `provider "<name>" model "<model>" returned status <status>: <excerpt>` (omit `: <excerpt>` when empty). Context gets `model` too. Same body excerpt in `fetchModels` failures (`fetchModels failed with status <s>: <excerpt>`).
- Network error message: `network error calling provider "<name>" model "<model>": <e.message>` (no URL query strings with keys — the URL has none; keep context as is).
- `GenerateOptions` gains optional `onRetry?: (info: { attempt: number; status?: number; error?: string; delayMs: number }) => void`, called before each retry sleep. Also optional `signal?: AbortSignal`: combined with the timeout via `AbortSignal.any([opts.signal, AbortSignal.timeout(TIMEOUT_MS)])`; when `opts.signal.aborted`, throw the abort reason immediately (no retry, no sleep).
- Tests: 402 → AI_QUOTA and no retry (fetch called once); message contains model id and body excerpt, never the key (key placed in the fake body); excerpt cut at 300; onRetry called with status 500 then succeeds; aborted signal → rejects without retrying.

## Task 2: Persistent AI errors stop AI, project completes (spec §1)

Files: `src/core/jobs.ts`, `src/core/qa-fix.ts`, `src/core/naming.ts` (only if needed to surface the message), tests `tests/unit/` (jobs unit tests with fake deps — find the existing jobs/qa-fix unit tests and extend them), `tests/e2e/qa-fixloop.test.ts` if it covers fixAll errors.

- `const STOP_AI = new Set([Codes.AI_AUTH, Codes.AI_QUOTA, Codes.AI_BAD_CONFIG])` (export from qa-fix or a shared place in core; one definition).
- `fixSection`: on an error whose code is in STOP_AI (from `proposeOps`), set `stop.ai = { code, message }` (extend the shared `stop` object) and return `result("ai_stopped")` keeping the best score so far. Before each round: if `stop.ai` is set, return `result("ai_stopped")`. `FixResult.status` union gains `"ai_stopped"`; `FixResult` gains optional `errorCode` / `errorMessage` set for that status. If the very first `scoreIr` never succeeded, the error still propagates (non-AI error path unchanged).
- `fixAll` no longer rejects for STOP_AI codes (they are absorbed per section as above). Other errors behave as before.
- `runFixes`: after `fixAll`, for each task, if its result is `ai_stopped` → `finishTask` with marker = code and store the message in `error_msg` (extend `finishTask` with an optional message param; it writes `error_msg`). Emit one `log warn`: `AI dừng: <code> — <message>`. Set `run.aiStopped = { code, message }`. Project still completes; at completion, if `run.aiStopped` or any budget/name marker exists, `status_reason` gets the code (Task 5 adds the column — here just pass `reason` to the completed status event and leave a TODO-free path: Task 5 wires persistence). Keep the existing catch for other `AI_*` (transient) errors: it still counts toward the circuit breaker; a transient code that is not `AI_CIRCUIT_OPEN` must no longer fail the project either — mark tasks done-red with the code/message and continue (breaker trips only at 5 consecutive, then `failed` + `AI_CIRCUIT_OPEN`).
- `runNames`: if `error` ∈ STOP_AI → keep fallback names for this page, set `run.aiStopped`, store the message (`nameSections` result must expose the error message; add `errorMessage` to its return), and all remaining name tasks finish with fallback names + marker without calling AI. Store `error_msg` on each name task that carries a marker.
- If `run.aiStopped` is set before the fix phase: fix tasks finish immediately with that marker (like `budgetHit`).
- Tests (unit, fake deps): fake generate throwing AI_QUOTA in fix → project `completed`, fix tasks `done` with `error_code='AI_QUOTA'` and `error_msg` containing the message, and generate not called again after the first failure; naming AI_AUTH on page 1 of 3 → no further naming calls, project completes; 5 consecutive AI_BAD_RESPONSE in naming still → `failed` + `AI_CIRCUIT_OPEN`.

## Task 3: No hangs, immediate pause, delete while running (spec §2)

Files: `src/core/qa.ts`, `src/core/capture.ts`, `src/core/qa-fix.ts`, `src/core/inspector.ts` (evaluate calls), `src/core/jobs.ts`, `src/core/browser.ts` (helper), `src/app/api/projects/[id]/route.ts`, `src/app/_server/session.ts` if the busy guard needs a hook; tests unit + e2e.

- `FONTS_READY_MS = 10_000`: replace every `page.evaluate(() => document.fonts.ready.then(() => true))` with an in-page race `Promise.race([document.fonts.ready.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))])`, passing ms as an argument.
- `EVAL_TIMEOUT_MS = 30_000`: helper `evalWithTimeout(page, what, fn, arg?)` in `browser.ts` (race with a Node timer; on timeout throw `AppError(BROWSER_CRASH, "<what> timed out after 30s")`). Use it for the `page.evaluate` calls in `qa.ts`, `qa-fix.ts`, `inspector.ts`.
- `prepareClonePage`: before `goto`, `page.route("**/*", r => sameOrigin(r.request().url(), url) ? r.fallback() : r.abort())` so only the clone's own loopback server is reachable (data:/blob: are not routed by Playwright; fine).
- Immediate pause: per running project keep an `AbortController` (map in jobs.ts). `pauseProject` on a running project: add to `paused`, `controller.abort()`, and close the run's browser handle (store it in a map when opened). `generate` calls made by naming/fix receive the run's signal (thread `signal` through `FixCtx` and `nameSections` options → `generate`). In `runProject`'s catch: if `paused.has(projectId)`, set every `running` task of the project back to `pending` (not failed) and `setStatus(paused)`; return without rethrowing. `handle.close()` in finally must tolerate an already-closed handle.
- `stopAndWait(projectId, ms)` exported from jobs: if running → pause as above and await the run's completion promise up to `ms`; if waiting in queue → remove (existing pause path). Returns whether it is idle now.
- DELETE route: if the project is queued/active, `await stopAndWait(id, 15_000)`; if still busy → `ApiError(409, "PROJECT_BUSY", "Đang dừng project, thử xoá lại sau vài giây.")`. Then the existing `exclusive(...)` delete.
- Tests: unit — fonts race returns within the timeout on a page whose font never loads (e2e with a local server that never answers a font request: QA score completes < 20 s); evalWithTimeout rejects with BROWSER_CRASH; external request from the clone page is aborted (e2e: clone HTML referencing `http://127.0.0.1:<other port>/x.woff2` on a server that hangs → scoring completes); pause during a fake fix phase whose generate never resolves (fake respects signal) → project `paused` within 2 s, tasks `pending`, no `failed` task; resume later completes; DELETE of a running project (fake slow run) → 200 and rows gone.

## Task 4: Recovery from failed / interrupted / paused (spec §3)

Files: `src/app/_server/http.ts`, editor routes (`editor/route.ts`, `editor/save/route.ts`, `editor/promote-layout/route.ts`), `src/app/api/projects/[id]/qa/rescore/route.ts`, editor/preview UI where the rescore button and editor error show, sitemap picker (`src/app/p/[id]/sitemap/sitemap-picker.tsx`), tests e2e `tests/e2e/api.test.ts`/`rescore.test.ts`.

- Replace `EDITABLE_STATUSES` + `requireStatus(..., "edit")` with `requireEditable(db, project)`: allowed statuses `completed|failed|interrupted|paused`, the `emit` task `done`, and `!isQueuedOrActive(id)`. Errors (409 BAD_STATE, Vietnamese): not emitted → `Chưa có bản clone để sửa (pha emit chưa xong). Bấm Tiếp tục ở trang Tiến độ.`; running/queued → `Project đang chạy — Tạm dừng trước khi sửa.`; other statuses (draft, needs_auth) → `Chưa thể sửa ở trạng thái <status>.`
- Rescore uses the same rule; the preview/editor UI shows the rescore button whenever the API would accept (not only on completed+stale: show when stale OR status≠completed).
- Editor page: on a 409 show the message in the existing Banner (no raw `BAD_STATE:` prefix — Task 6's hint table handles codes; here just make the route message Vietnamese).
- Sitemap in non-draft status: show under the header `Đã bắt đầu clone — danh sách trang đã chốt. Dùng Clone lại để quét lại.` (`data-ui="ui_sitemap_locked_note"`).
- Tests: editor GET on a failed project with emit done → 200; without emit done → 409 with the Vietnamese message; rescore on failed → accepted; running → 409.

## Task 5: Backend error surfacing — status_reason, error_msg, run.log, console, fix-round logs, log route (spec §4)

Files: `src/core/db.ts`, `src/core/jobs.ts`, `src/core/jobs-base.ts`, new `src/core/run-log.ts`, `src/core/qa-fix.ts`, `src/app/api/projects/[id]/log/route.ts` (new), `src/app/api/projects/route.ts` / project loaders that select status (add `status_reason`), tests unit `tests/unit/run-log.test.ts` + e2e route test.

- Migration: `ALTER TABLE projects ADD COLUMN status_reason TEXT` if missing (same pattern as `auth_enc`).
- `setStatus(db, id, status, reason?)` writes `status_reason = reason ?? NULL`. The completed update in `runProject` writes `status_reason` = `run.aiStopped?.code ?? (budgetHit ? BUDGET_EXCEEDED : NULL)` and the completed status event carries that reason.
- `finishTask(..., marker?, alsoInTx?, message?)`: writes `error_msg=message ?? NULL`. The naming fallback path stores the naming error message.
- `run-log.ts` (core, no app import): `appendRunLog(projectId, level, phase, message)` — one line `ISO LEVEL [phase] message\n` to `workspace/<id>/run.log`, per-project write chain like event-log (no interleaving), rotation at `MAX_RUN_LOG_BYTES = 5 * 1024 * 1024` → rename to `run.prev.log`; never creates the directory (deleted project stays deleted); a write failure warns once and never breaks a job. `readRunLog(projectId): Promise<string>` = prev + current.
- `emit` (jobs-base): after redact, also `appendRunLog` for every non-progress event (format by type: status/phase/task/log/needs_auth → human line, include errorCode + error). Server console: `log` warn/error, task `failed`, status `failed` → `console.warn`/`console.error("[job <id8>] …")`.
- `logDetail(projectId, level, phase, message)` exported (redacted, run.log + console for warn/error, NOT an SSE event) for server-only details: stack traces in `runProject`'s catch and the queue's `drain` catch; gateway `onRetry` (via fix/naming) as `warn`.
- Fix-round events (spec §4 list) emitted as `log` events from `fixSection` via an optional `ctx.log?(level, message)` that runFixes wires to `emit(... {type:"log"})`. Messages (Vietnamese): `fix <page>:<section> vòng <n>: bắt đầu (điểm <x>)`, `… AI trả sai định dạng`, `… ops bị IR từ chối`, `… ứng viên <y> < <x>, revert`, `… nhận ứng viên (điểm <y>)`, `fix <page>:<section>: <pass|đỏ> điểm <x> sau <n> vòng`. Scores formatted as percent with 1 decimal.
- `GET /api/projects/[id]/log`: `handle(req, …)` loopback guard, `requireProject`, return `new Response(await readRunLog(id), { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": 'attachment; filename="run-<first 8 of id>.log"' } })`. Empty log → empty body 200.
- Project list/detail API payloads include `statusReason`.
- Tests: run-log rotation + no-directory-creation + redaction (set run secrets, emit a message containing the secret → not in the file); status_reason persisted on failed and cleared on running; error_msg stored on a marker task; log route returns attachment headers.

## Task 6: UI error surfacing (spec §4)

Files: new `src/app/_ui/error-hints.ts`, `src/app/_ui/api.ts`, `src/app/p/[id]/page.tsx`, `src/app/p/[id]/progress-view.tsx`, `src/app/p/[id]/page-states.ts`, new `src/app/p/[id]/error-panel.tsx`, preview model/route (`src/app/p/[id]/preview/preview-model.ts`, `src/app/api/projects/[id]/preview/route.ts`), `src/app/globals.css` only if needed; tests unit for page-states/error-hints, e2e `tests/e2e/ui-smoke.test.ts` (seeded failed project).

- `error-hints.ts`: `ERROR_HINTS: Record<string, string>` exactly the spec §4 table (one entry per code; the grouped rows expand to each code with the same text) + `hintFor(code)`.
- `api()`: message = `hintFor(code)` when present, followed by ` (<server message>)` when the server message is non-empty; unknown code → `<code>: <message>` as today. Keep PROJECT_BUSY/QUEUE_FULL friendly texts (move them into the table).
- Progress page server component selects `error_msg AS errorMsg` and the project's `status_reason`; passes both down.
- Reason banner (`data-ui="ui_progress_reason_banner"`, existing `Banner`, tone error for failed, warning for completed-with-reason): `<code> — <hint>`; the latest error message of that code (from tasks) below it.
- Error panel (`data-ui="ui_progress_error_panel"`, `Card` + `GridTable`, title `Lỗi & cảnh báo (<n>)`): rows for tasks with `errorCode`, columns Pha / Trang·section / Mã / Thông báo / Gợi ý. Sorted: failed first, then rowid. Bounded to the 2 000 tasks already loaded; message cell truncated with the full text in `title`. Hidden when no rows. Updates live from SSE `task` events (errorCode + error).
- `page-states.ts`: a page is `lỗi` if any of its capture/name tasks or any fix task keyed `<pageId>:…` is failed or done with a marker in `STOP_AI ∪ {BUDGET_EXCEEDED, AI_BAD_RESPONSE, AI_RATE_LIMIT}`; the summary counts reflect it (no more "xong · 0 lỗi" beside a failed/warned run).
- `Tải log` button (`data-ui="ui_progress_download_log"`, existing `Button`/link style, icon `download`) → `/api/projects/<id>/log`.
- Preview fix card: show `errorMsg` (preview route selects `error_msg`); "Đang sửa…" only when the project status is `running`; otherwise a task still pending/running shows `Chưa sửa (project <status>)`.
- Tests: page-states unit (fix failure counts); hint table covers every `Codes` key used in spec; e2e seeded failed project with an AI_QUOTA fix task → banner + panel row + download link visible, `scrollWidth <= innerWidth` at 375 and 1440.

## Task 7: "Hiện trình duyệt khi chạy" (spec §5)

Files: `src/core/jobs-base.ts`, `src/core/jobs.ts`, `src/app/new/new-clone-form.tsx`, any route that re-creates a project config (Clone lại in history), tests unit (schema default) + e2e (form posts `headed`).

- `projectConfigSchema.headed: z.boolean().default(false)`.
- `discoverPages` and `runProject` pass `headed: cfg.headed` to `openBrowser`. (`session/import` and the login window unchanged.)
- `/new` checkbox `Hiện trình duyệt khi chạy` with hint `Mở cửa sổ Chromium để xem trực tiếp; mặc định chạy nền.` (`data-ui="ui_new_headed_toggle"`), existing Field/checkbox styling, placed with the run options. "Clone lại" keeps the old config's value.
- Tests: schema default false and accepts true; openBrowser fake receives `headed: true` for a project created with it; e2e form submit sends `config.headed`.

## Task 8: Clone fidelity — @font-face assets, section splitting (spec §6)

Files: `src/core/capture.ts` (asset URL collection), `src/core/assets.ts` (a pure `urlsFromFontFaces(fontFace: string[], baseUrl)` helper next to `urlsFromCssValue`), `src/core/ir-build.ts`, tests `tests/unit/assets.test.ts`, `tests/unit/ir*.test.ts` (find the splitSections tests), e2e fixture if needed.

- Collect url()s from the captured `cssom.fontFace` strings (absolute http/https kept; relative resolved against the page URL), dedupe with the rest, subject to the existing limits.
- `splitSections`: while unwrapping, a non-landmark candidate list of length 1 unwraps as today; additionally, when the list has >1 candidates but exactly one of them is a non-landmark wrapper containing a `main` descendant within `MAX_UNWRAP` levels, replace that wrapper by its element children (repeat up to MAX_UNWRAP). Then filter out noise candidates: tag in `script|style|noscript|template|next-route-announcer`, or its 1440 bbox width or height is 0, or captured style `display:none` / `visibility:hidden`. Noise nodes stay in the shell (they are simply not section roots). Keep determinism (same input → same ids).
- Tests: a DOM `body > div.page-wrapper > (header, main > (s1, s2), footer)` → sections header, s1, s2, footer; hidden div and `next-route-announcer` are not sections; fontFace absolute + relative urls collected.

## Task 9: AI request size caps + threshold warning (spec §6)

Files: `src/core/qa-fix.ts` (images), `src/core/naming.ts` (thumbnail + text cap), a small pure image helper in core (reuse `thumbnailOf` if it fits), `src/app/new/new-clone-form.tsx`, tests unit.

- `MAX_IMAGE_WIDTH = 1024`, `MAX_IMAGES_B64 = 1.5 * 1024 * 1024`, `MAX_NAMING_CHARS = 24_000`. Downscale each evidence PNG to width ≤ 1024 (keep aspect, nearest/box filter via pngjs; no new dependency). If the total base64 exceeds the cap, drop heat, then clone, then halve widths until it fits (bounded loop, ≤4 halvings).
- Naming prompt: section descriptions cut to 24 000 chars total (cut marker `…`).
- `/new`: threshold > 98 shows the spec's warning text (`data-ui="ui_new_threshold_warning"`, existing hint/warning style).
- Tests: a 2880-wide PNG becomes ≤1024 wide; three large images get trimmed under the cap in the documented order; naming text capped; e2e or component check for the warning.

## Task 10: Docs, README, graph (spec all)

Files: `docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md` (§4 pause, §9, §11: one-line pointers to the hardening spec), `docs/superpowers/design/stitch-screens.md` (new `ui_*` ids: `ui_sitemap_locked_note`, `ui_progress_reason_banner`, `ui_progress_error_panel`, `ui_progress_download_log`, `ui_new_headed_toggle`, `ui_new_threshold_warning` — marked "không có trong mockup, dùng token/component sẵn có"), `README.md` (env/usage: headed checkbox, Tải log, `run.log` location, new troubleshooting rows: AI_QUOTA/402, treo → Tạm dừng dừng ngay, failed → vẫn sửa được trong Editor), then refresh graphify: `C:\Users\Minh Khoa\AppData\Roaming\uv\tools\graphifyy\Scripts\python.exe` per the graphify `--update` flow on `docs` (add nodes for the hardening spec sections `hspec_s0..s7`, link to `feat_*`, `mod_*`, new `ui_*`), commit `graphify-out/graph.json` changes.
