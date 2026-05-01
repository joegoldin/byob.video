defmodule Byob.RoomServerTest do
  use ExUnit.Case, async: true

  alias Byob.RoomServer

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
    test "marks user as disconnected", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "SwiftHawk42")
      :ok = RoomServer.leave(pid, "user1")
      # Leave is deferred by @leave_grace_ms (5 s) so brief reconnects
      # don't clobber state. Force-finalize so the test can assert the
      # post-grace behavior without sleeping.
      send(pid, {:finalize_leave, "user1"})
      state = RoomServer.get_state(pid)
      assert state.users["user1"].connected == false
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
      # Pause first so the play is a real state transition (paused → playing)
      RoomServer.pause(pid, "user1", 0.0)

      Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")
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

      Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")
      :ok = RoomServer.pause(pid, "user1", 5.0)
      state = RoomServer.get_state(pid)
      assert state.play_state == :paused

      assert_receive {:sync_pause, %{time: 5.0, user_id: "user1"}}
    end
  end

  describe "seek/3" do
    test "updates position and broadcasts personalized seek to other peers",
         %{pid: pid, room_id: room_id} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test1")
      {:ok, _} = RoomServer.join(pid, "user2", "Test2")
      RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=abc123", :now)

      Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")
      :ok = RoomServer.seek(pid, "user1", 30.0)

      # Originator (user1) is excluded; user2 receives a personalized
      # seek command with target ≈ 30.0 + default_learned_l_ms / 1000.
      default_l = Byob.SyncDecision.default_learned_l_ms() / 1000
      expected_target = 30.0 + default_l

      assert_receive {:user_seek_command, "user2", %{position: target}}
      assert_in_delta target, expected_target, 0.001
      refute_received {:user_seek_command, "user1", _}

      # snapshot returns current_position (which advances if playing) —
      # the seek just landed so it should be very close to 30.0.
      state = RoomServer.get_state(pid)
      assert_in_delta state.current_time, 30.0, 0.5
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
      # Ready-then-play: the room holds at :paused until every connected
      # user reports `video:loaded`. Simulate the test user loading.
      state = RoomServer.get_state(pid)
      assert state.play_state == :paused
      RoomServer.video_loaded(pid, "user1", hd(state.queue).id)
      state = RoomServer.get_state(pid)
      assert state.current_index == 0
      assert state.play_state == :playing
    end

    test "play now with existing queue removes old now-playing and puts new at front", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=first", :now)
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=queued", :queue)
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=playnow", :now)

      state = RoomServer.get_state(pid)
      # :now always puts the new item at index 0, removing the old now-playing
      assert state.current_index == 0
      assert Enum.at(state.queue, 0).source_id == "playnow"
      # "queued" is still in the queue after the new item
      assert Enum.at(state.queue, 1).source_id == "queued"
      # "first" was removed (it was the old now-playing)
      assert length(state.queue) == 2
    end
  end

  describe "remove_from_queue/2" do
    test "removes item by id", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=first", :now)
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=second", :queue)

      state = RoomServer.get_state(pid)
      second_id = Enum.at(state.queue, 1).id

      :ok = RoomServer.remove_from_queue(pid, second_id)
      state = RoomServer.get_state(pid)
      assert length(state.queue) == 1
    end

    test "removing now-playing item sets current_index to nil", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=a", :queue)
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=b", :queue)

      state = RoomServer.get_state(pid)
      assert state.current_index == 0
      now_playing_id = Enum.at(state.queue, 0).id
      :ok = RoomServer.remove_from_queue(pid, now_playing_id)

      state = RoomServer.get_state(pid)
      assert state.current_index == nil
      assert length(state.queue) == 1
    end
  end

  describe "skip/1" do
    test "advances to next item", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=a", :now)
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=b", :queue)

      :ok = RoomServer.skip(pid)
      # Ready-then-play: skip starts a fresh ready check on the next
      # item, so simulate the load before asserting :playing.
      state = RoomServer.get_state(pid)
      RoomServer.video_loaded(pid, "user1", hd(state.queue).id)
      state = RoomServer.get_state(pid)
      assert state.current_index == 0
      assert state.play_state == :playing
      assert length(state.queue) == 1
      assert hd(state.queue).source_id == "b"
    end

    test "sets ended at end of queue", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=a", :now)

      :ok = RoomServer.skip(pid)
      state = RoomServer.get_state(pid)
      assert state.play_state == :ended
    end
  end

  describe "video_ended/2" do
    test "schedules autoplay countdown then advances", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=a", :now)
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=b", :queue)

      # video_ended no longer advances synchronously — it schedules a 5 s
      # countdown. Queue stays put until :advance_pending fires.
      :ok = RoomServer.video_ended(pid, 0)
      immediate = RoomServer.get_state(pid)
      assert immediate.current_index == 0
      assert length(immediate.queue) == 2
      assert immediate.play_state == :paused

      # Trigger the deferred advance directly (instead of sleeping 5 s).
      send(pid, :advance_pending)
      state = RoomServer.get_state(pid)
      assert state.current_index == 0
      assert length(state.queue) == 1
      assert hd(state.queue).source_id == "b"
    end

    test "no-ops when index is stale", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=a", :now)
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=b", :queue)
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=c", :queue)
      RoomServer.skip(pid)

      # After skip: "a" removed, queue=["b","c"], current_index=0
      # Stale: send ended for index 5 (doesn't match current_index 0)
      :stale = RoomServer.video_ended(pid, 5)
      state = RoomServer.get_state(pid)
      assert state.current_index == 0
      assert hd(state.queue).source_id == "b"
    end
  end

  describe "play_index/2" do
    test "jumps to specific index", %{pid: pid} do
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=a", :queue)
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=b", :queue)
      :ok = RoomServer.add_to_queue(pid, "user1", "https://youtube.com/watch?v=c", :queue)

      :ok = RoomServer.play_index(pid, 2)
      # Ready-then-play: play_index starts a fresh ready check on the
      # newly-promoted item.
      state = RoomServer.get_state(pid)
      RoomServer.video_loaded(pid, "user1", hd(state.queue).id)
      state = RoomServer.get_state(pid)
      # play_index moves the target item to front, removes old now-playing
      assert state.current_index == 0
      assert state.play_state == :playing
      assert state.current_time < 0.1
      assert hd(state.queue).source_id == "c"
      assert length(state.queue) == 2
    end
  end

  describe "empty room cleanup" do
    test "stops after empty timeout", %{pid: pid} do
      ref = Process.monitor(pid)
      {:ok, _} = RoomServer.join(pid, "user1", "Test")
      :ok = RoomServer.leave(pid, "user1")
      # Force-finalize the deferred leave so the empty-room timeout
      # (50 ms in setup) actually engages within the assert window.
      send(pid, {:finalize_leave, "user1"})

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
