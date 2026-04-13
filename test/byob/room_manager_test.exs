defmodule Byob.RoomManagerTest do
  use ExUnit.Case, async: false

  alias Byob.RoomManager

  # These tests use the real supervision tree started by the application

  describe "create_room/0" do
    test "returns {:ok, room_id, api_key} with 8-char alphanumeric id" do
      {:ok, room_id, api_key} = RoomManager.create_room()
      assert is_binary(room_id)
      assert byte_size(room_id) == 8
      assert room_id =~ ~r/^[0-9a-z]{8}$/
      assert is_binary(api_key)
      assert byte_size(api_key) > 0
    end
  end

  describe "ensure_room/1" do
    test "starts a RoomServer for new room_id" do
      {:ok, pid} = RoomManager.ensure_room("test_new_room")
      assert Process.alive?(pid)
    end

    test "returns same pid for existing room" do
      {:ok, pid1} = RoomManager.ensure_room("test_existing")
      {:ok, pid2} = RoomManager.ensure_room("test_existing")
      assert pid1 == pid2
    end

    test "concurrent calls for same room_id don't crash" do
      room_id = "test_concurrent_#{:erlang.unique_integer([:positive])}"

      tasks = for _ <- 1..10, do: Task.async(fn -> RoomManager.ensure_room(room_id) end)
      results = Task.await_many(tasks)

      pids = for {:ok, pid} <- results, do: pid
      assert length(Enum.uniq(pids)) == 1
    end
  end
end
