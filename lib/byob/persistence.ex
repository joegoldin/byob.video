defmodule Byob.Persistence do
  @moduledoc """
  SQLite persistence for room state and the roulette/voting video pool.
  Stores room history and playback state so rooms survive server restarts.
  Also owns the `video_pool` table used by the roulette/voting feature.
  Max 100 rooms, 99 history entries per room.
  """

  use GenServer

  alias Byob.DB.Migrations

  @default_db_path "priv/byob.db"
  defp db_path, do: System.get_env("BYOB_DB_PATH") || @default_db_path
  @max_rooms 100
  @max_history 99

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  # Client API — rooms

  def save_room(room_id, state) do
    GenServer.cast(__MODULE__, {:save_room, room_id, state})
  end

  def load_room(room_id) do
    GenServer.call(__MODULE__, {:load_room, room_id})
  end

  def list_rooms do
    GenServer.call(__MODULE__, :list_rooms)
  end

  def room_count do
    GenServer.call(__MODULE__, :room_count)
  end

  def delete_room(room_id) do
    GenServer.cast(__MODULE__, {:delete_room, room_id})
  end

  # Client API — video pool

  @doc """
  Bulk insert-or-update pool entries. Each entry is a map with keys:
  :source_type, :source_detail, :external_id, :title, :channel, :duration_s,
  :thumbnail_url, :score. `first_seen_at` is preserved on conflict; `last_seen_at`,
  `title`, `channel`, `duration_s`, `thumbnail_url`, `score` are updated.
  """
  def upsert_pool_entries(entries) when is_list(entries) do
    GenServer.call(__MODULE__, {:upsert_pool_entries, entries}, 30_000)
  end

  @doc """
  Weighted random pick from `video_pool` by `source_type`, excluding
  `exclude_external_ids`. Returns up to `limit` rows (maps).
  Curated source skips freshness decay; other sources use a 14-day half-scale.
  All sources apply a 30-day half-scale repeat decay on `last_picked_at`.
  """
  def pick_pool_candidates(source_type, limit, exclude_external_ids \\ []) do
    GenServer.call(
      __MODULE__,
      {:pick_pool_candidates, source_type, limit, exclude_external_ids}
    )
  end

  @doc """
  Mark a pool video as picked (winner of a round). Updates `last_picked_at`
  across every row with that external_id (same YT vid can exist under multiple
  source_types).
  """
  def mark_pool_picked(external_id) when is_binary(external_id) do
    GenServer.cast(__MODULE__, {:mark_pool_picked, external_id})
  end

  @doc "Total count of rows in video_pool. For admin/debug."
  def pool_count do
    GenServer.call(__MODULE__, :pool_count)
  end

  @doc "Count rows per source_type. For admin/debug."
  def pool_counts_by_source do
    GenServer.call(__MODULE__, :pool_counts_by_source)
  end

  # Server

  @impl true
  def init(_) do
    db_dir = Path.dirname(db_path())
    File.mkdir_p!(db_dir)
    {:ok, db} = Exqlite.Sqlite3.open(db_path())

    # WAL mode allows the background pool scheduler / query path to coexist
    # with room saves without SQLITE_BUSY contention. All writes still go
    # through this single GenServer, but readers (e.g. mix tasks) would
    # benefit. Safe on first run and idempotent.
    Exqlite.Sqlite3.execute(db, "PRAGMA journal_mode=WAL")
    Exqlite.Sqlite3.execute(db, "PRAGMA foreign_keys=ON")

    Exqlite.Sqlite3.execute(db, """
    CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      state BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    )
    """)

    # Add schema_version column (idempotent — fails silently if already exists)
    try do
      Exqlite.Sqlite3.execute(db, "ALTER TABLE rooms ADD COLUMN schema_version INTEGER DEFAULT 1")
    rescue
      _ -> :ok
    end

    Exqlite.Sqlite3.execute(db, """
    CREATE TABLE IF NOT EXISTS video_pool (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type    TEXT NOT NULL,
      source_detail  TEXT,
      external_id    TEXT NOT NULL,
      title          TEXT NOT NULL,
      channel        TEXT,
      duration_s     INTEGER,
      thumbnail_url  TEXT,
      score          INTEGER,
      first_seen_at  INTEGER NOT NULL,
      last_seen_at   INTEGER NOT NULL,
      last_picked_at INTEGER,
      UNIQUE(source_type, external_id)
    )
    """)

    Exqlite.Sqlite3.execute(
      db,
      "CREATE INDEX IF NOT EXISTS idx_pool_source_seen ON video_pool(source_type, last_seen_at DESC)"
    )

    Exqlite.Sqlite3.execute(
      db,
      "CREATE INDEX IF NOT EXISTS idx_pool_external ON video_pool(external_id)"
    )

    {:ok, %{db: db}}
  end

  @impl true
  def handle_cast({:save_room, room_id, state}, %{db: db} = s) do
    history = Enum.take(state.history || [], @max_history)
    state = %{state | history: history}

    blob = :erlang.term_to_binary(state)
    now = System.system_time(:second)

    {:ok, stmt} =
      Exqlite.Sqlite3.prepare(
        db,
        "INSERT OR REPLACE INTO rooms (room_id, state, updated_at, schema_version) VALUES (?1, ?2, ?3, ?4)"
      )

    :ok = Exqlite.Sqlite3.bind(stmt, [room_id, blob, now, Migrations.current_version()])
    Exqlite.Sqlite3.step(db, stmt)
    Exqlite.Sqlite3.release(db, stmt)

    {:noreply, s}
  end

  def handle_cast({:delete_room, room_id}, %{db: db} = s) do
    {:ok, stmt} = Exqlite.Sqlite3.prepare(db, "DELETE FROM rooms WHERE room_id = ?1")
    :ok = Exqlite.Sqlite3.bind(stmt, [room_id])
    Exqlite.Sqlite3.step(db, stmt)
    Exqlite.Sqlite3.release(db, stmt)
    {:noreply, s}
  end

  def handle_cast({:mark_pool_picked, external_id}, %{db: db} = s) do
    now = System.system_time(:millisecond)

    {:ok, stmt} =
      Exqlite.Sqlite3.prepare(
        db,
        "UPDATE video_pool SET last_picked_at = ?1 WHERE external_id = ?2"
      )

    :ok = Exqlite.Sqlite3.bind(stmt, [now, external_id])
    Exqlite.Sqlite3.step(db, stmt)
    Exqlite.Sqlite3.release(db, stmt)
    {:noreply, s}
  end

  @impl true
  def handle_call({:load_room, room_id}, _from, %{db: db} = s) do
    {:ok, stmt} =
      Exqlite.Sqlite3.prepare(
        db,
        "SELECT state, schema_version FROM rooms WHERE room_id = ?1"
      )

    :ok = Exqlite.Sqlite3.bind(stmt, [room_id])

    result =
      case Exqlite.Sqlite3.step(db, stmt) do
        {:row, [blob, schema_version]} when is_binary(blob) ->
          loaded_version = schema_version || 1
          state = :erlang.binary_to_term(blob, [:safe])
          {:ok, Migrations.run(state, loaded_version, Migrations.current_version())}

        _ ->
          :not_found
      end

    Exqlite.Sqlite3.release(db, stmt)
    {:reply, result, s}
  end

  def handle_call(:list_rooms, _from, %{db: db} = s) do
    {:ok, stmt} =
      Exqlite.Sqlite3.prepare(db, "SELECT room_id FROM rooms ORDER BY updated_at DESC")

    rooms = collect_rows(db, stmt, [])
    Exqlite.Sqlite3.release(db, stmt)
    {:reply, rooms, s}
  end

  def handle_call(:room_count, _from, %{db: db} = s) do
    {:ok, stmt} = Exqlite.Sqlite3.prepare(db, "SELECT COUNT(*) FROM rooms")

    count =
      case Exqlite.Sqlite3.step(db, stmt) do
        {:row, [n]} -> n
        _ -> 0
      end

    Exqlite.Sqlite3.release(db, stmt)
    {:reply, count, s}
  end

  def handle_call({:upsert_pool_entries, entries}, _from, %{db: db} = s) do
    now = System.system_time(:millisecond)

    Exqlite.Sqlite3.execute(db, "BEGIN IMMEDIATE")

    try do
      Enum.each(entries, fn entry ->
        {:ok, stmt} =
          Exqlite.Sqlite3.prepare(db, """
          INSERT INTO video_pool (
            source_type, source_detail, external_id, title, channel,
            duration_s, thumbnail_url, score, first_seen_at, last_seen_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
          ON CONFLICT(source_type, external_id) DO UPDATE SET
            last_seen_at = excluded.last_seen_at,
            title        = excluded.title,
            channel      = excluded.channel,
            duration_s   = excluded.duration_s,
            thumbnail_url = excluded.thumbnail_url,
            score        = excluded.score,
            source_detail = excluded.source_detail
          """)

        :ok =
          Exqlite.Sqlite3.bind(stmt, [
            to_string(entry.source_type),
            entry[:source_detail],
            entry.external_id,
            entry.title,
            entry[:channel],
            entry[:duration_s],
            entry[:thumbnail_url],
            entry[:score],
            now
          ])

        Exqlite.Sqlite3.step(db, stmt)
        Exqlite.Sqlite3.release(db, stmt)
      end)

      Exqlite.Sqlite3.execute(db, "COMMIT")
    rescue
      e ->
        Exqlite.Sqlite3.execute(db, "ROLLBACK")
        reraise e, __STACKTRACE__
    end

    {:reply, {:ok, length(entries)}, s}
  end

  def handle_call(
        {:pick_pool_candidates, source_type, limit, exclude_external_ids},
        _from,
        %{db: db} = s
      ) do
    now = System.system_time(:millisecond)

    # Build the NOT IN placeholder list for excludes. If empty, we omit the
    # clause entirely.
    {exclude_sql, exclude_params} =
      case exclude_external_ids do
        [] ->
          {"", []}

        ids ->
          placeholders = Enum.map_join(ids, ",", fn _ -> "?" end)
          {" AND external_id NOT IN (#{placeholders})", ids}
      end

    # Gumbel-trick weighted sampling. Weight = freshness_factor * repeat_factor.
    # Curated skips the freshness decay (playlists are evergreens).
    {freshness_sql, freshness_params} =
      if source_type == :curated,
        do: {"1.0", []},
        else: {"exp(-((? - first_seen_at) / 1209600000.0))", [now]}

    query = """
    SELECT id, source_type, source_detail, external_id, title, channel,
           duration_s, thumbnail_url, score, first_seen_at, last_seen_at,
           last_picked_at
      FROM video_pool
     WHERE source_type = ?#{exclude_sql}
     ORDER BY
       -ln(abs(random()) / 9223372036854775807.0 + 1e-10)
       / (#{freshness_sql}
         * CASE WHEN last_picked_at IS NULL THEN 1.0
                ELSE (1.0 - exp(-((? - last_picked_at) / 2592000000.0)))
           END)
     LIMIT ?
    """

    # Positional order: source_type, ...excludes, [freshness_now], repeat_now, limit
    params =
      [to_string(source_type)] ++
        exclude_params ++
        freshness_params ++
        [now, limit]

    {:ok, stmt} = Exqlite.Sqlite3.prepare(db, query)
    :ok = Exqlite.Sqlite3.bind(stmt, params)
    rows = collect_pool_rows(db, stmt, [])
    Exqlite.Sqlite3.release(db, stmt)

    {:reply, rows, s}
  end

  def handle_call(:pool_count, _from, %{db: db} = s) do
    {:ok, stmt} = Exqlite.Sqlite3.prepare(db, "SELECT COUNT(*) FROM video_pool")

    count =
      case Exqlite.Sqlite3.step(db, stmt) do
        {:row, [n]} -> n
        _ -> 0
      end

    Exqlite.Sqlite3.release(db, stmt)
    {:reply, count, s}
  end

  def handle_call(:pool_counts_by_source, _from, %{db: db} = s) do
    {:ok, stmt} =
      Exqlite.Sqlite3.prepare(
        db,
        "SELECT source_type, COUNT(*) FROM video_pool GROUP BY source_type"
      )

    result = collect_counts(db, stmt, %{})
    Exqlite.Sqlite3.release(db, stmt)
    {:reply, result, s}
  end

  @impl true
  def terminate(_reason, %{db: db}) do
    Exqlite.Sqlite3.close(db)
  end

  defp collect_rows(db, stmt, acc) do
    case Exqlite.Sqlite3.step(db, stmt) do
      {:row, [room_id]} -> collect_rows(db, stmt, [room_id | acc])
      :done -> Enum.reverse(acc)
    end
  end

  defp collect_counts(db, stmt, acc) do
    case Exqlite.Sqlite3.step(db, stmt) do
      {:row, [source_type, n]} -> collect_counts(db, stmt, Map.put(acc, source_type, n))
      :done -> acc
    end
  end

  defp collect_pool_rows(db, stmt, acc) do
    case Exqlite.Sqlite3.step(db, stmt) do
      {:row,
       [
         id,
         source_type,
         source_detail,
         external_id,
         title,
         channel,
         duration_s,
         thumbnail_url,
         score,
         first_seen_at,
         last_seen_at,
         last_picked_at
       ]} ->
        row = %{
          id: id,
          source_type: String.to_atom(source_type),
          source_detail: source_detail,
          external_id: external_id,
          title: title,
          channel: channel,
          duration_s: duration_s,
          thumbnail_url: thumbnail_url,
          score: score,
          first_seen_at: first_seen_at,
          last_seen_at: last_seen_at,
          last_picked_at: last_picked_at
        }

        collect_pool_rows(db, stmt, [row | acc])

      :done ->
        Enum.reverse(acc)
    end
  end

  def max_rooms, do: @max_rooms
end
