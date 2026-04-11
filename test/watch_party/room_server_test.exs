defmodule WatchParty.RoomServerTest do
  use ExUnit.Case, async: true

  alias WatchParty.RoomServer

  setup do
    room_id = "test_#{:erlang.unique_integer([:positive])}"
    pid = start_supervised!({RoomServer, room_id: room_id, empty_timeout: 50})
    %{pid: pid, room_id: room_id}
  end

  describe "start_link/1" do
    test "starts a process", %{pid: pid} do
      assert Process.alive?(pid)
    end
  end

  describe "join/3" do
    test "adds user and returns state", %{pid: pid} do
      {:ok, state} = RoomServer.join(pid, "user1", "SwiftHawk42")
      assert state.users["user1"].username == "SwiftHawk42"
    end

    test "double join is idempotent", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "SwiftHawk42")
      {:ok, state} = RoomServer.join(pid, "user1", "SwiftHawk42")
      assert map_size(state.users) == 1
    end
  end

  describe "leave/2" do
    test "removes user", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "SwiftHawk42")
      :ok = RoomServer.leave(pid, "user1")
      state = RoomServer.get_state(pid)
      assert state.users == %{}
    end
  end

  describe "get_state/1" do
    test "returns initial state", %{pid: pid} do
      state = RoomServer.get_state(pid)
      assert state.play_state == :paused
      assert state.current_time == 0.0
      assert state.queue == []
      assert state.current_index == nil
    end
  end

  describe "empty room cleanup" do
    test "stops after empty timeout", %{pid: pid} do
      ref = Process.monitor(pid)
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.leave(pid, "user1")

      assert_receive {:DOWN, ^ref, :process, ^pid, :normal}, 200
    end

    test "cancels cleanup when user joins", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.leave(pid, "user1")
      # Join before timeout fires
      {:ok, _} = RoomServer.join(pid, "user2", "Test2")
      Process.sleep(100)
      assert Process.alive?(pid)
    end
  end
end
