defmodule Byob.LegacyExport do
  @moduledoc "Read-only export of legacy SQLite/ETF state for the Workers migration."

  alias Exqlite.Sqlite3

  @room_fields ~w(room_id api_key host_id queue current_index play_state current_time playback_rate history sb_settings activity_log persisted_wallclock)a
  @room_field_names Enum.map(@room_fields, &Atom.to_string/1)
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
          state = durable_state!(blob)

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

  # References in transient fields contain the old VM's node atom. Skip those
  # fields structurally rather than interning database-controlled atom names.
  # Durable values still go through Erlang's safe decoder unchanged.
  defp durable_state!(<<131, 116, count::32, rest::binary>>)
       when count <= 256 and byte_size(rest) <= 16_777_216 do
    selected = select_fields(rest, count, [])
    encoded = IO.iodata_to_binary([<<131, 116, length(selected)::32>> | selected])
    :erlang.binary_to_term(encoded, [:safe])
  end

  defp durable_state!(_), do: raise(ArgumentError, "unsupported legacy room encoding")

  defp select_fields(<<>>, 0, selected), do: Enum.reverse(selected)

  defp select_fields(binary, count, selected) when count > 0 do
    {key, rest} = take_term(binary)
    {value, rest} = take_term(rest)

    selected =
      if atom_name(key) in @room_field_names, do: [[key, value] | selected], else: selected

    select_fields(rest, count - 1, selected)
  end

  defp select_fields(_, _, _), do: raise(ArgumentError, "invalid legacy room encoding")

  defp atom_name(<<tag, size, name::binary-size(size)>>) when tag in [115, 119], do: name
  defp atom_name(<<tag, size::16, name::binary-size(size)>>) when tag in [100, 118], do: name
  defp atom_name(_), do: nil

  defp take_term(binary) do
    rest = skip_term(binary, 128)
    {binary_part(binary, 0, byte_size(binary) - byte_size(rest)), rest}
  end

  defp skip_term(_, depth) when depth <= 0,
    do: raise(ArgumentError, "legacy term nesting limit exceeded")

  defp skip_term(<<106, rest::binary>>, _), do: rest

  defp skip_term(<<tag, rest::binary>>, _) when tag in [70, 97, 98, 99],
    do: skip_bytes(rest, %{70 => 8, 97 => 1, 98 => 4, 99 => 31}[tag])

  defp skip_term(<<tag, size, rest::binary>>, _) when tag in [115, 119],
    do: skip_bytes(rest, size)

  defp skip_term(<<tag, size::16, rest::binary>>, _) when tag in [100, 107, 118],
    do: skip_bytes(rest, size)

  defp skip_term(<<109, size::32, rest::binary>>, _), do: skip_bytes(rest, size)
  defp skip_term(<<77, size::32, rest::binary>>, _), do: skip_bytes(rest, size + 1)
  defp skip_term(<<110, size, rest::binary>>, _), do: skip_bytes(rest, size + 1)
  defp skip_term(<<111, size::32, rest::binary>>, _), do: skip_bytes(rest, size + 1)

  defp skip_term(<<104, count, rest::binary>>, depth),
    do: skip_terms(rest, count, depth - 1)

  defp skip_term(<<105, count::32, rest::binary>>, depth),
    do: skip_terms(rest, count, depth - 1)

  defp skip_term(<<108, count::32, rest::binary>>, depth),
    do: skip_terms(rest, count + 1, depth - 1)

  defp skip_term(<<116, count::32, rest::binary>>, depth),
    do: skip_terms(rest, count * 2, depth - 1)

  defp skip_term(<<tag, count::16, rest::binary>>, depth) when tag in [90, 114],
    do: rest |> skip_term(depth - 1) |> skip_bytes(count * 4 + if(tag == 90, do: 4, else: 1))

  defp skip_term(<<tag, rest::binary>>, depth) when tag in [88, 89, 101, 102, 103, 120],
    do:
      rest
      |> skip_term(depth - 1)
      |> skip_bytes(%{88 => 12, 89 => 8, 101 => 5, 102 => 5, 103 => 9, 120 => 12}[tag])

  defp skip_term(_, _), do: raise(ArgumentError, "unsupported legacy term encoding")

  defp skip_terms(rest, 0, _), do: rest

  defp skip_terms(binary, count, depth) when count > 0 and count <= 1_000_000,
    do: skip_terms(skip_term(binary, depth), count - 1, depth)

  defp skip_terms(_, _, _), do: raise(ArgumentError, "legacy term size limit exceeded")

  defp skip_bytes(binary, size) when byte_size(binary) >= size,
    do: binary_part(binary, size, byte_size(binary) - size)

  defp skip_bytes(_, _), do: raise(ArgumentError, "truncated legacy term encoding")

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
