defmodule Byob.RoomServer do
  use GenServer

  @default_sb_settings %{
    "sponsor" => "auto_skip",
    "selfpromo" => "show_bar",
    "interaction" => "show_bar",
    "intro" => "show_bar",
    "outro" => "show_bar",
    "preview" => "show_bar",
    "music_offtopic" => "disabled",
    "filler" => "show_bar"
  }

  defstruct [
    :room_id,
    :host_id,
    :cleanup_ref,
    :sync_correction_ref,
    :empty_timeout,
    :api_key,
    users: %{},
    queue: [],
    current_index: nil,
    play_state: :paused,
    current_time: 0.0,
    last_sync_at: 0,
    playback_rate: 1.0,
    history: [],
    sponsor_segments: [],
    sb_settings: %{},
    last_seek_at: %{},
    event_counts: %{},
    rate_limit_ref: nil
  ]

  def default_sb_settings, do: @default_sb_settings

  # Client API

  def start_link(opts) do
    room_id = Keyword.fetch!(opts, :room_id)
    name = {:via, Registry, {Byob.RoomRegistry, room_id}}
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

  def reorder_queue(pid, from_index, to_index) do
    GenServer.call(pid, {:reorder_queue, from_index, to_index})
  end

  def rename_user(pid, user_id, new_username) do
    GenServer.call(pid, {:rename_user, user_id, new_username})
  end

  def update_sb_settings(pid, category, action) do
    GenServer.call(pid, {:update_sb_settings, category, action})
  end

  def get_api_key(pid) do
    GenServer.call(pid, :get_api_key)
  end

  # Server callbacks

  @impl true
  def init(opts) do
    room_id = Keyword.fetch!(opts, :room_id)
    empty_timeout = Keyword.get(opts, :empty_timeout, :timer.minutes(5))

    loaded = try do Byob.Persistence.load_room(room_id) rescue _ -> :not_found catch :exit, _ -> :not_found end

    state =
      case loaded do
        {:ok, saved} ->
          # Restore from saved state, reset transient fields
          %{saved |
            empty_timeout: empty_timeout,
            last_sync_at: System.monotonic_time(:millisecond),
            cleanup_ref: nil,
            sync_correction_ref: nil,
            rate_limit_ref: nil,
            last_seek_at: %{},
            event_counts: %{},
            play_state: :paused,
            sponsor_segments: [],
            users: Enum.into(saved.users, %{}, fn {k, v} -> {k, %{v | connected: false}} end)
          }

        :not_found ->
          %__MODULE__{
            room_id: room_id,
            empty_timeout: empty_timeout,
            last_sync_at: System.monotonic_time(:millisecond),
            sb_settings: @default_sb_settings
          }
      end

    # Ensure api_key is set
    state =
      if state.api_key do
        state
      else
        %{state | api_key: :crypto.strong_rand_bytes(24) |> Base.url_encode64(padding: false)}
      end

    # Start timers
    state = schedule_rate_limit_reset(state)
    state = schedule_persist(state)
    {:ok, schedule_cleanup(state)}
  end

  @impl true
  def handle_call({:join, user_id, username}, _from, state) do
    state =
      state
      |> cancel_cleanup()
      |> put_in([Access.key(:users), user_id], %{
        username: username,
        joined_at: System.monotonic_time(:millisecond),
        connected: true
      })
      |> maybe_set_host(user_id)

    # Fetch sponsor segments if we have a current YouTube video but no segments
    if state.sponsor_segments == [] && state.current_index do
      current_item = Enum.at(state.queue, state.current_index)
      if current_item, do: fetch_sponsor_segments(current_item)
    end

    broadcast(state, {:users_updated, state.users})
    {:reply, {:ok, snapshot(state)}, state}
  end

  def handle_call({:leave, user_id}, _from, state) do
    # Mark as disconnected instead of removing
    state =
      case Map.get(state.users, user_id) do
        nil -> state
        user -> put_in(state.users[user_id], %{user | connected: false})
      end

    connected_count = Enum.count(state.users, fn {_, u} -> u.connected end)

    state =
      if connected_count == 0 do
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

  def handle_call(:get_api_key, _from, state) do
    {:reply, state.api_key, state}
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
    case Byob.MediaItem.parse_url(url) do
      {:ok, item} ->
        added_by_name =
          case Map.get(state.users, user_id) do
            %{username: name} -> name
            _ -> nil
          end

        item = %{item | added_by: user_id, added_by_name: added_by_name, added_at: DateTime.utc_now()}
        state = add_item_to_queue(state, item, mode)
        broadcast(state, {:queue_updated, %{queue: state.queue, current_index: state.current_index}})

        # Fetch metadata async
        item_id = item.id
        pid = self()

        Task.start(fn ->
          result =
            if item.source_type == :youtube do
              Byob.OEmbed.fetch_youtube(url)
            else
              Byob.OEmbed.fetch_opengraph(url)
            end

          case result do
            {:ok, meta} -> send(pid, {:oembed_result, item_id, meta})
            _ -> :ok
          end
        end)

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
    {:reply, :stale, state}
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

    state = %{state | current_index: index, current_time: 0.0, last_sync_at: now, play_state: :playing, sponsor_segments: []}
    state = add_to_history(state, item)
    state = schedule_sync_correction(state)
    fetch_sponsor_segments(item)

    broadcast(state, {:video_changed, %{media_item: item, index: index}})
    broadcast(state, {:queue_updated, %{queue: state.queue, current_index: state.current_index}})
    {:reply, :ok, state}
  end

  def handle_call({:play_index, _index}, _from, state) do
    {:reply, {:error, :invalid_index}, state}
  end

  def handle_call({:reorder_queue, from, to}, _from, state)
      when from >= 0 and from < length(state.queue) and to >= 0 and to < length(state.queue) and from != to do
    item = Enum.at(state.queue, from)
    queue = List.delete_at(state.queue, from) |> List.insert_at(to, item)

    # Adjust current_index to track the currently playing item
    current_index =
      cond do
        state.current_index == nil -> nil
        state.current_index == from -> to
        from < state.current_index and to >= state.current_index -> state.current_index - 1
        from > state.current_index and to <= state.current_index -> state.current_index + 1
        true -> state.current_index
      end

    state = %{state | queue: queue, current_index: current_index}
    broadcast(state, {:queue_updated, %{queue: state.queue, current_index: state.current_index}})
    {:reply, :ok, state}
  end

  def handle_call({:reorder_queue, _, _}, _from, state) do
    {:reply, :ok, state}
  end

  def handle_call({:rename_user, user_id, new_username}, _from, state) do
    state = put_in(state.users[user_id].username, new_username)
    broadcast(state, {:users_updated, state.users})
    {:reply, :ok, state}
  end

  @sb_categories ~w(sponsor selfpromo interaction intro outro preview music_offtopic filler)
  def handle_call({:update_sb_settings, category, action}, _from, state)
      when category in @sb_categories and action in ["auto_skip", "show_bar", "disabled"] do
    state = put_in(state.sb_settings[category], action)
    broadcast(state, {:sb_settings_updated, state.sb_settings})
    {:reply, :ok, state}
  end

  @impl true
  def handle_info(:check_empty, state) do
    connected_count = Enum.count(state.users, fn {_, u} -> u.connected end)

    if connected_count == 0 do
      {:stop, :normal, state}
    else
      {:noreply, state}
    end
  end

  def handle_info({:oembed_result, item_id, meta}, state) do
    update_item = fn item ->
      if item.id == item_id do
        %{item | title: meta.title, thumbnail_url: meta.thumbnail_url}
      else
        item
      end
    end

    queue = Enum.map(state.queue, update_item)

    history =
      Enum.map(state.history, fn entry ->
        %{entry | item: update_item.(entry.item)}
      end)

    state = %{state | queue: queue, history: history}
    broadcast(state, {:queue_updated, %{queue: state.queue, current_index: state.current_index}})
    {:noreply, state}
  end

  def handle_info(:reset_rate_limits, state) do
    state = %{state | event_counts: %{}}
    state = schedule_rate_limit_reset(state)
    {:noreply, state}
  end

  def handle_info(:persist, state) do
    persist(state)
    state = schedule_persist(state)
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

  def handle_info({:sponsor_segments_result, video_id, segments, duration}, state) do
    # Only apply if the current video matches
    current_item = if state.current_index, do: Enum.at(state.queue, state.current_index)

    if current_item && current_item.source_id == video_id do
      state = %{state | sponsor_segments: segments}
      broadcast(state, {:sponsor_segments, %{segments: segments, duration: duration, video_id: video_id}})
    end

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
      history: state.history,
      sponsor_segments: state.sponsor_segments,
      sb_settings: state.sb_settings
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
    Phoenix.PubSub.broadcast(Byob.PubSub, "room:#{state.room_id}", message)
  end

  @max_history 99
  defp add_to_history(state, item) do
    entry = %{item: item, played_at: DateTime.utc_now()}
    # Deduplicate: don't add if the last history entry is the same item
    case state.history do
      [%{item: %{id: id}} | _] when id == item.id -> state
      _ -> %{state | history: Enum.take([entry | state.history], @max_history)}
    end
  end

  @max_queue_size 200
  defp add_item_to_queue(state, item, :queue) do
    if length(state.queue) >= @max_queue_size do
      state
    else
      queue = state.queue ++ [item]
      # Auto-play if nothing is currently playing
      if state.current_index == nil do
        now = System.monotonic_time(:millisecond)
        state = %{state | queue: queue, current_index: 0, current_time: 0.0, last_sync_at: now, play_state: :playing, sponsor_segments: []}
        state = add_to_history(state, item)
        state = schedule_sync_correction(state)
        fetch_sponsor_segments(item)
        broadcast(state, {:video_changed, %{media_item: item, index: 0}})
        state
      else
        %{state | queue: queue}
      end
    end
  end

  defp add_item_to_queue(state, item, :now) do
    now = System.monotonic_time(:millisecond)

    case state.current_index do
      nil ->
        state = %{state | queue: [item], current_index: 0, current_time: 0.0, last_sync_at: now, play_state: :playing, sponsor_segments: []}
        state = add_to_history(state, item)
        state = schedule_sync_correction(state)
        fetch_sponsor_segments(item)
        broadcast(state, {:video_changed, %{media_item: item, index: 0}})
        state

      idx ->
        insert_at = idx + 1
        queue = List.insert_at(state.queue, insert_at, item)
        state = %{state | queue: queue, current_index: insert_at, current_time: 0.0, last_sync_at: now, play_state: :playing, sponsor_segments: []}
        state = add_to_history(state, item)
        state = schedule_sync_correction(state)
        fetch_sponsor_segments(item)
        broadcast(state, {:video_changed, %{media_item: item, index: insert_at}})
        state
    end
  end

  defp advance_queue(state) do
    now = System.monotonic_time(:millisecond)
    next_index = (state.current_index || -1) + 1

    if next_index < length(state.queue) do
      item = Enum.at(state.queue, next_index)
      state = %{state | current_index: next_index, current_time: 0.0, last_sync_at: now, play_state: :playing, sponsor_segments: []}
      state = add_to_history(state, item)
      state = schedule_sync_correction(state)
      fetch_sponsor_segments(item)
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

  @impl true
  def terminate(_reason, state) do
    persist(state)
    :ok
  end

  defp persist(state) do
    try do Byob.Persistence.save_room(state.room_id, state) rescue _ -> :ok catch :exit, _ -> :ok end
  end

  defp schedule_persist(state) do
    Process.send_after(self(), :persist, 30_000)
    state
  end

  defp fetch_sponsor_segments(item) do
    if item.source_type == :youtube && item.source_id do
      video_id = item.source_id
      pid = self()

      Task.start(fn ->
        case Byob.SponsorBlock.fetch_segments(video_id) do
          {:ok, segments, duration} -> send(pid, {:sponsor_segments_result, video_id, segments, duration})
          _ -> :ok
        end
      end)
    end
  end
end
