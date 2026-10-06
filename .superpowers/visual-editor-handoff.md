# HANDOFF — Visual Editor (E1–E4), brainstorming in progress (2026-09-27)

Repo D:/ai_web_clone, branch `sp1-clone-engine`, HEAD 437689a. Not pushed; there is no remote. Don't push or merge without the user.
Standing constraints (CLAUDE.md + rules.md):
- Never commit `passcaptchar/`, `rules.md`, `next-env.d.ts` or `.playwright-mcp/`. Never `git add -A`.
- No CAPTCHA solving, stealth or anti-bot bypass. Never build `drift_*` items.
- Secrets never appear in logs or AI requests.
- `core/` never imports `app/`.
- Workloads are bounded.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## What is done (don't redo)
- SP1 clone engine + UI parity + real-run hardening are complete and reviewed.
  - Specs: `docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md`, `…2026-09-24-sp1-ui-stitch-parity-design.md`, `…2026-09-26-sp1-realrun-hardening-design.md` (§1–§8, incl. §8 token-bounded AI requests).
- Last verified: tsc clean, unit 255/255, next build 0 warnings.

## User request (verbatim intent)
- Turn the editor into a Figma/Framer/Webflow-like **Visual Web Editor** over a structured document model, not raw HTML.
- Detect components: carousel / swiper / slick / splide / scroll-snap, tabs, accordion, modal, dropdown, menu, video.
- **Carousel cloning is currently broken** and must be fixed: a `CarouselComponent` with slides, active, autoplay, interval, loop, direction, arrows, pagination, transition, slidesPerView, spacing. The editor must support add, duplicate, delete and reorder of slides.
- AI edits go through editor commands: setStyle / setText / moveNode / deleteNode / duplicateNode / setAttribute / createNode / updateCarousel / addCarouselSlide / removeCarouselSlide.
- Fidelity report: anything not cloned is marked unsupported / partially-supported and never silently dropped.
- Refactor incrementally. No rewrite.

## Decisions taken with the user
1. Decomposition + order: **E1 → E2 → E3 → E4**.
   - E1: Document model v2 + Command API + history + fidelity report.
   - E2: Component detection + Carousel (+ tabs, accordion, modal, dropdown, video) + real runtime.
   - E3: Visual editor — canvas, hover and select, layer tree, bounding box with handles, full Style Manager, drag / resize / reorder, per-breakpoint editing, incremental render.
   - E4: AI editor commands via chat.
2. Components follow the **Figma model**: main + instances with overrides, "Reset override", "Detach".
3. Undo/redo: **server-side, bounded** command log per project (~500 steps). AI and user share it, and it survives reload.
4. E1 approach **A: evolve IR in place to IR v2** — one model, Command API, SQLite history, v1→v2 migration. Rejected: an overlay on the IR, and storing GrapesJS JSON.
5. Controller defaults, which the user may override:
   - 3 fixed breakpoints (1440 / 768 / 375), because QA depends on them.
   - Tablet/Mobile styles are inherited overrides, Webflow-style.
   - Old ir.json auto-migrates on open.

## Design presented, awaiting approval: E1 Section 1 — IR v2 data model
- IRNode:
  - `id`: stable id, deterministic seed from the original path. It no longer changes on move.
  - `parentId`, `tag`.
  - `type`: container | text | image | link | button | input | media | svg | component-root.
  - `name?`, `attrs`, `text?`.
  - `styles`: NodeStyles `{ base, bp{768,375}, state{hover,focus,active}, pseudo{before,after} }`. This is the source of truth, replacing the hashed `cls[]`. Classes `s-xxxx` are derived only at emit time via dedupe, so the output HTML/CSS and QA stay unchanged.
  - `box?`: per bp `[x, y, w, h]`, read-only, from capture.
  - `hidden?`.
  - `component?`: `{ id, role: main | instance, overrides?: string[] }`.
  - `behavior?`: E2 replaces this.
  - `children`.
- `IR.fidelity`: list of `{ feature, status: supported | partial | unsupported, nodeId?, note }`.
- Migration v1→v2 on load (class hash → styles, path id → stable id, box from capture.json), then write `version: 2`.
- **Next design sections to present, one at a time with approval:**
  - Section 2: Command API. Ops, inverse, validation, and how applyPatch / the AI fix loop / grapes-adapter map onto it.
  - Section 3: History (SQLite table, 500 cap, undo/redo semantics, concurrency with running jobs).
  - Section 4: Component main/instance override resolution at emit + in commands.
  - Section 5: Fidelity report (what capture already knows but drops: original @media rules, pseudo hover/bp variants, form focus delta, sticky scroll delta, subtreeHtml, scripts/JS components, iframes, canvas) + UI surfacing.
  - Section 6: Migration, error handling, testing.
- Then: write the spec `docs/superpowers/specs/2026-09-27-e1-document-model-design.md` → user reviews it → writing-plans → SDD.

## Audit facts (from a read-only audit, file:line)
**IR today** (src/core/ir.ts:22-62):
- IRNode is `{ id (path "pageId:0.1.2", ir-build.ts:31), tag, attrs, text?, cls[], hidden?, states?, behavior?, children }`.
- Styles live in `IR.classes` as hashed `s-xxxxxx` (dedupe.ts:86-97). A StyleSet is `{ base, before?, after?, media{768,375} }`. Values are computed styles minus UA defaults (capture-eval.ts:50-59,156).
- Breakpoint matching stops where tag or child count differ (ir-build.ts:52-56).
- PatchOp set is setStyle (base only, re-hash, ir.ts:194-205) / setAttr / setText / replaceSubtree / setBehavior. There are no insert, move or delete ops.
- Component = ≥3 siblings with the same structuralHash, stored as `{ id, hash, instanceIds }`. It exists only in the graph.
- Layout = a section shared by 2 or more pages (promoteLayout ir.ts:294, syncSections ir.ts:334).

**Raw HTML use:** essentially none. Editor save (grapes-adapter.ts:184-315 → applyPatch → saveEdited jobs.ts:304-326), emit-html, qa-fix (zod PatchOps) and naming are all model-based. Raw strings kept in the model: @keyframes / @font-face cssText, stateSelectors (regex), and subtreeHtml (captured but unused).

**Editor:** GrapesJS ^0.23.6 (src/app/p/[id]/editor/editor-view.tsx:56-94).
- Default Style / Layer / Trait managers.
- Devices use `widthMedia:""`, so edits apply to all breakpoints.
- The CSS is loaded as `protectedCss` and is not editable.
- runtime.js is not loaded in the canvas.
- The editor is rebuilt after every save, so the UndoManager history is lost.
- Only `#id` rules are diffed; media, state and class rules are ignored (grapes-adapter.ts:166-182).
- A mismatched child list becomes a replaceSubtree of the parent.

**Carousel is broken because:**
- Detection works: `.swiper`, `.slick-slider`, `.splide`, and scroll-snap (interactions-eval.ts:44-92).
- The scan only clicks "next" up to 10 times and checks movement, storing no slide data (interactions.ts:122-149).
- The behavior is put on the container, not on the buttons (ir.ts:130-137). The runtime only scrolls native overflow boxes (runtime.js:16-21,53).
- Swiper/slick transforms are frozen at capture time, and original classes and scripts are dropped (emit-html.ts:120,152).
- Loop clones are captured as ordinary nodes. Autoplay and pagination are not modeled.
- A slide-count mismatch across breakpoints breaks the responsive styles.
- Probable modal bug: runtime.js:44 calls `getElementById("#dialog")`.

**Silently dropped today:**
- Original @media rules (read at capture.ts:94, dropped at ir.ts:152-159).
- Pseudo-element breakpoint and hover variants.
- Form focus delta, sticky scroll delta, subtreeHtml.
- iframe content.
- All JS other than the 4 runtime behaviours (toggle / tabs / modal / carousel).
- There is no "unsupported" marker anywhere, and "captured" means only "moved during the scan" (graph.ts:230-250).

**Sizes (LOC) and tests:**
- editor-view 229, grapes-adapter 323, ir 351, ir-build 186, emit-html 345, interactions 234 + eval 166, runtime.js 67, qa-fix 411, graph 257, dedupe 198.
- Editor tests: unit grapes-adapter (27 tests); e2e editor-smoke has about 2 tests that touch the editor. Nothing tests style, breakpoint, effects or undo.

## Process to follow
- superpowers:brainstorming (architectural path). Present the remaining E1 sections one at a time; each needs user approval. Then write the spec, have the user review it, run writing-plans, then subagent-driven-development.
- Before touching tasks, check `/graphify explain` for related nodes.
- After changing docs, run `/graphify docs --update`: add E1 nodes and mark the new feature as a user-approved scope extension (it is not SP2/SP3).


## E1 DONE (2026-10-01) — HEAD bfaa333
E1 plan tasks 1–15 complete; final review + fix wave clean. Unit 358/358, build 0 warnings, e2e targeted green. Graph NOT synced: graphify docs --update needs an LLM API key (set ANTHROPIC_API_KEY or pass --backend) — run it before E2.
Next: E2 (Component detection + CarouselComponent + runtime) — start with superpowers:brainstorming.

### E1 rulings (from ledger)
- Task 4 Ruling: instance-only attrs rendered after main attrs (HTML not byte-identical to v1, renders same) accepted — cost if wrong: diff noise in HTML comparisons
- Task 5 Ruling: add `setHidden(id, hidden)` command (user's original request lists hide; IRNode has `hidden`) — carried into Task 6 — cost if wrong: one extra command
- Task 5 Ruling: shell trees allow setStyle/setAttribute/setText on existing nodes + move/delete of #section placeholders only; no create/duplicate in shell; body/html never deleted/moved — spec said placeholders only; styling body/wrappers needed by editor — cost if wrong: slightly wider shell edit surface
- Task 5 Ruling: migrateIR loader bounds = capture ceilings (MAX_NODES per page, depth guard), not the 500/20 per-command subtree limits — real sections exceed 500 — cost if wrong: loader accepts larger docs (still bounded)
- Task 6 Ruling: structural edits inside an instance refused ("edit the main or detach first") instead of a children override — matches Figma, avoids duplicate/drop of main nodes — cost if wrong: user must detach to restructure an instance
- Task 6 Ruling: nodes a main gained after promotion render under generated instance ids not in the document; per-instance property overrides on them are unsupported in E1 — Task 9 editor maps such ids to the main node (edit there) — cost if wrong: can't override newly added main children per instance
- Task 6 Ruling: setHidden refuses html/body (shell roots) — cost if wrong: can't hide a whole page via command
- Task 7 Ruling: between Task 9 (editor writes v2 ir.json) and Task 13 (pipeline loads v2) rescore/resume on an edited project is broken — accepted as intra-plan transitional state; no release/push before Task 13+14 — cost if wrong: user testing mid-plan hits errors
- Task 8 Ruling: out/ read during an in-flight materialize waits for it (then serves), 503 only if repair fails — no partial bytes either way, better UX than 503 — cost if wrong: slower first read after an edit
- Task 9 Ruling: save diff >50 commands refused (no silent split) — UI must say so in Vietnamese (save more often); E3 replaces diff-save with per-action commands — cost if wrong: friction on big manual edits
- Task 9 Ruling: cross-section drag / wrap copies node with new IDs in E1 (GrapesJS limitation) — E3 handles true moves — cost: history shows delete+create
- Task 9 Ruling: eye → setHidden + display:none kept; emitter keeps ignoring `hidden` (capture sets hidden for visibility:hidden/zero-size; emitting would shift existing clones' pixels) — cost if wrong: two-field hide state
- Task 9 Ruling: dropping a section block directly into page body refused in E1 (visible Vietnamese message) — cost: blocks only inside sections until E3
- Task 10 Ruling: fix phase writes v2 ir.json; loadIr compiles v2→v1 view for rescore (early slice of Task 13) accepted — cost if wrong: Task 13 must not double-convert
- Task 11 Ruling: deleting a clone node for a detected feature (carousel/hover) turns its fidelity item unsupported (clone no longer has it) — accepted; item kept via sourceRef — cost: status worsens after deletes
- Task 11 Ruling: script items shown per page (analytics/JSON-LD included) accepted as accurate; Task 12 UI groups them (one row per page with count) — cost: noise if not grouped
- Task 12 Ruling: preview GET may write derived fidelity (only when changed, idle, adopted doc) accepted — cost if wrong: a GET with a side effect; fix-loop fidelity refresh → Task 13
- Task 13 Ruling: job writes to an adopted document go through commitJob (CAS, revision+1, History reset, not an undoable job step) — undo across a whole-doc job rewrite is unsafe and breaks 8 MB cap; history normally empty then (user edits close fix tasks) — cost if wrong: user loses undo steps recorded before a job rewrote the doc
- Task 13 Ruling: opening/reading a v1 ir.json marks existing qa.json stale (spec §6) accepted — cost: one extra rescore after upgrade
- Task 14 Ruling: v1 project rescored before first editor open gets scores marked stale once at adoption (spec literal) accepted — cost: one extra rescore
- Task 14 Ruling: unreadable ir.json (corrupt / v1 with corrupt capture) → Preview shows no pages + one Fidelity "không đọc được" item accepted — cost: less info than old raw read
- Ruling: promoteLayout/restoreComponent undo payloads bounded by 8 MB step cap only, not 500/20 (real sections exceed 500) — spec §2 deviation — cost if wrong: larger history rows

## E2 IN PROGRESS (2026-10-02)
Spec 0f71994, plan 6ce8116, branch e2-interactive-components. Ledger: .superpowers/sdd/2026-10-02-e2-interactive-components/progress.md (resume at first task without "complete").

## E2 DONE (2026-10-03) — branch e2-interactive-components, HEAD 9946028
34 commits on top of main 0f71994 (spec) — not pushed/merged. Unit 436/436, full e2e 212/212 (x2 at 8d24684) + 53 targeted after final fixes, build 0 warnings.
Rulings: spec §14 of docs/superpowers/specs/2026-10-02-e2-interactive-components-design.md. Graph NOT synced (graphify docs --update needs an LLM API key).
Next: E3 (Figma-like visual editor) — start with superpowers:brainstorming. Deferred minors: see spec §14 / final review triage (non-blocking).
