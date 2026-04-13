defmodule ByobWeb.Plugs.ApiAuth do
  @moduledoc """
  Authenticates API requests by verifying the api_key matches the room's key.

  Extracts token from `Authorization: Bearer <token>` header or `api_key` query param.
  Looks up the room by `:id` path param and verifies the token.
  Sets `:room_id`, `:room_pid`, and `:api_key` in conn assigns.
  """
  import Plug.Conn

  def init(opts), do: opts

  def call(conn, _opts) do
    with {:ok, token} <- extract_token(conn),
         {:ok, room_id} <- extract_room_id(conn),
         {:ok, pid} <- Byob.RoomManager.ensure_room(room_id),
         :ok <- verify_token(pid, token) do
      conn
      |> assign(:room_id, room_id)
      |> assign(:room_pid, pid)
      |> assign(:api_key, token)
    else
      {:error, reason} ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(401, Jason.encode!(%{error: reason}))
        |> halt()
    end
  end

  defp extract_token(conn) do
    case get_req_header(conn, "authorization") do
      ["Bearer " <> token] ->
        {:ok, String.trim(token)}

      _ ->
        case conn.query_params do
          %{"api_key" => key} when key != "" -> {:ok, key}
          _ -> {:error, "Missing API key. Provide Authorization: Bearer <token> header or api_key query param."}
        end
    end
  end

  defp extract_room_id(conn) do
    case conn.path_params do
      %{"id" => id} when id != "" -> {:ok, id}
      _ -> {:error, "Missing room ID in path."}
    end
  end

  defp verify_token(pid, token) do
    case Byob.RoomServer.get_api_key(pid) do
      ^token -> :ok
      _ -> {:error, "Invalid API key for this room."}
    end
  end
end
