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

  describe "empty-room reaping" do
    setup do
      # Earlier tests leave idle rooms in the app supervisor; clear them
      # so the reaper's choice is unambiguous.
      Stream.repeatedly(&RoomManager.reap_idlest_room/0)
      |> Enum.find(&(&1 == :none))

      :ok
    end

    test "a room that times out empty stays stopped and frees its capacity slot" do
      room_id = "test_reap_#{:erlang.unique_integer([:positive])}"
      supervisor = Process.whereis(Byob.RoomSupervisor)

      {:ok, pid} =
        DynamicSupervisor.start_child(
          Byob.RoomSupervisor,
          {Byob.RoomServer, room_id: room_id, empty_timeout: 20}
        )

      ref = Process.monitor(pid)
      assert_receive {:DOWN, ^ref, :process, ^pid, :normal}, 1_000

      # The DynamicSupervisor must not resurrect it — otherwise every room
      # ever created counts against @max_rooms forever.
      Process.sleep(100)
      assert Registry.lookup(Byob.RoomRegistry, room_id) == []

      # Under :permanent the restart loop also took the supervisor itself
      # down, killing every other live room with it.
      assert Process.whereis(Byob.RoomSupervisor) == supervisor
    end

    test "reap_idlest_room/0 stops an empty room and spares an occupied one" do
      occupied_id = "test_occupied_#{:erlang.unique_integer([:positive])}"
      empty_id = "test_empty_#{:erlang.unique_integer([:positive])}"

      {:ok, occupied} = RoomManager.ensure_room(occupied_id)
      {:ok, _state} = Byob.RoomServer.join(occupied, "user1", "SwiftHawk42")
      {:ok, empty} = RoomManager.ensure_room(empty_id)

      assert RoomManager.reap_idlest_room() == :ok

      refute Process.alive?(empty)
      assert Process.alive?(occupied)
    end

    test "reap_idlest_room/0 returns :none when every room is occupied" do
      room_id = "test_all_busy_#{:erlang.unique_integer([:positive])}"
      {:ok, pid} = RoomManager.ensure_room(room_id)
      {:ok, _state} = Byob.RoomServer.join(pid, "user1", "SwiftHawk42")

      assert RoomManager.reap_idlest_room() == :none
      assert Process.alive?(pid)
    end
  end
end
