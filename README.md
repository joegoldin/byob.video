# byob — bring your own binge

Watch videos together in sync. Free, open source, self-hostable.

**[Try byob.video](https://byob.video)** · [Chrome Extension](https://chromewebstore.google.com/detail/jlpogmjckejgpbbfhafgjgkbnocjfbmb) · [Firefox Extension](https://addons.mozilla.org/en-US/firefox/addon/byob-bring-your-own-binge/) · [Discord Bot](https://github.com/joegoldin/byob-discord-bot)

## Watch together

Create a room, share the link, and paste a video URL. Play, pause, seek, and
playback speed stay synchronized across participants. No account required.

- **YouTube** — embedded playback, SponsorBlock, comments, and expandable replies.
- **Vimeo** — embedded playback.
- **Direct video files** — MP4, WebM, and other formats your browser can play.
- **Other streaming sites** — connect an external player window through the
  browser extension. Compatibility depends on the site, DRM, and browser permissions.

## Features

- Shared queue with drag-to-reorder, automatic advance, and right-click actions
- Watch history with replay and requeue
- Roulette and voting to choose what to watch next
- Per-room SponsorBlock settings
- Timestamped activity and connected-user presence
- Dark and light themes with desktop and mobile layouts
- Persistent queues, history, and room settings
- REST API for bots and integrations
- HTTP fallback when WebSockets are unavailable

## How it works

Cloudflare Workers serves the app. SQLite-backed Durable Objects manage room
state and a shared video pool, while hibernating WebSockets carry synchronization
events. The frontend uses JavaScript player adapters, Tailwind CSS, and daisyUI.

The browser extension connects supported players on external sites to a room.
It does not bypass a site's access requirements or DRM.

## Development

Use [devenv](https://devenv.sh/) for the pinned development tools. Commands below
use fish shell syntax.

```fish
devenv shell
cd workers
corepack pnpm install --frozen-lockfile

# Generate a local signing secret. This refuses to overwrite an existing file.
node --input-type=module -e 'import {writeFileSync} from "node:fs"; import {randomBytes} from "node:crypto"; writeFileSync(".env", "TOKEN_SECRET=" + randomBytes(32).toString("hex") + "\n", {mode: 0o600, flag: "wx"});'

corepack pnpm dev
```

Open **http://localhost:18789**. Wrangler loads local settings from `workers/.env`,
which is git-ignored. Add `YOUTUBE_API_KEY` to enable YouTube Data API features
such as comments. Keep credentials out of source control.

### Tests

From the repository root, inside the development shell:

```fish
mix precommit
cd workers
corepack pnpm test
corepack pnpm test:runtime
corepack pnpm test:migration
corepack pnpm check:deploy
```

Browser tests are opt-in and require `ffmpeg` plus compatible Chromium or Firefox
executables. On a supported Playwright host:

```fish
set -gx PLAYWRIGHT_BROWSERS_PATH "$HOME/.cache/ms-playwright"
corepack pnpm exec playwright-core install --with-deps chromium firefox
set -gx CHROMIUM_PATH (node --input-type=module -e 'import {chromium} from "playwright-core"; console.log(chromium.executablePath())')
set -gx FIREFOX_PATH (node --input-type=module -e 'import {firefox} from "playwright-core"; console.log(firefox.executablePath())')

corepack pnpm test:browser
env BYOB_BROWSER=firefox BYOB_HTTP_ONLY=1 corepack pnpm test:browser
env BYOB_NETWORK_PROFILE=delayed corepack pnpm test:browser
```

On NixOS, point `CHROMIUM_PATH` and `FIREFOX_PATH` at compatible Nix-packaged
browsers instead. The **Workers browser acceptance (manual)** GitHub workflow
runs the browser and transport matrix on demand, not on every push.

`corepack pnpm test:providers` contacts real video providers. Their availability,
embed policies, and network restrictions can affect the result.

### Build extensions

```fish
just chrome    # result-chrome/
just firefox   # result-firefox/
```

## Self-hosting on Cloudflare

The app uses Workers and SQLite-backed Durable Objects. Before deploying a fork,
update the Worker names, account settings, and routes in the Wrangler configs:

- `workers/wrangler.jsonc` — preview and local development
- `workers/wrangler.production.jsonc` — production

Configure `TOKEN_SECRET` as a Worker secret, using a securely generated random
value. Add `YOUTUBE_API_KEY` if you want the YouTube Data API features.

```fish
cd workers
corepack pnpm exec wrangler secret put TOKEN_SECRET --config wrangler.production.jsonc
corepack pnpm exec wrangler secret put YOUTUBE_API_KEY --config wrangler.production.jsonc
corepack pnpm build:web
corepack pnpm exec wrangler deploy --config wrangler.production.jsonc
```

The production config includes this project's public domains. Replace them with
your own before deploying. The deployment verification script also targets
`byob.video` and `www.byob.video`; update it for your installation.

### Automatic deployment

Pushes to `main` run precommit, unit/oracle, runtime, migration, and packaging
checks before deploying. Deployment then verifies health and exact frontend
build hashes on both public domains. Browser tests remain opt-in.

Configure these GitHub Actions settings for your installation:

| Setting | Type | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | Repository variable | Target Cloudflare account |
| `CLOUDFLARE_API_TOKEN` | Repository secret | Deploy Worker code and routes |

Restrict the token to the deployment account and zone, with **Workers Scripts:
Edit**, **Workers Routes: Edit**, and **Zone: Read** permissions. Keep the token
in GitHub Secrets, not in a file or workflow. Deployments preserve Worker secrets
and Durable Object storage.

### Resource limits

The application defaults to:

- **100 active rooms globally**, including new rooms and saved-room reactivation
- **32 connections per room**, counting browser and extension connections
- **24-hour empty-room retirement**, releasing capacity while retaining queues,
  history, and API keys; returning to a saved room requires a free slot
- Per-IP creation/join limits, authenticated API limits, and provider-request limits
- Bounded queues, history, request bodies, and upstream responses

API mutations also count as activity. Idle rooms do not poll, and ordinary drift
reports do not write room state to SQLite.

These limits reduce resource use; they are **not a guaranteed spending cap**.
Traffic, rejected requests, and saved data can still incur Cloudflare charges.
Configure usage alerts and account-level controls appropriate to your deployment.

## API

Visit **[/api](https://byob.video/api)** for the API reference. Create a room with:

```fish
curl -X POST https://byob.video/api/rooms
# {"ok":true,"data":{"room_id":"abc123","url":"https://byob.video/room/abc123","api_key":"..."}}
```

Use the returned key in the `Authorization: Bearer` header for room requests.
Keep it private. Playback commands require a numeric position.

## License

MIT — See [LICENSE](LICENSE).
