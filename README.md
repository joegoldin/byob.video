# byob — bring your own binge

Watch videos together in sync. Free, open source, self-hostable.

**[byob.video](https://byob.video)** · [Chrome Extension](https://chromewebstore.google.com/detail/jlpogmjckejgpbbfhafgjgkbnocjfbmb) · [Firefox Extension](https://addons.mozilla.org/en-US/firefox/addon/byob-bring-your-own-binge/) · [Discord Bot](https://github.com/joegoldin/byob-discord-bot)

## What it does

Create a room, share the link, paste video URLs, watch together. Play, pause, seek,
and playback speed synchronize across participants.

- **YouTube:** embedded playback, SponsorBlock and comments.
- **Vimeo:** embedded playback.
- **Direct video:** browser-supported media files, including MP4 and WebM. Codec
  support depends on your browser; a file extension alone does not guarantee playback.
- **Other streaming sites:** the browser extension connects an external player
  window. Site restrictions, DRM and browser permissions can limit compatibility.

## Features

- Shared queue, drag-to-reorder, history and automatic advance
- SponsorBlock categories configured per room
- Roulette and voting backed by a shared video pool
- Queue/history right-click actions and timestamped activity
- On-demand paginated comment replies with collapsible threads
- Connected-user presence
- Private room API keys for bots and integrations
- Persistent rooms, queues and history across Worker restarts
- Dark and light themes; responsive desktop and mobile layouts
- WebSocket synchronization with an HTTP fallback when WebSockets are blocked

## v7 architecture and migration

Production runs on **Cloudflare Workers**, with SQLite-backed Durable Objects
for individual rooms and the shared video pool. Hibernating WebSockets and
bounded HTTP streams carry room events. The frontend uses the existing player
adapters and synchronization hooks, styled with Tailwind and daisyUI. There are
no Cloudflare Containers or always-running application servers in this path.

Both `byob.video` and `www.byob.video` serve Workers. The final migration imported
88 rooms and 14,769 pool records; all 88 original API keys were subsequently
verified on the production domain. The temporary migration gateway is removed.

The legacy Elixir/Phoenix application remains in this repository as a behavioral
reference, migration source and rollback asset. Its Fly application is frozen;
its machine, volume and private backups are retained. **Do not restart Fly while
Workers accepts writes:** rollback must account for post-cutover changes.
Legacy session and extension-ticket compatibility has an absolute cutoff that
normal deployments do not extend.

See [migration and rollback details](docs/cloudflare-data-migration.md),
[Workers contracts](docs/cloudflare-contracts.md), and
[synchronization research](docs/video-synchronization-research.md). The production data cutover and main-push automatic deployment are verified.
The faster deployment workflow checks both public domains against the exact
HTML, JavaScript and CSS hashes from its build.

## Scaling and cost guardrails

- A single SQLite-backed admission registry gates **100 active rooms globally**,
  including simultaneous creates, named-room bootstrap and saved-room reactivation.
  Full capacity returns HTTP429 with an explicit message.
- After **24 hours without a connected viewer**, a room releases its slot and
  retires transient state through a one-shot alarm. Its queue, history and API key
  remain saved. Returning to it needs a free slot; API mutations also count as
  activity. Existing eight-hour deadlines are upgraded without resetting when
  the empty period began.
- Each room permits **32 browser/extension connections** in total. A connection
  exceeding60 messages per second is closed; playback controls and upstream
  services have additional limits. Queue/history/activity and request bodies are
  bounded, and ordinary drift reports do not write room SQLite state.
- Per-IP limits restrict creates and joins; authenticated API reads/mutations and
  provider calls are rate-limited. Provider calls have bounded responses/timeouts,
  coalescing, caching and quota-exhaustion handling. Idle rooms do not poll.

These are application limits, **not a guaranteed dollar cap**. Requests rejected
by the Worker still reach Cloudflare, rate-limit bindings are not a global billing
budget, saved rooms consume storage, and a valid busy room can generate traffic.
Keep Cloudflare usage alerts and plan-specific CPU/billing controls configured
for your account. The app does not silently change account-wide spending settings.

## Local development

Use the pinned [devenv](https://devenv.sh/) environment for Node, BEAM and the
migration/parity tools. Commands below use fish shell syntax.

```fish
devenv shell
cd workers
corepack pnpm install --frozen-lockfile

# Create a private local signing secret once; refuses to overwrite an existing file.
node --input-type=module -e 'import {writeFileSync} from "node:fs"; import {randomBytes} from "node:crypto"; writeFileSync(".env", "TOKEN_SECRET=" + randomBytes(32).toString("hex") + "\n", {mode: 0o600, flag: "wx"});'

corepack pnpm dev
# http://localhost:18789
```

Wrangler loads `workers/.env` for local development; `.env` files are git-ignored.
Do not commit secrets. Set `YOUTUBE_API_KEY` there if you need YouTube Data API
features such as comments. Optional services can be unavailable without making
video playback fail.

The default `workers/wrangler.jsonc` targets the isolated preview Worker.
`workers/wrangler.production.jsonc` defines the production Worker, bindings and
both public-domain routes. Change names, account configuration and routes before
deploying your own instance; do not use this repository's production destinations
for a separate installation.

### Checks

From the repository root, inside the development shell:

```fish
mix precommit
cd workers
corepack pnpm test
corepack pnpm test:runtime
corepack pnpm test:migration
corepack pnpm check:deploy
corepack pnpm check:production

# On a supported Playwright host (CI uses Ubuntu 24.04):
set -gx PLAYWRIGHT_BROWSERS_PATH "$HOME/.cache/ms-playwright"
corepack pnpm exec playwright-core install --with-deps chromium firefox
set -gx CHROMIUM_PATH (node --input-type=module -e 'import {chromium} from "playwright-core"; console.log(chromium.executablePath())')
set -gx FIREFOX_PATH (node --input-type=module -e 'import {firefox} from "playwright-core"; console.log(firefox.executablePath())')
corepack pnpm test:browser
env BYOB_BROWSER=firefox BYOB_HTTP_ONLY=1 corepack pnpm test:browser
```

Browser tests also need `ffmpeg`. `CHROMIUM_PATH` and `FIREFOX_PATH` select
installed browser executables when needed; on NixOS, use compatible Nix-packaged
browsers instead of the Playwright installation command. The optional
**Workers browser acceptance (manual)** GitHub workflow covers Chromium and
Firefox over both WebSocket and HTTP transports, legacy-page transitions, the
packaged Chromium extension, and delayed playback. Browser tests do not run on
every push; run them locally during development or trigger that manual workflow. The measured canonical-drift bound is
350 ms; it is not a claim about physical display/audio skew on every device.

Live-provider checks are separate from deterministic fixtures:

```fish
corepack pnpm test:providers
# Focus a provider while investigating it:
env BYOB_PROVIDER=youtube corepack pnpm test:providers
```

Real YouTube playback and native speed controls have passed. The current live
Vimeo check is blocked by the provider's connection restriction (HTTP401); its
adapter remains unchanged. This is an explicit verification limitation, not a
passing live Vimeo result.

## Deployment

The Workers workflow deploys pushes to `main` only after required acceptance
jobs pass: precommit, unit/oracle, Workers-runtime, migration, and deployment
packaging. The browser matrix is opt-in rather than a push/deployment dependency.
Main deployments are serialized and are not cancelled mid-upload.
It then verifies health and exact HTML/JavaScript/CSS build hashes on both public
domains. Configure the `CLOUDFLARE_ACCOUNT_ID` repository variable and a scoped
`CLOUDFLARE_API_TOKEN` Actions secret; never copy a local Wrangler OAuth token
into CI. See the [deployment setup](docs/cloudflare-data-migration.md#automated-production-deployment)
for permissions and credential handling. Production credentials are configured;
a real main-push run passed acceptance, deployed the Worker and verified both
domains. The browser matrix remains available as a manual development check.

For an explicitly authorized manual production deployment, after acceptance:

```fish
cd workers
corepack pnpm build:web
corepack pnpm exec wrangler deploy --config wrangler.production.jsonc
node scripts/verify-deployment.mjs
```

Production signing and service credentials are Worker secrets. Deployments
preserve existing secrets and Durable Object storage; they do not repeat the
migration, restart Fly or reset the legacy-auth cutoff. The old Docker/Fly
configuration is retained for the legacy application, not the v7 deployment path.

## Build extensions

```fish
just chrome    # result-chrome/
just firefox   # result-firefox/
```

The source manifests are version7.0.0. Store listings have their own publishing
and review process; a Worker deployment does not publish browser-store packages.

## API

Documentation is served at `/api`. Create rooms, manage queues and control
playback programmatically:

```fish
curl -X POST https://byob.video/api/rooms
# {"ok":true,"data":{"room_id":"abc123","url":"https://byob.video/room/abc123","api_key":"..."}}
```

Keep the returned key private and use it in the `Authorization: Bearer` header
for room requests. Playback commands require a numeric position. Room keys are
not broadcast to peers or embedded in public page markup.

## License

MIT — See [LICENSE](LICENSE)
