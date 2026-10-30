Code.require_file("../scripts/legacy_export.ex", __DIR__)
[directory] = System.argv()
room_id = System.get_env("BYOB_FIXTURE_ROOM_ID", "oldroom1")
api_key = System.get_env("BYOB_FIXTURE_API_KEY", "fixture-migration-room-key")
{:ok, db} = Exqlite.Sqlite3.open(Path.join(directory, "legacy.db"))

:ok =
  Exqlite.Sqlite3.execute(
    db,
    "CREATE TABLE rooms (room_id TEXT PRIMARY KEY, state BLOB, updated_at INTEGER, schema_version INTEGER)"
  )

:ok =
  Exqlite.Sqlite3.execute(
    db,
    "CREATE TABLE video_pool (source_type TEXT, source_detail TEXT, external_id TEXT, title TEXT, channel TEXT, duration_s INTEGER, thumbnail_url TEXT, score INTEGER, first_seen_at INTEGER, last_seen_at INTEGER, last_picked_at INTEGER)"
  )

item = %Byob.MediaItem{
  id: "legacy-media",
  url: "https://example.com/video.webm",
  source_type: :direct_url,
  title: "Preserved video",
  duration: 300,
  added_at: ~U[2025-01-02 03:04:05Z]
}

state = %Byob.RoomServer{
  room_id: room_id,
  api_key: api_key,
  queue: [item],
  current_index: 0,
  play_state: :paused,
  current_time: 42,
  playback_rate: 1.5,
  history: [%{item: item, played_at: ~U[2025-01-02 04:05:06Z]}],
  cleanup_ref: make_ref()
}

state = Map.put(state, :persisted_wallclock, 1_735_800_000)
{:ok, statement} = Exqlite.Sqlite3.prepare(db, "INSERT INTO rooms VALUES (?, ?, ?, 1)")
:ok = Exqlite.Sqlite3.bind(statement, [room_id, :erlang.term_to_binary(state), 1_735_800_000])
:done = Exqlite.Sqlite3.step(db, statement)
:ok = Exqlite.Sqlite3.release(db, statement)

:ok =
  Exqlite.Sqlite3.execute(
    db,
    "INSERT INTO video_pool VALUES ('curated', 'playlist', 'oldvideo', 'Preserved title', 'Channel', 300, NULL, 50, 1001, 2002, 3003)"
  )

:ok = Exqlite.Sqlite3.close(db)
Byob.LegacyExport.write!(Path.join(directory, "legacy.db"), Path.join(directory, "export.json"))
