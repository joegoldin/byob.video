defmodule ByobWeb.RoomLive.Username do
  @moduledoc """
  Handles username editing event handlers extracted from RoomLive.

  Covers: username:edit, username:cancel, username:change.
  """

  import Phoenix.Component, only: [assign: 2]
  import Phoenix.LiveView, only: [push_event: 3]

  alias Byob.RoomServer

  def handle_edit(_params, socket) do
    {:noreply, assign(socket, editing_username: true)}
  end

  def handle_cancel(_params, socket) do
    {:noreply, assign(socket, editing_username: false)}
  end

  def handle_change(%{"username" => new_username}, socket) do
    new_username = String.trim(new_username)

    state = RoomServer.get_state(socket.assigns.room_pid)
    name_taken = Enum.any?(state.users, fn {uid, u} ->
      u.username == new_username && !is_self_user(uid, socket.assigns.user_id)
    end)

    if new_username != "" and String.length(new_username) <= 30 and not name_taken do
      # Rename this tab's user
      RoomServer.rename_user(socket.assigns.room_pid, socket.assigns.user_id, new_username)
      # Also rename other tabs of the same user
      [base | _] = String.split(socket.assigns.user_id, ":", parts: 2)
      state = RoomServer.get_state(socket.assigns.room_pid)
      for {uid, _} <- state.users, uid != socket.assigns.user_id, String.starts_with?(uid, base <> ":") do
        RoomServer.rename_user(socket.assigns.room_pid, uid, new_username)
      end

      socket =
        socket
        |> assign(username: new_username, editing_username: false)
        |> push_event("store-username", %{username: new_username})

      {:noreply, socket}
    else
      {:noreply, assign(socket, editing_username: false)}
    end
  end

  defp is_self_user(uid, my_user_id) do
    # user_ids are "session_id:tab_id" — same session = same person
    [my_base | _] = String.split(my_user_id, ":", parts: 2)
    String.starts_with?(uid, my_base <> ":")
  end
end
