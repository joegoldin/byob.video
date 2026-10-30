defmodule Byob.LegacyExport do
  @moduledoc "Read-only export of legacy SQLite/ETF state for the Workers migration."

  alias Exqlite.Sqlite3

  @room_fields ~w(room_id api_key host_id queue current_index play_state current_time playback_rate history sb_settings activity_log persisted_wallclock)a
  @pool_fields ~w(source_type source_detail external_id title channel duration_s thumbnail_url score first_seen_at last_seen_at last_picked_at)

  def snapshot!(path, now \\ System.system_time(:millisecond)) do
    # Safe ETF decoding requires the old struct/key atoms to exist, but must
    # not start the application: Persistence would prune the source database.
    Enum.each(
      [Byob.RoomServer, Byob.MediaItem, Byob.SyncDecision, Byob.RoomServer.Round],
      &Code.ensure_loaded!/1
    )

    {:ok, db} = Sqlite3.open(path, mode: :readonly)

    try do
      :ok = Sqlite3.execute(db, "BEGIN")
      columns = query!(db, "PRAGMA table_info(rooms)") |> Enum.map(&Enum.at(&1, 1))
      version = if "schema_version" in columns, do: "schema_version", else: "1"

      rooms =
        query!(db, "SELECT room_id, state, updated_at, #{version} FROM rooms ORDER BY room_id")
        |> Enum.map(fn [room_id, blob, updated_at, schema_version] ->
          if (schema_version || 1) != 1, do: raise("unsupported legacy room schema")
          state = :erlang.binary_to_term(blob, [:safe])

          unless is_map(state) and Map.get(state, :room_id) == room_id do
            raise "legacy room identity mismatch"
          end

          %{
            room_id: room_id,
            updated_at: updated_at,
            schema_version: 1,
            state: state |> Map.take(@room_fields) |> json_value!()
          }
        end)

      pool =
        query!(
          db,
          "SELECT #{Enum.join(@pool_fields, ", ")} FROM video_pool ORDER BY source_type, external_id"
        )
        |> Enum.map(&Map.new(Enum.zip(@pool_fields, &1)))

      :ok = Sqlite3.execute(db, "COMMIT")
      %{format: "byob-legacy-export-v1", exported_at: now, rooms: rooms, pool: pool}
    after
      Sqlite3.close(db)
    end
  end

  def write!(database, output) do
    snapshot = snapshot!(database)
    encoded = Jason.encode!(snapshot)

    # Exclusive creation refuses both accidental overwrite and a symlink.
    # Set permissions before any credentials are written to the file.
    {:ok, file} = File.open(output, [:write, :exclusive, :binary])

    try do
      File.chmod!(output, 0o600)
      :ok = IO.binwrite(file, encoded)
    after
      File.close(file)
    end

    %{
      rooms: length(snapshot.rooms),
      pool: length(snapshot.pool),
      sha256: :crypto.hash(:sha256, encoded) |> Base.encode16(case: :lower)
    }
  end

  defp query!(db, sql) do
    {:ok, statement} = Sqlite3.prepare(db, sql)

    try do
      {:ok, rows} = Sqlite3.fetch_all(db, statement)
      rows
    after
      Sqlite3.release(db, statement)
    end
  end

  defp json_value!(%DateTime{} = value), do: DateTime.to_iso8601(value)
  defp json_value!(%NaiveDateTime{} = value), do: NaiveDateTime.to_iso8601(value)
  defp json_value!(%_{} = value), do: value |> Map.from_struct() |> json_value!()

  defp json_value!(value) when is_map(value),
    do: Map.new(value, fn {key, item} -> {key, json_value!(item)} end)

  defp json_value!(value) when is_list(value), do: Enum.map(value, &json_value!/1)
  defp json_value!(value) when is_binary(value) or is_number(value) or is_atom(value), do: value
  defp json_value!(_value), do: raise("unsupported persisted legacy value")
end
