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

  describe "play/3" do
    test "updates state to playing", %{pid: pid, room_id: room_id} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=abc123", :now)

      Phoenix.PubSub.subscribe(WatchParty.PubSub, "room:#{room_id}")
      :ok = RoomServer.play(pid, "user1", 10.0)
      state = RoomServer.get_state(pid)
      assert state.play_state == :playing

      assert_receive {:sync_play, %{time: 10.0, user_id: "user1"}}
    end
  end

  describe "pause/3" do
    test "updates state to paused", %{pid: pid, room_id: room_id} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=abc123", :now)
      RoomServer.play(pid, "user1", 0.0)

      Phoenix.PubSub.subscribe(WatchParty.PubSub, "room:#{room_id}")
      :ok = RoomServer.pause(pid, "user1", 5.0)
      state = RoomServer.get_state(pid)
      assert state.play_state == :paused

      assert_receive {:sync_pause, %{time: 5.0, user_id: "user1"}}
    end
  end

  describe "seek/3" do
    test "updates position", %{pid: pid, room_id: room_id} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=abc123", :now)

      Phoenix.PubSub.subscribe(WatchParty.PubSub, "room:#{room_id}")
      :ok = RoomServer.seek(pid, "user1", 30.0)

      assert_receive {:sync_seek, %{time: 30.0, user_id: "user1"}}
    end
  end

  describe "add_to_queue/4" do
    test "adds item to queue with :queue mode", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=abc123", :queue)
      state = RoomServer.get_state(pid)
      assert length(state.queue) == 1
      assert hd(state.queue).source_type == :youtube
    end

    test "play now starts playing when nothing is playing", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=abc123", :now)
      state = RoomServer.get_state(pid)
      assert state.current_index == 0
      assert state.play_state == :playing
    end

    test "play now with existing queue inserts after current and jumps", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=first", :now)
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=queued", :queue)
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=playnow", :now)

      state = RoomServer.get_state(pid)
      assert state.current_index == 1
      assert Enum.at(state.queue, 1).source_id == "playnow"
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
