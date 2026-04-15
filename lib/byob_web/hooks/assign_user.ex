defmodule ByobWeb.Hooks.AssignUser do
  import Phoenix.Component

  def on_mount(:default, _params, session, socket) do
    user_id = session["user_id"]
    username = session["username"]

    user_id =
      user_id || "anon:#{:crypto.strong_rand_bytes(8) |> Base.url_encode64(padding: false)}"

    username = username || "Guest"
    {:cont, assign(socket, user_id: user_id, username: username)}
  end
end
