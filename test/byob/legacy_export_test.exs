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

  test "omits foreign-node references without creating their atoms", %{database: path} do
    node = "fixture@#{Base.encode16(:crypto.strong_rand_bytes(8))}"
    reference = <<90, 1::16, 119, byte_size(node), node::binary, 0::32, 1::32>>
    put_raw_field!(path, :cleanup_ref, reference)
    before = File.read!(path)

    assert_raise ArgumentError, fn -> String.to_existing_atom(node) end
    [room] = Byob.LegacyExport.snapshot!(path).rooms
    assert room.state.current_time == 42.5
    assert room.state.api_key == "fixture-only-preserved-key"
    refute Map.has_key?(room.state, :cleanup_ref)
    assert_raise ArgumentError, fn -> String.to_existing_atom(node) end
    assert File.read!(path) == before
  end

  test "still refuses unknown atoms in retained fields", %{database: path} do
    value = "unknown_#{Base.encode16(:crypto.strong_rand_bytes(8))}"
    put_raw_field!(path, :play_state, <<119, byte_size(value), value::binary>>)
    assert_raise ArgumentError, fn -> Byob.LegacyExport.snapshot!(path) end
    assert_raise ArgumentError, fn -> String.to_existing_atom(value) end
  end

  test "rejects truncated transient references", %{database: path} do
    put_raw_field!(path, :cleanup_ref, <<90, 1::16, 119, 1, ?n>>)
    assert_raise ArgumentError, fn -> Byob.LegacyExport.snapshot!(path) end
  end

  test "bounds nesting even in discarded transient fields", %{database: path} do
    nested = IO.iodata_to_binary([List.duplicate(<<104, 1>>, 129), <<106>>])
    put_raw_field!(path, :users, nested)
    assert_raise ArgumentError, fn -> Byob.LegacyExport.snapshot!(path) end
  end

  defp put_raw_field!(path, field, raw) do
    {:ok, db} = Sqlite3.open(path)
    {:ok, query} = Sqlite3.prepare(db, "SELECT state FROM rooms")
    {:ok, [[blob]]} = Sqlite3.fetch_all(db, query)
    :ok = Sqlite3.release(db, query)
    state = :erlang.binary_to_term(blob, [:safe]) |> Map.delete(field)
    <<131, 116, count::32, entries::binary>> = :erlang.term_to_binary(state)
    <<131, key::binary>> = :erlang.term_to_binary(field)
    replacement = <<131, 116, count + 1::32, entries::binary, key::binary, raw::binary>>
    {:ok, update} = Sqlite3.prepare(db, "UPDATE rooms SET state = ?")
    :ok = Sqlite3.bind(update, [replacement])
    :done = Sqlite3.step(db, update)
    :ok = Sqlite3.release(db, update)
    :ok = Sqlite3.close(db)
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
