defmodule WatchParty.RoomServer do
  use GenServer

  defstruct [
    :room_id,
    :host_id,
    :cleanup_ref,
    :sync_correction_ref,
    :empty_timeout,
    users: %{},
    queue: [],
    current_index: nil,
    play_state: :paused,
    current_time: 0.0,
    last_sync_at: 0,
    playback_rate: 1.0,
    history: [],
    last_seek_at: %{},
    event_counts: %{},
    rate_limit_ref: nil
  ]

  # Client API

  def start_link(opts) do
    room_id = Keyword.fetch!(opts, :room_id)
    name = {:via, Registry, {WatchParty.RoomRegistry, room_id}}
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def join(pid, user_id, username) do
    GenServer.call(pid, {:join, user_id, username})
  end

  def leave(pid, user_id) do
    GenServer.call(pid, {:leave, user_id})
  end

  def get_state(pid) do
    GenServer.call(pid, :get_state)
  end

  def play(pid, user_id, position) do
    GenServer.call(pid, {:play, user_id, position})
  end

  def pause(pid, user_id, position) do
    GenServer.call(pid, {:pause, user_id, position})
  end

  def seek(pid, user_id, position) do
    GenServer.call(pid, {:seek, user_id, position})
  end

  def add_to_queue(pid, user_id, url, mode) do
    GenServer.call(pid, {:add_to_queue, user_id, url, mode})
  end

  def video_ended(pid, index) do
    GenServer.call(pid, {:video_ended, index})
  end

  def skip(pid) do
    GenServer.call(pid, :skip)
  end

  def remove_from_queue(pid, item_id) do
    GenServer.call(pid, {:remove_from_queue, item_id})
  end

  def play_index(pid, index) do
    GenServer.call(pid, {:play_index, index})
  end

  def rename_user(pid, user_id, new_username) do
    GenServer.call(pid, {:rename_user, user_id, new_username})
  end

  # Server callbacks

  @impl true
  def init(opts) do
    room_id = Keyword.fetch!(opts, :room_id)
    empty_timeout = Keyword.get(opts, :empty_timeout, :timer.minutes(5))

    state = %__MODULE__{
      room_id: room_id,
      empty_timeout: empty_timeout,
      last_sync_at: System.monotonic_time(:millisecond)
    }

    # Start cleanup timer since room starts empty
    state = schedule_rate_limit_reset(state)
    {:ok, schedule_cleanup(state)}
  end

  @impl true
  def handle_call({:join, user_id, username}, _from, state) do
    state =
      state
      |> cancel_cleanup()
      |> put_in([Access.key(:users), user_id], %{
        username: username,
        joined_at: System.monotonic_time(:millisecond)
      })
      |> maybe_set_host(user_id)

    broadcast(state, {:users_updated, state.users})
    {:reply, {:ok, snapshot(state)}, state}
  end

  def handle_call({:leave, user_id}, _from, state) do
    state = %{state | users: Map.delete(state.users, user_id)}

    state =
      if map_size(state.users) == 0 do
        schedule_cleanup(state)
      else
        broadcast(state, {:users_updated, state.users})
        state
      end

    {:reply, :ok, state}
  end

  def handle_call(:get_state, _from, state) do
    {:reply, snapshot(state), state}
  end

  def handle_call({:play, user_id, position}, _from, state) do
    case check_rate_limit(state, user_id) do
      {:error, state} ->
        {:reply, {:error, :rate_limited}, state}

      {:ok, state} ->
        now = System.monotonic_time(:millisecond)
        state = %{state | play_state: :playing, current_time: position, last_sync_at: now}
        state = schedule_sync_correction(state)
        broadcast(state, {:sync_play, %{time: position, server_time: now, user_id: user_id}})
        {:reply, :ok, state}
    end
  end

  def handle_call({:pause, user_id, position}, _from, state) do
    case check_rate_limit(state, user_id) do
      {:error, state} ->
        {:reply, {:error, :rate_limited}, state}

      {:ok, state} ->
        now = System.monotonic_time(:millisecond)
        state = %{state | play_state: :paused, current_time: position, last_sync_at: now}
        state = cancel_sync_correction(state)
        broadcast(state, {:sync_pause, %{time: position, server_time: now, user_id: user_id}})
        {:reply, :ok, state}
    end
  end

  def handle_call({:seek, user_id, position}, _from, state) do
    now = System.monotonic_time(:millisecond)
    last = Map.get(state.last_seek_at, user_id)

    if last != nil and now - last < 500 do
      {:reply, {:error, :debounced}, state}
    else
      state = %{state | current_time: position, last_sync_at: now, last_seek_at: Map.put(state.last_seek_at, user_id, now)}
      broadcast(state, {:sync_seek, %{time: position, server_time: now, user_id: user_id}})
      {:reply, :ok, state}
    end
  end

  def handle_call({:add_to_queue, user_id, url, mode}, _from, state) do
    case WatchParty.MediaItem.parse_url(url) do
      {:ok, item} ->
        item = %{item | added_by: user_id, added_at: DateTime.utc_now()}
        state = add_item_to_queue(state, item, mode)
        broadcast(state, {:queue_updated, %{queue: state.queue, current_index: state.current_index}})

        # Fetch metadata async for YouTube videos
        if item.source_type == :youtube do
          item_id = item.id
          pid = self()

          Task.start(fn ->
            case WatchParty.OEmbed.fetch_youtube(url) do
              {:ok, meta} -> send(pid, {:oembed_result, item_id, meta})
              _ -> :ok
            end
          end)
        end

        {:reply, :ok, state}

      {:error, reason} ->
        {:reply, {:error, reason}, state}
    end
  end

  def handle_call({:video_ended, index}, _from, %{current_index: index} = state) do
    state = advance_queue(state)
    {:reply, :ok, state}
  end

  def handle_call({:video_ended, _stale_index}, _from, state) do
    {:reply, :ok, state}
  end

  def handle_call(:skip, _from, state) do
    state = advance_queue(state)
    {:reply, :ok, state}
  end

  def handle_call({:remove_from_queue, item_id}, _from, state) do
    idx = Enum.find_index(state.queue, &(&1.id == item_id))

    if idx do
      queue = List.delete_at(state.queue, idx)

      current_index =
        cond do
          state.current_index == nil -> nil
          idx < state.current_index -> state.current_index - 1
          idx == state.current_index -> nil
          true -> state.current_index
        end

      state = %{state | queue: queue, current_index: current_index}
      broadcast(state, {:queue_updated, %{queue: state.queue, current_index: state.current_index}})
      {:reply, :ok, state}
    else
      {:reply, :ok, state}
    end
  end

  def handle_call({:play_index, index}, _from, state) when index >= 0 and index < length(state.queue) do
    now = System.monotonic_time(:millisecond)
    item = Enum.at(state.queue, index)

    state = %{state | current_index: index, current_time: 0.0, last_sync_at: now, play_state: :playing}
    state = add_to_history(state, item)
    state = schedule_sync_correction(state)

    broadcast(state, {:video_changed, %{media_item: item, index: index}})
    broadcast(state, {:queue_updated, %{queue: state.queue, current_index: state.current_index}})
    {:reply, :ok, state}
  end

  def handle_call({:play_index, _index}, _from, state) do
    {:reply, {:error, :invalid_index}, state}
  end

  def handle_call({:rename_user, user_id, new_username}, _from, state) do
    state = put_in(state.users[user_id].username, new_username)
    broadcast(state, {:users_updated, state.users})
    {:reply, :ok, state}
  end

  @impl true
  def handle_info(:check_empty, state) do
    if map_size(state.users) == 0 do
      {:stop, :normal, state}
    else
      {:noreply, state}
    end
  end

  def handle_info({:oembed_result, item_id, meta}, state) do
    queue =
      Enum.map(state.queue, fn item ->
        if item.id == item_id do
          %{item | title: meta.title, thumbnail_url: meta.thumbnail_url}
        else
          item
        end
      end)

    state = %{state | queue: queue}
    broadcast(state, {:queue_updated, %{queue: state.queue, current_index: state.current_index}})
    {:noreply, state}
  end

  def handle_info(:reset_rate_limits, state) do
    state = %{state | event_counts: %{}}
    state = schedule_rate_limit_reset(state)
    {:noreply, state}
  end

  def handle_info(:sync_correction, %{play_state: :playing} = state) do
    now = System.monotonic_time(:millisecond)
    position = current_position(state)
    broadcast(state, {:sync_correction, %{expected_time: position, server_time: now}})
    state = %{state | sync_correction_ref: Process.send_after(self(), :sync_correction, 5000)}
    {:noreply, state}
  end

  def handle_info(:sync_correction, state) do
    {:noreply, state}
  end

  # Private helpers

  defp current_position(%{play_state: :playing} = state) do
    elapsed = (System.monotonic_time(:millisecond) - state.last_sync_at) / 1000
    state.current_time + elapsed
  end

  defp current_position(state), do: state.current_time

  defp snapshot(state) do
    %{
      room_id: state.room_id,
      users: state.users,
      queue: state.queue,
      current_index: state.current_index,
      play_state: state.play_state,
      current_time: current_position(state),
      server_time: System.monotonic_time(:millisecond),
      playback_rate: state.playback_rate,
      history: state.history
    }
  end

  defp schedule_cleanup(state) do
    ref = Process.send_after(self(), :check_empty, state.empty_timeout)
    %{state | cleanup_ref: ref}
  end

  defp cancel_cleanup(%{cleanup_ref: nil} = state), do: state

  defp cancel_cleanup(%{cleanup_ref: ref} = state) do
    Process.cancel_timer(ref)
    %{state | cleanup_ref: nil}
  end

  defp maybe_set_host(%{host_id: nil} = state, user_id), do: %{state | host_id: user_id}
  defp maybe_set_host(state, _user_id), do: state

  defp broadcast(state, message) do
    Phoenix.PubSub.broadcast(WatchParty.PubSub, "room:#{state.room_id}", message)
  end

  defp add_to_history(state, item) do
    entry = %{item: item, played_at: DateTime.utc_now()}
    # Deduplicate: don't add if the last history entry is the same item
    case state.history do
      [%{item: %{id: id}} | _] when id == item.id -> state
      _ -> %{state | history: [entry | state.history]}
    end
  end

  defp add_item_to_queue(state, item, :queue) do
    %{state | queue: state.queue ++ [item]}
  end

  defp add_item_to_queue(state, item, :now) do
    now = System.monotonic_time(:millisecond)

    case state.current_index do
      nil ->
        state = %{state | queue: [item], current_index: 0, current_time: 0.0, last_sync_at: now, play_state: :playing}
        state = add_to_history(state, item)
        state = schedule_sync_correction(state)
        broadcast(state, {:video_changed, %{media_item: item, index: 0}})
        state

      idx ->
        insert_at = idx + 1
        queue = List.insert_at(state.queue, insert_at, item)
        state = %{state | queue: queue, current_index: insert_at, current_time: 0.0, last_sync_at: now, play_state: :playing}
        state = add_to_history(state, item)
        state = schedule_sync_correction(state)
        broadcast(state, {:video_changed, %{media_item: item, index: insert_at}})
        state
    end
  end

  defp advance_queue(state) do
    now = System.monotonic_time(:millisecond)
    next_index = (state.current_index || -1) + 1

    if next_index < length(state.queue) do
      item = Enum.at(state.queue, next_index)
      state = %{state | current_index: next_index, current_time: 0.0, last_sync_at: now, play_state: :playing}
      state = add_to_history(state, item)
      state = schedule_sync_correction(state)
      broadcast(state, {:video_changed, %{media_item: item, index: next_index}})
      broadcast(state, {:queue_updated, %{queue: state.queue, current_index: next_index}})
      state
    else
      state = %{state | play_state: :ended, current_time: 0.0, last_sync_at: now}
      state = cancel_sync_correction(state)
      state
    end
  end

  defp schedule_sync_correction(state) do
    state = cancel_sync_correction(state)
    ref = Process.send_after(self(), :sync_correction, 5000)
    %{state | sync_correction_ref: ref}
  end

  defp schedule_rate_limit_reset(state) do
    ref = Process.send_after(self(), :reset_rate_limits, 5000)
    %{state | rate_limit_ref: ref}
  end

  defp check_rate_limit(state, user_id) do
    count = Map.get(state.event_counts, user_id, 0)

    if count >= 20 do
      {:error, state}
    else
      {:ok, %{state | event_counts: Map.put(state.event_counts, user_id, count + 1)}}
    end
  end

  defp cancel_sync_correction(%{sync_correction_ref: nil} = state), do: state

  defp cancel_sync_correction(%{sync_correction_ref: ref} = state) do
    Process.cancel_timer(ref)
    %{state | sync_correction_ref: nil}
  end
end
