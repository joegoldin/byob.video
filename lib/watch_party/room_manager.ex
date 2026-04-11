defmodule WatchParty.RoomManager do
  alias WatchParty.RoomServer

  @alphabet "0123456789abcdefghijklmnopqrstuvwxyz"

  def create_room do
    room_id = Nanoid.generate(8, @alphabet)
    {:ok, _pid} = ensure_room(room_id)
    {:ok, room_id}
  end

  def ensure_room(room_id) do
    case Registry.lookup(WatchParty.RoomRegistry, room_id) do
      [{pid, _}] ->
        {:ok, pid}

      [] ->
        case DynamicSupervisor.start_child(
               WatchParty.RoomSupervisor,
               {RoomServer, room_id: room_id}
             ) do
          {:ok, pid} -> {:ok, pid}
          {:error, {:already_started, pid}} -> {:ok, pid}
        end
    end
  end
end
