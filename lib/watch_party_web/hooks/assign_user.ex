defmodule WatchPartyWeb.Hooks.AssignUser do
  import Phoenix.Component

  def on_mount(:default, _params, session, socket) do
    user_id = session["user_id"]
    username = session["username"]

    if user_id do
      {:cont, assign(socket, user_id: user_id, username: username)}
    else
      {:cont, socket}
    end
  end
end
