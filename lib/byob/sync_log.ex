defmodule Byob.SyncLog do
  @moduledoc """
  Structured sync logging with privacy-safe defaults.
  Video URLs are SHA-256 hashed (12-char hex prefix). User IDs are
  random UUIDs (session:tab) — no PII. Never logs titles, usernames,
  or chat.
  """
  require Logger

  def hash_url(nil), do: "none"

  def hash_url(url) when is_binary(url) do
    :crypto.hash(:sha256, url)
    |> Base.encode16(case: :lower)
    |> binary_part(0, 12)
  end

  def play(room_id, user_id, url, position, transition) do
    Logger.info(
      "[sync:play] room=#{room_id} user=#{user_id} video=#{hash_url(url)} pos=#{fmt_pos(position)} #{transition}"
    )
  end

  def pause(room_id, user_id, url, position, transition) do
    Logger.info(
      "[sync:pause] room=#{room_id} user=#{user_id} video=#{hash_url(url)} pos=#{fmt_pos(position)} #{transition}"
    )
  end

  def seek(room_id, user_id, url, position) do
    Logger.info(
      "[sync:seek] room=#{room_id} user=#{user_id} video=#{hash_url(url)} pos=#{fmt_pos(position)}"
    )
  end

  def join(room_id, user_id, user_count) do
    Logger.info("[sync:join] room=#{room_id} user=#{user_id} users=#{user_count}")
  end

  def leave(room_id, user_id) do
    Logger.info("[sync:leave] room=#{room_id} user=#{user_id}")
  end

  def snapshot(room_id, user_id, play_state, position) do
    Logger.info(
      "[sync:snapshot] room=#{room_id} user=#{user_id} state=#{play_state} pos=#{fmt_pos(position)}"
    )
  end

  def ext_join(room_id, user_id) do
    Logger.info("[sync:ext_join] room=#{room_id} user=#{user_id}")
  end

  def ext_event(room_id, event, user_id) do
    Logger.info("[sync:ext:#{event}] room=#{room_id} user=#{user_id}")
  end

  def heartbeat(room_id, play_state, position) do
    Logger.debug(
      "[sync:heartbeat] room=#{room_id} state=#{play_state} pos=#{fmt_pos(position)}"
    )
  end

  def redundant(room_id, event, user_id) do
    Logger.debug("[sync:redundant] room=#{room_id} event=#{event} user=#{user_id}")
  end

  defp fmt_pos(pos) when is_float(pos), do: Float.round(pos, 1)
  defp fmt_pos(pos) when is_integer(pos), do: pos
  defp fmt_pos(_), do: "?"
end
