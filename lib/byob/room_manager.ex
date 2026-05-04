defmodule Byob.RoomManager do
  alias Byob.RoomServer

  @alphabet "0123456789abcdefghijklmnopqrstuvwxyz"

  def create_room do
    if active_room_count() >= Byob.Persistence.max_rooms() do
      {:error, :max_capacity}
    else
      room_id = Nanoid.generate(8, @alphabet)
      {:ok, pid} = ensure_room(room_id)
      api_key = RoomServer.get_api_key(pid)
      {:ok, room_id, api_key}
    end
  end

  @doc """
  Number of LIVE rooms — registered GenServer processes. The capacity
  limit gates concurrent server resources (each room is one process
  with its own state, timers, PubSub subscription); idle rooms that
  ended their empty-timeout exit cleanly and stop counting against it
  even though their last-state snapshot lingers in SQLite for the
  history feature.
  """
  def active_room_count do
    DynamicSupervisor.count_children(Byob.RoomSupervisor)
    |> Map.get(:active, 0)
  rescue
    _ -> 0
  catch
    :exit, _ -> 0
  end

  def ensure_room(room_id) do
    case Registry.lookup(Byob.RoomRegistry, room_id) do
      [{pid, _}] ->
        {:ok, pid}

      [] ->
        case DynamicSupervisor.start_child(
               Byob.RoomSupervisor,
               {RoomServer, room_id: room_id}
             ) do
          {:ok, pid} -> {:ok, pid}
          {:error, {:already_started, pid}} -> {:ok, pid}
        end
    end
  end
end
