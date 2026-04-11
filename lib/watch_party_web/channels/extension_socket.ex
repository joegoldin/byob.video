defmodule WatchPartyWeb.ExtensionSocket do
  use Phoenix.Socket

  channel "extension:*", WatchPartyWeb.ExtensionChannel

  @impl true
  def connect(_params, socket, _connect_info) do
    user_id = generate_id()
    {:ok, assign(socket, :user_id, user_id)}
  end

  @impl true
  def id(socket), do: "extension:#{socket.assigns.user_id}"

  defp generate_id do
    :crypto.strong_rand_bytes(16) |> Base.url_encode64(padding: false)
  end
end
