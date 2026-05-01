defmodule Byob.RoomServer do
  use GenServer

  alias Byob.Events
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
    pending_leaves: %{},
    round: nil,
    round_expire_ref: nil,
    round_last_broadcast_ms: 0,
    round_coalesce_ref: nil,
    # Per-peer drift samples for room-wide clock adjustment.
    # %{user_id => %{drift_ms, updated_at_monotonic_ms}}
    drift_samples: %{},
    clock_adjust_ref: nil,
    # Server-authoritative seek decisions (was per-LV in assigns; moved
    # here because Phoenix can have multiple LV processes per user during
    # transport switches, each with its own streak counter racing the
    # other and stomping each other's seeks).
    # %{user_id => Byob.SyncDecision.t()}
    user_sync_states: %{}
  ]

  @autoplay_countdown_ms 5_000

  @max_log_entries 200

  # Timing constants
  @state_heartbeat_interval_ms 5_000
  @sync_correction_interval_ms 1_000
  @persist_interval_ms 5_000
  @rate_limit_reset_interval_ms 5_000
  @sync_broadcast_debounce_ms 500

  # Room-wide clock adjustment: minimize all peers' |drift| toward 0 by
  # shifting the canonical reference. Strategy depends on sign uniformity:
  #
  # All peers behind (drift < 0):
  #   Shift by `Enum.max(drifts)` — the LEAST-negative drift. Moves the
  #   closest-to-0 peer all the way to 0; everyone else moves the same
  #   amount toward 0 (none become worse). Full shift (no damping) is
  #   safe here.
  #
  # All peers ahead (drift > 0):
  #   Shift by `Enum.min(drifts)` — symmetric.
  #
  # Mixed signs:
  #   Shift by median (robust to outliers). Damped 0.5 because some peers
  #   *will* end up further from 0 (the ones on the opposite side of
  #   median); half-step keeps that disruption bounded.
  #
  # Capped at 1000 ms per pass and run every 5 s, so even pathological
  # corrections converge in a handful of seconds without yanking the
  # canonical reference dramatically in any single broadcast.
  @clock_adjust_interval_ms 5_000
  @clock_adjust_min_drift_ms 50
  @clock_adjust_mixed_damping 0.5
  @clock_adjust_max_per_pass_ms 1_000
  @drift_sample_stale_ms 5_000
  # Defer the side effects of a leave (broadcast "left" toast, pause room
  # if ≤1 user, mark user disconnected) by this much. Network blips that
  # resolve within the window leave no trace; only real disconnects fire.
  # Real-world WAN reconnects (5G handoffs, VPN flip, browser tab reload)
  # commonly take 2-4 seconds — 1.5s was triggering false "X left" toasts
  # whenever a friend's tab so much as breathed funny.
  @leave_grace_ms 5_000

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

  def update_live_status(pid, is_live) do
    GenServer.call(pid, {:update_live_status, is_live})
  end

  def update_current_url(pid, user_id, url) do
    GenServer.call(pid, {:update_current_url, user_id, url})
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

          raw_time =
            if saved.play_state == :playing do
              (saved.current_time || 0) + elapsed_sec
            else
              saved.current_time || 0
            end

          # Clamp to current media item's duration so a restart-gap or a
          # stale persisted "playing" state can't land us past the end of
          # the video (which would trigger newcomers to hard-seek everyone
          # to the end via reconcile).
          advanced_time =
            case current_item_duration(saved) do
              nil -> raw_time
              d -> min(raw_time, d)
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
            pending_leaves: %{},
            round: nil,
            round_expire_ref: nil,
            round_last_broadcast_ms: 0,
            round_coalesce_ref: nil,
            # Runtime-only state: clear on restart. last_seek_at /
            # updated_at inside these structs use System.monotonic_time
            # which resets across process restarts, so stale values from
            # the previous runtime become huge negative deltas (the
            # 700-second cooldown bug). learned_l_ms is also cleared
            # on restart — the client will re-measure it on its next
            # sync seek anyway.
            user_sync_states: %{},
            drift_samples: %{},
            clock_adjust_ref: nil,
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
    Process.send_after(self(), :state_heartbeat, @state_heartbeat_interval_ms)

    # Subscribe to our own room's PubSub so we can observe peers' drift
    # samples (broadcast as `:sync_client_stats` by LVs and Channels)
    # and adjust the canonical clock toward the room's mean drift.
    Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{state.room_id}")

    clock_adjust_ref =
      Process.send_after(self(), :adjust_room_clock, @clock_adjust_interval_ms)

    state = %{state | clock_adjust_ref: clock_adjust_ref}
    {:ok, schedule_cleanup(state)}
  end

  @impl true
  def handle_call({:join, user_id, username, opts}, _from, state) do
    is_extension = Keyword.get(opts, :is_extension, false)
    silent = Keyword.get(opts, :silent, false)

    # Cancel a pending leave for the same user_id (LV reconnect — same id
    # across the brief socket drop). This kills the deferred "left" toast
    # and the ≤1-user pause logic before they fire.
    state = cancel_pending_leave_timer(state, user_id)

    was_present = username_connected?(state, username)

    # Clean up stale disconnected users — reconnections create new user IDs
    # (extension) or re-use existing ones (LiveView). Remove disconnected
    # entries that would show as gray in the user list.
    stale_ids =
      state.users
      |> Enum.filter(fn {uid, u} ->
        uid != user_id && !u.connected &&
          Map.get(u, :is_extension, false) == is_extension &&
          u.username == username
      end)
      |> Enum.map(fn {uid, _} -> uid end)

    state =
      if length(stale_ids) > 0 do
        ready_tabs = Map.get(state, :ready_tabs, %{})
        open_tabs = Map.get(state, :open_tabs, %{})

        cleaned_ready =
          ready_tabs |> Enum.reject(fn {_, owner} -> owner in stale_ids end) |> Map.new()

        cleaned_open =
          open_tabs |> Enum.reject(fn {_, owner} -> owner in stale_ids end) |> Map.new()

        %{state | users: Map.drop(state.users, stale_ids)}
        |> Map.put(:ready_tabs, cleaned_ready)
        |> Map.put(:open_tabs, cleaned_open)
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

    # Skip activity logs + presence toasts on silent re-joins (e.g. the
    # LV ensure_room_pid hook re-marking the user as connected after a
    # brief socket drop) AND on reconnects within the leave-grace window
    # (where the username was still present from the deferred-leave POV).
    # Both cases shouldn't look like fresh joins.
    state =
      if silent or was_present do
        state
      else
        log_activity(state, :joined, user_id)
      end

    unless silent do
      SyncLog.join(state.room_id, user_id, map_size(state.users))
      SyncLog.snapshot(state.room_id, user_id, state.play_state, current_position(state))
    end

    broadcast(state, {:users_updated, state.users})
    broadcast_ready_count(state)

    # Only toast when a username transitions from "not present" to "present".
    # Re-connects (same user on a different device / after brief drop) stay quiet.
    if not silent and not was_present do
      broadcast(state, {:room_presence, %{event: Events.presence_joined(), username: username}})
    end

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
    ready_tabs = Map.get(state, :ready_tabs, %{})

    # Owner of the tab that's being cleared. Used below to decide if
    # this was the user's LAST player tab (→ emit ext_closed toast).
    closing_owner = Map.get(open_tabs, tab_id)

    # Also clear the ready_tabs entry for this tab. Normally `video:unready`
    # arrives alongside `video:tab_closed`, but if it gets dropped (SW
    # tearing down, port dying before the second push lands), a stale
    # ready entry sticks around and the tooltip never transitions back to
    # "needs to open player window" for that user.
    new_open_tabs = Map.delete(open_tabs, tab_id)
    new_ready_tabs = Map.delete(ready_tabs, tab_id)

    state =
      state
      |> Map.put(:open_tabs, new_open_tabs)
      |> Map.put(:ready_tabs, new_ready_tabs)

    # If this was the user's last player tab (they may still have other
    # non-player extension tabs open, or a LiveView session, but they no
    # longer have any extension player window for this room), broadcast
    # ext_closed so other users see "X closed their player window" in
    # their sync bar + webapp toast. `video:all_closed` in the extension
    # only fires when ALL ports close — a user with the byob webapp open
    # alongside the player would otherwise never trigger a presence
    # update on close.
    if closing_owner && user_has_no_open_tabs?(new_open_tabs, closing_owner) do
      username = get_in(state, [Access.key(:users), closing_owner, Access.key(:username)])

      if username do
        broadcast(state, {:room_presence, %{event: Events.presence_ext_closed(), username: username}})
      end
    end

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

  def handle_call({:update_live_status, is_live}, _from, state) do
    is_live = !!is_live

    case state.current_index do
      nil ->
        {:reply, :ok, state}

      idx ->
        case Enum.at(state.queue, idx) do
          nil ->
            {:reply, :ok, state}

          item ->
            current = Map.get(item, :is_live, false)

            if current == is_live do
              {:reply, :ok, state}
            else
              updated = %{item | is_live: is_live}
              queue = List.replace_at(state.queue, idx, updated)

              history =
                Enum.map(state.history, fn entry ->
                  if entry.item.id == item.id do
                    %{entry | item: %{entry.item | is_live: is_live}}
                  else
                    entry
                  end
                end)

              state = %{state | queue: queue, history: history}
              broadcast(state, {:live_status, %{is_live: is_live, item_id: item.id}})
              broadcast(state, {:queue_updated, %{queue: queue, current_index: idx}})
              {:reply, :ok, state}
            end
        end
    end
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

            # Rewrite activity-log entries that recorded the URL (because the
            # title hadn't been scraped yet) so the feed displays the title.
            old_url = item.url

            activity_log =
              if title && title != "" && old_url do
                Enum.map(state.activity_log, fn entry ->
                  if entry.action in [:added, :played] && entry.detail == old_url do
                    %{entry | detail: title}
                  else
                    entry
                  end
                end)
              else
                state.activity_log
              end

            log_changed = activity_log != state.activity_log
            state = %{state | queue: queue, history: history, activity_log: activity_log}
            broadcast(state, {:queue_updated, %{queue: queue, current_index: idx}})
            if log_changed, do: broadcast(state, {:activity_log_updated, activity_log})
            {:reply, :ok, state}
        end
    end
  end

  # Set the room's current video to the given URL — used by the extension's
  # "Set room to this page" toast. Two cases:
  #   * Queue active and current_index is set: rewrite that item in place
  #     (URL + re-parsed source_type/source_id; clear scraped title/thumb).
  #   * Queue ended (current_index nil) or empty: append a new MediaItem and
  #     point current_index at it so play_state can transition to :playing.
  # Either way: cancel pending advance/sync-correction timers, reset
  # current_time to 0, set play_state to :playing, and broadcast queue_updated
  # + video_changed so every client (LV + extension) re-syncs.
  def handle_call({:update_current_url, user_id, url}, _from, state) do
    case Byob.MediaItem.parse_url(url) do
      {:ok, parsed} ->
        now = System.monotonic_time(:millisecond)
        state = maybe_cancel_pending_advance(state)
        state = cancel_sync_correction(state)

        {item, queue, idx} =
          case state.current_index && Enum.at(state.queue, state.current_index) do
            %Byob.MediaItem{} = current ->
              updated = %{
                current
                | url: url,
                  source_type: parsed.source_type,
                  source_id: parsed.source_id,
                  title: nil,
                  thumbnail_url: nil
              }

              {updated, List.replace_at(state.queue, state.current_index, updated),
               state.current_index}

            _ ->
              added_by_name =
                case Map.get(state.users, user_id) do
                  %{username: name} -> name
                  _ -> nil
                end

              new_item = %{
                parsed
                | added_by: user_id,
                  added_by_name: added_by_name,
                  added_at: DateTime.utc_now()
              }

              queue = state.queue ++ [new_item]
              {new_item, queue, length(queue) - 1}
          end

        state = %{
          state
          | queue: queue,
            current_index: idx,
            current_time: 0.0,
            play_state: :playing,
            last_sync_at: now,
            sponsor_segments: []
        }

        state = add_to_history(state, item)
        state = schedule_sync_correction(state)
        fetch_sponsor_segments(item)
        state = fetch_comments_for_current(state)
        # Use :played (same as queue→Play Now) so the activity feed reads
        # "<user> jumped to <title>" rather than "<user> added <url>", which
        # mis-suggests a queue add.
        state = log_activity(state, :played, user_id, item.title || item.url)

        broadcast(state, {:queue_updated, %{queue: queue, current_index: idx}})
        state = broadcast_video_changed(state, item, idx)
        {:reply, {:ok, item}, state}

      _ ->
        {:reply, {:error, :invalid_url}, state}
    end
  end

  def handle_call({:leave, user_id}, _from, state) do
    case Map.get(state.users, user_id) do
      nil ->
        {:reply, :ok, state}

      _user ->
        # Defer the visible side effects (mark disconnected, "left" toast,
        # ≤1-user pause, ready-count refresh) by @leave_grace_ms. Network
        # blips that resolve within the window leave no trace — the
        # incoming :join will cancel this timer before it fires.
        state = cancel_pending_leave_timer(state, user_id)
        ref = Process.send_after(self(), {:finalize_leave, user_id}, @leave_grace_ms)
        pending = Map.put(state.pending_leaves, user_id, ref)
        {:reply, :ok, %{state | pending_leaves: pending}}
    end
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

        # If the autoplay-advance timer is running (current video just
        # ended), a fresh :play means a client replayed the same video
        # (e.g. YouTube's end-card replay button) — cancel the advance
        # so we don't yank them to the next queue item 5s later.
        state = maybe_cancel_pending_advance(state)

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
          SyncLog.play(
            state.room_id,
            user_id,
            current_media_url(state),
            position,
            "paused→playing"
          )
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
          SyncLog.pause(
            state.room_id,
            user_id,
            current_media_url(state),
            position,
            "playing→paused"
          )
        end

        {:reply, :ok, state}
    end
  end

  def handle_call({:seek, user_id, position}, _from, state) do
    now = System.monotonic_time(:millisecond)
    last = Map.get(state.last_seek_at, user_id)

    cond do
      current_media_is_live?(state) ->
        # Live content (YT live, Twitch) — there's no meaningful
        # position to sync, and forcing other players to seek
        # would knock them off the live edge. Drop the seek.
        {:reply, :ok, state}

      last != nil and now - last < @sync_broadcast_debounce_ms ->
        {:reply, {:error, :debounced}, state}

      true ->
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
        # User-initiated seek means the canonical reference just jumped —
        # any in-flight per-user SyncDecision streak / cooldown is now
        # stale. Reset all peers' decision state (preserving learned_L).
        state = reset_user_sync_states(state)
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
  def handle_call({:video_ended, ref_value}, _from, state) do
    # ref_value is either an item id (binary) or a queue index
    # (integer, kept for backward compat during deploy when older
    # clients haven't reloaded yet). Item id is the right key —
    # current_index is always 0 after each advance, so the previous
    # "match by index" amounted to "any :ended whose pending_advance
    # _ref slot is empty". A stale :ended from a backgrounded tab
    # (whose 500 ms tick was throttled past A's natural end and
    # fired post-advance) would slot right in and trigger ANOTHER
    # 5 s countdown, advancing B → C and making B look skipped.
    cond do
      state.pending_advance_ref != nil ->
        {:reply, :stale, state}

      state.current_index == nil ->
        {:reply, :stale, state}

      true ->
        current = Enum.at(state.queue, state.current_index)
        match? =
          cond do
            is_binary(ref_value) -> current && current.id == ref_value
            is_integer(ref_value) -> ref_value == state.current_index
            true -> false
          end

        if match? do
          state =
            case current do
              %{} = finished ->
                title = finished.title || finished.url
                log_activity(state, :finished, nil, title)

              _ ->
                state
            end

          now = System.monotonic_time(:millisecond)
          timer_ref = Process.send_after(self(), :advance_pending, @autoplay_countdown_ms)
          state = %{state | pending_advance_ref: timer_ref, play_state: :paused}

          has_next = state.current_index + 1 < length(state.queue)

          broadcast(
            state,
            {:autoplay_countdown,
             %{duration_ms: @autoplay_countdown_ms, server_time: now, has_next: has_next}}
          )

          {:reply, :ok, state}
        else
          {:reply, :stale, state}
        end
    end
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

    state = broadcast_video_changed(state, item, 0)
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

    # Over-fetch and validate via the cached YT Data API so we never
    # hand the user a non-embeddable winner or a thumbnail-less tile
    # in the spinner / vote grid. Cached lookups are essentially free;
    # uncached are HTTP but parallel so total latency stays sub-second
    # for typical pool sizes.
    case Byob.Pool.pick_candidates(queue_ids, total_target * 3) do
      {:ok, raw_candidates} ->
        case validate_pool_candidates(raw_candidates) |> Enum.take(total_target) do
          [] ->
            {:reply, {:error, :no_candidates}, state}

          candidates ->
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

            state = %{
              state
              | round: round,
                round_expire_ref: expire_ref,
                round_last_broadcast_ms: 0
            }

            state =
              log_activity(
                state,
                if(mode == :voting, do: :vote_started, else: :roulette_started),
                user_id,
                nil
              )

            broadcast(state, {:round_started, snapshot_round(round)})
            {:reply, {:ok, round}, state}
        end

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
          if entry.action in [:added, :played] && entry.detail == old_url do
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

  def handle_info({:finalize_leave, user_id}, state) do
    state = %{state | pending_leaves: Map.delete(state.pending_leaves, user_id)}
    {:noreply, do_finalize_leave(state, user_id)}
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

  def handle_info(
        {:round_expire, round_id},
        %{round: %Round{id: round_id, phase: :active}} = state
      ) do
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

    # Live content has no meaningful position. Heartbeats with a
    # bogus current_time would force clients to drift-correct
    # toward whatever value we send, so skip the time payload.
    unless current_media_is_live?(state) do
      broadcast(
        state,
        {:state_heartbeat,
         %{
           play_state: state.play_state,
           current_time: position,
           server_time: now
         }}
      )
    end

    Process.send_after(self(), :state_heartbeat, @state_heartbeat_interval_ms)
    {:noreply, state}
  end

  def handle_info(:sync_correction, %{play_state: :playing} = state) do
    now = System.monotonic_time(:millisecond)
    position = current_position(state)

    unless current_media_is_live?(state) do
      broadcast(state, {:sync_correction, %{expected_time: position, server_time: now}})
    end

    state = %{state | sync_correction_ref: Process.send_after(self(), :sync_correction, @sync_correction_interval_ms)}
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

  # ── Drift-sample tracking + per-user SyncDecision + clock adjustment ──
  # We subscribe to "room:#{room_id}" in init so we receive every peer's
  # drift report (broadcast as `:sync_client_stats` by LV and Channel).
  # The data drives:
  #   1. drift_samples for room-wide clock adjustment
  #   2. per-user `Byob.SyncDecision` — single authoritative state per
  #      user, regardless of how many LV processes are alive for that
  #      user (transport switches, reconnects).
  def handle_info({:sync_client_stats, data}, state) do
    user_id = Map.get(data, :user_id)

    if is_binary(user_id) do
      now = System.monotonic_time(:millisecond)

      drift_samples =
        Map.put(state.drift_samples, user_id, %{
          drift_ms: Map.get(data, :drift_ms, 0),
          updated_at: now
        })

      {user_state, new_user_state, seek_command, tolerance_ms, cooldown_ms} =
        run_sync_decision(state, data, drift_samples, user_id, now)

      user_sync_states = Map.put(state.user_sync_states, user_id, new_user_state)
      state = %{state | drift_samples: drift_samples, user_sync_states: user_sync_states}

      # If a seek was decided, broadcast it. Targeted at the user_id —
      # any LV/Channel whose socket matches forwards to push_event.
      if seek_command do
        broadcast(state, {:user_seek_command, user_id, seek_command})
      end

      # Always broadcast the decision-state snapshot so the panel can
      # show server-authoritative tolerance / streak / cooldown / learned_L
      # for that user. This *replaces* the per-LV computation that used
      # to live in room_live's handle_info.
      broadcast(
        state,
        {:user_decision_state, user_id,
         %{
           tolerance_ms: tolerance_ms,
           seek_streak: new_user_state.seek_streak,
           cooldown_remaining_ms: cooldown_ms,
           learned_l_ms: trunc(new_user_state.learned_l_ms || 0)
         }}
      )

      _ = user_state
      {:noreply, state}
    else
      {:noreply, state}
    end
  end

  # Periodic room-wide clock adjustment. Server's canonical reference
  # (current_time + elapsed) is fixed at room creation; if peers
  # consistently report drift = -200 ms (everyone 200 ms behind it), the
  # reference is calibrated wrong for the actual room. Shift it backward
  # by a damped fraction of mean drift so peer drifts converge to ~0.
  #
  # Heavily defended:
  #   * ≥ 2 active peers (otherwise it's a single peer's structural lag,
  #     not room-wide).
  #   * Only if play_state is :playing.
  #   * Only if |mean| > 100 ms (avoid noise / EMA pollution).
  #   * Damped at 30 % and capped at 200 ms per pass — small enough that
  #     clients' jitter-EMA seek-rejection (500 ms threshold) won't see
  #     it as a discontinuity.
  def handle_info(:adjust_room_clock, state) do
    now = System.monotonic_time(:millisecond)

    active_drifts =
      state.drift_samples
      |> Enum.filter(fn {_, %{updated_at: t}} -> now - t < @drift_sample_stale_ms end)
      |> Enum.map(fn {_, %{drift_ms: d}} -> d end)

    state =
      cond do
        length(active_drifts) < 2 ->
          state

        state.play_state != :playing ->
          state

        true ->
          {raw_shift, reason} = clock_adjust_target(active_drifts)

          if abs(raw_shift) > @clock_adjust_min_drift_ms do
            # Sign: drift = local − expected. To move peer drifts TOWARD 0
            # by N, expected must shift by SAME sign as the drift values
            # (`new_drift = drift − Δ` so Δ = drift to zero them; for the
            # all-same-sign case `raw_shift` already IS such a Δ).
            shift_ms =
              raw_shift
              |> trunc()
              |> max(-@clock_adjust_max_per_pass_ms)
              |> min(@clock_adjust_max_per_pass_ms)

            current_pos = current_position(state)
            # `current_pos − shift_ms/1000`: new expected drops by shift,
            # so peers' drifts increase by shift (= -shift_ms applied to
            # `local - expected`). For all-behind (raw_shift = max_neg <
            # 0), this *decreases* current_pos by abs(max_neg).
            new_pos = max(0.0, current_pos + shift_ms / 1000)

            unless current_media_is_live?(state) do
              broadcast(
                state,
                {:sync_correction, %{expected_time: new_pos, server_time: now}}
              )
            end

            require Logger

            Logger.info(
              "[clock_adjust] room=#{state.room_id} #{reason} shift=#{shift_ms}ms peers=#{length(active_drifts)} drifts=#{inspect(active_drifts)} new_pos=#{Float.round(new_pos * 1.0, 2)}"
            )

            %{state | current_time: new_pos, last_sync_at: now}
          else
            state
          end
      end

    ref = Process.send_after(self(), :adjust_room_clock, @clock_adjust_interval_ms)
    {:noreply, %{state | clock_adjust_ref: ref}}
  end

  # Catch-all for self-PubSub broadcasts we receive but don't act on
  # (we subscribe broadly to get :sync_client_stats; everything else —
  # :sync_play, :sync_correction tuples that bounce back, etc. — is for
  # the LVs / Channels, not us).
  def handle_info(_msg, state), do: {:noreply, state}

  # Private helpers

  defp current_position(%{play_state: :playing} = state) do
    elapsed = (System.monotonic_time(:millisecond) - state.last_sync_at) / 1000
    clamp_to_duration(state.current_time + elapsed, state)
  end

  defp current_position(state), do: clamp_to_duration(state.current_time, state)

  defp clamp_to_duration(pos, state) do
    case current_item_duration(state) do
      nil -> pos
      d -> min(pos, d)
    end
  end

  defp current_item_duration(%{current_index: nil}), do: nil

  defp current_item_duration(%{current_index: idx, queue: queue}) do
    case Enum.at(queue, idx) do
      %{duration: d} when is_number(d) and d > 0 -> d * 1.0
      _ -> nil
    end
  end

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

  # Walk the pool candidates in parallel, dropping any that the YT
  # Data API flags as non-embeddable or that we can't pull a thumbnail
  # for. Backfill missing pool fields (some sources skip duration /
  # thumbnail). When the API itself is down (quota / network), keep
  # entries that already have a thumbnail — the worst case is a
  # non-embeddable winner that the user-facing fallback handles, vs.
  # serving no candidates at all.
  defp validate_pool_candidates(candidates) do
    candidates
    |> Task.async_stream(
      fn c ->
        case Byob.YouTube.Videos.fetch(c.external_id) do
          {:ok, %{embeddable: false}} ->
            :reject

          {:ok, meta} ->
            thumb = c.thumbnail_url || meta[:thumbnail_url]

            if thumb do
              {:keep,
               %{
                 c
                 | thumbnail_url: thumb,
                   duration_s: c.duration_s || meta[:duration],
                   title: c.title || meta[:title]
               }}
            else
              :reject
            end

          {:error, _} ->
            if c.thumbnail_url, do: {:keep, c}, else: :reject
        end
      end,
      max_concurrency: 12,
      timeout: 3_000,
      on_timeout: :kill_task
    )
    |> Enum.flat_map(fn
      {:ok, {:keep, c}} -> [c]
      _ -> []
    end)
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

  # Runs Byob.SyncDecision for ONE user. Returns
  #   {old_state, new_state, seek_command_or_nil, tolerance_ms, cooldown_ms}
  defp run_sync_decision(state, data, drift_samples, user_id, now_ms) do
    user_state = Map.get(state.user_sync_states, user_id) || Byob.SyncDecision.new()

    # Room jitter: max non-stale peer noise floor.
    room_jitter =
      drift_samples
      |> Enum.filter(fn {_, %{updated_at: t}} -> now_ms - t < @drift_sample_stale_ms end)
      |> Enum.map(fn {_, c} -> Map.get(c, :noise_floor_ms, 0) end)
      |> case do
        [] -> 0
        list -> Enum.max(list)
      end

    expected_position = current_position(state)

    drift_input = %{
      drift_ms: Map.get(data, :drift_ms, 0),
      noise_floor_ms: Map.get(data, :noise_floor_ms, 0),
      rtt_ms: Map.get(data, :rtt_ms, 0),
      observed_l_ms: Map.get(data, :observed_l_ms, 0),
      user_id: user_id
    }

    room = %{expected_position: expected_position, room_jitter_ms: room_jitter}

    {result, new_user_state} =
      case Byob.SyncDecision.evaluate(user_state, drift_input, room, now_ms) do
        {:seek, command, ns} -> {{:seek, command}, ns}
        {:no_seek, ns} -> {:no_seek, ns}
      end

    seek_command =
      case result do
        {:seek, cmd} -> cmd
        _ -> nil
      end

    tolerance_ms =
      drift_input
      |> Byob.SyncDecision.tolerance_ms(room, new_user_state, now_ms)
      |> trunc()

    cooldown_ms = Byob.SyncDecision.cooldown_remaining_ms(new_user_state, now_ms)

    {user_state, new_user_state, seek_command, tolerance_ms, cooldown_ms}
  end

  # Wipes per-session SyncDecision state for every user — streak,
  # cooldown, last_seek_at — while preserving each user's
  # `learned_l_ms` (device-specific seek-processing latency that
  # outlives any single video). Called on user seeks and video
  # changes: the canonical reference position just shifted, so any
  # pending seek state is now stale.
  defp reset_user_sync_states(state) do
    %{
      state
      | user_sync_states:
          Map.new(state.user_sync_states, fn {user_id, ds} ->
            {user_id, Byob.SyncDecision.reset_for_new_video(ds)}
          end),
        drift_samples: %{}
    }
  end

  # Wraps the `:video_changed` broadcast with a SyncDecision reset.
  # Every video transition resets per-user streak / cooldown so the next
  # video starts with a clean slate (preserving learned_L).
  defp broadcast_video_changed(state, item, index) do
    state = reset_user_sync_states(state)
    broadcast(state, {:video_changed, %{media_item: item, index: index}})
    state
  end

  # Choose how much to shift the canonical clock to minimize peers' |drift|.
  # Returns `{shift_ms, reason}`.
  defp clock_adjust_target(drifts) do
    cond do
      drifts == [] ->
        {0, "empty"}

      Enum.all?(drifts, &(&1 < 0)) ->
        # All behind. Shifting by the LEAST-negative drift moves it to
        # exactly 0 and pulls every other peer the same amount toward 0
        # — none end up worse. Full shift, no damping needed.
        {Enum.max(drifts), "all-behind"}

      Enum.all?(drifts, &(&1 > 0)) ->
        # All ahead. Symmetric.
        {Enum.min(drifts), "all-ahead"}

      true ->
        # Mixed signs — peers on opposite sides of 0. Shifting in either
        # direction moves some peers toward 0 and others away. Use median
        # for the robust optimum and damp to limit per-pass disruption.
        median = compute_median(drifts)
        {trunc(median * @clock_adjust_mixed_damping), "mixed"}
    end
  end

  defp compute_median(values) do
    sorted = Enum.sort(values)
    n = length(sorted)
    mid = div(n, 2)

    if rem(n, 2) == 0 do
      div(Enum.at(sorted, mid - 1) + Enum.at(sorted, mid), 2)
    else
      Enum.at(sorted, mid)
    end
  end

  defp username_connected?(state, username) do
    state.users
    |> Enum.any?(fn {_, u} -> u.connected && u.username == username end)
  end

  defp cancel_pending_leave_timer(state, user_id) do
    case Map.get(state.pending_leaves, user_id) do
      nil ->
        state

      ref ->
        Process.cancel_timer(ref)
        %{state | pending_leaves: Map.delete(state.pending_leaves, user_id)}
    end
  end

  defp do_finalize_leave(state, user_id) do
    case Map.get(state.users, user_id) do
      nil ->
        state

      user ->
        leaving_username = user.username
        is_ext = Map.get(user, :is_extension, false)

        state = log_activity(state, :left, user_id)

        # If this is an extension user leaving, clear only their ready tabs.
        # When the SW dies, it can't send video:unready — this is the fallback.
        state =
          if is_ext do
            ready_tabs = Map.get(state, :ready_tabs, %{})
            open_tabs = Map.get(state, :open_tabs, %{})

            cleaned_ready =
              ready_tabs |> Enum.reject(fn {_, owner} -> owner == user_id end) |> Map.new()

            cleaned_open =
              open_tabs |> Enum.reject(fn {_, owner} -> owner == user_id end) |> Map.new()

            state |> Map.put(:ready_tabs, cleaned_ready) |> Map.put(:open_tabs, cleaned_open)
          else
            state
          end

        # Mark as disconnected instead of removing
        state = put_in(state.users[user_id], %{user | connected: false})

        # Count distinct USERNAMES, not raw user_ids. Per-tab user IDs
        # (session_id:tab_id + one extra for the extension SW) mean a
        # single real person can contribute 2–3 connected entries to
        # state.users. We want "2 actual humans → 1 human" to pause,
        # not "4 user_ids → 3".
        connected_usernames =
          state.users
          |> Enum.filter(fn {_, u} -> u.connected end)
          |> Enum.map(fn {_, u} -> u.username end)
          |> Enum.uniq()

        connected_count = length(connected_usernames)

        # Pause when the room is down to ≤1 distinct user — there's
        # nobody left to watch in sync, so leaving state=:playing just
        # lets the server-side clock drift.
        state =
          if connected_count <= 1 and state.play_state == :playing do
            %{
              state
              | play_state: :paused,
                current_time: current_position(state),
                last_sync_at: System.monotonic_time(:millisecond)
            }
            |> cancel_sync_correction()
            |> tap(fn s ->
              now = System.monotonic_time(:millisecond)
              broadcast(s, {:sync_pause, %{time: s.current_time, server_time: now, user_id: nil}})
            end)
          else
            state
          end

        state =
          if connected_count == 0 do
            schedule_cleanup(state)
          else
            broadcast(state, {:users_updated, state.users})
            broadcast_ready_count(state)
            state
          end

        # Toast "username left" only if no other connection with the
        # same username is still present (extension reconnect with a
        # new user_id during the grace window suppresses this).
        if leaving_username && not username_connected?(state, leaving_username) do
          broadcast(
            state,
            {:room_presence, %{event: Events.presence_left(), username: leaving_username}}
          )
        end

        state
    end
  end

  defp user_has_no_open_tabs?(open_tabs, ext_user_id) do
    not Enum.any?(open_tabs, fn {_, owner} -> owner == ext_user_id end)
  end

  defp broadcast_ready_count(state) do
    connected = state.users |> Enum.filter(fn {_, u} -> u.connected end)

    has_extension_users =
      Enum.any?(connected, fn {_, u} -> Map.get(u, :is_extension, false) end)

    open_tabs = Map.get(state, :open_tabs, %{})
    ready_tabs = Map.get(state, :ready_tabs, %{})

    if has_extension_users or map_size(open_tabs) > 0 do
      non_ext = connected |> Enum.reject(fn {_, u} -> Map.get(u, :is_extension, false) end)
      non_ext_usernames = non_ext |> Enum.map(fn {_, u} -> u.username end) |> Enum.uniq()
      total_users = length(non_ext_usernames)

      %{has_tab: has_tab, ready: ready, needs_open: needs_open, needs_play: needs_play} =
        count_tab_owners(state, open_tabs, ready_tabs, non_ext_usernames)

      broadcast(
        state,
        {:ready_count,
         %{
           ready: ready,
           has_tab: has_tab,
           total: total_users,
           needs_open: needs_open,
           needs_play: needs_play
         }}
      )
    end
  end

  # Count unique usernames that have at least one open tab / ready tab,
  # and compute which non-ext usernames still need to open a player window
  # or hit play. open_tabs / ready_tabs are keyed by tab_id with the
  # ext_user_id as value; a single user can have multiple tabs and
  # multiple ext_user_ids can share a username. Filters out owners that
  # aren't currently connected so stale entries don't inflate counts.
  defp count_tab_owners(state, open_tabs, ready_tabs, non_ext_usernames) do
    connected_ids =
      state.users
      |> Enum.filter(fn {_, u} -> u.connected end)
      |> Enum.map(fn {id, _} -> id end)
      |> MapSet.new()

    resolve = fn owner_id ->
      if MapSet.member?(connected_ids, owner_id) do
        get_in(state, [Access.key(:users), owner_id, Access.key(:username)])
      else
        nil
      end
    end

    open_users =
      open_tabs
      |> Map.values()
      |> Enum.map(resolve)
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq()

    ready_users =
      ready_tabs
      |> Map.values()
      |> Enum.map(resolve)
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq()

    total_users = length(non_ext_usernames)
    has_tab = min(length(open_users), total_users)
    ready = min(length(ready_users), has_tab)

    open_set = MapSet.new(open_users)
    ready_set = MapSet.new(ready_users)

    needs_open = Enum.reject(non_ext_usernames, &MapSet.member?(open_set, &1))

    needs_play =
      non_ext_usernames
      |> Enum.filter(&MapSet.member?(open_set, &1))
      |> Enum.reject(&MapSet.member?(ready_set, &1))

    %{has_tab: has_tab, ready: ready, needs_open: needs_open, needs_play: needs_play}
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
        broadcast_video_changed(state, item, 0)
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
        broadcast_video_changed(state, item, 0)

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
        broadcast_video_changed(state, item, 0)
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
      state = broadcast_video_changed(state, item, 0)
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
      nil ->
        nil

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

  defp current_media_is_live?(state) do
    case state.current_index do
      nil ->
        false

      idx ->
        item = Enum.at(state.queue, idx)
        item && Map.get(item, :is_live, false)
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
    ref = Process.send_after(self(), :sync_correction, @sync_correction_interval_ms)
    %{state | sync_correction_ref: ref}
  end

  defp schedule_rate_limit_reset(state) do
    ref = Process.send_after(self(), :reset_rate_limits, @rate_limit_reset_interval_ms)
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
    Process.send_after(self(), :persist, @persist_interval_ms)
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

    # Curated-playlist candidates land here with duration_s = nil because
    # the YouTube playlistItems endpoint doesn't return durations. Kick
    # off the same metadata fetch the manual add_to_queue path uses so
    # the queue thumbnail's "M:SS" overlay (and any missing title/thumb)
    # gets backfilled via :oembed_result.
    item_id = item.id
    pid = self()

    Task.start(fn ->
      case fetch_youtube_meta(item.source_id, url) do
        {:ok, meta} -> send(pid, {:oembed_result, item_id, meta})
        _ -> :ok
      end
    end)

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
