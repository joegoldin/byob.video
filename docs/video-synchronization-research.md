# Video synchronization: research and BYOB implications

Research reviewed 2026-10-29. This is a bounded review of primary specifications,
provider documentation and implementations, not a claim that one algorithm is
universally optimal. Recommendations below are not implemented or verified merely
because they appear here.

## Conclusion

Keep BYOB's authoritative room timeline and clock synchronization. Improve the
measurement and per-player execution paths before changing the correction policy.
A hybrid controller—small bounded rate corrections where supported, hard seeks
for discontinuities or large errors—is a strong candidate, not a universal
replacement for the existing server-directed seeks.

There is no browser API that guarantees frame-exact synchronization across
arbitrary third-party embeds. Provider capabilities, actual presented frames,
buffering and event ownership matter as much as the clock algorithm.

## What the sources establish

| Source | Evidence | Implication for BYOB |
| --- | --- | --- |
| [Timing Object, 2024 community report][timing] | Shared position/velocity/timestamp model; monotonic local clocks; ongoing alignment and gradual playback-rate adjustment. Explicitly not a W3C Standard or Standards Track document. | Supports our existing rate-aware timeline. Does not establish a universally supported native `timingsrc` API. |
| [MediaSync reference implementation background][mediasync] | Uses seeks and variable playback rate to make HTML media follow an external timing object; discusses buffering, decoding and browser variation. | Useful control-system precedent, not a guarantee for BYOB's providers or a reason to add a dependency. |
| [Vimeo's actual timing-source connector][vimeo-controller] | Separates viewer/controller roles and uses drift-dependent seeks/rate adjustments. Source defaults include 0.3 s allowed drift, 1 s maximum drift and 0.2 maximum rate adjustment. | A deployed SDK has the hybrid pattern. Its defaults and async sampling are not proof of our 350 ms bound and should not be copied blindly. |
| [hls.js latency controller][hls] | Adjusts speed toward a live-edge latency target; checks forward buffer and live range; backs off the target after stalls. | Buffer-aware correction is useful. Equal distance from independently estimated live edges is not necessarily synchronized content across viewers. |
| [Syncplay constants][syncplay] | Defaults include 0.95 slowdown rate, 1.5 s slowdown kick-in, 4 s rewind and 5 s fast-forward thresholds. | Mature watch-party systems trade accuracy against disruption. These defaults are substantially looser than our requirement. `SEEK_THRESHOLD = 1` is a separate constant, not the default rewind policy. |
| [RFC 7272][idms] | Distinguishes packet arrival from actual presentation timestamps; coordinates a common playout point. Leaves the synchronization algorithm out of scope. | Measure playout, not merely message delivery. This is an RTP/RTCP standard, not a drop-in transport for third-party web players. |

Sources on moving repository branches were read at research time; their defaults
are descriptive evidence, not version-pinned dependencies or acceptance limits.

## Preserve what already works

The canonical target remains:

```text
expected(t) = position_at_anchor + room_rate * (server_time(t) - anchor_time)
```

Use consistent time units. While paused, expected position is constant. A room
rate change must re-anchor the timeline, not reinterpret elapsed time at the new
rate. Clock synchronization must map each browser's monotonic clock onto the
server's time domain; matching raw `performance.now()` values across devices is
invalid.

BYOB already has rate-aware anchors, monotonic client probes, low-RTT sample
selection, paused-state protections, no ambiguous mutation replay, and
request-driven Durable Objects. Preserve those properties. Neither a shared
timeline nor a client-side correction loop requires recurring idle DO alarms or
SQLite writes for ordinary drift.

Local Chromium/Firefox runs have demonstrated substantially better than 350 ms
alignment in many cases. The failed `b345bed88` run measured 368 ms during initial
1.5x playback. Diagnostic run `b9c67b855`, with native event tracing but no
functional synchronization fix, passed the browser matrix; its largest printed
absolute drift was 149 ms. This is evidence of intermittency, not a fixed defect.
The earlier failure, live-provider coverage, injected-extension coverage and
physical Safari checks remain outstanding.

## Measurement before correction

`currentTime` is an approximate reported playback position, not proof of what is
on the screen. It remains stable while a script runs, and repeated reads can
remain unchanged while wall time advances ([MDN][current-time]). Our timestamp-
aligned browser measurement correctly avoids comparing positions captured at
different times, but does not by itself establish frame or audio presentation
accuracy.

For direct HTML video, add independent diagnostic observations using
[`requestVideoFrameCallback`][rvfc]: pair `mediaTime` with
`expectedDisplayTime`, translating that monotonic timestamp through the clock
mapping. Compare the canonical timeline at the frame's expected presentation
time, not at callback arrival. The callback can arrive a display refresh late;
this remains browser-reported presentation evidence, not a physical display or
speaker measurement. `processingDuration` describes decoder processing, not the
whole seek latency. Keep `currentTime` fallback for unsupported/opaque players.

Do not increase reporting traffic to frame rate. Frame observations can remain
local and summarized. Preserve the existing 350 ms acceptance gate; frame-aware
measurement should provide additional evidence, not replace a failing metric
with a more convenient one. Across real devices, clock-offset uncertainty and
network asymmetry also need measurement; the same-host test avoids that problem
rather than proving it solved.

## Concrete gaps visible in today's code

These are inspection findings and hypotheses, not a demonstrated explanation of
the intermittent failure:

- `workers/src/sync-decision.mjs:30-32` accepts latency samples only from 50 to
  5000 ms. Its default learned latency is 500 ms. Fast valid completions cannot
  train that value downward. Missing observations and measured near-zero latency
  need different representations, rather than treating every zero as missing.
- `assets/js/hooks/video_player.js:636-674` gives direct video its own callbacks.
  The latency observation at `:729-758` is in the separate shared player-state
  handler. Suppressing a programmatic seek's user-command echo must not also
  discard the measurement needed to learn its completion time.
- The diagnostic direct-media trace contains roughly 2–4 ms seek completions and
  an overlapping startup seek completing about 43 ms after the final assignment.
  These are native `seeked` timings, not first-presented-frame timings. They
  nevertheless warrant testing the inherited 500 ms prior rather than assuming
  every player needs a YouTube-style processing allowance.
- `workers/src/sync-decision.mjs:43-47` adds processing milliseconds as media
  seconds without multiplying by room rate. `assets/js/sync/reconcile.js:120-129`
  likewise adds transit milliseconds without the rate. Dimensional correctness
  requires wall-time compensation to advance media position by `rate * seconds`
  while playing, and zero while paused. Test these independently of the startup
  failure; do not infer that they caused it.
- The policy raises post-seek tolerance from at least 300 to 600 ms for five
  seconds (`workers/src/sync-decision.mjs:17-19`). That can suppress another
  correction despite a sample failing our 350 ms acceptance limit. Cooldown can
  prevent oscillation, but it does not turn such a sample into acceptable sync.
- `assets/js/players/direct.js:36-43` uses one boolean to classify seek completion.
  The trace demonstrates that overlapping assignments can coalesce. Any change
  needs explicit tests for coalescing, superseded seeks and genuine user scrubs,
  not a long blanket suppression window that loses user commands.

Latency estimation should distinguish command receipt, seek issuance, native
completion and first usable frame. Associate observations with the current media
item and operation, invalidate superseded work, and keep measurements bounded.
Do not count network transit twice. Separate clock uncertainty, measurement
noise and actuator latency instead of folding all three into a larger tolerance.

### Follow-up: rate compensation regression

Failing-first tests reproduced unscaled transit at 0.25x (20.25 seconds instead
of 20.0625) and unscaled processing compensation (10.2 instead of 10.05).
The client now scales transit by its canonical room rate; the Worker passes
room velocity into the processing calculation, with zero velocity while paused.
Run `b74a7c6c9` passed precommit, all172 unit tests (including unchanged legacy
oracles), both workerd suites, Chromium WebSocket and Firefox HTTP-only browser
acceptance, and the deployment dry-run. Maximum printed drift was154ms in
Chromium and72ms in Firefox. LSP checks were unavailable/inconclusive, not clean.
This corrects two independently reproduced defects; it does not establish the
cause of the intermittent startup failure or resolve the latency-learning and
ownership questions above.

### Follow-up: stale completion ownership regression

Run `b58532065` reproduced the ownership failure in actual Chromium: starting a
new programmatic seek before the older completion reached the adapter caused
the new target (12 seconds) to be reported as a user seek. The focused unit
regression failed for the same reason. The adapter now leaves ownership intact
when `seeked` arrives while `video.seeking` is still true.

Run `b5b217363` passed precommit,172 units, and both Chromium WebSocket and
Firefox HTTP-only browser suites. Both browsers verified overlapping seeks
produce no user command and a subsequent genuine native seek still reports.
Maximum printed drift was190ms in Chromium and91ms in Firefox. This proves the
specific ownership fix, not that every cause of the earlier368ms failure has
been eliminated. Fast-latency learning and real-provider acceptance remain open.

### Follow-up: delayed resume and direct seek learning

The opt-in `BYOB_NETWORK_PROFILE=delayed` browser harness preserves WebSocket
message order while adding100–145ms to sends and150–195ms to message callbacks.
It models application-visible transport delay and jitter, not packet loss or
physical network shaping. The350ms assertion is unchanged.

Run `b876a7ba1` passed the rate matrix but failed paused reload/resume. The remote
resume handler applied the old message position without advancing it through
transit. A failing-first unit regression confirmed this, and `_onSyncPlay` now
projects the position at the canonical room rate before seeking.

Run `beb7745e4` then exposed the retained500ms processing prior during a fast
2x direct seek. Direct completion timing was missing, and the server rejected
sub50ms observations. Both defects received failing-first regressions. The
adapter now reports programmatic completion timing independently of suppressing
user-command echoes. The Worker accepts1–5000ms observations for direct media;
other providers retain the legacy50ms floor. Sub-millisecond completions are
represented as1ms because zero remains the missing-observation sentinel. This
measures native seek completion, not physical frame presentation.

Run `b91c35a72` passed the Worker unit suite, both workerd suites, delayed Chromium
and Firefox browser matrices including paused reload/resume, and deployment
dry-run. Maximum printed drift was324ms in Chromium and266ms in Firefox.
Both browsers' delayed suites are now included in the WebSocket CI jobs;
actionlint passes. Hosted CI execution remains unverified.

Required precommit initially stopped at an unrelated persistent pool-fixture ID
collision (`b12e7ebb5`). Cross-run random fixture suffixes fixed it without
removing assertions or deleting the database. Run `b3b55cdad` passed the pool
module twice in separate VMs and full precommit (140 Elixir tests).

Run `bce74e1de` then passed the final low-latency Chromium/Firefox × WebSocket/HTTP
matrix. Maximum printed drift was147ms (Chromium WS),136ms (Chromium HTTP),99ms
(Firefox WS) and84ms (Firefox HTTP), including paused seeks and reload/resume.
These checks close the reproduced local defects, not real-provider, injected-
extension, physical Safari or production acceptance.

## Where gradual correction fits—and where it does not

For capable VOD players, a bounded correction can avoid repeated hard seeks for
moderate persistent error. Preserve the user's room rate separately from the
temporary actuator rate. Otherwise the existing rate-change forwarding can turn
a local correction into a new room-wide command and cause feedback.

Use an entry/exit deadband, buffer/readiness checks and a convergence deadline.
Restore the canonical rate on settling, pause, replacement, disconnect or user
rate change. Large discontinuities still need seeks. A 5% relative rate nudge
at 1x needs about six seconds to remove a 300 ms error; at 0.25x it needs about
24 seconds. "Gentle" does not mean "fast enough for our acceptance bound."
Rate limits and correction thresholds need experiments, not borrowed defaults.

Keep room intent authoritative on the server. A local follower can execute
bounded corrections without making its observations new room intent. That is
an architectural option to evaluate against the current server-owned policy,
not permission to silently replace legacy behavior or parity checks.

Provider differences are material:

- **Direct HTML video:** continuous rate control and frame callbacks make this
  the strongest candidate for precise measurement and soft correction.
- **YouTube iframe:** supported rates are discrete; unsupported values round
  toward 1, a setter does not guarantee a change, and loading/cueing resets rate
  to 1. Seeking unbuffered content can land on an earlier keyframe. Confirm
  actual rate changes and retain a seek-based fallback ([official API][youtube]).
- **Vimeo:** async setters return the actual seek result, and seeking before
  playback has started can start playback. Rate capability must be checked in
  practice, not assumed from the method existing ([official SDK][vimeo]). Its
  timing connector is useful reference material, not an automatic replacement
  for BYOB's authenticated room protocol.
- **Twitch live embeds:** documented `seek` and `getCurrentTime` do not support
  live streams. `PlaybackStats.playbackRate` is bitrate in Kbps, not speed.
  Matching local elapsed time is not content synchronization ([official API][twitch]).
- **Injected extension players:** direct element access helps, but site scripts,
  ads, source replacements and a provider's own live catch-up controller can
  overwrite state. Test the actual injected extension, not only a synthetic
  extension-channel peer. Do not let two rate controllers fight.

For live streams, identify a shared content-time mapping and seekable overlap
where the provider exposes them. If it does not, keep the capability limitation
visible; do not claim a live synchronization guarantee from VOD fixture results.
Scheduling a common future start may reduce message-arrival skew, but adds
latency and cannot override autoplay restrictions or buffering. It is not the
first remedy for the observed failure.

## Evidence needed before adopting a changed controller

First establish deterministic regressions for fast/slow seek observations,
rate-scaled compensation, paused seeks and seek ownership. Then use the existing
real-media WS/HTTP browser suites, with their unchanged limit, to verify the
behavior. A passing retry without a cause and regression is insufficient.

Compare correction policies on maximum and percentile error, convergence time,
seek count, buffering time and rate deviation—not just final drift. Include all
eight room rates, cold and buffered seeks, consecutive/superseded commands,
network delay/jitter/asymmetry, reconnect, visibility changes, autoplay blocking
and player replacement. A per-client 350 ms canonical bound does not imply a
350 ms pairwise bound: clients on opposite sides can be nearly 700 ms apart.
Record both metrics without silently redefining the existing gate.

Local fixtures establish controller behavior, not provider support. Actual
YouTube/Vimeo/live-provider sessions, injected extension sessions and physical
Safari remain separate acceptance evidence. Retain legacy oracle comparisons;
any deliberate policy improvement needs an explicit new expected behavior rather
than weakening the old oracle to conceal a divergence.

[timing]: https://www.w3.org/community/reports/webtiming/CG-FINAL-timingobject-20241203/
[mediasync]: https://webtiming.github.io/timingsrc/doc/background_mediasync.html
[vimeo-controller]: https://github.com/vimeo/player.js/blob/master/src/lib/timing-src-connector.js
[hls]: https://github.com/video-dev/hls.js/blob/master/src/controller/latency-controller.ts
[syncplay]: https://github.com/Syncplay/syncplay/blob/master/syncplay/constants.py
[idms]: https://www.rfc-editor.org/rfc/rfc7272
[current-time]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime
[rvfc]: https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
[youtube]: https://developers.google.com/youtube/iframe_api_reference
[vimeo]: https://github.com/vimeo/player.js/blob/master/README.md
[twitch]: https://dev.twitch.tv/docs/embed/video-and-clips/
