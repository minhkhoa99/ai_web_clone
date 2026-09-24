# SP1 — UI ↔ Stitch parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the SP1 UI to Stitch parity in layout and visual system (tokens, app shell, icons, shared components, all 122 `ui_*` elements), fill the UI gaps for features that already exist, and add exactly the six approved backend pieces (durable event log + SSE replay, "Chạy lại QA", crawl HTTP status/latency, provider Test latency/HTTP code, token/time estimate, small API tweaks).

**Architecture:** Stitch `tailwind.config` tokens become CSS custom properties in `src/app/globals.css` (no Tailwind, no UI library). A client `Shell` (56px header + 224px sidebar, real routes only) wraps every page; one-file-per-component `src/app/_ui/*` primitives (Icon from a committed Material Symbols SVG subset, Button, SegmentedControl, GridTable, PageHeader, …) rebuild each screen, every element root tagged `data-ui="ui_<screen>_<slug>"`. Backend changes stay inside the existing guards: `handle()` → `requireProject` → `requireStatus` → `exclusive()`; core never imports app.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript 7 strict, `node:sqlite`, Playwright, Vitest 5, zod 4, shiki, GrapesJS, `@material-symbols/svg-400@0.47.5` (devDependency, build-time only).

**Spec:** `docs/superpowers/specs/2026-09-24-sp1-ui-stitch-parity-design.md` (decisions D1–D10 approved). Context: `docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md`, `CLAUDE.md`, `rules.md`, mockups `docs/superpowers/design/stitch/*.png|.html`.

## Global Constraints

Every task's requirements implicitly include all of these.

- Approach A: Stitch tokens → CSS custom properties in `src/app/globals.css`. **No Tailwind, no UI library**, no CSS-in-JS.
- Primary = Stitch token: `primary #c0c1ff`, `on-primary #1000a9`, hover `primary-fixed #e1e0ff`; accent fill `primary-container #8083ff` + `on-primary-container #0d0096` (D2). Never `#6366F1`.
- Icons: Material Symbols Outlined, **self-hosted SVG subset** generated from `@material-symbols/svg-400` into the committed `src/app/_ui/icons.gen.ts` (D1). No icon/font CDN at runtime; every page loads only loopback URLs. Icon-only buttons **must** have `aria-label` + `title` (the `IconButton` `label` prop is required by type).
- Shell: header fixed 56px + sidebar 224px, only real routes: Lịch sử, Clone mới, Cài đặt AI; under `/p/[id]` the project block Tiến độ / Sitemap / Preview / Editor / Code. No footer/status bar.
- Every element root of spec §3 carries `data-ui="<ui_id>"` (ids exactly as in the spec).
- Copy is the spec's exact Vietnamese (feature names in English where the spec says so). Mandatory copies: auth banner "Trang <url> cần đăng nhập — Mở cửa sổ để đăng nhập, rồi bấm Tiếp tục"; buttons "Add Anthropic Compatible" / "Add OpenAI Compatible"; stepper = the 9 phases `discover capture assets ir name emit qa fix done` in order; status pill text = the status code.
- **No drift**: never render any `drift_*` string/element (spec §5; the `DRIFT` list in `tests/e2e/ui-checks.ts`). No CAPTCHA solving, no stealth/fingerprint, no anti-bot bypass (`rule_no_captcha_bypass`): login/CAPTCHA → `needs_auth`, the user handles it in the Chrome window. No USD anywhere.
- No SP2/SP3 feature (only the disabled "SP2" output cards). Out of scope (spec §0.2): ignore/accept section, abort clone, USD, DOM Delta, diagnostic callouts, asset-queue counter, DOM node stat, inspect-DOM route, model cache/default model/global role matrix, ping/robots line, Configure Rules, Failed tab / rows-per-page / regex search.
- Every new/changed route goes through `handle()` (loopback Host + CSRF: Origin same host, a body must be `application/json`), `requireProject`, `requireStatus` where a state applies, `exclusive()` (busy guard) for anything touching the workspace/browser. Existing guards are never loosened.
- Secrets (API key, password, cookie) never reach an event, `events*.jsonl`, a response, the DOM (except the value the user is typing), the graph or the AI.
- Bounded workloads (spec §4.8): 2000 events/project in RAM and replay, ≤4000 lines on disk (2 rotating files), 32 rings in RAM, 2000 chars per event string, 500 chars `lastError.message`, 2000 client log lines, 2000 files + `stat` concurrency 8 in the code viewer, 2000 `fixes`, rescore = 1 job through the shared queue (1 running, ≤5 waiting, beyond → 429). No `Promise.all` over an unbounded array (use `mapLimit`).
- `src/core/**` never imports `src/app/**`. `core/estimate.ts` is pure (client-importable, like `statuses.ts`); `core/event-log.ts` imports no app code. Client components import from core only pure modules or `import type`.
- Clone determinism, QA gate (per section × breakpoint, 95%, ≤3 fix rounds), checkpoints (tmp → rename → done), no auto-resume: unchanged.
- TypeScript strict, `noUncheckedIndexedAccess`; **no `any`**, no `@ts-ignore`.
- `npx tsc --noEmit`, `npx vitest run`, `npx vitest run -c vitest.e2e.config.ts` green; `npx next build` prints **0 warnings**.
- Commits: stage explicit paths only — **never `git add -A` / `git add .`**; never stage `passcaptchar/`, `rules.md`, `next-env.d.ts`. Message = subject line, blank line, `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (use `git commit -m "<subject>" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"`).

## Review Focus

Inputs/conditions the spec implies but does not test directly; each has a pinning test in the owning task.

1. **Very long URLs and paths** (300+ chars) in history rows, chips and the sitemap tree → ellipsis, the page never scrolls horizontally. Test: Task 8 (`scrollWidth <= innerWidth` with a 300-char URL).
2. **Reload / SSE reconnect mid-run** → the `history` message *replaces* the log (no duplicated lines) and the SSE status snapshot never restarts the run clock. Test: Task 11 (reload keeps exactly 3 lines, elapsed still ≥ 1 min).
3. **Legacy `discover.json` without `status/loadMs/redirected`** (written before §4.4) → HTTP column shows "—", nothing crashes. Test: Task 10 (`/legacy` row).
4. **Regex-special / mixed-case input in filters** (`[`, `(`, `DOCS`) → literal, case-insensitive substring; never throws. Test: Task 10 (sitemap `[` → 0 rows, `DOCS` → 2) and Task 7 (endpoint filter `(`).
5. **Double-click on an async action** ("Chạy lại QA") → exactly one POST (button disabled while pending). Test: Task 12 (request counter = 1).

---

## Conventions (read once)

- **Graph trace before each task** (CLAUDE.md): run `/graphify explain <node>` for the nodes named in the task's Step 0, or the equivalent one-liner from the repo root:
  `node -e "const g=require('./graphify-out/graph.json');const id=process.argv[1];for(const l of g.links)if(l.source===id||l.target===id)console.log(l.source,'-'+l.relation+'->',l.target)" <node>`
  Build only what the spec + graph contain; anything else → ask, don't add.
- **Unit tests**: `npx vitest run <file>`; **e2e**: `npx vitest run -c vitest.e2e.config.ts <file> [-t "<name>"]` (the UI suites do one shared `next build`; a filtered run still builds once, ~2–4 min).
- **Parity screenshots** (spec §7.1, reviewer compares): each screen task runs its smoke test with
  `PARITY_DIR="C:/Users/MINHKH~1/AppData/Local/Temp/claude/D--ai-web-clone/ef3d0bc4-858a-48e9-ad43-ca2ad3118fd8/scratchpad/ui-parity"` set; `parityShot(page, name)` then writes a full-page 1440×900 PNG `<name>.png` there. Open it next to the Stitch PNG named in the step (Read tool on both images) and note differences in the task report; do not commit screenshots.
- **Build check**: `npx next build 2>&1 | grep -iE "warn|⚠"; echo "grep-exit=$?"` → expected `grep-exit=1` (no warning line).
- CSS lives in `src/app/globals.css`, one commented section per component/screen (`/* === <Name> === */`). The Task 1 file keeps the old screen styles in `/* legacy: <screen> */` blocks re-pointed to the new tokens; each screen task deletes its own legacy block, Task 14 deletes `/* legacy: shared */`.

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `scripts/gen-icons.mjs` | icon subset generator (`npm run icons`), exports `NAMES`, `FILE_OF` | 1 |
| `src/app/_ui/icons.gen.ts` | GENERATED: `ICONS` path map + `IconName` | 1 |
| `src/app/_ui/Icon.tsx` | decorative SVG icon | 1 |
| `src/app/globals.css` | tokens, base, component + screen CSS | 1–14 |
| `src/app/_ui/{Button,IconButton,StatusPill,Badge,SegmentedControl,GridTable,PageHeader,UrlChip,Card,Field,SearchInput,PasswordInput,StatTile,ProgressBar,Banner,RelTime,LogView,Disclosure}.tsx`, `format.ts`, `download.ts` | shared UI (spec §2.2) | 2 |
| `src/app/_ui/Shell.tsx`, `src/app/layout.tsx` | app shell | 2 |
| `tests/e2e/ui-checks.ts`, `tests/e2e/ui-seed.ts`, `tests/e2e/parity-shots.ts` | smoke helpers (drift/labels/CDN checks, db+workspace seeding, screenshots) | 2 |
| `src/core/event-log.ts` | bounded durable event tail | 3 |
| `src/core/jobs-base.ts`, `src/core/jobs.ts` | stamped + redacted `emit`, `StampedEvent`, `requeueRescore`, `tokensUsed` | 3, 4 |
| `src/app/api/projects/[id]/qa/rescore/route.ts` | "Chạy lại QA" | 4 |
| `src/core/crawl.ts`, `src/core/gateway.ts`, `src/app/_server/providers.ts` | HTTP status/latency, provider body union | 5 |
| `src/core/estimate.ts` | pure token/time estimate | 6 |
| `src/app/p/[id]/sitemap/route-tree.ts` | pure sitemap tree | 10 |
| `src/app/p/[id]/page-states.ts` | pure page states, run clock, log lines | 11 |
| `src/app/p/[id]/preview/preview-model.ts` | pure fix text, checklist label, mean score | 12 |
| `src/app/p/[id]/code/{file-tree,code-file}.tsx` | code viewer client parts | 13 |
| `docs/superpowers/design/stitch-screens.md` | element-level map + official drift list | 15 |

---
### Task 1: Design tokens + self-hosted Material Symbols subset

**Files:**
- Create: `scripts/gen-icons.mjs`, `src/app/_ui/icons.gen.ts` (generated, committed), `src/app/_ui/Icon.tsx`, `tests/unit/icons.test.ts`
- Modify: `package.json` (devDependency + `icons` script), `package-lock.json`, `src/app/globals.css` (full rewrite)

**Interfaces:**
- Consumes: nothing.
- Produces: `ICONS: Record<IconName, string>` and `type IconName` (72 names of spec §1.5) from `@/app/_ui/icons.gen`; `Icon({ name: IconName; size?: 14 | 16 | 20; className?: string; ...SVGProps })` and re-exported `type IconName` from `@/app/_ui/Icon`; CSS tokens `--c-*`, `--t-*`, `--r-*`, `--s-*`, classes `.t-headline-lg … .t-label-sm`, `.tone-{neutral,primary,success,warn,danger}` (sets `--tone`), `.tint`, `.dot`, `.ping`, `.row`, `.spread`, `.stack`, `.text-2`, `.text-3`, `.text-success`, `.text-warn`, `.text-danger`, `.upper`, `.visually-hidden`, `.note`.

Note (resolved in this plan): 4 mockup `data-icon` names do not exist as files in `@material-symbols/svg-400@0.47.5` (they are font-ligature aliases). The generator keeps the spec's names as `IconName` and reads them from the current file names: `expand_more → keyboard_arrow_down`, `phone_iphone → mobile`, `auto_fix_high → wand_stars`, `generating_tokens → token` (all verified present in 0.47.5). The version is pinned exactly.

- [ ] **Step 0: Trace in the graph** — `/graphify explain spec_s0` and `/graphify explain feat_emit_html` (tokens/icons touch every screen; confirm no `drift_*` is involved).

- [ ] **Step 1: Install the icon package (build-time only)**

```bash
npm install --save-dev --save-exact @material-symbols/svg-400@0.47.5
```
Then add the script to `package.json` `"scripts"`: `"icons": "node scripts/gen-icons.mjs"`.

- [ ] **Step 2: Write the failing test** — `tests/unit/icons.test.ts`

```ts
import { expect, test } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FILE_OF, NAMES } from "../../scripts/gen-icons.mjs";
import { ICONS } from "@/app/_ui/icons.gen";
import { Icon } from "@/app/_ui/Icon";

test("icons.gen.ts holds exactly the spec §1.5 subset (72 names), each a non-empty SVG path", () => {
  expect(NAMES).toHaveLength(72);
  expect(new Set(NAMES).size).toBe(72);
  expect(Object.keys(ICONS).sort()).toEqual([...NAMES].sort());
  for (const d of Object.values(ICONS)) expect(d).toMatch(/^M/);
  expect(Object.keys(FILE_OF).every((n) => NAMES.includes(n))).toBe(true);
});

test("Icon is decorative: aria-hidden, not focusable, currentColor, Material viewBox, sizes 16 by default", () => {
  const html = renderToStaticMarkup(h(Icon, { name: "history" }));
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('focusable="false"');
  expect(html).toContain('fill="currentColor"');
  expect(html).toContain('viewBox="0 -960 960 960"');
  expect(html).toContain('width="16"');
  expect(renderToStaticMarkup(h(Icon, { name: "lock", size: 14, className: "x" }))).toContain('class="icon x"');
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/unit/icons.test.ts`
Expected: FAIL — cannot resolve `../../scripts/gen-icons.mjs` / `@/app/_ui/icons.gen`.

- [ ] **Step 4: Write the generator** — `scripts/gen-icons.mjs`

```js
// Generates src/app/_ui/icons.gen.ts: the Material Symbols Outlined paths (viewBox 0 -960 960 960) of the icons the UI uses
// (spec parity §1.5), from the @material-symbols/svg-400 devDependency (Apache-2.0). The output is committed, so a build
// needs neither the network nor this script. A name missing from the package exits 1. Run: npm run icons
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Names as in the mockups' data-icon.
export const NAMES = [
  // shell / nav
  "history", "add", "settings", "timeline", "account_tree", "difference", "edit", "code",
  // common
  "search", "refresh", "open_in_new", "content_copy", "visibility", "visibility_off", "expand_more", "chevron_right",
  "chevron_left", "close", "check", "remove", "more_vert", "arrow_forward", "undo", "redo", "save",
  // status
  "check_circle", "cancel", "pause_circle", "warning", "lock", "error", "schedule", "draft",
  // project actions
  "pause", "play_arrow", "replay", "delete", "download", "folder_zip", "drive_folder_upload", "bolt", "hub", "add_circle", "block",
  // /new
  "language", "radar", "generating_tokens", "output",
  // stepper
  "task_alt", "photo_camera", "image", "schema", "badge", "auto_fix_high",
  // preview
  "phone_iphone", "tablet_mac", "desktop_windows", "view_column_2", "opacity", "compare", "layers",
  // code viewer
  "folder", "folder_open", "description", "html", "css", "javascript", "data_object", "format_list_numbered", "wrap_text",
  // sitemap
  "unfold_more", "unfold_less",
];

// Ligature aliases the package ships under the glyph's current file name.
export const FILE_OF = { expand_more: "keyboard_arrow_down", phone_iphone: "mobile", auto_fix_high: "wand_stars", generating_tokens: "token" };

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = join(root, "node_modules", "@material-symbols", "svg-400", "outlined");
  const lines = [];
  for (const name of NAMES) {
    const file = join(dir, `${FILE_OF[name] ?? name}.svg`);
    let svg;
    try {
      svg = readFileSync(file, "utf8");
    } catch {
      console.error(`gen-icons: "${name}" not found (${file})`);
      process.exit(1);
    }
    const d = [...svg.matchAll(/\sd="([^"]+)"/g)].map((m) => m[1]).join(" ");
    if (!d) {
      console.error(`gen-icons: no <path d> in ${file}`);
      process.exit(1);
    }
    lines.push(`  ${name}: ${JSON.stringify(d)},`);
  }
  const out = [
    "// GENERATED by scripts/gen-icons.mjs from @material-symbols/svg-400 (Apache-2.0). Do not edit: npm run icons.",
    "export const ICONS = {",
    ...lines,
    "} as const;",
    "export type IconName = keyof typeof ICONS;",
    "",
  ].join("\n");
  writeFileSync(join(root, "src", "app", "_ui", "icons.gen.ts"), out);
  console.log(`gen-icons: ${NAMES.length} icons`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
```

- [ ] **Step 5: Generate the subset**

Run: `npm run icons`
Expected: `gen-icons: 72 icons` and a new `src/app/_ui/icons.gen.ts` (≈30 KB).

- [ ] **Step 6: Write the Icon component** — `src/app/_ui/Icon.tsx`

```tsx
import type { SVGProps } from "react";
import { ICONS, type IconName } from "./icons.gen";

export type { IconName };

type Props = { name: IconName; size?: 14 | 16 | 20; className?: string } & Omit<SVGProps<SVGSVGElement>, "name" | "className">;

// Always decorative (aria-hidden): a control that is only an icon names itself (IconButton's required label).
export function Icon({ name, size = 16, className, ...rest }: Props) {
  return (
    <svg
      viewBox="0 -960 960 960"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      className={className ? `icon ${className}` : "icon"}
      {...rest}
    >
      <path d={ICONS[name]} />
    </svg>
  );
}
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx vitest run tests/unit/icons.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 8: Rewrite `src/app/globals.css`** (whole file; the legacy blocks keep today's screens working on the new tokens until their screen task replaces them)

```css
/* === Tokens: Stitch tailwind.config (spec parity §1) — only the tokens in use === */
:root {
  --c-bg: #10131a;
  --c-surface-lowest: #0b0e15;
  --c-surface-low: #191c23;
  --c-surface: #1d2027;
  --c-surface-high: #272a31;
  --c-surface-highest: #32353c;
  --c-surface-bright: #363941;
  --c-text: #e0e2ec;
  --c-text-2: #c7c4d7;
  --c-text-3: #908fa0;
  --c-border: #464554;
  --c-primary: #c0c1ff;
  --c-on-primary: #1000a9;
  --c-primary-hover: #e1e0ff;
  --c-accent: #8083ff;
  --c-on-accent: #0d0096;
  --c-accent-strong: #494bd6;
  --c-success: #4ae176;
  --c-warn: #ffb95f;
  --c-on-warn: #3e2400;
  --c-danger: #ffb4ab;
  --c-danger-strong: #93000a;
  --c-on-danger: #ffdad6;

  --t-headline-lg: 600 28px/36px var(--font-head), system-ui, sans-serif;
  --t-headline-md: 600 22px/28px var(--font-head), system-ui, sans-serif;
  --t-headline-sm: 600 18px/24px var(--font-head), system-ui, sans-serif;
  --t-body-lg: 400 16px/24px var(--font-body), system-ui, sans-serif;
  --t-body-md: 400 14px/20px var(--font-body), system-ui, sans-serif;
  --t-body-sm: 400 12px/16px var(--font-body), system-ui, sans-serif;
  --t-label-md: 500 13px/18px var(--font-mono), ui-monospace, monospace;
  --t-label-sm: 500 11px/14px var(--font-mono), ui-monospace, monospace;

  --r-sm: 2px;
  --r-md: 4px;
  --r-lg: 8px;
  --r-full: 12px;

  --s-xs: 4px;
  --s-sm: 8px;
  --s-md: 12px;
  --s-lg: 16px;
  --s-xl: 24px;

  color-scheme: dark;
}

/* === Base === */
* { box-sizing: border-box; }
body { margin: 0; background: var(--c-bg); color: var(--c-text); font: var(--t-body-md); }
h1, h2, h3 { margin: 0; }
a { color: var(--c-primary); }
code, .mono { font: var(--t-label-md); }
:focus-visible { outline: 2px solid var(--c-primary); outline-offset: 1px; }
input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]), select, textarea {
  font: var(--t-label-md); color: var(--c-text); background: var(--c-surface);
  border: 1px solid var(--c-surface-highest); border-radius: var(--r-sm); padding: 5px 10px; min-height: 30px;
}
input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):focus, select:focus, textarea:focus {
  outline: none; border-color: var(--c-primary); box-shadow: 0 0 0 1px var(--c-primary);
}
input::placeholder { color: var(--c-text-3); }
input[type="checkbox"], input[type="radio"], input[type="range"] { accent-color: var(--c-accent); }

/* === Type scale (8 classes, spec §1.2) === */
.t-headline-lg { font: var(--t-headline-lg); }
.t-headline-md { font: var(--t-headline-md); }
.t-headline-sm { font: var(--t-headline-sm); }
.t-body-lg { font: var(--t-body-lg); }
.t-body-md { font: var(--t-body-md); }
.t-body-sm { font: var(--t-body-sm); }
.t-label-md { font: var(--t-label-md); }
.t-label-sm { font: var(--t-label-sm); }

/* === Utilities === */
.row { display: flex; gap: var(--s-md); align-items: center; flex-wrap: wrap; }
.spread { justify-content: space-between; }
.stack { display: grid; gap: var(--s-md); align-content: start; }
.upper { text-transform: uppercase; letter-spacing: 0.05em; }
.text-2 { color: var(--c-text-2); }
.text-3 { color: var(--c-text-3); }
.text-success { color: var(--c-success); }
.text-warn { color: var(--c-warn); }
.text-danger { color: var(--c-danger); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

/* Status tint (Stitch bg-{c}/10 border-{c}/30 text-{c}) */
.tone-neutral { --tone: var(--c-text-2); }
.tone-primary { --tone: var(--c-primary); }
.tone-success { --tone: var(--c-success); }
.tone-warn { --tone: var(--c-warn); }
.tone-danger { --tone: var(--c-danger); }
.tint {
  background: color-mix(in srgb, var(--tone) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--tone) 30%, transparent);
  color: var(--tone);
}
.note { margin: 0; padding: 8px 12px; border-radius: var(--r-md); font: var(--t-body-md); }

/* running = animate-ping dot */
.dot { position: relative; display: inline-block; width: 6px; height: 6px; border-radius: var(--r-full); background: currentColor; flex: none; }
.dot[class*="tone-"] { color: var(--tone); }
.ping::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: currentColor; animation: ping 1s cubic-bezier(0, 0, 0.2, 1) infinite; }
@keyframes ping { 0% { transform: scale(1); opacity: 1; } 100% { transform: scale(2); opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .ping::after { animation: none; }
  .btn:active, .icon-btn:active { transform: none !important; }
}

/* === legacy (pre-parity classes on the new tokens; removed by the screen tasks / Task 14) === */
/* legacy: shared */
.muted { color: var(--c-text-2); }
.card { background: var(--c-surface-low); border: 1px solid var(--c-border); border-radius: var(--r-lg); padding: 16px; }
.alert { padding: 10px 14px; border-radius: var(--r-md); border: 1px solid var(--c-danger); color: var(--c-danger); background: color-mix(in srgb, var(--c-danger) 10%, transparent); }
.notice { padding: 10px 14px; border-radius: var(--r-md); border: 1px solid var(--c-success); color: var(--c-success); background: color-mix(in srgb, var(--c-success) 10%, transparent); }
ul.plain { list-style: none; margin: 0; padding: 0; }
.btn { font: var(--t-label-md); cursor: pointer; padding: 6px 12px; border-radius: var(--r-sm); border: 1px solid var(--c-border); background: var(--c-surface-high); color: var(--c-text); text-decoration: none; display: inline-block; }
.btn:hover:not(:disabled) { background: var(--c-surface-bright); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn.primary { background: var(--c-primary); border-color: var(--c-primary); color: var(--c-on-primary); }
.btn.danger { color: var(--c-danger); }
.btn.warn { background: var(--c-warn); border-color: var(--c-warn); color: var(--c-on-warn); }
.btn[aria-pressed="true"] { background: var(--c-surface); border-color: var(--c-primary); color: var(--c-primary); }
label.field { display: grid; gap: 4px; font: var(--t-label-md); color: var(--c-text-2); }
label.field input, label.field select { color: var(--c-text); }
fieldset { border: 1px solid var(--c-border); border-radius: var(--r-md); padding: 12px 16px; margin: 0; display: grid; gap: 10px; }
legend { padding: 0 6px; color: var(--c-text-2); }
.grid-3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; font: var(--t-label-sm); color: var(--c-text-2); text-transform: uppercase; letter-spacing: 0.05em; }
th, td { padding: 10px 12px; border-bottom: 1px solid var(--c-border); vertical-align: middle; }
.split { display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: var(--s-lg); }
.tag { font: var(--t-label-sm); padding: 0 6px; border-radius: var(--r-sm); border: 1px solid var(--c-warn); color: var(--c-warn); }
main.page { padding: 24px; }
.topbar { display: flex; align-items: center; gap: 24px; padding: 12px 24px; border-bottom: 1px solid var(--c-border); background: var(--c-surface-lowest); }
.brand { font: var(--t-headline-sm); color: var(--c-text); text-decoration: none; }
.topbar nav { display: flex; gap: 16px; }
.topbar nav a { color: var(--c-text-2); text-decoration: none; }
/* legacy: pill */
.pill { display: inline-block; font: var(--t-label-sm); padding: 2px 8px; border-radius: var(--r-sm); border: 1px solid currentColor; }
.pill-draft, .pill-paused, .pill-interrupted { color: var(--c-text-2); }
.pill-running, .pill-queued { color: var(--c-primary); }
.pill-needs_auth { color: var(--c-warn); }
.pill-failed { color: var(--c-danger); }
.pill-completed { color: var(--c-success); }
/* legacy: history */
.thumb { width: 96px; height: 60px; object-fit: cover; object-position: top; border-radius: var(--r-md); border: 1px solid var(--c-border); background: var(--c-surface); display: block; }
.bar { height: 6px; background: var(--c-surface-highest); border-radius: 3px; overflow: hidden; width: 140px; }
.bar > span { display: block; height: 100%; background: var(--c-primary); }
/* legacy: progress */
.stepper { display: flex; gap: 6px; list-style: none; padding: 0; margin: 0; flex-wrap: wrap; }
.stepper li { font: var(--t-label-md); padding: 6px 12px; border: 1px solid var(--c-border); border-radius: var(--r-md); color: var(--c-text-2); }
.stepper .done { color: var(--c-success); }
.stepper .active { color: var(--c-text); border-color: var(--c-primary); }
.stepper .error { color: var(--c-danger); }
.auth-banner { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; border: 1px solid var(--c-warn); border-radius: var(--r-lg); background: color-mix(in srgb, var(--c-warn) 10%, transparent); }
.log { height: 460px; overflow: auto; background: var(--c-surface-lowest); border: 1px solid var(--c-border); border-radius: var(--r-md); padding: 10px 12px; margin: 0; font: var(--t-label-md); white-space: pre-wrap; }
.log .warn { color: var(--c-warn); }
.log .error { color: var(--c-danger); }
/* legacy: sitemap */
.tree li { padding: 6px 0; border-bottom: 1px solid var(--c-border); display: flex; gap: 10px; align-items: center; }
/* legacy: preview */
.compare { height: 72vh; overflow: auto; border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-surface); padding: 12px; }
.compare-side { display: flex; gap: 12px; align-items: flex-start; }
.compare-overlay { position: relative; }
.compare-overlay .clone { position: absolute; top: 0; left: 0; }
.frame { overflow: hidden; background: #fff; }
.frame iframe { border: 0; transform-origin: 0 0; display: block; background: #fff; }
.pane-label { font: var(--t-label-sm); color: var(--c-text-2); margin-bottom: 4px; }
.sections li button { width: 100%; display: flex; justify-content: space-between; gap: 8px; text-align: left; }
.score { font: var(--t-label-md); }
.score.fail { color: var(--c-danger); }
.score.pass { color: var(--c-success); }
.checklist-row { display: grid; grid-template-columns: 80px minmax(0, 1fr); gap: 8px; padding: 4px 0; overflow-wrap: anywhere; }
.heat { max-width: 100%; display: block; margin-top: 6px; border: 1px solid var(--c-border); }
/* legacy: code */
.code-layout { display: grid; grid-template-columns: 300px minmax(0, 1fr); gap: var(--s-lg); }
.files { max-height: 75vh; overflow: auto; }
.files a { display: block; padding: 3px 0; text-decoration: none; color: var(--c-text-2); font: var(--t-label-md); }
.files a[aria-current="page"] { color: var(--c-text); }
.viewer { max-height: 75vh; overflow: auto; border: 1px solid var(--c-border); border-radius: var(--r-md); }
.viewer pre { margin: 0; padding: 12px; font-size: 12.5px; }
/* legacy: editor */
.editor-layout { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--s-lg); align-items: start; }
```
(`.frame { background: #fff }` is the clone canvas, a page's own background — not a UI color.)

- [ ] **Step 9: Verify nothing else broke**

Run: `npx tsc --noEmit && npx vitest run`
Expected: typecheck clean; all unit tests PASS.
Run: `npx next build 2>&1 | grep -iE "warn|⚠"; echo "grep-exit=$?"`
Expected: `grep-exit=1`.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json scripts/gen-icons.mjs src/app/_ui/icons.gen.ts src/app/_ui/Icon.tsx src/app/globals.css tests/unit/icons.test.ts
git commit -m "feat(ui): Stitch design tokens + self-hosted Material Symbols subset" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 2: App shell + shared `_ui` components

**Files:**
- Create: `src/app/_ui/{Button,IconButton,Badge,SegmentedControl,GridTable,PageHeader,UrlChip,Card,Field,SearchInput,PasswordInput,StatTile,ProgressBar,Banner,RelTime,LogView,Disclosure,Shell}.tsx`, `src/app/_ui/format.ts`, `src/app/_ui/download.ts`, `tests/unit/format.test.ts`, `tests/unit/ui-components.test.ts`, `tests/e2e/ui-checks.ts`, `tests/e2e/ui-seed.ts`, `tests/e2e/parity-shots.ts`
- Modify: `src/app/_ui/StatusPill.tsx` (replace), `src/app/layout.tsx`, `src/app/globals.css` (component + shell CSS; delete `/* legacy: pill */`, the legacy `.btn`, `.btn:hover`, `.btn:disabled`, `main.page`, `.topbar*`, `.brand` lines), `src/app/p/[id]/page.tsx`, `src/app/p/[id]/preview/page.tsx`, `src/app/p/[id]/code/page.tsx`, `src/app/p/[id]/editor/page.tsx` (drop the old `<nav aria-label="Dự án">` link rows), `src/app/p/[id]/code/export-panel.tsx` (use `downloadZip`), `tests/e2e/ui-smoke.test.ts` (shell test; DRIFT → `ui-checks`)

**Interfaces:**
- Consumes: `Icon`, `IconName` (Task 1).
- Produces (all under `@/app/_ui/*`; every component accepts `"data-ui"?: string` and puts it on its root):
  - `Button(props: { variant?: "primary"|"secondary"|"warn"|"danger"|"ghost"; icon?: IconName; iconEnd?: IconName; size?: "md"|"lg"; className?; children? } & ({ href: string; title?; "aria-current"?: "page" } | ButtonHTMLAttributes))` — default `type="button"`.
  - `IconButton(props: { icon: IconName; label: string; tone?: "default"|"danger"|"success"|"warn"; className? } & ({ href: string; external?: boolean; current?: boolean } | ButtonHTMLAttributes & { pressed?: boolean; ref?: Ref<HTMLButtonElement> }))`.
  - `StatusPill({ status: string; queued?: boolean })`, `Badge({ tone?: "neutral"|"primary"|"success"|"warn"|"danger"|"accent"; title?; children })`.
  - `SegmentedControl<T extends string>({ label: string; options: SegOption<T>[]; value: T; onChange(v: T): void; semantics?: "toggle"|"tabs"; full?: boolean })`, `type SegOption<T> = { value: T; label: ReactNode; icon?: IconName; count?: number; disabled?: boolean; tone?: "warn" }`.
  - `GridTable<R>({ label; columns: { key: string; header: ReactNode; width: string }[]; rows: R[]; rowKey(r): string; renderCell(r, key): ReactNode; rowTone?(r): "warn"|"danger"|undefined; rowProps?(r): { className?: string; "data-ui"?: string }; empty?: ReactNode })`.
  - `PageHeader({ crumbs: Crumb[]; title: ReactNode; subtitle?; meta?; actions? })`, `type Crumb = { label: string; href?: string }`, `projectCrumbs(url: string, id: string, screen: string): Crumb[]`.
  - `UrlChip({ url; openable?; copyable?; plain?; extra? })`, `Card({ title?; icon?; hint?; actions?; variant?: "section"; className?; "aria-label"?; children })`, `Field({ label; hint?; hintEnd?; suffix?; className?; children })`, `SearchInput({ label; placeholder; value; onChange(v: string); onSubmit?(): void })`, `PasswordInput({ label: string; hint?: ReactNode } & InputHTMLAttributes)`, `StatTile({ label; value; tone?: "warn" })`, `ProgressBar({ value; status; label })`, `Banner({ tone: "warn"|"danger"|"info"; icon: IconName; title?; children?; actions?; role? })`, `RelTime({ at: number; unit?: "s"|"ms"; prefix?: string })`, `relative(ms, now): string`, `LogView({ lines: LogLine[]; wrap: boolean; empty: ReactNode; ref?; onScroll?; lineUi? })`, `type LogLine = { n: number; at: number; level: "info"|"warn"|"error"; text: string }`, `clock(at: number): string`, `Disclosure({ summary; defaultOpen?; className?; children })`, `Shell({ children })`.
  - `format.ts`: `fmtInt, fmtPct(x, digits=1), fmtTokens, fmtBytes, fmtDuration(ms), fmtMinutes(s), hostPath(url)`; `download.ts`: `downloadZip(projectId: string, stripIds: boolean): Promise<void>`.
  - Tests: `tests/e2e/ui-checks.ts` → `DRIFT: RegExp[]`, `expectNoDrift(page)`, `expectIconButtonsLabelled(page)`, `trackForeignRequests(page): string[]`, `expectUi(page, ids: string[])`; `tests/e2e/ui-seed.ts` → `seedProject(db, SeedProject): string`, `writeWs(root, id, rel, data)`, `pngOf(w, h, rgb): Buffer`; `tests/e2e/parity-shots.ts` → `parityShot(page, name)`.

- [ ] **Step 0: Trace in the graph** — `/graphify explain spec_s10` and `/graphify path "feat_history_resume" "screen_history"`; confirm the shell nav list has none of `drift_history_invented_nav`, `drift_*_extra_nav`.

- [ ] **Step 1: Write the failing unit tests** — `tests/unit/format.test.ts`

```ts
import { expect, test } from "vitest";
import { fmtBytes, fmtDuration, fmtInt, fmtMinutes, fmtPct, fmtTokens, hostPath } from "@/app/_ui/format";
import { clock } from "@/app/_ui/LogView";
import { relative } from "@/app/_ui/RelTime";

test("format.ts (vi-VN)", () => {
  expect(fmtInt(2_000_000)).toBe("2.000.000");
  expect(fmtPct(0.962)).toBe("96,2%");
  expect(fmtPct(0.95, 0)).toBe("95%");
  expect([fmtTokens(1_200_000), fmtTokens(2_000_000), fmtTokens(140_000), fmtTokens(861_000), fmtTokens(950)]).toEqual(["1,2M", "2M", "140k", "861k", "950"]);
  expect([fmtBytes(512), fmtBytes(19_046), fmtBytes(3 * 1024 * 1024)]).toEqual(["512 B", "18,6 KB", "3,0 MB"]);
  expect([fmtDuration(252_000), fmtDuration(0), fmtDuration(3_723_000)]).toEqual(["00:04:12", "00:00:00", "01:02:03"]);
  expect([fmtMinutes(45), fmtMinutes(360), fmtMinutes(1216.5)]).toEqual(["<1 phút", "~6 phút", "~20 phút"]);
  expect([hostPath("https://stripe.com/"), hostPath("https://stripe.com/pricing?x=1")]).toEqual(["stripe.com", "stripe.com/pricing"]);
});

test("relative time (vi) and log clock", () => {
  const now = Date.UTC(2026, 8, 24, 12, 0, 0);
  expect(relative(now - 12_000, now)).toBe("12 giây trước");
  expect(relative(now - 5 * 60_000, now)).toBe("5 phút trước");
  expect(relative(now - 86_400_000, now)).toBe("hôm qua");
  expect(clock(new Date(2026, 8, 24, 14, 22, 1, 104).getTime())).toBe("14:22:01.104");
});
```

`tests/unit/ui-components.test.ts`

```ts
import { expect, test } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GridTable } from "@/app/_ui/GridTable";
import { IconButton } from "@/app/_ui/IconButton";
import { PageHeader } from "@/app/_ui/PageHeader";
import { ProgressBar } from "@/app/_ui/ProgressBar";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { StatusPill } from "@/app/_ui/StatusPill";

const STATUSES = ["draft", "running", "paused", "interrupted", "needs_auth", "failed", "completed"];

test("StatusPill: text is always the status code; running pings, the 6 others carry an icon; queued adds 'đang chờ'", () => {
  for (const s of STATUSES) {
    const html = renderToStaticMarkup(h(StatusPill, { status: s }));
    expect(html).toContain(`>${s}</span>`);
    expect(html.includes("ping")).toBe(s === "running");
    expect(html.includes("<svg")).toBe(s !== "running");
  }
  expect(renderToStaticMarkup(h(StatusPill, { status: "draft", queued: true }))).toContain("đang chờ");
  expect(renderToStaticMarkup(h(StatusPill, { status: "failed", "data-ui": "x" }))).toContain('data-ui="x"');
});

test("IconButton names itself: aria-label + title from the required label", () => {
  const html = renderToStaticMarkup(h(IconButton, { icon: "delete", label: "Xóa", tone: "danger" }));
  expect(html).toContain('aria-label="Xóa"');
  expect(html).toContain('title="Xóa"');
  expect(html).toContain("tone-danger");
  expect(html).toContain('type="button"');
});

test("GridTable: ARIA table roles, grid template from the widths, row tone", () => {
  const html = renderToStaticMarkup(
    h(GridTable<{ id: string; warn: boolean }>, {
      label: "T",
      columns: [{ key: "a", header: "A", width: "120px" }, { key: "b", header: "B", width: "minmax(0, 1fr)" }],
      rows: [{ id: "1", warn: true }, { id: "2", warn: false }],
      rowKey: (r) => r.id,
      renderCell: (r, k) => `${k}${r.id}`,
      rowTone: (r) => (r.warn ? "warn" : undefined),
    }),
  );
  expect(html).toContain('role="table"');
  expect(html.match(/role="row"/g)).toHaveLength(3);
  expect(html.match(/role="columnheader"/g)).toHaveLength(2);
  expect(html.match(/role="cell"/g)).toHaveLength(4);
  expect(html).toContain("grid-template-columns:120px minmax(0, 1fr)");
  expect(html.match(/row-warn/g)).toHaveLength(1);
});

test("PageHeader: breadcrumb nav, last crumb aria-current, h1 title", () => {
  const html = renderToStaticMarkup(h(PageHeader, { crumbs: [{ label: "Lịch sử" }, { label: "Sitemap" }], title: "Chọn trang để clone" }));
  expect(html).toContain('aria-label="Breadcrumb"');
  expect(html).toContain('<span aria-current="page">Sitemap</span>');
  expect(html).toMatch(/<h1 class="t-headline-lg">Chọn trang để clone<\/h1>/);
});

test("SegmentedControl: tabs = tablist/tab/aria-selected with a count badge; toggle = group/aria-pressed", () => {
  const tabs = renderToStaticMarkup(
    h(SegmentedControl<"a" | "b">, { label: "L", semantics: "tabs", value: "a", onChange: () => {}, options: [{ value: "a", label: "A", count: 4 }, { value: "b", label: "B", count: 1 }] }),
  );
  expect(tabs).toContain('role="tablist"');
  expect(tabs.match(/role="tab"/g)).toHaveLength(2);
  expect(tabs).toContain('aria-selected="true"');
  expect(tabs).toContain("tone-accent");
  const toggle = renderToStaticMarkup(h(SegmentedControl<"a" | "b">, { label: "L", value: "b", onChange: () => {}, options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }));
  expect(toggle).toContain('role="group"');
  expect(toggle).toContain('aria-pressed="true"');
});

test("ProgressBar: progressbar role and the status color", () => {
  for (const [status, tone] of [["running", "primary"], ["needs_auth", "warn"], ["interrupted", "warn"], ["failed", "danger"], ["completed", "success"], ["paused", "neutral"]]) {
    const html = renderToStaticMarkup(h(ProgressBar, { value: 42, status: status!, label: "Tiến độ" }));
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain(`tone-${tone}`);
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/unit/format.test.ts tests/unit/ui-components.test.ts`
Expected: FAIL — modules `@/app/_ui/format`, `GridTable`, … not found.

- [ ] **Step 3: Write `src/app/_ui/format.ts`**

```ts
// Display formatting (vi-VN). Pure: used by server and client components alike.
const int = new Intl.NumberFormat("vi-VN");
const one = (x: number) => x.toFixed(1).replace(".", ",");

export const fmtInt = (n: number): string => int.format(Math.round(n));
export const fmtPct = (x: number, digits = 1): string => `${(x * 100).toFixed(digits).replace(".", ",")}%`;

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${one(n / 1_000_000).replace(/,0$/, "")}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${one(n / 1024)} KB`;
  return `${one(n / 1024 / 1024)} MB`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}

export const fmtMinutes = (s: number): string => (s < 60 ? "<1 phút" : `~${Math.round(s / 60)} phút`);

// "stripe.com/pricing": the breadcrumb label of a project.
export function hostPath(url: string): string {
  const u = new URL(url);
  return u.host + (u.pathname === "/" ? "" : u.pathname);
}
```

- [ ] **Step 4: Write the components** (one file each)

`src/app/_ui/Button.tsx`

```tsx
import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

type Look = {
  variant?: "primary" | "secondary" | "warn" | "danger" | "ghost";
  icon?: IconName;
  iconEnd?: IconName;
  size?: "md" | "lg";
  className?: string;
  children?: ReactNode;
  "data-ui"?: string;
};
type LinkProps = Look & { href: string; title?: string; "aria-current"?: "page" };
type NativeProps = Look & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className"> & { href?: undefined };
export type ButtonProps = LinkProps | NativeProps;

// Mono label (spec §1.2). type="button" unless the caller says type="submit".
export function Button(props: ButtonProps) {
  const { variant = "secondary", icon, iconEnd, size = "md", className, children } = props;
  const cls = ["btn", `btn-${variant}`, size === "lg" ? "btn-lg" : "", className ?? ""].filter(Boolean).join(" ");
  const px = size === "lg" ? 20 : 16;
  const body = (
    <>
      {icon && <Icon name={icon} size={px} />}
      {children}
      {iconEnd && <Icon name={iconEnd} size={px} />}
    </>
  );
  if (props.href !== undefined) {
    return (
      <Link href={props.href} className={cls} title={props.title} aria-current={props["aria-current"]} data-ui={props["data-ui"]}>
        {body}
      </Link>
    );
  }
  const { variant: _v, icon: _i, iconEnd: _e, size: _s, className: _c, children: _ch, href: _h, ...native } = props;
  return (
    <button type="button" {...native} className={cls}>
      {body}
    </button>
  );
}
```

`src/app/_ui/IconButton.tsx`

```tsx
import Link from "next/link";
import type { ButtonHTMLAttributes, Ref } from "react";
import { Icon, type IconName } from "./Icon";

type Base = { icon: IconName; label: string; tone?: "default" | "danger" | "success" | "warn"; className?: string; "data-ui"?: string };
type LinkProps = Base & { href: string; external?: boolean; current?: boolean };
type NativeProps = Base &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "className" | "title" | "aria-label"> & { href?: undefined; pressed?: boolean; ref?: Ref<HTMLButtonElement> };

// 28×28 ghost button. `label` is required: it becomes aria-label AND title (spec §1.5).
export function IconButton(props: LinkProps | NativeProps) {
  const cls = ["icon-btn", props.tone && props.tone !== "default" ? `tone-${props.tone}` : "", props.className ?? ""].filter(Boolean).join(" ");
  const svg = <Icon name={props.icon} />;
  if (props.href !== undefined) {
    const common = { className: cls, "aria-label": props.label, title: props.label, "data-ui": props["data-ui"] };
    return props.external ? (
      <a href={props.href} target="_blank" rel="noopener noreferrer" {...common}>
        {svg}
      </a>
    ) : (
      <Link href={props.href} aria-current={props.current ? "page" : undefined} {...common}>
        {svg}
      </Link>
    );
  }
  const { icon: _i, label, tone: _t, className: _c, href: _h, pressed, ...native } = props;
  return (
    <button type="button" {...native} className={cls} aria-label={label} title={label} aria-pressed={pressed}>
      {svg}
    </button>
  );
}
```

`src/app/_ui/StatusPill.tsx` (replace the whole file)

```tsx
import { Icon, type IconName } from "./Icon";

// Spec §4 statuses: the text is always the status code, color + icon only support it.
const LOOK: Record<string, { tone: string; icon?: IconName }> = {
  draft: { tone: "neutral", icon: "draft" },
  running: { tone: "primary" },
  paused: { tone: "neutral", icon: "pause_circle" },
  interrupted: { tone: "warn", icon: "warning" },
  needs_auth: { tone: "warn", icon: "lock" },
  failed: { tone: "danger", icon: "cancel" },
  completed: { tone: "success", icon: "check_circle" },
};

// queued: waiting in the job queue behind another project (the status is still the pre-run one)
export function StatusPill({ status, queued = false, ...ui }: { status: string; queued?: boolean; "data-ui"?: string }) {
  const look = LOOK[status] ?? { tone: "neutral" };
  return (
    <span className="pill-group" data-ui={ui["data-ui"]}>
      <span className={`pill tint tone-${look.tone}`} data-status={status}>
        {look.icon ? <Icon name={look.icon} size={14} /> : <span className={`dot${status === "running" ? " ping" : ""}`} aria-hidden="true" />}
        {status}
      </span>
      {queued && (
        <span className="pill tint tone-primary">
          <Icon name="schedule" size={14} />
          đang chờ
        </span>
      )}
    </span>
  );
}
```

`src/app/_ui/Badge.tsx`

```tsx
import type { ReactNode } from "react";

export function Badge({ tone = "neutral", title, children, ...ui }: { tone?: "neutral" | "primary" | "success" | "warn" | "danger" | "accent"; title?: string; children: ReactNode; "data-ui"?: string }) {
  return (
    <span className={`badge tint tone-${tone}`} title={title} data-ui={ui["data-ui"]}>
      {children}
    </span>
  );
}
```

`src/app/_ui/SegmentedControl.tsx`

```tsx
"use client";
import type { KeyboardEvent, ReactNode } from "react";
import { Badge } from "./Badge";
import { Icon, type IconName } from "./Icon";

export type SegOption<T extends string> = { value: T; label: ReactNode; icon?: IconName; count?: number; disabled?: boolean; tone?: "warn" };
type Props<T extends string> = {
  label: string;
  options: SegOption<T>[];
  value: T;
  onChange(v: T): void;
  semantics?: "toggle" | "tabs";
  full?: boolean;
  "data-ui"?: string;
};

// toggle: role=group + aria-pressed. tabs: role=tablist/tab + aria-selected, ←/→ move between enabled tabs.
export function SegmentedControl<T extends string>({ label, options, value, onChange, semantics = "toggle", full = false, ...ui }: Props<T>) {
  const tabs = semantics === "tabs";
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!tabs || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const enabled = options.filter((o) => !o.disabled);
    const i = enabled.findIndex((o) => o.value === value);
    const next = enabled[(i + (e.key === "ArrowRight" ? 1 : enabled.length - 1)) % enabled.length];
    if (!next) return;
    e.preventDefault();
    onChange(next.value);
    e.currentTarget.querySelector<HTMLElement>(`[data-value="${CSS.escape(next.value)}"]`)?.focus();
  };
  return (
    <div
      role={tabs ? "tablist" : "group"}
      aria-label={label}
      className={`seg${tabs ? " seg-tabs" : ""}${full ? " seg-full" : ""}`}
      onKeyDown={onKey}
      data-ui={ui["data-ui"]}
    >
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            data-value={o.value}
            disabled={o.disabled}
            className={`seg-item${o.tone ? ` tone-${o.tone}` : ""}`}
            {...(tabs ? { role: "tab", "aria-selected": on, tabIndex: on ? 0 : -1 } : { "aria-pressed": on })}
            onClick={() => onChange(o.value)}
          >
            {o.icon && <Icon name={o.icon} />}
            {o.label}
            {o.count !== undefined && <Badge tone={on ? "accent" : "neutral"}>{o.count}</Badge>}
          </button>
        );
      })}
    </div>
  );
}
```

`src/app/_ui/GridTable.tsx`

```tsx
import type { ReactNode } from "react";

type Column = { key: string; header: ReactNode; width: string };
type Props<R> = {
  label: string;
  columns: Column[];
  rows: R[];
  rowKey(r: R): string;
  renderCell(r: R, key: string): ReactNode;
  rowTone?(r: R): "warn" | "danger" | undefined;
  rowProps?(r: R): { className?: string; "data-ui"?: string };
  empty?: ReactNode;
  "data-ui"?: string;
};

// ARIA table on divs (CSS grid rows): header band + rows, row tone = 5% warn/danger tint.
export function GridTable<R>({ label, columns, rows, rowKey, renderCell, rowTone, rowProps, empty, ...ui }: Props<R>) {
  const template = { gridTemplateColumns: columns.map((c) => c.width).join(" ") };
  return (
    <div role="table" aria-label={label} className="grid-table" data-ui={ui["data-ui"]}>
      <div role="rowgroup">
        <div role="row" className="grid-row grid-head" style={template}>
          {columns.map((c) => (
            <div role="columnheader" key={c.key}>
              {c.header}
            </div>
          ))}
        </div>
      </div>
      <div role="rowgroup">
        {rows.map((r) => {
          const tone = rowTone?.(r);
          const extra = rowProps?.(r);
          const cls = ["grid-row", tone ? `row-${tone}` : "", extra?.className ?? ""].filter(Boolean).join(" ");
          return (
            <div role="row" key={rowKey(r)} className={cls} style={template} data-ui={extra?.["data-ui"]}>
              {columns.map((c) => (
                <div role="cell" key={c.key}>
                  {renderCell(r, c.key)}
                </div>
              ))}
            </div>
          );
        })}
      </div>
      {rows.length === 0 && empty}
    </div>
  );
}
```

`src/app/_ui/PageHeader.tsx`

```tsx
import Link from "next/link";
import type { ReactNode } from "react";
import { hostPath } from "./format";

export type Crumb = { label: string; href?: string };

// "Lịch sử / <host+path> / <screen>" for every /p/[id] screen (no "Task #", no "Pipelines").
export const projectCrumbs = (url: string, id: string, screen: string): Crumb[] => [
  { label: "Lịch sử", href: "/" },
  { label: hostPath(url), href: `/p/${id}` },
  { label: screen },
];

type Props = { crumbs: Crumb[]; title: ReactNode; subtitle?: ReactNode; meta?: ReactNode; actions?: ReactNode; "data-ui"?: string };

export function PageHeader({ crumbs, title, subtitle, meta, actions, ...ui }: Props) {
  return (
    <div className="page-header" data-ui={ui["data-ui"]}>
      <div className="page-header-main">
        {/* the shell-level part of every page header (spec §2.1 ui_shell_page_header): the breadcrumb */}
        <nav aria-label="Breadcrumb" className="crumbs" data-ui="ui_shell_page_header">
          <ol>
            {crumbs.map((c, i) => (
              <li key={i}>
                {i === crumbs.length - 1 ? <span aria-current="page">{c.label}</span> : c.href ? <Link href={c.href}>{c.label}</Link> : <span>{c.label}</span>}
              </li>
            ))}
          </ol>
        </nav>
        <div className="page-title">
          <h1 className="t-headline-lg">{title}</h1>
          {meta}
        </div>
        {subtitle && <p className="t-body-lg page-subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}
```

`src/app/_ui/UrlChip.tsx`

```tsx
"use client";
import { useState, type ReactNode } from "react";
import { IconButton } from "./IconButton";

type Props = { url: string; openable?: boolean; copyable?: boolean; plain?: boolean; extra?: ReactNode; "data-ui"?: string };

export function UrlChip({ url, openable = false, copyable = false, plain = false, extra, ...ui }: Props) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  return (
    <span className={`url-chip${plain ? " url-chip-plain" : ""}`} data-ui={ui["data-ui"]}>
      <span className="mono url-chip-text" title={url}>
        {url}
      </span>
      {openable && <IconButton icon="open_in_new" label="Mở trang gốc trong tab mới" href={url} external />}
      {copyable && <IconButton icon="content_copy" label={copied ? "Đã sao chép" : "Sao chép URL"} onClick={copy} />}
      {extra}
    </span>
  );
}
```

`src/app/_ui/Card.tsx`

```tsx
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

type Props = {
  title?: ReactNode;
  icon?: IconName;
  hint?: ReactNode;
  actions?: ReactNode;
  variant?: "section";
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
  "data-ui"?: string;
};

export function Card({ title, icon, hint, actions, variant, className, children, ...rest }: Props) {
  return (
    <section className={`panel${className ? ` ${className}` : ""}`} aria-label={rest["aria-label"]} data-ui={rest["data-ui"]}>
      {(title || actions) && (
        <div className="panel-head">
          {icon && <Icon name={icon} size={20} />}
          <h2 className={variant === "section" ? "t-label-md upper" : "t-headline-sm"}>{title}</h2>
          {hint && <span className="panel-hint t-label-sm">{hint}</span>}
          {actions}
        </div>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}
```

`src/app/_ui/Field.tsx`

```tsx
import type { ReactNode } from "react";

// The <label> wraps only the label text + the control, so the accessible name is exactly `label`
// (suffix is aria-hidden; hintEnd/hint sit outside the label).
type Props = { label: ReactNode; hint?: ReactNode; hintEnd?: ReactNode; suffix?: string; className?: string; children: ReactNode; "data-ui"?: string };

export function Field({ label, hint, hintEnd, suffix, className, children, ...ui }: Props) {
  return (
    <div className={`field-x${className ? ` ${className}` : ""}`} data-ui={ui["data-ui"]}>
      <label>
        <span className="field-label">{label}</span>
        <span className={`field-control${suffix ? " has-suffix" : ""}`}>
          {children}
          {suffix && (
            <span className="field-suffix t-label-sm" aria-hidden="true">
              {suffix}
            </span>
          )}
        </span>
      </label>
      {hintEnd && <span className="field-hint-end t-label-sm">{hintEnd}</span>}
      {hint && <span className="field-hint t-body-sm">{hint}</span>}
    </div>
  );
}
```

`src/app/_ui/SearchInput.tsx`

```tsx
"use client";
import { Icon } from "./Icon";

type Props = { label: string; placeholder: string; value: string; onChange(v: string): void; onSubmit?(): void; "data-ui"?: string };

// Literal substring search: callers filter with includes(), never a RegExp.
export function SearchInput({ label, placeholder, value, onChange, onSubmit, ...ui }: Props) {
  const input = (
    <span className="search-input">
      <Icon name="search" />
      <input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    </span>
  );
  if (!onSubmit) return <span data-ui={ui["data-ui"]}>{input}</span>;
  return (
    <form
      role="search"
      data-ui={ui["data-ui"]}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {input}
    </form>
  );
}
```

`src/app/_ui/PasswordInput.tsx`

```tsx
"use client";
import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { IconButton } from "./IconButton";

// The eye only switches type password <-> text on what the user is typing: this input is never given a stored secret.
// The toggle sits outside the <label> so the input's accessible name stays exactly `label`.
type Props = { label: string; hint?: ReactNode; "data-ui"?: string } & Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "id">;

export function PasswordInput({ label, hint, ...props }: Props) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const { "data-ui": ui, ...input } = props;
  return (
    <div className="field-x" data-ui={ui}>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <span className="field-control pw">
        <input id={id} type={shown ? "text" : "password"} autoComplete="off" {...input} />
        <IconButton icon={shown ? "visibility_off" : "visibility"} label={shown ? "Ẩn mật khẩu" : "Hiện mật khẩu"} pressed={shown} onClick={() => setShown((s) => !s)} />
      </span>
      {hint && <span className="field-hint t-body-sm">{hint}</span>}
    </div>
  );
}
```

`src/app/_ui/StatTile.tsx`

```tsx
import type { ReactNode } from "react";

export function StatTile({ label, value, tone, ...ui }: { label: string; value: ReactNode; tone?: "warn"; "data-ui"?: string }) {
  return (
    <div className={`stat-tile${tone ? ` tone-${tone}` : ""}`} data-ui={ui["data-ui"]}>
      <span className="t-label-sm stat-label">{label}</span>
      <span className="t-label-md stat-value">{value}</span>
    </div>
  );
}
```

`src/app/_ui/ProgressBar.tsx`

```tsx
const TONE: Record<string, string> = { running: "primary", needs_auth: "warn", interrupted: "warn", failed: "danger", completed: "success" };

export function ProgressBar({ value, status, label, ...ui }: { value: number; status: string; label: string; "data-ui"?: string }) {
  const v = Math.min(100, Math.max(0, value));
  return (
    <div className={`progress tone-${TONE[status] ?? "neutral"}`} role="progressbar" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100} data-ui={ui["data-ui"]}>
      <span style={{ width: `${v}%` }} />
    </div>
  );
}
```

`src/app/_ui/Banner.tsx`

```tsx
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

type Props = { tone: "warn" | "danger" | "info"; icon: IconName; title?: ReactNode; children?: ReactNode; actions?: ReactNode; role?: "alert" | "status"; "data-ui"?: string };

export function Banner({ tone, icon, title, children, actions, role, ...ui }: Props) {
  return (
    <div className={`banner tint tone-${tone === "info" ? "primary" : tone}`} role={role ?? (tone === "info" ? undefined : "alert")} data-ui={ui["data-ui"]}>
      <span className="banner-icon">
        <Icon name={icon} size={20} />
      </span>
      <div className="banner-body">
        {title && <div className="banner-title">{title}</div>}
        {children && <div className="banner-text">{children}</div>}
      </div>
      {actions && <div className="banner-actions">{actions}</div>}
    </div>
  );
}
```

`src/app/_ui/RelTime.tsx`

```tsx
"use client";
import { useEffect, useState } from "react";

const rtf = new Intl.RelativeTimeFormat("vi", { numeric: "auto" });

// Pure: "12 giây trước", "5 phút trước", "hôm qua" (ICU capitalizes "Hôm qua": lowercased, it follows a prefix).
export function relative(ms: number, now: number): string {
  const s = Math.round((ms - now) / 1000);
  const abs = Math.abs(s);
  const text =
    abs < 60 ? rtf.format(s, "second") : abs < 3600 ? rtf.format(Math.round(s / 60), "minute") : abs < 86_400 ? rtf.format(Math.round(s / 3600), "hour") : rtf.format(Math.round(s / 86_400), "day");
  return text.toLocaleLowerCase("vi");
}

// One interval for every mounted RelTime (not one timer per instance), stopped when none is left.
const subscribers = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function useTick(): void {
  const [, setN] = useState(0);
  useEffect(() => {
    const tick = () => setN((n) => n + 1);
    subscribers.add(tick);
    timer ??= setInterval(() => subscribers.forEach((f) => f()), 30_000);
    return () => {
      subscribers.delete(tick);
      if (subscribers.size === 0 && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  }, []);
}

// SSR + hydration render the absolute date; after mount the relative one (title keeps the absolute date).
export function RelTime({ at, unit = "s", prefix = "", ...ui }: { at: number; unit?: "s" | "ms"; prefix?: string; "data-ui"?: string }) {
  const ms = unit === "s" ? at * 1000 : at;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useTick();
  const absolute = new Date(ms).toLocaleString("vi-VN");
  return (
    <time dateTime={new Date(ms).toISOString()} title={absolute} suppressHydrationWarning data-ui={ui["data-ui"]}>
      {prefix}
      {mounted ? relative(ms, Date.now()) : absolute}
    </time>
  );
}
```

`src/app/_ui/LogView.tsx`

```tsx
import type { ReactNode, Ref, UIEvent } from "react";

export type LogLine = { n: number; at: number; level: "info" | "warn" | "error"; text: string };

// Local wall clock of the server's `at` stamp: "14:22:01.104".
export function clock(at: number): string {
  const d = new Date(at);
  const p = (x: number, w = 2) => String(x).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

type Props = { lines: LogLine[]; wrap: boolean; empty: ReactNode; ref?: Ref<HTMLDivElement>; onScroll?(e: UIEvent<HTMLDivElement>): void; lineUi?: string; "data-ui"?: string };

export function LogView({ lines, wrap, empty, ref, onScroll, lineUi, ...ui }: Props) {
  return (
    <div ref={ref} className={`log-view${wrap ? " wrap" : ""}`} role="log" aria-live="polite" onScroll={onScroll} data-ui={ui["data-ui"]}>
      {lines.length === 0 && <span className="log-empty">{empty}</span>}
      {lines.map((l) => (
        <div key={l.n} className={`log-line log-${l.level}`} data-ui={lineUi}>
          <span className="log-time">[{clock(l.at)}]</span> <span className="log-level">[{l.level.toUpperCase()}]</span> {l.text}
        </div>
      ))}
    </div>
  );
}
```

`src/app/_ui/Disclosure.tsx`

```tsx
import type { ReactNode } from "react";
import { Icon } from "./Icon";

export function Disclosure({ summary, defaultOpen = false, className, children, ...ui }: { summary: ReactNode; defaultOpen?: boolean; className?: string; children: ReactNode; "data-ui"?: string }) {
  return (
    <details className={`disclosure${className ? ` ${className}` : ""}`} open={defaultOpen} data-ui={ui["data-ui"]}>
      <summary>
        <Icon name="chevron_right" className="disclosure-chevron" />
        {summary}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
```

`src/app/_ui/download.ts`

```ts
// The export ZIP is a POST (JSON body: the CSRF guard), so it is streamed into a blob and saved via <a download>.
export async function downloadZip(projectId: string, stripIds: boolean): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/export`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode: "zip", stripIds }),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new Error(`${err.code ?? res.status}: ${err.message ?? res.statusText}`);
  }
  const href = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href, download: `${projectId}.zip` }).click();
  setTimeout(() => URL.revokeObjectURL(href), 10_000); // after the download has started
}
```

`src/app/_ui/Shell.tsx`

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Button } from "./Button";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./IconButton";

type NavLink = { href: string; label: string; icon: IconName; active: boolean };

// Only real routes (spec parity §2.1): no Engines/Telemetry/Docs/version chips/bell/avatar.
export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const projectId = /^\/p\/([^/]+)/.exec(path)?.[1];
  const general: NavLink[] = [
    { href: "/", label: "Lịch sử", icon: "history", active: path === "/" },
    { href: "/new", label: "Clone mới", icon: "add", active: path.startsWith("/new") },
    { href: "/settings/ai", label: "Cài đặt AI", icon: "settings", active: path.startsWith("/settings/ai") },
  ];
  const base = projectId ? `/p/${projectId}` : "";
  const project: NavLink[] = projectId
    ? [
        { href: base, label: "Tiến độ", icon: "timeline", active: path === base },
        { href: `${base}/sitemap`, label: "Sitemap", icon: "account_tree", active: path === `${base}/sitemap` },
        { href: `${base}/preview`, label: "Preview", icon: "difference", active: path === `${base}/preview` },
        { href: `${base}/editor`, label: "Editor", icon: "edit", active: path === `${base}/editor` },
        { href: `${base}/code`, label: "Code", icon: "code", active: path === `${base}/code` },
      ]
    : [];
  return (
    <>
      <header className="shell-header" data-ui="ui_shell_header">
        <Link href="/" className="shell-brand">
          <Icon name="code" size={20} />
          AI Web Clone
        </Link>
        <div className="shell-header-actions">
          <Button variant="primary" icon="add" href="/new" data-ui="ui_shell_new_clone_cta">
            Clone mới
          </Button>
          <IconButton icon="settings" label="Cài đặt AI" href="/settings/ai" current={path.startsWith("/settings/ai")} data-ui="ui_shell_settings_link" />
        </div>
      </header>
      <aside className="shell-sidebar">
        <NavGroup title="Chung" links={general} ui="ui_shell_sidebar_nav" />
        {projectId && <NavGroup title="Dự án" links={project} ui="ui_shell_project_nav" />}
      </aside>
      <main className="shell-main">{children}</main>
    </>
  );
}

function NavGroup({ title, links, ui }: { title: string; links: NavLink[]; ui: string }) {
  return (
    <nav aria-label={title} data-ui={ui}>
      <p className="nav-group">{title}</p>
      <ul>
        {links.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="nav-item" aria-current={l.active ? "page" : undefined} aria-label={l.label} title={l.label}>
              <Icon name={l.icon} />
              <span className="nav-label">{l.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
```

- [ ] **Step 5: Mount the shell** — `src/app/layout.tsx`

```tsx
import type { ReactNode } from "react";
import { Inter, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { Shell } from "./_ui/Shell";
import "./globals.css";

// Self-hosted at build time by next/font: no runtime font CDN.
const head = Space_Grotesk({ subsets: ["latin", "vietnamese"], variable: "--font-head" });
const body = Inter({ subsets: ["latin", "vietnamese"], variable: "--font-body" });
const mono = JetBrains_Mono({ subsets: ["latin", "vietnamese"], variable: "--font-mono" });

export const metadata = { title: "AI Web Clone" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" className={`${head.variable} ${body.variable} ${mono.variable}`}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
```

Remove the per-page project link rows (the sidebar replaces them; duplicate "Editor" links would also break the editor smoke test):
- `src/app/p/[id]/page.tsx`: replace the `<div className="row spread">…</div>` block (h1 + `<nav aria-label="Dự án">`) with `<h1>Tiến độ clone</h1>` and drop the now-unused `Link` import.
- `src/app/p/[id]/preview/page.tsx`: same → `<h1>Preview &amp; QA</h1>`, drop `Link`.
- `src/app/p/[id]/code/page.tsx`: same → `<h1>Mã nguồn</h1>`, drop `Link` only if unused (the file tree still uses it — keep).
- `src/app/p/[id]/editor/page.tsx`: same → `<h1>Editor</h1>`, drop `Link`.

In `src/app/p/[id]/code/export-panel.tsx` replace the body of `zip` with the shared helper:

```tsx
  const zip = () =>
    run(async () => {
      await downloadZip(projectId, stripIds);
      return "Đã tải ZIP.";
    });
```
(add `import { downloadZip } from "@/app/_ui/download";`, remove the inline fetch/blob code and the now-unused `path` usage only if `folder` no longer needs it — `folder` still posts to `path`, keep it).

- [ ] **Step 6: Component + shell CSS** — in `src/app/globals.css` delete the `/* legacy: pill */` block and, from `/* legacy: shared */`, the lines `.btn { … }`, `.btn:hover…`, `.btn:disabled…`, `main.page…`, `.topbar…` (4 lines) and `.brand…`; then insert after the Utilities section:

```css
/* === Shell === */
.shell-header { position: fixed; inset: 0 0 auto 0; height: 56px; z-index: 20; display: flex; align-items: center; justify-content: space-between; padding: 0 var(--s-lg); background: var(--c-surface-lowest); border-bottom: 1px solid var(--c-border); }
.shell-brand { display: inline-flex; align-items: center; gap: var(--s-sm); color: var(--c-text); text-decoration: none; font: var(--t-headline-sm); }
.shell-header-actions { display: flex; align-items: center; gap: var(--s-sm); }
.shell-sidebar { position: fixed; top: 56px; left: 0; width: 224px; height: calc(100vh - 56px); z-index: 10; overflow-y: auto; padding: var(--s-md) var(--s-sm); display: grid; align-content: start; gap: var(--s-lg); background: var(--c-surface-lowest); border-right: 1px solid var(--c-border); }
.shell-sidebar ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.nav-group { margin: 0 0 var(--s-xs); padding: 0 var(--s-sm); font: var(--t-label-sm); color: var(--c-text-3); text-transform: uppercase; letter-spacing: 0.05em; }
.nav-item { display: flex; align-items: center; gap: var(--s-sm); height: 32px; padding: 0 var(--s-sm); border-left: 2px solid transparent; border-radius: var(--r-sm); color: var(--c-text-2); text-decoration: none; font: var(--t-label-md); }
.nav-item:hover { background: var(--c-surface-low); color: var(--c-text); }
.nav-item[aria-current="page"] { background: var(--c-surface-highest); color: var(--c-primary); border-left-color: var(--c-primary); }
.shell-main { padding: 72px 16px 16px 240px; min-width: 0; }
@media (max-width: 1023px) {
  .shell-sidebar { width: 56px; padding: var(--s-md) var(--s-xs); }
  .nav-group, .nav-label { display: none; }
  .nav-item { justify-content: center; padding: 0; }
  .shell-main { padding-left: 72px; }
}

/* === Button / IconButton === */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 6px 12px; font: var(--t-label-md); white-space: nowrap; cursor: pointer; text-decoration: none; color: var(--c-text); background: var(--c-surface-high); border: 1px solid var(--c-border); border-radius: var(--r-sm); }
.btn:hover:not(:disabled) { background: var(--c-surface-bright); }
.btn:active:not(:disabled) { transform: scale(0.98); }
.btn:disabled, .btn[aria-disabled="true"] { opacity: 0.45; cursor: not-allowed; }
.btn-primary { background: var(--c-primary); border-color: var(--c-primary); color: var(--c-on-primary); }
.btn-primary:hover:not(:disabled) { background: var(--c-primary-hover); }
.btn-warn { background: var(--c-warn); border-color: var(--c-warn); color: var(--c-on-warn); }
.btn-warn:hover:not(:disabled) { background: color-mix(in srgb, var(--c-warn) 85%, white); }
.btn-danger { color: var(--c-danger); }
.btn-ghost { background: transparent; border-color: transparent; }
.btn-ghost:hover:not(:disabled) { background: var(--c-surface); }
.btn-lg { padding: 10px 20px; font: var(--t-headline-sm); }
.btn-outline-warn { color: var(--c-warn); border-color: color-mix(in srgb, var(--c-warn) 50%, transparent); }
.btn[aria-pressed="true"] { background: var(--c-surface); border-color: var(--c-primary); color: var(--c-primary); }
.btn.text-success { color: var(--c-success); }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 28px; height: 28px; padding: 6px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--c-text-2); cursor: pointer; text-decoration: none; }
.icon-btn:hover:not(:disabled) { background: var(--c-surface); color: var(--c-text); }
.icon-btn:active:not(:disabled) { transform: scale(0.98); }
.icon-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.icon-btn[aria-current="page"], .icon-btn[aria-pressed="true"] { color: var(--c-primary); }
.icon-btn.tone-danger { color: var(--c-danger); }
.icon-btn.tone-success { color: var(--c-success); }
.icon-btn.tone-warn { color: var(--c-warn); background: color-mix(in srgb, var(--c-warn) 10%, transparent); }

/* === StatusPill / Badge === */
.pill-group { display: inline-flex; gap: var(--s-xs); flex-wrap: wrap; }
.pill, .badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: var(--r-sm); font: var(--t-label-sm); white-space: nowrap; }
.badge.tone-accent { background: var(--c-accent); border-color: transparent; color: var(--c-on-accent); }

/* === SegmentedControl === */
.seg { display: inline-flex; gap: 2px; padding: 2px; background: var(--c-surface-lowest); border: 1px solid var(--c-border); border-radius: var(--r-md); }
.seg-full { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; width: 100%; }
.seg-item { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 5px 12px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--c-text-2); font: var(--t-label-md); cursor: pointer; white-space: nowrap; }
.seg-item:hover:not(:disabled) { color: var(--c-text); }
.seg-item[aria-pressed="true"], .seg-item[aria-selected="true"] { background: var(--c-surface); color: var(--c-primary); }
.seg-tabs .seg-item[aria-selected="true"] { box-shadow: inset 0 -2px 0 var(--c-primary); }
.seg-item:disabled { opacity: 0.45; cursor: not-allowed; }
.seg-item.tone-warn { color: var(--c-warn); }

/* === GridTable === */
.grid-table { border: 1px solid var(--c-border); border-radius: var(--r-lg); overflow: hidden; background: var(--c-surface-lowest); }
.grid-row { display: grid; align-items: center; gap: var(--s-md); padding: 0 var(--s-lg); min-height: 44px; border-bottom: 1px solid var(--c-border); }
.grid-table > [role="rowgroup"]:last-of-type > .grid-row:last-child { border-bottom: 0; }
.grid-head { min-height: 36px; background: var(--c-surface); color: var(--c-text-2); font: var(--t-label-sm); text-transform: uppercase; letter-spacing: 0.05em; }
.grid-row:not(.grid-head):hover { background: var(--c-surface-low); }
.grid-row.row-warn { background: color-mix(in srgb, var(--c-warn) 5%, transparent); }
.grid-row.row-danger { background: color-mix(in srgb, var(--c-danger) 5%, transparent); }
.grid-row > [role="cell"] { min-width: 0; padding: var(--s-sm) 0; }

/* === PageHeader === */
.page-header { display: flex; justify-content: space-between; align-items: flex-end; gap: var(--s-lg); flex-wrap: wrap; padding-bottom: var(--s-lg); margin-bottom: var(--s-lg); border-bottom: 1px solid var(--c-border); }
.page-header-main { min-width: 0; }
.crumbs ol { list-style: none; display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 var(--s-xs); padding: 0; font: var(--t-label-md); color: var(--c-text-3); }
.crumbs li { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 480px; }
.crumbs li + li::before { content: "/"; margin-right: 6px; color: var(--c-border); }
.crumbs a { color: var(--c-text-3); text-decoration: none; }
.crumbs a:hover { color: var(--c-text); }
.crumbs [aria-current="page"] { color: var(--c-primary); }
.page-title { display: flex; align-items: center; gap: var(--s-md); flex-wrap: wrap; }
.page-subtitle { margin: var(--s-xs) 0 0; color: var(--c-text-2); }
.page-actions { display: flex; align-items: center; gap: var(--s-sm); flex-wrap: wrap; }

/* === UrlChip === */
.url-chip { display: inline-flex; align-items: center; gap: 2px; max-width: 100%; min-width: 0; padding: 1px 2px 1px 8px; background: var(--c-surface-lowest); border: 1px solid var(--c-border); border-radius: var(--r-sm); }
.url-chip-plain { background: none; border: 0; padding: 0; }
.url-chip-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

/* === Card === */
.panel { background: var(--c-surface-low); border: 1px solid var(--c-border); border-radius: var(--r-lg); min-width: 0; }
.panel-head { display: flex; align-items: center; gap: var(--s-sm); padding: 12px 16px; border-bottom: 1px solid var(--c-border); }
.panel-head h2 { margin: 0; flex: 1; display: flex; align-items: center; gap: var(--s-sm); }
.panel-hint { color: var(--c-text-3); }
.panel-body { padding: 16px; display: grid; gap: var(--s-md); }

/* === Field / SearchInput / PasswordInput === */
.field-x { position: relative; display: grid; gap: var(--s-xs); min-width: 0; }
.field-x > label { display: grid; gap: var(--s-xs); }
.field-label { font: var(--t-label-md); color: var(--c-text-2); }
.field-hint-end { position: absolute; top: 2px; right: 0; color: var(--c-text-3); }
.field-hint { color: var(--c-text-3); }
.field-control { position: relative; display: flex; align-items: center; min-width: 0; }
.field-control > input, .field-control > select { flex: 1; min-width: 0; }
.field-control.has-suffix > input { padding-right: 64px; }
.field-suffix { position: absolute; right: 10px; color: var(--c-text-3); pointer-events: none; }
.pw > input { padding-right: 36px; }
.pw > .icon-btn { position: absolute; right: 2px; }
.search-input { position: relative; display: inline-flex; align-items: center; min-width: 240px; }
.search-input > .icon { position: absolute; left: 8px; color: var(--c-text-3); pointer-events: none; }
.search-input > input { width: 100%; padding-left: 30px; }

/* === StatTile / ProgressBar / Banner / Disclosure === */
.stat-tile { display: grid; gap: 2px; padding: 6px 12px; border: 1px solid var(--c-border); border-radius: var(--r-md); }
.stat-label { color: var(--c-text-3); text-transform: uppercase; letter-spacing: 0.05em; }
.stat-tile.tone-warn .stat-value { color: var(--c-warn); }
.progress { height: 4px; border-radius: var(--r-full); background: var(--c-surface-highest); overflow: hidden; }
.progress > span { display: block; height: 100%; background: var(--tone); }
.progress.tone-neutral { --tone: var(--c-text-3); }
.banner { display: flex; align-items: center; gap: var(--s-md); padding: 12px 16px; border-radius: var(--r-lg); }
.banner-icon { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 32px; height: 32px; border-radius: var(--r-md); background: color-mix(in srgb, var(--tone) 15%, transparent); }
.banner-body { flex: 1; min-width: 0; color: var(--c-text); font: var(--t-body-md); }
.banner-title { font-weight: 600; color: var(--tone); margin-bottom: 2px; }
.banner-actions { display: flex; gap: var(--s-sm); flex-wrap: wrap; }
.disclosure > summary { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; font: var(--t-label-md); color: var(--c-text-2); }
.disclosure > summary::-webkit-details-marker { display: none; }
.disclosure-chevron { transition: transform 0.15s; }
.disclosure[open] > summary .disclosure-chevron { transform: rotate(90deg); }
.disclosure-body { margin-top: var(--s-sm); }
.section-gap { margin-top: var(--s-lg); }

/* === LogView === */
.log-view { overflow: auto; background: var(--c-surface-lowest); font: var(--t-label-md); padding: var(--s-sm) 0; white-space: pre; }
.log-view.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.log-line { padding: 1px var(--s-md); border-left: 2px solid transparent; }
.log-line.log-warn { background: color-mix(in srgb, var(--c-warn) 5%, transparent); border-left-color: var(--c-warn); }
.log-line.log-error { background: color-mix(in srgb, var(--c-danger) 5%, transparent); border-left-color: var(--c-danger); }
.log-time, .log-level { color: var(--c-text-3); }
.log-warn .log-level { color: var(--c-warn); }
.log-error .log-level { color: var(--c-danger); }
.log-empty { padding: 0 var(--s-md); color: var(--c-text-3); }
```

- [ ] **Step 7: Run the unit tests to verify they pass**

Run: `npx vitest run tests/unit/format.test.ts tests/unit/ui-components.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 8: Smoke-test helpers**

`tests/e2e/ui-checks.ts`

```ts
// Shared UI smoke assertions (spec parity §7.2).
import { expect } from "vitest";
import type { Page } from "playwright";

// Stitch-invented strings that must never be rendered (spec §5 + §7.2). Iframe (clone) content is not in body.innerText.
export const DRIFT: RegExp[] = [
  /Turnstile/i, /Cloudflare/i, /Inject Auth/i, /Inject Cookies/i, /\.har\b/i, /Puppeteer/i, /Stealth/i, /Auto-reconcile/i,
  /Approve/i, /Deploy/i, /Telemetry/i, /\bPID\b/, /Daemon/i, /worker#/i, /Thread #/i, /Build Successful/i, /Export Package/i,
  /Save as preset/i, /Figma/i, /Markdown/i, /DOM Delta/i, /\bAbort\b/i, /Configure Rules/i, /\bEngine/i, /Cluster/i,
  /DevBrowser/i, /main branch/i, /Synced/i, /ROUTER ACTIVE/i, /High Precision/i, /AES-256/i, /\$\s?\d/, /Task #/i,
  /claude-3/i, /gpt-4o/i,
];

export async function expectNoDrift(page: Page): Promise<void> {
  const text = await page.locator("body").innerText();
  for (const re of DRIFT) expect(text, `drift ${re}`).not.toMatch(re);
}

// Every button/link whose only content is an icon names itself with aria-label AND title.
export async function expectIconButtonsLabelled(page: Page): Promise<void> {
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("button, a")]
      .filter((el) => el.innerText.trim() === "" && el.querySelector("svg"))
      .filter((el) => !el.getAttribute("aria-label")?.trim() || !el.getAttribute("title")?.trim())
      .map((el) => el.outerHTML.slice(0, 160)),
  );
  expect(bad).toEqual([]);
}

// Any http(s) request off the loopback host (font CDN, icon CDN, …) is collected.
export function trackForeignRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if ((u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") seen.push(r.url());
  });
  return seen;
}

export async function expectUi(page: Page, ids: string[]): Promise<void> {
  for (const id of ids) expect(await page.locator(`[data-ui="${id}"]`).count(), id).toBeGreaterThan(0);
}
```

`tests/e2e/ui-seed.ts`

```ts
// Seeds app state straight into the next app's db (WAL: the server sees committed rows at once) + workspace files.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { PNG } from "pngjs";
import { projectConfigSchema } from "@/core/jobs-base";

export type SeedTask = { phase: string; key: string; status: string; errorCode?: string; errorMsg?: string; updatedAt?: number };
export type SeedProject = { url: string; status: string; mode?: "single" | "crawl"; progress?: number; config?: Record<string, unknown>; tasks?: SeedTask[] };

export function seedProject(db: DatabaseSync, p: SeedProject): string {
  const id = randomUUID();
  const cfg = projectConfigSchema.parse(p.config ?? {}); // the frozen config every screen reads, defaults filled in
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status,progress) VALUES(?,?,?,?,?,?)").run(id, p.url, p.mode ?? "single", JSON.stringify(cfg), p.status, p.progress ?? 0);
  const ins = db.prepare("INSERT INTO tasks(id,project_id,phase,key,status,error_code,error_msg,updated_at) VALUES(?,?,?,?,?,?,?,COALESCE(?,unixepoch()))");
  for (const t of p.tasks ?? []) ins.run(randomUUID(), id, t.phase, t.key, t.status, t.errorCode ?? null, t.errorMsg ?? null, t.updatedAt ?? null);
  return id;
}

export async function writeWs(root: string, id: string, rel: string, data: string | Uint8Array): Promise<void> {
  const path = join(root, id, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

export function pngOf(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h; i++) png.data.set([r, g, b, 255], i * 4);
  return PNG.sync.write(png);
}
```

`tests/e2e/parity-shots.ts`

```ts
// Parity screenshots (spec parity §7.1) for side-by-side review against docs/superpowers/design/stitch/*.png.
// Not a pass/fail check: a no-op unless PARITY_DIR is set, e.g.
//   PARITY_DIR=<scratchpad>/ui-parity npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright";

export async function parityShot(page: Page, name: string): Promise<void> {
  const dir = process.env.PARITY_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
}
```

- [ ] **Step 9: Shell smoke test** — in `tests/e2e/ui-smoke.test.ts` delete the local `DRIFT` const and `expectNoDrift` function, add the imports, and add the test:

```ts
import { expectIconButtonsLabelled, expectNoDrift, expectUi, trackForeignRequests } from "./ui-checks";
import { pngOf, seedProject, writeWs } from "./ui-seed";
import { parityShot } from "./parity-shots";
```

```ts
test("shell: fixed 56px header; 3 general nav items; under /p/[id] the 5 project links; no request off loopback", async () => {
  const db = openDb(env.DB_PATH);
  let id = "";
  try {
    id = seedProject(db, { url: "http://shell.test/", status: "draft" });
  } finally {
    db.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  await page.goto(`${base}/`);
  await expectUi(page, ["ui_shell_header", "ui_shell_new_clone_cta", "ui_shell_settings_link", "ui_shell_sidebar_nav"]);
  expect((await page.locator('[data-ui="ui_shell_header"]').boundingBox())?.height).toBe(56);
  const general = page.getByRole("navigation", { name: "Chung" });
  expect(await general.getByRole("link").allInnerTexts()).toEqual(["Lịch sử", "Clone mới", "Cài đặt AI"]);
  expect(await general.getByRole("link", { name: "Lịch sử" }).getAttribute("aria-current")).toBe("page");
  expect(await page.getByRole("navigation", { name: "Dự án" }).count()).toBe(0);

  await page.goto(`${base}/p/${id}/sitemap`);
  const project = page.getByRole("navigation", { name: "Dự án" });
  expect(await project.getByRole("link").allInnerTexts()).toEqual(["Tiến độ", "Sitemap", "Preview", "Editor", "Code"]);
  expect(await project.getByRole("link").evaluateAll((as) => as.map((a) => a.getAttribute("href")))).toEqual(
    ["", "/sitemap", "/preview", "/editor", "/code"].map((s) => `/p/${id}${s}`),
  );
  expect(await project.getByRole("link", { name: "Sitemap" }).getAttribute("aria-current")).toBe("page");

  for (const path of ["/new", "/settings/ai"]) await page.goto(`${base}${path}`);
  expect(await page.locator('[data-ui="ui_shell_settings_link"]').getAttribute("aria-current")).toBe("page");
  await expectIconButtonsLabelled(page);
  await expectNoDrift(page);
  expect(foreign).toEqual([]);
  await parityShot(page, "shell-settings");
  await page.close();
});
```
(`pngOf`/`writeWs` are imported now for the screen tasks; they are used from Task 8 on.)

- [ ] **Step 10: Run the e2e smoke + editor suites**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts tests/e2e/editor-smoke.test.ts`
Expected: PASS — the new shell test and every existing test (the editor test now clicks the sidebar's single "Editor" link).

- [ ] **Step 11: Parity screenshot** — rerun the shell test with `PARITY_DIR` set (see Conventions); compare `shell-settings.png` header/sidebar with the header + left sidebar frame of `docs/superpowers/design/stitch/history-alt3.png` (56px bar, 224px rail, active item: highest surface + primary text + 2px left bar). Note differences in the report.

- [ ] **Step 12: Typecheck, unit tests, build**

Run: `npx tsc --noEmit && npx vitest run`, then the build check (Conventions). Expected: clean, PASS, `grep-exit=1`.

- [ ] **Step 13: Commit**

```bash
git add src/app/_ui src/app/layout.tsx src/app/globals.css "src/app/p/[id]/page.tsx" "src/app/p/[id]/preview/page.tsx" "src/app/p/[id]/code/page.tsx" "src/app/p/[id]/editor/page.tsx" "src/app/p/[id]/code/export-panel.tsx" tests/unit/format.test.ts tests/unit/ui-components.test.ts tests/e2e/ui-checks.ts tests/e2e/ui-seed.ts tests/e2e/parity-shots.ts tests/e2e/ui-smoke.test.ts
git commit -m "feat(ui): app shell (56px header + 224px sidebar) and shared _ui components" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 3: Stamped + redacted events, durable bounded event tail, SSE replay (spec §4.1–4.2)

**Files:**
- Create: `src/core/event-log.ts`, `tests/unit/event-log.test.ts`, `tests/e2e/event-log.test.ts`
- Modify: `src/core/jobs-base.ts` (StampedEvent, secrets/redact moved in, stamping `emit`, `subscribe` pins the ring), `src/core/jobs.ts` (use the moved redact, `createProject` creates the workspace dir, re-export `StampedEvent`), `src/app/api/projects/[id]/events/route.ts` (history message first), `src/app/api/projects/[id]/route.ts` (`forget` after delete), `tests/unit/jobs.test.ts` (events now carry `at`), `tests/e2e/api.test.ts` (SSE test; files route 404 for event files), `tests/e2e/secrets.test.ts` (event files + replay grepped)

**Interfaces:**
- Consumes: `workspaceOf` (`src/core/fsx.ts`).
- Produces:
  - `src/core/event-log.ts`: `MAX_EVENTS = 2000`, `MAX_RINGS = 32`, `MAX_FIELD_CHARS = 2000`; `record(id: string, ev: StampedEvent): void`; `history(id: string): StampedEvent[]`; `settled(id: string): Promise<void>` (resolves when queued appends are on disk — tests and cross-process readers); `retain(id: string): () => void` (pins the ring while an SSE listener exists); `forget(id: string): void`.
  - `src/core/jobs-base.ts`: `type StampedEvent = JobEvent & { at: number }`; `subscribe(projectId, cb: (e: StampedEvent) => void): () => void`; `emit(projectId, e: JobEvent): void` (stamps, redacts `message|reason|error|url`, cuts to 2000 chars, records all but `progress`, then notifies); `setRunSecrets(projectId, secrets: string[])`, `clearRunSecrets(projectId)`, `redact(projectId, text): string`.
  - SSE `GET /api/projects/[id]/events`: first message `{"type":"history","events":StampedEvent[]}`, then `{"type":"status",status,queued,at}`, then live `StampedEvent`s.

- [ ] **Step 0: Trace in the graph** — `/graphify explain feat_job_queue_sse` and `/graphify explain mod_jobs` (or the node ids the graph prints for `jobs.ts`); confirm `rule_*` on secrets.

- [ ] **Step 1: Write the failing unit tests** — `tests/unit/event-log.test.ts`

```ts
import { expect, test } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { config } from "@/core/config";
import { forget, history, MAX_EVENTS, MAX_RINGS, record, retain, settled } from "@/core/event-log";
import { clearRunSecrets, emit, setRunSecrets, subscribe, type StampedEvent } from "@/core/jobs-base";

const wsOf = (id: string) => join(config.workspaceRoot, id);
async function newWs(): Promise<string> {
  const id = randomUUID();
  await mkdir(wsOf(id), { recursive: true });
  return id;
}
const ev = (i: number): StampedEvent => ({ type: "log", level: "info", message: `m${i}`, at: i });
const linesOf = async (id: string, f: string) => (await readFile(join(wsOf(id), f), "utf8").catch(() => "")).split("\n").filter(Boolean);

test("the ring keeps the newest MAX_EVENTS; the file rotates every MAX_EVENTS lines; a reload reads both files", async () => {
  const id = await newWs();
  for (let i = 0; i < MAX_EVENTS + 5; i++) record(id, ev(i));
  await settled(id);
  expect(history(id).map((e) => e.at)).toEqual(Array.from({ length: MAX_EVENTS }, (_, k) => k + 5));
  expect(await linesOf(id, "events.prev.jsonl")).toHaveLength(MAX_EVENTS);
  expect(await linesOf(id, "events.jsonl")).toHaveLength(5);
  forget(id); // as after a restart: rebuilt from disk
  const reloaded = history(id);
  expect(reloaded).toHaveLength(MAX_EVENTS);
  expect(reloaded.at(-1)?.at).toBe(MAX_EVENTS + 4);
});

test("load drops a torn last line (power loss mid-append)", async () => {
  const id = await newWs();
  await writeFile(join(wsOf(id), "events.jsonl"), `${JSON.stringify(ev(1))}\n${JSON.stringify(ev(2))}\n{"type":"log","le`);
  expect(history(id).map((e) => e.at)).toEqual([1, 2]);
});

test("an append after the workspace was deleted never recreates it", async () => {
  const id = await newWs();
  record(id, ev(1));
  await settled(id);
  await rm(wsOf(id), { recursive: true, force: true });
  record(id, ev(2));
  await settled(id);
  expect(existsSync(wsOf(id))).toBe(false);
});

test("eviction past MAX_RINGS spares a ring with a listener (retain) and drops an idle one", async () => {
  const pinned = await newWs();
  const idle = await newWs();
  record(pinned, ev(1));
  record(idle, ev(1));
  await Promise.all([settled(pinned), settled(idle)]);
  const release = retain(pinned);
  await rm(wsOf(pinned), { recursive: true, force: true }); // RAM is now the only copy
  await rm(wsOf(idle), { recursive: true, force: true });
  for (let i = 0; i < MAX_RINGS + 4; i++) history(randomUUID()); // touch many other projects
  expect(history(pinned)).toHaveLength(1);
  expect(history(idle)).toHaveLength(0); // evicted, reloaded from the (deleted) disk
  release();
});

test("emit stamps `at`, redacts the run's secrets, cuts strings at 2000 chars and never records progress", async () => {
  const id = await newWs();
  const got: StampedEvent[] = [];
  const off = subscribe(id, (e) => got.push(e));
  setRunSecrets(id, ["hunter2"]);
  emit(id, { type: "log", level: "warn", message: `pw=hunter2 ${"x".repeat(3000)}` });
  clearRunSecrets(id);
  emit(id, { type: "status", status: "running" });
  off();
  const [log] = got;
  expect(log?.type).toBe("log");
  const message = log?.type === "log" ? log.message : "";
  expect(message).toContain("[redacted]");
  expect(message).not.toContain("hunter2");
  expect(message.length).toBeLessThanOrEqual(2000);
  expect(typeof log?.at).toBe("number");
  expect(history(id).map((e) => e.type)).toEqual(["log", "status"]);
});
```
(`emit` of `progress` is covered in Task 4 once the event carries `tokensUsed`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/event-log.test.ts`
Expected: FAIL — `@/core/event-log` not found, `setRunSecrets` not exported.

- [ ] **Step 3: Write `src/core/event-log.ts`**

```ts
// Durable, bounded per-project event tail (spec parity §4.1): a RAM ring of the newest MAX_EVENTS stamped events,
// appended to workspace/<id>/events.jsonl and rotated to events.prev.jsonl every MAX_EVENTS lines, so the progress
// log survives a reload and a restart. A log, not a checkpoint: each line is complete or dropped on load.
// Never served by /files (ALLOWED stays out|qa|shots), never exported, never in the graph. No app/ import.
import { readFileSync } from "node:fs";
import { appendFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { workspaceOf } from "./fsx";
import type { StampedEvent } from "./jobs-base";

export const MAX_EVENTS = 2000; // ring per project, and the rotation threshold of the file
export const MAX_RINGS = 32; // rings kept in RAM
export const MAX_FIELD_CHARS = 2000; // string fields are cut at emit

type Ring = { events: StampedEvent[]; lines: number; writes: Promise<void>; pending: number; pins: number; warned: boolean };
const rings = new Map<string, Ring>(); // Map order = least recently used first

const filesOf = (id: string) => ({ current: join(workspaceOf(id), "events.jsonl"), prev: join(workspaceOf(id), "events.prev.jsonl") });

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((l) => l !== "");
  } catch {
    return []; // no file yet
  }
}

function parse(lines: string[]): StampedEvent[] {
  const out: StampedEvent[] = [];
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as StampedEvent;
      if (typeof e === "object" && e !== null && typeof e.at === "number") out.push(e);
    } catch {
      // a torn line (crash mid-append): dropped
    }
  }
  return out;
}

// Loads once per project per process (bounded: <= 2 x MAX_EVENTS lines), then touches it as most recently used.
function ringOf(id: string): Ring {
  const hit = rings.get(id);
  if (hit) {
    rings.delete(id);
    rings.set(id, hit);
    return hit;
  }
  const { current, prev } = filesOf(id);
  const cur = readLines(current);
  const ring: Ring = { events: parse([...readLines(prev), ...cur]).slice(-MAX_EVENTS), lines: cur.length, writes: Promise.resolve(), pending: 0, pins: 0, warned: false };
  rings.set(id, ring);
  evict(id);
  return ring;
}

// Past MAX_RINGS: drop the least recently used rings that have no SSE listener and no write in flight.
function evict(keep: string): void {
  for (const [id, r] of rings) {
    if (rings.size <= MAX_RINGS) return;
    if (id !== keep && r.pins === 0 && r.pending === 0) rings.delete(id);
  }
}

export function record(id: string, ev: StampedEvent): void {
  const ring = ringOf(id);
  ring.events.push(ev);
  if (ring.events.length > MAX_EVENTS) ring.events.splice(0, ring.events.length - MAX_EVENTS);
  const line = `${JSON.stringify(ev)}\n`;
  ring.pending++;
  // one write chain per project: appends never interleave, rotation happens between two appends
  ring.writes = ring.writes.then(async () => {
    const { current, prev } = filesOf(id);
    try {
      await appendFile(current, line); // creates the file, never the directory (a deleted project stays deleted)
      if (++ring.lines >= MAX_EVENTS) {
        await rename(current, prev); // atomic, replaces the older segment
        ring.lines = 0;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !ring.warned) {
        ring.warned = true; // once per project: a log write failure never breaks a job
        console.error(`event-log: cannot write ${current}: ${(e as Error).message}`);
      }
    } finally {
      ring.pending--;
    }
  });
}

export const history = (id: string): StampedEvent[] => [...ringOf(id).events];

export const settled = (id: string): Promise<void> => rings.get(id)?.writes ?? Promise.resolve();

export function retain(id: string): () => void {
  const ring = ringOf(id);
  ring.pins++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ring.pins--;
  };
}

// After DELETE /api/projects/[id] removed the workspace and rows.
export function forget(id: string): void {
  rings.delete(id);
}
```

- [ ] **Step 4: Rework `src/core/jobs-base.ts`** — add the import at the top and replace everything from `// --- event bus ---` to the end of the file with:

```ts
import { MAX_FIELD_CHARS, record, retain } from "./event-log";
```

```ts
// --- event bus -------------------------------------------------------------------

export type ProjectStatus = "draft" | "running" | "paused" | "interrupted" | "needs_auth" | "failed" | "completed";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "needs_auth";
export type JobEvent =
  | { type: "status"; status: ProjectStatus; reason?: string; queued?: boolean } // queued: only on the SSE's snapshot message
  | { type: "phase"; phase: string }
  | { type: "task"; phase: string; key: string; status: TaskStatus; errorCode?: string; error?: string }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "needs_auth"; url: string; code: string }
  | { type: "progress"; progress: number };
// Server-stamped (epoch ms) in emit: log times and the run clock are real, not the client's receive time.
export type StampedEvent = JobEvent & { at: number };

const listeners = new Map<string, Set<(e: StampedEvent) => void>>();

// A listener pins the project's event ring in RAM (never evicted while an SSE stream is open).
export function subscribe(projectId: string, cb: (e: StampedEvent) => void): () => void {
  const set = listeners.get(projectId) ?? new Set();
  listeners.set(projectId, set.add(cb));
  const release = retain(projectId);
  return () => {
    set.delete(cb);
    if (set.size === 0) listeners.delete(projectId);
    release();
  };
}

// --- secrets of live runs ------------------------------------------------------------
// Login credentials of each running project: never in an event (SSE, events.jsonl) nor in error_msg (a Playwright
// error can echo a filled value). Longest first, so a user name inside the password can't leave part of it.
const secretsOf = new Map<string, string[]>();

export function setRunSecrets(projectId: string, secrets: string[]): void {
  secretsOf.set(projectId, secrets.filter((s) => s.length > 0).sort((a, b) => b.length - a.length));
}

export function clearRunSecrets(projectId: string): void {
  secretsOf.delete(projectId);
}

export function redact(projectId: string, text: string): string {
  let out = text;
  for (const secret of secretsOf.get(projectId) ?? []) out = out.split(secret).join("[redacted]");
  return out;
}

const REDACTED_FIELDS = ["message", "reason", "error", "url"] as const;

// Fixed order, synchronous: stamp + redact + cut, record (all but progress: noisy, derivable), then notify.
export function emit(projectId: string, e: JobEvent): void {
  const stamped: StampedEvent = { ...e, at: Date.now() };
  const bag: Record<string, unknown> = stamped;
  for (const k of REDACTED_FIELDS) {
    const v = bag[k];
    if (typeof v === "string") bag[k] = redact(projectId, v).slice(0, MAX_FIELD_CHARS);
  }
  if (stamped.type !== "progress") record(projectId, stamped);
  for (const cb of listeners.get(projectId) ?? []) {
    try {
      cb(stamped);
    } catch {
      // a broken subscriber (closed SSE stream) must never break the job
    }
  }
}
```

- [ ] **Step 5: Update `src/core/jobs.ts`**
  - `import { mkdirSync } from "node:fs";`
  - Delete the local `secretsOf` map and `redact` function (lines "The login credentials of each live run … return out; }"); import them instead: change the jobs-base import to `import { clearRunSecrets, createSchema, emit, pageIdsFor, redact, setRunSecrets, type ProjectConfig, type ProjectStatus, type TaskStatus } from "./jobs-base";`
  - Re-export: `export { pageIdsFor, projectConfigSchema, subscribe, type JobEvent, type ProjectConfig, type ProjectStatus, type StampedEvent } from "./jobs-base";`
  - In `runProject`: replace `secretsOf.set(projectId, [user, pass].filter((s): s is string => !!s).sort((a, b) => b.length - a.length));` with `setRunSecrets(projectId, [user ?? "", pass ?? ""]);` and in `finally` replace `secretsOf.delete(projectId);` with `clearRunSecrets(projectId);`.
  - `createProject`: the event log appends into the workspace but never creates it, so create it with the row:

```ts
export function createProject(db: DatabaseSync, input: { url: string; mode: "single" | "crawl"; config: unknown }): string {
  const { url, mode, config: cfg } = createSchema.parse(input);
  const id = randomUUID();
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES(?,?,?,?,'draft')").run(id, url, mode, JSON.stringify(cfg));
  mkdirSync(workspaceOf(id), { recursive: true }); // events.jsonl lives here (the event log never creates the dir)
  return id;
}
```

- [ ] **Step 6: SSE replay** — `src/app/api/projects/[id]/events/route.ts` (whole file)

```ts
import { history } from "@/core/event-log";
import { isWaiting, subscribe } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { handle, requireProject, type IdCtx } from "@/app/_server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;
const MAX_BUFFERED = 1_000; // a client this far behind is gone or stuck: close instead of buffering forever

// SSE (spec parity §4.2): the persisted event tail (<= 2000, for the log + run clock after a reload/restart), then the
// current status (+ whether it waits in the queue), then every live job event, plus a heartbeat comment. Snapshot,
// status and subscribe happen in one synchronous tick: no event is lost or sent twice.
export function GET(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    const { status } = requireProject(getDb(), id);
    const enc = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const close = () => {
          cleanup();
          try {
            controller.close();
          } catch {
            // already closed or cancelled by the reader
          }
        };
        const send = (chunk: string) => {
          if ((controller.desiredSize ?? 0) < -MAX_BUFFERED) return close();
          controller.enqueue(enc.encode(chunk));
        };
        send(`data: ${JSON.stringify({ type: "history", events: history(id) })}\n\n`);
        send(`data: ${JSON.stringify({ type: "status", status, queued: isWaiting(id), at: Date.now() })}\n\n`);
        const unsubscribe = subscribe(id, (e) => send(`data: ${JSON.stringify(e)}\n\n`));
        const heartbeat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
        cleanup = () => {
          unsubscribe();
          clearInterval(heartbeat);
          req.signal.removeEventListener("abort", close);
        };
        req.signal.addEventListener("abort", close);
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" } });
  });
}
```

- [ ] **Step 7: Forget on delete** — `src/app/api/projects/[id]/route.ts`: `import { forget } from "@/core/event-log";` and after the `tx(db, …)` inside `exclusive` add `forget(id); // the event ring of a deleted project`.

- [ ] **Step 8: Run the unit tests**

Run: `npx vitest run tests/unit/event-log.test.ts`
Expected: PASS (5 tests).
Run: `npx vitest run`
Expected: one FAIL in `tests/unit/jobs.test.ts` ("subscribe: listeners get events…") — events now carry `at`. Fix the expectation:

```ts
  expect(got).toEqual([{ type: "status", status: "interrupted", at: expect.any(Number) }]);
```
Re-run `npx vitest run` → all PASS.

- [ ] **Step 9: Update the e2e API test** — in `tests/e2e/api.test.ts` replace the test "SSE streams the current status, then job events, and closes on abort" with:

```ts
test("SSE: persisted history first, then the current status, then live stamped events; closes on abort; replayed next time", async () => {
  const id = await newProject();
  const open = async () => {
    const ac = new AbortController();
    const res = await events.GET(new Request("http://127.0.0.1", { signal: ac.signal }), ctx({ id }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const next = async () => JSON.parse(dec.decode((await reader.read()).value).replace(/^data: /, "")) as Record<string, unknown>;
    return { ac, reader, next };
  };
  const first = await open();
  expect(await first.next()).toEqual({ type: "history", events: [] });
  expect(await first.next()).toEqual({ type: "status", status: "draft", queued: false, at: expect.any(Number) });
  emit(id, { type: "log", level: "info", message: "hello" });
  expect(await first.next()).toEqual({ type: "log", level: "info", message: "hello", at: expect.any(Number) });
  first.ac.abort();
  expect((await first.reader.read()).done).toBe(true);
  emit(id, { type: "log", level: "info", message: "after close" }); // must not throw into the job

  const second = await open();
  const replay = (await second.next()) as { type: string; events: { message: string }[] };
  expect(replay.type).toBe("history");
  expect(replay.events.map((e) => e.message)).toEqual(["hello", "after close"]);
  second.ac.abort();
});
```
In "start maps a full queue to 429 QUEUE_FULL" the SSE's first chunk is now the history message; replace
`expect(new TextDecoder().decode((await sse.body!.getReader().read()).value)).toContain('"queued":true');` with

```ts
  const sseReader = sse.body!.getReader();
  expect(new TextDecoder().decode((await sseReader.read()).value)).toContain('"type":"history"');
  expect(new TextDecoder().decode((await sseReader.read()).value)).toContain('"queued":true');
```

In "export: zip streams out/ as a valid zip; …" add, right after the two `writeFile` calls into `out/`, `await writeFile(join(config.workspaceRoot, id, "events.jsonl"), "{}
");` — the existing exact `toEqual` on the unzipped entries then proves the event log never enters the ZIP.

and in "files route serves only allowlisted workspace dirs and rejects traversal" add before the traversal lines:

```ts
  await writeFile(join(ws, "events.jsonl"), "{}\n");
  await writeFile(join(ws, "events.prev.jsonl"), "{}\n");
  expect((await files.GET(new Request("http://127.0.0.1"), ctx({ id, path: ["events.jsonl"] }))).status).toBe(404);
  expect((await files.GET(new Request("http://127.0.0.1"), ctx({ id, path: ["events.prev.jsonl"] }))).status).toBe(404);
```

- [ ] **Step 10: Write the e2e durability test** — `tests/e2e/event-log.test.ts`

```ts
// Durable log (spec parity §7.4): a real site1 run leaves its events on disk; a fresh SSE replays them, also after
// the in-memory ring is gone (as after a restart).
import { afterAll, beforeAll, expect, test } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "@/core/config";
import { forget, settled } from "@/core/event-log";
import { createProject, enqueue, runProject, type JobDeps, type StampedEvent } from "@/core/jobs";
import type { SectionNames } from "@/core/naming";
import type { FixResult } from "@/core/qa-fix";
import { serveDir } from "@/core/serve";
import { getDb } from "@/app/_server/db";
import * as events from "@/app/api/projects/[id]/events/route";

const offline: JobDeps = {
  nameSections: async () => ({ names: {} as SectionNames }),
  fixAll: async (_ctx, failing) => failing.map((t): FixResult => ({ ...t, finalScore: 0, scores: { 375: 0, 768: 0, 1440: 0 }, rounds: 0, patched: false, status: "red" })),
};

let site: { url: string; close(): Promise<void> } | undefined;
let id = "";

beforeAll(async () => {
  site = await serveDir(fileURLToPath(new URL("../fixtures/site1", import.meta.url)));
  id = createProject(getDb(), { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0 } });
  await enqueue(getDb(), id, [`${site.url}/index.html`]);
  await runProject(getDb(), id, { deps: offline });
  await settled(id);
}, 300_000);

afterAll(async () => {
  await site?.close();
  if (id) await rm(join(config.workspaceRoot, id), { recursive: true, force: true, maxRetries: 3 });
});

async function replay(): Promise<StampedEvent[]> {
  const ac = new AbortController();
  const res = await events.GET(new Request("http://127.0.0.1", { signal: ac.signal }), { params: Promise.resolve({ id }) });
  const chunk = new TextDecoder().decode((await res.body!.getReader().read()).value);
  ac.abort();
  const msg = JSON.parse(chunk.replace(/^data: /, "")) as { type: string; events: StampedEvent[] };
  expect(msg.type).toBe("history");
  return msg.events;
}

test("a finished run is replayed from RAM, then from disk once the ring is gone; `at` never goes backwards", async () => {
  const live = await replay();
  expect(live.some((e) => e.type === "status" && e.status === "running")).toBe(true);
  expect(live.at(-1)).toMatchObject({ type: "status", status: "completed" });
  expect(live.every((e, i) => i === 0 || e.at >= live[i - 1]!.at)).toBe(true);
  expect(live.some((e) => e.type === "progress")).toBe(false);
  const onDisk = (await readFile(join(config.workspaceRoot, id, "events.jsonl"), "utf8")).split("\n").filter(Boolean);
  expect(onDisk).toHaveLength(live.length);

  forget(id); // as after a process restart
  expect(await replay()).toEqual(live);
});
```

- [ ] **Step 11: Extend the secrets test** — in `tests/e2e/secrets.test.ts` add `import { history, settled } from "@/core/event-log";`; directly after the `try { await runProject(…) } finally { …; off(); }` block add `await settled(projectId); // the event log's appends are on disk before the files are grepped`, and after the workspace-file leak check (`expect(fileLeaks).toEqual([]);`) add:

```ts
  expect(files.some((f) => f.endsWith("events.jsonl"))).toBe(true); // the durable log was grepped above
  expect(leaks(Buffer.from(JSON.stringify(history(projectId))))).toEqual([]); // the SSE history message
```

- [ ] **Step 12: Run the e2e suites touched**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/api.test.ts tests/e2e/event-log.test.ts tests/e2e/secrets.test.ts tests/e2e/jobs-resume.test.ts`
Expected: PASS.

- [ ] **Step 13: Typecheck + full unit run + build**

Run: `npx tsc --noEmit && npx vitest run` and the build check. Expected: clean, PASS, `grep-exit=1`.

- [ ] **Step 14: Commit**

```bash
git add src/core/event-log.ts src/core/jobs-base.ts src/core/jobs.ts "src/app/api/projects/[id]/events/route.ts" "src/app/api/projects/[id]/route.ts" tests/unit/event-log.test.ts tests/unit/jobs.test.ts tests/e2e/event-log.test.ts tests/e2e/api.test.ts tests/e2e/secrets.test.ts
git commit -m "feat(jobs): server-stamped redacted events, durable bounded event tail, SSE history replay" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: "Chạy lại QA" (`qa:rescore`) + `tokensUsed` on progress (spec §4.3, D3)

**Files:**
- Create: `src/app/api/projects/[id]/qa/rescore/route.ts`, `tests/e2e/rescore.test.ts`
- Modify: `src/core/jobs-base.ts` (progress event type), `src/core/jobs.ts` (`updateProgress`, `finishTask`, final progress emit, `requeueRescore`, `runQa`), `tests/unit/jobs-progress.test.ts`

**Interfaces:**
- Consumes: `emit`, `StampedEvent`, `subscribe` (Task 3); `exclusive` (`@/app/_server/session`), `handle`, `requireProject`, `requireStatus`, `optionalJson`, `ApiError`, `workspaceOf` (`@/app/_server/http`); `queueHasRoom`, `startProject`, `isWaiting` (`@/core/jobs`).
- Produces: `JobEvent` progress = `{ type: "progress"; progress: number; tokensUsed: number }`; `requeueRescore(db: DatabaseSync, projectId: string): void` exported from `@/core/jobs`; route `POST /api/projects/[id]/qa/rescore` → 202 `{ ok: true, queued: boolean }`; errors 409 `BAD_STATE` (not completed), 409 `NO_OUTPUT`, 409 `PROJECT_BUSY`, 429 `QUEUE_FULL`, 403 (CSRF).

- [ ] **Step 0: Trace in the graph** — `/graphify explain feat_qa_score` and `/graphify explain feat_fix_loop` (the rescore must not enter the fix loop); `/graphify explain spec_s9`.

- [ ] **Step 1: Write the failing unit test** — in `tests/unit/jobs-progress.test.ts` extend the jobs import to `import { createProject, discoverPages, subscribe, type StampedEvent } from "@/core/jobs";` and append:

```ts
test("progress events carry the project's tokensUsed (read in the same transaction)", async () => {
  const db = openDb(":memory:");
  const id = createProject(db, { url: "http://x.test/", mode: "single", config: {} });
  db.prepare("UPDATE projects SET tokens_used=42 WHERE id=?").run(id);
  const got: StampedEvent[] = [];
  const off = subscribe(id, (e) => got.push(e));
  await discoverPages(db, id, {} as BrowserHandle);
  off();
  expect(got.find((e) => e.type === "progress")).toMatchObject({ type: "progress", progress: 0, tokensUsed: 42 });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/jobs-progress.test.ts`
Expected: FAIL — the progress event has no `tokensUsed`.

- [ ] **Step 3: Implement `tokensUsed`**
  - `src/core/jobs-base.ts`: `| { type: "progress"; progress: number; tokensUsed: number };`
  - `src/core/jobs.ts`:

```ts
// discover is the sitemap step before the page selection: a draft (only discover done) is 0%, not 100%.
function updateProgress(db: DatabaseSync, projectId: string): { progress: number; tokensUsed: number } {
  const { total, done } = db
    .prepare("SELECT COUNT(*) total, COALESCE(SUM(status='done'),0) done FROM tasks WHERE project_id=? AND phase<>'discover'")
    .get(projectId) as { total: number; done: number };
  const progress = total ? Math.round((done * 100) / total) : 0;
  db.prepare("UPDATE projects SET progress=?,updated_at=unixepoch() WHERE id=?").run(progress, projectId);
  return { progress, tokensUsed: tokensUsedOf(db, projectId) };
}

const tokensUsedOf = (db: DatabaseSync, projectId: string): number =>
  (db.prepare("SELECT tokens_used FROM projects WHERE id=?").get(projectId) as { tokens_used: number } | undefined)?.tokens_used ?? 0;
```
In `finishTask`: rename the tx result to `p` and emit `emit(projectId, { type: "progress", ...p });`. In `runProject`, replace `emit(projectId, { type: "progress", progress: 100 });` with `emit(projectId, { type: "progress", progress: 100, tokensUsed: tokensUsedOf(db, projectId) });`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/jobs-progress.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing e2e test** — `tests/e2e/rescore.test.ts`

```ts
// "Chạy lại QA" (spec parity §4.3, D3): a completed clone re-scored through the job queue — no fix loop, no AI call.
import { afterAll, beforeAll, expect, test } from "vitest";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "@/core/config";
import { createProject, enqueue, runProject, saveEdited, startProject, subscribe, type JobDeps, type QaFile, type StampedEvent } from "@/core/jobs";
import type { SectionNames } from "@/core/naming";
import type { FixResult } from "@/core/qa-fix";
import { serveDir } from "@/core/serve";
import { getDb } from "@/app/_server/db";
import * as rescore from "@/app/api/projects/[id]/qa/rescore/route";

const offline: JobDeps = {
  nameSections: async () => ({ names: {} as SectionNames }),
  fixAll: async (_ctx, failing) => failing.map((t): FixResult => ({ ...t, finalScore: 0, scores: { 375: 0, 768: 0, 1440: 0 }, rounds: 0, patched: false, status: "red" })),
};

let site: { url: string; close(): Promise<void> } | undefined;
let id = "";
const created: string[] = [];

beforeAll(async () => {
  site = await serveDir(fileURLToPath(new URL("../fixtures/site1", import.meta.url)));
  id = createProject(getDb(), { url: `${site.url}/index.html`, mode: "single", config: { delayMs: 0 } });
  created.push(id);
  await enqueue(getDb(), id, [`${site.url}/index.html`]);
  await runProject(getDb(), id, { deps: offline });
}, 300_000);

afterAll(async () => {
  await site?.close();
  for (const x of created) await rm(join(config.workspaceRoot, x), { recursive: true, force: true, maxRetries: 3 });
});

const post = (x: string, init: RequestInit = {}) => rescore.POST(new Request("http://127.0.0.1", { method: "POST", ...init }), { params: Promise.resolve({ id: x }) });
const statusOf = (x: string) => (getDb().prepare("SELECT status FROM projects WHERE id=?").get(x) as { status: string }).status;
const codeOf = async (res: Response) => ((await res.json()) as { code: string }).code;

test("completed + stale: 202, running -> completed; qa.json rewritten without stale; no fix task, no token, only qa:rescore ran", async () => {
  const db = getDb();
  await saveEdited(db, id, (ir) => ir); // an editor save marks qa.json stale
  const qaPath = join(config.workspaceRoot, id, "qa.json");
  expect((JSON.parse(await readFile(qaPath, "utf8")) as QaFile).stale).toBe(true);
  const fixCount = () => (db.prepare("SELECT COUNT(*) n FROM tasks WHERE project_id=? AND phase='fix'").get(id) as { n: number }).n;
  const tokens = () => (db.prepare("SELECT tokens_used t FROM projects WHERE id=?").get(id) as { t: number }).t;
  const [fixesBefore, tokensBefore] = [fixCount(), tokens()];
  const seen: StampedEvent[] = [];
  const off = subscribe(id, (e) => seen.push(e));
  const res = await post(id);
  expect(res.status).toBe(202);
  expect(await res.json()).toEqual({ ok: true, queued: false });
  await expect.poll(() => seen.some((e) => e.type === "status" && e.status === "completed"), { timeout: 180_000 }).toBe(true);
  off();
  const qa = JSON.parse(await readFile(qaPath, "utf8")) as QaFile;
  expect(qa.stale).toBeUndefined();
  expect(qa.scores.length).toBeGreaterThan(0);
  expect(fixCount()).toBe(fixesBefore);
  expect(tokens()).toBe(tokensBefore);
  const tasks = seen.filter((e) => e.type === "task");
  expect(tasks.length).toBeGreaterThan(0);
  expect(tasks.every((e) => e.type === "task" && e.phase === "qa" && e.key === "rescore")).toBe(true);
  expect(seen.filter((e) => e.type === "status").map((e) => (e.type === "status" ? e.status : ""))).toEqual(["running", "completed"]);
});

test("refusals: not completed -> 409 BAD_STATE, no out/ -> 409 NO_OUTPUT, foreign Origin / text/plain body -> 403", async () => {
  const db = getDb();
  const draft = createProject(db, { url: "http://127.0.0.1:9/", mode: "single", config: {} });
  const bare = createProject(db, { url: "http://127.0.0.1:9/", mode: "single", config: {} });
  created.push(draft, bare);
  db.prepare("UPDATE projects SET status='completed' WHERE id=?").run(bare);
  const a = await post(draft);
  expect([a.status, await codeOf(a)]).toEqual([409, "BAD_STATE"]);
  const b = await post(bare);
  expect([b.status, await codeOf(b)]).toEqual([409, "NO_OUTPUT"]);
  expect((await post(id, { headers: { origin: "http://evil.test" } })).status).toBe(403);
  expect((await post(id, { body: "{}", headers: { "content-type": "text/plain", "content-length": "2" } })).status).toBe(403);
});

test("waiting in the queue -> a second press is 409 PROJECT_BUSY; a full queue -> 429 QUEUE_FULL before anything is requeued", async () => {
  const db = getDb();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const hang: JobDeps = {
    openBrowser: async () => {
      await gate;
      throw new Error("released by test");
    },
  };
  const completedWithOut = async () => {
    const x = createProject(db, { url: "http://127.0.0.1:9/", mode: "single", config: {} });
    created.push(x);
    db.prepare("UPDATE projects SET status='completed' WHERE id=?").run(x);
    await mkdir(join(config.workspaceRoot, x, "out"), { recursive: true });
    return x;
  };
  const fillers = Array.from({ length: 5 }, () => {
    const f = createProject(db, { url: "http://127.0.0.1:9/", mode: "single", config: {} });
    created.push(f);
    return f;
  });
  startProject(db, fillers[0]!, { deps: hang }); // the active job, blocked on the gate
  const q1 = await completedWithOut();
  const first = await post(q1);
  expect([first.status, await first.json()]).toEqual([202, { ok: true, queued: true }]);
  const again = await post(q1);
  expect([again.status, await codeOf(again)]).toEqual([409, "PROJECT_BUSY"]);
  for (const f of fillers.slice(1)) startProject(db, f, { deps: hang }); // waiting: q1 + 4 = 5
  const q2 = await completedWithOut();
  const full = await post(q2);
  expect([full.status, await codeOf(full)]).toEqual([429, "QUEUE_FULL"]);
  expect((db.prepare("SELECT COUNT(*) n FROM tasks WHERE project_id=? AND key='rescore'").get(q2) as { n: number }).n).toBe(0);
  release();
  await expect.poll(() => [...fillers, q1].every((x) => ["failed", "completed"].includes(statusOf(x))), { timeout: 60_000 }).toBe(true);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/rescore.test.ts`
Expected: FAIL — cannot resolve `@/app/api/projects/[id]/qa/rescore/route`.

- [ ] **Step 7: `requeueRescore` + `runQa`** — in `src/core/jobs.ts` after `enqueue`:

```ts
// "Chạy lại QA" (spec parity §4.3): one qa task keyed `rescore` (re-armed on every press), run through the queue like any
// job. runQa scores and rewrites qa.json (no `stale`) but creates no fix task: a manual edit is never auto-patched.
export function requeueRescore(db: DatabaseSync, projectId: string): void {
  db.prepare(
    "INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,'qa','rescore','pending') ON CONFLICT(project_id,phase,key) DO UPDATE SET status='pending',attempts=0,error_code=NULL,error_msg=NULL,updated_at=unixepoch()",
  ).run(randomUUID(), projectId);
}
```
and in `runQa` change the `finishTask` call to:

```ts
  finishTask(run.db, run.projectId, t, "qa.json", undefined, () => {
    if (t.key === "rescore") return; // the key is in the db: also right after an interrupt + resume
    for (const k of failing) insertTask(run.db, run.projectId, "fix", k);
  });
```

- [ ] **Step 8: The route** — `src/app/api/projects/[id]/qa/rescore/route.ts`

```ts
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AppError, Codes } from "@/core/errors";
import { isWaiting, queueHasRoom, requeueRescore, startProject } from "@/core/jobs";
import { getDb } from "@/app/_server/db";
import { ApiError, handle, optionalJson, requireProject, requireStatus, workspaceOf, type IdCtx } from "@/app/_server/http";
import { exclusive } from "@/app/_server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({}).strict();

// "Chạy lại QA" after an editor save: completed -> running -> completed through the job queue (1 running, <=5
// waiting), scoring only — no fix loop, no AI call. The editor can't save meanwhile (status is not completed).
export function POST(req: Request, { params }: IdCtx) {
  return handle(req, async () => {
    const { id } = await params;
    bodySchema.parse(await optionalJson(req));
    const db = getDb();
    requireStatus(requireProject(db, id), ["completed"], "rescore");
    if (!(await stat(join(workspaceOf(id), "out")).catch(() => null))?.isDirectory()) throw new ApiError(409, "NO_OUTPUT", "nothing emitted yet");
    await exclusive(id, async () => {
      // a full queue -> 429 before the task is re-armed
      if (!queueHasRoom()) throw new AppError(Codes.QUEUE_FULL, "job queue full", { projectId: id });
      requeueRescore(db, id);
      startProject(db, id);
    });
    return Response.json({ ok: true, queued: isWaiting(id) }, { status: 202 });
  });
}
```

- [ ] **Step 9: Run to verify it passes**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/rescore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 10: Regression + build**

Run: `npx tsc --noEmit && npx vitest run && npx vitest run -c vitest.e2e.config.ts tests/e2e/api.test.ts tests/e2e/qa-fixloop.test.ts tests/e2e/jobs-resume.test.ts`, then the build check. Expected: clean / PASS / `grep-exit=1`.

- [ ] **Step 11: Commit**

```bash
git add src/core/jobs-base.ts src/core/jobs.ts "src/app/api/projects/[id]/qa/rescore/route.ts" tests/unit/jobs-progress.test.ts tests/e2e/rescore.test.ts
git commit -m "feat(qa): re-score a completed clone through the queue (qa:rescore); progress carries tokensUsed" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 5: Crawl HTTP status + load time; provider Test latency + HTTP code, also for unsaved values (spec §4.4–4.5, D7)

**Files:**
- Modify: `src/core/crawl.ts`, `src/core/gateway.ts` (`fetchModels` return), `src/app/_server/providers.ts` (shared body union), `src/app/api/providers/models/route.ts`, `src/app/api/providers/test/route.ts`, `tests/e2e/crawl.test.ts`, `tests/unit/gateway.test.ts`, `tests/e2e/api.test.ts`, `tests/e2e/auth-draft.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `type CrawlPage = { url: string; needsAuth: boolean; status?: number | null; loadMs?: number; redirected?: boolean }` (fields optional: an older `discover.json` still parses; UI shows "—"); `fetchModels(kind, baseUrl, apiKey): Promise<{ models: string[]; httpStatus: number }>`; `providerBodySchema` (union: unsaved `{kind, baseUrl, apiKey}` | `{providerId}`) and `resolveProvider(db, body): { kind; baseUrl; apiKey }` in `@/app/_server/providers`; `POST /api/providers/test` → 200 `{ ok: true, models: number, latencyMs: number, httpStatus: number }`, errors unchanged (`AI_*` → 502, message carries "status <n>").

- [ ] **Step 0: Trace in the graph** — `/graphify explain feat_crawl` and `/graphify explain feat_ai_gateway`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/e2e/crawl.test.ts` (add `import { createServer } from "node:http"; import type { AddressInfo } from "node:net";`):

```ts
test("records per page the HTTP status, the time to DOMContentLoaded and whether it was redirected; no extra request", async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/robots.txt" || req.url === "/sitemap.xml") return void res.writeHead(404).end();
    if (req.url === "/old") return void res.writeHead(302, { location: "/new" }).end();
    if (req.url === "/private") return void res.writeHead(401, { "content-type": "text/html" }).end("<p>login required</p>");
    res.writeHead(200, { "content-type": "text/html" }).end('<a href="/old">old</a> <a href="/private">private</a> <a href="/new">new</a>');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const results = await crawl(handle, { start: `${origin}/`, depth: 1, maxPages: 20, sameOriginOnly: true, delayMs: 0 });
    const by = new Map(results.map((r) => [new URL(r.url).pathname, r]));
    expect(by.get("/")).toMatchObject({ status: 200, redirected: false, needsAuth: false });
    expect(by.get("/old")).toMatchObject({ status: 200, redirected: true });
    expect(by.get("/private")).toMatchObject({ status: 401, redirected: false, needsAuth: true });
    for (const r of results) expect(r.loadMs).toBeGreaterThanOrEqual(0);
    // one navigation per page (+ the redirect hop): the timing adds no request
    expect(hits.filter((h) => h === "/").length).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
```
In the first site3 test add after the `needsAuth` check: `expect(results.every((r) => r.status === 200 && (r.loadMs ?? -1) >= 0 && r.redirected === false)).toBe(true);`

`tests/unit/gateway.test.ts` — change the happy-path expectation:

```ts
  const res = await fetchModels("openai", "https://o/v1", "sk-secret-key");
  expect(res).toEqual({ models: ["x"], httpStatus: 200 });
```
(replacing `const ids = …; expect(ids).toEqual(["x"]);`).

`tests/e2e/api.test.ts` — in "providers: GET masks the key; /test decrypts it server-side and counts models" replace `expect(await t.json()).toEqual({ ok: true, models: 2 });` with:

```ts
    const tested = (await t.json()) as { ok: boolean; models: number; latencyMs: number; httpStatus: number };
    expect(tested).toMatchObject({ ok: true, models: 2, httpStatus: 200 });
    expect(tested.latencyMs).toBeGreaterThanOrEqual(0);
    // D7: an unsaved form (Test before Save) works the same, with the typed values
    const unsaved = (await (await providerTest.POST(post({ kind: "openai", baseUrl, apiKey: "sk-unsaved-key-5555" }))).json()) as { models: number; httpStatus: number };
    expect(unsaved).toMatchObject({ models: 2, httpStatus: 200 });
    expect(seen.authorization).toBe("Bearer sk-unsaved-key-5555");
```
and add a test:

```ts
test("providers/test: an upstream 401 is 502 AI_AUTH with the status in the message; no key in the response", async () => {
  const server = createServer((_req, res) => res.writeHead(401).end("nope"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const res = await providerTest.POST(post({ kind: "anthropic", baseUrl, apiKey: "sk-denied-key-7777" }));
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ code: "AI_AUTH" });
    expect(text).toContain("401");
    expect(text).not.toContain("sk-denied-key-7777");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
```
`tests/e2e/auth-draft.test.ts` — the crawl result now carries HTTP fields; replace the two `toEqual([{ url: …, needsAuth: … }])` with `toMatchObject([{ url: \`${base}/\`, needsAuth: false, status: 200 }])` and `toMatchObject([{ url: \`${base}/\`, needsAuth: true, status: 200 }])`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/gateway.test.ts` → FAIL (array vs object).
Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/crawl.test.ts tests/e2e/api.test.ts -t "records per page|providers"` → FAIL (no `status`; `/test` rejects the unsaved body with 400).

- [ ] **Step 3: Crawl** — `src/core/crawl.ts`:

```ts
export type CrawlPage = { url: string; needsAuth: boolean; status?: number | null; loadMs?: number; redirected?: boolean };

type Loaded = { links: string[]; needsAuth: boolean; status: number | null; loadMs: number; redirected: boolean };

// The navigation's own response: status, time to DOMContentLoaded, redirect — no extra request.
async function loadPage(handle: BrowserHandle, pageUrl: string): Promise<Loaded> {
  return withPage(handle, async (page) => {
    const t0 = performance.now();
    const response = await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
    const loadMs = Math.round(performance.now() - t0);
    const authState = await detectNeedsAuth(page, { status: response?.status(), requestedUrl: pageUrl });
    // `any`: $$eval runs in the browser context, not Node — no DOM lib types here.
    const links = await page.$$eval("a[href]", (anchors: any[]) => anchors.map((a) => a.getAttribute("href") ?? ""));
    return { links, needsAuth: authState !== "none", status: response?.status() ?? null, loadMs, redirected: !!response?.request().redirectedFrom() };
  });
}
```
Keep the existing `any` comment line as is (pre-existing, browser context); in `crawl()` change `let page: { links: string[]; needsAuth: boolean };` to `let page: Loaded;` and the push to:

```ts
    results.push({ url: item.url, needsAuth: page.needsAuth, status: page.status, loadMs: page.loadMs, redirected: page.redirected });
```

- [ ] **Step 4: Gateway** — `src/core/gateway.ts`:

```ts
export async function fetchModels(kind: ProviderKind, baseUrl: string, apiKey: string): Promise<{ models: string[]; httpStatus: number }> {
  const url = `${baseUrl}/models`;
  const res = await fetch(url, { headers: modelsHeaders(kind, apiKey), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    const { code } = mapHttpError(res.status);
    throw new AppError(code, `fetchModels failed with status ${res.status}`, { status: res.status, url });
  }
  const raw = (await res.json()) as { data?: { id: string }[] };
  if (!Array.isArray(raw.data)) throw new AppError("AI_BAD_RESPONSE", "unexpected /models response shape", { url });
  return { models: raw.data.map((m) => m.id), httpStatus: res.status };
}
```

- [ ] **Step 5: Shared body union** — append to `src/app/_server/providers.ts`:

```ts
// /models and /test (D7): a form's unsaved values, or a saved provider (its key decrypted server-side only).
export const providerBodySchema = z.union([
  z.object({ kind: z.enum(["anthropic", "openai"]), baseUrl: baseUrlSchema, apiKey: z.string().min(1).max(4096) }).strict(),
  providerIdSchema,
]);

export function resolveProvider(db: DatabaseSync, body: z.infer<typeof providerBodySchema>): { kind: ProviderKind; baseUrl: string; apiKey: string } {
  return "providerId" in body ? storedProvider(db, body.providerId) : body;
}
```
`src/app/api/providers/models/route.ts` (whole file):

```ts
import { fetchModels } from "@/core/gateway";
import { getDb } from "@/app/_server/db";
import { handle } from "@/app/_server/http";
import { providerBodySchema, resolveProvider } from "@/app/_server/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handle(req, async () => {
    const p = resolveProvider(getDb(), providerBodySchema.parse(await req.json()));
    const { models } = await fetchModels(p.kind, p.baseUrl, p.apiKey);
    return Response.json({ models });
  });
}
```
`src/app/api/providers/test/route.ts` (whole file):

```ts
import { fetchModels } from "@/core/gateway";
import { getDb } from "@/app/_server/db";
import { handle } from "@/app/_server/http";
import { providerBodySchema, resolveProvider } from "@/app/_server/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One short request (GET /models) proves base URL + key, timed; failures map to AI_* -> 502 (message has the status).
export function POST(req: Request) {
  return handle(req, async () => {
    const p = resolveProvider(getDb(), providerBodySchema.parse(await req.json()));
    const t0 = performance.now();
    const { models, httpStatus } = await fetchModels(p.kind, p.baseUrl, p.apiKey);
    return Response.json({ ok: true, models: models.length, latencyMs: Math.round(performance.now() - t0), httpStatus });
  });
}
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run tests/unit/gateway.test.ts` → PASS.
Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/crawl.test.ts tests/e2e/api.test.ts tests/e2e/auth-draft.test.ts` → PASS.

- [ ] **Step 7: Typecheck + unit + build** — `npx tsc --noEmit && npx vitest run` + build check → clean / PASS / `grep-exit=1`.

- [ ] **Step 8: Commit**

```bash
git add src/core/crawl.ts src/core/gateway.ts src/app/_server/providers.ts src/app/api/providers/models/route.ts src/app/api/providers/test/route.ts tests/e2e/crawl.test.ts tests/unit/gateway.test.ts tests/e2e/api.test.ts tests/e2e/auth-draft.test.ts
git commit -m "feat(api): crawl records HTTP status/load time/redirect; provider Test reports latency + HTTP code, also unsaved" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Run estimate, list/preview API fields, `start` closes the login window, new limits (spec §4.6–4.8, D8)

**Files:**
- Create: `src/core/estimate.ts`, `tests/unit/estimate.test.ts`, `tests/unit/history-rates.test.ts`, `tests/e2e/start-auth-window.test.ts`
- Modify: `src/app/api/projects/route.ts` (GET fields), `src/app/api/projects/[id]/preview/route.ts` (`fixes`), `src/app/api/projects/[id]/start/route.ts` (D8), `src/app/p/[id]/data.ts` (`historyRates`, `tokens_used`), `tests/e2e/api.test.ts`, `docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md` (§1 limits table)

**Interfaces:**
- Consumes: `closeAuthWindow` (`@/app/_server/session`).
- Produces:
  - `@/core/estimate`: `type EstimateInput = { pages: number; concurrency: number; delayMs: number; tokenBudget: number; sectionsPerPage: number; fixRate: number }`, `type Estimate = { tokens: number; cappedByBudget: boolean; seconds: number; fixSections: number }`, `type HistoryRates = Pick<EstimateInput, "sectionsPerPage" | "fixRate">`, `estimateRun(i: EstimateInput): Estimate`, `NAME_TOKENS_PER_PAGE`, `FIX_TOKENS_PER_SECTION`, `DEFAULT_SECTIONS_PER_PAGE`, `DEFAULT_FIX_RATE`.
  - `@/app/p/[id]/data`: `historyRates(db?: DatabaseSync): HistoryRates`; `ProjectView` gains `tokens_used: number`.
  - `GET /api/projects` rows gain `pageCount: number | null`, `phaseDone: number | null`, `phaseTotal: number | null`, `lastError: { code: string | null; message: string; phase: string; key: string } | null`; body gains `counts: { incomplete: number; completed: number }` (same `q`, ignores `group`).
  - `GET /api/projects/[id]/preview` gains `fixes: { pageId: string; sectionId: string; status: TaskStatus; errorCode: string | null }[]` (≤2000).

- [ ] **Step 0: Trace in the graph** — `/graphify explain feat_history_resume`, `/graphify explain feat_auth` (D8), `/graphify explain spec_s1`.

- [ ] **Step 1: Write the failing unit tests**

`tests/unit/estimate.test.ts`

```ts
import { expect, test } from "vitest";
import { DEFAULT_FIX_RATE, DEFAULT_SECTIONS_PER_PAGE, estimateRun } from "@/core/estimate";

const base = { concurrency: 3, delayMs: 500, tokenBudget: 2_000_000, sectionsPerPage: DEFAULT_SECTIONS_PER_PAGE, fixRate: DEFAULT_FIX_RATE };

test("1 page: 2 fix sections, naming + fix tokens, capture/name/qa/fix/re-qa seconds", () => {
  expect(estimateRun({ ...base, pages: 1 })).toEqual({ tokens: 123_000, cappedByBudget: false, seconds: 199.5, fixSections: 2 });
});

test("100 pages hit the token budget; seconds follow the concurrency and the fix concurrency 2", () => {
  expect(estimateRun({ ...base, pages: 100 })).toEqual({ tokens: 2_000_000, cappedByBudget: true, seconds: 16_980, fixSections: 200 });
});

test("fixSections rounds up; no fix section -> no re-score pass; 0 pages -> 0", () => {
  expect(estimateRun({ ...base, pages: 3, fixRate: 0.1 }).fixSections).toBe(3); // 2.4 -> 3
  expect(estimateRun({ ...base, pages: 2, fixRate: 0 })).toEqual({ tokens: 6_000, cappedByBudget: false, seconds: 45 + 1 + 20 + 24, fixSections: 0 });
  expect(estimateRun({ ...base, pages: 0 })).toEqual({ tokens: 0, cappedByBudget: false, seconds: 0, fixSections: 0 });
});
```

`tests/unit/history-rates.test.ts`

```ts
import { expect, test } from "vitest";
import { openDb } from "@/core/db";
import { DEFAULT_FIX_RATE, DEFAULT_SECTIONS_PER_PAGE } from "@/core/estimate";
import { historyRates } from "@/app/p/[id]/data";

test("historyRates: defaults below 20 samples; measured ratios from completed projects once there are enough", () => {
  const db = openDb(":memory:");
  expect(historyRates(db)).toEqual({ sectionsPerPage: DEFAULT_SECTIONS_PER_PAGE, fixRate: DEFAULT_FIX_RATE });
  db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES('p','http://x/','crawl','{}','completed')").run();
  const node = db.prepare("INSERT INTO nodes(id,project_id,type,key,data_json) VALUES(?,?,?,?,'{}')");
  for (let i = 0; i < 20; i++) node.run(`page${i}`, "p", "Page", `/${i}`);
  for (let i = 0; i < 100; i++) node.run(`sec${i}`, "p", "Section", `s${i}`);
  const task = db.prepare("INSERT INTO tasks(id,project_id,phase,key,status) VALUES(?,?,'fix',?,'done')");
  for (let i = 0; i < 10; i++) task.run(`t${i}`, "p", `page0:sec${i}`);
  expect(historyRates(db)).toEqual({ sectionsPerPage: 5, fixRate: 0.1 });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/estimate.test.ts tests/unit/history-rates.test.ts`
Expected: FAIL — `@/core/estimate` missing, `historyRates` not exported.

- [ ] **Step 3: Write `src/core/estimate.ts`**

```ts
// Rough run estimate for the sitemap picker (spec parity §4.6): tokens and wall time for the selected pages.
// Pure and dependency-free: client components import it. Every constant is a coarse heuristic, not a measurement —
// recalibrate when real runs are timed. No money anywhere.
export type EstimateInput = { pages: number; concurrency: number; delayMs: number; tokenBudget: number; sectionsPerPage: number; fixRate: number };
export type Estimate = { tokens: number; cappedByBudget: boolean; seconds: number; fixSections: number };
export type HistoryRates = Pick<EstimateInput, "sectionsPerPage" | "fixRate">;

// naming: outline (depth-3 tag tree + 200 chars of text per section, ~8 sections ≈ 1 200 tokens) + thumbnail
// <= 400×1200 px (≈ w·h/750 ≈ 640 tokens) + prompt/answer ≈ 500
export const NAME_TOKENS_PER_PAGE = 3_000;
// 1 fix call ≈ 24 000 chars of context / 4 ≈ 6 000 + 3 crops ≈ 4 800 + answer <= 4 096 ≈ 15 000; assumed 2 rounds × 2
// calls on average (hard ceiling 3 rounds × 6 calls, always cut by the budget)
export const FIX_TOKENS_PER_SECTION = 60_000;
export const DEFAULT_SECTIONS_PER_PAGE = 8; // no history yet
export const DEFAULT_FIX_RATE = 0.25; // share of sections needing a fix, no history yet
const CAPTURE_S_PER_PAGE = 45; // load + lazy scroll + 3 breakpoints + interaction scan (the 5 min/page cap not counted)
const NAME_S_PER_PAGE = 10; // 1 AI call
const QA_S_PER_PAGE_BP = 4; // render + shoot 1 page × 1 breakpoint
const FIX_S_PER_SECTION = 120; // 2 rounds × (2 AI calls + re-score)
const FIX_CONCURRENCY = 2; // spec SP1 §1
const BPS = 3;

export function estimateRun(i: EstimateInput): Estimate {
  const fixSections = Math.ceil(i.pages * i.sectionsPerPage * i.fixRate);
  const raw = i.pages * NAME_TOKENS_PER_PAGE + fixSections * FIX_TOKENS_PER_SECTION;
  const qa = i.pages * BPS * QA_S_PER_PAGE_BP;
  const seconds =
    Math.ceil(i.pages / i.concurrency) * CAPTURE_S_PER_PAGE +
    (i.pages * i.delayMs) / 1000 +
    i.pages * NAME_S_PER_PAGE +
    qa +
    Math.ceil(fixSections / FIX_CONCURRENCY) * FIX_S_PER_SECTION +
    (fixSections > 0 ? qa : 0);
  return { tokens: Math.min(raw, i.tokenBudget), cappedByBudget: raw > i.tokenBudget, seconds, fixSections };
}
```

- [ ] **Step 4: `historyRates` + `tokens_used`** — `src/app/p/[id]/data.ts`: add imports `import type { DatabaseSync } from "node:sqlite";` and `import { DEFAULT_FIX_RATE, DEFAULT_SECTIONS_PER_PAGE, type HistoryRates } from "@/core/estimate";`; change `ProjectView`/`loadProject` to also select `tokens_used`:

```ts
export type ProjectView = { id: string; url: string; status: string; progress: number; config_json: string; tokens_used: number };

export function loadProject(id: string): ProjectView {
  const row = getDb().prepare("SELECT id,url,status,progress,config_json,tokens_used FROM projects WHERE id=?").get(id) as ProjectView | undefined;
  if (!row) notFound();
  return row;
}
```
and append:

```ts
const MIN_SAMPLE = 20; // below this a measured ratio is noise: the estimate's defaults are used

// The estimate's history-based rates (spec parity §4.6): 2 aggregate queries over the whole store.
export function historyRates(db: DatabaseSync = getDb()): HistoryRates {
  const all = db.prepare("SELECT COALESCE(SUM(type='Section'),0) sections, COALESCE(SUM(type='Page'),0) pages FROM nodes").get() as { sections: number; pages: number };
  const done = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM tasks t JOIN projects p ON p.id=t.project_id WHERE p.status='completed' AND t.phase='fix') fixes,
              (SELECT COUNT(*) FROM nodes n JOIN projects p ON p.id=n.project_id WHERE p.status='completed' AND n.type='Section') sections`,
    )
    .get() as { fixes: number; sections: number };
  return {
    sectionsPerPage: all.pages >= MIN_SAMPLE ? all.sections / all.pages : DEFAULT_SECTIONS_PER_PAGE,
    fixRate: done.sections >= MIN_SAMPLE ? done.fixes / done.sections : DEFAULT_FIX_RATE,
  };
}
```

- [ ] **Step 5: Run the unit tests** — `npx vitest run tests/unit/estimate.test.ts tests/unit/history-rates.test.ts` → PASS (4 tests).

- [ ] **Step 6: Write the failing API tests** — in `tests/e2e/api.test.ts` add `vi` to the vitest import and add:

```ts
test("GET /api/projects: counts (q, not group), pageCount, phaseDone/phaseTotal, lastError — fixed queries, no N+1", async () => {
  const db = getDb();
  const prefix = `https://list.test/${crypto.randomUUID()}/`;
  type T = [phase: string, key: string, status: string, code: string | null, msg: string | null];
  const mk = (suffix: string, status: string, tasks: T[]) => {
    const id = crypto.randomUUID();
    created.push(id);
    db.prepare("INSERT INTO projects(id,url,mode,config_json,status) VALUES(?,?,?,?,?)").run(id, prefix + suffix, "single", "{}", status);
    for (const [phase, key, st, code, msg] of tasks)
      db.prepare("INSERT INTO tasks(id,project_id,phase,key,status,error_code,error_msg) VALUES(?,?,?,?,?,?,?)").run(crypto.randomUUID(), id, phase, key, st, code, msg);
    return id;
  };
  const failed = mk("failed", "failed", [
    ["discover", prefix, "done", null, null],
    ["capture", "a", "done", null, null],
    ["capture", "b", "failed", "NAV_TIMEOUT", "timeout 30000ms"],
    ["ir", "all", "pending", null, null],
  ]);
  const auth = mk("auth", "needs_auth", [["capture", "home", "needs_auth", "AUTH_REQUIRED", "login wall at /home"]]);
  const draft = mk("draft", "draft", [["discover", prefix, "done", null, null]]);
  mk("done", "completed", [["capture", "home", "done", null, null]]);

  const spy = vi.spyOn(db, "prepare");
  type Body = { counts: { incomplete: number; completed: number }; total: number; projects: Record<string, unknown>[] };
  let body: Body;
  let sqls: string[];
  try {
    body = (await (await projects.GET(new Request(`http://127.0.0.1/api/projects?group=incomplete&q=${encodeURIComponent(prefix)}`))).json()) as Body;
    sqls = spy.mock.calls.map((c) => String(c[0]));
  } finally {
    spy.mockRestore();
  }
  expect(body.counts).toEqual({ incomplete: 3, completed: 1 });
  expect(body.total).toBe(3);
  const row = (id: string) => body.projects.find((p) => p.id === id);
  expect(row(failed)).toMatchObject({ phase: "capture", pageCount: 2, phaseDone: 1, phaseTotal: 2, lastError: { code: "NAV_TIMEOUT", message: "timeout 30000ms", phase: "capture", key: "b" } });
  expect(row(auth)).toMatchObject({ pageCount: 1, lastError: { code: "AUTH_REQUIRED", message: "login wall at /home", phase: "capture", key: "home" } });
  expect(row(draft)).toMatchObject({ pageCount: null, phaseDone: null, phaseTotal: null, lastError: null });
  const count = (re: RegExp) => sqls.filter((s) => re.test(s)).length;
  expect([count(/GROUP BY project_id, phase/), count(/ROW_NUMBER\(\)/), count(/SUM\(status<>'completed'\)/)]).toEqual([1, 1, 1]);
});
```
and extend "preview returns pages with emitted file names, qa scores and coverage": before the GET insert

```ts
  getDb().prepare("INSERT INTO tasks(id,project_id,phase,key,status,error_code) VALUES(?,?,'fix','home:s1','done','BUDGET_EXCEEDED')").run(crypto.randomUUID(), id);
```
widen the body type with `fixes: unknown[]` and add `expect(body.fixes).toEqual([{ pageId: "home", sectionId: "s1", status: "done", errorCode: "BUDGET_EXCEEDED" }]);`.

`tests/e2e/start-auth-window.test.ts`

```ts
// D8: "Bắt đầu clone" closes an open login window first (like /crawl) instead of answering 409 PROJECT_BUSY.
import { afterAll, expect, test, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserHandle } from "@/core/browser";
import { config } from "@/core/config";
import { getDb } from "@/app/_server/db";
import * as projects from "@/app/api/projects/route";
import * as authOpen from "@/app/api/projects/[id]/auth/open/route";
import * as start from "@/app/api/projects/[id]/start/route";

const { closed } = vi.hoisted(() => ({ closed: vi.fn(async () => {}) }));
// no headed Chrome in tests: the "window" is a fake handle whose close() is observable
vi.mock("@/core/browser", async (orig) => {
  const real = await orig<typeof import("@/core/browser")>();
  const fake = { context: { once: () => {}, newPage: async () => ({ goto: async () => null }) }, close: closed } as unknown as BrowserHandle;
  return { ...real, openBrowser: vi.fn(async () => fake) };
});

let id = "";
afterAll(async () => {
  if (id) await rm(join(config.workspaceRoot, id), { recursive: true, force: true, maxRetries: 3 });
});

const json = (body: unknown) => {
  const text = JSON.stringify(body);
  return new Request("http://127.0.0.1", { method: "POST", body: text, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) } });
};

test("draft + auth/open -> start is 202 (the window is closed first), not 409 PROJECT_BUSY", async () => {
  const url = "http://127.0.0.1:9/";
  id = ((await (await projects.POST(json({ url, mode: "single", config: { delayMs: 0, auth: { mode: "manual" } } }))).json()) as { id: string }).id;
  expect((await authOpen.POST(new Request("http://127.0.0.1", { method: "POST" }), { params: Promise.resolve({ id }) })).status).toBe(200);
  expect(closed).not.toHaveBeenCalled();
  const res = await start.POST(json({ pages: [url] }), { params: Promise.resolve({ id }) });
  expect(res.status).toBe(202);
  expect(closed).toHaveBeenCalled();
  // the queued run gets the fake browser and fails: wait for it so nothing leaks into later tests
  const statusOf = () => (getDb().prepare("SELECT status FROM projects WHERE id=?").get(id) as { status: string }).status;
  await expect.poll(statusOf, { timeout: 30_000 }).toBe("failed");
});
```
(vi.mock is hoisted above the imports, so every module above — session.ts, jobs.ts — gets the fake `openBrowser`; `withPage` stays real and fails on the fake handle, which ends the queued run as `failed`.)

- [ ] **Step 7: Run to verify failure**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/api.test.ts tests/e2e/start-auth-window.test.ts -t "GET /api/projects: counts|preview returns|draft \\+ auth/open"`
Expected: FAIL — no `counts`/`fixes`; start answers 409.

- [ ] **Step 8: List API** — in `src/app/api/projects/route.ts` replace `GET` with:

```ts
type LastError = { code: string | null; message: string; phase: string; key: string };

// History list: 20 per page, newest update first, `q` = URL substring, `phase` = first unfinished task's phase,
// `thumbPage` = first captured pageId, `needsCredentials` = resume must ask for a login first, `queued` = waiting in
// the job queue; per row `pageCount` (capture tasks; null = draft without a selection), `phaseDone/phaseTotal` of the
// current phase, `lastError` (failed | needs_auth only, message <= 500 chars, redacted when written); `counts` per
// group under the same `q`. Fixed number of queries per request (no per-task query).
export function GET(req: Request) {
  return handle(req, () => {
    const { group, q, page } = listSchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    const qWhere = q ? "instr(url, ?) > 0" : "1";
    const where = [group === "completed" ? "status='completed'" : group === "incomplete" ? "status<>'completed'" : "1", qWhere].join(" AND ");
    const args = q ? [q] : [];
    const db = getDb();
    const { total } = db.prepare(`SELECT COUNT(*) total FROM projects WHERE ${where}`).get(...args) as { total: number };
    const counts = db
      .prepare(`SELECT COALESCE(SUM(status<>'completed'),0) incomplete, COALESCE(SUM(status='completed'),0) completed FROM projects WHERE ${qWhere}`)
      .get(...args) as { incomplete: number; completed: number };
    const rows = db
      .prepare(
        `SELECT id,url,mode,status,progress,tokens_used AS tokensUsed,created_at AS createdAt,updated_at AS updatedAt,
           (SELECT phase FROM tasks t WHERE t.project_id=p.id AND t.status<>'done' ORDER BY rowid LIMIT 1) AS phase,
           (SELECT key FROM tasks t WHERE t.project_id=p.id AND t.phase='capture' AND t.status='done' ORDER BY rowid LIMIT 1) AS thumbPage
         FROM projects p WHERE ${where} ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, PAGE_SIZE, (page - 1) * PAGE_SIZE) as { id: string; status: string; phase: string | null }[];
    const ids = rows.map((r) => r.id);
    const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
    const agg = ids.length
      ? (db.prepare(`SELECT project_id, phase, COUNT(*) total, SUM(status='done') done FROM tasks WHERE project_id IN (${marks(ids.length)}) GROUP BY project_id, phase`).all(...ids) as {
          project_id: string;
          phase: string;
          total: number;
          done: number;
        }[])
      : [];
    const errIds = rows.filter((r) => r.status === "failed" || r.status === "needs_auth").map((r) => r.id);
    const errs = errIds.length
      ? (db
          .prepare(
            `SELECT project_id, error_code, error_msg, phase, key FROM (
               SELECT project_id, error_code, substr(error_msg,1,500) error_msg, phase, key,
                      ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY updated_at DESC, rowid DESC) rn
               FROM tasks WHERE status IN ('failed','needs_auth') AND project_id IN (${marks(errIds.length)})) WHERE rn=1`,
          )
          .all(...errIds) as { project_id: string; error_code: string | null; error_msg: string | null; phase: string; key: string }[])
      : [];
    const byPhase = new Map(agg.map((a) => [`${a.project_id}:${a.phase}`, a]));
    const lastErrorOf = new Map<string, LastError>(errs.map((e) => [e.project_id, { code: e.error_code, message: e.error_msg ?? "", phase: e.phase, key: e.key }]));
    const projects = rows.map((p) => {
      const capture = byPhase.get(`${p.id}:capture`);
      const current = p.phase ? byPhase.get(`${p.id}:${p.phase}`) : undefined;
      return {
        ...p,
        needsCredentials: needsCredentials(db, p.id),
        queued: isWaiting(p.id),
        pageCount: capture?.total ?? null,
        phaseDone: current?.done ?? null,
        phaseTotal: current?.total ?? null,
        lastError: lastErrorOf.get(p.id) ?? null,
      };
    });
    return Response.json({ projects, total, page, pageSize: PAGE_SIZE, counts });
  });
}
```
(`needsCredentials` stays per row as before: ≤20 rows, 2 indexed lookups each — unchanged behavior.)

- [ ] **Step 9: Preview `fixes`** — in `src/app/api/projects/[id]/preview/route.ts` add `import type { TaskStatus } from "@/core/jobs-base";` and before the `return`:

```ts
    // the fix-loop outcome per section (key pageId:sectionId) for the preview's "cần sửa" cards
    const fixes = (
      db.prepare("SELECT key,status,error_code FROM tasks WHERE project_id=? AND phase='fix' ORDER BY rowid LIMIT 2000").all(id) as { key: string; status: TaskStatus; error_code: string | null }[]
    ).map((t) => {
      const i = t.key.indexOf(":");
      return { pageId: t.key.slice(0, i), sectionId: t.key.slice(i + 1), status: t.status, errorCode: t.error_code };
    });
```
and add `fixes` to the response object.

- [ ] **Step 10: D8** — in `src/app/api/projects/[id]/start/route.ts` import `closeAuthWindow` from `@/app/_server/session` and after `requireStatus(project, ["draft"], "start");` add:

```ts
    // D8: the sitemap's login banner may have opened the window; the user is done logging in, and it holds the profile
    await closeAuthWindow(id);
```

- [ ] **Step 11: Run to verify pass**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/api.test.ts tests/e2e/start-auth-window.test.ts tests/e2e/auth-draft.test.ts`
Expected: PASS.

- [ ] **Step 12: New limits in the SP1 spec** — in `docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md` §1 "Giới hạn mặc định", append these rows after "Chờ người dùng xử lý auth":

```markdown
| Event giữ / dự án (RAM và replay SSE) | 2000 | không |
| Dòng event trên đĩa / dự án | ≤ 4000 (2 file xoay vòng) | không |
| Ring event trong RAM | 32 dự án | không |
| Độ dài chuỗi trong event | 2000 ký tự | không |
| `lastError.message` trong danh sách | 500 ký tự | không |
| Dòng log hiển thị ở client | 2000 | không |
| File thống kê ở code viewer | 2000, `stat` song song 8 | không |
| `fixes` trong preview | 2000 | không |
| Chạy lại QA (rescore) | 1 job qua queue chung (1 chạy, ≤5 chờ, vượt → 429) | không |
```

- [ ] **Step 13: Typecheck + unit + build** — `npx tsc --noEmit && npx vitest run` + build check.

- [ ] **Step 14: Commit**

```bash
git add src/core/estimate.ts "src/app/p/[id]/data.ts" src/app/api/projects/route.ts "src/app/api/projects/[id]/preview/route.ts" "src/app/api/projects/[id]/start/route.ts" tests/unit/estimate.test.ts tests/unit/history-rates.test.ts tests/e2e/api.test.ts tests/e2e/start-auth-window.test.ts docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md
git commit -m "feat(api): run estimate, history list fields + counts, preview fixes, start closes the login window" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 7: Screen `/settings/ai` — `screen_settings_ai` (spec §3.1)

**Files:**
- Modify: `src/app/settings/ai/page.tsx`, `src/app/settings/ai/provider-settings.tsx` (rewrite), `src/app/globals.css` (settings + menu CSS), `tests/e2e/ui-smoke.test.ts` (replace the settings test)

**Interfaces:**
- Consumes: `Badge`, `Banner`, `Button`, `Card`, `Field`, `Icon`, `IconButton`, `PageHeader`, `PasswordInput`, `SearchInput` (Task 2); `POST /api/providers/test` → `{ ok, models, latencyMs, httpStatus }`, body = form values or `{ providerId }` (Task 5); existing `GET/POST /api/providers`, `PATCH/DELETE /api/providers/[id]`, `POST /api/providers/models`.
- Produces: nothing used by later tasks.

Elements (all 15, `data-ui` on each root): `ui_settings_ai_page_header`, `…_add_provider_buttons`, `…_endpoint_list`, `…_endpoint_filter`, `…_endpoint_row`, `…_test_endpoint`, `…_row_menu`, `…_config_panel`, `…_display_name`, `…_protocol`, `…_base_url`, `…_api_key`, `…_fetch_models`, `…_role_matrix`, `…_save_provider`. Not rendered: HTTP Pool, Failover, Upstream Telemetry, gateway footer, Default Primary Model (`ui_settings_ai_default_model` out of scope), "v2.4-gateway", "ROUTER ACTIVE", "ID: … // status", "Cached … ago", "AES-256 GCM", VLLM/OLLAMA.

- [ ] **Step 0: Trace in the graph** — `/graphify explain screen_settings_ai` and `/graphify path "feat_ai_gateway" "screen_settings_ai"`; list the `drift_settings_ai_*` nodes (they must stay absent).

- [ ] **Step 1: Write the failing smoke test** — in `tests/e2e/ui-smoke.test.ts` add `import { createServer } from "node:http"; import type { AddressInfo } from "node:net";` and replace the test "settings/ai: add a provider, it is listed with a masked key" with:

```ts
test("settings/ai: 2-column layout, Test before Save (ms + HTTP), eye toggle, filter, kebab edit/delete, masked key", async () => {
  const models = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "m1" }, { id: "m2" }] })));
  await new Promise<void>((r) => models.listen(0, "127.0.0.1", r));
  const modelsUrl = `http://127.0.0.1:${(models.address() as AddressInfo).port}/v1`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  try {
    await page.goto(`${base}/settings/ai`);
    await expectUi(page, ["ui_settings_ai_page_header", "ui_settings_ai_add_provider_buttons", "ui_settings_ai_endpoint_list", "ui_settings_ai_endpoint_filter", "ui_settings_ai_config_panel"]);
    expect(await page.locator('[data-ui="ui_settings_ai_config_panel"]').innerText()).toContain("Chọn một endpoint để sửa, hoặc thêm mới.");
    const adds = page.locator('[data-ui="ui_settings_ai_add_provider_buttons"]').getByRole("button");
    expect(await adds.allInnerTexts()).toEqual(["Add Anthropic Compatible", "Add OpenAI Compatible"]);

    await page.getByRole("button", { name: "Add OpenAI Compatible" }).click();
    const form = page.getByRole("form", { name: "Cấu hình provider" });
    await expectUi(page, ["ui_settings_ai_display_name", "ui_settings_ai_protocol", "ui_settings_ai_base_url", "ui_settings_ai_api_key", "ui_settings_ai_fetch_models", "ui_settings_ai_test_endpoint", "ui_settings_ai_role_matrix", "ui_settings_ai_save_provider"]);
    expect(await form.locator('[data-ui="ui_settings_ai_protocol"]').innerText()).toContain("OpenAI Chat Completions API");
    await form.getByLabel("Tên hiển thị").fill("Local OpenAI");
    await form.getByLabel("Base URL").fill(modelsUrl);
    const key = form.getByLabel("API key", { exact: true });
    await key.fill("sk-smoke-secret-key-1234");
    expect(await key.getAttribute("type")).toBe("password");
    await form.getByRole("button", { name: "Hiện mật khẩu" }).click();
    expect(await key.getAttribute("type")).toBe("text");
    await form.getByRole("button", { name: "Test kết nối" }).click(); // D7: before the provider is saved
    await expect.poll(() => form.locator('[data-ui="ui_settings_ai_test_endpoint"] [role="status"]').innerText()).toMatch(/^Kết nối OK · \d+ ms · HTTP 200 · 2 model$/);
    expect(await form.getByLabel("Model cho vai trò vision").isDisabled()).toBe(true);
    await form.getByRole("button", { name: "Fetch models" }).click();
    await expect.poll(() => form.locator('[data-ui="ui_settings_ai_fetch_models"]').innerText()).toContain("2 model");
    await form.getByLabel("Model cho vai trò vision").selectOption("m1");
    await parityShot(page, "settings-ai-form");
    await form.getByRole("button", { name: "Lưu provider" }).click();

    const rows = page.locator('[data-ui="ui_settings_ai_endpoint_row"]');
    const row = rows.filter({ hasText: "Local OpenAI" });
    await expect.poll(() => row.innerText()).toContain("sk-…1234");
    expect(await row.innerText()).toContain("OPENAI");
    expect(await row.innerText()).toContain("chưa test");
    expect(await page.content()).not.toContain("sk-smoke-secret-key-1234");
    expect(await page.locator('[data-ui="ui_settings_ai_endpoint_list"] .badge').first().innerText()).toBe(String(await rows.count()));

    // row Test: latency on the row
    await row.getByRole("button", { name: "Test", exact: true }).click();
    await expect.poll(() => row.innerText()).toMatch(/\d+ ms/);

    // filter is a literal, client-side substring over name / base URL / models
    const filter = page.getByRole("searchbox", { name: "Lọc endpoint" });
    await filter.fill("(");
    expect(await rows.count()).toBe(0);
    await filter.fill("LOCAL open");
    expect(await rows.count()).toBe(1);
    await filter.fill("");

    // kebab: Esc closes and returns focus; Sửa opens the form; the saved key is never filled back
    const kebab = row.getByRole("button", { name: "Thao tác" });
    await kebab.click();
    expect(await page.getByRole("menu").count()).toBe(1);
    await page.keyboard.press("Escape");
    expect(await page.getByRole("menu").count()).toBe(0);
    expect(await kebab.evaluate((el) => el === document.activeElement)).toBe(true);
    await kebab.click();
    await page.getByRole("menuitem", { name: "Sửa" }).click();
    expect(await page.locator('[data-ui="ui_settings_ai_config_panel"] h2').innerText()).toBe("Sửa: Local OpenAI");
    expect(await form.getByLabel("API key", { exact: true }).inputValue()).toBe("");
    expect(await row.getAttribute("class")).toContain("is-open");
    await form.getByLabel("Tên hiển thị").fill("Renamed OpenAI");
    await form.getByRole("button", { name: "Lưu provider" }).click();
    const renamed = rows.filter({ hasText: "Renamed OpenAI" });
    await expect.poll(() => renamed.innerText()).toContain("sk-…1234");

    page.once("dialog", (d) => void d.accept());
    await renamed.getByRole("button", { name: "Thao tác" }).click();
    await page.getByRole("menuitem", { name: "Xóa" }).click();
    await expect.poll(() => rows.filter({ hasText: "OpenAI" }).count()).toBe(0);

    await expectNoDrift(page);
    await expectIconButtonsLabelled(page);
    expect(foreign).toEqual([]);
  } finally {
    await page.close();
    await new Promise((r) => models.close(r));
  }
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts -t "settings/ai"`
Expected: FAIL — no `ui_settings_ai_*` elements.

- [ ] **Step 3: Page** — `src/app/settings/ai/page.tsx`

```tsx
import { ProviderSettings } from "./provider-settings";

export default function SettingsAiPage() {
  return <ProviderSettings />;
}
```

- [ ] **Step 4: Rewrite `src/app/settings/ai/provider-settings.tsx`**

```tsx
"use client";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { Field } from "@/app/_ui/Field";
import { Icon, type IconName } from "@/app/_ui/Icon";
import { IconButton } from "@/app/_ui/IconButton";
import { PageHeader } from "@/app/_ui/PageHeader";
import { PasswordInput } from "@/app/_ui/PasswordInput";
import { SearchInput } from "@/app/_ui/SearchInput";

type Kind = "anthropic" | "openai";
type Role = "vision" | "code" | "design";
type Provider = { id: string; name: string; kind: Kind; baseUrl: string; apiKey: string; roles: Partial<Record<Role, string>> };
// id set = editing a saved provider (an empty apiKey keeps the stored key; it is never filled back)
type Draft = { id?: string; title: string; kind: Kind; name: string; baseUrl: string; apiKey: string; roles: Partial<Record<Role, string>> };
type TestResult = { ok: boolean; text: string; latencyMs?: number };
type TestResponse = { models: number; latencyMs: number; httpStatus: number };

const KIND_LABEL: Record<Kind, string> = { anthropic: "Anthropic Compatible", openai: "OpenAI Compatible" };
const PROTOCOL: Record<Kind, string> = { anthropic: "Anthropic Messages API", openai: "OpenAI Chat Completions API" };
const URL_HINT: Record<Kind, string> = { anthropic: "https://api.anthropic.com/v1", openai: "https://api.openai.com/v1" };
const ROLES: { role: Role; icon: IconName; text: string }[] = [
  { role: "vision", icon: "visibility", text: "Đặt tên section (1 lần gọi mỗi trang, kèm ảnh thu nhỏ)." },
  { role: "code", icon: "code", text: "Vòng sửa section chưa đạt QA (patch IR, tối đa 3 vòng); nhận ảnh nếu cùng model với vision." },
  { role: "design", icon: "edit", text: "Dành cho SP3, SP1 không dùng." },
];

const okText = (r: TestResponse) => `Kết nối OK · ${r.latencyMs} ms · HTTP ${r.httpStatus} · ${r.models} model`;

async function runTest(body: unknown): Promise<TestResult> {
  try {
    const r = await api<TestResponse>("/api/providers/test", { body });
    return { ok: true, text: okText(r), latencyMs: r.latencyMs };
  } catch (e) {
    return { ok: false, text: errorText(e) }; // the server's code + message, which carries the upstream HTTP status
  }
}

export function ProviderSettings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [tests, setTests] = useState<Record<string, TestResult | "running">>({}); // this session only, never stored
  const [formTest, setFormTest] = useState<TestResult | "running" | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () =>
    api<{ providers: Provider[] }>("/api/providers").then(
      (r) => setProviders(r.providers),
      (e: unknown) => setMsg(errorText(e)),
    );
  useEffect(() => void load(), []);

  const openForm = (kind: Kind) => {
    setDraft({ kind, title: `Thêm ${KIND_LABEL[kind]}`, name: "", baseUrl: "", apiKey: "", roles: {} });
    setModels([]);
    setFormTest(null);
    setMsg("");
  };

  const editForm = (p: Provider) => {
    setDraft({ id: p.id, title: `Sửa: ${p.name}`, kind: p.kind, name: p.name, baseUrl: p.baseUrl, apiKey: "", roles: p.roles });
    setModels([...new Set(Object.values(p.roles).filter((m): m is string => !!m))]); // current choices stay selectable
    setFormTest(null);
    setMsg("");
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  // editing without a new key: the saved provider (its key decrypted server-side); otherwise the typed values (D7)
  const bodyOf = (d: Draft) => (d.id && !d.apiKey ? { providerId: d.id } : { kind: d.kind, baseUrl: d.baseUrl, apiKey: d.apiKey });

  const fetchModels = () =>
    run(async () => {
      if (!draft) return;
      const r = await api<{ models: string[] }>("/api/providers/models", { body: bodyOf(draft) });
      setModels(r.models);
    });

  const testForm = async () => {
    if (!draft) return;
    setFormTest("running");
    const body = bodyOf(draft);
    const saved = "providerId" in body ? body.providerId : null; // the row's dot/latency only reflect the saved provider
    const r = await runTest(body);
    setFormTest(r);
    if (saved) setTests((t) => ({ ...t, [saved]: r }));
  };

  const testRow = async (id: string) => {
    setTests((t) => ({ ...t, [id]: "running" }));
    const r = await runTest({ providerId: id });
    setTests((t) => ({ ...t, [id]: r }));
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      if (!draft) return;
      const roles = Object.fromEntries(Object.entries(draft.roles).filter(([, m]) => m));
      const { id, kind, apiKey, name, baseUrl } = draft;
      if (id) await api(`/api/providers/${id}`, { method: "PATCH", body: { name, baseUrl, roles, ...(apiKey ? { apiKey } : {}) } });
      else await api("/api/providers", { body: { name, baseUrl, kind, apiKey, roles } });
      setDraft(null);
      await load();
    });
  };

  const remove = (p: Provider) => {
    if (!confirm(`Xóa provider ${p.name}?`)) return;
    void run(async () => {
      await api(`/api/providers/${p.id}`, { method: "DELETE" });
      if (draft?.id === p.id) setDraft(null);
      await load();
    });
  };

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const q = filter.trim().toLowerCase();
  const shown = q ? providers.filter((p) => [p.name, p.baseUrl, ...Object.values(p.roles)].some((v) => v?.toLowerCase().includes(q))) : providers;

  return (
    <>
      <PageHeader
        data-ui="ui_settings_ai_page_header"
        crumbs={[{ label: "Cài đặt" }, { label: "AI Gateway & Provider" }]}
        title="AI Gateway & Provider"
        subtitle="Thêm endpoint tương thích Anthropic hoặc OpenAI, lấy danh sách model, Test kết nối và gán model cho từng vai trò."
        actions={
          <div className="row" data-ui="ui_settings_ai_add_provider_buttons">
            <Button className="btn-outline-warn" icon="hub" onClick={() => openForm("anthropic")}>
              Add Anthropic Compatible
            </Button>
            <Button variant="primary" icon="add_circle" onClick={() => openForm("openai")}>
              Add OpenAI Compatible
            </Button>
          </div>
        }
      />
      {msg && (
        <Banner tone="danger" icon="error">
          {msg}
        </Banner>
      )}
      <div className="settings-grid">
        <Card
          data-ui="ui_settings_ai_endpoint_list"
          title={
            <>
              Endpoint đã cấu hình <Badge>{providers.length}</Badge>
            </>
          }
        >
          <SearchInput data-ui="ui_settings_ai_endpoint_filter" label="Lọc endpoint" placeholder="Lọc theo tên hoặc base URL…" value={filter} onChange={setFilter} />
          {providers.length === 0 && <p className="text-3">Chưa có provider nào.</p>}
          <ul className="endpoint-list">
            {shown.map((p) => {
              const t = tests[p.id];
              const tone = t === undefined || t === "running" ? "neutral" : t.ok ? "success" : "danger";
              const latency = t === undefined ? "chưa test" : t === "running" ? "Đang test…" : t.ok ? `${t.latencyMs} ms` : "lỗi";
              return (
                <li key={p.id} className={`endpoint-row${draft?.id === p.id ? " is-open" : ""}`} data-ui="ui_settings_ai_endpoint_row">
                  <button type="button" className="endpoint-main" onClick={() => editForm(p)}>
                    <span className={`dot tone-${tone}`} aria-hidden="true" />
                    <span className="endpoint-name">{p.name}</span>
                    <Badge>{p.kind.toUpperCase()}</Badge>
                    <span className="mono text-3">{p.apiKey}</span>
                    <span className="t-label-sm text-3" title={t !== undefined && t !== "running" ? t.text : undefined}>
                      {latency}
                    </span>
                  </button>
                  <IconButton icon="bolt" label="Test" tone="success" disabled={t === "running"} onClick={() => void testRow(p.id)} />
                  <RowMenu onEdit={() => editForm(p)} onDelete={() => remove(p)} />
                </li>
              );
            })}
          </ul>
        </Card>

        <Card data-ui="ui_settings_ai_config_panel" title={draft ? draft.title : "Cấu hình provider"}>
          {!draft ? (
            <p className="text-3">Chọn một endpoint để sửa, hoặc thêm mới.</p>
          ) : (
            <form className="stack" aria-label="Cấu hình provider" onSubmit={save}>
              <Field label="Tên hiển thị" data-ui="ui_settings_ai_display_name">
                <input required maxLength={100} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
              </Field>
              <div className="field-x" data-ui="ui_settings_ai_protocol">
                <span className="field-label">Chuẩn API</span>
                <span className="readonly-value">
                  <Icon name="lock" />
                  {PROTOCOL[draft.kind]}
                  <span className="t-label-sm text-3">cố định</span>
                </span>
              </div>
              <Field label="Base URL" hintEnd={`Mặc định: ${URL_HINT[draft.kind]}`} data-ui="ui_settings_ai_base_url">
                <input required type="url" className="mono" placeholder={URL_HINT[draft.kind]} value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} />
              </Field>
              <PasswordInput
                data-ui="ui_settings_ai_api_key"
                label="API key"
                hint="Key được mã hóa khi lưu và không bao giờ hiển thị lại."
                required={!draft.id}
                placeholder={draft.id ? "để trống = giữ key cũ" : undefined}
                value={draft.apiKey}
                onChange={(e) => set({ apiKey: e.target.value })}
              />
              <div className="row" data-ui="ui_settings_ai_fetch_models">
                <Button icon="refresh" disabled={busy || !draft.baseUrl || (!draft.apiKey && !draft.id)} onClick={() => void fetchModels()}>
                  Fetch models
                </Button>
                <span className="t-label-md text-2">{models.length ? `${models.length} model` : "Chưa có danh sách model"}</span>
              </div>
              <div className="row" data-ui="ui_settings_ai_test_endpoint">
                <Button className="text-success" icon="bolt" disabled={formTest === "running" || !draft.baseUrl || (!draft.apiKey && !draft.id)} onClick={() => void testForm()}>
                  {formTest === "running" ? "Đang test…" : "Test kết nối"}
                </Button>
                {formTest && formTest !== "running" && (
                  <span role="status" className={`t-label-md ${formTest.ok ? "text-success" : "text-danger"}`}>
                    {formTest.text}
                  </span>
                )}
              </div>
              <fieldset className="role-matrix" data-ui="ui_settings_ai_role_matrix">
                <legend className="t-headline-sm">Vai trò model</legend>
                {ROLES.map((r) => (
                  <div className="role-row" key={r.role}>
                    <Icon name={r.icon} size={20} />
                    <div className="role-text">
                      <span className="mono">{r.role}</span> — <span className="t-body-sm text-2">{r.text}</span>
                    </div>
                    <select aria-label={`Model cho vai trò ${r.role}`} disabled={!models.length} value={draft.roles[r.role] ?? ""} onChange={(e) => set({ roles: { ...draft.roles, [r.role]: e.target.value } })}>
                      <option value="">(không gán)</option>
                      {models.map((m) => (
                        <option key={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                ))}
                <p className="t-body-sm text-3">Khi chạy: dùng provider của dự án nếu nó phục vụ vai trò, nếu không dùng provider lưu gần nhất có vai trò đó.</p>
              </fieldset>
              <div className="form-actions" data-ui="ui_settings_ai_save_provider">
                <Button onClick={() => setDraft(null)}>Hủy thay đổi</Button>
                <Button type="submit" variant="primary" icon="save" disabled={busy}>
                  Lưu provider
                </Button>
              </div>
            </form>
          )}
        </Card>
      </div>
    </>
  );
}

// Kebab menu: role=menu, Esc / outside click close it and give focus back to the button, ↑/↓ move between items.
function RowMenu({ onEdit, onDelete }: { onEdit(): void; onDelete(): void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") return close();
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  };
  const pick = (fn: () => void) => () => {
    close();
    fn();
  };
  return (
    <span className="menu-anchor" data-ui="ui_settings_ai_row_menu">
      <IconButton ref={button} icon="more_vert" label="Thao tác" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} />
      {open && (
        <div ref={box} role="menu" className="menu" onKeyDown={onKey}>
          <button type="button" role="menuitem" onClick={pick(onEdit)}>
            Sửa
          </button>
          <button type="button" role="menuitem" className="danger" onClick={pick(onDelete)}>
            Xóa
          </button>
        </div>
      )}
    </span>
  );
}
```

- [ ] **Step 5: CSS** — append to `src/app/globals.css`:

```css
/* === Screen: settings/ai === */
.settings-grid { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: var(--s-lg); align-items: start; margin-top: var(--s-lg); }
@media (max-width: 1099px) { .settings-grid { grid-template-columns: minmax(0, 1fr); } }
.endpoint-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.endpoint-row { display: flex; align-items: center; gap: var(--s-xs); padding-right: var(--s-xs); border-left: 2px solid transparent; border-radius: var(--r-sm); }
.endpoint-row:hover { background: var(--c-surface-high); }
.endpoint-row.is-open { background: var(--c-surface); border-left-color: var(--c-accent-strong); }
.endpoint-main { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--s-sm); padding: 10px var(--s-sm); border: 0; background: transparent; color: var(--c-text); text-align: left; cursor: pointer; font: var(--t-body-md); }
.endpoint-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.readonly-value { display: inline-flex; align-items: center; gap: var(--s-sm); padding: 5px 10px; min-height: 30px; font: var(--t-label-md); color: var(--c-text-2); background: var(--c-surface-lowest); border: 1px solid var(--c-border); border-radius: var(--r-sm); }
.role-matrix { border: 1px solid var(--c-border); border-radius: var(--r-md); padding: var(--s-md) var(--s-lg); margin: 0; display: grid; gap: var(--s-md); }
.role-matrix > legend { padding: 0 var(--s-xs); color: var(--c-text); }
.role-row { display: grid; grid-template-columns: 20px minmax(0, 1fr) 220px; gap: var(--s-md); align-items: center; }
.role-row .icon { color: var(--c-text-2); }
.form-actions { display: flex; justify-content: flex-end; gap: var(--s-sm); padding-top: var(--s-md); border-top: 1px solid var(--c-border); }

/* === Menu (kebab) === */
.menu-anchor { position: relative; display: inline-flex; }
.menu { position: absolute; right: 0; top: 30px; z-index: 30; min-width: 140px; padding: 4px; display: grid; background: var(--c-surface-high); border: 1px solid var(--c-border); border-radius: var(--r-md); }
.menu [role="menuitem"] { text-align: left; padding: 6px 10px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--c-text); font: var(--t-label-md); cursor: pointer; }
.menu [role="menuitem"]:hover, .menu [role="menuitem"]:focus-visible { background: var(--c-surface-bright); }
.menu .danger { color: var(--c-danger); }
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts -t "settings/ai"`
Expected: PASS.

- [ ] **Step 7: Parity screenshot** — rerun with `PARITY_DIR` set; compare `settings-ai-form.png` with `docs/superpowers/design/stitch/settings-ai.png` (2 columns 5:7, endpoint rows with dot/badge/masked key/latency, amber outline + indigo filled add buttons, role rows with icon + description + select). Report differences; drift areas (telemetry, failover, footer, version badges) must be absent.

- [ ] **Step 8: Typecheck + unit + build** — `npx tsc --noEmit && npx vitest run` + build check.

- [ ] **Step 9: Commit**

```bash
git add src/app/settings/ai/page.tsx src/app/settings/ai/provider-settings.tsx src/app/globals.css tests/e2e/ui-smoke.test.ts
git commit -m "feat(ui): settings/ai to Stitch parity (2 columns, endpoint rows, Test with ms + HTTP, kebab menu)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 8: Screen `/` Lịch sử — `screen_history` (spec §3.2; reference mockup `history-alt3.png`)

**Files:**
- Modify: `src/app/page.tsx`, `src/app/history.tsx` (rewrite), `src/app/globals.css` (history CSS; delete `/* legacy: history */`), `tests/e2e/ui-smoke.test.ts`
- Create: `tests/unit/history-window.test.ts`

**Interfaces:**
- Consumes: Task 2 components, `downloadZip`; `GET /api/projects` fields `pageCount`, `phaseDone`, `phaseTotal`, `lastError`, `counts` (Task 6); `RESUMABLE_STATUSES` (`@/core/statuses`).
- Produces: `pageWindow(page: number, pages: number): (number | "gap")[]` exported from `src/app/history.tsx` (tested here only).

Elements (21): `ui_history_page_header`, `…_status_tabs`, `…_url_search`, `…_refresh`, `…_job_rows`, `…_row_thumb`, `…_row_url`, `…_row_subtitle`, `…_failed_error_log`, `…_needs_auth_status`, `…_status_pill`, `…_progress_bar`, `…_row_actions`, `…_pause_button`, `…_resume_button`, `…_open_button`, `…_reclone_button`, `…_download_export`, `…_delete_button`, `…_pagination`, `…_empty`. Not rendered: cluster/concurrency chips, "All Engines", Failed tab, daemon footer, copy/docs icon, DOM/SPA/AUTH/HTML/ERR thumbnail badges, "Target:", "Inject Auth", "Trace", "Rows: 20 per page".

- [ ] **Step 0: Trace in the graph** — `/graphify explain screen_history`; confirm `ui_history_status_filter` and `ui_history_inject_auth` are out of scope and the 3 aliases (`ui_history_vi_status_tabs`, `ui_history_search`, `ui_history_interrupted_resume`) map to the ids above.

- [ ] **Step 1: Write the failing tests**

`tests/unit/history-window.test.ts`

```ts
import { expect, test } from "vitest";
import { pageWindow } from "@/app/history";

test("pagination window: <= 7 entries, 1 … k-1 k k+1 … N", () => {
  expect(pageWindow(1, 1)).toEqual([1]);
  expect(pageWindow(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(pageWindow(1, 10)).toEqual([1, 2, "gap", 10]);
  expect(pageWindow(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
  expect(pageWindow(10, 10)).toEqual([1, "gap", 9, 10]);
  expect(pageWindow(3, 10)).toEqual([1, 2, 3, 4, "gap", 10]);
  for (let n = 1; n <= 30; n++) for (let k = 1; k <= n; k++) expect(pageWindow(k, n).length).toBeLessThanOrEqual(7);
});
```

In `tests/e2e/ui-smoke.test.ts` add:

```ts
test("history: tab counts, row states (failed code, needs_auth, running phase x/y, draft), actions, ZIP download, long URL, pagination", async () => {
  const db = openDb(env.DB_PATH);
  const pfx = `http://history.test/${crypto.randomUUID()}`;
  const ws = env.WORKSPACE_ROOT;
  let done = "";
  try {
    done = seedProject(db, { url: `${pfx}/done`, status: "completed", progress: 100, tasks: [{ phase: "capture", key: "home", status: "done" }] });
    await writeWs(ws, done, "pages/home/shots/1440.png", pngOf(40, 25, [40, 60, 200]));
    await writeWs(ws, done, "out/index.html", "<h1>done</h1>");
    seedProject(db, { url: `${pfx}/running`, status: "running", progress: 40, mode: "crawl", tasks: [{ phase: "capture", key: "home", status: "done" }, { phase: "capture", key: "about", status: "running" }] });
    seedProject(db, { url: `${pfx}/failed`, status: "failed", progress: 10, tasks: [{ phase: "capture", key: "home", status: "failed", errorCode: "NAV_TIMEOUT", errorMsg: "navigation timeout 30000ms" }] });
    seedProject(db, { url: `${pfx}/auth`, status: "needs_auth", tasks: [{ phase: "capture", key: "home", status: "needs_auth", errorCode: "AUTH_REQUIRED", errorMsg: "login wall" }] });
    seedProject(db, { url: `${pfx}/${"very-long-segment-".repeat(16)}draft`, status: "draft", tasks: [{ phase: "discover", key: pfx, status: "done" }] });
  } finally {
    db.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  await page.goto(`${base}/`);
  const search = page.getByRole("searchbox", { name: "Tìm theo URL" });
  await search.fill(pfx);
  await search.press("Enter");
  const rows = page.locator('[data-ui="ui_history_job_rows"] [role="row"]:not(.grid-head)');
  await expect.poll(() => rows.count()).toBe(4);
  const tabs = page.getByRole("tablist", { name: "Nhóm dự án" });
  expect(await tabs.getByRole("tab", { name: /Chưa hoàn thành/ }).innerText()).toMatch(/Chưa hoàn thành\s*4/);
  expect(await tabs.getByRole("tab", { name: /Đã hoàn thành/ }).innerText()).toMatch(/Đã hoàn thành\s*1/);
  expect(await page.locator('[data-ui="ui_history_page_header"]').innerText()).toContain("5 dự án");
  const row = (s: string) => rows.filter({ hasText: `${pfx}/${s}` });
  expect(await row("failed").innerText()).toContain("NAV_TIMEOUT: navigation timeout 30000ms");
  expect(await row("auth").innerText()).toContain("Cần đăng nhập (AUTH_REQUIRED) — mở dự án để đăng nhập");
  expect(await row("auth").getAttribute("class")).toContain("row-warn");
  expect(await row("auth").getByRole("link", { name: "Tiếp tục" }).getAttribute("href")).toMatch(/^\/p\/[^/]+$/);
  expect(await row("running").innerText()).toMatch(/capture 1\/2[\s\S]*40%/);
  expect(await row("running").getByRole("button", { name: "Tạm dừng" }).count()).toBe(1);
  expect(await row("running").innerText()).toMatch(/Crawl · 2 trang · bắt đầu/);
  expect(await rows.filter({ hasText: "draft" }).innerText()).toContain("chưa chọn trang");
  for (const s of ["failed", "needs_auth", "running", "draft"]) expect(await rows.locator(`[data-status="${s}"]`).count()).toBe(1);
  expect(await page.locator('[data-ui="ui_history_pagination"]').innerText()).toContain("Hiển thị 1–4 / 4 dự án");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); // a 300-char URL never widens the page
  await expectUi(page, ["ui_shell_page_header", "ui_history_page_header", "ui_history_status_tabs", "ui_history_url_search", "ui_history_refresh", "ui_history_job_rows", "ui_history_row_url", "ui_history_row_subtitle", "ui_history_failed_error_log", "ui_history_needs_auth_status", "ui_history_status_pill", "ui_history_progress_bar", "ui_history_row_actions", "ui_history_pause_button", "ui_history_resume_button", "ui_history_open_button", "ui_history_reclone_button", "ui_history_delete_button", "ui_history_pagination"]);
  await expectNoDrift(page);
  await expectIconButtonsLabelled(page);
  await parityShot(page, "history-mixed");

  await tabs.getByRole("tab", { selected: true }).press("ArrowRight"); // keyboard: → selects "Đã hoàn thành"
  await expect.poll(() => rows.count()).toBe(1);
  expect(await rows.locator('[data-ui="ui_history_row_thumb"]').count()).toBe(1);
  expect(await rows.innerText()).toContain("xong");
  const [download] = await Promise.all([page.waitForEvent("download"), rows.getByRole("button", { name: "Tải ZIP" }).click()]);
  expect(download.suggestedFilename()).toBe(`${done}.zip`);
  await parityShot(page, "history-completed");

  await tabs.getByRole("tab", { name: /Chưa hoàn thành/ }).click();
  await expect.poll(() => rows.count()).toBe(4);
  page.once("dialog", (d) => void d.accept());
  await rows.filter({ hasText: "draft" }).getByRole("button", { name: "Xóa" }).click();
  await expect.poll(() => rows.count()).toBe(3);
  await search.fill(`${pfx}/nothing-here`);
  await search.press("Enter");
  await expect.poll(() => page.locator('[data-ui="ui_history_empty"]').innerText()).toContain("Không có dự án nào.");
  expect(foreign).toEqual([]);
  await page.close();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/history-window.test.ts` → FAIL (`pageWindow` not exported).
Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts -t "history:"` → FAIL.

- [ ] **Step 3: Page** — `src/app/page.tsx`

```tsx
import { History } from "./history";

export default function HistoryPage() {
  return <History />;
}
```

- [ ] **Step 4: Rewrite `src/app/history.tsx`**

```tsx
"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RESUMABLE_STATUSES } from "@/core/statuses";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { Disclosure } from "@/app/_ui/Disclosure";
import { downloadZip } from "@/app/_ui/download";
import { GridTable } from "@/app/_ui/GridTable";
import { IconButton } from "@/app/_ui/IconButton";
import { PageHeader } from "@/app/_ui/PageHeader";
import { ProgressBar } from "@/app/_ui/ProgressBar";
import { RelTime } from "@/app/_ui/RelTime";
import { SearchInput } from "@/app/_ui/SearchInput";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { StatusPill } from "@/app/_ui/StatusPill";
import { UrlChip } from "@/app/_ui/UrlChip";

type Group = "incomplete" | "completed";
type LastError = { code: string | null; message: string; phase: string; key: string };
type Row = {
  id: string;
  url: string;
  mode: "single" | "crawl";
  status: string;
  progress: number;
  phase: string | null;
  createdAt: number;
  updatedAt: number;
  thumbPage: string | null;
  needsCredentials: boolean;
  queued: boolean;
  pageCount: number | null;
  phaseDone: number | null;
  phaseTotal: number | null;
  lastError: LastError | null;
};
type List = { projects: Row[]; total: number; page: number; pageSize: number; counts: { incomplete: number; completed: number } };

const COLUMNS = [
  { key: "source", header: "NGUỒN & XEM TRƯỚC", width: "minmax(0, 5fr)" },
  { key: "status", header: "TRẠNG THÁI", width: "minmax(150px, 1.4fr)" },
  { key: "phase", header: "PHA & TIẾN ĐỘ", width: "minmax(200px, 2.6fr)" },
  { key: "actions", header: "THAO TÁC", width: "196px" },
];

const openHref = (r: Row) => (r.status === "draft" ? `/p/${r.id}/sitemap` : `/p/${r.id}`);

// <= 7 page buttons: 1 … k-1 k k+1 … N.
export function pageWindow(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const mid = [page - 1, page, page + 1].filter((p) => p > 1 && p < pages);
  const first = mid[0] ?? 2;
  const last = mid.at(-1) ?? pages - 1;
  return [1, ...(first > 2 ? ["gap" as const] : []), ...mid, ...(last < pages - 1 ? ["gap" as const] : []), pages];
}

function subtitle(r: Row): ReactNode {
  if (r.status === "needs_auth")
    return (
      <span className="text-warn" data-ui="ui_history_needs_auth_status">
        Cần đăng nhập ({r.lastError?.code ?? "AUTH_REQUIRED"}) — mở dự án để đăng nhập
      </span>
    );
  const mode = r.mode === "crawl" ? "Crawl" : "1 trang";
  if (r.pageCount === null)
    return (
      <>
        {mode} · chưa chọn trang · tạo <RelTime at={r.createdAt} />
      </>
    );
  return (
    <>
      {mode} · {r.pageCount} trang · bắt đầu <RelTime at={r.createdAt} />
    </>
  );
}

function failedLine(r: Row): ReactNode {
  if (r.status !== "failed") return null;
  if (!r.lastError)
    return (
      <div className="row-error text-danger" data-ui="ui_history_failed_error_log">
        Lỗi — mở dự án để xem log
      </div>
    );
  const e = r.lastError;
  return (
    <div className="row-error" data-ui="ui_history_failed_error_log">
      <span className="text-danger ellipsis">{e.code ? `${e.code}: ${e.message}` : e.message}</span>
      <Disclosure summary="Chi tiết lỗi">
        <p className="mono text-3">
          [{e.phase}] {e.key}
        </p>
        <p className="error-full">{e.message}</p>
      </Disclosure>
    </div>
  );
}

export function History() {
  const [group, setGroup] = useState<Group>("incomplete");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [list, setList] = useState<List | null>(null);
  const [msg, setMsg] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);

  const load = useCallback(() => {
    const params = new URLSearchParams({ group, page: String(page), ...(q ? { q } : {}) });
    return api<List>(`/api/projects?${params}`).then(setList, (e: unknown) => setMsg(errorText(e)));
  }, [group, q, page]);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(errorText(e));
    }
    await load();
  };

  const remove = (r: Row) => {
    if (!confirm(`Xóa dự án ${r.url}? Toàn bộ workspace (ảnh chụp, output) sẽ bị xóa.`)) return;
    void act(() => api(`/api/projects/${r.id}`, { method: "DELETE" }));
  };

  const download = async (r: Row) => {
    setDownloading(r.id);
    setMsg("");
    try {
      await downloadZip(r.id, false);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setDownloading(null);
    }
  };

  const pickGroup = (g: Group) => {
    setGroup(g);
    setPage(1);
  };

  const pages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  const all = list ? list.counts.incomplete + list.counts.completed : 0;
  const from = list && list.total ? (page - 1) * list.pageSize + 1 : 0;
  const to = list ? Math.min(page * list.pageSize, list.total) : 0;

  const cell = (r: Row, key: string): ReactNode => {
    switch (key) {
      case "source":
        return (
          <div className="source-cell">
            {r.thumbPage ? (
              <img className="row-thumb" alt="" data-ui="ui_history_row_thumb" src={`/api/projects/${r.id}/files/pages/${encodeURIComponent(r.thumbPage)}/shots/1440.png`} />
            ) : (
              <span className="row-thumb" aria-hidden="true" />
            )}
            <div className="source-text">
              <UrlChip url={r.url} openable plain data-ui="ui_history_row_url" />
              <div className="t-body-sm text-2" data-ui="ui_history_row_subtitle">
                {subtitle(r)}
              </div>
              {failedLine(r)}
            </div>
          </div>
        );
      case "status":
        return <StatusPill status={r.status} queued={r.queued} data-ui="ui_history_status_pill" />;
      case "phase":
        return (
          <div className="phase-cell" data-ui="ui_history_progress_bar">
            <div className="phase-line t-label-md">
              <span>
                {r.status === "completed" ? "done" : (r.phase ?? "—")}
                {r.status !== "completed" && r.phaseTotal ? ` ${r.phaseDone}/${r.phaseTotal}` : ""}
              </span>
              <span>{r.status === "completed" ? "xong" : `${r.progress}%`}</span>
            </div>
            <ProgressBar value={r.progress} status={r.status} label="Tiến độ" />
            <div className="t-body-sm text-3">
              Cập nhật <RelTime at={r.updatedAt} />
            </div>
          </div>
        );
      default:
        return (
          <div className="row-actions" data-ui="ui_history_row_actions">
            {r.status === "running" && (
              <IconButton data-ui="ui_history_pause_button" icon="pause" label="Tạm dừng" onClick={() => void act(() => api(`/api/projects/${r.id}/pause`, { method: "POST" }))} />
            )}
            {RESUMABLE_STATUSES.includes(r.status) &&
              (r.needsCredentials || r.status === "needs_auth" ? (
                // the progress screen asks for the account / shows the login banner before resuming
                <IconButton data-ui="ui_history_resume_button" icon="play_arrow" label="Tiếp tục" tone={r.status === "interrupted" ? "warn" : "default"} href={`/p/${r.id}`} />
              ) : (
                <IconButton
                  data-ui="ui_history_resume_button"
                  icon="play_arrow"
                  label="Tiếp tục"
                  tone={r.status === "interrupted" ? "warn" : "default"}
                  onClick={() => void act(() => api(`/api/projects/${r.id}/resume`, { method: "POST" }))}
                />
              ))}
            <IconButton data-ui="ui_history_open_button" icon="visibility" label="Mở" href={openHref(r)} />
            <IconButton data-ui="ui_history_reclone_button" icon="replay" label="Clone lại" href={`/new?from=${r.id}`} />
            {r.status === "completed" && (
              <IconButton data-ui="ui_history_download_export" icon="download" label="Tải ZIP" disabled={downloading === r.id} onClick={() => void download(r)} />
            )}
            <IconButton data-ui="ui_history_delete_button" icon="delete" label="Xóa" tone="danger" onClick={() => remove(r)} />
          </div>
        );
    }
  };

  return (
    <>
      <PageHeader data-ui="ui_history_page_header" crumbs={[{ label: "Lịch sử" }]} title="Lịch sử dự án" meta={list && <Badge>{all} dự án</Badge>} />
      <div className="toolbar">
        <SegmentedControl
          data-ui="ui_history_status_tabs"
          semantics="tabs"
          label="Nhóm dự án"
          value={group}
          onChange={pickGroup}
          options={[
            { value: "incomplete", label: "Chưa hoàn thành", count: list?.counts.incomplete },
            { value: "completed", label: "Đã hoàn thành", count: list?.counts.completed },
          ]}
        />
        <div className="toolbar-end">
          <SearchInput
            data-ui="ui_history_url_search"
            label="Tìm theo URL"
            placeholder="Tìm theo URL…"
            value={search}
            onChange={setSearch}
            onSubmit={() => {
              setPage(1);
              setQ(search.trim());
            }}
          />
          <IconButton data-ui="ui_history_refresh" icon="refresh" label="Tải lại" onClick={() => void load()} />
        </div>
      </div>
      {msg && (
        <Banner tone="danger" icon="error">
          {msg}
        </Banner>
      )}
      <GridTable
        data-ui="ui_history_job_rows"
        label="Dự án"
        columns={COLUMNS}
        rows={list?.projects ?? []}
        rowKey={(r) => r.id}
        renderCell={cell}
        rowTone={(r) => (r.status === "needs_auth" ? "warn" : undefined)}
        empty={
          list && (
            <div className="table-empty" data-ui="ui_history_empty">
              <p>Không có dự án nào.</p>
              <Button variant="primary" icon="add" href="/new">
                Clone mới
              </Button>
            </div>
          )
        }
      />
      <nav className="pagination" aria-label="Phân trang" data-ui="ui_history_pagination">
        <span className="t-label-md text-2">
          Hiển thị {from}–{to} / {list?.total ?? 0} dự án
        </span>
        <div className="row">
          <Button disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Trước
          </Button>
          {pageWindow(page, pages).map((p, i) =>
            p === "gap" ? (
              <span key={`gap-${i}`} className="text-3">
                …
              </span>
            ) : (
              <button key={p} type="button" className="page-num" aria-current={p === page ? "page" : undefined} onClick={() => setPage(p)}>
                {p}
              </button>
            ),
          )}
          <Button disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Sau
          </Button>
        </div>
      </nav>
    </>
  );
}
```

- [ ] **Step 5: CSS** — in `src/app/globals.css` delete the `/* legacy: history */` block and append:

```css
/* === Screen: history === */
.toolbar { display: flex; align-items: center; justify-content: space-between; gap: var(--s-md); flex-wrap: wrap; margin-bottom: var(--s-md); }
.toolbar-end { display: flex; align-items: center; gap: var(--s-sm); }
[data-ui="ui_history_job_rows"] .grid-row:not(.grid-head) { min-height: 64px; }
.source-cell { display: flex; align-items: center; gap: var(--s-md); min-width: 0; }
.source-text { display: grid; gap: 2px; min-width: 0; }
.row-thumb { flex: none; width: 100px; height: 64px; object-fit: cover; object-position: top; border-radius: var(--r-md); border: 1px solid var(--c-border); background: var(--c-surface); display: block; }
.row-error { display: grid; gap: 2px; min-width: 0; font: var(--t-body-sm); }
.error-full { margin: 4px 0 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.phase-cell { display: grid; gap: 6px; }
.phase-line { display: flex; justify-content: space-between; gap: var(--s-sm); }
.row-actions { display: flex; justify-content: flex-end; gap: 2px; }
.table-empty { display: grid; justify-items: center; gap: var(--s-md); padding: var(--s-xl); color: var(--c-text-2); }
.pagination { display: flex; align-items: center; justify-content: space-between; gap: var(--s-md); flex-wrap: wrap; margin-top: var(--s-md); }
.page-num { min-width: 30px; height: 30px; padding: 0 8px; border: 1px solid var(--c-border); border-radius: var(--r-sm); background: var(--c-surface-high); color: var(--c-text); font: var(--t-label-md); cursor: pointer; }
.page-num[aria-current="page"] { background: var(--c-accent); border-color: var(--c-accent); color: var(--c-on-accent); }
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run tests/unit/history-window.test.ts` → PASS.
Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts -t "history:"` → PASS.

- [ ] **Step 7: Parity screenshots** — rerun with `PARITY_DIR`; compare `history-mixed.png` and `history-completed.png` with `docs/superpowers/design/stitch/history-alt3.png` (tabs with count badges, search + refresh, header band, 100×64 thumbnails, mono URL + open icon, subtitle, pill, phase line + colored bar + "Cập nhật …", icon action column, footer "Hiển thị … / … dự án" + page numbers). Report differences.

- [ ] **Step 8: Typecheck + unit + build** — `npx tsc --noEmit && npx vitest run` + build check.

- [ ] **Step 9: Commit**

```bash
git add src/app/page.tsx src/app/history.tsx src/app/globals.css tests/unit/history-window.test.ts tests/e2e/ui-smoke.test.ts
git commit -m "feat(ui): history to Stitch parity (tab counts, row states + errors, icon actions, ZIP, pagination)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 9: Screen `/new` — `screen_new_clone` (spec §3.3, D9)

**Files:**
- Modify: `src/app/new/page.tsx`, `src/app/new/new-clone-form.tsx` (rewrite), `src/app/globals.css` (new-clone CSS), `tests/e2e/ui-smoke.test.ts` (new layout test; the 3 existing `/new` tests updated to the new labels)

**Interfaces:**
- Consumes: Task 2 components, `fmtInt`; `POST /api/projects`, `POST …/crawl`, `POST …/auth/open` (unchanged).
- Produces: nothing used by later tasks.

Elements (15): `ui_new_clone_page_header`, `…_card`, `…_url_input`, `…_mode_toggle`, `…_crawl_limits`, `…_auth_select`, `…_auth_credentials`, `…_auth_selectors`, `…_manual_login`, `…_qa_threshold`, `…_token_budget`, `…_output_format`, `…_cancel`, `…_preview_sitemap`, `…_error`. Not rendered: "TASK CONFIG / READY / DOM v3 Parser", Ping button, robots/DNS line, "Polite rate limiting active", PGS/LVL/THRD, "Session Cookie Vault", "HIGH FIDELITY", "Est. cost", "$", Markdown / Figma Tokens, "Save as preset", PIPELINE/EST. TIME/CLUSTER footer, "Allocated for AST …", "Target AST dialect".

- [ ] **Step 0: Trace in the graph** — `/graphify explain screen_new_clone`; `/graphify path "feat_auth" "screen_new_clone"`; confirm `feat_framework_emitters_sp2` is only shown as disabled "SP2" cards.

- [ ] **Step 1: Write the failing smoke tests** — in `tests/e2e/ui-smoke.test.ts` add:

```ts
test("new: centered card ≤1000px, copy-URL icon, mode toggle, crawl limits only when crawling, QA slider ⇄ number, SP2 outputs disabled", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  await page.goto(`${base}/new`);
  await expectUi(page, ["ui_new_clone_page_header", "ui_new_clone_card", "ui_new_clone_url_input", "ui_new_clone_mode_toggle", "ui_new_clone_auth_select", "ui_new_clone_qa_threshold", "ui_new_clone_token_budget", "ui_new_clone_output_format", "ui_new_clone_cancel", "ui_new_clone_preview_sitemap"]);
  expect((await page.locator('[data-ui="ui_new_clone_card"]').boundingBox())!.width).toBeLessThanOrEqual(1000);
  expect(await page.locator('[data-ui="ui_new_clone_crawl_limits"]').count()).toBe(0);
  await page.getByRole("group", { name: "Chế độ" }).getByRole("button", { name: "Crawl nhiều trang" }).click();
  expect(await page.locator('[data-ui="ui_new_clone_crawl_limits"]').innerText()).toMatch(/GIỚI HẠN CRAWL[\s\S]*Số trang tối đa[\s\S]*Độ sâu[\s\S]*Trang chụp song song[\s\S]*Delay giữa request/);

  const slider = page.getByRole("slider", { name: "Ngưỡng QA" });
  const exact = page.getByRole("spinbutton", { name: "Chính xác (%)" });
  expect(await exact.inputValue()).toBe("95");
  await slider.focus();
  for (let i = 0; i < 10; i++) await slider.press("ArrowLeft");
  expect(await exact.inputValue()).toBe("85");
  await exact.fill("99");
  expect(await slider.inputValue()).toBe("99");
  expect(await page.locator('[data-ui="ui_new_clone_qa_threshold"]').innerText()).toMatch(/99%[\s\S]*70% \(thoáng\)[\s\S]*85% \(cân bằng\)[\s\S]*95% \(chặt\)[\s\S]*100% \(khớp pixel\)/);

  const outputs = page.getByRole("radiogroup", { name: "Định dạng output" });
  expect(await outputs.getByRole("radio", { checked: true }).innerText()).toMatch(/HTML[\s\S]*Đang dùng/);
  const disabled = outputs.locator('[aria-disabled="true"]');
  expect(await disabled.count()).toBe(4);
  for (const [i, name] of ["React", "Next.js", "Vue", "WordPress"].entries()) expect(await disabled.nth(i).innerText()).toMatch(new RegExp(`${name.replace(".", "\\.")}[\\s\\S]*SP2`));

  await page.getByLabel("Cách đăng nhập").selectOption("auto");
  await expectUi(page, ["ui_new_clone_auth_credentials", "ui_new_clone_auth_selectors"]);
  await page.getByRole("button", { name: "Hiện mật khẩu" }).click();
  expect(await page.getByLabel("Mật khẩu", { exact: true }).getAttribute("type")).toBe("text");
  await page.getByRole("textbox", { name: "URL trang web" }).fill("https://example.com/");
  expect(await page.getByRole("button", { name: "Sao chép URL" }).count()).toBe(1);
  expect(await page.getByRole("link", { name: "Hủy" }).getAttribute("href")).toBe("/");
  await expectNoDrift(page);
  await expectIconButtonsLabelled(page);
  await parityShot(page, "new-clone-crawl-auto");
  expect(foreign).toEqual([]);
  await page.close();
});
```
Update the existing `/new` tests to the new controls:
- "new: crawl the site3 fixture…": `await page.getByRole("textbox", { name: "URL trang web" }).fill(\`${site.url}/index.html\`);` and `await page.getByRole("group", { name: "Chế độ" }).getByRole("button", { name: "Crawl nhiều trang" }).click();` (instead of `getByLabel("URL")` / `.check()`).
- "new (manual login)…": the URL line as above and `await page.getByLabel("Cách đăng nhập").selectOption("manual");`.
- "new: delay and optional login selectors are saved…" — rename to "new: delay, QA threshold, token budget and optional login selectors are saved in the project config" and use:

```ts
  await page.getByRole("textbox", { name: "URL trang web" }).fill(`${site.url}/index.html`);
  await page.getByRole("group", { name: "Chế độ" }).getByRole("button", { name: "Crawl nhiều trang" }).click();
  await page.getByLabel("Delay giữa request").fill("0");
  await page.getByRole("spinbutton", { name: "Chính xác (%)" }).fill("90");
  const budget = page.getByRole("textbox", { name: "Ngân sách token" });
  await budget.fill("1500000");
  await budget.blur();
  expect(await budget.inputValue()).toBe("1.500.000");
  await page.getByLabel("Cách đăng nhập").selectOption("auto");
  await page.getByLabel("Tài khoản", { exact: true }).fill("u");
  await page.getByLabel("Mật khẩu", { exact: true }).fill("p");
  await page.getByText("Selector form đăng nhập (tùy chọn)").click();
  await page.getByLabel("Selector ô mật khẩu").fill("#pw");
  await page.getByLabel("Selector nút gửi").fill("button.go");
  await page.getByRole("button", { name: "Quét trang" }).click();
```
and after reading `cfg` add `expect(cfg.threshold).toBe(0.9); expect(cfg.tokenBudget).toBe(1_500_000);`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts -t "new"`
Expected: FAIL.

- [ ] **Step 3: Page** — `src/app/new/page.tsx`: keep `initialFrom`, replace the returned JSX with:

```tsx
    <>
      <PageHeader
        data-ui="ui_new_clone_page_header"
        crumbs={[{ label: "Clone mới" }]}
        title="Cấu hình clone mới"
        subtitle="Nhập URL, chọn chế độ, cách đăng nhập, ngưỡng QA và ngân sách token."
      />
      <NewCloneForm initial={initialFrom(typeof from === "string" ? from : undefined)} />
    </>
```
(add `import { PageHeader } from "@/app/_ui/PageHeader";`).

- [ ] **Step 4: Rewrite `src/app/new/new-clone-form.tsx`**

```tsx
"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import type { ProjectConfig } from "@/core/jobs-base";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { Disclosure } from "@/app/_ui/Disclosure";
import { Field } from "@/app/_ui/Field";
import { Icon, type IconName } from "@/app/_ui/Icon";
import { IconButton } from "@/app/_ui/IconButton";
import { PasswordInput } from "@/app/_ui/PasswordInput";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { fmtInt } from "@/app/_ui/format";

type Mode = "single" | "crawl";
type AuthMode = ProjectConfig["auth"]["mode"];
type Initial = { url: string; mode: Mode; config: ProjectConfig };

const AUTH_MODES: [AuthMode, string][] = [
  ["none", "Không"],
  ["manual", "Thủ công (tự đăng nhập trong cửa sổ Chrome)"],
  ["auto", "Tự động (tài khoản)"],
];
const SP2_OUTPUTS = ["React", "Next.js", "Vue", "WordPress"];
const QA_MARKS: [number, string][] = [
  [70, "70% (thoáng)"],
  [85, "85% (cân bằng)"],
  [95, "95% (chặt)"],
  [100, "100% (khớp pixel)"],
];

function Section({ icon, title, hint, ui, children }: { icon: IconName; title: string; hint?: ReactNode; ui?: string; children: ReactNode }) {
  return (
    <section className="new-section" data-ui={ui}>
      <div className="new-section-head">
        <Icon name={icon} size={20} />
        <h2 className="t-label-md">{title}</h2>
        {hint && <span className="new-section-hint t-label-sm">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function NewCloneForm({ initial }: { initial?: Initial }) {
  const router = useRouter();
  const cfg = initial?.config;
  const [url, setUrl] = useState(initial?.url ?? "");
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<Mode>(initial?.mode ?? "single");
  const [maxPages, setMaxPages] = useState(cfg?.maxPages ?? 20);
  const [depth, setDepth] = useState(cfg?.depth ?? 2);
  const [concurrency, setConcurrency] = useState(cfg?.concurrency ?? 3);
  const [delayMs, setDelayMs] = useState(cfg?.delayMs ?? 500);
  const [selectors, setSelectors] = useState({ user: cfg?.auth.selectors?.user ?? "", pass: cfg?.auth.selectors?.pass ?? "", submit: cfg?.auth.selectors?.submit ?? "" });
  const [authMode, setAuthMode] = useState<AuthMode>(cfg?.auth.mode ?? "none");
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [remember, setRemember] = useState(false);
  const [threshold, setThreshold] = useState(Math.round((cfg?.threshold ?? 0.95) * 100));
  const [tokenBudget, setTokenBudget] = useState(cfg ? String(cfg.tokenBudget) : ""); // digits only; "" = server default
  const [budgetFocus, setBudgetFocus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [loginFirst, setLoginFirst] = useState(false); // manual auth: log in in the window, then crawl

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (err) {
      setMsg(errorText(err));
      setBusy(false);
    }
  };

  const crawl = async (id: string) => {
    await api(`/api/projects/${id}/crawl`, { method: "POST" });
    router.push(`/p/${id}/sitemap`);
  };

  const copyUrl = () =>
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });

  // Create, then crawl the sitemap for the page picker (manual auth: after the user logged in in the window).
  // A failed crawl leaves the draft project, linked in the error.
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    try {
      // only the selectors the user filled in; none -> the login form is found heuristically
      const filled = Object.fromEntries(Object.entries(selectors).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
      const config = {
        maxPages,
        depth,
        concurrency,
        delayMs,
        threshold: threshold / 100,
        ...(tokenBudget ? { tokenBudget: Number(tokenBudget) } : {}),
        auth: { mode: authMode, ...(authMode === "auto" && Object.keys(filled).length > 0 ? { selectors: filled } : {}) },
      };
      const credentials = authMode === "auto" ? { credentials: { user, pass, remember } } : {};
      const { id } = await api<{ id: string }>("/api/projects", { body: { url, mode, config, ...credentials } });
      setCreated(id);
      if (authMode === "manual") {
        setLoginFirst(true);
        setBusy(false);
        return;
      }
      await crawl(id);
    } catch (err) {
      setMsg(errorText(err));
      setBusy(false);
    }
  };

  const num = (value: number, set: (n: number) => void, min: number, max: number, step = 1) => (
    <input type="number" className="num-center" min={min} max={max} step={step} required value={value} onChange={(e) => set(e.target.valueAsNumber)} />
  );

  return (
    <form className="new-card" data-ui="ui_new_clone_card" onSubmit={(e) => void submit(e)}>
      <Section icon="language" title="URL trang web" hint="HTTP/HTTPS" ui="ui_new_clone_url_input">
        <span className="url-input">
          <Icon name="language" />
          <input required type="url" className="mono" aria-label="URL trang web" placeholder="https://example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          <IconButton icon="content_copy" label={copied ? "Đã sao chép" : "Sao chép URL"} disabled={!url} onClick={copyUrl} />
        </span>
      </Section>

      <SegmentedControl<Mode>
        data-ui="ui_new_clone_mode_toggle"
        label="Chế độ"
        full
        value={mode}
        onChange={setMode}
        options={[
          { value: "single", label: "1 trang đầy đủ", icon: "description" },
          { value: "crawl", label: "Crawl nhiều trang", icon: "account_tree" },
        ]}
      />
      {mode === "crawl" && (
        <Card variant="section" title="GIỚI HẠN CRAWL" data-ui="ui_new_clone_crawl_limits">
          <div className="limits-grid">
            <Field label="Số trang tối đa" suffix="trang">
              {num(maxPages, setMaxPages, 1, 100)}
            </Field>
            <Field label="Độ sâu" suffix="cấp">
              {num(depth, setDepth, 0, 5)}
            </Field>
            <Field label="Trang chụp song song" suffix="trang">
              {num(concurrency, setConcurrency, 1, 5)}
            </Field>
            <Field label="Delay giữa request" suffix="ms">
              {num(delayMs, setDelayMs, 0, 10_000, 100)}
            </Field>
          </div>
        </Card>
      )}

      <div className="new-divider" />
      <Section icon="lock" title="Đăng nhập" ui="ui_new_clone_auth_select">
        <select aria-label="Cách đăng nhập" className="full" value={authMode} onChange={(e) => setAuthMode(e.target.value as AuthMode)}>
          {AUTH_MODES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        {authMode === "auto" && (
          <div className="creds-grid" data-ui="ui_new_clone_auth_credentials">
            <Field label="Tài khoản">
              <input required autoComplete="off" value={user} onChange={(e) => setUser(e.target.value)} />
            </Field>
            <PasswordInput label="Mật khẩu" required value={pass} onChange={(e) => setPass(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Ghi nhớ (mã hóa trên máy này)
            </label>
          </div>
        )}
        {authMode === "auto" && (
          <Disclosure summary="Selector form đăng nhập (tùy chọn)" data-ui="ui_new_clone_auth_selectors">
            <div className="creds-grid">
              {(["user", "pass", "submit"] as const).map((k) => (
                <Field key={k} label={`Selector ${k === "user" ? "ô tài khoản" : k === "pass" ? "ô mật khẩu" : "nút gửi"}`}>
                  <input className="mono" maxLength={500} placeholder="CSS selector" value={selectors[k]} onChange={(e) => setSelectors({ ...selectors, [k]: e.target.value })} />
                </Field>
              ))}
            </div>
          </Disclosure>
        )}
      </Section>

      <div className="new-divider" />
      <Section icon="difference" title="Ngưỡng QA" hint={`${threshold}%`} ui="ui_new_clone_qa_threshold">
        <input type="range" aria-label="Ngưỡng QA" min={70} max={100} step={1} value={Math.min(100, Math.max(70, threshold))} onChange={(e) => setThreshold(e.target.valueAsNumber)} />
        <div className="qa-marks t-label-sm">
          {QA_MARKS.map(([v, label]) => (
            <span key={v} style={{ left: `${((v - 70) / 30) * 100}%` }}>
              {label}
            </span>
          ))}
        </div>
        {/* D9: the number keeps every threshold the schema allows (0..100), the slider covers 70..100 */}
        <Field label="Chính xác (%)" suffix="%" className="qa-exact">
          <input type="number" min={0} max={100} required value={threshold} onChange={(e) => setThreshold(e.target.valueAsNumber)} />
        </Field>
      </Section>

      <div className="new-divider" />
      <Section icon="generating_tokens" title="Ngân sách token" ui="ui_new_clone_token_budget">
        <span className="field-control has-suffix">
          <input
            type="text"
            inputMode="numeric"
            aria-label="Ngân sách token"
            className="mono"
            placeholder="2.000.000 (mặc định)"
            value={budgetFocus || !tokenBudget ? tokenBudget : fmtInt(Number(tokenBudget))}
            onFocus={() => setBudgetFocus(true)}
            onBlur={() => setBudgetFocus(false)}
            onChange={(e) => setTokenBudget(e.target.value.replace(/\D/g, "").slice(0, 12))}
          />
          <span className="field-suffix t-label-sm" aria-hidden="true">
            token
          </span>
        </span>
        <p className="t-body-sm text-3">Dùng cho đặt tên section và vòng sửa QA. Hết ngân sách → dừng các bước AI, dự án vẫn hoàn thành.</p>
      </Section>

      <div className="new-divider" />
      <Section icon="output" title="Định dạng output" ui="ui_new_clone_output_format">
        <div role="radiogroup" aria-label="Định dạng output" className="output-grid">
          <div role="radio" aria-checked="true" tabIndex={0} className="output-card is-on">
            <span className="mono">HTML</span>
            <span className="t-body-sm text-2">HTML/CSS tĩnh</span>
            <Badge tone="success">Đang dùng</Badge>
          </div>
          {SP2_OUTPUTS.map((o) => (
            <div key={o} role="radio" aria-checked="false" aria-disabled="true" className="output-card">
              <span className="mono">{o}</span>
              <Badge>SP2</Badge>
            </div>
          ))}
        </div>
      </Section>

      {msg && (
        <Banner tone="danger" icon="error" data-ui="ui_new_clone_error">
          {msg}
          {created && (
            <>
              {" — "}
              <Link href={`/p/${created}/sitemap`}>mở sitemap của dự án đã tạo</Link>
            </>
          )}
        </Banner>
      )}
      {loginFirst && created ? (
        <div role="group" aria-label="Đăng nhập trước khi quét" data-ui="ui_new_clone_manual_login">
          <Banner
            tone="info"
            icon="lock"
            actions={
              <>
                <Button icon="open_in_new" disabled={busy} onClick={() => void run(() => api(`/api/projects/${created}/auth/open`, { method: "POST" }).then(() => setBusy(false)))}>
                  Mở cửa sổ đăng nhập
                </Button>
                <Button variant="primary" icon="radar" disabled={busy} onClick={() => void run(() => crawl(created))}>
                  Quét trang
                </Button>
              </>
            }
          >
            Mở cửa sổ Chrome, đăng nhập (tự xử lý CAPTCHA nếu có), rồi bấm Quét trang — cửa sổ sẽ được đóng trước khi quét.
          </Banner>
        </div>
      ) : (
        <div className="new-actions">
          <Button href="/" data-ui="ui_new_clone_cancel">
            Hủy
          </Button>
          <Button type="submit" variant="primary" size="lg" icon="radar" iconEnd="arrow_forward" disabled={busy} data-ui="ui_new_clone_preview_sitemap">
            {busy ? "Đang quét…" : "Quét trang"}
          </Button>
        </div>
      )}
    </form>
  );
}
```

- [ ] **Step 5: CSS** — append:

```css
/* === Screen: new clone === */
.new-card { max-width: 1000px; margin: 0 auto; padding: var(--s-xl); display: grid; gap: var(--s-lg); background: var(--c-surface-low); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
.new-section { display: grid; gap: var(--s-md); }
.new-section-head { display: flex; align-items: center; gap: var(--s-sm); color: var(--c-text-2); }
.new-section-head h2 { color: var(--c-text); text-transform: uppercase; letter-spacing: 0.05em; flex: 1; }
.new-section-hint { color: var(--c-text-3); }
.new-divider { height: 1px; background: var(--c-border); }
.url-input { position: relative; display: flex; align-items: center; }
.url-input > .icon { position: absolute; left: 12px; color: var(--c-text-3); pointer-events: none; }
.url-input > input { flex: 1; min-height: 44px; padding-left: 38px; padding-right: 40px; background: var(--c-surface-lowest); font: var(--t-label-md); }
.url-input > .icon-btn { position: absolute; right: 8px; }
.limits-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s-md); }
.num-center { text-align: center; }
select.full { width: 100%; }
.creds-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s-md); align-items: end; }
.check { display: inline-flex; align-items: center; gap: var(--s-sm); font: var(--t-body-md); color: var(--c-text-2); }
.qa-marks { position: relative; height: 16px; margin: 0 8px; color: var(--c-text-3); }
.qa-marks > span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
.qa-marks > span:first-child { transform: none; }
.qa-marks > span:last-child { transform: translateX(-100%); }
.qa-exact { max-width: 220px; }
.output-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--s-sm); }
.output-card { display: grid; gap: 4px; justify-items: start; padding: var(--s-md); border: 1px solid var(--c-border); border-radius: var(--r-md); background: var(--c-surface-lowest); color: var(--c-text-3); }
.output-card.is-on { border-color: var(--c-primary); color: var(--c-text); background: color-mix(in srgb, var(--c-primary) 8%, transparent); }
.output-card[aria-disabled="true"] { opacity: 0.6; cursor: not-allowed; }
.new-actions { display: flex; justify-content: flex-end; gap: var(--s-sm); padding-top: var(--s-md); border-top: 1px solid var(--c-border); }
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts -t "new"`
Expected: PASS (the layout test + the 3 updated flow tests).

- [ ] **Step 7: Parity screenshot** — rerun with `PARITY_DIR`; compare `new-clone-crawl-auto.png` with `docs/superpowers/design/stitch/new-clone.png` (centered card, section headers with 20px icon + hint, large URL input, full-width segmented mode, crawl-constraints card with unit suffixes, slider with 4 marks, token budget with suffix, 5 output cards). Report differences.

- [ ] **Step 8: Typecheck + unit + build** — `npx tsc --noEmit && npx vitest run` + build check.

- [ ] **Step 9: Commit**

```bash
git add src/app/new/page.tsx src/app/new/new-clone-form.tsx src/app/globals.css tests/e2e/ui-smoke.test.ts
git commit -m "feat(ui): /new to Stitch parity (card sections, mode toggle, QA slider + exact value, output cards)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 10: Screen `/p/[id]/sitemap` — `screen_sitemap` (spec §3.4, D8, D10)

**Files:**
- Create: `src/app/p/[id]/sitemap/route-tree.ts`, `tests/unit/route-tree.test.ts`
- Modify: `src/app/p/[id]/sitemap/page.tsx`, `src/app/p/[id]/sitemap/sitemap-picker.tsx` (rewrite), `src/app/p/[id]/session-tools.tsx` (restyle + export `importSessionFile`), `src/app/globals.css` (sitemap CSS; delete `/* legacy: sitemap */`), `tests/e2e/ui-smoke.test.ts`

**Interfaces:**
- Consumes: Task 2 components, `estimateRun`, `HistoryRates` (`@/core/estimate`), `historyRates()`, `loadProject` (`../data`, Task 6), `CrawlPage` fields `status/loadMs/redirected` (Task 5), start closes the login window (D8, Task 6).
- Produces:
  - `route-tree.ts`: `type RouteRow<P> = { kind: "folder" | "page"; key: string; path: string; depth: number; isLast: boolean; page?: P; urls: string[]; children: RouteRow<P>[] }`; `pathOf(url): string`; `buildRouteTree<P extends { url: string }>(pages: P[]): RouteRow<P>[]`; `filterTree(rows, keep: (url) => boolean)`; `visibleRows(rows, closed: Set<string>)`; `parentKeys(rows): string[]`; `selectionState(urls: string[], selected: Set<string>): "all" | "some" | "none"`; `httpLabel(p): { text: string; tone: "neutral" | "success" | "warn" | "danger" }`.
  - `session-tools.tsx`: `importSessionFile(projectId: string, file: File): Promise<string>`, `SessionTools({ projectId })` (still a region named "Phiên đăng nhập"; used again by Task 11).

Elements (17): `ui_sitemap_page_header`, `…_select_all`, `…_cost_estimate`, `…_route_search`, `…_expand_collapse`, `…_filter_tabs`, `…_route_tree`, `…_http_status`, `…_auth_gated_rows`, `…_captured_at`, `…_protected_banner`, `…_action_bar`, `…_runtime_estimate`, `…_cancel`, `…_start_clone`, `…_recrawl`, `…_session_tools`. Not rendered: "Stage 3", "Task #", "Pipelines", payload/assets/"cached" columns, Engine label, Configure Rules, "Inject Cookies (.har)", "Configure Turnstile Bypass", "$", "cost", the origin row (D10), keyboard shortcut.

- [ ] **Step 0: Trace in the graph** — `/graphify explain screen_sitemap`; confirm `drift_sitemap_turnstile_bypass`, `drift_sitemap_capture_telemetry`, `drift_sitemap_extra_nav` stay absent; `/graphify path "feat_auth" "screen_sitemap"`.

- [ ] **Step 1: Write the failing unit test** — `tests/unit/route-tree.test.ts`

```ts
import { expect, test } from "vitest";
import { buildRouteTree, filterTree, httpLabel, parentKeys, selectionState, visibleRows, type RouteRow } from "@/app/p/[id]/sitemap/route-tree";

const o = "http://x.test";
const pages = (paths: string[]) => paths.map((p) => ({ url: `${o}${p}` }));
const flat = <P,>(rows: RouteRow<P>[]) => visibleRows(rows, new Set()).map((r) => `${"  ".repeat(r.depth)}${r.kind === "folder" ? "+" : "-"}${r.path}${r.isLast ? " $" : ""}`);

test("D10: a virtual folder only for a non-page prefix with >= 2 pages; a single-page prefix is lifted; home is a sibling, no origin row", () => {
  expect(flat(buildRouteTree(pages(["/docs/b", "/", "/blog/post", "/about", "/docs/a"])))).toEqual([
    "-/",
    "-/about",
    "-/blog/post",
    "+/docs $",
    "  -/docs/a",
    "  -/docs/b $",
  ]);
});

test("a page with sub-pages is their parent; a query string is its own leaf; folder urls = every page below", () => {
  const tree = buildRouteTree(pages(["/pricing", "/pricing/team", "/?page=2", "/a/b/c", "/a/b/d"]));
  expect(flat(tree)).toEqual(["-/?page=2", "+/a/b", "  -/a/b/c", "  -/a/b/d $", "-/pricing $", "  -/pricing/team $"]);
  expect(tree.find((r) => r.kind === "folder")?.urls).toEqual([`${o}/a/b/c`, `${o}/a/b/d`]);
  expect(tree.find((r) => r.path === "/pricing")?.urls).toEqual([`${o}/pricing`]);
});

test("filterTree keeps matches and their ancestors; visibleRows hides closed branches; parentKeys lists every expandable row", () => {
  const tree = buildRouteTree(pages(["/", "/docs/a", "/docs/b", "/about"]));
  expect(flat(filterTree(tree, (u) => u.endsWith("/docs/b")))).toEqual(["+/docs $", "  -/docs/b $"]);
  expect(filterTree(tree, (u) => u.endsWith("/docs/b"))[0]?.urls).toEqual([`${o}/docs/b`]);
  expect(filterTree(tree, () => false)).toEqual([]);
  expect(visibleRows(tree, new Set(["/docs"])).map((r) => r.path)).toEqual(["/", "/about", "/docs"]);
  expect(parentKeys(tree)).toEqual(["/docs"]);
});

test("selectionState is the tri-state of a folder checkbox", () => {
  const sel = new Set(["a", "b"]);
  expect([selectionState(["a", "b"], sel), selectionState(["a", "c"], sel), selectionState(["c"], sel), selectionState([], sel)]).toEqual(["all", "some", "none", "none"]);
});

test("httpLabel: 2xx success with seconds, redirect text-2, 401/403 warn, other 4xx/5xx danger, no data '—'", () => {
  expect(httpLabel({ status: 200, loadMs: 1234, redirected: false })).toEqual({ text: "200 · 1,2 s", tone: "success" });
  expect(httpLabel({ status: 200, loadMs: 60, redirected: true })).toEqual({ text: "200 · chuyển hướng", tone: "neutral" });
  expect(httpLabel({ status: 401, loadMs: 40 }).tone).toBe("warn");
  expect(httpLabel({ status: 404, loadMs: 40 }).tone).toBe("danger");
  expect(httpLabel({ status: 503, loadMs: 40 }).tone).toBe("danger");
  expect(httpLabel({})).toEqual({ text: "—", tone: "neutral" }); // discover.json from before spec §4.4
  expect(httpLabel({ status: null })).toEqual({ text: "—", tone: "neutral" });
});

test("100 pages build in < 50 ms", () => {
  const many = pages(Array.from({ length: 100 }, (_, i) => `/s${i % 10}/p${i}`));
  const t0 = performance.now();
  const tree = buildRouteTree(many);
  expect(performance.now() - t0).toBeLessThan(50);
  expect(visibleRows(tree, new Set()).filter((r) => r.kind === "page")).toHaveLength(100);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/route-tree.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write `src/app/p/[id]/sitemap/route-tree.ts`**

```ts
// Sitemap tree (spec parity §3.4, D10), pure: one node per path segment. A virtual folder only for a prefix that is
// not itself a page and holds >= 2 pages (in >= 2 branches); a non-page prefix with a single branch is skipped (its
// rows are lifted). A page with sub-pages is their parent. No origin row: the origin is the chip in the page header.
export type RouteRow<P> = { kind: "folder" | "page"; key: string; path: string; depth: number; isLast: boolean; page?: P; urls: string[]; children: RouteRow<P>[] };

type Trie<P> = { prefix: string; page?: P; kids: Map<string, Trie<P>> };

export const pathOf = (url: string): string => {
  const u = new URL(url);
  return u.pathname + u.search;
};

const urlsOf = <P extends { url: string }>(n: Trie<P>): string[] => [...(n.page ? [n.page.url] : []), ...[...n.kids.values()].flatMap((k) => urlsOf(k))];
const markLast = <P>(rows: RouteRow<P>[]): RouteRow<P>[] => rows.map((r, i) => ({ ...r, isLast: i === rows.length - 1 }));

function rowsOf<P extends { url: string }>(node: Trie<P>, depth: number): RouteRow<P>[] {
  const out: RouteRow<P>[] = [];
  const kids = [...node.kids.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, k]) => k);
  for (const kid of kids) {
    if (kid.page) out.push({ kind: "page", key: kid.prefix, path: kid.prefix, depth, isLast: false, page: kid.page, urls: [kid.page.url], children: rowsOf(kid, depth + 1) });
    // >= 2 branches below a non-page prefix = >= 2 pages (every leaf is a page); a single branch is lifted, so a chain
    // like /a -> /a/b collapses into one folder "/a/b"
    else if (kid.kids.size >= 2) out.push({ kind: "folder", key: kid.prefix, path: kid.prefix, depth, isLast: false, urls: urlsOf(kid), children: rowsOf(kid, depth + 1) });
    else out.push(...rowsOf(kid, depth));
  }
  return markLast(out);
}

export function buildRouteTree<P extends { url: string }>(pages: P[]): RouteRow<P>[] {
  const root: Trie<P> = { prefix: "", kids: new Map() };
  for (const p of pages) {
    const u = new URL(p.url);
    const segs = u.pathname.split("/").filter(Boolean);
    let node = root;
    segs.forEach((seg, i) => {
      let next = node.kids.get(seg);
      if (!next) {
        next = { prefix: `/${segs.slice(0, i + 1).join("/")}`, kids: new Map() };
        node.kids.set(seg, next);
      }
      node = next;
    });
    if (u.search) {
      const leaf: Trie<P> = { prefix: u.pathname + u.search, page: p, kids: new Map() };
      node.kids.set(u.search, leaf);
    } else if (node.page) {
      node.kids.set(`#${pathOf(p.url)}`, { prefix: pathOf(p.url), page: p, kids: new Map() }); // "/a" and "/a/": both kept
    } else node.page = p;
  }
  const home: RouteRow<P>[] = root.page ? [{ kind: "page", key: "/", path: "/", depth: 0, isLast: false, page: root.page, urls: [root.page.url], children: [] }] : [];
  return markLast([...home, ...rowsOf(root, 0)]);
}

// Matching pages and the rows above them; a folder's urls shrink to the matching ones (its checkbox acts on those).
export function filterTree<P extends { url: string }>(rows: RouteRow<P>[], keep: (url: string) => boolean): RouteRow<P>[] {
  const out: RouteRow<P>[] = [];
  for (const r of rows) {
    const children = filterTree(r.children, keep);
    const self = r.kind === "page" && r.page !== undefined && keep(r.page.url);
    if (self || children.length > 0) out.push({ ...r, children, urls: r.kind === "folder" ? r.urls.filter(keep) : r.urls });
  }
  return markLast(out);
}

export const visibleRows = <P>(rows: RouteRow<P>[], closed: Set<string>): RouteRow<P>[] => rows.flatMap((r) => [r, ...(closed.has(r.key) ? [] : visibleRows(r.children, closed))]);

export const parentKeys = <P>(rows: RouteRow<P>[]): string[] => rows.flatMap((r) => (r.children.length ? [r.key, ...parentKeys(r.children)] : []));

export function selectionState(urls: string[], selected: Set<string>): "all" | "some" | "none" {
  const n = urls.filter((u) => selected.has(u)).length;
  return n === 0 ? "none" : n === urls.length ? "all" : "some";
}

export function httpLabel(p: { status?: number | null; loadMs?: number; redirected?: boolean }): { text: string; tone: "neutral" | "success" | "warn" | "danger" } {
  if (p.status === undefined || p.status === null) return { text: "—", tone: "neutral" };
  if (p.redirected || (p.status >= 300 && p.status < 400)) return { text: `${p.status} · chuyển hướng`, tone: "neutral" };
  const text = `${p.status} · ${((p.loadMs ?? 0) / 1000).toFixed(1).replace(".", ",")} s`;
  if (p.status < 300) return { text, tone: "success" };
  return { text, tone: p.status === 401 || p.status === 403 ? "warn" : "danger" };
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/unit/route-tree.test.ts` → PASS (6 tests).

- [ ] **Step 5: Write the failing smoke test** — in `tests/e2e/ui-smoke.test.ts` add:

```ts
test("sitemap: tree + connectors, HTTP/auth/captured columns, filters, tri-state, estimates, protected banner, action bar", async () => {
  const db = openDb(env.DB_PATH);
  const o = "http://sitemap.test";
  let id = "";
  try {
    id = seedProject(db, { url: `${o}/`, status: "draft", mode: "crawl", tasks: [{ phase: "discover", key: `${o}/`, status: "done" }, { phase: "capture", key: "about", status: "done" }] });
    await writeWs(env.WORKSPACE_ROOT, id, "pages.json", JSON.stringify([{ pageId: "about", url: `${o}/about` }]));
    await writeWs(env.WORKSPACE_ROOT, id, "discover.json", JSON.stringify([
      { url: `${o}/`, needsAuth: false, status: 200, loadMs: 1234, redirected: false },
      { url: `${o}/about`, needsAuth: false, status: 200, loadMs: 80, redirected: false },
      { url: `${o}/docs/a`, needsAuth: false, status: 200, loadMs: 90, redirected: false },
      { url: `${o}/docs/b`, needsAuth: false, status: 200, loadMs: 95, redirected: false },
      { url: `${o}/account`, needsAuth: true, status: 401, loadMs: 40, redirected: false },
      { url: `${o}/old`, needsAuth: false, status: 200, loadMs: 60, redirected: true },
      { url: `${o}/legacy`, needsAuth: false }, // written before spec §4.4: no HTTP data
    ]));
  } finally {
    db.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  await page.goto(`${base}/p/${id}/sitemap`);
  const tree = page.locator('[data-ui="ui_sitemap_route_tree"]');
  const rowOf = (text: string) => tree.locator('[role="row"]').filter({ hasText: text });
  const pageBoxes = tree.getByRole("checkbox", { name: /^\// });
  await expect.poll(() => rowOf("/docs (2 trang con)").count()).toBe(1);
  expect(await rowOf("/ (trang chủ)").innerText()).toContain("200 · 1,2 s");
  expect(await rowOf("/old").innerText()).toContain("200 · chuyển hướng");
  expect(await rowOf("/account").innerText()).toMatch(/401[\s\S]*Cần đăng nhập/);
  expect(await rowOf("/account").getAttribute("class")).toContain("row-warn");
  expect(await rowOf("/legacy").locator('[data-ui="ui_sitemap_http_status"]').innerText()).toBe("—");
  expect(await rowOf("/about").innerText()).toContain("đã chụp");
  expect(await rowOf("/legacy").innerText()).toContain("Chưa chụp");
  expect(await page.locator('[data-ui="ui_sitemap_select_all"]').innerText()).toMatch(/Chọn tất cả \(7\)[\s\S]*7 \/ 7 đã chọn/);
  // defaults (fewer than 20 samples in this db): 7 pages -> 14 fix sections -> 21k + 840k tokens; ~1216 s
  expect(await page.locator('[data-ui="ui_sitemap_cost_estimate"]').innerText()).toBe("· ~861k token (ước tính)");
  const bar = page.locator('[data-ui="ui_sitemap_action_bar"]');
  expect(await bar.innerText()).toMatch(/7 trang đã chọn \(1 cần đăng nhập\)[\s\S]*Ước tính ~20 phút[\s\S]*Hủy[\s\S]*Bắt đầu clone/);
  const banner = page.locator('[data-ui="ui_sitemap_protected_banner"]');
  expect(await banner.innerText()).toContain("Có 1 trang cần đăng nhập trong lựa chọn");
  expect(await banner.getByRole("button", { name: "Mở cửa sổ đăng nhập" }).count()).toBe(1);
  expect(await banner.getByText("Import cookie JSON").count()).toBe(1);
  await expectUi(page, ["ui_sitemap_page_header", "ui_sitemap_route_search", "ui_sitemap_expand_collapse", "ui_sitemap_filter_tabs", "ui_sitemap_auth_gated_rows", "ui_sitemap_captured_at", "ui_sitemap_runtime_estimate", "ui_sitemap_cancel", "ui_sitemap_start_clone", "ui_sitemap_session_tools"]);
  expect(await page.locator('[data-ui="ui_sitemap_page_header"]').innerText()).toMatch(/http:\/\/sitemap\.test[\s\S]*7 trang · 1 đã chụp/);
  await expectNoDrift(page);
  await expectIconButtonsLabelled(page);
  await parityShot(page, "sitemap");

  // tri-state folder; deselecting the auth page removes the banner
  await tree.getByRole("checkbox", { name: "/docs/a", exact: true }).uncheck();
  expect(await tree.getByRole("checkbox", { name: "Chọn tất cả trong /docs" }).evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
  expect(await rowOf("/docs/a").getAttribute("class")).toContain("unselected");
  await tree.getByRole("checkbox", { name: "/account", exact: true }).uncheck();
  expect(await banner.count()).toBe(0);
  expect(await bar.innerText()).toContain("5 trang đã chọn");
  await tree.getByRole("checkbox", { name: "Chọn tất cả trong /docs" }).check();
  expect(await bar.innerText()).toContain("6 trang đã chọn");

  // filter tabs with counts
  const tabs = page.getByRole("group", { name: "Bộ lọc trang" });
  expect(await tabs.innerText()).toMatch(/Tất cả \(7\)[\s\S]*Công khai \(6\)[\s\S]*Cần đăng nhập \(1\)[\s\S]*Đã chụp < 7 ngày \(1\)/);
  await tabs.getByRole("button", { name: /Cần đăng nhập/ }).click();
  await expect.poll(() => pageBoxes.count()).toBe(1);
  await tabs.getByRole("button", { name: /Tất cả/ }).click();

  // search: literal, case-insensitive substring; regex characters never throw
  const search = page.getByRole("searchbox", { name: "Lọc đường dẫn" });
  await search.fill("[");
  await expect.poll(() => pageBoxes.count()).toBe(0);
  await search.fill("DOCS");
  await expect.poll(() => pageBoxes.count()).toBe(2);
  await search.fill("");

  // expand / collapse
  await page.getByRole("button", { name: "Thu gọn", exact: true }).click();
  expect(await tree.getByRole("checkbox", { name: "/docs/a", exact: true }).count()).toBe(0);
  await page.getByRole("button", { name: "Mở hết", exact: true }).click();
  expect(await tree.getByRole("checkbox", { name: "/docs/a", exact: true }).count()).toBe(1);

  // session tools sit in a closed disclosure, 16px below the action bar
  await page.locator('[data-ui="ui_sitemap_session_tools"] > summary').click();
  expect(await page.getByRole("region", { name: "Phiên đăng nhập" }).isVisible()).toBe(true);
  expect(foreign).toEqual([]);
  await page.close();
});
```
In "new (manual login)…" open the disclosure before using the session tools: insert `await page.locator('[data-ui="ui_sitemap_session_tools"] > summary').click();` before `const session = page.getByRole("region", { name: "Phiên đăng nhập" });`.

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts -t "sitemap|new"` → FAIL.

- [ ] **Step 7: `src/app/p/[id]/session-tools.tsx`** (whole file)

```tsx
"use client";
import { useState, type ChangeEvent } from "react";
import { api, errorText } from "@/app/_ui/api";
import { Button } from "@/app/_ui/Button";

// A bare cookie array (browser extension export) or a Playwright storageState, applied into the project profile.
export async function importSessionFile(projectId: string, file: File): Promise<string> {
  const raw = JSON.parse(await file.text()) as unknown;
  const storageState = Array.isArray(raw) ? { cookies: raw } : raw;
  const r = await api<{ cookies: number; origins: number }>(`/api/projects/${projectId}/session/import`, { body: { storageState } });
  return `Đã import ${r.cookies} cookie, ${r.origins} origin.`;
}

// The project's browser session (spec §3): clear it, or import a cookie / storageState JSON export into it.
export function SessionTools({ projectId }: { projectId: string }) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    if (!confirm("Xóa phiên đăng nhập (cookie, localStorage) của dự án này?")) return;
    void run(async () => {
      await api(`/api/projects/${projectId}/session/clear`, { method: "POST" });
      return "Đã xóa phiên.";
    });
  };

  const importFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // the same file can be picked again
    if (file) void run(() => importSessionFile(projectId, file));
  };

  return (
    <section className="session-tools" aria-label="Phiên đăng nhập">
      <div className="row">
        <Button icon="delete" disabled={busy} onClick={clear}>
          Xóa phiên
        </Button>
        <label className="file-pick">
          <span className="t-label-md text-2">Import cookie / storageState JSON</span>
          <input type="file" accept="application/json,.json" disabled={busy} onChange={importFile} />
        </label>
      </div>
      {msg && (
        <p className={`note tint tone-${msg.ok ? "success" : "danger"}`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
    </section>
  );
}
```

- [ ] **Step 8: `src/app/p/[id]/sitemap/page.tsx`** (keep `captureDates`, replace the rest)

```tsx
import type { CrawlPage } from "@/core/crawl";
import type { ProjectConfig } from "@/core/jobs-base";
import { getDb } from "@/app/_server/db";
import { Button } from "@/app/_ui/Button";
import { Disclosure } from "@/app/_ui/Disclosure";
import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { StatusPill } from "@/app/_ui/StatusPill";
import { UrlChip } from "@/app/_ui/UrlChip";
import { historyRates, loadProject, readWorkspaceJson } from "../data";
import { SessionTools } from "../session-tools";
import { SitemapPicker, type SitemapPage } from "./sitemap-picker";

// (captureDates unchanged)

export default async function SitemapScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = loadProject(id);
  const cfg = JSON.parse(project.config_json) as ProjectConfig;
  const [discovered, dates] = await Promise.all([readWorkspaceJson<CrawlPage[] | null>(id, "discover.json", null), captureDates(id)]);
  const pages: SitemapPage[] = (discovered ?? []).map((p) => ({ ...p, capturedAt: dates.get(p.url) ?? null }));
  const captured = pages.filter((p) => p.capturedAt !== null).length;
  return (
    <>
      <PageHeader
        data-ui="ui_sitemap_page_header"
        crumbs={projectCrumbs(project.url, id, "Sitemap")}
        title="Chọn trang để clone"
        meta={<StatusPill status={project.status} />}
        actions={
          <>
            <UrlChip
              url={new URL(project.url).origin}
              openable
              extra={
                <span className="t-label-sm text-3 chip-extra">
                  {pages.length} trang · {captured} đã chụp
                </span>
              }
            />
            {project.status !== "draft" && (
              <Button href={`/p/${id}`} icon="timeline">
                Xem tiến độ
              </Button>
            )}
          </>
        }
      />
      <SitemapPicker
        projectId={id}
        pages={pages}
        crawled={discovered !== null}
        draft={project.status === "draft"}
        rates={historyRates()}
        tokenBudget={cfg.tokenBudget}
        concurrency={cfg.concurrency}
        delayMs={cfg.delayMs}
        now={Math.floor(Date.now() / 1000)}
      />
      <Disclosure summary="Phiên đăng nhập" className="section-gap" data-ui="ui_sitemap_session_tools">
        <SessionTools projectId={id} />
      </Disclosure>
    </>
  );
}
```
(`getDb` stays imported for `captureDates`.)

- [ ] **Step 9: Rewrite `src/app/p/[id]/sitemap/sitemap-picker.tsx`**

```tsx
"use client";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import type { CrawlPage } from "@/core/crawl";
import { estimateRun, type HistoryRates } from "@/core/estimate";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { GridTable } from "@/app/_ui/GridTable";
import { Icon } from "@/app/_ui/Icon";
import { IconButton } from "@/app/_ui/IconButton";
import { RelTime } from "@/app/_ui/RelTime";
import { SearchInput } from "@/app/_ui/SearchInput";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { fmtMinutes, fmtTokens } from "@/app/_ui/format";
import { importSessionFile } from "../session-tools";
import { buildRouteTree, filterTree, httpLabel, parentKeys, pathOf, selectionState, visibleRows, type RouteRow } from "./route-tree";

export type SitemapPage = CrawlPage & { capturedAt: number | null };
type Filter = "all" | "public" | "auth" | "recent";
type Props = {
  projectId: string;
  pages: SitemapPage[];
  crawled: boolean;
  draft: boolean;
  rates: HistoryRates;
  tokenBudget: number;
  concurrency: number;
  delayMs: number;
  now: number; // epoch s, from the server (no hydration drift in the "< 7 ngày" count)
};

const WEEK_S = 7 * 86_400;
const COLUMNS = [
  { key: "path", header: "ĐƯỜNG DẪN", width: "minmax(0, 1fr)" },
  { key: "http", header: "HTTP", width: "160px" },
  { key: "auth", header: "ĐĂNG NHẬP", width: "150px" },
  { key: "captured", header: "ĐÃ CHỤP", width: "170px" },
];
const ESTIMATE_TITLE = "Ước tính thô: ~3.000 token/trang để đặt tên + ~60.000 token cho mỗi section cần sửa, chặn bởi ngân sách token.";
const shownPath = (path: string) => (path === "/" ? "/ (trang chủ)" : path);

function TriCheckbox({ state, label, disabled, onChange, visibleLabel }: { state: "all" | "some" | "none"; label: string; disabled: boolean; onChange(): void; visibleLabel?: ReactNode }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  const box = <input ref={ref} type="checkbox" checked={state === "all"} disabled={disabled} onChange={onChange} aria-label={visibleLabel ? undefined : label} />;
  return visibleLabel ? (
    <label className="check">
      {box}
      {visibleLabel}
    </label>
  ) : (
    box
  );
}

export function SitemapPicker({ projectId, pages, crawled, draft, rates, tokenBudget, concurrency, delayMs, now }: Props) {
  const router = useRouter();
  const [selected, setSelected] = useState(() => new Set(pages.map((p) => p.url)));
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [authMsg, setAuthMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const tree = useMemo(() => buildRouteTree(pages), [pages]);

  const recent = (p: SitemapPage) => p.capturedAt !== null && p.capturedAt >= now - WEEK_S;
  const inTab = (p: SitemapPage) => filter === "all" || (filter === "public" ? !p.needsAuth : filter === "auth" ? p.needsAuth : recent(p));
  const q = query.trim().toLowerCase();
  const shown = pages.filter((p) => inTab(p) && (!q || pathOf(p.url).toLowerCase().includes(q)));
  const shownUrls = new Set(shown.map((p) => p.url));
  const filtering = filter !== "all" || q !== "";
  // while filtering, every branch holding a match is open
  const rows = visibleRows(filtering ? filterTree(tree, (u) => shownUrls.has(u)) : tree, filtering ? new Set<string>() : closed);
  const counts = { all: pages.length, public: pages.filter((p) => !p.needsAuth).length, auth: pages.filter((p) => p.needsAuth).length, recent: pages.filter(recent).length };
  const authSelected = pages.filter((p) => p.needsAuth && selected.has(p.url)).length;
  const est = estimateRun({ pages: selected.size, concurrency, delayMs, tokenBudget, ...rates });

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg("");
    try {
      await fn();
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const setMany = (urls: string[], on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      for (const u of urls) {
        if (on) next.add(u);
        else next.delete(u);
      }
      return next;
    });

  const toggleOpen = (key: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const recrawl = () =>
    run(async () => {
      await api(`/api/projects/${projectId}/crawl`, { method: "POST" });
      router.refresh();
    });

  const start = () =>
    run(async () => {
      const urls = pages.filter((p) => selected.has(p.url)).map((p) => p.url).sort((a, b) => pathOf(a).localeCompare(pathOf(b)));
      await api(`/api/projects/${projectId}/start`, { body: { pages: urls } }); // closes an open login window first (D8)
      router.push(`/p/${projectId}`);
    });

  const openWindow = async () => {
    setAuthMsg(null);
    try {
      await api(`/api/projects/${projectId}/auth/open`, { method: "POST" });
    } catch (e) {
      setAuthMsg({ ok: false, text: errorText(e) });
    }
  };

  const importFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setAuthMsg(null);
    importSessionFile(projectId, file).then(
      (text) => setAuthMsg({ ok: true, text }),
      (err: unknown) => setAuthMsg({ ok: false, text: errorText(err) }),
    );
  };

  const cell = (r: RouteRow<SitemapPage>, key: string): ReactNode => {
    const p = r.page;
    if (key === "path") {
      const open = filtering || !closed.has(r.key);
      return (
        <div className="tree-cell" style={{ paddingLeft: r.depth * 20 }}>
          {r.depth > 0 && <span className={`tree-conn${r.isLast ? " last" : ""}`} aria-hidden="true" />}
          {r.children.length > 0 ? (
            <IconButton icon="chevron_right" className={open ? "chev open" : "chev"} label={open ? `Thu gọn ${r.path}` : `Mở ${r.path}`} aria-expanded={open} onClick={() => toggleOpen(r.key)} />
          ) : (
            <span className="chev-space" />
          )}
          {r.kind === "folder" ? (
            <TriCheckbox state={selectionState(r.urls, selected)} label={`Chọn tất cả trong ${r.path}`} disabled={!draft} onChange={() => setMany(r.urls, selectionState(r.urls, selected) !== "all")} />
          ) : (
            <TriCheckbox state={selected.has(p!.url) ? "all" : "none"} label={shownPath(r.path)} disabled={!draft} onChange={() => setMany([p!.url], !selected.has(p!.url))} />
          )}
          <Icon name={r.kind === "folder" ? (open ? "folder_open" : "folder") : "description"} />
          <span className="mono tree-label" title={r.path}>
            {r.kind === "folder" ? `${r.path} (${r.urls.length} trang con)` : shownPath(r.path)}
          </span>
        </div>
      );
    }
    if (!p) return null;
    if (key === "http") {
      const h = httpLabel(p);
      return h.text === "—" ? (
        <span className="text-3" data-ui="ui_sitemap_http_status">
          —
        </span>
      ) : (
        <Badge tone={h.tone} data-ui="ui_sitemap_http_status">
          {h.text}
        </Badge>
      );
    }
    if (key === "auth")
      return p.needsAuth ? (
        <Badge tone="warn" title="Trang này cần đăng nhập">
          <Icon name="lock" size={14} />
          Cần đăng nhập
        </Badge>
      ) : (
        <span className="text-3">—</span>
      );
    return p.capturedAt ? (
      <RelTime at={p.capturedAt} prefix="đã chụp " data-ui="ui_sitemap_captured_at" />
    ) : (
      <span className="text-3" data-ui="ui_sitemap_captured_at">
        Chưa chụp
      </span>
    );
  };

  const visibleState = selectionState(shown.map((p) => p.url), selected);

  return (
    <div className="stack">
      {msg && (
        <Banner tone="danger" icon="error">
          {msg}
        </Banner>
      )}
      {!crawled && (
        <Card data-ui="ui_sitemap_recrawl">
          <div className="row spread">
            <span className="text-2">Chưa có sitemap (lần quét trước chưa xong hoặc lỗi).</span>
            <Button icon="radar" disabled={busy || !draft} onClick={() => void recrawl()}>
              {busy ? "Đang quét…" : "Quét lại"}
            </Button>
          </div>
        </Card>
      )}
      {crawled && (
        <>
          <div className="sitemap-tools">
            <div className="row">
              <span className="row" data-ui="ui_sitemap_select_all">
                <TriCheckbox
                  state={visibleState}
                  label="Chọn tất cả"
                  disabled={!draft || shown.length === 0}
                  onChange={() => setMany(shown.map((p) => p.url), visibleState !== "all")}
                  visibleLabel={`Chọn tất cả (${shown.length})`}
                />
                <span className="t-label-md text-2">
                  {selected.size} / {pages.length} đã chọn
                </span>
              </span>
              <span className="t-label-md text-3" data-ui="ui_sitemap_cost_estimate" title={ESTIMATE_TITLE}>
                {est.cappedByBudget ? `· tối đa ${fmtTokens(tokenBudget)} token (ngân sách)` : `· ~${fmtTokens(est.tokens)} token (ước tính)`}
              </span>
            </div>
            <div className="row">
              <SearchInput data-ui="ui_sitemap_route_search" label="Lọc đường dẫn" placeholder="Lọc theo đường dẫn…" value={query} onChange={setQuery} />
              <span className="row" data-ui="ui_sitemap_expand_collapse">
                <Button variant="ghost" icon="unfold_more" onClick={() => setClosed(new Set())}>
                  Mở hết
                </Button>
                <Button variant="ghost" icon="unfold_less" onClick={() => setClosed(new Set(parentKeys(tree)))}>
                  Thu gọn
                </Button>
              </span>
            </div>
          </div>
          <SegmentedControl<Filter>
            data-ui="ui_sitemap_filter_tabs"
            label="Bộ lọc trang"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: `Tất cả (${counts.all})` },
              { value: "public", label: `Công khai (${counts.public})` },
              { value: "auth", label: `Cần đăng nhập (${counts.auth})`, icon: "lock", tone: "warn" },
              { value: "recent", label: `Đã chụp < 7 ngày (${counts.recent})` },
            ]}
          />
          <GridTable
            data-ui="ui_sitemap_route_tree"
            label="Cây đường dẫn"
            columns={COLUMNS}
            rows={rows}
            rowKey={(r) => r.key}
            renderCell={cell}
            rowTone={(r) => (r.page?.needsAuth ? "warn" : undefined)}
            rowProps={(r) => ({
              className: r.page && !selected.has(r.page.url) ? "unselected" : undefined,
              "data-ui": r.page?.needsAuth ? "ui_sitemap_auth_gated_rows" : undefined,
            })}
            empty={<p className="table-empty">Không có trang nào khớp bộ lọc.</p>}
          />
          {draft && authSelected > 0 && (
            <Banner
              data-ui="ui_sitemap_protected_banner"
              tone="warn"
              icon="lock"
              title={`Có ${authSelected} trang cần đăng nhập trong lựa chọn`}
              actions={
                <>
                  <Button icon="open_in_new" onClick={() => void openWindow()}>
                    Mở cửa sổ đăng nhập
                  </Button>
                  <label className="btn btn-secondary file-btn">
                    <Icon name="drive_folder_upload" />
                    Import cookie JSON
                    <input type="file" accept="application/json,.json" className="visually-hidden" onChange={importFile} />
                  </label>
                </>
              }
            >
              Mở cửa sổ Chrome để đăng nhập (tự xử lý CAPTCHA nếu có), hoặc import cookie/storageState JSON. Phiên được lưu trong profile của dự án.
            </Banner>
          )}
          {authMsg && (
            <p className={`note tint tone-${authMsg.ok ? "primary" : "danger"}`} role={authMsg.ok ? "status" : "alert"}>
              {authMsg.text}
            </p>
          )}
        </>
      )}
      <div className="action-bar" data-ui="ui_sitemap_action_bar">
        <span className="t-label-md">
          {selected.size} trang đã chọn
          {authSelected > 0 && <span className="text-warn"> ({authSelected} cần đăng nhập)</span>}
        </span>
        <span className="t-label-md text-2" data-ui="ui_sitemap_runtime_estimate">
          Ước tính {fmtMinutes(est.seconds)}
        </span>
        <span className="action-bar-end">
          <Button href="/" data-ui="ui_sitemap_cancel">
            Hủy
          </Button>
          <Button variant="primary" size="lg" icon="play_arrow" data-ui="ui_sitemap_start_clone" disabled={busy || !draft || selected.size === 0} onClick={() => void start()}>
            Bắt đầu clone
          </Button>
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 10: CSS** — delete `/* legacy: sitemap */` and append:

```css
/* === Screen: sitemap === */
.sitemap-tools { display: flex; justify-content: space-between; align-items: center; gap: var(--s-md); flex-wrap: wrap; }
.tree-cell { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tree-conn { position: relative; width: 12px; flex: none; color: var(--c-border); font: var(--t-label-md); }
.tree-conn::before { content: "├"; }
.tree-conn.last::before { content: "└"; }
.chev .icon { transition: transform 0.15s; }
.chev.open .icon { transform: rotate(90deg); }
.chev-space { width: 28px; flex: none; }
.tree-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.grid-row.unselected .tree-label { color: var(--c-text-3); }
.chip-extra { padding: 0 6px; white-space: nowrap; }
.file-btn { position: relative; }
.file-btn:focus-within { outline: 2px solid var(--c-primary); outline-offset: 1px; }
.action-bar { position: sticky; bottom: 0; z-index: 5; display: flex; align-items: center; gap: var(--s-lg); padding: var(--s-md) var(--s-lg); background: var(--c-surface-lowest); border-top: 1px solid var(--c-border); }
.action-bar-end { margin-left: auto; display: flex; gap: var(--s-sm); }
.session-tools { display: grid; gap: var(--s-sm); }
.file-pick { display: inline-flex; align-items: center; gap: var(--s-sm); }
```

- [ ] **Step 11: Run to verify pass**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts -t "sitemap|new"` → PASS (the site3 crawl test still finds its 3 page checkboxes by path).

- [ ] **Step 12: Parity screenshot** — rerun with `PARITY_DIR`; compare `sitemap.png` with `docs/superpowers/design/stitch/sitemap.png` (select-all + counter + estimate line, search + expand/collapse, filter segmented row, tree with ├/└ connectors and folder rows, HTTP/auth/captured columns, amber rows, protected banner, sticky action bar). Report differences.

- [ ] **Step 13: Typecheck + unit + build** — `npx tsc --noEmit && npx vitest run` + build check.

- [ ] **Step 14: Commit**

```bash
git add "src/app/p/[id]/sitemap/route-tree.ts" "src/app/p/[id]/sitemap/page.tsx" "src/app/p/[id]/sitemap/sitemap-picker.tsx" "src/app/p/[id]/session-tools.tsx" src/app/globals.css tests/unit/route-tree.test.ts tests/e2e/ui-smoke.test.ts
git commit -m "feat(ui): sitemap to Stitch parity (route tree + folders, HTTP column, filters, estimates, login banner, action bar)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 11: Screen `/p/[id]` Tiến độ — `screen_progress` (spec §3.5)

**Files:**
- Create: `src/app/p/[id]/page-states.ts`, `tests/unit/page-states.test.ts`
- Modify: `src/app/p/[id]/page.tsx`, `src/app/p/[id]/progress-view.tsx` (rewrite), `src/app/p/[id]/phase-stepper.tsx` (icons, keep `phaseStates`), `src/app/globals.css` (progress CSS; delete `/* legacy: progress */`), `tests/unit/phase-stepper.test.ts` (unchanged logic — must stay green), `tests/e2e/ui-smoke.test.ts`

**Interfaces:**
- Consumes: SSE `history` message + stamped events (Task 3), progress `tokensUsed` (Task 4), `loadProject(...).tokens_used`, `readWorkspaceJson` (Task 6 / existing), `SessionTools` (Task 10), Task 2 components (`LogView`, `StatTile`, `Banner`, `PasswordInput`, …).
- Produces (`page-states.ts`, pure, client-safe): `type TaskView = { phase: string; key: string; status: string; errorCode: string | null }`, `type PageRef = { pageId: string; url: string }`, `type PageState = { pageId; path; state: "done"|"running"|"needs_auth"|"failed"|"skipped"|"pending"; phase?; code? }`, `pageStates(tasks, pages): PageState[]`, `stateLabel(p): string`, `type RunSpan = { start: number | null; end: number | null }`, `spanAfter(s, e: StampedEvent): RunSpan`, `runSpan(events): RunSpan`, `describe(e: StampedEvent): { level; text } | null`.

Elements (14): `ui_progress_page_header`, `…_context_bar`, `…_stats_bar`, `…_controls`, `…_phase_stepper`, `…_auth_banner`, `…_credentials_form`, `…_page_list`, `…_page_counts`, `…_log_stream`, `…_log_level_filter`, `…_log_toggles`, `…_log_line`, `…_session_tools`. Not rendered: DOM nodes, asset queue, cost/"$", daemon prompt, Workers/Mem/CPU footer, "Inspect DOM Snapshot" (`ui_progress_inspect_snapshot` out of scope), "Abort Clone", "worker#", "Thread #", "stdout & ast-worker.log PID", "Cloudflare/Turnstile/clearance", "200 OK 1.2s", "Cached".

- [ ] **Step 0: Trace in the graph** — `/graphify explain screen_progress`; confirm `drift_progress_turnstile_wording`, `drift_progress_system_telemetry`, `drift_progress_worker_tags` stay absent; `/graphify path "feat_job_queue_sse" "screen_progress"`.

- [ ] **Step 1: Write the failing unit test** — `tests/unit/page-states.test.ts`

```ts
import { expect, test } from "vitest";
import type { StampedEvent } from "@/core/jobs-base";
import { describe as lineOf, pageStates, runSpan, spanAfter, stateLabel, type TaskView } from "@/app/p/[id]/page-states";

const t = (phase: string, key: string, status: string, errorCode: string | null = null): TaskView => ({ phase, key, status, errorCode });
const pages = ["home", "a", "b", "c", "d", "e", "f"].map((pageId) => ({ pageId, url: `http://x.test/${pageId === "home" ? "" : pageId}?q=1` }));

test("pageStates: needs_auth > running > failed capture (skip codes -> skipped) > done (capture + name) > pending", () => {
  const states = pageStates(
    [
      t("capture", "home", "done"), t("name", "home", "done"),
      t("capture", "a", "needs_auth", "AUTH_REQUIRED"), t("name", "a", "running"),
      t("capture", "b", "done"), t("name", "b", "done"), t("fix", "b:sec-1", "running"),
      t("capture", "c", "failed", "NAV_TIMEOUT"),
      t("capture", "d", "failed", "ROBOTS_DISALLOWED"),
      t("capture", "e", "done"), t("name", "e", "pending"),
      t("ir", "all", "pending"), t("qa", "all", "pending"),
    ],
    pages,
  );
  expect(states.map((s) => [s.pageId, s.state, s.phase ?? s.code ?? ""])).toEqual([
    ["home", "done", ""],
    ["a", "needs_auth", ""],
    ["b", "running", "fix"],
    ["c", "failed", "NAV_TIMEOUT"],
    ["d", "skipped", "ROBOTS_DISALLOWED"],
    ["e", "pending", ""],
    ["f", "pending", ""],
  ]);
  expect(states[0]?.path).toBe("/?q=1");
  expect(states.map(stateLabel)).toEqual(["xong", "cần đăng nhập", "đang chạy · fix", "lỗi · NAV_TIMEOUT", "bỏ qua · ROBOTS_DISALLOWED", "chờ", "chờ"]);
  // capture done and no name task (e.g. a capture-only view) is done
  expect(pageStates([t("capture", "home", "done")], pages.slice(0, 1))[0]?.state).toBe("done");
});

test("run clock: the last `running` status starts it, the next status ends it", () => {
  const ev = (status: string, at: number) => ({ type: "status", status, at }) as StampedEvent;
  const log = { type: "log", level: "info", message: "x", at: 20 } as StampedEvent;
  expect(runSpan([])).toEqual({ start: null, end: null });
  expect(runSpan([ev("running", 10), log, ev("completed", 50)])).toEqual({ start: 10, end: 50 });
  expect(runSpan([ev("running", 10), ev("paused", 30), ev("running", 60)])).toEqual({ start: 60, end: null });
  expect(spanAfter({ start: 60, end: null }, ev("failed", 90))).toEqual({ start: 60, end: 90 });
  expect(spanAfter({ start: 60, end: 90 }, ev("interrupted", 99))).toEqual({ start: 60, end: 90 });
});

test("log lines: text as before (describe), progress is not a line", () => {
  expect(lineOf({ type: "task", phase: "capture", key: "home", status: "failed", errorCode: "NAV_TIMEOUT", error: "boom", at: 1 })).toEqual({ level: "error", text: "[capture] home → failed — NAV_TIMEOUT: boom" });
  expect(lineOf({ type: "status", status: "completed", at: 1 })).toEqual({ level: "info", text: "trạng thái → completed" });
  expect(lineOf({ type: "progress", progress: 5, tokensUsed: 0, at: 1 })).toBeNull();
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/page-states.test.ts` → FAIL (module missing).

- [ ] **Step 3: Write `src/app/p/[id]/page-states.ts`**

```ts
// Progress screen model (spec parity §3.5). Pure and client-safe (type-only core import).
import type { StampedEvent } from "@/core/jobs-base";

export type TaskView = { phase: string; key: string; status: string; errorCode: string | null };
export type PageRef = { pageId: string; url: string };
export type PageState = { pageId: string; path: string; state: "done" | "running" | "needs_auth" | "failed" | "skipped" | "pending"; phase?: string; code?: string };
export type RunSpan = { start: number | null; end: number | null };

// The orchestrator's skip codes (core/jobs SKIP): the page was left out on purpose.
const SKIP = new Set(["ROBOTS_DISALLOWED", "ASSET_TOO_LARGE", "NODE_LIMIT", "PROJECT_SIZE_LIMIT"]);

// A page's tasks: capture:<pageId>, name:<pageId>, fix:<pageId>:<sectionId>.
function pageOf(t: TaskView): string | null {
  if (t.phase === "capture" || t.phase === "name") return t.key;
  if (t.phase !== "fix") return null;
  const i = t.key.indexOf(":");
  return i > 0 ? t.key.slice(0, i) : t.key;
}

export function pageStates(tasks: TaskView[], pages: PageRef[]): PageState[] {
  const byPage = new Map<string, TaskView[]>();
  for (const t of tasks) {
    const id = pageOf(t);
    if (id === null) continue;
    const list = byPage.get(id);
    if (list) list.push(t);
    else byPage.set(id, [t]);
  }
  return pages.map(({ pageId, url }): PageState => {
    const own = byPage.get(pageId) ?? [];
    const u = new URL(url);
    const path = u.pathname + u.search;
    const capture = own.find((t) => t.phase === "capture");
    const name = own.find((t) => t.phase === "name");
    const running = own.find((t) => t.status === "running");
    if (own.some((t) => t.status === "needs_auth")) return { pageId, path, state: "needs_auth" };
    if (running) return { pageId, path, state: "running", phase: running.phase };
    if (capture?.status === "failed") {
      const code = capture.errorCode ?? undefined;
      return { pageId, path, state: code && SKIP.has(code) ? "skipped" : "failed", code };
    }
    if (capture?.status === "done" && (!name || name.status === "done")) return { pageId, path, state: "done" };
    return { pageId, path, state: "pending" };
  });
}

export function stateLabel(p: PageState): string {
  switch (p.state) {
    case "done":
      return "xong";
    case "running":
      return `đang chạy · ${p.phase ?? ""}`;
    case "needs_auth":
      return "cần đăng nhập";
    case "failed":
      return `lỗi · ${p.code ?? "?"}`;
    case "skipped":
      return `bỏ qua · ${p.code ?? "?"}`;
    case "pending":
      return "chờ";
  }
}

// Run clock from server stamps: the last `running` status starts it, the next status (paused, failed, …) ends it.
export function spanAfter(s: RunSpan, e: StampedEvent): RunSpan {
  if (e.type !== "status") return s;
  if (e.status === "running") return { start: e.at, end: null };
  return s.start !== null && s.end === null ? { start: s.start, end: e.at } : s;
}

export const runSpan = (events: StampedEvent[]): RunSpan => events.reduce(spanAfter, { start: null, end: null });

export function describe(e: StampedEvent): { level: "info" | "warn" | "error"; text: string } | null {
  switch (e.type) {
    case "status":
      return { level: e.status === "failed" ? "error" : "info", text: `trạng thái → ${e.status}${e.reason ? ` (${e.reason})` : ""}` };
    case "phase":
      return { level: "info", text: `pha ${e.phase}` };
    case "task": {
      const level = e.status === "failed" ? "error" : e.status === "needs_auth" ? "warn" : "info";
      const detail = [e.errorCode, e.error].filter(Boolean).join(": ");
      return { level, text: `[${e.phase}] ${e.key} → ${e.status}${detail ? ` — ${detail}` : ""}` };
    }
    case "log":
      return { level: e.level, text: e.message };
    case "needs_auth":
      return { level: "warn", text: `cần đăng nhập: ${e.url} (${e.code})` };
    case "progress":
      return null;
  }
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/unit/page-states.test.ts tests/unit/phase-stepper.test.ts` → PASS.

- [ ] **Step 5: Write the failing smoke tests** — in `tests/e2e/ui-smoke.test.ts` add:

```ts
const PHASE_NAMES = ["discover", "capture", "assets", "ir", "name", "emit", "qa", "fix", "done"];

test("progress (needs_auth): mandatory banner copy, 9-phase stepper in order, page states + counts", async () => {
  const db = openDb(env.DB_PATH);
  let id = "";
  try {
    id = seedProject(db, { url: "http://auth.test/", status: "needs_auth", mode: "crawl", tasks: [{ phase: "capture", key: "home", status: "needs_auth", errorCode: "AUTH_REQUIRED" }, { phase: "capture", key: "about", status: "pending" }] });
    await writeWs(env.WORKSPACE_ROOT, id, "pages.json", JSON.stringify([{ pageId: "home", url: "http://auth.test/" }, { pageId: "about", url: "http://auth.test/about" }]));
  } finally {
    db.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  await page.goto(`${base}/p/${id}`);
  const banner = page.locator('[data-ui="ui_progress_auth_banner"]');
  expect(await banner.locator(".banner-text").innerText()).toBe("Trang http://auth.test/ cần đăng nhập — Mở cửa sổ để đăng nhập, rồi bấm Tiếp tục");
  expect(await banner.getByRole("button", { name: "Mở cửa sổ" }).count()).toBe(1);
  expect(await banner.getByRole("button", { name: "Tiếp tục" }).count()).toBe(1);
  const steps = page.locator('[data-ui="ui_progress_phase_stepper"] li');
  expect(await steps.locator(".step-name").allInnerTexts()).toEqual(PHASE_NAMES);
  expect(await steps.nth(1).getAttribute("data-state")).toBe("error");
  const list = page.locator('[data-ui="ui_progress_page_list"]');
  expect(await list.innerText()).toMatch(/\/\s*cần đăng nhập[\s\S]*\/about\s*chờ/);
  expect(await page.locator('[data-ui="ui_progress_page_counts"]').innerText()).toContain("0 xong • 0 đang chạy • 1 cần đăng nhập • 0 lỗi • 1 chờ");
  await expectUi(page, ["ui_progress_page_header", "ui_progress_context_bar", "ui_progress_stats_bar", "ui_progress_controls", "ui_progress_log_stream", "ui_progress_log_level_filter", "ui_progress_log_toggles", "ui_progress_session_tools"]);
  await expectNoDrift(page);
  await expectIconButtonsLabelled(page);
  await parityShot(page, "progress-needs-auth");
  expect(foreign).toEqual([]);
  await page.close();
});

test("progress (running): run clock from the server stamps, tokens, page list, log replayed on reload without duplicates, level filter, toggles", async () => {
  const db = openDb(env.DB_PATH);
  const T = Date.now() - 65_000;
  let id = "";
  try {
    id = seedProject(db, {
      url: "http://progress.test/",
      status: "running",
      progress: 30,
      mode: "crawl",
      tasks: [
        { phase: "discover", key: "http://progress.test/", status: "done" },
        { phase: "capture", key: "home", status: "done" },
        { phase: "capture", key: "about", status: "running" },
        { phase: "capture", key: "blocked", status: "failed", errorCode: "ROBOTS_DISALLOWED" },
        { phase: "capture", key: "late", status: "pending" },
        { phase: "name", key: "home", status: "done" },
      ],
    });
    await writeWs(env.WORKSPACE_ROOT, id, "pages.json", JSON.stringify(["home", "about", "blocked", "late"].map((p) => ({ pageId: p, url: `http://progress.test/${p === "home" ? "" : p}` }))));
    const past = [
      { type: "status", status: "running", at: T },
      { type: "log", level: "warn", message: "home: slow asset", at: T + 1_000 },
      { type: "task", phase: "capture", key: "home", status: "done", at: T + 2_000 },
    ];
    await writeWs(env.WORKSPACE_ROOT, id, "events.jsonl", past.map((e) => JSON.stringify(e)).join("\n") + "\n");
  } finally {
    db.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  await page.goto(`${base}/p/${id}`);
  const stats = page.locator('[data-ui="ui_progress_stats_bar"]');
  await expect.poll(() => stats.innerText()).toMatch(/00:01:0\d/);
  expect(await stats.innerText()).toContain("0 / 2.000.000");
  const list = page.locator('[data-ui="ui_progress_page_list"]');
  expect(await list.innerText()).toMatch(/\/about\s*đang chạy · capture/);
  expect(await list.innerText()).toMatch(/\/blocked\s*bỏ qua · ROBOTS_DISALLOWED/);
  const counts = page.locator('[data-ui="ui_progress_page_counts"]');
  expect(await counts.innerText()).toContain("1 xong • 1 đang chạy • 0 cần đăng nhập • 1 lỗi • 1 chờ");
  expect(await counts.innerText()).toContain("4 trang");
  expect(await counts.innerText()).toContain("Task đang chạy: [capture] about");
  const log = page.getByRole("log");
  const lines = log.locator('[data-ui="ui_progress_log_line"]');
  await expect.poll(() => lines.count()).toBe(3);
  expect(await lines.nth(1).innerText()).toMatch(/^\[\d\d:\d\d:\d\d\.\d{3}\] \[WARN\] home: slow asset$/);
  expect(await lines.nth(1).getAttribute("class")).toContain("log-warn");
  await parityShot(page, "progress-running");

  // reload: the history replaces the log (no duplicate), the SSE status snapshot does not restart the clock
  await page.reload();
  await expect.poll(() => lines.count()).toBe(3);
  await expect.poll(() => stats.innerText()).toMatch(/00:01:\d\d/);

  const levels = page.getByRole("group", { name: "Mức log" });
  expect(await levels.innerText()).toMatch(/Warn \(1\)[\s\S]*Error \(0\)/);
  await levels.getByRole("button", { name: /Warn/ }).click();
  expect(await lines.count()).toBe(1);
  await levels.getByRole("button", { name: "Tất cả" }).click();
  expect(await lines.count()).toBe(3);
  await page.getByLabel("Xuống dòng").uncheck();
  expect(await log.getAttribute("class")).not.toContain("wrap");
  await page.getByRole("button", { name: "Xóa log đang hiển thị (lịch sử vẫn giữ)" }).click();
  expect(await lines.count()).toBe(0);
  expect(await log.innerText()).toContain("Đang chờ sự kiện…");
  await page.getByRole("searchbox", { name: "Lọc trang" }).fill("BLOCK");
  expect(await list.locator("li").count()).toBe(1);
  await expectNoDrift(page);
  expect(foreign).toEqual([]);
  await page.close();
});
```
Update the existing tests:
- "new: crawl the site3 fixture…": replace the stepper assertion with
  `await expect.poll(() => page.locator('[data-ui="ui_progress_phase_stepper"] li').first().getAttribute("data-state")).toBe("done");` and add `expect(await page.getByRole("searchbox", { name: "Lọc trang" }).getAttribute("placeholder")).toBe("Lọc 0 trang…");` (a draft has no pages.json yet).
- "progress: after LOGIN_FAILED…": `form.getByLabel("Mật khẩu")` → `form.getByLabel("Mật khẩu", { exact: true })`, and the first click → `await page.locator('[data-ui="ui_progress_controls"]').getByRole("button", { name: "Tiếp tục" }).click();`.

In `tests/e2e/editor-smoke.test.ts` (it owns the completed site1 clone): make the seed flush the event log, and add the completed-progress test as the file's first test.

```ts
// seedCompleted: import the event log with the other core modules (after WORKSPACE_ROOT is set)
  const [{ openDb }, { createProject, enqueue, runProject }, { settled }] = await Promise.all([import("@/core/db"), import("@/core/jobs"), import("@/core/event-log")]);
  // … unchanged …
  await runProject(db, id, { deps: offline });
  await settled(id); // the run's events are on disk: the app process replays them
  return id;
```

```ts
import { parityShot } from "./parity-shots";

test("progress (completed): the finished run's log is replayed from disk by the app; every phase done; run clock shown", async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${app!.base}/p/${projectId}`);
  const lines = page.locator('[data-ui="ui_progress_log_line"]');
  await expect.poll(() => lines.count(), { timeout: 30_000 }).toBeGreaterThan(5);
  expect(await page.getByRole("log").innerText()).toContain("trạng thái → completed");
  const states = await page.locator('[data-ui="ui_progress_phase_stepper"] li').evaluateAll((els) => els.map((e) => e.getAttribute("data-state")));
  expect(new Set(states)).toEqual(new Set(["done"]));
  expect(await page.locator('[data-ui="ui_progress_stats_bar"]').innerText()).toMatch(/\d\d:\d\d:\d\d/);
  await parityShot(page, "progress-completed");
  await page.close();
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts tests/e2e/editor-smoke.test.ts -t "progress|new: crawl"` → FAIL.

- [ ] **Step 7: Stepper** — `src/app/p/[id]/phase-stepper.tsx`: keep `PHASES`, `stateOf`, `phaseStates`, `TaskLike`, `LABEL`; replace `PhaseStepper` and add the icon map:

```tsx
import { Icon, type IconName } from "@/app/_ui/Icon";

const ICON: Record<Phase, IconName> = {
  discover: "radar",
  capture: "photo_camera",
  assets: "image",
  ir: "schema",
  name: "badge",
  emit: "code",
  qa: "difference",
  fix: "auto_fix_high",
  done: "task_alt",
};

export function PhaseStepper({ states }: { states: Record<Phase, StepState> }) {
  return (
    <ol className="stepper-x" aria-label="Các pha" data-ui="ui_progress_phase_stepper">
      {PHASES.map((p) => {
        const s = states[p];
        return (
          <li key={p} className={`step step-${s}`} data-state={s} aria-current={s === "active" ? "step" : undefined} title={LABEL[s]}>
            <span className="step-icon">
              <Icon name={s === "done" ? "check" : s === "error" ? "error" : ICON[p]} />
              {s === "active" && <span className="dot ping step-dot" aria-hidden="true" />}
            </span>
            <span className="step-name t-label-md">{p}</span>
          </li>
        );
      })}
    </ol>
  );
}
```

- [ ] **Step 8: Server page** — `src/app/p/[id]/page.tsx` (whole file)

```tsx
import type { ProjectConfig } from "@/core/jobs-base";
import { getDb } from "@/app/_server/db";
import { authUrl } from "@/app/_server/http";
import { needsCredentials } from "@/app/_server/credentials";
import { Disclosure } from "@/app/_ui/Disclosure";
import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { loadProject, readWorkspaceJson } from "./data";
import type { PageRef, TaskView } from "./page-states";
import { ProgressView } from "./progress-view";
import { SessionTools } from "./session-tools";

const MAX_TASKS = 2_000; // pages (<=100) x phases + fix tasks per failing section: far above any real run
const MAX_PAGES = 100; // spec §1 crawl ceiling

export default async function ProgressPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = loadProject(id);
  const cfg = JSON.parse(project.config_json) as ProjectConfig;
  // node:sqlite rows have a null prototype, which can't cross into a client component: copy to plain objects
  const tasks = (
    getDb().prepare("SELECT phase,key,status,error_code AS errorCode FROM tasks WHERE project_id=? ORDER BY rowid LIMIT ?").all(id, MAX_TASKS) as TaskView[]
  ).map((t) => ({ ...t }));
  const pages = (await readWorkspaceJson<PageRef[]>(id, "pages.json", [])).slice(0, MAX_PAGES).map((p) => ({ pageId: p.pageId, url: p.url }));
  const auth = project.status === "needs_auth" ? await authUrl(getDb(), project) : null;
  return (
    <>
      <PageHeader data-ui="ui_progress_page_header" crumbs={projectCrumbs(project.url, id, "Tiến độ")} title="Tiến độ clone" />
      <ProgressView
        projectId={id}
        url={project.url}
        initial={{
          status: project.status,
          progress: project.progress,
          tasks,
          authUrl: auth,
          needsCredentials: needsCredentials(getDb(), id),
          pages,
          tokensUsed: project.tokens_used,
          tokenBudget: cfg.tokenBudget,
        }}
      />
      <Disclosure summary="Phiên đăng nhập" className="section-gap" data-ui="ui_progress_session_tools">
        <SessionTools projectId={id} />
      </Disclosure>
    </>
  );
}
```

- [ ] **Step 9: Rewrite `src/app/p/[id]/progress-view.tsx`**

```tsx
"use client";
import { useEffect, useRef, useState, type FormEvent, type UIEvent } from "react";
import type { StampedEvent } from "@/core/jobs-base";
import { RESUMABLE_STATUSES } from "@/core/statuses";
import { api, errorText } from "@/app/_ui/api";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { Field } from "@/app/_ui/Field";
import { IconButton } from "@/app/_ui/IconButton";
import { LogView, type LogLine } from "@/app/_ui/LogView";
import { PasswordInput } from "@/app/_ui/PasswordInput";
import { SearchInput } from "@/app/_ui/SearchInput";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { StatTile } from "@/app/_ui/StatTile";
import { StatusPill } from "@/app/_ui/StatusPill";
import { UrlChip } from "@/app/_ui/UrlChip";
import { fmtDuration, fmtInt } from "@/app/_ui/format";
import { describe, pageStates, runSpan, spanAfter, stateLabel, type PageRef, type RunSpan, type TaskView } from "./page-states";
import { PhaseStepper, phaseStates } from "./phase-stepper";

export type { TaskView };
type Initial = { status: string; progress: number; tasks: TaskView[]; authUrl: string | null; needsCredentials: boolean; pages: PageRef[]; tokensUsed: number; tokenBudget: number };
type Level = "all" | LogLine["level"];
type Message = StampedEvent | { type: "history"; events: StampedEvent[] };

const MAX_LOG = 2_000; // lines kept on the client (the server replays at most 2000)
const MAX_RUNNING_SHOWN = 3;
const taskKey = (t: { phase: string; key: string }) => `${t.phase}:${t.key}`;

export function ProgressView({ projectId, url, initial }: { projectId: string; url: string; initial: Initial }) {
  const [status, setStatus] = useState(initial.status);
  const [progress, setProgress] = useState(initial.progress);
  const [tokensUsed, setTokensUsed] = useState(initial.tokensUsed);
  const [tasks, setTasks] = useState(() => new Map(initial.tasks.map((t) => [taskKey(t), t])));
  const [authUrl, setAuthUrl] = useState(initial.authUrl);
  const [log, setLog] = useState<LogLine[]>([]);
  const [span, setSpan] = useState<RunSpan>({ start: null, end: null });
  const [now, setNow] = useState(() => Date.now());
  const [level, setLevel] = useState<Level>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [pageQuery, setPageQuery] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [needsCreds, setNeedsCreds] = useState(initial.needsCredentials);
  const [queued, setQueued] = useState(false); // set by the SSE's snapshot and by resume responses
  const [askFor, setAskFor] = useState<string | null>(null); // resume / auth/continue waiting for credentials
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let n = 0;
    const lineOf = (e: StampedEvent): LogLine[] => {
      const d = describe(e);
      return d ? [{ ...d, at: e.at, n: n++ }] : [];
    };
    const es = new EventSource(`/api/projects/${projectId}/events`);
    es.onmessage = (m: MessageEvent<string>) => {
      const ev = JSON.parse(m.data) as Message;
      if (ev.type === "history") {
        // the persisted tail REPLACES the log (a reconnect never duplicates lines); task/status state stays SSR + live
        setLog(ev.events.flatMap(lineOf).slice(-MAX_LOG));
        setSpan(runSpan(ev.events));
        return;
      }
      if (ev.type === "status") {
        setStatus(ev.status);
        setQueued(ev.queued ?? false); // any status the job itself emits means it left the queue
        if (ev.queued !== undefined) return; // the SSE's snapshot of the current status: not a transition, not a log line
        setSpan((s) => spanAfter(s, ev));
      }
      if (ev.type === "progress") {
        setProgress(ev.progress);
        setTokensUsed(ev.tokensUsed);
      }
      if (ev.type === "needs_auth") setAuthUrl(ev.url);
      if (ev.type === "task" && ev.phase === "login" && ev.errorCode === "LOGIN_FAILED") setNeedsCreds(true);
      if (ev.type === "task") setTasks((prev) => new Map(prev).set(taskKey(ev), { phase: ev.phase, key: ev.key, status: ev.status, errorCode: ev.errorCode ?? null }));
      const line = lineOf(ev);
      if (line.length) setLog((prev) => [...prev.slice(-(MAX_LOG - 1)), ...line]);
    };
    return () => es.close();
  }, [projectId]);

  useEffect(() => {
    if (status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [status]);

  useEffect(() => {
    if (autoScroll) logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log, autoScroll, level, wrap]);

  // scrolling up turns auto-scroll off; the checkbox turns it back on
  const onLogScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (autoScroll && el.scrollHeight - el.scrollTop - el.clientHeight > 24) setAutoScroll(false);
  };

  const call = async (path: string, body?: unknown) => {
    setBusy(true);
    setMsg("");
    try {
      const r = await api<{ queued?: boolean }>(`/api/projects/${projectId}/${path}`, body === undefined ? { method: "POST" } : { body });
      if (r.queued) setQueued(true);
      return true;
    } catch (e) {
      setMsg(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Resume paths: auth mode auto without usable credentials asks for them first (spec §3).
  const resume = (path: string) => (needsCreds ? setAskFor(path) : void call(path));
  const submitCreds = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const credentials = { user: String(f.get("user")), pass: String(f.get("pass")), remember: f.get("remember") === "on" };
    if (askFor && (await call(askFor, { credentials }))) {
      setAskFor(null);
      setNeedsCreds(false);
    }
  };

  const all = [...tasks.values()];
  const running = all.filter((t) => t.status === "running");
  const states = pageStates(all, initial.pages);
  const pq = pageQuery.trim().toLowerCase();
  const shownPages = pq ? states.filter((p) => p.path.toLowerCase().includes(pq)) : states;
  const count = (...s: string[]) => states.filter((p) => s.includes(p.state)).length;
  const elapsedMs = span.start === null ? null : span.end !== null ? span.end - span.start : status === "running" ? now - span.start : null;
  const shownLines = level === "all" ? log : log.filter((l) => l.level === level);
  const warnN = log.filter((l) => l.level === "warn").length;
  const errorN = log.filter((l) => l.level === "error").length;

  return (
    <div className="stack progress-screen">
      <div className="context-bar" data-ui="ui_progress_context_bar">
        <span className="t-label-md text-3">Trang gốc:</span>
        <UrlChip url={url} openable />
        <StatusPill status={status} queued={queued} />
        <span className="t-label-md">{progress}%</span>
        <div className="context-stats" data-ui="ui_progress_stats_bar">
          <StatTile label="Thời gian chạy" value={elapsedMs === null ? "—" : fmtDuration(elapsedMs)} />
          <StatTile label="Token đã dùng" value={`${fmtInt(tokensUsed)} / ${fmtInt(initial.tokenBudget)}`} tone={tokensUsed >= 0.9 * initial.tokenBudget ? "warn" : undefined} />
        </div>
        <div className="context-controls" data-ui="ui_progress_controls">
          {status === "running" && (
            <Button icon="pause" disabled={busy} onClick={() => void call("pause")}>
              Tạm dừng
            </Button>
          )}
          {/* needs_auth resumes from its own banner (auth/continue) */}
          {RESUMABLE_STATUSES.includes(status) && status !== "needs_auth" && (
            <Button variant="primary" icon="play_arrow" disabled={busy} onClick={() => resume("resume")}>
              Tiếp tục
            </Button>
          )}
        </div>
      </div>

      <PhaseStepper states={phaseStates(all, status)} />

      {status === "needs_auth" && (
        <Banner
          data-ui="ui_progress_auth_banner"
          tone="warn"
          icon="warning"
          actions={
            <>
              <Button icon="open_in_new" disabled={busy} onClick={() => void call("auth/open")}>
                Mở cửa sổ
              </Button>
              <Button variant="warn" icon="play_arrow" disabled={busy} onClick={() => resume("auth/continue")}>
                Tiếp tục
              </Button>
            </>
          }
        >
          Trang <code className="inline-chip">{authUrl ?? url}</code> cần đăng nhập — Mở cửa sổ để đăng nhập, rồi bấm Tiếp tục
        </Banner>
      )}
      {askFor && (
        <Card data-ui="ui_progress_credentials_form" title="Đăng nhập lại">
          <form className="stack" aria-label="Đăng nhập lại" onSubmit={(e) => void submitCreds(e)}>
            <span className="text-2">Cần tài khoản để đăng nhập tự động (lần đăng nhập trước thất bại hoặc chưa có tài khoản).</span>
            <div className="creds-grid">
              <Field label="Tài khoản">
                <input name="user" required autoComplete="off" />
              </Field>
              <PasswordInput label="Mật khẩu" name="pass" required />
              <label className="check">
                <input name="remember" type="checkbox" />
                Ghi nhớ
              </label>
            </div>
            <div className="row">
              <Button type="submit" variant="primary" disabled={busy}>
                Tiếp tục với tài khoản này
              </Button>
              <Button onClick={() => setAskFor(null)}>Hủy</Button>
            </div>
          </form>
        </Card>
      )}
      {msg && (
        <Banner tone="danger" icon="error">
          {msg}
        </Banner>
      )}

      <div className="progress-grid">
        <section className="panel pane" aria-label="Trang" data-ui="ui_progress_page_list">
          <div className="pane-toolbar">
            <SearchInput label="Lọc trang" placeholder={`Lọc ${initial.pages.length} trang…`} value={pageQuery} onChange={setPageQuery} />
          </div>
          <ul className="page-states">
            {shownPages.map((p) => (
              <li key={p.pageId} className={`page-state state-${p.state}`}>
                <span className={`dot${p.state === "running" ? " ping" : ""}`} aria-hidden="true" />
                <span className="mono page-path" title={p.path}>
                  {p.path}
                </span>
                <span className="t-label-sm page-label">{stateLabel(p)}</span>
              </li>
            ))}
          </ul>
          <div className="pane-foot t-label-sm" data-ui="ui_progress_page_counts">
            <div className="row spread">
              <span>
                {count("done")} xong • {count("running")} đang chạy • {count("needs_auth")} cần đăng nhập • {count("failed", "skipped")} lỗi • {count("pending")} chờ
              </span>
              <span>{states.length} trang</span>
            </div>
            {running.length > 0 && (
              <div className="text-2">
                Task đang chạy:{" "}
                {running
                  .slice(0, MAX_RUNNING_SHOWN)
                  .map((t) => `[${t.phase}] ${t.key}`)
                  .join(", ")}
                {running.length > MAX_RUNNING_SHOWN && ` +${running.length - MAX_RUNNING_SHOWN}`}
              </div>
            )}
          </div>
        </section>

        <section className="panel pane" aria-label="Log" data-ui="ui_progress_log_stream">
          <div className="pane-toolbar">
            <h2 className="t-label-md upper">Log</h2>
            <SegmentedControl<Level>
              data-ui="ui_progress_log_level_filter"
              label="Mức log"
              value={level}
              onChange={setLevel}
              options={[
                { value: "all", label: "Tất cả" },
                { value: "info", label: "Info" },
                { value: "warn", label: `Warn (${warnN})` },
                { value: "error", label: `Error (${errorN})` },
              ]}
            />
            <div className="log-toggles" data-ui="ui_progress_log_toggles">
              <label className="check">
                <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
                Tự cuộn
              </label>
              <label className="check">
                <input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} />
                Xuống dòng
              </label>
              <IconButton icon="block" label="Xóa log đang hiển thị (lịch sử vẫn giữ)" onClick={() => setLog([])} />
            </div>
          </div>
          <LogView ref={logRef} lines={shownLines} wrap={wrap} empty="Đang chờ sự kiện…" onScroll={onLogScroll} lineUi="ui_progress_log_line" />
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 10: CSS** — delete `/* legacy: progress */` and append:

```css
/* === Screen: progress === */
.context-bar { display: flex; align-items: center; gap: var(--s-md); flex-wrap: wrap; padding-bottom: var(--s-md); border-bottom: 1px solid var(--c-border); }
.context-stats { display: flex; gap: var(--s-sm); margin-left: auto; }
.context-controls { display: flex; gap: var(--s-sm); }
.stepper-x { list-style: none; margin: 0; padding: 0; display: flex; align-items: center; gap: 0; overflow-x: auto; }
.step { display: flex; align-items: center; gap: 6px; padding: 6px 10px; color: var(--c-text-3); white-space: nowrap; }
.step + .step::before { content: ""; width: 20px; height: 1px; margin-right: 10px; background: var(--c-border); }
.step-done + .step::before { background: var(--c-primary); }
.step-icon { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--r-full); border: 1px solid var(--c-border); background: var(--c-surface-low); }
.step-done { color: var(--c-success); }
.step-done .step-icon { border-color: color-mix(in srgb, var(--c-success) 30%, transparent); background: color-mix(in srgb, var(--c-success) 10%, transparent); }
.step-active { color: var(--c-primary); }
.step-active .step-icon { border-color: var(--c-primary); }
.step-dot { position: absolute; top: -2px; right: -2px; color: var(--c-primary); }
.step-error { color: var(--c-danger); }
.step-error .step-icon { border-color: color-mix(in srgb, var(--c-danger) 30%, transparent); }
.inline-chip { padding: 1px 6px; border-radius: var(--r-sm); background: var(--c-surface-lowest); border: 1px solid var(--c-border); }
/* ponytail: the fixed top area (~400px) is an estimate, not measured; measure it if the stepper/banners grow */
.progress-grid { display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: var(--s-lg); height: max(480px, calc(100vh - 400px)); }
.pane { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.pane-toolbar { display: flex; align-items: center; gap: var(--s-sm); flex-wrap: wrap; padding: var(--s-sm) var(--s-md); border-bottom: 1px solid var(--c-border); }
.pane-toolbar .search-input { flex: 1; min-width: 0; }
.pane .log-view { flex: 1; min-height: 0; }
.log-toggles { display: flex; align-items: center; gap: var(--s-md); margin-left: auto; }
.page-states { list-style: none; margin: 0; padding: var(--s-xs) 0; flex: 1; overflow-y: auto; }
.page-state { display: flex; align-items: center; gap: var(--s-sm); padding: 6px var(--s-md); }
.page-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state-done { color: var(--c-success); }
.state-running { color: var(--c-primary); }
.state-needs_auth { color: var(--c-warn); }
.state-failed { color: var(--c-danger); }
.state-skipped, .state-pending { color: var(--c-text-3); }
.page-state .page-path { color: var(--c-text); }
.pane-foot { display: grid; gap: 4px; padding: var(--s-sm) var(--s-md); border-top: 1px solid var(--c-border); color: var(--c-text-2); }
```

- [ ] **Step 11: Run to verify pass**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/ui-smoke.test.ts` → PASS (all smoke tests).
Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/editor-smoke.test.ts` → PASS.

- [ ] **Step 12: Parity screenshots** — rerun with `PARITY_DIR`; compare `progress-running.png` and `progress-needs-auth.png` with `docs/superpowers/design/stitch/progress.png` (context bar with URL chip + pill + stats, 9-step stepper with connectors/active ping, warn banner with icon tile, 2 panes: page list + counts footer, log with level filter/toggles and `[time] [LEVEL]` lines, warn line tinted). Report differences.

- [ ] **Step 13: Typecheck + unit + build** — `npx tsc --noEmit && npx vitest run` + build check.

- [ ] **Step 14: Commit**

```bash
git add "src/app/p/[id]/page-states.ts" "src/app/p/[id]/page.tsx" "src/app/p/[id]/progress-view.tsx" "src/app/p/[id]/phase-stepper.tsx" src/app/globals.css tests/unit/page-states.test.ts tests/e2e/ui-smoke.test.ts tests/e2e/editor-smoke.test.ts
git commit -m "feat(ui): progress to Stitch parity (context bar + stats, icon stepper, page list, durable log with filters)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 12: Screen `/p/[id]/preview` — `screen_qa_preview` (spec §3.6, D3, D6)

**Files:**
- Create: `src/app/p/[id]/preview/preview-model.ts`, `tests/unit/preview-model.test.ts`
- Modify: `src/app/p/[id]/preview/page.tsx`, `src/app/p/[id]/preview/preview-view.tsx` (rewrite), `src/app/globals.css` (preview CSS; delete `/* legacy: preview */`), `tests/e2e/editor-smoke.test.ts`

**Interfaces:**
- Consumes: `GET …/preview` with `fixes` (Task 6), `POST …/qa/rescore` (Task 4), SSE status events (Task 3), Task 2 components, `fmtPct`.
- Produces (`preview-model.ts`, pure): `type Fix = { pageId: string; sectionId: string; status: TaskStatus; errorCode: string | null }`, `fixText(fix?: Fix): string`, `checklistLabel(kind: string, trigger: string): string`, `meanScore(scores: { score: number }[]): number | null`.

Elements (18): `ui_qa_preview_page_header`, `…_page_select`, `…_breakpoint_switch`, `…_compare_modes`, `…_overlay_slider`, `…_heatmap_toggle`, `…_match_score`, `…_rerun_qa`, `…_export_button`, `…_side_by_side_panes`, `…_sync_scroll` (the one shared scroll container — no toggle is rendered), `…_rail_tabs`, `…_summary`, `…_section_scores`, `…_fix_request`, `…_next_diff`, `…_coverage_checklist`, `…_skipped_item`. Not rendered: DOM Delta, Auto-reconcile CSS, Approve & Deploy, "Pixel QA 1 Diff", "#8942", DPR, PUPPETEER/VITE/TAILWIND JIT, diagnostic numbers, "Ignore", "card-hero.tsx", "Synthesis/verified/untriggered", "Chồng lớp".

- [ ] **Step 0: Trace in the graph** — `/graphify explain screen_qa_preview`; `/graphify path "feat_qa_score" "screen_qa_preview"`; confirm `drift_qa_preview_*` absent; D3 = score only, never the fix loop.

- [ ] **Step 1: Write the failing unit test** — `tests/unit/preview-model.test.ts`

```ts
import { expect, test } from "vitest";
import { checklistLabel, fixText, meanScore, type Fix } from "@/app/p/[id]/preview/preview-model";

const fix = (status: Fix["status"], errorCode: string | null = null): Fix => ({ pageId: "home", sectionId: "s", status, errorCode });

test("fix card text from the fix task", () => {
  expect(fixText(undefined)).toBe("Chưa qua vòng sửa tự động.");
  expect(fixText(fix("pending"))).toBe("Đang sửa…");
  expect(fixText(fix("running"))).toBe("Đang sửa…");
  expect(fixText(fix("failed", "AI_AUTH"))).toBe("Vòng sửa lỗi: AI_AUTH.");
  expect(fixText(fix("done", "BUDGET_EXCEEDED"))).toBe("Dừng sửa: hết ngân sách token.");
  expect(fixText(fix("done"))).toBe("Đã chạy vòng sửa tự động (tối đa 3 vòng), vẫn dưới ngưỡng.");
});

test("checklist labels are deterministic from kind + trigger (no AI), trigger cut at 60 chars", () => {
  expect(checklistLabel("menu", "nav > li:nth-child(2) > a")).toBe("Menu thả xuống · nav > li:nth-child(2) > a");
  expect(checklistLabel("sticky", "header")).toBe("Sticky/cuộn · header");
  const long = checklistLabel("hover", `button.${"x".repeat(100)}`);
  expect(long.startsWith("Hover · button.")).toBe(true);
  expect(long.length).toBe("Hover · ".length + 60);
  expect(long.endsWith("…")).toBe(true);
  expect(["hover", "menu", "tab", "accordion", "modal", "carousel", "sticky", "form"].map((k) => checklistLabel(k, "t").split(" · ")[0])).toEqual([
    "Hover", "Menu thả xuống", "Tab", "Accordion", "Modal", "Carousel", "Sticky/cuộn", "Form",
  ]);
});

test("D6: the overall match is the mean of the page × breakpoint section scores", () => {
  expect(meanScore([])).toBeNull();
  expect(meanScore([{ score: 1 }, { score: 0.9 }, { score: 0.986 }])).toBeCloseTo(0.962, 6);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run tests/unit/preview-model.test.ts` → FAIL.

- [ ] **Step 3: Write `src/app/p/[id]/preview/preview-model.ts`**

```ts
// Preview & QA screen model (spec parity §3.6). Pure, client-safe.
import type { TaskStatus } from "@/core/jobs-base";

export type Fix = { pageId: string; sectionId: string; status: TaskStatus; errorCode: string | null };

// The "cần sửa" card: what the automatic fix loop did for this section (no diagnostic numbers).
export function fixText(fix: Fix | undefined): string {
  if (!fix) return "Chưa qua vòng sửa tự động.";
  if (fix.status === "pending" || fix.status === "running") return "Đang sửa…";
  if (fix.status !== "done") return `Vòng sửa lỗi: ${fix.errorCode ?? fix.status}.`;
  if (fix.errorCode === "BUDGET_EXCEEDED") return "Dừng sửa: hết ngân sách token.";
  return "Đã chạy vòng sửa tự động (tối đa 3 vòng), vẫn dưới ngưỡng.";
}

const KIND: Record<string, string> = {
  hover: "Hover",
  menu: "Menu thả xuống",
  tab: "Tab",
  accordion: "Accordion",
  modal: "Modal",
  carousel: "Carousel",
  sticky: "Sticky/cuộn",
  form: "Form",
};
const MAX_TRIGGER = 60;

export function checklistLabel(kind: string, trigger: string): string {
  const t = trigger.replace(/\s+/g, " ").trim();
  return `${KIND[kind] ?? kind} · ${t.length > MAX_TRIGGER ? `${t.slice(0, MAX_TRIGGER - 1)}…` : t}`;
}

// D6: the overall "khớp" = mean of the section scores; the pass gate stays per section (spec SP1 §9).
export const meanScore = (scores: { score: number }[]): number | null => (scores.length ? scores.reduce((a, s) => a + s.score, 0) / scores.length : null);
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run tests/unit/preview-model.test.ts` → PASS.

- [ ] **Step 5: Write the failing smoke tests** — in `tests/e2e/editor-smoke.test.ts` add imports `import { readFile, writeFile } from "node:fs/promises"; import { fmtPct } from "@/app/_ui/format"; import { expectIconButtonsLabelled, expectNoDrift, expectUi, trackForeignRequests } from "./ui-checks";` (`mkdtemp`, `rm` stay) and a module-level `let workspaceRoot = "";` set in `beforeAll` (`workspaceRoot = env.WORKSPACE_ROOT;`). Insert after the completed-progress test (before the editor test):

```ts
type PreviewData = { pages: { pageId: string }[]; scores: { pageId: string; sectionId: string; bp: number; score: number; heatPath: string | null }[]; stale: boolean };

test("preview: toolbar, mean match, panes fill the area, onion/swipe, heatmap overlay, fix card → editor, next diff, checklist", async () => {
  const base = app!.base;
  // force one failing section (all 3 breakpoints) so the "cần sửa" card is deterministic
  const qaPath = join(workspaceRoot, projectId, "qa.json");
  const qa = JSON.parse(await readFile(qaPath, "utf8")) as { scores: PreviewData["scores"] };
  const forced = qa.scores.find((s) => s.pageId === "home")!.sectionId;
  for (const s of qa.scores) if (s.sectionId === forced) s.score = 0.5;
  await writeFile(qaPath, JSON.stringify(qa));

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const foreign = trackForeignRequests(page);
  await page.goto(`${base}/p/${projectId}/preview`);
  await expectUi(page, ["ui_qa_preview_page_header", "ui_qa_preview_page_select", "ui_qa_preview_breakpoint_switch", "ui_qa_preview_compare_modes", "ui_qa_preview_heatmap_toggle", "ui_qa_preview_match_score", "ui_qa_preview_export_button", "ui_qa_preview_side_by_side_panes", "ui_qa_preview_sync_scroll", "ui_qa_preview_rail_tabs", "ui_qa_preview_summary", "ui_qa_preview_section_scores", "ui_qa_preview_fix_request", "ui_qa_preview_next_diff"]);
  const data = (await (await fetch(`${base}/api/projects/${projectId}/preview`)).json()) as PreviewData;
  const at1440 = data.scores.filter((s) => s.pageId === "home" && s.bp === 1440);
  const mean = at1440.reduce((a, s) => a + s.score, 0) / at1440.length;
  expect(await page.locator('[data-ui="ui_qa_preview_match_score"]').innerText()).toBe(`${fmtPct(mean)} khớp`);
  expect(await page.locator('[data-ui="ui_qa_preview_match_score"]').getAttribute("class")).toContain("tone-danger"); // one section below the gate
  expect(await page.locator('[data-ui="ui_qa_preview_summary"]').innerText()).toMatch(/\d+ đạt • [1-9]\d* cần sửa · ngưỡng 95,0%/);
  expect(await page.getByRole("tablist", { name: "Bảng bên" }).getByRole("tab", { name: `Section (${at1440.length})` }).count()).toBe(1);

  // panes share the compare area: no dead space at 1440; >= 500px each at 1920
  const area = (await page.locator('[data-ui="ui_qa_preview_sync_scroll"]').boundingBox())!;
  const panes = page.locator('[data-ui="ui_qa_preview_side_by_side_panes"] .pane');
  await expect.poll(async () => (await panes.first().boundingBox())!.width * 2 + 12).toBeGreaterThan(area.width - 24 - 4);
  expect(await panes.first().locator(".pane-head").innerText()).toMatch(/^Gốc · 1440 × \d+px$/);
  expect(await panes.nth(1).locator(".pane-head").innerText()).toMatch(/^Clone · 1440 × \d+px$/);
  await parityShot(page, "preview-side");
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect.poll(async () => (await panes.first().boundingBox())!.width).toBeGreaterThanOrEqual(500);
  await page.setViewportSize({ width: 1440, height: 900 });

  const modes = page.getByRole("group", { name: "Chế độ so sánh" });
  await modes.getByRole("button", { name: "Chồng mờ" }).click();
  expect(await page.locator('[data-ui="ui_qa_preview_overlay_slider"]').innerText()).toContain("Độ trong 50%");
  expect(await page.locator(".clone-frame").evaluate((el) => (el as HTMLElement).style.opacity)).toBe("0.5");
  await parityShot(page, "preview-onion");
  await modes.getByRole("button", { name: "Trượt so sánh" }).click();
  expect(await page.locator('[data-ui="ui_qa_preview_overlay_slider"]').innerText()).toContain("Vị trí 50%");
  expect(await page.locator("body").innerText()).not.toContain("Chồng lớp");
  await modes.getByRole("button", { name: "Cạnh nhau" }).click();
  expect(await page.locator('[data-ui="ui_qa_preview_overlay_slider"]').count()).toBe(0);

  const heat = page.getByRole("button", { name: "Heatmap" });
  await heat.click();
  expect(await heat.getAttribute("aria-pressed")).toBe("true");
  await expect.poll(() => page.locator(".heat-overlay").count()).toBeGreaterThan(0);
  expect(await page.locator(".heat-overlay").count()).toBeLessThanOrEqual(at1440.filter((s) => s.heatPath).length);

  const card = page.locator('[data-ui="ui_qa_preview_fix_request"]').first();
  expect(await card.getByRole("link", { name: "Sửa trong editor" }).getAttribute("href")).toBe(`/p/${projectId}/editor?page=home`);
  await page.getByRole("button", { name: "Section chưa đạt tiếp theo" }).click();
  expect(await page.locator('[data-ui="ui_qa_preview_section_scores"] li[data-marked]').count()).toBe(1);
  expect(await page.getByRole("link", { name: "Xuất mã" }).getAttribute("href")).toBe(`/p/${projectId}/code`);

  await page.getByRole("tablist", { name: "Bảng bên" }).getByRole("tab", { name: /Checklist độ phủ/ }).click();
  expect(await page.locator('[data-ui="ui_qa_preview_coverage_checklist"]').innerText()).toMatch(/CHECKLIST ĐỘ PHỦ[\s\S]*\d+\/\d+ đã chụp/);
  await parityShot(page, "preview-checklist");
  await expectNoDrift(page);
  await expectIconButtonsLabelled(page);
  expect(foreign).toEqual([]);
  await page.close();
});
```
and append as the file's **last** test (after "editor API: only completed projects are editable…", which must end with status `completed`):

```ts
test("preview: after an editor save, 'Chạy lại QA' re-scores through the queue (one POST even on double click); the banner goes away", async () => {
  const base = app!.base;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/qa/rescore")) posts.push(r.method());
  });
  await page.goto(`${base}/p/${projectId}/preview`);
  const banner = page.locator('[data-ui="ui_qa_preview_rerun_qa"]');
  await expect.poll(() => banner.innerText()).toContain("Điểm QA chưa cập nhật sau chỉnh sửa.");
  await banner.getByRole("button", { name: "Chạy lại QA" }).dblclick();
  await expect.poll(() => banner.count(), { timeout: 180_000 }).toBe(0);
  expect(posts).toEqual(["POST"]);
  const after = (await (await fetch(`${base}/api/projects/${projectId}/preview`)).json()) as PreviewData;
  expect(after.stale).toBe(false);
  await page.close();
});
```

- [ ] **Step 6: Run to verify failure** — `npx vitest run -c vitest.e2e.config.ts tests/e2e/editor-smoke.test.ts` → FAIL (no `ui_qa_preview_*`).

- [ ] **Step 7: Server page** — `src/app/p/[id]/preview/page.tsx` (whole file)

```tsx
import type { ProjectConfig } from "@/core/jobs-base";
import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { loadProject } from "../data";
import { PreviewView } from "./preview-view";

export default async function PreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const project = loadProject(id);
  const { threshold } = JSON.parse(project.config_json) as ProjectConfig;
  return (
    <>
      <PageHeader data-ui="ui_qa_preview_page_header" crumbs={projectCrumbs(project.url, id, "Preview & QA")} title="Preview & QA" />
      <PreviewView projectId={id} threshold={threshold} status={project.status} />
    </>
  );
}
```

- [ ] **Step 8: Rewrite `src/app/p/[id]/preview/preview-view.tsx`**

```tsx
"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Bp, SectionScore } from "@/core/qa";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Banner } from "@/app/_ui/Banner";
import { Button } from "@/app/_ui/Button";
import { GridTable } from "@/app/_ui/GridTable";
import { Icon } from "@/app/_ui/Icon";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";
import { fmtPct } from "@/app/_ui/format";
import { checklistLabel, fixText, meanScore, type Fix } from "./preview-model";

type Data = {
  pages: { pageId: string; path: string; file?: string }[];
  sections: { id: string; pageId: string; name: string; rootId: string }[];
  scores: SectionScore[];
  stale: boolean; // edited in the editor after scoring
  interactions: { id: string; pageId: string; kind: string; trigger: string; status: string }[];
  coverage: { page: string; captured: number; failed: number; skipped: number }[];
  fixes: Fix[];
};
type Mode = "side" | "onion" | "swipe";
type Box = { x: number; y: number; w: number; h: number };
type Rescore = "idle" | "running" | { failed: string };

const BPS: Bp[] = [375, 768, 1440];
const MAX_FRAME_H = 30_000; // a runaway (vh-driven) page can't grow the frame forever
const PANE_GAP = 12;
const AREA_PAD = 24; // compare area padding (12px each side)

export function PreviewView({ projectId, threshold, status }: { projectId: string; threshold: number; status: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState("");
  const [pageId, setPageId] = useState("");
  const [bp, setBp] = useState<Bp>(1440);
  const [mode, setMode] = useState<Mode>("side");
  const [slider, setSlider] = useState(50);
  const [heat, setHeat] = useState(false);
  const [tab, setTab] = useState<"sections" | "checklist">("sections");
  const [frameH, setFrameH] = useState(1000);
  const [origH, setOrigH] = useState(0); // the original shot's natural height (it is bp px wide)
  const [areaW, setAreaW] = useState(0);
  const [boxes, setBoxes] = useState<Record<string, Box>>({});
  const [marked, setMarked] = useState<string | null>(null);
  const [rescore, setRescore] = useState<Rescore>("idle");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const load = useCallback(
    () =>
      api<Data>(`/api/projects/${projectId}/preview`).then(
        (d) => {
          setData(d);
          setPageId((cur) => (d.pages.some((p) => p.pageId === cur) ? cur : (d.pages[0]?.pageId ?? "")));
        },
        (e: unknown) => setMsg(errorText(e)),
      ),
    [projectId],
  );
  useEffect(() => void load(), [load]);
  useEffect(() => () => esRef.current?.close(), []);

  const hasPage = !!data?.pages.some((p) => p.pageId === pageId);
  // the compare area's width drives the scale (no fixed pane width)
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAreaW(el.clientWidth));
    ro.observe(el);
    setAreaW(el.clientWidth);
    return () => ro.disconnect();
  }, [hasPage]);
  useEffect(() => scrollRef.current?.scrollTo({ top: 0 }), [pageId]);

  const fileUrl = (rel: string) => `/api/projects/${projectId}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;
  const page = data?.pages.find((p) => p.pageId === pageId);
  const inner = Math.max(0, areaW - AREA_PAD);
  const scale = areaW === 0 ? Math.min(1, 440 / bp) : Math.min(1, mode === "side" ? (inner - PANE_GAP) / 2 / bp : inner / bp);
  const names = new Map(data?.sections.map((s) => [s.id, s]));
  const pageSections = data?.sections.filter((s) => s.pageId === pageId) ?? [];
  const scores = data?.scores.filter((s) => s.pageId === pageId && s.bp === bp) ?? [];
  const failing = scores.filter((s) => s.score < threshold);
  const mean = meanScore(scores);
  const fixes = new Map(data?.fixes.map((f) => [`${f.pageId}:${f.sectionId}`, f]));
  const pageInteractions = data?.interactions.filter((i) => i.pageId === pageId) ?? [];

  // The clone iframe is same-origin (files route): measure its height and each section root's box ([data-ir-id]).
  const measure = () => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    const win = doc?.defaultView;
    if (!frame || !doc || !win) return;
    frame.style.height = "0px"; // measure the content, not the previous frame height
    const h = Math.min(MAX_FRAME_H, Math.max(doc.documentElement.scrollHeight, 200));
    frame.style.height = `${Math.max(h, origH)}px`; // React skips the style write when the height is unchanged
    setFrameH(h);
    const next: Record<string, Box> = {};
    for (const s of pageSections) {
      const el = doc.querySelector(`[data-ir-id="${CSS.escape(s.rootId)}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      next[s.id] = { x: r.left + win.scrollX, y: r.top + win.scrollY, w: r.width, h: r.height };
    }
    setBoxes(next);
  };

  const scrollToSection = (sectionId: string) => {
    const rootId = names.get(sectionId)?.rootId;
    const doc = frameRef.current?.contentDocument;
    const el = rootId && doc?.querySelector(`[data-ir-id="${CSS.escape(rootId)}"]`);
    if (!el || !doc?.defaultView) return;
    const top = el.getBoundingClientRect().top + doc.defaultView.scrollY;
    scrollRef.current?.scrollTo({ top: top * scale, behavior: "smooth" });
  };

  const pick = (sectionId: string) => {
    setMarked(sectionId);
    scrollToSection(sectionId);
  };

  // next section below the gate, wrapping around
  const nextDiff = () => {
    if (failing.length === 0) return;
    const i = failing.findIndex((s) => s.sectionId === marked);
    pick(failing[(i + 1) % failing.length]!.sectionId);
  };

  // D3: POST -> the job queue; follow the SSE until the run leaves `running`, then reload the scores.
  const rerun = async () => {
    setRescore("running");
    try {
      await api(`/api/projects/${projectId}/qa/rescore`, { method: "POST" });
    } catch (e) {
      setRescore({ failed: errorText(e) });
      return;
    }
    esRef.current?.close();
    const es = new EventSource(`/api/projects/${projectId}/events`);
    esRef.current = es;
    es.onmessage = (m: MessageEvent<string>) => {
      const e = JSON.parse(m.data) as { type: string; status?: string; reason?: string; queued?: boolean };
      if (e.type !== "status") return;
      if (e.status === "completed" && !e.queued) {
        es.close();
        setRescore("idle");
        void load();
      } else if (e.status === "failed" || e.status === "paused" || e.status === "interrupted") {
        es.close();
        setRescore({ failed: e.reason ?? e.status });
      }
    };
  };

  if (msg)
    return (
      <Banner tone="danger" icon="error">
        {msg}
      </Banner>
    );
  if (!data) return <p className="text-3">Đang tải…</p>;
  if (!page) return <p className="text-3">Chưa có output — chạy clone trước.</p>;

  const paneH = Math.max(frameH, origH); // the clone is at least as tall as the original shot (its viewport)
  const heatImgs = heat
    ? scores.flatMap((s) => {
        const b = boxes[s.sectionId];
        return s.heatPath && b ? [<img key={s.sectionId} className="heat-overlay" alt="" src={fileUrl(s.heatPath)} style={{ left: b.x * scale, top: b.y * scale, width: b.w * scale, height: b.h * scale }} />] : [];
      })
    : null;
  const cloneFrame = (
    <div className="frame clone-frame" style={{ width: bp * scale, height: paneH * scale, ...(mode === "onion" ? { opacity: slider / 100 } : {}) }}>
      {page.file && (
        <iframe
          key={`${page.file}-${bp}`}
          ref={frameRef}
          title="Bản clone"
          src={fileUrl(`out/${page.file}`)}
          onLoad={measure}
          style={{ width: bp, height: paneH, transform: `scale(${scale})` }}
        />
      )}
      {heatImgs}
    </div>
  );
  const original = (
    <img className="orig-shot" alt="Bản gốc" src={fileUrl(`pages/${pageId}/shots/${bp}.png`)} onLoad={(e) => setOrigH(e.currentTarget.naturalHeight)} style={{ width: bp * scale }} />
  );
  const head = (label: string, h: number) => (
    <div className="pane-head mono">
      {label} · {bp} × {Math.round(h)}px
    </div>
  );

  return (
    <div className="stack">
      <div className="qa-toolbar">
        <div className="row">
          <label className="inline-field" data-ui="ui_qa_preview_page_select">
            <span className="field-label">Trang</span>
            <select value={pageId} onChange={(e) => setPageId(e.target.value)}>
              {data.pages.map((p) => (
                <option key={p.pageId} value={p.pageId}>
                  {p.path}
                </option>
              ))}
            </select>
          </label>
          <SegmentedControl
            data-ui="ui_qa_preview_breakpoint_switch"
            label="Breakpoint"
            value={String(bp)}
            onChange={(v) => setBp(Number(v) as Bp)}
            options={BPS.map((b) => ({ value: String(b), label: `${b}px`, icon: b === 375 ? "phone_iphone" : b === 768 ? "tablet_mac" : "desktop_windows" }))}
          />
          <SegmentedControl<Mode>
            data-ui="ui_qa_preview_compare_modes"
            label="Chế độ so sánh"
            value={mode}
            onChange={setMode}
            options={[
              { value: "side", label: "Cạnh nhau", icon: "view_column_2" },
              { value: "onion", label: "Chồng mờ", icon: "opacity" },
              { value: "swipe", label: "Trượt so sánh", icon: "compare" },
            ]}
          />
          {mode !== "side" && (
            <label className="inline-field" data-ui="ui_qa_preview_overlay_slider">
              <span className="t-label-md">
                {mode === "onion" ? "Độ trong" : "Vị trí"} {slider}%
              </span>
              <input type="range" min={0} max={100} value={slider} aria-label={mode === "onion" ? "Độ trong" : "Vị trí"} onChange={(e) => setSlider(e.target.valueAsNumber)} />
            </label>
          )}
        </div>
        <div className="row">
          <Button data-ui="ui_qa_preview_heatmap_toggle" icon="layers" aria-pressed={heat} onClick={() => setHeat((h) => !h)}>
            Heatmap
          </Button>
          {mean !== null && (
            <span
              data-ui="ui_qa_preview_match_score"
              className={`match-chip tint tone-${failing.length === 0 ? "success" : "danger"}`}
              title={`Trung bình ${scores.length} section; cổng đạt tính theo từng section`}
            >
              {fmtPct(mean)} khớp
            </span>
          )}
          <Button data-ui="ui_qa_preview_export_button" icon="download" href={`/p/${projectId}/code`}>
            Xuất mã
          </Button>
        </div>
      </div>

      <div className="qa-body">
        {/* one scroll container for both panes: scrolling always stays in sync (no toggle) */}
        <div className="compare-area" ref={scrollRef} data-ui="ui_qa_preview_sync_scroll">
          {mode === "side" ? (
            <div className="compare-side" style={{ gap: PANE_GAP }} data-ui="ui_qa_preview_side_by_side_panes">
              <div className="pane-col" style={{ width: bp * scale }}>
                <div className="pane">{head("Gốc", origH)}</div>
                {original}
              </div>
              <div className="pane-col" style={{ width: bp * scale }}>
                <div className="pane">{head("Clone", frameH)}</div>
                {cloneFrame}
              </div>
            </div>
          ) : (
            <div className="pane-col" style={{ width: bp * scale }} data-ui="ui_qa_preview_side_by_side_panes">
              <div className="pane">{head(mode === "onion" ? "Gốc + Clone" : "Gốc | Clone", paneH)}</div>
              <div className="compare-overlay">
                {original}
                <div className="overlay-clone" style={mode === "swipe" ? { clipPath: `inset(0 ${100 - slider}% 0 0)` } : undefined}>
                  {cloneFrame}
                </div>
              </div>
            </div>
          )}
        </div>

        <aside className="qa-rail">
          {data.stale && status === "completed" && (
            <Banner
              data-ui="ui_qa_preview_rerun_qa"
              tone="info"
              icon="replay"
              actions={
                <Button variant="primary" icon="replay" disabled={rescore === "running"} onClick={() => void rerun()}>
                  {rescore === "running" ? "Đang chấm lại…" : "Chạy lại QA"}
                </Button>
              }
            >
              Điểm QA chưa cập nhật sau chỉnh sửa.
              {typeof rescore === "object" && (
                <span className="text-danger">
                  {" "}
                  {rescore.failed} — <Link href={`/p/${projectId}`}>Xem tiến độ</Link>
                </span>
              )}
            </Banner>
          )}
          <SegmentedControl<"sections" | "checklist">
            data-ui="ui_qa_preview_rail_tabs"
            semantics="tabs"
            full
            label="Bảng bên"
            value={tab}
            onChange={setTab}
            options={[
              { value: "sections", label: `Section (${scores.length})` },
              { value: "checklist", label: `Checklist độ phủ (${pageInteractions.length})` },
            ]}
          />
          {tab === "sections" ? (
            <div className="panel rail-panel" role="tabpanel">
              <div className="rail-summary t-label-md" data-ui="ui_qa_preview_summary">
                {scores.length - failing.length} đạt • {failing.length} cần sửa · ngưỡng {fmtPct(threshold)}
              </div>
              {scores.length === 0 && <p className="text-3">Chưa có điểm QA cho breakpoint này.</p>}
              <ul className="section-list" data-ui="ui_qa_preview_section_scores">
                {scores.map((s) => {
                  const ok = s.score >= threshold;
                  const name = names.get(s.sectionId)?.name ?? s.sectionId;
                  return (
                    <li key={s.sectionId} data-marked={marked === s.sectionId ? "true" : undefined}>
                      <button type="button" className="section-row" onClick={() => pick(s.sectionId)}>
                        <span className={`dot tone-${ok ? "success" : "danger"}`} aria-hidden="true" />
                        <span className="mono section-name">{name}</span>
                        <Badge tone={ok ? "success" : "danger"}>{fmtPct(s.score)}</Badge>
                        <Icon name="chevron_right" />
                      </button>
                      {!ok && (
                        <div className="fix-card tint tone-danger" data-ui="ui_qa_preview_fix_request">
                          <div className="row">
                            <Badge tone="danger">cần sửa</Badge>
                            <span className="t-body-sm fix-text">{fixText(fixes.get(`${s.pageId}:${s.sectionId}`))}</span>
                          </div>
                          {s.heatPath && <img className="fix-heat" alt={`Heatmap ${name}`} src={fileUrl(s.heatPath)} />}
                          <Button variant="primary" icon="edit" href={`/p/${projectId}/editor?page=${encodeURIComponent(s.pageId)}`}>
                            Sửa trong editor
                          </Button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <Button data-ui="ui_qa_preview_next_diff" icon="arrow_forward" disabled={failing.length === 0} onClick={nextDiff}>
                Section chưa đạt tiếp theo
              </Button>
            </div>
          ) : (
            <Checklist data={data} rows={pageInteractions} />
          )}
        </aside>
      </div>
    </div>
  );
}

function Checklist({ data, rows }: { data: Data; rows: Data["interactions"] }) {
  const captured = rows.filter((i) => i.status === "captured").length;
  return (
    <div className="panel rail-panel" role="tabpanel" data-ui="ui_qa_preview_coverage_checklist">
      <div className="rail-summary">
        <span className="t-label-md">CHECKLIST ĐỘ PHỦ</span>
        <span className="t-label-sm text-3">
          {captured}/{rows.length} đã chụp
        </span>
      </div>
      <GridTable
        label="Độ phủ theo trang"
        columns={[
          { key: "page", header: "Trang", width: "minmax(0, 1fr)" },
          { key: "captured", header: "Đã chụp", width: "64px" },
          { key: "failed", header: "Lỗi", width: "44px" },
          { key: "skipped", header: "Bỏ qua", width: "56px" },
        ]}
        rows={data.coverage}
        rowKey={(c) => c.page}
        renderCell={(c, k) => (k === "page" ? <span className="mono">{c.page}</span> : k === "captured" ? c.captured : k === "failed" ? c.failed : c.skipped)}
      />
      {rows.length === 0 && <p className="text-3">Không có tương tác nào.</p>}
      <ul className="checklist">
        {rows.map((i) => (
          <li key={i.id} className={`check-row check-${i.status}`} data-ui={i.status === "skipped" ? "ui_qa_preview_skipped_item" : undefined}>
            <Icon name={i.status === "captured" ? "check" : i.status === "failed" ? "close" : "remove"} />
            <span className="check-label">{checklistLabel(i.kind, i.trigger)}</span>
            <span className="t-label-sm check-status">{i.status === "captured" ? "đã chụp" : i.status === "failed" ? "lỗi" : "bỏ qua"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 9: CSS** — delete `/* legacy: preview */` and append:

```css
/* === Screen: preview & QA === */
.qa-toolbar { display: flex; justify-content: space-between; align-items: center; gap: var(--s-md); flex-wrap: wrap; }
.inline-field { display: inline-flex; align-items: center; gap: var(--s-sm); }
.match-chip { display: inline-flex; align-items: center; padding: 5px 10px; border-radius: var(--r-sm); font: var(--t-label-md); }
.qa-body { display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: var(--s-lg); }
.compare-area { height: calc(100vh - 56px - 220px); min-height: 420px; overflow: auto; padding: 12px; background: var(--c-surface); border: 1px solid var(--c-border); border-radius: var(--r-lg); }
.compare-side { display: flex; align-items: flex-start; }
.pane-col { flex: none; }
.pane { position: sticky; top: -12px; z-index: 2; }
.pane-head { padding: 6px 10px; background: var(--c-surface-lowest); border: 1px solid var(--c-border); border-bottom: 0; border-radius: var(--r-md) var(--r-md) 0 0; color: var(--c-text-2); font: var(--t-label-sm); }
.orig-shot { display: block; }
.frame { position: relative; overflow: hidden; background: #fff; }
.frame iframe { border: 0; transform-origin: 0 0; display: block; background: #fff; }
.compare-overlay { position: relative; }
.overlay-clone { position: absolute; top: 0; left: 0; }
.heat-overlay { position: absolute; pointer-events: none; mix-blend-mode: multiply; opacity: 0.6; }
.qa-rail { display: grid; gap: var(--s-md); align-content: start; }
.rail-panel { display: grid; gap: var(--s-md); padding: var(--s-md); }
.rail-summary { display: flex; justify-content: space-between; gap: var(--s-sm); color: var(--c-text-2); }
.section-list, .checklist { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.section-row { width: 100%; display: flex; align-items: center; gap: var(--s-sm); padding: 8px 10px; border: 1px solid transparent; border-radius: var(--r-md); background: transparent; color: var(--c-text); cursor: pointer; text-align: left; }
.section-row:hover { background: var(--c-surface-high); }
.section-list li[data-marked] > .section-row { border-color: var(--c-primary); background: var(--c-surface); }
.section-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fix-card { display: grid; gap: var(--s-sm); margin: 4px 0 8px; padding: var(--s-md); border-radius: var(--r-md); }
.fix-text { color: var(--c-text); }
.fix-heat { max-width: 100%; display: block; border: 1px solid var(--c-border); border-radius: var(--r-sm); }
.check-row { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: var(--s-sm); align-items: center; padding: 6px 8px; border-radius: var(--r-sm); overflow-wrap: anywhere; }
.check-captured .icon, .check-captured .check-status { color: var(--c-success); }
.check-failed { background: color-mix(in srgb, var(--c-danger) 5%, transparent); }
.check-failed .icon, .check-failed .check-status { color: var(--c-danger); }
.check-skipped { color: var(--c-text-3); }
```
(`.frame { background: #fff }`: the clone page's own canvas, not a UI color.)

- [ ] **Step 10: Run to verify pass** — `npx vitest run -c vitest.e2e.config.ts tests/e2e/editor-smoke.test.ts` → PASS (the editor test still clicks the sidebar "Editor" link from the preview).

- [ ] **Step 11: Parity screenshots** — rerun with `PARITY_DIR`; compare `preview-side.png`, `preview-onion.png`, `preview-checklist.png` with `docs/superpowers/design/stitch/qa-preview.png` and `qa-preview-alt.png` (toolbar row, pane headers, panes filling the area, rail tabs, section rows with badge %, red fix card, checklist rows). Report differences.

- [ ] **Step 12: Typecheck + unit + build** — `npx tsc --noEmit && npx vitest run` + build check.

- [ ] **Step 13: Commit**

```bash
git add "src/app/p/[id]/preview/preview-model.ts" "src/app/p/[id]/preview/page.tsx" "src/app/p/[id]/preview/preview-view.tsx" src/app/globals.css tests/unit/preview-model.test.ts tests/e2e/editor-smoke.test.ts
git commit -m "feat(ui): preview & QA to Stitch parity (mean match, onion/swipe, heatmap overlay, fix cards, Chạy lại QA)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 13: Screen `/p/[id]/code` — `screen_code_viewer` (spec §3.7)

**Files:**
- Create: `src/app/p/[id]/code/file-tree.tsx`, `src/app/p/[id]/code/code-file.tsx`
- Modify: `src/app/p/[id]/code/page.tsx` (rewrite), `src/app/p/[id]/code/export-panel.tsx` (rewrite as header actions), `src/app/globals.css` (code CSS; delete `/* legacy: code */`), `tests/e2e/editor-smoke.test.ts`

**Interfaces:**
- Consumes: `mapLimit` (`@/core/limit`), `downloadZip`, `fmtBytes`, Task 2 components, existing `POST …/export`, `GET …/files/out/*`.
- Produces: nothing used by later tasks.

Elements (11): `ui_code_viewer_page_header`, `…_file_search`, `…_file_tree`, `…_file_header`, `…_copy_button`, `…_strip_ids`, `…_export_zip`, `…_export_folder`, `…_code_pane`, `…_wrap_toggle`, `…_build_status`. Not rendered: Git tab, Explorer/Search/Export side nav, "Export Package", "Build Successful", "HTML5 / UTF-8", "Synced", "DevBrowser", "workspace-root", "main branch".

- [ ] **Step 0: Trace in the graph** — `/graphify explain screen_code_viewer`; confirm `drift_code_viewer_*` absent; `/graphify path "feat_export" "screen_code_viewer"`.

- [ ] **Step 1: Write the failing smoke test** — in `tests/e2e/editor-smoke.test.ts` insert after the preview test (before the editor test):

```ts
test("code viewer: tree + filter, file header (size, lines), copy = file content, wrap on for .html, line numbers, footer totals", async () => {
  const base = app!.base;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const foreign = trackForeignRequests(page);
  await page.goto(`${base}/p/${projectId}/code`);
  await expectUi(page, ["ui_code_viewer_page_header", "ui_code_viewer_file_search", "ui_code_viewer_file_tree", "ui_code_viewer_file_header", "ui_code_viewer_copy_button", "ui_code_viewer_strip_ids", "ui_code_viewer_export_zip", "ui_code_viewer_export_folder", "ui_code_viewer_code_pane", "ui_code_viewer_wrap_toggle", "ui_code_viewer_build_status"]);
  const html = await (await fetch(`${base}/api/projects/${projectId}/files/out/index.html`)).text();
  const n = html === "" ? 0 : html.split("\n").length - (html.endsWith("\n") ? 1 : 0);
  expect(await page.locator('[data-ui="ui_code_viewer_file_header"]').innerText()).toMatch(new RegExp(`out/index\\.html[\\s\\S]*\\d+(,\\d)? (B|KB)[\\s\\S]*${n} dòng`));
  const tree = page.locator('[data-ui="ui_code_viewer_file_tree"]');
  expect(await tree.getByRole("link", { name: "index.html" }).getAttribute("aria-current")).toBe("page");
  expect(await tree.getByRole("button", { name: /out/ }).getAttribute("aria-expanded")).toBe("true");

  const wrap = page.getByRole("button", { name: "Xuống dòng" });
  const pane = page.locator('[data-ui="ui_code_viewer_code_pane"]');
  expect(await wrap.getAttribute("aria-pressed")).toBe("true");
  expect(await pane.getAttribute("class")).toContain("wrap");
  await wrap.click();
  expect(await wrap.getAttribute("aria-pressed")).toBe("false");
  expect(await pane.getAttribute("class")).not.toContain("wrap");
  expect(await pane.locator(".line").first().evaluate((el) => getComputedStyle(el, "::before").content)).toBe("counter(line)");

  await page.getByRole("button", { name: "Sao chép" }).click();
  await expect.poll(() => page.getByRole("button", { name: "Đã sao chép" }).count()).toBe(1);
  expect((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n")).toBe(html);
  expect(await page.locator('[data-ui="ui_code_viewer_build_status"]').innerText()).toMatch(/^\d+ file · [\d,]+ (B|KB|MB)$/);
  await parityShot(page, "code");

  // filter by file name (not content): only the css file stays, its folder auto-opens
  await page.getByRole("searchbox", { name: "Lọc file" }).fill("STYLES");
  expect(await tree.getByRole("link").allInnerTexts()).toEqual(["styles.css"]);
  await page.getByRole("searchbox", { name: "Lọc file" }).fill("(");
  expect(await tree.getByRole("link").count()).toBe(0);

  // export-to-folder popover: Esc closes it
  const folder = page.locator('[data-ui="ui_code_viewer_export_folder"]');
  await folder.locator("summary").click();
  expect(await folder.getByLabel("Thư mục đích (đường dẫn tuyệt đối)").isVisible()).toBe(true);
  await page.keyboard.press("Escape");
  expect(await folder.getAttribute("open")).toBeNull();
  await expectNoDrift(page);
  await expectIconButtonsLabelled(page);
  expect(foreign).toEqual([]);
  await context.close();
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run -c vitest.e2e.config.ts tests/e2e/editor-smoke.test.ts -t "code viewer"` → FAIL.

- [ ] **Step 3: `src/app/p/[id]/code/file-tree.tsx`**

```tsx
"use client";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Icon, type IconName } from "@/app/_ui/Icon";
import { SearchInput } from "@/app/_ui/SearchInput";

type Dir = { name: string; path: string; dirs: Dir[]; files: string[] };

const ICON_OF: Record<string, IconName> = { ".html": "html", ".css": "css", ".js": "javascript", ".json": "data_object" };
const IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|avif|bmp)$/i;
const fileIcon = (f: string): IconName => ICON_OF[f.slice(f.lastIndexOf(".")).toLowerCase()] ?? (IMAGE.test(f) ? "image" : "description");
const ancestors = (f: string) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"));

// out/ as a tree (<= 2000 paths, from the server listing).
function buildDirs(files: string[]): Dir {
  const root: Dir = { name: "out", path: "", dirs: [], files: [] };
  for (const f of files) {
    const parts = f.split("/");
    let d = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let next = d.dirs.find((x) => x.path === path);
      if (!next) {
        next = { name: parts[i]!, path, dirs: [], files: [] };
        d.dirs.push(next);
      }
      d = next;
    }
    d.files.push(f);
  }
  return root;
}

export function FileTree({ files, current }: { files: string[]; current: string }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(() => new Set(["", ...ancestors(current)])); // the branch of the viewed file starts open
  const q = query.trim().toLowerCase();
  const root = buildDirs(q ? files.filter((f) => f.toLowerCase().includes(q)) : files); // name filter, never the content
  const isOpen = (path: string) => q !== "" || open.has(path);
  const toggle = (path: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const dir = (d: Dir, depth: number): ReactNode => (
    <li key={d.path || "/"}>
      <button type="button" className="tree-dir" aria-expanded={isOpen(d.path)} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(d.path)}>
        <Icon name="chevron_right" className={isOpen(d.path) ? "chev-i open" : "chev-i"} />
        <Icon name={isOpen(d.path) ? "folder_open" : "folder"} />
        <span>{d.name}</span>
      </button>
      {isOpen(d.path) && (
        <ul>
          {d.dirs.map((c) => dir(c, depth + 1))}
          {d.files.map((f) => (
            <li key={f}>
              <Link href={`?file=${encodeURIComponent(f)}`} className="tree-file" aria-current={f === current ? "page" : undefined} style={{ paddingLeft: 22 + (depth + 1) * 14 }}>
                <Icon name={fileIcon(f)} />
                <span>{f.slice(f.lastIndexOf("/") + 1)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );

  return (
    <nav className="panel file-tree" aria-label="Cây file" data-ui="ui_code_viewer_file_tree">
      <div className="pane-toolbar">
        <SearchInput data-ui="ui_code_viewer_file_search" label="Lọc file" placeholder="Lọc file theo tên…" value={query} onChange={setQuery} />
      </div>
      <ul className="tree-root">{dir(root, 0)}</ul>
    </nav>
  );
}
```

- [ ] **Step 4: `src/app/p/[id]/code/code-file.tsx`**

```tsx
"use client";
import { useState, type ReactNode } from "react";
import { Button } from "@/app/_ui/Button";
import { Icon } from "@/app/_ui/Icon";
import { IconButton } from "@/app/_ui/IconButton";

type Props = { projectId: string; file: string; size: string; lines: number | null; copyable: boolean; initialWrap: boolean; children: ReactNode };

// File header (chip, size, lines, Copy, wrap) + the server-highlighted code pane.
export function CodeFile({ projectId, file, size, lines, copyable, initialWrap, children }: Props) {
  const [wrap, setWrap] = useState(initialWrap);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const res = await fetch(`/api/projects/${projectId}/files/out/${file.split("/").map(encodeURIComponent).join("/")}`);
    if (!res.ok) return;
    await navigator.clipboard.writeText(await res.text());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <>
      <div className="code-head" data-ui="ui_code_viewer_file_header">
        <span className="url-chip">
          <Icon name="description" />
          <span className="mono">out/{file}</span>
        </span>
        <span className="t-label-sm text-3">{size}</span>
        {lines !== null && <span className="t-label-sm text-3">{lines} dòng</span>}
        <span className="code-head-actions">
          {copyable && (
            <Button data-ui="ui_code_viewer_copy_button" icon="content_copy" onClick={() => void copy()}>
              {copied ? "Đã sao chép" : "Sao chép"}
            </Button>
          )}
          <IconButton data-ui="ui_code_viewer_wrap_toggle" icon="wrap_text" label="Xuống dòng" pressed={wrap} onClick={() => setWrap((w) => !w)} />
        </span>
      </div>
      <div className={`code-pane${wrap ? " wrap" : ""}`} data-ui="ui_code_viewer_code_pane">
        {children}
      </div>
    </>
  );
}
```

- [ ] **Step 5: `src/app/p/[id]/code/export-panel.tsx`** (whole file)

```tsx
"use client";
import { useRef, useState } from "react";
import { api, errorText } from "@/app/_ui/api";
import { Button } from "@/app/_ui/Button";
import { downloadZip } from "@/app/_ui/download";
import { Field } from "@/app/_ui/Field";
import { Icon } from "@/app/_ui/Icon";

// Header actions: strip ids, "Xuất ra thư mục" popover (absolute path, required by the API), "Xuất ZIP".
export function ExportPanel({ projectId, disabled }: { projectId: string; disabled: boolean }) {
  const [dest, setDest] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [stripIds, setStripIds] = useState(false);
  const pop = useRef<HTMLDetailsElement>(null);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ ok: true, text: await fn() });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const zip = () =>
    run(async () => {
      await downloadZip(projectId, stripIds);
      return "Đã tải ZIP.";
    });

  const folder = () =>
    run(async () => {
      const r = await api<{ dest: string }>(`/api/projects/${projectId}/export`, { body: { mode: "folder", dest, stripIds } });
      if (pop.current) pop.current.open = false;
      return `Đã xuất ra ${r.dest}`;
    });

  return (
    <div className="export-actions">
      <label className="check" data-ui="ui_code_viewer_strip_ids">
        <input type="checkbox" checked={stripIds} onChange={(e) => setStripIds(e.target.checked)} />
        Bỏ data-ir-id
      </label>
      <details
        ref={pop}
        className="popover"
        data-ui="ui_code_viewer_export_folder"
        onKeyDown={(e) => {
          if (e.key !== "Escape" || !pop.current) return;
          pop.current.open = false;
          pop.current.querySelector("summary")?.focus();
        }}
      >
        <summary className="btn btn-secondary" aria-disabled={disabled || undefined} onClick={(e) => disabled && e.preventDefault()}>
          <Icon name="drive_folder_upload" />
          Xuất ra thư mục
        </summary>
        <div className="popover-body">
          <Field label="Thư mục đích (đường dẫn tuyệt đối)">
            <input className="mono" value={dest} onChange={(e) => setDest(e.target.value)} placeholder={"D:\\exports\\site"} />
          </Field>
          <Button variant="primary" disabled={disabled || busy || !dest} onClick={() => void folder()}>
            Xuất
          </Button>
        </div>
      </details>
      <Button data-ui="ui_code_viewer_export_zip" variant="primary" icon="folder_zip" disabled={disabled || busy} onClick={() => void zip()}>
        Xuất ZIP
      </Button>
      {msg && (
        <p className={`note tint tone-${msg.ok ? "success" : "danger"}`} role={msg.ok ? "status" : "alert"}>
          {msg.text}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 6: `src/app/p/[id]/code/page.tsx`** (whole file)

```tsx
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import type { ReactNode } from "react";
import { codeToHtml } from "shiki";
import { mapLimit } from "@/core/limit";
import { workspaceOf } from "@/app/_server/http";
import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { UrlChip } from "@/app/_ui/UrlChip";
import { fmtBytes } from "@/app/_ui/format";
import { loadProject } from "../data";
import { CodeFile } from "./code-file";
import { ExportPanel } from "./export-panel";
import { FileTree } from "./file-tree";

const MAX_FILES = 2_000; // tree shows at most this many out/ files
const STAT_CONCURRENCY = 8; // stat() calls in flight for the totals
const MAX_VIEW_BYTES = 512 * 1024; // larger text files are not highlighted (shiki is O(n) but slow on huge input)
const LANG: Record<string, string> = { ".html": "html", ".css": "css", ".js": "javascript", ".json": "json", ".svg": "xml", ".txt": "text" };
const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico"]);

async function listOut(out: string): Promise<string[]> {
  const entries = await readdir(out, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(out, join(e.parentPath, e.name)).split(sep).join("/"))
    .sort()
    .slice(0, MAX_FILES);
}

// Only a file from the listing is ever read: the query string can't reach outside out/.
async function viewer(out: string, file: string, fileUrl: string, size: number): Promise<{ node: ReactNode; lines: number | null }> {
  const ext = extname(file).toLowerCase();
  const lang = LANG[ext];
  if (!lang) return { node: IMAGE.has(ext) ? <img alt={file} src={fileUrl} className="code-image" /> : <p className="text-3 pad">Không xem được loại file này.</p>, lines: null };
  if (size > MAX_VIEW_BYTES) return { node: <p className="text-3 pad">File quá lớn để xem ({Math.round(size / 1024)} KB).</p>, lines: null };
  const source = await readFile(join(out, file), "utf8");
  const html = await codeToHtml(source, { lang, theme: "github-dark" });
  const lines = source === "" ? 0 : source.split("\n").length - (source.endsWith("\n") ? 1 : 0);
  return { node: <div dangerouslySetInnerHTML={{ __html: html }} />, lines }; // shiki escapes the source text
}

export default async function CodePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ file?: string | string[] }> }) {
  const [{ id }, { file }] = await Promise.all([params, searchParams]);
  const project = loadProject(id);
  const out = join(workspaceOf(id), "out");
  const files = await listOut(out);
  const sizes = await mapLimit(files, STAT_CONCURRENCY, async (f) => (await stat(join(out, f))).size);
  const total = sizes.reduce((a, b) => a + b, 0);
  const current = typeof file === "string" && files.includes(file) ? file : (files.find((f) => f === "index.html") ?? files[0]);
  const fileUrl = (f: string) => `/api/projects/${id}/files/out/${f.split("/").map(encodeURIComponent).join("/")}`;
  const header = (
    <PageHeader
      data-ui="ui_code_viewer_page_header"
      crumbs={projectCrumbs(project.url, id, "Mã nguồn")}
      title="Mã nguồn"
      meta={<UrlChip url={project.url} />}
      actions={<ExportPanel projectId={id} disabled={files.length === 0} />}
    />
  );
  if (current === undefined)
    return (
      <>
        {header}
        <p className="text-3">Chưa có output (out/) — chạy clone trước.</p>
      </>
    );
  const size = sizes[files.indexOf(current)] ?? 0;
  const view = await viewer(out, current, fileUrl(current), size);
  const ext = extname(current).toLowerCase();
  return (
    <>
      {header}
      <div className="code-grid">
        <FileTree files={files} current={current} />
        <section className="panel code-main" aria-label={current}>
          <CodeFile projectId={id} file={current} size={fmtBytes(size)} lines={view.lines} copyable={LANG[ext] !== undefined} initialWrap={ext === ".html"}>
            {view.node}
          </CodeFile>
          <footer className="code-foot t-label-sm" data-ui="ui_code_viewer_build_status">
            {files.length} file · {fmtBytes(total)}
          </footer>
        </section>
      </div>
    </>
  );
}
```

- [ ] **Step 7: CSS** — delete `/* legacy: code */` and append:

```css
/* === Screen: code viewer === */
.export-actions { display: flex; align-items: center; gap: var(--s-sm); flex-wrap: wrap; }
.popover { position: relative; }
.popover > summary { list-style: none; }
.popover > summary::-webkit-details-marker { display: none; }
.popover-body { position: absolute; right: 0; top: 36px; z-index: 30; width: 360px; display: grid; gap: var(--s-sm); padding: var(--s-md); background: var(--c-surface-high); border: 1px solid var(--c-border); border-radius: var(--r-md); }
.code-grid { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: var(--s-lg); height: calc(100vh - 56px - 160px); min-height: 420px; }
.file-tree { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.tree-root, .tree-root ul { list-style: none; margin: 0; padding: 0; }
.tree-root { flex: 1; overflow: auto; padding: var(--s-xs) 0; }
.tree-dir, .tree-file { width: 100%; display: flex; align-items: center; gap: 6px; padding-top: 4px; padding-bottom: 4px; padding-right: 8px; border: 0; border-left: 2px solid transparent; background: transparent; color: var(--c-text-2); font: var(--t-label-md); text-align: left; text-decoration: none; cursor: pointer; }
.tree-dir:hover, .tree-file:hover { background: var(--c-surface-high); color: var(--c-text); }
.tree-file[aria-current="page"] { background: color-mix(in srgb, var(--c-accent) 20%, transparent); border-left-color: var(--c-accent-strong); color: var(--c-text); }
.chev-i { transition: transform 0.15s; }
.chev-i.open { transform: rotate(90deg); }
.code-main { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.code-head { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: var(--s-md); padding: var(--s-sm) var(--s-md); border-bottom: 1px solid var(--c-border); background: var(--c-surface-low); }
.code-head-actions { margin-left: auto; display: flex; align-items: center; gap: var(--s-xs); }
.code-pane { flex: 1; min-height: 0; overflow: auto; background: var(--c-surface-lowest); }
.code-pane .shiki { margin: 0; padding: 12px 0; background-color: var(--c-surface-lowest) !important; font: var(--t-label-md); white-space: pre; counter-reset: line; }
.code-pane.wrap .shiki { white-space: pre-wrap; overflow-wrap: anywhere; }
.code-pane .line { counter-increment: line; }
.code-pane .line::before { content: counter(line); display: inline-block; width: 3.5em; margin-right: 1em; padding-right: 0.5em; text-align: right; color: var(--c-text-3); user-select: none; }
.code-image { max-width: 100%; display: block; margin: var(--s-md); }
.pad { padding: var(--s-md); }
.code-foot { padding: var(--s-sm) var(--s-md); border-top: 1px solid var(--c-border); color: var(--c-text-3); }
```

- [ ] **Step 8: Run to verify pass** — `npx vitest run -c vitest.e2e.config.ts tests/e2e/editor-smoke.test.ts tests/e2e/api.test.ts` → PASS.

- [ ] **Step 9: Parity screenshot** — rerun with `PARITY_DIR`; compare `code.png` with `docs/superpowers/design/stitch/code-viewer.png` (280px tree with folder/file icons and the open file highlighted, sticky file header with chip/size/lines/Copy/wrap, gutter numbers, footer "n file · size", Export ZIP + folder in the page header). Report differences.

- [ ] **Step 10: Typecheck + unit + build** — `npx tsc --noEmit && npx vitest run` + build check.

- [ ] **Step 11: Commit**

```bash
git add "src/app/p/[id]/code/page.tsx" "src/app/p/[id]/code/file-tree.tsx" "src/app/p/[id]/code/code-file.tsx" "src/app/p/[id]/code/export-panel.tsx" src/app/globals.css tests/e2e/editor-smoke.test.ts
git commit -m "feat(ui): code viewer to Stitch parity (file tree + filter, file header, copy, wrap, line numbers, totals)" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 14: Screen `/p/[id]/editor` chrome (spec §3.8) + removal of the legacy CSS

**Files:**
- Create: `src/app/p/[id]/editor/editor-view.tsx` (the GrapesJS client logic, moved from `page.tsx` and restyled)
- Modify: `src/app/p/[id]/editor/page.tsx` (server wrapper: PageHeader + `?page=`), `src/app/globals.css` (editor CSS + GrapesJS theme; delete `/* legacy: editor */` and `/* legacy: shared */`), `tests/e2e/editor-smoke.test.ts`

**Interfaces:**
- Consumes: `loadProject`, `projectCrumbs`, Task 2 components; `GET …/editor?page=`, `POST …/editor/save`, `POST …/editor/promote-layout` (unchanged).
- Produces: nothing.

Elements (5): `ui_editor_page_header`, `ui_editor_toolbar`, `ui_editor_canvas_chrome`, `ui_editor_effects_panel`, `ui_editor_sections_panel`.

Note (resolved in this plan): the spec says the editor reads `?page=` with `useSearchParams` (client). The page is split into a server wrapper (it needs the project URL for the breadcrumb anyway) that reads `searchParams` and passes `initialPage` down — same behavior, no Suspense boundary for `useSearchParams`.

- [ ] **Step 0: Trace in the graph** — `/graphify explain screen_editor`; `/graphify explain feat_editor`.

- [ ] **Step 1: Update/add the failing smoke tests** — in `tests/e2e/editor-smoke.test.ts`:
  - in "editor: edit one heading…", click the sidebar link explicitly and expect the new status copy:
    `await page.getByRole("navigation", { name: "Dự án" }).getByRole("link", { name: "Editor" }).click();` and
    `await expect.poll(() => page.getByRole("status").innerText(), { timeout: 30_000 }).toBe("Đã lưu: 1 thay đổi — điểm QA cần chạy lại");`, then add `expect(await page.getByRole("link", { name: "Mở Preview" }).getAttribute("href")).toBe(\`/p/${projectId}/preview\`);`
  - add after it:

```ts
test("editor: ?page= opens that page, an unknown one falls back to the default; toolbar + GrapesJS on the tokens", async () => {
  const base = app!.base;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/p/${projectId}/editor?page=home`);
  const select = page.locator('[data-ui="ui_editor_toolbar"] select');
  await expect.poll(() => select.inputValue(), { timeout: 30_000 }).toBe("home");
  await expectUi(page, ["ui_editor_page_header", "ui_editor_toolbar", "ui_editor_canvas_chrome", "ui_editor_effects_panel", "ui_editor_sections_panel"]);
  // no more default #444 GrapesJS panels: --c-surface-low
  await expect.poll(() => page.locator(".editor-shell .gjs-one-bg").first().evaluate((el) => getComputedStyle(el).backgroundColor), { timeout: 30_000 }).toBe("rgb(25, 28, 35)");
  expect(await page.getByRole("group", { name: "Thiết bị" }).getByRole("button").allInnerTexts()).toEqual(["1440", "768", "375"]);
  expect(await page.getByRole("button", { name: "Hoàn tác" }).getAttribute("title")).toBe("Hoàn tác");
  expect(await page.getByRole("button", { name: "Làm lại" }).getAttribute("title")).toBe("Làm lại");
  await expectNoDrift(page);
  await parityShot(page, "editor");
  await page.goto(`${base}/p/${projectId}/editor?page=nope`);
  await expect.poll(() => select.inputValue(), { timeout: 30_000 }).toBe("home");
  expect(await page.getByRole("status").innerText()).toBe("");
  await page.close();
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run -c vitest.e2e.config.ts tests/e2e/editor-smoke.test.ts -t "editor"` → FAIL.

- [ ] **Step 3: `src/app/p/[id]/editor/page.tsx`** (whole file)

```tsx
import { PageHeader, projectCrumbs } from "@/app/_ui/PageHeader";
import { loadProject } from "../data";
import { EditorView } from "./editor-view";

// ?page=<pageId> (the preview's "Sửa trong editor") opens that page; an unknown id falls back to the first page.
export default async function EditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ page?: string | string[] }> }) {
  const [{ id }, { page }] = await Promise.all([params, searchParams]);
  const project = loadProject(id);
  return (
    <>
      <PageHeader data-ui="ui_editor_page_header" crumbs={projectCrumbs(project.url, id, "Editor")} title="Editor" />
      <EditorView projectId={id} initialPage={typeof page === "string" ? page : ""} />
    </>
  );
}
```

- [ ] **Step 4: `src/app/p/[id]/editor/editor-view.tsx`**

```tsx
"use client";
import "grapesjs/dist/css/grapes.min.css";
import type { Editor } from "grapesjs";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { GrapesProject } from "@/core/grapes-adapter";
import { api, errorText } from "@/app/_ui/api";
import { Badge } from "@/app/_ui/Badge";
import { Button } from "@/app/_ui/Button";
import { Card } from "@/app/_ui/Card";
import { Field } from "@/app/_ui/Field";
import { IconButton } from "@/app/_ui/IconButton";
import { SegmentedControl } from "@/app/_ui/SegmentedControl";

const DEVICES = ["1440", "768", "375"] as const;
type Device = (typeof DEVICES)[number];
const DEFAULT_EFFECT_MS = 600;

// GrapesJS over one page of the IR (spec §10). Save sends the editor's JSON to the adapter, which patches the IR and
// re-emits out/; layout sections are shared, so editing one on any page edits it everywhere.
export function EditorView({ projectId: id, initialPage }: { projectId: string; initialPage: string }) {
  const [pageId, setPageId] = useState(initialPage); // "" = the API's default (first page)
  const [version, setVersion] = useState(0); // bumped after a save / merge: reload the IR into a fresh editor
  const [project, setProject] = useState<GrapesProject | null>(null);
  const [device, setDevice] = useState<Device>(DEVICES[0]);
  const [picked, setPicked] = useState<string[]>([]); // click order: the first becomes the layout
  const [effect, setEffect] = useState("sp1-fade-in");
  const [effectMs, setEffectMs] = useState(DEFAULT_EFFECT_MS);
  const [msg, setMsg] = useState("");
  const [saved, setSaved] = useState(false); // qa.json is stale from now on: offer the preview (Chạy lại QA)
  const [busy, setBusy] = useState(false);
  const holder = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);

  useEffect(() => {
    let editor: Editor | undefined;
    let cancelled = false;
    (async () => {
      const [data, { default: grapesjs }] = await Promise.all([
        api<GrapesProject>(`/api/projects/${id}/editor${pageId ? `?page=${encodeURIComponent(pageId)}` : ""}`),
        import("grapesjs"),
      ]);
      if (cancelled || !holder.current) return;
      const pathOf = new Map(data.pages.map((p) => [p.id, p.path]));
      editor = grapesjs.init({
        container: holder.current,
        height: "72vh",
        storageManager: false, // the IR on the server is the only store
        protectedCss: data.styles,
        selectorManager: { componentFirst: true }, // style edits target the component, not a shared class
        // widthMedia "": a style edit applies at every breakpoint (the IR patch sets the base style)
        deviceManager: { devices: DEVICES.map((w) => ({ id: w, name: `${w}px`, width: `${w}px`, widthMedia: "" })) },
        blockManager: {
          blocks: data.sections.map((s) => ({ id: s.id, label: s.name, category: pathOf.get(s.pageId) ?? s.pageId, content: s.component })),
        },
      });
      // the canvas resolves urls like the emitted page (local assets in out/): <base> before the body renders
      const baseHref = new URL(`/api/projects/${id}/files/out/${encodeURIComponent(data.pageFile)}`, window.location.href).href;
      editor.on("canvas:frame:load:head", ({ window: frame }: { window: Window }) => {
        const base = frame.document.createElement("base");
        base.href = baseHref;
        frame.document.head.prepend(base);
      });
      editor.setComponents(data.components);
      editor.getWrapper()?.addClass(data.bodyClasses);
      editor.UndoManager.clear(); // loading the page is not an undoable edit
      editor.setDevice(DEVICES[0]);
      editorRef.current = editor;
      setDevice(DEVICES[0]);
      setProject(data);
    })().catch((e: unknown) => {
      // a stale or mistyped ?page= falls back to the default page instead of failing the editor
      if (pageId !== "" && pageId === initialPage && errorText(e).startsWith("NOT_FOUND")) return setPageId("");
      setMsg(errorText(e));
    });
    return () => {
      cancelled = true;
      editor?.destroy();
      editorRef.current = null;
    };
  }, [id, pageId, version, initialPage]);

  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(label);
    try {
      setMsg(await fn());
      setVersion((v) => v + 1);
    } catch (e) {
      setMsg(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () =>
    run("Đang lưu…", async () => {
      const editor = editorRef.current;
      if (!editor || !project) return "Editor chưa sẵn sàng.";
      // a text still being edited is only synced into the model when rich-text editing ends
      const view = editor.getEditing()?.getView() as { disableEditing?: () => Promise<void> } | undefined;
      await view?.disableEditing?.();
      const body = { pageId: project.pageId, project: { components: editor.getComponents(), styles: editor.Css.getAll() } };
      const res = await api<{ ops: number }>(`/api/projects/${id}/editor/save`, { body });
      setSaved(true);
      return `Đã lưu: ${res.ops} thay đổi — điểm QA cần chạy lại`;
    });

  const mergeLayout = () =>
    run("Đang gộp…", async () => {
      await api(`/api/projects/${id}/editor/promote-layout`, { body: { sectionIds: picked } });
      setPicked([]);
      setSaved(true);
      return "Đã gộp thành layout chung";
    });

  const applyEffect = () => {
    const selected = editorRef.current?.getSelected();
    if (!selected) return setMsg("Chọn một phần tử trên canvas trước.");
    selected.addStyle({ animation: `${effect} ${effectMs}ms ease-out both` });
    setMsg(`Đã áp ${effect} — nhớ Lưu`);
  };

  const togglePick = (sectionId: string) => setPicked((p) => (p.includes(sectionId) ? p.filter((x) => x !== sectionId) : [...p, sectionId]));
  const pathOf = new Map(project?.pages.map((p) => [p.id, p.path]));

  return (
    <div className="stack">
      <div className="editor-toolbar" data-ui="ui_editor_toolbar">
        <label className="inline-field">
          <span className="field-label">Trang</span>
          <select value={project?.pageId ?? ""} onChange={(e) => setPageId(e.target.value)} disabled={busy}>
            {project?.pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.path}
              </option>
            ))}
          </select>
        </label>
        <SegmentedControl<Device>
          label="Thiết bị"
          value={device}
          onChange={(w) => {
            editorRef.current?.setDevice(w);
            setDevice(w);
          }}
          options={DEVICES.map((w) => ({ value: w, label: w }))}
        />
        <IconButton icon="undo" label="Hoàn tác" onClick={() => editorRef.current?.UndoManager.undo()} />
        <IconButton icon="redo" label="Làm lại" onClick={() => editorRef.current?.UndoManager.redo()} />
        <Button variant="primary" icon="save" onClick={() => void save()} disabled={busy || !project}>
          Lưu
        </Button>
        <span role="status" className="t-label-md text-2">
          {msg}
        </span>
        {saved && <Link href={`/p/${id}/preview`}>Mở Preview</Link>}
      </div>
      <div className="editor-grid">
        <div className="editor-shell panel" data-ui="ui_editor_canvas_chrome">
          <div ref={holder} />
        </div>
        <aside className="stack">
          <Card title="Hiệu ứng" data-ui="ui_editor_effects_panel">
            <Field label="Keyframes">
              <select value={effect} onChange={(e) => setEffect(e.target.value)}>
                {project?.effects.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            </Field>
            <Field label="Thời lượng (ms)">
              <input type="number" min={100} max={10_000} step={100} value={effectMs} onChange={(e) => setEffectMs(Number(e.target.value) || DEFAULT_EFFECT_MS)} />
            </Field>
            <Button onClick={applyEffect} disabled={!project}>
              Áp cho phần tử đang chọn
            </Button>
          </Card>
          <Card title="Section" data-ui="ui_editor_sections_panel">
            <p className="t-body-sm text-2">Chọn section ở các trang khác nhau; section chọn đầu tiên thành layout chung.</p>
            <ul className="editor-sections">
              {project?.sections.map((s) => (
                <li key={s.id}>
                  <label className="check">
                    <input type="checkbox" checked={picked.includes(s.id)} onChange={() => togglePick(s.id)} />
                    <span className="mono">{s.name}</span> <span className="text-3">{pathOf.get(s.pageId)}</span>
                    {s.layoutId && <Badge tone="primary">Layout chung</Badge>}
                  </label>
                </li>
              ))}
            </ul>
            <Button onClick={() => void mergeLayout()} disabled={busy || picked.length < 2}>
              Gộp thành layout
            </Button>
          </Card>
        </aside>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: CSS** — delete the `/* legacy: editor */` block and append:

```css
/* === Screen: editor === */
.editor-toolbar { display: flex; align-items: center; gap: var(--s-sm); flex-wrap: wrap; }
.editor-grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--s-lg); align-items: start; }
.editor-sections { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; max-height: 40vh; overflow: auto; }
.editor-shell { overflow: hidden; }
/* GrapesJS theme on the Stitch tokens (spec §3.8) */
.editor-shell .gjs-one-bg { background-color: var(--c-surface-low); }
.editor-shell .gjs-two-color { color: var(--c-text-2); }
.editor-shell .gjs-three-bg { background-color: var(--c-surface-high); color: var(--c-text); }
.editor-shell .gjs-four-color, .editor-shell .gjs-four-color-h:hover { color: var(--c-primary); }
.editor-shell .gjs-pn-panel, .editor-shell .gjs-blocks-c, .editor-shell .gjs-sm-sector, .editor-shell .gjs-layer, .editor-shell .gjs-block { border-color: var(--c-border); }
.editor-shell .gjs-editor, .editor-shell .gjs-pn-btn, .editor-shell .gjs-block, .editor-shell .gjs-sm-sector-title, .editor-shell .gjs-layer-name { font: var(--t-label-md); }
```

- [ ] **Step 6: Delete the legacy shared CSS** — remove the whole `/* legacy: shared */` block (and any other `/* legacy: … */` block still present) from `src/app/globals.css`, then prove no component still uses those classes:

```bash
node -e '
const fs = require("fs"), path = require("path");
const legacy = new Set(["card","alert","notice","muted","plain","field","grid-3","split","tag","thumb","bar","stepper","auth-banner","log","tree","compare","pane-label","sections","score","checklist-row","heat","code-layout","files","viewer","editor-layout","topbar","brand","page","primary","warn"]);
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx$/.test(e.name) ? [path.join(d, e.name)] : []));
const bad = [];
for (const f of walk("src/app")) for (const m of fs.readFileSync(f, "utf8").matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) for (const t of (m[1] ?? m[2]).split(/\s+/)) if (legacy.has(t)) bad.push(`${f}: ${t}`);
console.log(bad.join("\n") || "clean");
'
grep -n "legacy" src/app/globals.css; echo "grep-exit=$?"
```
Expected: `clean` and `grep-exit=1`. (Fix any hit by switching to the new component/class, not by keeping the legacy rule.)

- [ ] **Step 7: Run everything UI**

Run: `npx vitest run -c vitest.e2e.config.ts tests/e2e/editor-smoke.test.ts tests/e2e/ui-smoke.test.ts` → PASS.

- [ ] **Step 8: Parity screenshot** — rerun with `PARITY_DIR`; `editor.png` has no Stitch mockup: check it against the token system only (toolbar density, GrapesJS panels on `--c-surface-low`, cards like the other screens). Also re-shoot every screen once more (the legacy CSS is gone) and confirm nothing regressed versus the earlier shots.

- [ ] **Step 9: Typecheck + unit + build** — `npx tsc --noEmit && npx vitest run` + build check.

- [ ] **Step 10: Commit**

```bash
git add "src/app/p/[id]/editor/page.tsx" "src/app/p/[id]/editor/editor-view.tsx" src/app/globals.css tests/e2e/editor-smoke.test.ts
git commit -m "feat(ui): editor chrome on the Stitch tokens (toolbar, ?page=, GrapesJS theme); drop the legacy CSS" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---
### Task 15: Docs — element-level Stitch map + official drift list (spec §5–6, D4)

**Files:**
- Modify: `docs/superpowers/design/stitch-screens.md` (rewrite), `docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md` (§10 pointer)
- Local only (gitignored, not committed): `.superpowers/sdd/2026-09-23-sp1-clone-engine/drift-list.md`

**Interfaces:**
- Consumes: the ids of Tasks 2 and 7–14 (all `data-ui` values), spec §3.9 / §5.
- Produces: the committed source the controller's `/graphify docs --update` reads (122 `ui_*`, 59 `drift_*`, 4 out-of-scope, 3 aliases).

- [ ] **Step 0: Trace in the graph** — `/graphify explain sp1` and list current `drift_*` nodes (30) with the one-liner; they must all be in the new list.

- [ ] **Step 1: Verify every mapped id exists in code** (the doc must not list an element the code lacks):

```bash
node -e '
const fs = require("fs"), path = require("path");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(d, e.name)] : []));
const ids = new Set(walk("src/app").flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/"(ui_[a-z0-9_]+)"/g)].map((m) => m[1])));
console.log(ids.size, [...ids].sort().join(" "));
'
```
Expected: `122` followed by the ids of spec §3 (shell 6, settings 15, history 21, new-clone 15, sitemap 17, progress 14, qa-preview 18, code-viewer 11, editor 5).

- [ ] **Step 2: Rewrite `docs/superpowers/design/stitch-screens.md`** with exactly this content:

````markdown
# SP1 UI — Stitch Design Reference (element map)

Stitch project: **AI Web Clone Tool** (`projects/5886124613364668099`). Design system `assets/12550457517034224226`: dark; Space Grotesk headline, Inter body, JetBrains Mono for labels/URLs/code/numbers; token Stitch xuất ra: primary `#c0c1ff`, primary-container `#8083ff` (xem spec parity §1); success `#4ae176`, warn `#ffb95f`, danger `#ffb4ab`.

Nguồn sự thật: spec `docs/superpowers/specs/2026-09-24-sp1-ui-stitch-parity-design.md` (token §1, shell + component §2, element §3, drift §5). Bản tải về (HTML + PNG 2560px) ở `docs/superpowers/design/stitch/` — chỉ tham khảo bố cục; mọi thứ Stitch tự bịa là drift (cuối file). Mỗi element có `data-ui="<ui_id>"` trong DOM.

Trạng thái: **build** = đã dựng; **out_of_scope** = node giữ trong graph, không dựng; **alias** = id cũ gộp vào id khác.

## Ghi chú copy bắt buộc

- **Auth banner (Tiến độ):** "Trang <url> cần đăng nhập — Mở cửa sổ để đăng nhập, rồi bấm Tiếp tục" (không Cloudflare/Turnstile/clearance). Không bypass anti-bot: gặp login/CAPTCHA → `needs_auth`, người dùng tự xử lý trong cửa sổ Chrome.
- **Provider settings:** đúng 2 nút "Add Anthropic Compatible" / "Add OpenAI Compatible"; không model id cứng.
- **Phase stepper:** đúng 9 pha: discover → capture → assets → ir → name → emit → qa → fix → done.
- **Status pill:** draft, running, paused, interrupted, needs_auth, failed, completed (chữ = mã trạng thái) + "đang chờ".

## Shell (mọi màn) — `src/app/_ui/Shell.tsx`

Screens: `screen_history`, `screen_new_clone`, `screen_settings_ai`, `screen_sitemap`, `screen_progress`, `screen_qa_preview`, `screen_code_viewer`, `screen_editor`. Mockup: header + sidebar trái của mọi file (`history-alt3.png` chuẩn).

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_shell_header` | `feat_history_resume` | — | header `h-14` | build |
| `ui_shell_new_clone_cta` | `feat_crawl` | route `/new` | header phải "+ New Clone" | build |
| `ui_shell_settings_link` | `feat_ai_gateway` | route `/settings/ai` | header phải icon settings | build |
| `ui_shell_sidebar_nav` | `feat_history_resume`, `feat_crawl`, `feat_ai_gateway` | `usePathname()` | sidebar `w-56` | build |
| `ui_shell_project_nav` | `feat_job_queue_sse`, `feat_qa_score`, `feat_editor`, `feat_export` | route `/p/[id]/*` | sidebar (không có tương đương thật) | build |
| `ui_shell_page_header` | `feat_history_resume` | `PageHeader` | vùng tiêu đề trang | build |

## `/settings/ai` ↔ `screen_settings_ai` ↔ `settings-ai.png|html`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_settings_ai_page_header` | `feat_ai_gateway` | — | tiêu đề trên cùng | build |
| `ui_settings_ai_add_provider_buttons` | `feat_ai_gateway` | `POST /api/providers` | góc phải header | build |
| `ui_settings_ai_endpoint_list` | `feat_ai_gateway` | `GET /api/providers` | card "Configured Endpoints" | build |
| `ui_settings_ai_endpoint_filter` | `feat_ai_gateway` | client | ô lọc dưới title card | build |
| `ui_settings_ai_endpoint_row` | `feat_ai_gateway` | `GET /api/providers` + state Test | hàng endpoint | build |
| `ui_settings_ai_test_endpoint` | `feat_ai_gateway` | `POST /api/providers/test` (`latencyMs`, `httpStatus`) | bolt + "Test Endpoint" | build |
| `ui_settings_ai_row_menu` | `feat_ai_gateway` | `PATCH`/`DELETE /api/providers/[id]` | kebab | build |
| `ui_settings_ai_config_panel` | `feat_ai_gateway` | — | card "Provider Configuration" | build |
| `ui_settings_ai_display_name` | `feat_ai_gateway` | `name` | "Provider Display Name" | build |
| `ui_settings_ai_protocol` | `feat_ai_gateway` | `kind` | "Protocol Standard … LOCKED" | build |
| `ui_settings_ai_base_url` | `feat_ai_gateway` | `baseUrl` | "Upstream Base URL" | build |
| `ui_settings_ai_api_key` | `feat_ai_gateway` | `apiKey` (chỉ gửi đi) | "Secret API Token" | build |
| `ui_settings_ai_fetch_models` | `feat_ai_gateway` | `POST /api/providers/models` | "Fetch Models" | build |
| `ui_settings_ai_role_matrix` | `feat_ai_gateway`, `feat_section_naming`, `feat_fix_loop` | `roles` của provider | card "Engine Role Assignment" | build |
| `ui_settings_ai_save_provider` | `feat_ai_gateway` | `POST`/`PATCH /api/providers` | "Discard Changes" / "Save Provider" | build |
| `ui_settings_ai_default_model` | `feat_ai_gateway` | — | "Default Primary Model" | out_of_scope |

## `/` ↔ `screen_history` ↔ `history-alt3.png` (chuẩn), `history.png`, `history-alt1.png`, `history-alt2.png`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_history_page_header` | `feat_history_resume` | `counts` | tiêu đề + "24 recorded" | build |
| `ui_history_status_tabs` | `feat_history_resume` | `GET /api/projects` `counts` | tab trái có count | build |
| `ui_history_url_search` | `feat_history_resume` | `GET /api/projects?q=` | ô search | build |
| `ui_history_refresh` | `feat_history_resume` | `GET /api/projects` | nút refresh | build |
| `ui_history_job_rows` | `feat_history_resume` | `GET /api/projects` | bảng + header band | build |
| `ui_history_row_thumb` | `feat_capture_dom` | `thumbPage` → `shots/1440.png` | thumbnail 100×64 | build |
| `ui_history_row_url` | `feat_history_resume` | `url` | URL + open_in_new | build |
| `ui_history_row_subtitle` | `feat_history_resume`, `feat_crawl` | `mode`, `pageCount`, `createdAt` | dòng phụ dưới URL | build |
| `ui_history_failed_error_log` | `feat_history_resume` | `lastError` | dòng đỏ lỗi | build |
| `ui_history_needs_auth_status` | `feat_auth` | `status`, `lastError.code` | hàng amber | build |
| `ui_history_status_pill` | `feat_job_queue_sse` | `status`, `queued` | cột STATUS | build |
| `ui_history_progress_bar` | `feat_job_queue_sse` | `phase`, `phaseDone/phaseTotal`, `progress`, `updatedAt` | cột pha + thanh màu | build |
| `ui_history_row_actions` | `feat_history_resume` | — | cột ACTIONS | build |
| `ui_history_pause_button` | `feat_history_resume` | `POST …/pause` | pause | build |
| `ui_history_resume_button` | `feat_history_resume` | `POST …/resume` | play_arrow | build |
| `ui_history_open_button` | `feat_history_resume` | route | visibility | build |
| `ui_history_reclone_button` | `feat_history_resume`, `feat_crawl` | `/new?from=` | replay | build |
| `ui_history_download_export` | `feat_export` | `POST …/export {mode:"zip"}` | download | build |
| `ui_history_delete_button` | `feat_history_resume` | `DELETE /api/projects/[id]` | delete | build |
| `ui_history_pagination` | `feat_history_resume` | `total`, `page`, `pageSize` | footer phân trang | build |
| `ui_history_empty` | `feat_history_resume` | — | — | build |
| `ui_history_status_filter` | `feat_history_resume` | — | tab Failed | out_of_scope |
| `ui_history_inject_auth` | `feat_auth` | — | "Inject Auth" (`drift_history_inject_auth`) | out_of_scope |
| `ui_history_vi_status_tabs` | `feat_history_resume` | — | — | alias → `ui_history_status_tabs` |
| `ui_history_search` | `feat_history_resume` | — | — | alias → `ui_history_url_search` |
| `ui_history_interrupted_resume` | `feat_history_resume` | — | — | alias → `ui_history_resume_button` |

## `/new` ↔ `screen_new_clone` ↔ `new-clone.png|html`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_new_clone_page_header` | `feat_crawl` | — | "New Clone Configuration" | build |
| `ui_new_clone_card` | `feat_crawl` | — | card giữa | build |
| `ui_new_clone_url_input` | `feat_crawl` | `url` | "Website URL" | build |
| `ui_new_clone_mode_toggle` | `feat_crawl` | `mode` | "Single page / Crawl site" | build |
| `ui_new_clone_crawl_limits` | `feat_crawl` | `maxPages`, `depth`, `concurrency`, `delayMs` | "CRAWL CONSTRAINTS" | build |
| `ui_new_clone_auth_select` | `feat_auth` | `auth.mode` | "Authentication" | build |
| `ui_new_clone_auth_credentials` | `feat_auth` | `credentials` | "Username / Password" | build |
| `ui_new_clone_auth_selectors` | `feat_auth` | `auth.selectors` | "Optional selectors" | build |
| `ui_new_clone_manual_login` | `feat_auth` | `POST …/auth/open`, `POST …/crawl` | — | build |
| `ui_new_clone_qa_threshold` | `feat_qa_score` | `threshold` | "QA threshold" slider | build |
| `ui_new_clone_token_budget` | `feat_ai_gateway` | `tokenBudget` | "Token budget" | build |
| `ui_new_clone_output_format` | `feat_emit_html` (SP2 card = `feat_framework_emitters_sp2`, không build) | HTML | lưới card output | build |
| `ui_new_clone_cancel` | `feat_crawl` | route `/` | "Cancel" | build |
| `ui_new_clone_preview_sitemap` | `feat_crawl` | `POST /api/projects`, `POST …/crawl` | "Preview sitemap →" | build |
| `ui_new_clone_error` | `feat_crawl` | — | — | build |

## `/p/[id]/sitemap` ↔ `screen_sitemap` ↔ `sitemap.png|html`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_sitemap_page_header` | `feat_crawl` | `project`, `discover.json` | breadcrumb + title + chip origin | build |
| `ui_sitemap_select_all` | `feat_crawl` | client | "Select all (34)" | build |
| `ui_sitemap_cost_estimate` | `feat_crawl`, `feat_ai_gateway` | `estimateRun()` (`core/estimate.ts`) | "~1.2M tokens" | build |
| `ui_sitemap_route_search` | `feat_crawl` | client | "Filter routes…" | build |
| `ui_sitemap_expand_collapse` | `feat_crawl` | client | "Expand / Collapse" | build |
| `ui_sitemap_filter_tabs` | `feat_crawl`, `feat_auth` | `discover.json` + capture dates | "All / Public / Auth Gated / Modified" | build |
| `ui_sitemap_route_tree` | `feat_crawl` | `buildRouteTree()` | bảng cây | build |
| `ui_sitemap_http_status` | `feat_crawl` | `CrawlPage.status/loadMs/redirected` | "200 OK 1.2s" | build |
| `ui_sitemap_auth_gated_rows` | `feat_auth` | `needsAuth` | hàng amber | build |
| `ui_sitemap_captured_at` | `feat_capture_dom` | capture tasks done | "Captured: …" | build |
| `ui_sitemap_protected_banner` | `feat_auth` | `POST …/auth/open`, `POST …/session/import` | "Protected Routes Detected" | build |
| `ui_sitemap_action_bar` | `feat_crawl` | client | thanh đáy dính | build |
| `ui_sitemap_runtime_estimate` | `feat_crawl` | `estimateRun().seconds` | "Est. runtime" | build |
| `ui_sitemap_cancel` | `feat_crawl` | route `/` | "Cancel" | build |
| `ui_sitemap_start_clone` | `feat_crawl`, `feat_job_queue_sse` | `POST …/start` (đóng cửa sổ đăng nhập trước, D8) | "Start clone" | build |
| `ui_sitemap_recrawl` | `feat_crawl` | `POST …/crawl` | — | build |
| `ui_sitemap_session_tools` | `feat_auth` | `POST …/session/clear`, `…/session/import` | — | build |

## `/p/[id]` ↔ `screen_progress` ↔ `progress.png|html`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_progress_page_header` | `feat_job_queue_sse` | — | — | build |
| `ui_progress_context_bar` | `feat_job_queue_sse` | `project`, SSE `status`/`progress` | "Target Origin" + pill | build |
| `ui_progress_stats_bar` | `feat_job_queue_sse`, `feat_ai_gateway` | event `at`, `progress.tokensUsed`, `tokenBudget` | "elapsed", "Tokens" | build |
| `ui_progress_controls` | `feat_history_resume` | `POST …/pause`, `…/resume` | "Pause / Resume" | build |
| `ui_progress_phase_stepper` | `feat_job_queue_sse` | tasks + SSE | stepper 9 pha | build |
| `ui_progress_auth_banner` | `feat_auth` | `POST …/auth/open`, `…/auth/continue` | "Action Required" banner | build |
| `ui_progress_credentials_form` | `feat_auth` | `…/resume`, `…/auth/continue` + `credentials` | — | build |
| `ui_progress_page_list` | `feat_capture_dom`, `feat_asset_download` | `pageStates()` + `pages.json` + SSE | pane trái | build |
| `ui_progress_page_counts` | `feat_job_queue_sse` | `pageStates()` + tasks running | footer pane trái | build |
| `ui_progress_log_stream` | `feat_job_queue_sse` | SSE `history` + event log bền (`core/event-log.ts`) | pane log | build |
| `ui_progress_log_level_filter` | `feat_job_queue_sse` | client | "All / Info / Warn / Error" | build |
| `ui_progress_log_toggles` | `feat_job_queue_sse` | client | "Auto-scroll / Wrap lines" | build |
| `ui_progress_log_line` | `feat_job_queue_sse` | event `at` | dòng log | build |
| `ui_progress_session_tools` | `feat_auth` | session routes | — | build |
| `ui_progress_inspect_snapshot` | `feat_capture_dom` | — | "Inspect DOM Snapshot" | out_of_scope |

## `/p/[id]/preview` ↔ `screen_qa_preview` ↔ `qa-preview.png|html`, `qa-preview-alt.png|html`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_qa_preview_page_header` | `feat_qa_score` | — | "stripe.com-pricing / …" | build |
| `ui_qa_preview_page_select` | `feat_qa_score` | `pages` | — | build |
| `ui_qa_preview_breakpoint_switch` | `feat_qa_score` | scores theo bp | "375 / 768 / 1440" | build |
| `ui_qa_preview_compare_modes` | `feat_qa_score` | shots + iframe clone | "Side by Side / Onion / Swipe" | build |
| `ui_qa_preview_overlay_slider` | `feat_qa_score` | client | "Blend 65%" | build |
| `ui_qa_preview_heatmap_toggle` | `feat_qa_score` | `scores[].heatPath` | "Heatmap On" | build |
| `ui_qa_preview_match_score` | `feat_qa_score` | scores (trung bình, D6) | "96.2% Match" | build |
| `ui_qa_preview_rerun_qa` | `feat_qa_score`, `feat_editor` | `POST …/qa/rescore` | "Re-run Diff" | build |
| `ui_qa_preview_export_button` | `feat_export` | route `/p/[id]/code` | "Export" | build |
| `ui_qa_preview_side_by_side_panes` | `feat_qa_score` | shots, iframe | 2 pane có chrome | build |
| `ui_qa_preview_sync_scroll` | `feat_qa_score` | 1 vùng cuộn chung | "Sync Scroll" (không render toggle) | build |
| `ui_qa_preview_rail_tabs` | `feat_qa_score`, `feat_interaction_scan` | scores, interactions | "Sections / Coverage checklist" | build |
| `ui_qa_preview_summary` | `feat_qa_score` | scores, `threshold` | "7 Passing • 1 Action Item" | build |
| `ui_qa_preview_section_scores` | `feat_qa_score`, `feat_section_naming` | `sections`, `scores` | hàng section | build |
| `ui_qa_preview_fix_request` | `feat_fix_loop`, `feat_editor` | `fixes` trong `GET …/preview` | card đỏ "FIX REQ" | build |
| `ui_qa_preview_next_diff` | `feat_qa_score` | scores | "Jump to next diff" | build |
| `ui_qa_preview_coverage_checklist` | `feat_interaction_scan` | `interactions`, `coverage` | "COVERAGE CHECKLIST" | build |
| `ui_qa_preview_skipped_item` | `feat_interaction_scan` | `status=skipped` | "— … skipped" | build |

## `/p/[id]/code` ↔ `screen_code_viewer` ↔ `code-viewer.png|html`

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_code_viewer_page_header` | `feat_export` | `project` | — | build |
| `ui_code_viewer_file_search` | `feat_export` | danh sách file (≤2000) | "Search project files…" | build |
| `ui_code_viewer_file_tree` | `feat_emit_html` | `listOut` | cây "out" | build |
| `ui_code_viewer_file_header` | `feat_emit_html` | `stat` + nội dung | chip file + size + lines | build |
| `ui_code_viewer_copy_button` | `feat_export` | files route (out/) | "Copy" | build |
| `ui_code_viewer_strip_ids` | `feat_export` | `stripIds` | — | build |
| `ui_code_viewer_export_zip` | `feat_export` | `POST …/export {mode:"zip"}` | "Export ZIP" | build |
| `ui_code_viewer_export_folder` | `feat_export` | `POST …/export {mode:"folder"}` | "Export to folder" | build |
| `ui_code_viewer_code_pane` | `feat_emit_html` | shiki | code + gutter | build |
| `ui_code_viewer_wrap_toggle` | `feat_emit_html` | client | — | build |
| `ui_code_viewer_build_status` | `feat_export` | `listOut` + `stat` (`mapLimit(8)`) | footer | build |

## `/p/[id]/editor` ↔ `screen_editor` — GrapesJS thật, không có mockup Stitch (chỉ token + chrome)

| ui_id | Feature | API / nguồn | Mockup (vùng) | Trạng thái |
|---|---|---|---|---|
| `ui_editor_page_header` | `feat_editor` | — | — | build |
| `ui_editor_toolbar` | `feat_editor` | `GET/POST …/editor*`, `?page=` | — | build |
| `ui_editor_canvas_chrome` | `feat_editor`, `feat_ir` | GrapesJS | — | build |
| `ui_editor_effects_panel` | `feat_editor` | `effects` | — | build |
| `ui_editor_sections_panel` | `feat_editor`, `feat_ir` | `…/editor/promote-layout` | — | build |

## Drift — danh sách chính thức (59 id, không render, không implement)

Không `ui_*` nào nối tới `drift_*`, trừ `ui_history_inject_auth` (out_of_scope) ↔ `drift_history_inject_auth`.

| drift id | Chuỗi / phần tử Stitch | Mockup |
|---|---|---|
| `drift_history_cloudflare_bot` | "Cloudflare Bot Management Challenge" (hàng failed) | `history.html` |
| `drift_history_cluster_metrics` | us-east-core, Concurrency 8 jobs, Daemon :4421, CLI daemon workers | `history-alt1.html` |
| `drift_history_engine_filter` | Engine filter (Playwright DOM / Puppeteer / Static Wget AST) | `history.html` |
| `drift_history_fake_engines` | Chromium Headless, Playwright Spider, Wasm Synthesizer / Engine Pool | `history-alt2.html` |
| `drift_history_inject_auth` | nút "Inject Auth" trên hàng Cloudflare Turnstile | `history-alt1.html` |
| `drift_history_invented_nav` | Engines, DOM Rules, Tokens & Budget, Telemetry, Keyring & Auth, Run Test, Deploy Clone, CLONE//ARCH | `history-alt1.html` |
| `drift_history_nav_artifacts_audit` | Configure / Pipeline / Artifacts / Audit, Deploy Clone | `history.html` |
| `drift_history_stealth_engine` | "Puppeteer Stealth" | `history-alt3.html` |
| `drift_history_trace_button` | "Trace" / nút terminal trên hàng failed | `history-alt2.html` |
| `drift_history_cluster_telemetry` | Cluster us-east-core / concurrency 8 jobs / telemetry / Tokens & Budget sidebar | `history.html` |
| `drift_progress_system_telemetry` | Mem/CPU/Network, socket :9422, worker threads | `progress.html` |
| `drift_progress_turnstile_wording` | "Cloudflare Turnstile detected / headless browser clearance" | `progress.html` |
| `drift_sitemap_turnstile_bypass` | "Configure Turnstile Bypass" / "Turnstile pass" | `sitemap.html` |
| `drift_sitemap_capture_telemetry` | cột cached, asset KB; Engine DOM v3 + Tailwind JIT | `sitemap.html` |
| `drift_sitemap_extra_nav` | Projects / Pipelines / Diff QA / Templates / Execution IR / Asset Store | `sitemap.html` |
| `drift_new_clone_fake_telemetry` | PIPELINE SYNTH_CHROMIUM_V8, cluster us-east-1a, DNS IP | `new-clone.html` |
| `drift_new_clone_figma_tokens` | output "Figma Tokens (DTCG schema)", "Markdown" | `new-clone.html` |
| `drift_new_clone_nav_artifacts_audit` | Configure / Pipeline / Artifacts / Audit, Deploy Clone, Engine Pool | `new-clone.html` |
| `drift_new_clone_cookie_vault` | "Session Cookie Vault" / "Save as preset" | `new-clone.html` |
| `drift_qa_preview_auto_reconcile_css` | "Auto-reconcile CSS" / "Approve & Deploy" | `qa-preview.html` |
| `drift_qa_preview_fake_engine_labels` | Puppeteer Headless, Vite + Tailwind JIT, AST v3.1, DPR 2.0x | `qa-preview-alt.html` |
| `drift_qa_preview_fake_telemetry` | AST Worker Node #4, DOM nodes, latency, memory | `qa-preview.html` |
| `drift_qa_preview_invented_nav` | Projects, Pipelines, Templates, Execution IR, Asset Store, System Logs, Terminal CLI, PID | `qa-preview.html` |
| `drift_code_viewer_devbrowser_brand` | "DevBrowser static generator" | `code-viewer.html` |
| `drift_code_viewer_git_branch` | Git tab / "main branch" / "Synced 2m ago" | `code-viewer.html` |
| `drift_settings_ai_aes_vault_claim` | "Stored with AES-256 GCM in local daemon vault" | `settings-ai.html` |
| `drift_settings_ai_audit_export` | Audit Logs / Export Config (JSON) | `settings-ai.html` |
| `drift_settings_ai_failover_router` | Failover strategy / fallback router to local vLLM | `settings-ai.html` |
| `drift_settings_ai_fake_model_ids` | claude-3-7-sonnet-20250219, gpt-4o, qwen-2.5-coder | `settings-ai.html` |
| `drift_settings_ai_telemetry` | Upstream Telemetry (requests/error rate/latency, uptime, gateway port) | `settings-ai.html` |
| `drift_shell_version_chips` | "v2.4.0-edge • PID 4921", "Daemon v2.4.0", "CORE v2.4.0-rc1", "WebClone Core", "PID 4921 DAEMON SYNC" | mọi mockup (header/sidebar trên) |
| `drift_shell_workspace_switcher` | "Project Alpha" + chọn workspace | `new-clone.html`, `history*.html` |
| `drift_shell_notification_bell` | chuông thông báo + chấm cam | mọi mockup (header phải) |
| `drift_shell_terminal_cli` | icon terminal, nút "Terminal CLI" | mọi mockup |
| `drift_shell_tune_icon` | icon `tune` ở header | mọi mockup |
| `drift_shell_avatars` | avatar "DX" / "WC" / "CL" | mọi mockup (header phải) |
| `drift_shell_docs_links` | "Docs", "API Proxy Docs" | header, sidebar dưới, footer settings |
| `drift_shell_task_ids` | "Task #8942", "#8942-PRICING", "Diff QA #8942", crumb "Pipelines" | `sitemap.html`, `progress.html`, `qa-preview.html` |
| `drift_history_page_type_badges` | badge thumbnail DOM / SPA / AUTH / DOCS / HTML / ERR | `history*.html` |
| `drift_history_target_wording` | "Target: DOM + CSS Assets", "Target: Full SPAs • SSR hydration dump", "HTML+Tailwind export • 18.4MB bundle • Zero diff errors", "ready • bundle exported" | `history*.html` |
| `drift_history_copy_icon` | icon copy/docs trên hàng completed | `history.html` |
| `drift_new_clone_task_config_chips` | "TASK CONFIG 0X88F", "READY", "DOM v3 Parser • Headless Chromium" | `new-clone.html` |
| `drift_new_clone_polite_rate_badge` | "Polite rate limiting active", hint "limit/hops/workers", hậu tố "PGS/LVL/THRD" | `new-clone.html` |
| `drift_new_clone_fidelity_badge` | "HIGH FIDELITY" | `new-clone.html` |
| `drift_new_clone_budget_helper_copy` | "Allocated for AST layout synthesis, multi-pass stylesheet reconciliation, and icon vectorization.", "Target AST dialect" | `new-clone.html` |
| `drift_sitemap_stage_chip` | "Stage 3: AST Scoping" | `sitemap.html` |
| `drift_sitemap_har_import` | "Inject Cookies (.har)" (bản hợp lệ = cookie/storageState JSON) | `sitemap.html` |
| `drift_settings_ai_version_badges` | "v2.4-gateway", "ROUTER ACTIVE", "MATRIX v1.2", "GATEWAY" | `settings-ai.html` |
| `drift_settings_ai_role_badges` | "High Precision", "Low Latency", "Token Extractor" + mô tả vai trò sai | `settings-ai.html` |
| `drift_settings_ai_extra_kinds` | badge "VLLM / OAI", "OLLAMA" | `settings-ai.html` |
| `drift_settings_ai_config_id_line` | "ID: prov_anthropic_v1 // status: 200 OK" | `settings-ai.html` |
| `drift_settings_ai_model_cache_age` | "Cached 4 mins ago", "Sync: OK" | `settings-ai.html` |
| `drift_progress_worker_tags` | "[worker#01]", "Thread #04", "stdout & ast-worker.log PID 4921" | `progress.html` |
| `drift_qa_preview_pixel_qa_badge` | "Pixel QA 1 Diff" | `qa-preview.html` |
| `drift_qa_preview_source_ref` | "card-hero.tsx:42" (output là HTML thuần) | `qa-preview.html` |
| `drift_qa_preview_synthesis_wording` | "SYNTHESIS COVERAGE CHECKLIST", "verified", "untriggered" | `qa-preview.html` |
| `drift_code_viewer_build_successful` | "Build Successful" | `code-viewer.html` |
| `drift_code_viewer_export_package` | nút "Export Package" (trùng Export ZIP) | `code-viewer.html` |
| `drift_code_viewer_encoding_label` | "HTML5 / UTF-8" | `code-viewer.html` |
````

- [ ] **Step 3: Count check** — the doc has 122 `build` rows, 4 `out_of_scope`, 3 `alias`, 59 drift rows:

```bash
node -e '
const t = require("fs").readFileSync("docs/superpowers/design/stitch-screens.md", "utf8").split("\n");
const n = (re) => t.filter((l) => re.test(l)).length;
console.log({ build: n(/^\| `ui_.*\| build \|$/), out: n(/\| out_of_scope \|$/), alias: n(/\| alias → /), drift: n(/^\| `drift_/) });
'
```
Expected: `{ build: 122, out: 4, alias: 3, drift: 59 }`.

- [ ] **Step 4: SP1 spec §10 pointer** — in `docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md`, after the §10 table (right before the "Adapter editor:" line) add the line:

```markdown
Bố cục, token và element từng màn: xem `2026-09-24-sp1-ui-stitch-parity-design.md`.
```

- [ ] **Step 5: Local drift list (not committed)** — append the 29 new ids of spec §5 (`drift_shell_version_chips` … `drift_code_viewer_encoding_label`, same wording as the table above, one `- <id> : <chuỗi>` line each) to `.superpowers/sdd/2026-09-23-sp1-clone-engine/drift-list.md`. Do not `git add` it (the directory is gitignored).

- [ ] **Step 6: Commit (docs only)**

```bash
git add docs/superpowers/design/stitch-screens.md docs/superpowers/specs/2026-09-23-sp1-clone-engine-design.md
git commit -m "docs: element-level Stitch map + official drift list (59), SP1 §10 pointer" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Controller step (after Task 15 — not an implementer task)

1. Run `/graphify docs --update`.
2. Check the result against spec §6.5: 122 `ui_*` nodes (ids of spec §3), each linked to its `screen_*` (references) and ≥1 `feat_*`; the 29 new `drift_*` nodes linked to their `screen_*`; 4 out-of-scope nodes and 3 aliases as in spec §3.9; no `ui_*` → `drift_*` edge except `ui_history_inject_auth`. Verify with `/graphify explain screen_<x>` for the 8 screens.
3. Final gate (spec §7.6): `npx tsc --noEmit`, `npx vitest run`, `npx vitest run -c vitest.e2e.config.ts` all green; `npx next build` 0 warnings; the 1440 parity shots of Tasks 7–14 reviewed against the Stitch PNGs; every row of spec §3.10 has its `data-ui` in code (Task 15 Step 1 prints 122).
