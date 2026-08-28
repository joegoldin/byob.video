defmodule Byob.RoomManager do
  alias Byob.RoomServer

  @alphabet "0123456789abcdefghijklmnopqrstuvwxyz"

  def create_room do
    if at_capacity?() and reap_idlest_room() == :none do
      {:error, :max_capacity}
    else
      room_id = Nanoid.generate(8, @alphabet)
      {:ok, pid} = ensure_room(room_id)
      api_key = RoomServer.get_api_key(pid)
      {:ok, room_id, api_key}
    end
  end

  defp at_capacity? do
    active_room_count() >= Byob.Persistence.max_rooms()
  end

  @doc """
  Stop the room that has been empty the longest, freeing a capacity slot.
  Rooms hold their process for hours after the last user leaves so a
  Discord invite can be clicked late; at capacity that courtesy has to
  yield to someone actually asking for a room. Stopping is lossless —
  the room persists on terminate and `ensure_room/1` reloads it (queue,
  history, api_key intact) if anyone comes back.

  Returns `:none` when every live room still has a connected user.
  """
  def reap_idlest_room do
    idlest =
      Byob.RoomSupervisor
      |> DynamicSupervisor.which_children()
      |> Enum.filter(fn {_, pid, _, _} -> is_pid(pid) end)
      |> Enum.map(fn {_, pid, _, _} -> {pid, RoomServer.idle_ms_left(pid)} end)
      |> Enum.reject(fn {_pid, ms_left} -> is_nil(ms_left) end)
      |> Enum.min_by(fn {_pid, ms_left} -> ms_left end, fn -> nil end)

    case idlest do
      nil ->
        :none

      {pid, _ms_left} ->
        # :normal so the :transient child spec leaves it stopped, and via
        # GenServer.stop so terminate/2 runs and persists first.
        try do
          GenServer.stop(pid, :normal, 5_000)
          :ok
        catch
          :exit, _ -> :ok
        end
    end
  catch
    # Supervisor mid-restart (deploy): no slot to free right now.
    :exit, _ -> :none
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
