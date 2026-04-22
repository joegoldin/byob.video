defmodule Byob.RoomServer do
  use GenServer

  alias Byob.RoomServer.Round
  alias Byob.SyncLog

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
    rate_limit_ref: nil,
    activity_log: [],
    pending_advance_ref: nil,
    round: nil,
    round_expire_ref: nil,
    round_last_broadcast_ms: 0,
    round_coalesce_ref: nil
  ]

  @autoplay_countdown_ms 5_000

  @max_log_entries 200

  def default_sb_settings, do: @default_sb_settings

  # Client API

  def start_link(opts) do
    room_id = Keyword.fetch!(opts, :room_id)
    name = {:via, Registry, {Byob.RoomRegistry, room_id}}
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def join(pid, user_id, username, opts \\ []) do
    GenServer.call(pid, {:join, user_id, username, opts})
  end

  def leave(pid, user_id) do
    GenServer.call(pid, {:leave, user_id})
  end

  def mark_tab_opened(pid, tab_id, ext_user_id) do
    GenServer.call(pid, {:mark_tab_opened, tab_id, ext_user_id})
  end

  def clear_tab_opened(pid, tab_id) do
    GenServer.call(pid, {:clear_tab_opened, tab_id})
  end

  def mark_tab_ready(pid, tab_id, ext_user_id) do
    GenServer.call(pid, {:mark_tab_ready, tab_id, ext_user_id})
  end

  def clear_ready_tab(pid, tab_id) do
    GenServer.call(pid, {:clear_ready_tab, tab_id})
  end

  def update_current_media(pid, attrs) do
    GenServer.call(pid, {:update_current_media, attrs})
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

  def play_index(pid, index, user_id \\ nil) do
    GenServer.call(pid, {:play_index, index, user_id})
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

  def start_round(pid, mode, user_id) when mode in [:voting, :roulette] do
    GenServer.call(pid, {:start_round, mode, user_id})
  end

  def cast_vote(pid, user_id, external_id, round_id) do
    GenServer.call(pid, {:cast_vote, user_id, external_id, round_id})
  end

  def cancel_round(pid, user_id, round_id) do
    GenServer.call(pid, {:cancel_round, user_id, round_id})
  end

  # Server callbacks

  @impl true
  def init(opts) do
    room_id = Keyword.fetch!(opts, :room_id)
    empty_timeout = Keyword.get(opts, :empty_timeout, :timer.minutes(5))

    loaded =
      try do
        Byob.Persistence.load_room(room_id)
      rescue
        _ -> :not_found
      catch
        :exit, _ -> :not_found
      end

    state =
      case loaded do
        {:ok, saved} ->
          # Advance current_time by wallclock elapsed since persist so the
          # new process picks up roughly where the old one left off — the
          # deploy gap (typically 5–30 s) doesn't get "undone" in the
          # timeline. We keep the persisted play_state: if the room was
          # playing when we persisted, we resume playing from the advanced
          # position.
          now_wall = System.system_time(:second)
          persisted_wall = Map.get(saved, :persisted_wallclock) || now_wall
          elapsed_sec = max(0, now_wall - persisted_wall)

          advanced_time =
            if saved.play_state == :playing do
              (saved.current_time || 0) + elapsed_sec
            else
              saved.current_time || 0
            end

          # Use Map.merge so this also works when `saved` comes from an
          # older version of the struct that's missing newer fields (e.g.
          # `:pending_advance_ref`). Map update syntax would KeyError there.
          Map.merge(%__MODULE__{}, saved)
          |> Map.merge(%{
            empty_timeout: empty_timeout,
            current_time: advanced_time,
            last_sync_at: System.monotonic_time(:millisecond),
            cleanup_ref: nil,
            sync_correction_ref: nil,
            rate_limit_ref: nil,
            last_seek_at: %{},
            event_counts: %{},
            sponsor_segments: [],
            pending_advance_ref: nil,
            round: nil,
            round_expire_ref: nil,
            round_last_broadcast_ms: 0,
            round_coalesce_ref: nil,
            users: Enum.into(saved.users, %{}, fn {k, v} -> {k, %{v | connected: false}} end)
          })

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
    state = if state.play_state == :playing, do: schedule_sync_correction(state), else: state
    Process.send_after(self(), :state_heartbeat, 5_000)
    {:ok, schedule_cleanup(state)}
  end

  @impl true
  def handle_call({:join, user_id, username, opts}, _from, state) do
    is_extension = Keyword.get(opts, :is_extension, false)

    # Clean up disconnected extension users. SW reconnections create new
    # user IDs leaving orphans. Only remove disconnected ones — active
    # connections from other browsers are valid.
    state =
      if is_extension do
        stale_ids =
          state.users
          |> Enum.filter(fn {uid, u} ->
            uid != user_id && Map.get(u, :is_extension, false) && !u.connected
          end)
          |> Enum.map(fn {uid, _} -> uid end)

        if stale_ids != [] do
          stale_set = MapSet.new(stale_ids)
          open = Map.get(state, :open_tabs, %{}) |> Enum.reject(fn {_, o} -> o in stale_set end) |> Map.new()
          ready = Map.get(state, :ready_tabs, %{}) |> Enum.reject(fn {_, o} -> o in stale_set end) |> Map.new()

          state
          |> Map.put(:users, Map.drop(state.users, stale_ids))
          |> Map.put(:open_tabs, open)
          |> Map.put(:ready_tabs, ready)
        else
          state
        end
      else
        state
      end

    state =
      state
      |> cancel_cleanup()
      |> put_in([Access.key(:users), user_id], %{
        username: username,
        joined_at: System.monotonic_time(:millisecond),
        connected: true,
        is_extension: is_extension
      })
      |> maybe_set_host(user_id)

    # Fetch sponsor segments if we have a current YouTube video but no segments
    if state.sponsor_segments == [] && state.current_index do
      current_item = Enum.at(state.queue, state.current_index)
      if current_item, do: fetch_sponsor_segments(current_item)
    end

    state = log_activity(state, :joined, user_id)
    SyncLog.join(state.room_id, user_id, map_size(state.users))
    SyncLog.snapshot(state.room_id, user_id, state.play_state, current_position(state))
    broadcast(state, {:users_updated, state.users})
    broadcast_ready_count(state)
    {:reply, {:ok, snapshot(state)}, state}
  end

  # open_tabs / ready_tabs are maps of %{tab_id => ext_user_id}
  def handle_call({:mark_tab_opened, tab_id, ext_user_id}, _from, state) when is_binary(tab_id) do
    open_tabs = Map.get(state, :open_tabs, %{})
    state = Map.put(state, :open_tabs, Map.put(open_tabs, tab_id, ext_user_id))
    broadcast_ready_count(state)
    {:reply, :ok, state}
  end

  def handle_call({:mark_tab_opened, _, _}, _from, state), do: {:reply, :ok, state}

  def handle_call({:clear_tab_opened, tab_id}, _from, state) when is_binary(tab_id) do
    open_tabs = Map.get(state, :open_tabs, %{})
    state = Map.put(state, :open_tabs, Map.delete(open_tabs, tab_id))
    broadcast_ready_count(state)
    {:reply, :ok, state}
  end

  def handle_call({:clear_tab_opened, _}, _from, state), do: {:reply, :ok, state}

  def handle_call({:mark_tab_ready, tab_id, ext_user_id}, _from, state) when is_binary(tab_id) do
    ready_tabs = Map.get(state, :ready_tabs, %{})
    state = Map.put(state, :ready_tabs, Map.put(ready_tabs, tab_id, ext_user_id))
    broadcast_ready_count(state)
    {:reply, :ok, state}
  end

  def handle_call({:mark_tab_ready, _, _}, _from, state) do
    {:reply, :ok, state}
  end

  def handle_call({:clear_ready_tab, tab_id}, _from, state) when is_binary(tab_id) do
    ready_tabs = Map.get(state, :ready_tabs, %{})
    state = Map.put(state, :ready_tabs, Map.delete(ready_tabs, tab_id))
    broadcast_ready_count(state)
    {:reply, :ok, state}
  end

  def handle_call({:clear_ready_tab, _}, _from, state) do
    {:reply, :ok, state}
  end

  def handle_call({:update_current_media, attrs}, _from, state) do
    case state.current_index do
      nil ->
        {:reply, :ok, state}

      idx ->
        case Enum.at(state.queue, idx) do
          nil ->
            {:reply, :ok, state}

          item ->
            title = attrs[:title] || item.title
            thumbnail_url = attrs[:thumbnail_url] || item.thumbnail_url
            updated = %{item | title: title, thumbnail_url: thumbnail_url}
            queue = List.replace_at(state.queue, idx, updated)

            # Also update the matching history entry
            history =
              Enum.map(state.history, fn entry ->
                if entry.item.id == item.id do
                  %{entry | item: %{entry.item | title: title, thumbnail_url: thumbnail_url}}
                else
                  entry
                end
              end)

            state = %{state | queue: queue, history: history}
            broadcast(state, {:queue_updated, %{queue: queue, current_index: idx}})
            {:reply, :ok, state}
        end
    end
  end

  def handle_call({:leave, user_id}, _from, state) do
    state = log_activity(state, :left, user_id)

    # If this is an extension user leaving, clear only their ready tabs.
    # When the SW dies, it can't send video:unready — this is the fallback.
    is_ext = get_in(state, [Access.key(:users), user_id, Access.key(:is_extension)])

    state =
      if is_ext do
        ready_tabs = Map.get(state, :ready_tabs, %{})
        open_tabs = Map.get(state, :open_tabs, %{})
        cleaned_ready = ready_tabs |> Enum.reject(fn {_, owner} -> owner == user_id end) |> Map.new()
        cleaned_open = open_tabs |> Enum.reject(fn {_, owner} -> owner == user_id end) |> Map.new()
        state |> Map.put(:ready_tabs, cleaned_ready) |> Map.put(:open_tabs, cleaned_open)
      else
        state
      end

    # Mark as disconnected instead of removing
    state =
      case Map.get(state.users, user_id) do
        nil -> state
        user -> put_in(state.users[user_id], %{user | connected: false})
      end

    connected_count = Enum.count(state.users, fn {_, u} -> u.connected end)

    state =
      if connected_count == 0 do
        # Auto-pause when everyone leaves so video doesn't keep "playing"
        # in the background. When someone reconnects, they'll see it paused.
        state =
          if state.play_state == :playing do
            %{state | play_state: :paused, current_time: current_position(state),
              last_sync_at: System.monotonic_time(:millisecond)}
            |> cancel_sync_correction()
          else
            state
          end

        schedule_cleanup(state)
      else
        broadcast(state, {:users_updated, state.users})
        broadcast_ready_count(state)
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
        was_paused = state.play_state != :playing

        # Only accept the client's position when this is a real state
        # transition (paused → playing). A client that's already seeing the
        # video as playing and echoes `video:play` again must NOT be allowed
        # to rewrite `current_time` — otherwise a buggy client stuck at 0
        # can poison the room state for everyone.
        state =
          if was_paused do
            %{state | play_state: :playing, current_time: position, last_sync_at: now}
          else
            state
          end

        state = schedule_sync_correction(state)
        # Only log play if actually transitioning from paused (not seek-resume)
        state =
          if was_paused do
            title = current_media_title(state)
            added_by = current_media_added_by(state)

            if position < 2 && title do
              # Video starting from beginning — log as "now playing" not "user played"
              detail = if added_by, do: "#{title} (added by #{added_by})", else: title
              log_activity(state, :now_playing, nil, detail)
            else
              # Resume from pause — log who resumed
              log_activity(state, :play, user_id, title)
            end
          else
            state
          end

        # Always broadcast so all clients sync, even on redundant plays.
        # State only updates on real transitions (above), but the broadcast
        # ensures clients whose local state disagrees get corrected.
        broadcast(state, {:sync_play, %{time: position, server_time: now, user_id: user_id}})
        if was_paused do
          SyncLog.play(state.room_id, user_id, current_media_url(state), position, "paused→playing")
        end

        {:reply, :ok, state}
    end
  end

  def handle_call({:pause, user_id, position}, _from, state) do
    case check_rate_limit(state, user_id) do
      {:error, state} ->
        {:reply, {:error, :rate_limited}, state}

      {:ok, state} ->
        now = System.monotonic_time(:millisecond)
        was_playing = state.play_state == :playing

        # Only accept the position on a real playing → paused transition,
        # for the same poisoning-resistance reason as :play above.
        state =
          if was_playing do
            %{state | play_state: :paused, current_time: position, last_sync_at: now}
          else
            state
          end

        state = cancel_sync_correction(state)
        # Only log pause if actually transitioning from playing
        state =
          if was_playing do
            log_activity(state, :pause, user_id, current_media_title(state))
          else
            state
          end

        broadcast(state, {:sync_pause, %{time: position, server_time: now, user_id: user_id}})
        if was_playing do
          SyncLog.pause(state.room_id, user_id, current_media_url(state), position, "playing→paused")
        end

        {:reply, :ok, state}
    end
  end

  def handle_call({:seek, user_id, position}, _from, state) do
    now = System.monotonic_time(:millisecond)
    last = Map.get(state.last_seek_at, user_id)

    if last != nil and now - last < 500 do
      {:reply, {:error, :debounced}, state}
    else
      old_pos = current_position(state)

      state = %{
        state
        | current_time: position,
          last_sync_at: now,
          last_seek_at: Map.put(state.last_seek_at, user_id, now)
      }

      # Only log meaningful seeks (>3s jump, not from 0:00)
      diff = abs(position - old_pos)

      state =
        if diff > 3 and old_pos > 1 do
          log_activity(
            state,
            :seeked,
            user_id,
            "#{format_seconds(old_pos)} → #{format_seconds(position)}"
          )
        else
          state
        end

      SyncLog.seek(state.room_id, user_id, current_media_url(state), position)
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

        item = %{
          item
          | added_by: user_id,
            added_by_name: added_by_name,
            added_at: DateTime.utc_now()
        }

        state = add_item_to_queue(state, item, mode)
        state = log_activity(state, :added, user_id, url)

        broadcast(
          state,
          {:queue_updated, %{queue: state.queue, current_index: state.current_index}}
        )

        # Fetch metadata async
        item_id = item.id
        pid = self()

        Task.start(fn ->
          result =
            case item.source_type do
              :youtube -> fetch_youtube_meta(item.source_id, url)
              :vimeo -> Byob.OEmbed.fetch_vimeo(url)
              _ -> Byob.OEmbed.fetch_opengraph(url)
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

  # First client to report video_ended for the current index wins.
  # Logs :finished, kicks off a 5 s autoplay countdown, and schedules the
  # actual advance. Subsequent :video_ended events for the same index are
  # silently ignored because pending_advance_ref is already set.
  def handle_call(
        {:video_ended, index},
        _from,
        %{current_index: index, pending_advance_ref: nil} = state
      ) do
    state =
      case Enum.at(state.queue, index) do
        %{} = finished ->
          title = finished.title || finished.url
          log_activity(state, :finished, nil, title)

        _ ->
          state
      end

    now = System.monotonic_time(:millisecond)
    ref = Process.send_after(self(), :advance_pending, @autoplay_countdown_ms)
    state = %{state | pending_advance_ref: ref, play_state: :paused}

    broadcast(
      state,
      {:autoplay_countdown, %{duration_ms: @autoplay_countdown_ms, server_time: now}}
    )

    {:reply, :ok, state}
  end

  def handle_call({:video_ended, _stale_index}, _from, state) do
    {:reply, :stale, state}
  end

  def handle_call(:skip, _from, state) do
    state = cancel_pending_advance(state)
    state = log_activity(state, :skipped)
    broadcast(state, {:autoplay_countdown_cancelled, %{}})
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

      broadcast(
        state,
        {:queue_updated, %{queue: state.queue, current_index: state.current_index}}
      )

      {:reply, :ok, state}
    else
      {:reply, :ok, state}
    end
  end

  def handle_call({:play_index, index, user_id}, _from, state)
      when index >= 0 and index < length(state.queue) do
    # Jumping to a queue item during an autoplay countdown cancels the countdown.
    state = maybe_cancel_pending_advance(state)

    now = System.monotonic_time(:millisecond)
    item = Enum.at(state.queue, index)

    # Remove old now-playing, pull clicked item to front, keep rest in order
    queue = state.queue

    queue =
      if state.current_index != nil, do: List.delete_at(queue, state.current_index), else: queue

    # Adjust index after removal
    adj_index =
      if state.current_index != nil and state.current_index < index, do: index - 1, else: index

    # Remove the clicked item from its current position and put it at front
    queue = List.delete_at(queue, adj_index)
    queue = [item | queue]

    state = %{
      state
      | queue: queue,
        current_index: 0,
        current_time: 0.0,
        last_sync_at: now,
        play_state: :playing,
        sponsor_segments: []
    }

    state = add_to_history(state, item)
    state = schedule_sync_correction(state)
    fetch_sponsor_segments(item)
    state = fetch_comments_for_current(state)

    # Log a "jumped to" event so the activity log reflects the manual queue click
    title = item.title || item.url
    state = log_activity(state, :played, user_id, title)

    broadcast(state, {:video_changed, %{media_item: item, index: 0}})
    broadcast(state, {:queue_updated, %{queue: queue, current_index: 0}})
    {:reply, :ok, state}
  end

  def handle_call({:play_index, _index, _user_id}, _from, state) do
    {:reply, {:error, :invalid_index}, state}
  end

  def handle_call({:reorder_queue, from, to}, _from, state)
      when from >= 0 and from < length(state.queue) and to >= 0 and to < length(state.queue) and
             from != to do
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
    old_name = get_in(state, [Access.key(:users), user_id, Access.key(:username)])
    state = put_in(state.users[user_id].username, new_username)
    state = log_activity(state, :renamed, user_id, "#{old_name} → #{new_username}")
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

  # --- Rounds (roulette / voting) ---

  def handle_call({:start_round, _mode, _user_id}, _from, %{round: %Round{}} = state) do
    {:reply, {:error, :round_active}, state}
  end

  def handle_call({:start_round, mode, user_id}, _from, state) do
    queue_ids =
      state.queue
      |> Enum.map(fn item ->
        case item do
          %{source_type: :youtube, source_id: id} when is_binary(id) -> id
          _ -> nil
        end
      end)
      |> Enum.reject(&is_nil/1)

    total_target =
      case mode do
        :voting -> 5
        :roulette -> 12
      end

    case Byob.Pool.pick_candidates(queue_ids, total_target) do
      {:ok, candidates} ->
        candidate_maps =
          Enum.map(candidates, fn row ->
            %{
              external_id: row.external_id,
              title: row.title,
              channel: row.channel,
              duration_s: row.duration_s,
              thumbnail_url: row.thumbnail_url,
              source_type: row.source_bucket || row.source_type
            }
          end)

        round = Round.new(mode, user_id, candidate_maps)

        duration =
          case mode do
            :voting -> Round.vote_duration_ms()
            :roulette -> Round.roulette_duration_ms()
          end

        expire_ref = Process.send_after(self(), {:round_expire, round.id}, duration)

        state = %{state | round: round, round_expire_ref: expire_ref, round_last_broadcast_ms: 0}

        state =
          log_activity(
            state,
            if(mode == :voting, do: :vote_started, else: :roulette_started),
            user_id,
            nil
          )

        broadcast(state, {:round_started, snapshot_round(round)})
        {:reply, {:ok, round}, state}

      {:error, :no_candidates} ->
        {:reply, {:error, :no_candidates}, state}
    end
  end

  def handle_call({:cast_vote, user_id, external_id, round_id}, _from, state) do
    case state.round do
      %Round{id: ^round_id, mode: :voting, phase: :active} = round ->
        updated = Round.cast_vote(round, user_id, external_id)
        state = %{state | round: updated}

        # Early-close if all present (connected, non-extension) users have voted
        connected_user_ids =
          state.users
          |> Enum.filter(fn {_, u} -> u.connected and not Map.get(u, :is_extension, false) end)
          |> Enum.map(fn {id, _} -> id end)
          |> MapSet.new()

        voted_user_ids =
          updated.votes
          |> Map.values()
          |> Enum.reduce(MapSet.new(), &MapSet.union/2)

        if MapSet.size(connected_user_ids) > 0 and
             MapSet.subset?(connected_user_ids, voted_user_ids) do
          state = cancel_round_expire(state)
          state = resolve_round_now(state)
          {:reply, :ok, state}
        else
          # Broadcast immediately so all clients see the vote in real-time
          broadcast(state, {:round_updated, snapshot_round(updated)})
          state = %{state | round_last_broadcast_ms: System.monotonic_time(:millisecond)}
          {:reply, :ok, state}
        end

      _ ->
        {:reply, {:error, :invalid_round}, state}
    end
  end

  def handle_call({:cancel_round, user_id, round_id}, _from, state) do
    case state.round do
      %Round{id: ^round_id, started_by: ^user_id, phase: :active} ->
        state = cancel_round_expire(state)
        state = flush_round_coalesce(state)
        state = log_activity(state, :round_cancelled, user_id, "cancelled")
        broadcast(state, {:round_cancelled, %{reason: :cancelled_by_starter}})
        state = %{state | round: nil}
        {:reply, :ok, state}

      _ ->
        {:reply, {:error, :not_authorized}, state}
    end
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
        %{
          item
          | title: meta[:title] || item.title,
            thumbnail_url: meta[:thumbnail_url] || item.thumbnail_url,
            duration: meta[:duration] || item.duration,
            published_at: meta[:published_at] || item.published_at
        }
      else
        item
      end
    end

    queue = Enum.map(state.queue, update_item)

    history =
      Enum.map(state.history, fn entry ->
        %{entry | item: update_item.(entry.item)}
      end)

    # Update activity log: replace raw URLs with titles for this item
    old_item = Enum.find(state.queue, &(&1.id == item_id))
    old_url = if old_item, do: old_item.url

    activity_log =
      if old_url && meta[:title] do
        Enum.map(state.activity_log, fn entry ->
          if entry.action == :added && entry.detail == old_url do
            %{entry | detail: meta[:title]}
          else
            entry
          end
        end)
      else
        state.activity_log
      end

    state = %{state | queue: queue, history: history, activity_log: activity_log}
    broadcast(state, {:queue_updated, %{queue: state.queue, current_index: state.current_index}})
    if old_url && meta[:title], do: broadcast(state, {:activity_log_updated, activity_log})
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

  def handle_info(:advance_pending, state) do
    state = %{state | pending_advance_ref: nil}
    state = advance_queue(state)
    {:noreply, state}
  end

  # --- round timers ---

  def handle_info({:round_expire, round_id}, %{round: %Round{id: round_id, phase: :active}} = state) do
    state = %{state | round_expire_ref: nil}
    state = flush_round_coalesce(state)
    state = resolve_round_now(state)
    {:noreply, state}
  end

  def handle_info({:round_expire, _stale_id}, state) do
    {:noreply, state}
  end

  def handle_info({:round_finalize, round_id}, %{round: %Round{id: round_id} = round} = state) do
    state = finalize_round(state, round)
    {:noreply, state}
  end

  def handle_info({:round_finalize, _stale_id}, state) do
    {:noreply, state}
  end

  def handle_info(:round_broadcast_flush, state) do
    state = %{state | round_coalesce_ref: nil}

    case state.round do
      %Round{} = r ->
        state = %{state | round_last_broadcast_ms: System.monotonic_time(:millisecond)}
        broadcast(state, {:round_updated, snapshot_round(r)})
        {:noreply, state}

      _ ->
        {:noreply, state}
    end
  end

  # Periodic state heartbeat: re-broadcasts play_state + current_time so
  # clients that missed an earlier broadcast (reconnect, transient drop) can
  # reconcile without waiting for the next natural state change.
  def handle_info(:state_heartbeat, state) do
    now = System.monotonic_time(:millisecond)
    position = current_position(state)
    SyncLog.heartbeat(state.room_id, state.play_state, position)

    broadcast(
      state,
      {:state_heartbeat,
       %{
         play_state: state.play_state,
         current_time: position,
         server_time: now
       }}
    )

    Process.send_after(self(), :state_heartbeat, 5_000)
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

      broadcast(
        state,
        {:sponsor_segments, %{segments: segments, duration: duration, video_id: video_id}}
      )
    end

    {:noreply, state}
  end

  def handle_info({:comments_result, video_id, result}, state) do
    current_item = if state.current_index, do: Enum.at(state.queue, state.current_index)

    if current_item && current_item.source_id == video_id do
      broadcast(
        state,
        {:comments_updated,
         %{
           video_id: video_id,
           comments: result.comments,
           next_page_token: result.next_page_token,
           total_count: result.total_count
         }}
      )
    end

    {:noreply, state}
  end

  # Private helpers

  defp current_position(%{play_state: :playing} = state) do
    elapsed = (System.monotonic_time(:millisecond) - state.last_sync_at) / 1000
    state.current_time + elapsed
  end

  defp current_position(state), do: state.current_time

  # Fetch YouTube metadata. Prefer the Data API (duration + published_at);
  # fall back to oEmbed (title + thumbnail only) if the API isn't configured
  # or quota is out.
  defp fetch_youtube_meta(source_id, url) do
    case source_id && Byob.YouTube.Videos.fetch(source_id) do
      {:ok, meta} ->
        {:ok, meta}

      _ ->
        case Byob.OEmbed.fetch_youtube(url) do
          {:ok, meta} -> {:ok, Map.put(meta, :source_type, :youtube)}
          err -> err
        end
    end
  end

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
      sb_settings: state.sb_settings,
      activity_log: Enum.take(state.activity_log, 50),
      round: if(state.round, do: snapshot_round(state.round), else: nil)
    }
  end

  defp schedule_cleanup(state) do
    ref = Process.send_after(self(), :check_empty, state.empty_timeout)
    %{state | cleanup_ref: ref}
  end

  defp cancel_pending_advance(%{pending_advance_ref: nil} = state), do: state

  defp cancel_pending_advance(%{pending_advance_ref: ref} = state) do
    Process.cancel_timer(ref)
    %{state | pending_advance_ref: nil}
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

  defp broadcast_ready_count(state) do
    # Group connected users by username to deduplicate (extension + LiveView = same person).
    # A person is "ready" unless they have an extension connection that isn't ready yet.
    connected = state.users |> Enum.filter(fn {_, u} -> u.connected end)

    has_extension_users =
      Enum.any?(connected, fn {_, u} -> Map.get(u, :is_extension, false) end)

    open_tabs = Map.get(state, :open_tabs, %{})
    ready_tabs = Map.get(state, :ready_tabs, %{})

    # Only broadcast when tabs exist — otherwise the count is meaningless
    if has_extension_users or map_size(open_tabs) > 0 do
      non_ext = connected |> Enum.reject(fn {_, u} -> Map.get(u, :is_extension, false) end)
      non_ext_usernames = non_ext |> Enum.map(fn {_, u} -> u.username end) |> Enum.uniq()
      total = length(non_ext_usernames)

      has_tab = min(map_size(open_tabs), total)
      ready = min(map_size(ready_tabs), total)

      broadcast(state, {:ready_count, %{ready: ready, has_tab: has_tab, total: total}})
    end
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

        # Nothing was playing, but the autoplay-advance timer may still be
        # armed (e.g. race where queue_ended hadn't finalized). Defensive.
        state = maybe_cancel_pending_advance(state)

        state = %{
          state
          | queue: queue,
            current_index: 0,
            current_time: 0.0,
            last_sync_at: now,
            play_state: :playing,
            sponsor_segments: []
        }

        state = add_to_history(state, item)
        added_by = item.added_by_name
        title = item.title || item.url
        detail = if added_by, do: "#{title} (added by #{added_by})", else: title
        state = log_activity(state, :now_playing, nil, detail)
        state = schedule_sync_correction(state)
        fetch_sponsor_segments(item)
        state = fetch_comments_for_current(state)
        broadcast(state, {:video_changed, %{media_item: item, index: 0}})
        state
      else
        %{state | queue: queue}
      end
    end
  end

  defp add_item_to_queue(state, item, :now) do
    now = System.monotonic_time(:millisecond)

    # Replacing the now-playing video by hand. If the autoplay countdown
    # was running for the previously-finished video, cancel it — otherwise
    # it fires a few seconds later and advances OUT of the video we just
    # queued, dropping the user on the "queue finished" screen (with the
    # just-added video's metadata, no less).
    state = maybe_cancel_pending_advance(state)

    case state.current_index do
      nil ->
        state = %{
          state
          | queue: [item],
            current_index: 0,
            current_time: 0.0,
            last_sync_at: now,
            play_state: :playing,
            sponsor_segments: []
        }

        state = add_to_history(state, item)
        state = schedule_sync_correction(state)
        fetch_sponsor_segments(item)
        state = fetch_comments_for_current(state)
        broadcast(state, {:video_changed, %{media_item: item, index: 0}})
        state

      idx ->
        # Remove old now-playing, put new item at front
        queue = List.delete_at(state.queue, idx)
        queue = [item | queue]

        state = %{
          state
          | queue: queue,
            current_index: 0,
            current_time: 0.0,
            last_sync_at: now,
            play_state: :playing,
            sponsor_segments: []
        }

        state = add_to_history(state, item)
        state = schedule_sync_correction(state)
        fetch_sponsor_segments(item)
        state = fetch_comments_for_current(state)
        broadcast(state, {:video_changed, %{media_item: item, index: 0}})
        state
    end
  end

  # Cancel the autoplay-advance timer (if any) and broadcast the
  # cancellation so clients hide their pie countdowns immediately.
  defp maybe_cancel_pending_advance(%{pending_advance_ref: nil} = state), do: state

  defp maybe_cancel_pending_advance(%{pending_advance_ref: _} = state) do
    state = cancel_pending_advance(state)
    broadcast(state, {:autoplay_countdown_cancelled, %{}})
    state
  end

  defp advance_queue(state) do
    now = System.monotonic_time(:millisecond)
    current_idx = state.current_index || -1

    # Remove the just-played item from the queue
    queue = if current_idx >= 0, do: List.delete_at(state.queue, current_idx), else: state.queue

    if length(queue) > 0 do
      # Next item is now at index 0 (since we removed the played one)
      item = Enum.at(queue, 0)

      state = %{
        state
        | queue: queue,
          current_index: 0,
          current_time: 0.0,
          last_sync_at: now,
          play_state: :playing,
          sponsor_segments: []
      }

      state = add_to_history(state, item)

      # Log the auto-advance so the activity feed reflects the transition
      added_by = item.added_by_name
      title = item.title || item.url
      detail = if added_by, do: "#{title} (added by #{added_by})", else: title
      state = log_activity(state, :now_playing, nil, detail)

      state = schedule_sync_correction(state)
      fetch_sponsor_segments(item)
      state = fetch_comments_for_current(state)
      broadcast(state, {:video_changed, %{media_item: item, index: 0}})
      broadcast(state, {:queue_updated, %{queue: queue, current_index: 0}})
      state
    else
      state = %{
        state
        | queue: queue,
          play_state: :ended,
          current_time: 0.0,
          last_sync_at: now,
          current_index: nil
      }

      state = cancel_sync_correction(state)
      broadcast(state, {:queue_ended, %{}})
      broadcast(state, {:queue_updated, %{queue: queue, current_index: nil}})
      state
    end
  end

  defp format_seconds(s) when is_number(s) do
    mins = trunc(s / 60)
    secs = trunc(rem(trunc(s), 60))
    "#{mins}:#{String.pad_leading(Integer.to_string(secs), 2, "0")}"
  end

  defp format_seconds(_), do: "0:00"

  defp current_media_added_by(state) do
    case state.current_index do
      nil ->
        nil

      idx ->
        item = Enum.at(state.queue, idx)
        if item, do: item.added_by_name, else: nil
    end
  end

  defp current_media_url(state) do
    case state.current_index do
      nil -> nil
      idx ->
        item = Enum.at(state.queue, idx)
        if item, do: item.url, else: nil
    end
  end

  defp current_media_title(state) do
    case state.current_index do
      nil ->
        nil

      idx ->
        item = Enum.at(state.queue, idx)
        if item, do: item.title || item.url, else: nil
    end
  end

  defp log_activity(state, action, user_id \\ nil, detail \\ nil) do
    username =
      if user_id,
        do: get_in(state, [Access.key(:users), user_id, Access.key(:username)]),
        else: nil

    user_label = username || user_id

    # Deduplicate: skip if the last entry is the same user+action within 2 seconds
    case state.activity_log do
      [%{action: ^action, user: ^user_label} = prev | _] ->
        if DateTime.diff(DateTime.utc_now(), prev.at, :second) < 2 do
          state
        else
          do_log_activity(state, action, user_label, detail)
        end

      _ ->
        do_log_activity(state, action, user_label, detail)
    end
  end

  defp do_log_activity(state, action, user_label, detail) do
    entry = %{
      action: action,
      user: user_label,
      detail: detail,
      at: DateTime.utc_now()
    }

    log = Enum.take([entry | state.activity_log], @max_log_entries)
    state = %{state | activity_log: log}
    broadcast(state, {:activity_log_entry, entry})
    state
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
    # Snapshot the computed current position and a wallclock timestamp so a
    # fresh process on restart can advance the position by elapsed wallclock.
    # We store these alongside the struct via ephemeral fields — they're only
    # used at load time.
    snapshot_state = %{
      state
      | current_time: current_position(state),
        last_sync_at: System.monotonic_time(:millisecond)
    }

    snapshot_state = Map.put(snapshot_state, :persisted_wallclock, System.system_time(:second))

    try do
      Byob.Persistence.save_room(state.room_id, snapshot_state)
    rescue
      _ -> :ok
    catch
      :exit, _ -> :ok
    end
  end

  defp schedule_persist(state) do
    Process.send_after(self(), :persist, 5_000)
    state
  end

  defp fetch_sponsor_segments(item) do
    if item.source_type == :youtube && item.source_id do
      video_id = item.source_id
      pid = self()

      Task.start(fn ->
        case Byob.SponsorBlock.fetch_segments(video_id) do
          {:ok, segments, duration} ->
            send(pid, {:sponsor_segments_result, video_id, segments, duration})

          _ ->
            :ok
        end
      end)
    end
  end

  # --- round helpers ---

  defp cancel_round_expire(%{round_expire_ref: nil} = state), do: state

  defp cancel_round_expire(%{round_expire_ref: ref} = state) do
    Process.cancel_timer(ref)
    %{state | round_expire_ref: nil}
  end

  defp flush_round_coalesce(%{round_coalesce_ref: nil} = state), do: state

  defp flush_round_coalesce(%{round_coalesce_ref: ref} = state) do
    Process.cancel_timer(ref)
    %{state | round_coalesce_ref: nil}
  end

  # (schedule_round_broadcast removed — votes broadcast immediately)

  # Resolve (pick winner), broadcast :round_revealed, schedule finalize.
  defp resolve_round_now(state) do
    {resolved, outcome} = Round.resolve(state.round)

    case {resolved.mode, outcome} do
      {:voting, :no_votes} ->
        state = log_activity(state, :round_cancelled, nil, "no votes cast")
        broadcast(state, {:round_cancelled, %{reason: :no_votes}})
        %{state | round: nil}

      {mode, :winner_chosen} ->
        payload =
          case mode do
            :voting ->
              %{
                mode: :voting,
                winner_external_id: resolved.winner_external_id,
                tallies: Round.tallies(resolved)
              }

            :roulette ->
              %{
                mode: :roulette,
                seed: resolved.seed,
                winner_external_id: resolved.winner_external_id
              }
          end

        delay =
          case mode do
            :voting -> Round.reveal_delay_voting_ms()
            :roulette -> Round.reveal_delay_roulette_ms()
          end

        finalize_ref = Process.send_after(self(), {:round_finalize, resolved.id}, delay)
        resolved = %{resolved | finalize_ref: finalize_ref}
        broadcast(state, {:round_revealed, payload})
        %{state | round: resolved}
    end
  end

  # Finalize: enqueue winner, mark in pool, activity log, broadcast.
  defp finalize_round(state, %Round{winner_external_id: nil}) do
    %{state | round: nil}
  end

  defp finalize_round(state, %Round{winner_external_id: winner_id} = round) do
    candidate = Round.candidate_by_id(round, winner_id)

    state =
      case candidate do
        %{} = c -> append_pool_winner(state, c, round)
        _ -> state
      end

    Byob.Pool.mark_picked(winner_id)
    broadcast(state, {:round_finalized, %{}})
    %{state | round: nil}
  end

  defp append_pool_winner(state, candidate, round) do
    url = "https://www.youtube.com/watch?v=#{candidate.external_id}"

    item = %Byob.MediaItem{
      id: Base.url_encode64(:crypto.strong_rand_bytes(9), padding: false),
      url: url,
      source_type: :youtube,
      source_id: candidate.external_id,
      title: candidate.title,
      thumbnail_url: candidate.thumbnail_url,
      duration: candidate.duration_s,
      added_by: round.started_by,
      added_by_name: starter_name(state, round.started_by),
      added_at: DateTime.utc_now()
    }

    state = add_item_to_queue(state, item, :queue)

    title = candidate.title || url

    state =
      case round.mode do
        :voting ->
          count =
            round.votes
            |> Map.get(winner_of(round), MapSet.new())
            |> MapSet.size()

          detail = "#{title} (#{count} vote#{if count == 1, do: "", else: "s"})"
          log_activity(state, :vote_winner, nil, detail)

        :roulette ->
          log_activity(state, :roulette_winner, nil, title)
      end

    broadcast(
      state,
      {:queue_updated, %{queue: state.queue, current_index: state.current_index}}
    )

    state
  end

  defp winner_of(%Round{winner_external_id: id}), do: id

  defp starter_name(state, user_id) do
    case Map.get(state.users, user_id) do
      %{username: name} -> name
      _ -> nil
    end
  end

  # Public-facing serialization for broadcasts. Strips MapSets (which don't
  # survive Phoenix.PubSub → LiveView assigns gracefully) and exposes only
  # what the client needs.
  defp snapshot_round(%Round{} = r) do
    %{
      id: r.id,
      mode: r.mode,
      started_by: r.started_by,
      started_at: r.started_at,
      expires_at: r.expires_at,
      server_time: System.monotonic_time(:millisecond),
      candidates: r.candidates,
      tallies: if(r.mode == :voting, do: Round.tallies(r), else: %{}),
      voter_ids_by_candidate:
        if(r.mode == :voting,
          do: Enum.into(r.votes, %{}, fn {ext, set} -> {ext, MapSet.to_list(set)} end),
          else: %{}
        ),
      phase: r.phase,
      seed: r.seed,
      winner_external_id: r.winner_external_id
    }
  end

  defp fetch_comments_for_current(state) do
    current = Enum.at(state.queue, state.current_index)

    if current && current.source_type == :youtube && current.source_id do
      video_id = current.source_id
      pid = self()

      Task.start(fn ->
        case Byob.YouTube.Comments.fetch(video_id) do
          {:ok, result} -> send(pid, {:comments_result, video_id, result})
          _ -> :ok
        end
      end)
    end

    state
  end
end
