defmodule ByobWeb.ExtensionSocket do
  use Phoenix.Socket

  channel "extension:*", ByobWeb.ExtensionChannel

  @impl true
  def connect(%{"token" => token}, socket, _connect_info) do
    case Phoenix.Token.verify(ByobWeb.Endpoint, "extension", token, max_age: 86400) do
      # New token format: {room_id, owner_user_id}. Extension's user_id
      # is derived deterministically from the byob session's user_id so
      # the extension peer is provably the same human's session — no
      # username-as-identity dependence, survives renames, can be
      # linked to the LV peer for activity-log dedup / ready_count.
      {:ok, {room_id, owner_user_id}} when is_binary(owner_user_id) ->
        user_id = "ext:" <> owner_user_id

        {:ok,
         socket
         |> assign(:user_id, user_id)
         |> assign(:owner_user_id, owner_user_id)
         |> assign(:authorized_room, room_id)}

      # Legacy token format: room_id only. Falls back to a random
      # user_id (the old behavior). Old extension builds will keep
      # working until the user updates.
      {:ok, room_id} when is_binary(room_id) ->
        user_id = generate_id()

        {:ok,
         socket
         |> assign(:user_id, user_id)
         |> assign(:owner_user_id, nil)
         |> assign(:authorized_room, room_id)}

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

  @doc """
  Generate a signed token for extension socket auth.

  Pass the byob session's user_id so the extension's user_id can be
  derived deterministically on connect. Older callers can still pass
  just `room_id`; the extension will fall back to a random user_id.
  """
  def generate_token(room_id, owner_user_id \\ nil) do
    payload =
      if is_binary(owner_user_id), do: {room_id, owner_user_id}, else: room_id

    Phoenix.Token.sign(ByobWeb.Endpoint, "extension", payload)
  end
end
