# AI Web Clone Tool — SP1 (clone engine)

A local tool that clones a website into static HTML/CSS deterministically: the HTML is generated from the captured
DOM and computed styles; AI only names sections and fixes sections that fail the visual QA gate (pixel diff per
section at 375/768/1440, threshold 95%, at most 3 fix rounds).

## Prerequisites

- Node.js 24+ (developed on Node 26)
- Chromium for Playwright: `npx playwright install chromium`
- `npm install`

## Run

```sh
npm run build && npm start   # production build, served on http://127.0.0.1:3000 only
npm run dev                  # development server, also 127.0.0.1 only
```

Open http://127.0.0.1:3000, add an AI provider under **Cài đặt AI** (Anthropic- or OpenAI-compatible base URL +
API key, then pick a model per role: `vision`, `code`, `design`), and start a clone from **Clone mới**.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `WORKSPACE_ROOT` | `./workspace` | per-project workspaces (captures, assets, `out/`, browser profile) |
| `DB_PATH` | `./sp1.db` | SQLite database (projects, tasks, providers, graph) |
| `KEY_PATH` | `./secret.key` | AES-256-GCM key for API keys and remembered logins (created on first use) |
| `TOKEN_BUDGET` | `2000000` | default AI token budget per project (overridable per project) |
| `CDP_URL` | — | attach to an already running Chrome (`http://127.0.0.1:9222`) instead of launching Chromium |

## Tests

```sh
npx vitest run                          # unit tests
npx vitest run -c vitest.e2e.config.ts  # e2e (real Chromium; builds Next once for the UI tests)
npx tsc --noEmit                        # type check
npx next build                          # production build
```

## Security notes

- Local only: the server binds 127.0.0.1 and refuses any non-loopback `Host` (DNS rebinding); mutations need a JSON
  body and a same-origin `Origin` (CSRF). There is no login: do not expose it on a network.
- Cloned pages are served on the app origin with a CSP that allows only the clone's own `js/runtime.js`; downloaded
  assets keep a passive media extension (else `.bin`) and are served sandboxed.
- API keys and remembered credentials are encrypted at rest (AES-256-GCM), never logged, never sent to the AI.
- No CAPTCHA solving, no stealth/fingerprint spoofing, no anti-bot bypass. A login wall or CAPTCHA pauses the project
  as `needs_auth`; you log in yourself in the Chrome window the tool opens (or import a cookie/storageState JSON).
