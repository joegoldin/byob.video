# Legacy data migration

The migration tools are implemented for staging validation. Production export,
traffic freeze, import, session compatibility and rollback acceptance are still
required before cutover. Do not retire Fly or its volume on the strength of a
local round trip.

## Export

Run the exporter against a consistent SQLite backup that includes committed WAL
contents. Copying only the main database file while Fly is writing is not a
backup. Keep the original database and volume available for rollback.

From the repository root, inside the development shell:

```fish
mix run --no-start workers/scripts/export-legacy.exs /private/backup/byob.db /private/backup/byob-export.json
```

The exporter opens SQLite read-only and uses a read transaction for both tables.
It does not start Phoenix or Persistence, so the legacy 30-day pruning process
cannot delete old rooms during export. It decodes ETF with safe decoding,
serializes durable media/history/activity dates, and omits VM references,
transports, presence and timers. Unknown schemas or unsupported values fail the
export instead of silently discarding a room.

The output includes API keys. It is created exclusively, with mode0600 before
credentials are written; an existing file or symlink is refused. Standard output
contains only counts and a SHA256 checksum. Store that checksum with the backup.
Never commit or upload the export as a CI artifact.

## Import

The temporary gateway is a separate Worker. The public application has no HTTP
migration route. Without `MIGRATION_TOKEN`, the gateway returns404. Imports
require a bearer token, reject browser Origin headers and limit request bodies
to1MiB. The importer refuses credential-bearing URLs and redirects.

`workers/wrangler.migration.jsonc` currently binds only to
`byob-video-preview`. It is not a production configuration. Deploying the gateway
and setting its temporary secret are separate release actions, not part of the
local test command. Verify the target namespace before using production data.

After configuring a verified gateway, set `MIGRATION_TOKEN` securely in your
shell environment, then run from `workers/`:

```fish
corepack pnpm migrate:import /private/backup/byob-export.json https://your-migration-gateway.workers.dev THE_EXPORT_SHA256
```

The CLI verifies file permissions and checksum before sending credentials. It
validates room records before making requests and submits bounded pool batches.
Only counts and the checksum are printed. A failed request stops the run; retry
the exact same file after resolving the error.

Room imports preserve IDs, API keys, queue item IDs, history, activity,
SponsorBlock settings, playback rate and the saved wall-clock anchor. A playing
snapshot advances at its saved rate; native playback clamps to media duration.
Paused positions remain exact. Old monotonic-clock values, connected users and
runtime timers are not restored. Imported rooms and the pool do not acquire
periodic idle alarms.

Pool imports preserve first-seen, last-seen and last-picked timestamps exactly,
including separate rows for the same video in different source buckets. A legacy
null thumbnail receives the standard YouTube thumbnail URL; rows are not dropped
for that legacy nullable field.

Imports are resumable, not a cross-object transaction. Room records and pool
batches are individually atomic. Receipts make an identical retry a no-op even
if the room has subsequently changed or a video has been picked again. Different
input for an already imported key, or any collision with native-created data,
is rejected rather than overwriting it. Investigate conflicts; do not delete live
state to force an import through.

After successful production verification, remove the temporary gateway and its
secret. Preserve the original backup and export for the agreed rollback period.

## Local evidence

- `mix test --no-start test/byob/legacy_export_test.exs`: read-only ETF export,
  source database byte preservation, historical dates, pool timestamps, private
  output and overwrite/schema rejection.
- `corepack pnpm test`: SQLite import preservation, atomicity, idempotency,
  collision refusal and gateway security boundaries.
- `corepack pnpm test:migration`: real legacy SQLite/ETF fixture through the
  export/import tools and authenticated cross-worker workerd RPC, original API
  key authentication, persisted history/queue, exact pool timestamps, eviction
  and dormant alarms.
- `corepack pnpm check:migration`: package the temporary gateway without deploying.

These checks do not establish production backup completeness, traffic freeze,
legacy cookie/token continuity, cutover success or rollback readiness.

## Production-data preflight evidence

A consistent read-only `VACUUM INTO` snapshot of Fly's live SQLite database,
including committed WAL contents, passed `integrity_check`: 87 rooms and 14,760
pool rows. It was retrieved into a private directory with mode0600 and its
SHA256 matched the source. The final cutover still requires a fresh snapshot
after freezing writes; this preflight is not that snapshot.

The real export exposed two compatibility gaps. Transient references contained
an old VM node atom unknown to the exporter. A bounded structural ETF traversal
now selects durable fields before `binary_to_term(..., [:safe])`, without creating
atoms from database contents. Regression tests cover foreign-node references,
unknown retained atoms, truncation and nesting limits. The importer also now
accepts the legitimate `ended` state used by both implementations, preserving it
rather than restarting playback.

Run `b15250376` imported all 87 rooms and 14,760 pool rows into private temporary
local workerd storage. It verified room identities, original API keys,
queue/history/playback, exact pool timestamps, API authentication after eviction,
and idempotent retry. Temporary test storage was removed. No production data was
sent to Cloudflare by this rehearsal. To repeat against a private export:

```fish
cd workers
node test/migration-preflight.integration.mjs /private/backup/byob-export.json
```

`wrangler.production.jsonc` and `wrangler.migration-production.jsonc` isolate the
production application and gateway from preview. Both pass packaging dry runs;
the application has no production-domain routes configured yet. CI checks both
production packages as well as preview. Neither production deployment nor import
is established by these dry runs.

## Hosted preview evidence

The isolated preview is `https://byob-video-preview.joe-eb3.workers.dev`.
Application version `6304cfb9-e651-4aaa-8216-bf1aedef0e73` passed actual hosted
health/assets, two browser channels, private credentials, REST authorization,
queue broadcasts, current-host self-reference protection and exact paused
position across reload (`b316b31fb`). This caught a readiness race locally
reproduced and fixed: explicit playback controls now cancel older load deadlines.

Run `b2ce33dc5` generated synthetic legacy SQLite data with a fresh random room
ID/API key and exported it through the actual Elixir exporter. The existing CLI
imported it through a separately deployed preview-only gateway into hosted room
and pool Durable Objects. Original-key access, paused position, queue fields,
repeat-import idempotency, conflict refusal and Origin/auth boundaries passed.
No production data or production signing secret was used. Hosted private pool
timestamps/history were not independently inspected; those retain local workerd
round-trip evidence rather than a new hosted-inspection claim.

The temporary `byob-migration-preview` gateway was then deleted and its endpoint
verified to return404. The preview application remains deployed. These results
do not replace production backup, freeze, import, session continuity or rollback
acceptance.

## Authentication transition

The native Worker can temporarily verify legacy Plug session cookies and Phoenix
extension tickets. Compatibility is disabled unless both `LEGACY_SECRET_KEY_BASE`
(a secret binding containing the original Phoenix signing secret) and
`LEGACY_AUTH_UNTIL` (an absolute Unix timestamp in milliseconds) are configured.
Never place the signing secret in Wrangler configuration, source, or logs.

A valid `_byob_key` session retains its UUID when exchanged for the native secure
cookie. Existing `byob_tab_id` session storage retains the tab suffix. Once the
native cookie exists it takes precedence, and subsequent visits do not need the
legacy secret. Legacy extension signatures are accepted only on the extension
socket endpoint, with their original one-day lifetime; they cannot authenticate
browser sockets. Old room-only extension tickets retain the legacy behavior of
an unassociated peer rather than claiming someone else's owner identity.

Verification uses PBKDF2/HMAC matching Plug and decodes only a bounded ETF subset
after signature verification. Compressed terms, VM references, arbitrary atoms,
oversized tokens, malformed terms and invalid identities are rejected. Remove
the legacy secret after the chosen transition window. Actual production secret
configuration and the transition of already-open LiveView pages still require
release verification.

### Verified WebSocket page transition

`corepack pnpm test:legacy-page` runs the installed Phoenix/LiveView browser
client against workerd, then loads the real native frontend. The test uses the
configured worker-first routes and verifies exactly one page reload, the same
room URL, the original cookie UUID and the original tab ID. This passed in
Chromium154.0.8037.97 and Firefox150.0.2 in run `b388f4bac`, alongside precommit,
157 JavaScript tests, the data/authentication migration integration and a deploy
dry-run. No production deployment was performed.

During the configured compatibility window, `/live/websocket` answers a join
with Phoenix's stale-session response. It does not replay old mutations. The
connection closes after the response, or after five seconds without a join.
Cross-origin connections are rejected; the bridge is disabled after the cutoff.

Long-poll clients are also covered locally. The temporary `/live/longpoll`
endpoint carries signed stale-join replies in a short-lived, per-connection
HttpOnly cookie, then clears it when polled. It stores no legacy session on the
server and never replays mutations. Connection tokens expire after30seconds;
request/frame sizes, cookie size and cross-origin access are bounded.

`BYOB_LEGACY_LONGPOLL=1 corepack pnpm test:legacy-page` passed in both Chromium
and Firefox with browser WebSockets blocked. Both reloaded exactly once into the
native HTTP fallback and retained their original identity. Runs `bfd09bc29` and
`bfbd8e824` also passed the full native HTTP-only playback/UI matrix in Chromium
and Firefox, the default Chromium WebSocket regression suite, migration tests,
precommit and a deployment dry-run. These are local checks, not production
cutover evidence.
