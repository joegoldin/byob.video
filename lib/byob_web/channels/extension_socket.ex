defmodule ByobWeb.ExtensionSocket do
  use Phoenix.Socket

  channel "extension:*", ByobWeb.ExtensionChannel

  @impl true
  def connect(%{"token" => token}, socket, _connect_info) do
    case Phoenix.Token.verify(ByobWeb.Endpoint, "extension", token, max_age: 86400) do
      {:ok, room_id} ->
        user_id = generate_id()
        {:ok, socket |> assign(:user_id, user_id) |> assign(:authorized_room, room_id)}

      {:error, _} ->
        :error
    end
  end

  def connect(_params, socket, _connect_info) do
    # Allow unauthenticated connections for backwards compat, but mark as unauthorized
    user_id = generate_id()
    {:ok, assign(socket, :user_id, user_id)}
  end

  @impl true
  def id(socket), do: "extension:#{socket.assigns.user_id}"

  defp generate_id do
    :crypto.strong_rand_bytes(16) |> Base.url_encode64(padding: false)
  end

  @doc "Generate a signed token for extension socket auth"
  def generate_token(room_id) do
    Phoenix.Token.sign(ByobWeb.Endpoint, "extension", room_id)
  end
end
