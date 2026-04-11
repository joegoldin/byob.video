defmodule Byob.RoomManager do
  alias Byob.RoomServer

  @alphabet "0123456789abcdefghijklmnopqrstuvwxyz"

  def create_room do
    count = try do Byob.Persistence.room_count() rescue _ -> 0 catch :exit, _ -> 0 end

    if count >= Byob.Persistence.max_rooms() do
      {:error, :max_capacity}
    else
      room_id = Nanoid.generate(8, @alphabet)
      {:ok, _pid} = ensure_room(room_id)
      {:ok, room_id}
    end
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
