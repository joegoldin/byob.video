defmodule ByobWeb.RoomLive do
  use ByobWeb, :live_view

  alias Byob.{Events, RoomManager, RoomServer}

  alias ByobWeb.RoomLive.{
    Comments,
    Components,
    Playback,
    PubSub,
    Queue,
    RoundPanel,
    UrlPreview,
    Username
  }

  # Cross-boundary handle_event patterns (browser JS → LV). Module attributes
  # because handle_event/3 pattern matching requires compile-time strings.
  @ev_video_play Events.ev_video_play()
  @ev_video_pause Events.ev_video_pause()
  @ev_video_seek Events.ev_video_seek()
  @ev_video_ended Events.ev_video_ended()
  @ev_video_embed_blocked Events.ev_video_embed_blocked()
  @ev_video_drift_report Events.ev_video_drift_report()
  @ev_video_live_status Events.ev_video_live_status()
  @ev_video_loaded Events.ev_video_loaded()
  @ev_sync_ping Events.in_sync_ping()

  def mount(%{"id" => room_id}, _session, socket) do
    if not Regex.match?(~r/^[a-z0-9]{1,16}$/, room_id) do
      {:ok, push_navigate(socket, to: "/")}
    else
      mount_room(room_id, socket)
    end
  end

  defp mount_room(room_id, socket) do
    {:ok, pid} = RoomManager.ensure_room(room_id)

    socket =
      assign(socket,
        room_id: room_id,
        room_pid: pid,
        users: %{},
        queue: [],
        history: [],
        current_index: nil,
        play_state: :paused,
        current_media: nil,
        ext_player: nil,
        sidebar_tab: :queue,
        editing_username: false,
        url_preview: nil,
        url_preview_loading: false,
        preview_url: nil,
        resolved_url: nil,
        url_preview_error: nil,
        api_key: nil,
        activity_log: [],
        sb_settings: Byob.RoomServer.default_sb_settings(),
        comments: nil,
        comments_next_page: nil,
        comments_video_id: nil,
        comments_total: nil,
        show_comments: true,
        comments_collapsed: false,
        comments_expanded: false,
        round: nil,
        round_collapsed: false,
        sync_stats: %{correction_interval_ms: 1000, clients: %{}}
      )

    if connected?(socket) do
      # Use stable per-tab ID from sessionStorage (survives reconnects, unique per tab)
      tab_id = get_connect_params(socket)["tab_id"] || socket.id
      user_id = socket.assigns.user_id <> ":" <> tab_id
      # Prefer localStorage username over session-generated one
      username =
        case get_connect_params(socket)["stored_username"] do
          nil -> socket.assigns.username
          "" -> socket.assigns.username
          stored -> stored
        end

      browser_id = get_connect_params(socket)["browser_id"] || socket.assigns.user_id
      has_extension = get_connect_params(socket)["has_extension"] == true
      show_comments = get_connect_params(socket)["show_comments"] != false

      socket =
        assign(socket,
          user_id: user_id,
          username: username,
          browser_id: browser_id,
          show_comments: show_comments
        )

      Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")
      {:ok, state} = RoomServer.join(pid, user_id, username)

      # Analytics — use browser_id as distinct_id (same person across tabs)
      Byob.Analytics.room_joined(browser_id, room_id, has_extension: has_extension)

      current_media =
        if state.current_index, do: Enum.at(state.queue, state.current_index), else: nil

      socket =
        assign(socket,
          users: state.users,
          queue: state.queue,
          history: state.history,
          current_index: state.current_index,
          play_state: state.play_state,
          current_media: current_media,
          sb_settings: state.sb_settings,
          activity_log: state.activity_log || [],
          api_key: RoomServer.get_api_key(pid),
          round: Map.get(state, :round)
        )

      # Push full state to client hook for two-step join
      socket = push_event(socket, Events.sync_state(), sync_state_payload(state, user_id))

      # Push SB settings and sponsor segments
      socket = push_event(socket, Events.sb_settings(), state.sb_settings)

      socket =
        if state.sponsor_segments != [] && current_media do
          push_event(socket, Events.sponsor_segments(), %{
            segments: state.sponsor_segments,
            duration: current_media.duration || 0,
            video_id: current_media.source_id
          })
        else
          socket
        end

      # Fetch YouTube comments for current video
      if current_media && current_media.source_type == :youtube && current_media.source_id do
        me = self()
        video_id = current_media.source_id

        Task.start(fn ->
          case Byob.YouTube.Comments.fetch(video_id) do
            {:ok, result} -> send(me, {:comments_result_direct, video_id, result})
            _ -> :ok
          end
        end)
      end

      # Push media info for extension placeholder
      socket =
        if current_media && current_media.source_type == :extension_required do
          push_event(socket, Events.ext_media_info(), %{
            title: current_media.title,
            thumbnail_url: current_media.thumbnail_url,
            url: current_media.url
          })
        else
          socket
        end

      {:ok,
       attach_hook(socket, :ensure_pid, :handle_event, fn _event, _params, socket ->
         {:cont, ensure_room_pid(socket)}
       end)}
    else
      {:ok, socket}
    end
  end

  def terminate(_reason, socket) do
    if Map.has_key?(socket.assigns, :user_id) and Map.has_key?(socket.assigns, :room_pid) do
      RoomServer.leave(socket.assigns.room_pid, socket.assigns.user_id)
    end

    :ok
  end

  # Client events

  def handle_event("preview_url", params, socket),
    do: UrlPreview.handle_preview_url(params, socket)

  def handle_event("clear_url", _params, socket) do
    {:noreply,
     assign(socket,
       url_preview: nil,
       url_preview_loading: false,
       preview_url: nil,
       resolved_url: nil,
       url_preview_error: nil
     )}
  end

  def handle_event("history:play", params, socket), do: Queue.handle_history_play(params, socket)
  def handle_event("queue:readd", params, socket), do: Queue.handle_readd(params, socket)
  def handle_event("video:restart", params, socket), do: Queue.handle_restart(params, socket)

  def handle_event("add_url", params, socket), do: UrlPreview.handle_add_url(params, socket)

  def handle_event("analytics:has_extension", params, socket),
    do: Playback.handle_has_extension(params, socket)

  def handle_event(@ev_video_play, params, socket), do: Playback.handle_play(params, socket)
  def handle_event(@ev_video_pause, params, socket), do: Playback.handle_pause(params, socket)
  def handle_event(@ev_video_seek, params, socket), do: Playback.handle_seek(params, socket)
  def handle_event(@ev_video_loaded, params, socket), do: Playback.handle_loaded(params, socket)

  def handle_event(@ev_video_drift_report, params, socket) do
    # Local (browser) player reports its adjusted drift and learned offset so
    # the "Stats for nerds" panel can show it next to extension clients.
    user_id = socket.assigns[:user_id]
    username = socket.assigns[:username]
    room_id = socket.assigns[:room_id]
    room_pid = socket.assigns[:room_pid]

    if user_id && room_id && room_pid do
      # Server-authoritative model: client only ships raw measurements.
      # Tolerance / seek_streak / cooldown are server-computed and only
      # broadcast for the local user (set by maybe_decide_seek's panel
      # push). Other peers see drift / jitter / rtt only.
      drift_ms = trunc(params["drift_ms"] || 0)
      offset_ms = trunc(params["offset_ms"] || 0)
      rtt_ms = trunc(params["rtt_ms"] || 0)
      noise_floor_ms = trunc(params["noise_floor_ms"] || 0)
      observed_l_ms = trunc(params["observed_l_ms"] || 0)
      gesture_blocked = !!params["gesture_blocked"]
      playing = params["playing"] || false

      state = Byob.RoomServer.get_state(room_pid)
      now = System.monotonic_time(:millisecond)

      server_pos =
        if state.play_state == :playing do
          elapsed = (now - Map.get(state, :last_sync_at, now)) / 1000
          state.current_time + elapsed
        else
          state.current_time
        end

      Phoenix.PubSub.broadcast(
        Byob.PubSub,
        "room:#{room_id}",
        {:sync_client_stats,
         %{
           user_id: user_id,
           tab_id: "browser",
           username: username,
           drift_ms: drift_ms,
           raw_drift_ms: drift_ms + offset_ms,
           offset_ms: offset_ms,
           rtt_ms: rtt_ms,
           noise_floor_ms: noise_floor_ms,
           observed_l_ms: observed_l_ms,
           gesture_blocked: gesture_blocked,
           server_position: Float.round(server_pos * 1.0, 1),
           play_state: if(playing, do: "playing", else: "paused")
         }}
      )
    end

    {:noreply, socket}
  end

  def handle_event(@ev_video_embed_blocked, params, socket),
    do: Playback.handle_embed_blocked(params, socket)

  def handle_event(@ev_video_ended, params, socket), do: Playback.handle_ended(params, socket)

  def handle_event(@ev_video_live_status, params, socket) do
    # Client (LV embed or extension content script) auto-detected
    # whether the current item is live based on duration-growth /
    # video.duration === Infinity. Forward to the room server, which
    # rebroadcasts to peers so they all stop / start time-based sync
    # in lockstep.
    is_live = !!params["is_live"]
    room_pid = socket.assigns[:room_pid]
    if room_pid, do: Byob.RoomServer.update_live_status(room_pid, is_live)
    {:noreply, socket}
  end

  def handle_event("queue:skip", params, socket), do: Queue.handle_skip(params, socket)
  def handle_event("queue:remove", params, socket), do: Queue.handle_remove(params, socket)

  def handle_event("queue:play_index", params, socket),
    do: Queue.handle_play_index(params, socket)

  def handle_event("queue:reorder", params, socket), do: Queue.handle_reorder(params, socket)
  def handle_event("switch_tab", params, socket), do: Queue.handle_switch_tab(params, socket)
  def handle_event("sb:update", params, socket), do: Queue.handle_sb_update(params, socket)

  def handle_event("username:edit", params, socket), do: Username.handle_edit(params, socket)
  def handle_event("username:cancel", params, socket), do: Username.handle_cancel(params, socket)
  def handle_event("username:change", params, socket), do: Username.handle_change(params, socket)

  def handle_event("comments:load_more", params, socket),
    do: Comments.handle_load_more(params, socket)

  def handle_event("toggle_comments_collapse", _params, socket) do
    {:noreply, assign(socket, comments_collapsed: !socket.assigns.comments_collapsed)}
  end

  def handle_event("toggle_comments_expand", _params, socket) do
    {:noreply, assign(socket, comments_expanded: !socket.assigns.comments_expanded)}
  end

  def handle_event("toggle_comments", _params, socket) do
    show = !socket.assigns.show_comments
    socket = assign(socket, show_comments: show)
    socket = push_event(socket, "store-show-comments", %{show: show})
    socket = push_event(socket, "reopen-modal", %{id: "sb-settings-modal"})
    {:noreply, socket}
  end

  def handle_event(@ev_sync_ping, params, socket), do: Playback.handle_sync_ping(params, socket)

  # Rounds (roulette / voting)

  def handle_event("round:start", %{"mode" => mode}, socket)
      when mode in ["voting", "roulette"] do
    mode_atom = String.to_existing_atom(mode)

    case RoomServer.start_round(socket.assigns.room_pid, mode_atom, socket.assigns.user_id) do
      {:ok, _round} ->
        {:noreply, socket}

      {:error, :no_candidates} ->
        {:noreply, put_flash(socket, :error, "Pool is empty — come back in a bit.")}

      {:error, :round_active} ->
        {:noreply, socket}
    end
  end

  def handle_event("round:vote", %{"round_id" => round_id, "external_id" => external_id}, socket) do
    RoomServer.cast_vote(socket.assigns.room_pid, socket.assigns.user_id, external_id, round_id)
    {:noreply, socket}
  end

  def handle_event("round:cancel", %{"round_id" => round_id}, socket) do
    RoomServer.cancel_round(socket.assigns.room_pid, socket.assigns.user_id, round_id)
    {:noreply, socket}
  end

  def handle_event("round:toggle_collapse", _params, socket) do
    {:noreply, assign(socket, round_collapsed: !socket.assigns.round_collapsed)}
  end

  # PubSub messages from RoomServer

  def handle_info({:sync_play, data}, socket), do: PubSub.handle_sync_play(data, socket)
  def handle_info({:sync_pause, data}, socket), do: PubSub.handle_sync_pause(data, socket)

  def handle_info({:sync_correction, data}, socket),
    do: PubSub.handle_sync_correction(data, socket)

  def handle_info({:state_heartbeat, data}, socket),
    do: PubSub.handle_state_heartbeat(data, socket)

  def handle_info({:autoplay_countdown, data}, socket),
    do: PubSub.handle_autoplay_countdown(data, socket)

  def handle_info({:autoplay_countdown_cancelled, _}, socket),
    do: PubSub.handle_autoplay_cancelled(socket)

  def handle_info({:queue_updated, data}, socket), do: PubSub.handle_queue_updated(data, socket)

  def handle_info({:sponsor_segments, data}, socket),
    do: PubSub.handle_sponsor_segments(data, socket)

  def handle_info({:queue_ended, data}, socket), do: PubSub.handle_queue_ended(data, socket)
  def handle_info({:video_changed, data}, socket), do: PubSub.handle_video_changed(data, socket)

  def handle_info({:ready_count, data}, socket), do: PubSub.handle_ready_count(data, socket)

  def handle_info({:live_status, data}, socket) do
    {:noreply, push_event(socket, Events.live_status(), data)}
  end

  def handle_info({:url_preview_result, result}, socket),
    do: UrlPreview.handle_preview_result(result, socket)

  def handle_info({:sb_settings_updated, sb_settings}, socket),
    do: PubSub.handle_sb_settings_updated(sb_settings, socket)

  def handle_info({:extension_player_state, state}, socket),
    do: PubSub.handle_extension_player_state(state, socket)

  def handle_info({:extension_media_info, info}, socket),
    do: PubSub.handle_extension_media_info(info, socket)

  def handle_info({:sync_client_stats, data}, socket) do
    clients = Map.get(socket.assigns.sync_stats, :clients, %{})
    key = "#{data.user_id}:#{data.tab_id}"

    # Preserve any existing decision-state fields (tolerance_ms,
    # seek_streak, cooldown_remaining_ms, learned_l_ms). Those arrive
    # via the separate `:user_decision_state` broadcast — if we wrote
    # 0/empty here, the panel would flicker on every drift report
    # because the conditional "Seek cooldown" row would disappear and
    # reappear between this :sync_client_stats and the next
    # :user_decision_state.
    prev = Map.get(clients, key, %{})

    clients =
      Map.put(clients, key, %{
        drift_ms: data.drift_ms,
        raw_drift_ms: Map.get(data, :raw_drift_ms, data.drift_ms),
        offset_ms: Map.get(data, :offset_ms, 0),
        rtt_ms: Map.get(data, :rtt_ms, 0),
        noise_floor_ms: Map.get(data, :noise_floor_ms, 0),
        gesture_blocked: Map.get(data, :gesture_blocked, false),
        username: Map.get(data, :username),
        server_position: data.server_position,
        play_state: data.play_state,
        updated_at: System.system_time(:second),
        # Carry forward decision-state fields from the previous entry.
        tolerance_ms: Map.get(prev, :tolerance_ms, 0),
        seek_streak: Map.get(prev, :seek_streak, 0),
        cooldown_remaining_ms: Map.get(prev, :cooldown_remaining_ms, 0),
        learned_l_ms: Map.get(prev, :learned_l_ms, 0)
      })

    sync_stats = Map.put(socket.assigns.sync_stats, :clients, clients)

    # Room-wide consensus, two signals:
    #   room_jitter    = max peer noise_floor (tick-to-tick jitter EMA)
    #   room_max_drift = max peer |drift| — captures sustained spread
    now_s = System.system_time(:second)

    active =
      clients
      |> Enum.filter(fn {_, c} -> now_s - Map.get(c, :updated_at, 0) < 5 end)

    {room_jitter, room_max_drift} =
      case active do
        [] ->
          {0, 0}

        list ->
          jitters = Enum.map(list, fn {_, c} -> Map.get(c, :noise_floor_ms, 0) end)
          drifts = Enum.map(list, fn {_, c} -> abs(Map.get(c, :drift_ms, 0)) end)
          {Enum.max(jitters), Enum.max(drifts)}
      end

    # Server-authoritative seek decisions live in room_server now. LVs
    # don't run SyncDecision per-user anymore — that caused duplicate
    # state when two LV processes existed for the same user (transport
    # switches, reconnects). room_server is a singleton per room and
    # owns one decision state per user.
    #
    # Decision-state fields (tolerance / streak / cooldown / learned_L)
    # arrive via `:user_decision_state` broadcasts handled below; they
    # update the clients map entry for that user.

    sync_stats = Map.put(sync_stats, :clients, clients)

    # Use the carried-forward decision-state values for the JS push too,
    # so the bands diagram doesn't flicker between the broadcast and the
    # follow-up :user_decision_state (1 Hz cycle was very visible).
    merged = Map.get(clients, key, %{})

    socket =
      Phoenix.LiveView.push_event(socket, Events.sync_client_stats(), %{
        key: key,
        user_id: data.user_id,
        username: Map.get(data, :username),
        drift_ms: data.drift_ms,
        offset_ms: Map.get(data, :offset_ms, 0),
        rtt_ms: Map.get(data, :rtt_ms, 0),
        noise_floor_ms: Map.get(data, :noise_floor_ms, 0),
        room_jitter_ms: room_jitter,
        room_max_drift_ms: room_max_drift,
        tolerance_ms: Map.get(merged, :tolerance_ms, 0),
        seek_streak: Map.get(merged, :seek_streak, 0),
        cooldown_remaining_ms: Map.get(merged, :cooldown_remaining_ms, 0),
        learned_l_ms: Map.get(merged, :learned_l_ms, 0),
        play_state: data.play_state
      })

    socket =
      Phoenix.LiveView.push_event(socket, Events.sync_room_tolerance(), %{
        room_jitter_ms: room_jitter,
        room_max_drift_ms: room_max_drift
      })

    {:noreply, assign(socket, :sync_stats, sync_stats)}
  end

  # Room-server-driven seek command. Targeted at user_id; only the LV(s)
  # whose socket matches forwards to push_event. Multiple LVs for the
  # same user (transport switches) all forward the same command —
  # idempotent since position + server_time are identical.
  def handle_info({:user_seek_command, user_id, command}, socket) do
    if user_id == socket.assigns[:user_id] do
      socket = Phoenix.LiveView.push_event(socket, Events.sync_seek_command(), command)
      {:noreply, socket}
    else
      {:noreply, socket}
    end
  end

  # Room-server-driven decision-state update. Updates the local clients-
  # map entry so the panel can render server-authoritative tolerance /
  # streak / cooldown / learned_L for the named user.
  #
  # Also re-pushes `sync:client_stats` to the JS layer with the merged
  # values — the original push from handle_info({:sync_client_stats, …})
  # ran BEFORE room_server made its decision, so it carried `tolerance_ms
  # = 0` and the bands diagram fell back to its 100 ms default. This
  # second push fixes the diagram with the actual server-authoritative
  # tolerance / streak / cooldown.
  def handle_info({:user_decision_state, user_id, decision}, socket) do
    clients = Map.get(socket.assigns.sync_stats, :clients, %{})
    key = "#{user_id}:browser"

    {clients, socket} =
      case Map.get(clients, key) do
        nil ->
          {clients, socket}

        entry ->
          merged = Map.merge(entry, decision)
          new_clients = Map.put(clients, key, merged)

          socket =
            Phoenix.LiveView.push_event(socket, Events.sync_client_stats(), %{
              key: key,
              user_id: user_id,
              username: Map.get(merged, :username),
              drift_ms: Map.get(merged, :drift_ms, 0),
              offset_ms: Map.get(merged, :offset_ms, 0),
              rtt_ms: Map.get(merged, :rtt_ms, 0),
              noise_floor_ms: Map.get(merged, :noise_floor_ms, 0),
              room_jitter_ms: room_jitter_from_clients(clients),
              room_max_drift_ms: room_max_drift_from_clients(clients),
              tolerance_ms: Map.get(merged, :tolerance_ms, 0),
              seek_streak: Map.get(merged, :seek_streak, 0),
              cooldown_remaining_ms: Map.get(merged, :cooldown_remaining_ms, 0),
              learned_l_ms: Map.get(merged, :learned_l_ms, 0),
              play_state: Map.get(merged, :play_state, "playing")
            })

          {new_clients, socket}
      end

    sync_stats = Map.put(socket.assigns.sync_stats, :clients, clients)
    {:noreply, assign(socket, :sync_stats, sync_stats)}
  end

  def handle_info({:users_updated, users}, socket), do: PubSub.handle_users_updated(users, socket)

  def handle_info({:room_presence, data}, socket),
    do: PubSub.handle_room_presence(data, socket)

  def handle_info({:activity_log_updated, log}, socket),
    do: PubSub.handle_activity_log_updated(log, socket)

  def handle_info({:activity_log_entry, entry}, socket),
    do: PubSub.handle_activity_log_entry(entry, socket)

  def handle_info({:round_started, round}, socket) do
    socket = assign(socket, round: round, round_collapsed: false)

    socket =
      if round.mode == :roulette do
        push_event(socket, "round:spin_start", %{
          candidates: Enum.map(round.candidates, &candidate_for_client/1)
        })
      else
        socket
      end

    # Scroll the round panel into view when there's nothing currently
    # playing to keep users' attention on (no queue, ended, or fresh room).
    # Otherwise users who are actively watching don't get yanked around.
    nothing_playing? =
      socket.assigns.current_index == nil or socket.assigns.play_state == :ended

    socket =
      if nothing_playing? do
        push_event(socket, "round:scroll_into_view", %{})
      else
        socket
      end

    {:noreply, socket}
  end

  def handle_info({:round_updated, round}, socket) do
    {:noreply, assign(socket, round: round)}
  end

  def handle_info({:round_revealed, payload}, socket) do
    round =
      case socket.assigns.round do
        nil ->
          nil

        existing ->
          merged =
            existing
            |> Map.put(:phase, :revealing)
            |> Map.put(:winner_external_id, payload.winner_external_id)
            |> Map.put(:seed, payload[:seed])
            |> Map.put(:tallies, payload[:tallies] || existing.tallies)

          merged
      end

    socket = assign(socket, round: round)

    socket =
      if payload.mode == :roulette do
        push_event(socket, "round:spin_land", %{
          seed: payload.seed,
          winner_external_id: payload.winner_external_id
        })
      else
        socket
      end

    {:noreply, socket}
  end

  def handle_info({:round_cancelled, _payload}, socket) do
    socket = assign(socket, round: nil, round_collapsed: false)
    socket = push_event(socket, "round:cleanup", %{})
    {:noreply, socket}
  end

  def handle_info({:round_finalized, _}, socket) do
    socket = assign(socket, round: nil, round_collapsed: false)
    socket = push_event(socket, "round:cleanup", %{})
    {:noreply, socket}
  end

  def handle_info({:comments_updated, data}, socket),
    do: PubSub.handle_comments_updated(data, socket)

  def handle_info({:comments_page_result, _, _} = msg, socket),
    do: Comments.handle_page_result(msg, socket)

  def handle_info({:comments_result_direct, video_id, result}, socket) do
    {:noreply,
     assign(socket,
       comments: result.comments,
       comments_next_page: result.next_page_token,
       comments_video_id: video_id,
       comments_total: result.total_count
     )}
  end

  def handle_info(_msg, socket) do
    {:noreply, socket}
  end

  defp room_jitter_from_clients(clients) do
    now_s = System.system_time(:second)

    clients
    |> Enum.filter(fn {_, c} -> now_s - Map.get(c, :updated_at, 0) < 5 end)
    |> Enum.map(fn {_, c} -> Map.get(c, :noise_floor_ms, 0) end)
    |> case do
      [] -> 0
      list -> Enum.max(list)
    end
  end

  defp room_max_drift_from_clients(clients) do
    now_s = System.system_time(:second)

    clients
    |> Enum.filter(fn {_, c} -> now_s - Map.get(c, :updated_at, 0) < 5 end)
    |> Enum.map(fn {_, c} -> abs(Map.get(c, :drift_ms, 0)) end)
    |> case do
      [] -> 0
      list -> Enum.max(list)
    end
  end

  # Render

  def render(assigns) do
    ~H"""
    <Components.room_nav
      room_id={@room_id}
      url_preview_loading={@url_preview_loading}
      url_preview={@url_preview}
      url_preview_error={@url_preview_error}
      preview_url={@preview_url}
      resolved_url={@resolved_url}
      round_active={@round != nil}
    />
    <Components.settings_modal
      sb_settings={@sb_settings}
      api_key={@api_key}
      show_comments={@show_comments}
      sync_stats={@sync_stats}
      users={@users}
      user_id={@user_id}
      play_state={@play_state}
      current_media={@current_media}
    />
    <Components.autoplay_help_modal />
    <div id="byob-tab-notifier" phx-hook="TabNotifier" class="hidden"></div>

    <div
      id="byob-nicknames-root"
      phx-hook="Nicknames"
      class={"flex flex-col lg:flex-row gap-3 #{unless @comments_expanded, do: "lg:h-[calc(100vh-3.5rem)]"}"}
    >
      <%!-- Main content --%>
      <div class="flex-1 min-w-0 min-h-0 flex flex-col">
        <%!-- Player wrapper: sizes the player to fit viewport while maintaining 16:9 --%>
        <div id="player-sizer" class="mb-2 flex justify-center flex-shrink-0" phx-update="ignore">
          <div
            id="player"
            phx-hook="VideoPlayer"
            data-user-id={@user_id}
            data-current-index={@current_index}
            data-room-id={@room_id}
            data-server-url={ByobWeb.Endpoint.url()}
            data-token={ByobWeb.ExtensionSocket.generate_token(@room_id, @user_id)}
            data-username={@username}
            class="relative bg-base-300 rounded-lg overflow-hidden"
          >
            <div class="absolute inset-0 flex items-center justify-center text-base-content/40">
              Paste a URL below to start watching
            </div>
          </div>
        </div>

        <RoundPanel.round_panel
          round={@round}
          collapsed={@round_collapsed}
          current_user_id={@user_id}
        />

        <Comments.comments_panel
          :if={@show_comments}
          comments={@comments}
          comments_next_page={@comments_next_page}
          collapsed={@comments_collapsed}
          expanded={@comments_expanded}
        />

        <%!-- The "Open / Focus Player Window" button used to live in a
             banner here. It's been moved into the player placeholder
             itself (assets/js/players/extension.js) so it's always
             visible regardless of how the surrounding sidebar / banner
             reflows at narrow window ratios. --%>
      </div>

      <%!-- Sidebar: queue/history at top, users pinned at bottom.
           When comments are expanded the outer container loses its fixed height
           and the main column grows — sticky/clamped height keeps this sidebar
           from stretching with it. --%>
      <div class="lg:w-72 flex flex-col gap-2 min-h-0 flex-shrink-0 lg:h-[calc(100vh-3.5rem)] lg:sticky lg:top-0 lg:self-start">
        <%!-- Queue/History card — fills available space --%>
        <div class="card bg-base-200 flex-1 min-h-0 overflow-hidden">
          <div class="card-body p-4 flex flex-col overflow-hidden">
            <%!-- Tabs --%>
            <div class="flex items-center gap-1 mb-2">
              <div role="tablist" class="tabs tabs-box tabs-sm flex-1">
                <button
                  role="tab"
                  class={"tab #{if @sidebar_tab == :queue, do: "tab-active"}"}
                  phx-click="switch_tab"
                  phx-value-tab="queue"
                >
                  Queue
                  <span :if={@queue != []} class="badge badge-xs ml-1">
                    {length(@queue) - (@current_index || 0)}
                  </span>
                </button>
                <button
                  role="tab"
                  class={"tab #{if @sidebar_tab == :history, do: "tab-active"}"}
                  phx-click="switch_tab"
                  phx-value-tab="history"
                >
                  History
                  <span :if={@history != []} class="badge badge-xs ml-1">
                    {length(@history)}
                  </span>
                </button>
              </div>
            </div>

            <%!-- Queue list --%>
            <div :if={@sidebar_tab == :queue} class="flex flex-col flex-1 min-h-0">
              <Components.queue_panel queue={@queue} current_index={@current_index} />
            </div>

            <%!-- History list --%>
            <div :if={@sidebar_tab == :history} class="flex flex-col flex-1 min-h-0">
              <Components.history_panel history={@history} />
            </div>
          </div>
        </div>

        <%!-- Activity log --%>
        <Components.activity_log activity_log={@activity_log} />

        <%!-- Users card — pinned at bottom --%>
        <Components.users_card
          users={@users}
          user_id={@user_id}
          editing_username={@editing_username}
          sync_clients={Map.get(@sync_stats || %{}, :clients, %{})}
        />
      </div>
    </div>
    """
  end

  # Private helpers

  defp ensure_room_pid(socket) do
    pid = socket.assigns[:room_pid]

    if pid && Process.alive?(pid) do
      # The GenServer is alive, but the room may still have us marked
      # as disconnected — a brief LV socket drop sets connected=false
      # and nothing else restores it. If we're a connected LV process
      # processing events, we ARE online; re-mark ourselves to keep
      # presence + ready-count accurate.
      maybe_restore_connected(pid, socket)
      socket
    else
      {:ok, new_pid} = RoomManager.ensure_room(socket.assigns.room_id)
      # Re-join the room with the new pid
      if socket.assigns[:user_id] do
        username = socket.assigns[:username] || "Guest"
        RoomServer.join(new_pid, socket.assigns.user_id, username)
        Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{socket.assigns.room_id}")
      end

      assign(socket, room_pid: new_pid)
    end
  end

  defp maybe_restore_connected(pid, socket) do
    user_id = socket.assigns[:user_id]
    username = socket.assigns[:username]

    if user_id && username do
      state = RoomServer.get_state(pid)

      case Map.get(state.users, user_id) do
        %{connected: false} ->
          # We were marked offline. Rejoin silently — skip the presence
          # toast since this is a reconnection, not a new arrival.
          RoomServer.join(pid, user_id, username, silent: true)

        nil ->
          # Not in the room's user map at all. Full re-join.
          RoomServer.join(pid, user_id, username)

        _ ->
          :ok
      end
    end
  end

  defp sync_state_payload(state, user_id) do
    %{
      user_id: user_id,
      queue: Enum.map(state.queue, &serialize_item/1),
      current_index: state.current_index,
      play_state: Atom.to_string(state.play_state),
      current_time: state.current_time,
      server_time: state.server_time,
      playback_rate: state.playback_rate
    }
  end

  def serialize_media_item(%{media_item: item, index: index} = data) do
    %{
      media_item: serialize_item(item),
      index: index,
      play_state: Map.get(data, :play_state, :playing) |> to_string()
    }
  end

  def serialize_item(%Byob.MediaItem{} = item) do
    %{
      id: item.id,
      url: item.url,
      source_type: Atom.to_string(item.source_type),
      source_id: item.source_id,
      title: item.title,
      thumbnail_url: item.thumbnail_url,
      is_live: Map.get(item, :is_live, false)
    }
  end

  def serialize_item(item) when is_map(item) do
    %{
      id: item[:id] || item["id"],
      url: item[:url] || item["url"],
      source_type: to_string(item[:source_type] || item["source_type"]),
      source_id: item[:source_id] || item["source_id"],
      title: item[:title] || item["title"],
      thumbnail_url: item[:thumbnail_url] || item["thumbnail_url"],
      is_live: item[:is_live] || item["is_live"] || false
    }
  end

  defp candidate_for_client(c) do
    %{
      external_id: c.external_id,
      title: c.title,
      thumbnail_url: c.thumbnail_url,
      source_type: to_string(c.source_type)
    }
  end
end
