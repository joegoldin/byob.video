# byob development

The application runs on Cloudflare Workers with SQLite-backed Durable Objects.
There is no Elixir, Phoenix server, Mix or Hex build dependency.

## Structure

- `workers/src/`: native backend, room state, synchronization and provider services.
- `workers/web/`: browser application, views, styles and channel transport.
- `assets/js/`: shared video adapters, synchronization and animation hooks.
- `extension/`: Chromium/Firefox extension and its standalone channel client.
- `assets/static/`: public images, favicon and robots file.

## Checks

From `workers/`, run `corepack pnpm precommit` after changes. It checks JavaScript
syntax, JSON, release-version consistency, the locked extension client, and unit
regressions. Also run `corepack pnpm test:runtime`, `test:migration`, `check:deploy`,
`check:migration`, and `check:production` for backend, dependency or release changes.

UI changes need browser acceptance (`corepack pnpm test:browser`). Test theater
scrolling in Chromium and Firefox; `BYOB_THEATER_ONLY=1` runs the focused checks.
Respect reduced motion and leave touch/mobile and nested panel scrolling native.

## Conventions

- Match existing JavaScript modules and use platform APIs before dependencies.
- Render untrusted values through `html` in `workers/web/html.mjs`; never build raw
  HTML from user-controlled strings. Keep URLs validated and secrets out of logs.
- Tailwind v4 and daisyUI are locked npm dependencies. Styles live in
  `workers/web/app.css`. New UI should use compact, accessible controls.
- Keep the 24-hour pnpm release-age policy and explicit build-script approvals.
- Preserve Durable Object migrations and stored data during upgrades.
- Bump `VERSION`, `workers/package.json` and both extension manifests together;
  update `CHANGELOG.md`.
- Pushes to main deploy only after required CI. Verify both production domains
  with `node scripts/verify-deployment.mjs` from `workers/`.
- Captured regression fixtures in `workers/test/fixtures/` retain pre-migration
  behavior without executing the retired server. Their provenance is documented.
