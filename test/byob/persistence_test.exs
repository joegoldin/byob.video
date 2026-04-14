defmodule Byob.PersistenceTest do
  use ExUnit.Case

  alias Byob.DB.Migrations

  @moduletag :tmp_dir

  setup %{tmp_dir: tmp_dir} do
    db_path = Path.join(tmp_dir, "test.db")
    {:ok, db} = Exqlite.Sqlite3.open(db_path)

    Exqlite.Sqlite3.execute(db, """
    CREATE TABLE rooms (
      room_id TEXT PRIMARY KEY,
      state BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    )
    """)

    %{db: db, db_path: db_path}
  end

  describe "schema_version default" do
    test "loading a room without schema_version column defaults to version 1", %{db: db} do
      # Insert a row without schema_version (simulating old schema)
      state = %{queue: [], history: [], playing: nil}
      blob = :erlang.term_to_binary(state)
      now = System.system_time(:second)

      {:ok, stmt} = Exqlite.Sqlite3.prepare(db,
        "INSERT INTO rooms (room_id, state, updated_at) VALUES (?1, ?2, ?3)")
      :ok = Exqlite.Sqlite3.bind(stmt, ["test-room", blob, now])
      Exqlite.Sqlite3.step(db, stmt)
      Exqlite.Sqlite3.release(db, stmt)

      # Now add the column (as init would)
      Exqlite.Sqlite3.execute(db, "ALTER TABLE rooms ADD COLUMN schema_version INTEGER DEFAULT 1")

      # Read back — schema_version should be 1 (the DEFAULT)
      {:ok, stmt} = Exqlite.Sqlite3.prepare(db,
        "SELECT state, schema_version FROM rooms WHERE room_id = ?1")
      :ok = Exqlite.Sqlite3.bind(stmt, ["test-room"])

      {:row, [loaded_blob, schema_version]} = Exqlite.Sqlite3.step(db, stmt)
      Exqlite.Sqlite3.release(db, stmt)

      loaded_version = schema_version || 1
      loaded_state = :erlang.binary_to_term(loaded_blob, [:safe])
      result = Migrations.run(loaded_state, loaded_version, Migrations.current_version())

      assert result == state
      assert loaded_version == 1
    end
  end
end
