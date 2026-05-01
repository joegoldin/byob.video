defmodule Byob.Events do
  @moduledoc """
  Named constants for every cross-boundary event string.

  Channel `handle_in/3` patterns require compile-time strings — callers alias
  this module and bind module attributes:

      alias Byob.Events
      @in_video_play Events.in_video_play()
      def handle_in(@in_video_play, payload, socket), do: ...

  Naming convention mirrors flow direction:
    * `in_*`  — events the server receives (extension channel `handle_in`)
    * `sync_*`, `autoplay_*`, `queue_*`, … — events the server pushes or the
      LV broadcasts via `push_event` (wire name is whatever the function
      returns)
    * `presence_*` — value strings inside `{:room_presence, %{event: ...}}`
  """

  # ── Channel IN (extension → server) ────────────────────────────────────
  def in_video_play, do: "video:play"
  def in_video_pause, do: "video:pause"
  def in_video_seek, do: "video:seek"
  def in_video_ended, do: "video:ended"
  def in_video_all_closed, do: "video:all_closed"
  def in_video_state, do: "video:state"
  def in_video_media_info, do: "video:media_info"
  def in_video_tab_opened, do: "video:tab_opened"
  def in_video_tab_closed, do: "video:tab_closed"
  def in_video_ready, do: "video:ready"
  def in_video_unready, do: "video:unready"
  def in_video_drift, do: "video:drift"
  def in_video_live_status, do: "video:live_status"
  def in_sync_ping, do: "sync:ping"
  def in_sync_request_state, do: "sync:request_state"
  def in_debug_log, do: "debug:log"
  def in_video_update_url, do: "video:update_url"

  # ── Channel OUT & LV push_event (server → client) ──────────────────────
  def sync_state, do: "sync:state"
  def sync_play, do: "sync:play"
  def sync_pause, do: "sync:pause"
  def sync_seek, do: "sync:seek"
  def sync_correction, do: "sync:correction"
  def sync_heartbeat, do: "sync:heartbeat"
  def sync_pong, do: "sync:pong"
  def sync_autoplay_countdown, do: "sync:autoplay_countdown"
  def sync_autoplay_cancelled, do: "sync:autoplay_cancelled"
  def autoplay_countdown, do: "autoplay:countdown"
  def autoplay_cancelled, do: "autoplay:cancelled"
  def ready_count, do: "ready:count"
  def room_presence, do: "room:presence"
  def queue_updated, do: "queue:updated"
  def queue_ended, do: "queue:ended"
  def video_change, do: "video:change"
  def toast, do: "toast"
  def ext_media_info, do: "ext:media-info"
  def ext_player_state, do: "ext:player-state"
  def media_metadata, do: "media:metadata"
  def sponsor_segments, do: "sponsor:segments"
  def sb_settings, do: "sb:settings"
  def live_status, do: "live:status"
  def notify, do: "notify"
  def sync_client_stats, do: "sync:client_stats"
  def sync_room_tolerance, do: "sync:room_tolerance"

  # ── LV handle_event (browser VideoPlayer → LiveView) ────────────────────
  def ev_video_play, do: "video:play"
  def ev_video_pause, do: "video:pause"
  def ev_video_seek, do: "video:seek"
  def ev_video_ended, do: "video:ended"
  def ev_video_drift_report, do: "video:drift_report"
  def ev_video_embed_blocked, do: "video:embed_blocked"
  def ev_video_live_status, do: "video:live_status"

  # ── Presence event strings (inside room_presence payloads) ──────────────
  def presence_joined, do: "joined"
  def presence_left, do: "left"
  def presence_ext_closed, do: "ext_closed"
end
