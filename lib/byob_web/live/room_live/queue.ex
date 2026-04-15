defmodule ByobWeb.RoomLive.Queue do
  @moduledoc """
  Handles queue/history/tab/SponsorBlock event handlers extracted from RoomLive.

  Covers: history:play, queue:readd, queue:skip, queue:remove, queue:play_index,
  queue:reorder, video:restart, switch_tab, and sb:update.
  """

  import Phoenix.Component, only: [assign: 2]

  alias Byob.RoomServer

  def handle_history_play(%{"url" => url}, socket) do
    RoomServer.add_to_queue(socket.assigns.room_pid, socket.assigns.user_id, url, :now)
    {:noreply, socket}
  end

  def handle_readd(%{"url" => url}, socket) do
    RoomServer.add_to_queue(socket.assigns.room_pid, socket.assigns.user_id, url, :queue)
    {:noreply, socket}
  end

  def handle_restart(_params, socket) do
    RoomServer.seek(socket.assigns.room_pid, socket.assigns.user_id, 0.0)
    {:noreply, socket}
  end

  def handle_skip(_params, socket) do
    RoomServer.skip(socket.assigns.room_pid)
    {:noreply, socket}
  end

  def handle_remove(%{"item_id" => item_id}, socket) do
    RoomServer.remove_from_queue(socket.assigns.room_pid, item_id)
    {:noreply, socket}
  end

  def handle_play_index(%{"index" => index}, socket) do
    RoomServer.play_index(
      socket.assigns.room_pid,
      String.to_integer(index),
      socket.assigns.user_id
    )

    {:noreply, socket}
  end

  def handle_reorder(%{"from" => from, "to" => to}, socket) do
    RoomServer.reorder_queue(
      socket.assigns.room_pid,
      String.to_integer(from),
      String.to_integer(to)
    )

    {:noreply, socket}
  end

  def handle_switch_tab(%{"tab" => tab}, socket) do
    {:noreply, assign(socket, sidebar_tab: String.to_existing_atom(tab))}
  end

  def handle_sb_update(%{"category" => category, "action" => action}, socket) do
    RoomServer.update_sb_settings(socket.assigns.room_pid, category, action)
    {:noreply, socket}
  end
end
