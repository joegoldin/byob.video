# BYOB v7 compatibility contract

The Workers-native migration releases as **7.0.0**. `VERSION` remains the version
source for the application and both extension manifests. The Phoenix deployment
remains available as a fallback until the new deployment and data import are
verified. This document records acceptance requirements, not completed checks.

## Public interfaces

- `/`, `/room/:id`, `/api`, `/health` remain available. Room IDs accept lowercase
  letters/digits, 1–16 characters; newly created IDs remain eight characters.
- `POST /api/rooms` returns HTTP 201 and `{ok:true,data:{room_id,url,api_key}}`.
- Authenticated `/api/rooms/:id` routes retain room, queue and user reads;
  queue add/delete/reorder; skip/play/pause; and username changes. Bearer auth and
  the existing `api_key` query form remain compatible. Secrets must not appear
  in logs, static assets, public room snapshots or analytics.
- The existing extension speaks Phoenix Channels v2 over `/extension/websocket`.
  Preserve its topic/event/reply framing and event payloads, not Phoenix LiveView
  rendering internals. Tokens must authorize the specific room and owner identity.
  An extension is `ext:<owner_user_id>`, never an identity supplied by username.
- Per-tab browser identity, per-browser analytics identity, local usernames,
  nicknames, volume/theme/comments preferences and extension handoff remain.

Sources: `lib/byob_web/router.ex`, `controllers/api_controller.ex`,
`channels/extension_socket.ex`, `channels/extension_channel.ex`,
`lib/byob/events.ex`, `assets/js/sync/event_names.js`, `extension/background.js`.

## Room behavior

Preserve queue/current-index semantics; stable item IDs; add-now versus enqueue;
playlist selections; duplicate/stale ended-event protection; reorder/removal;
history replay; activity log; rename propagation; and current-media metadata/URL
updates. Queue changes reset playback rate and use the existing ready-then-play
quorum, excluding hidden tabs and respecting the 2.5-second loading deadline.

Preserve play/pause/seek/rate synchronization, 0.25–2× rate bounds, NTP-style
clock probes, per-user adaptive latency/tolerance/backoff, and visible-peer room
clock consensus. A hibernated room derives position from stored position,
playback rate and timestamp; do not persist or broadcast a ticking playhead.

Preserve extension open/ready tab reconciliation, same-owner deduplication,
5-second disconnect grace, autoplay countdown/cancellation, live-stream handling,
embed-blocked fallback and SponsorBlock settings/segments.

Roulette/voting retains balanced trending/subreddit/curated candidates,
queue exclusions, freshness/repeat weighting, single replaceable votes, no-vote
outcomes, stale-round rejection and seeded landing physics. Voting lasts 15 s;
roulette's active phase lasts 6.5 s, with existing reveal/finalization delays.
Persist deadlines and use Durable Object alarms only when a transition is due.

Sources: `lib/byob/room_server.ex`, `room_server/round.ex`, `sync_decision.ex`,
`pool.ex`, `assets/js/hooks/video_player.js` and the existing ExUnit tests.

## UI and upstream services

Reuse the YouTube, Vimeo, Twitch, direct-video and extension player modules and
clock/reconciliation/suppression logic. Preserve responsive layout, drag reorder,
queue/history menus, settings/stats, roulette/voting, comments/replies/pagination,
URL/playlist previews, player popups, notifications and theme preferences.
Video bytes remain direct from their provider, not relayed through Workers.
Metadata, comments and pool refreshes need bounded requests and caching; they
must not become arbitrary-URL proxies. Optional upstream credentials stay secret.

## Persistence and cost boundaries

The legacy SQLite `rooms.state` is an Erlang external-term BLOB, not JSON. Export
through Elixir's existing structs/migrations into a versioned, validated portable
snapshot. Preserve room IDs, API keys, queue/history/media and SponsorBlock
settings, and the shared `video_pool` rows including selection timestamps.
Do not serialize live PIDs/references, sockets or stale monotonic-clock values.
Protect export/import files and endpoints; validate before modifying live state.
Retain a verified backup and rollback path; do not delete the Fly volume.

Prefer Workers Static Assets and SQLite-backed Durable Objects with hibernating
WebSockets. No always-on server/container or recurring per-room intervals.
Persist mutations, use timestamp-derived playback, bound history/logs/queues,
rate-limit unauthenticated creation and authenticated mutations, and preserve
idle-room expiry. Browser heartbeat compatibility must not require keeping an
object resident. Include an explicit traffic/cost model and deployment limits.

## Required evidence

Legacy tests and `mix precommit`; protocol/state parity tests; real workerd
storage, alarms, hibernation/reconnect and multi-client tests; browser UI/player
and extension tests; migration round-trip and API-key preservation; frozen
build/security checks; deployment dry-run; preview and production smoke checks.
A passing unit suite or a Worker that merely serves the landing page does not
establish completion of this migration.

## Current verification and intentional corrections

The original ExUnit baseline passes (137 tests) with Elixir 1.19. The previous
Elixir 1.18/OTP 28 development-shell combination fails before tests because
PostHog's regex configuration cannot be escaped into a module attribute.

`workers/scripts/sync-oracle.exs` executes the original per-user sync module.
`room-sync-oracle.exs` extracts the original room handlers and helpers from their
AST, replacing only time, timer registration and PubSub delivery. Node tests
compare resulting state and event payloads, not just whether a seek happened.

The native clock intentionally corrects 1×-only position extrapolation at other
playback speeds. A test executes the original position function to demonstrate
the discrepancy and verifies the new rate-aware clock and continuous rate
changes. Browser/extension rate behavior still needs integrated verification.
Queue safety tests also require restarting the current item not to discard its
successor, and removing an item not to resurrect it through a stale readiness
deadline. These corrections must remain explicit rather than being described
as byte-for-byte legacy behavior.

Local SQLite tests verify atomic replacement, schema rejection, size limits,
API-key preservation, playback anchors and learned-latency checkpoints. They
are not evidence of real Durable Object storage or hibernation behavior. Socket
attachments must restore fresh per-peer measurements without a SQLite write
for each drift report; reconnects must retain the learned-latency checkpoint.

The actual workerd socket harness now forces Durable Object eviction with live
WebSockets and checks learned latency and correction streak recovery. SQLite
INSERT/UPDATE triggers observe zero room writes during ordinary drift reports;
a visibility mutation is the positive control for that instrumentation. This
is separate from rendered-browser/player quality, which remains a release gate.

Idle retirement uses one eight-hour deadline after creation, the last real
viewer leaves, or a headless API mutation. API actors are not live transports.
Retirement clears transient presence, not the room ID/API key, queue, history,
learned device state or pending durable work. It does not rearm itself. Native
hibernation already removes the old continuously resident GenServer cost;
retirement must not delete the persisted room. The old persistence service also
prunes 30-day snapshots. Native retirement deliberately retains durable room
data instead of replaying that startup deletion: migration does not discard
rooms based on age. Any future durable-data deletion needs a separate explicit
retention policy; the eight-hour transient cleanup is not that policy.

A hard-kill Wrangler test now joins a real browser channel, kills the whole
runtime process group without a close handshake, restarts with the same SQLite
storage, and verifies that the orphaned viewer leaves after the normal grace
period. Rehydration preserves live hibernated sockets and does not prolong
already-pending leaves. Test-only runtime probes verify actual idle alarms clear
once, retain API-key access, and leave no recurring idle/pool alarm; production
routing rejects those probes. At this milestone, 125 tests, both workerd
harnesses, and a 123.94 KiB / 31.00 KiB gzip deployment dry-run passed.

Metadata is fetched in durable, leased batches of at most three jobs. YouTube
API/oEmbed, Vimeo and OpenGraph enrichment update queue, history and activity;
stale results cannot overwrite a replacement URL. SponsorBlock uses the same
bounded work queue, prioritizes the playing video, and persists segments across
hibernation. Provider fixtures exercise delivery through real workerd sockets.
Requests have byte/time/redirect limits, validate every redirect target, and
strip private headers on cross-origin redirects. Direct media is not downloaded
for metadata. Literal-host filtering alone is not proof against DNS rebinding.
Hosted egress relies on Cloudflare's documented outbound proxy, which verifies
that destinations are public Internet services or the zone's own origin, rather
than internal services. See the [security model](https://developers.cloudflare.com/workers/reference/security-model/)
and [resolver behavior](https://developers.cloudflare.com/workers/platform/known-issues/),
reviewed 2026-10-29. A separate DNS lookup would not pin fetch's resolution and
is not substituted for that network boundary. This deployment has no VPC/private
network bindings. Local workerd does not inherit every hosted security defense:
keep local development loopback-only and use fixture upstreams in tests. The
production configuration and real public-provider egress still require release
acceptance; documentation is not an executed production test. Metadata cache
lifetime is 24 hours, SponsorBlock one hour, and failed lookups one minute.

YouTube comments retain author/avatar/text/likes/date/reply-count fields and
pagination. Initial pages are broadcast for the current video; reconnecting
browser clients request `comments:load`, and `comments:load_more` carries the
returned `page_token` and replies only to that viewer. Timestamp clicks use
`comments:seek` and the authoritative playback seek path. Comment pages are
cached for 15 minutes, not stored in room SQLite. A real-runtime write counter
verifies that pagination does not write room state or broadcast another
viewer's page. Stale-video results are discarded. The shared YouTube adapter
coalesces identical in-flight requests, bounds concurrent requests, and shares
the legacy UTC-day quota latch across metadata/comments/playlists per cache location;
negative quota entries expire by midnight. These provider checks use fixtures,
not live production credentials. Rendered comment controls remain part of the
frontend acceptance gate.

URL previews remain private and do not write room state. Playlist previews
retain the first-page-only limit of 50 items, total/truncation indicators,
channel attribution, and focus-video-first ordering. Missing credentials,
unavailable/private lists and unsupported mixes fall back to a single-video
preview. `playlist:add` supports all, selected and single-item scopes and
play-now/queue modes. The server resolves the playlist itself rather than
trusting client-supplied media metadata, preserves source order, bounds queue
capacity, and backfills metadata through the existing bounded job queue.
Only accepted items count toward the response/activity total. Real socket tests
exercise preview, selected insertion and asynchronous metadata backfill; the
rendered selection UI is still part of frontend acceptance.

The shared `VideoPool` SQLite Durable Object retains cross-room selection
history rather than duplicating the pool in every room. Refreshes are initiated
by round requests when hourly/daily data is due. Batches of three source pages
have persisted leases; curated pagination continues through finite work alarms.
There is no scheduled hourly/daily wake-up when the pool is unused. The original
four subreddits and twelve curated playlists are retained. Source selection
preserves freshness/repeat weighting, source quotas, exclusions and deduplication.
Known deleted/non-embeddable candidates are rejected during batched validation;
provider failures retain the legacy thumbnail-backed fallback.

Voting and roulette use persisted expiry/reveal deadlines, starter-only
cancellation, vote replacement, and single winner insertion. Winner timestamps
are delivered to the shared pool through a durable, idempotent outbox, with
bounded retry requests rather than losing updates on interruption. Actual
workerd tests populate the pool from provider fixtures, resolve both modes,
evict the room during both reveal phases, and verify alarm-driven completion
and the shared winner timestamp. Rendered spinner/voting interactions and live
provider availability remain separate acceptance checks.

A SQLite test executes the original weighted-selection expression and exposes
its zero-repeat-weight edge case: division by zero produces NULL, which sorts
a just-picked video first. Native sampling clamps that weight away from zero;
the same fixture instead selects the fresh, unpicked video.

The extension's scraped title/image, live detection, and current-URL handoff are
wired through the native socket transport. Live detection retains the original
YouTube/Twitch host allow-list. URL handoff keeps the active queue slot/item ID,
but clears the previous source's duration and publication metadata and adopts
the newly parsed live status, instead of carrying stale playback constraints.
It also respects the queue limit when appending to an ended room.

An executed legacy quorum comparison reproduces another synchronization defect:
a REST API actor is marked connected despite having no player, so all real
players can finish loading yet still wait for the fallback timer. Native ready
quorums exclude these `api:` identities without removing their presence/history.
The real socket test verifies immediate readiness both before and after REST
activity, including an extension URL handoff. This improvement is not claimed
as byte-for-byte legacy parity.

## Native browser transport acceptance (UI port in progress)

The browser channel now implements same-origin cookie/tab bootstrap, authenticated
Phoenix-compatible envelopes, acknowledgements, heartbeat/reconnect and explicit
rejection of ambiguous in-flight actions. It does not replay stale play/seek or
queue mutations after reconnect. Browser snapshots carry the signed owner's
`user_id`; popup readiness is personalized by owner, not display name. The hook
bridge owns subscription cleanup and reuses existing player lifecycle methods.
For native reconnects the player recalibrates clocks without replaying its old
local play/pause state over the persisted server state.

A real network test caught a server bug that in-memory WebSocket fixtures missed:
the browser remained in CLOSING with no close event because the hibernating
server socket did not acknowledge the close handshake. After adding the explicit
acknowledgement, the native channel reconnects within the unchanged five-second
limit and retains its owner and paused position 42. Both actual runtime suites
and the 124.43 KiB / 31.12 KiB gzip deployment dry-run pass; 130 unit tests passed
before that runtime-only close fix. These results are not rendered-player or UI
acceptance: the static room interface and build are still being ported.

## Native static UI acceptance (partial, not a release claim)

The static bundle reuses the existing VideoPlayer, statistics, round-timer and
roulette-animation hooks. Player and active wheel DOM survive room snapshots.
A viewer arriving during a roulette reveal sees the selected candidate instead
of starting an animation that would outlast the server's finalization deadline.
Room keys are fetched through an explicit browser-only private channel reply;
settings access does not put the key in snapshots or broadcasts. Actual workerd
checks cover browser access, extension rejection and other-peer isolation.

The Chromium harness renders desktop and mobile layouts, creates a room and
joins two players, then exercises real direct audio/video, pause/play and 1.5×
playback. Both sampled playheads must be within 350 ms of the canonical room
position after advancing three media seconds. A plain-video 20-second seek is a
fixture preflight: the original HTTP fixture ignored byte ranges, causing
Chromium seeks to jump to zero and producing misleading 5–6-second drift.
Proper HTTP206 range responses fixed the fixture without changing that drift
threshold. The successful run also rendered the legacy seeded roulette hook and
matched its highlighted winner to the native backend's landing calculation.
These are local, gesture-unlocked Chromium checks, not live-provider, physical
Safari, extension-injection or impaired-network acceptance.

Statistics legends previously interpolated peer names into HTML. An executed
regression reproduced the injection; escaping text now passes both the bundled
hook test and a rendered malicious-name check. Safe view templates also cover
queue, comment, preview and round text. Screenshots exposed a cramped mobile
URL toolbar despite passing a document-overflow assertion; the toolbar now
wraps its URL form onto its own row, with an explicit input-width acceptance
check. Autoplay-help persistence/reset and live settings updates passed rendered
checks in b18a63a28. The latter first reproduced an open dialog ignoring another
viewer's SponsorBlock change; snapshots now update its existing selects without
replacing the dialog or statistics graphs. An earlier intermittent initial-playback
timeout remains unexplained despite subsequent successful runs; the harness now
captures media readiness, network errors and user activation if it recurs.

`test:runtime` and `check:deploy` build static assets before invoking Wrangler;
`test:browser` builds them as part of its harness. Scripts invoke the Node build
entry directly, so a global pnpm shim is not required when launched through
Corepack. The build still uses the project's pinned installed Tailwind binary;
clean-environment setup remains a release gate. The latest successful dry-run
was 124.75 KiB / 31.17 KiB gzip plus static assets; nothing was published.

The rendered rate matrix now exercises all eight UI rates (0.25× through 2×),
advancing three media seconds at each rate before checking both actual players
against timestamped canonical room references. The first matrix run passed every rate (observed drift
between -156 and +9 ms), then exposed a separate immediate paused-seek failure.
A focused bundled-player regression reproduced the cause: the shared pause
suppression window also discarded the direct video's subsequent user seek.
The direct adapter now filters its own programmatic seek completion, while
native user seeks are no longer rejected merely because a pause is settling.
The focused regression passes. A subsequent wire trace confirmed that the origin
and room reached exactly 20 seconds, but revealed a second defect: the peer was
sent 20.5 seconds because server latency compensation still advanced a paused
playhead. Browser and extension transit compensation had the same stationary
clock error. Three regressions reproduced those errors before the paused-path
fixes and now pass. The next full run passed 145 unit tests, both workerd suites,
all eight rendered rates and the exact paused-seek check. It then exposed a
reload defect: a newly created direct player kept its default 1× rate rather
than applying the snapshot's 2× rate. A bundled readiness-callback regression
failed before restoring the rate on metadata readiness and now passes.
The subsequent Chromium run passed the full rate, paused seek, reload and resume
suite after fixing a second reload issue: the polling seek detector mistook the
restored direct-video position for a user seek, duplicating native seek events.
The polling fallback now reports seeks only for non-direct players; its ended
checks remain intact. A regression also preserves the YouTube fallback.

Firefox reached 1.75× before exposing a test measurement error: a media sample
was compared with an HTTP API position taken roughly 234 ms later. Its apparent
415 ms drift was actually about -6 ms when aligned to the socket's server-time
anchor. The harness now compares positions at the media sample's timestamp,
without changing the 350 ms threshold. Regression tests reproduce that exact
trace and ensure genuine ±400 ms drift still fails at every tested rate.
Firefox's remaining rendered acceptance is pending.
Active LSP diagnostics for the four changed JS/test files remain unavailable or
inconclusive, not a clean type-check result.

## HTTP transport fallback

The native browser now selects an HTTP stream after a WebSocket opening failure
or the legacy-compatible2.5-second opening deadline. A blocked WebSocket
constructor also selects the fallback. HTTP uses the same room ticket and a
fresh per-connection UUID: `/socket/stream` carries newline-delimited Phoenix
frames and `/socket/message` accepts ordered POSTs. The room still executes its
existing `RoomSockets` state machine, including acknowledgements, presence,
rate limits, readiness and drift handling. No second room-state implementation
or new Durable Object namespace is introduced.

The Worker bridges the HTTP reader to an internal hibernating room socket. A
stream disconnect closes that socket; a stalled reader has a bounded byte queue.
POSTs must match both the signed owner and connection ID, and origins must match.
The client serializes POSTs and never retries them: a lost HTTP response does not
prove a mutation failed. Closing the transport aborts outstanding work and drops
unsent actions; reconnect obtains authoritative state.

`BYOB_HTTP_ONLY=1 corepack pnpm test:browser` runs the rendered acceptance suite
with browser WebSocket construction blocked. HTTP sync references are observed
at message dispatch so playback checks keep the same timestamp-aligned350ms
threshold as the WebSocket suite. Runs `bfd09bc29` and `bfbd8e824` passed this
full matrix in Chromium and Firefox, including all eight rates, paused seeks and
reload/resume. Maximum reported HTTP drift was159ms in Chromium and86ms in
Firefox. The default Chromium WebSocket regression suite, actual workerd HTTP
owner/origin isolation, duplicate-stream refusal, cancellation/backpressure unit
tests, precommit and deployment dry-run also passed. Real legacy Phoenix
long-poll pages transitioned to native HTTP in both browsers with their identity
retained. Production fallback/cutover verification remains outstanding.

## Backend event audit

The native socket dispatcher and room commands cover the original extension
play/pause/seek/rate/state/media/URL/live/loaded/ended, tab/ready reconciliation,
clock and state-request events. Legacy `debug:log` is accepted from extension
peers but its arbitrary page data is neither logged, persisted nor broadcast.
A failing-first unit test reproduced the missing handler; actual workerd tests
verify acceptance, browser-role refusal and non-disclosure to other viewers.

Queue/history/rename/settings/round/comment/playlist operations retain their
server mutations. Former LiveView UI-only events (clear input, selected playlist
checkboxes, queue/history tabs, rename edit/cancel, comments and round collapse)
are local browser state rather than new server writes. Old LiveView pages
transition through the separately tested temporary compatibility endpoints.

Self-reference checks cover the primary/www domains and the current request
host, including case/root-dot aliases, on API additions, browser additions,
previews and extension URL handoff. Additional production aliases must be
included in the deployment review; none are configured in the current preview
Wrangler file.

Pool exhaustion returns no candidates rather than creating a placeholder round.
Sparse-source backfill preserves the legacy per-source quota plus two-row
surplus, so one available source need not fill all12 slots. Tests cover empty
storage, one-source surplus and complete exclusion, alongside weighted picking
and cross-source deduplication. This is parity, not a newly enlarged search.

## Actual player and extension acceptance

Run `ba25c40c9` loaded the Nix-packaged Chromium extension in an ephemeral
persistent profile and verified actual content-script injection, background
service-worker operation, managed external-video popup, native Worker
authentication, play/pause/rate controls and paused seek propagation back to the
room. This uses a real HTML-video fixture, not a simulated extension-channel
peer; it does not establish provider-specific DRM-site behavior.

Run `b56f6d8c9` verified actual public YouTube playback, room pause/resume and an
observed1.5x playback rate. The old Vimeo fixture returned oEmbed404. The current
Vimeo SDK sample returned oEmbed200 but its actual embed was blocked with HTTP401
and a connection-security restriction (`b73b7845b`). No bypass was attempted.

You explicitly accepted Vimeo on the basis of working YouTube and reuse of the
old application's Vimeo implementation. Inspection confirmed
`assets/js/players/vimeo.js` is byte-for-byte identical to HEAD (SHA256
`48528bd2ca27942f3aa54d3f58a76341552eeb076ec4a430cf4ff201b0e2afa2`), and the
Vimeo-specific loading callback is unchanged. Vimeo is therefore accepted by
that criterion, not claimed as a passing live-provider playback test. The
optional provider diagnostic remains available without weakening its assertions.

## Optional analytics parity

The Worker preserves the legacy browser analytics events (`room_created`,
`room_joined`, `video_added`, `video_embed_blocked`, `$identify`) only when
`POSTHOG_API_KEY` is configured. `POSTHOG_HOST` defaults to the existing US
PostHog ingestion host; an override must be an HTTPS origin. Requests have a
five-second deadline, do not follow redirects and cannot delay playback or
create idle alarms. Without configuration, no analytics request is made.

The existing `byob_browser_id` localStorage UUID remains the cross-tab identifier;
it never grants room authority. Browser joins carry extension availability, and
late extension detection updates the profile. Extension-channel peers cannot
emit these events. The reused YouTube player's embed-blocked event is now
acknowledged even when analytics is disabled, rather than surfacing an
unsupported-event error.

Properties are allowlisted again at the network boundary: room ID, source type,
extension availability and numeric provider error code. URLs, video IDs, titles,
usernames, room API keys and tickets are excluded. Unit tests cover disabled
configuration, sanitization, redirect refusal and provider failure. Actual
workerd tests intercept a fixture analytics provider and verify creation/join/
embed events without sensitive fields. The first runtime check exposed workerd's
unsupported `redirect: "error"` option; the implementation now uses `manual` and
rejects redirect responses without forwarding credentials. Run `b345bed88` passed
precommit,170 unit tests and both runtime suites, then failed Chromium's initial
1.5x playback check at368ms against the unchanged350ms limit. The chained Firefox
and deployment dry-run checks were not reached. Diagnostic run `b9c67b855` passed
Chromium with native seek tracing but no synchronization fix; this does not
resolve the earlier failure. Production analytics has not been configured or
contacted by these tests. See [synchronization research](video-synchronization-research.md)
for the source-backed assessment and remaining measurement/controller questions.
