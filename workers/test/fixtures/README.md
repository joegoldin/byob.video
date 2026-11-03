# Regression fixture provenance

`sync-decision.json.gz` and `room-sync.json.gz` were captured by executing the
original reference handlers from commit `804c89091f73d4decfebff1572bcb9b9b38ec069`
before deleting the old server. Each contains input/expected pairs plus source
SHA-256 hashes and the source commit. They cover tolerance/cooldown boundaries,
seek latency, clock consensus, hidden peers, negative/positive time epochs and
stateful traces. Expectations were not generated from the Worker under test.

`legacy.json` contains the earlier captured media, roulette and sync traces;
its source hashes refer to archived code in Git history, not build dependencies.

`legacy-auth.json` contains synthetic original cookie and extension signatures
with a fixed 2023 timestamp. The fixture-only secret is deliberately public.
The Node integration helper refreshes extension timestamps and is itself checked
byte-for-byte against the original fixed signature.

`legacy-export.json` is the original serializer's synthetic database export,
captured before retirement. Native integration tests exercise the current JSON
import CLI, auth boundaries, idempotency, preserved API keys/queues/history/pool,
SQLite eviction/reload and transport compatibility. The old SQLite/ETF exporter
and its old-server-only tests are retired; no current build needs to export an
old database or run BEAM code. Keep any private production exports outside Git.
