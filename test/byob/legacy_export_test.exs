Code.require_file("../../workers/scripts/legacy_export.ex", __DIR__)

defmodule Byob.LegacyExportTest do
  use ExUnit.Case, async: true
  alias Exqlite.Sqlite3

  @moduletag :tmp_dir

  setup %{tmp_dir: directory} do
    path = Path.join(directory, "legacy.db")
    {:ok, db} = Sqlite3.open(path)

    :ok =
      Sqlite3.execute(
        db,
        "CREATE TABLE rooms (room_id TEXT PRIMARY KEY, state BLOB, updated_at INTEGER, schema_version INTEGER)"
      )

    :ok =
      Sqlite3.execute(
        db,
        "CREATE TABLE video_pool (source_type TEXT, source_detail TEXT, external_id TEXT, title TEXT, channel TEXT, duration_s INTEGER, thumbnail_url TEXT, score INTEGER, first_seen_at INTEGER, last_seen_at INTEGER, last_picked_at INTEGER)"
      )

    item = %Byob.MediaItem{
      id: "media1",
      url: "https://example.com/video.webm",
      source_type: :direct_url,
      added_at: ~U[2025-01-02 03:04:05Z]
    }

    state = %Byob.RoomServer{
      room_id: "oldroom1",
      api_key: "fixture-only-preserved-key",
      queue: [item],
      history: [%{item: item, played_at: ~U[2025-01-02 04:05:06Z]}],
      cleanup_ref: make_ref(),
      current_time: 42.5,
      playback_rate: 1.5
    }

    state = Map.put(state, :persisted_wallclock, 1_735_800_000)
    {:ok, statement} = Sqlite3.prepare(db, "INSERT INTO rooms VALUES (?, ?, ?, ?)")
    :ok = Sqlite3.bind(statement, ["oldroom1", :erlang.term_to_binary(state), 1_735_800_000, 1])
    :done = Sqlite3.step(db, statement)
    :ok = Sqlite3.release(db, statement)

    :ok =
      Sqlite3.execute(
        db,
        "INSERT INTO video_pool VALUES ('curated', 'playlist', 'video1', 'Title', 'Channel', 60, NULL, 100, 1001, 2002, 3003)"
      )

    :ok = Sqlite3.close(db)
    %{database: path}
  end

  test "exports old rooms without pruning, preserves identities, dates and pool timestamps", %{
    database: path
  } do
    before = File.read!(path)
    exported = Byob.LegacyExport.snapshot!(path, 1_800_000_000_000)
    [room] = exported.rooms
    assert room.room_id == "oldroom1"
    assert room.state.api_key == "fixture-only-preserved-key"
    assert room.state.current_time == 42.5
    assert room.state.playback_rate == 1.5
    assert hd(room.state.queue).added_at == "2025-01-02T03:04:05Z"
    assert hd(room.state.history).played_at == "2025-01-02T04:05:06Z"
    refute Map.has_key?(room.state, :cleanup_ref)
    assert hd(exported.pool)["first_seen_at"] == 1001
    assert hd(exported.pool)["last_seen_at"] == 2002
    assert hd(exported.pool)["last_picked_at"] == 3003
    assert hd(exported.pool)["thumbnail_url"] == nil
    assert File.read!(path) == before
  end

  test "writes credentials privately and never overwrites an existing export", %{
    database: path,
    tmp_dir: directory
  } do
    output = Path.join(directory, "export.json")
    result = Byob.LegacyExport.write!(path, output)
    assert result.rooms == 1
    assert result.pool == 1
    assert Bitwise.band(File.stat!(output).mode, 0o777) == 0o600

    assert Jason.decode!(File.read!(output))["rooms"] |> hd() |> get_in(["state", "api_key"]) ==
             "fixture-only-preserved-key"

    assert_raise MatchError, fn -> Byob.LegacyExport.write!(path, output) end
  end

  test "refuses unsupported schemas rather than silently dropping rooms", %{database: path} do
    {:ok, db} = Sqlite3.open(path)
    :ok = Sqlite3.execute(db, "UPDATE rooms SET schema_version = 99")
    :ok = Sqlite3.close(db)

    assert_raise RuntimeError, "unsupported legacy room schema", fn ->
      Byob.LegacyExport.snapshot!(path)
    end
  end
end
