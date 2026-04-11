defmodule Byob.Persistence do
  @moduledoc """
  SQLite persistence for room state. Stores room history and playback state
  so rooms survive server restarts. Max 100 rooms, 99 history entries per room.
  """

  use GenServer

  @db_path "priv/byob.db"
  @max_rooms 100
  @max_history 99

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, [], name: __MODULE__)
  end

  # Client API

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

  # Server

  @impl true
  def init(_) do
    db_dir = Path.dirname(@db_path)
    File.mkdir_p!(db_dir)
    {:ok, db} = Exqlite.Sqlite3.open(@db_path)

    Exqlite.Sqlite3.execute(db, """
    CREATE TABLE IF NOT EXISTS rooms (
      room_id TEXT PRIMARY KEY,
      state BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    )
    """)

    {:ok, %{db: db}}
  end

  @impl true
  def handle_cast({:save_room, room_id, state}, %{db: db} = s) do
    history = Enum.take(state.history || [], @max_history)
    state = %{state | history: history}

    blob = :erlang.term_to_binary(state)
    now = System.system_time(:second)

    {:ok, stmt} = Exqlite.Sqlite3.prepare(db,
      "INSERT OR REPLACE INTO rooms (room_id, state, updated_at) VALUES (?1, ?2, ?3)")
    :ok = Exqlite.Sqlite3.bind(stmt, [room_id, blob, now])
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

  @impl true
  def handle_call({:load_room, room_id}, _from, %{db: db} = s) do
    {:ok, stmt} = Exqlite.Sqlite3.prepare(db, "SELECT state FROM rooms WHERE room_id = ?1")
    :ok = Exqlite.Sqlite3.bind(stmt, [room_id])

    result =
      case Exqlite.Sqlite3.step(db, stmt) do
        {:row, [blob]} when is_binary(blob) ->
          {:ok, :erlang.binary_to_term(blob)}
        _ ->
          :not_found
      end

    Exqlite.Sqlite3.release(db, stmt)
    {:reply, result, s}
  end

  def handle_call(:list_rooms, _from, %{db: db} = s) do
    {:ok, stmt} = Exqlite.Sqlite3.prepare(db, "SELECT room_id FROM rooms ORDER BY updated_at DESC")
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

  def max_rooms, do: @max_rooms
end
