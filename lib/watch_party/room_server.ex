defmodule WatchParty.RoomServer do
  use GenServer

  defstruct [
    :room_id,
    :host_id,
    :cleanup_ref,
    :empty_timeout,
    users: %{},
    queue: [],
    current_index: nil,
    play_state: :paused,
    current_time: 0.0,
    last_sync_at: 0,
    playback_rate: 1.0
  ]

  # Client API

  def start_link(opts) do
    room_id = Keyword.fetch!(opts, :room_id)
    name = {:via, Registry, {WatchParty.RoomRegistry, room_id}}
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def join(pid, user_id, username) do
    GenServer.call(pid, {:join, user_id, username})
  end

  def leave(pid, user_id) do
    GenServer.call(pid, {:leave, user_id})
  end

  def get_state(pid) do
    GenServer.call(pid, :get_state)
  end

  # Server callbacks

  @impl true
  def init(opts) do
    room_id = Keyword.fetch!(opts, :room_id)
    empty_timeout = Keyword.get(opts, :empty_timeout, :timer.minutes(5))

    state = %__MODULE__{
      room_id: room_id,
      empty_timeout: empty_timeout,
      last_sync_at: System.monotonic_time(:millisecond)
    }

    # Start cleanup timer since room starts empty
    {:ok, schedule_cleanup(state)}
  end

  @impl true
  def handle_call({:join, user_id, username}, _from, state) do
    state =
      state
      |> cancel_cleanup()
      |> put_in([Access.key(:users), user_id], %{
        username: username,
        joined_at: System.monotonic_time(:millisecond)
      })
      |> maybe_set_host(user_id)

    broadcast(state, {:users_updated, state.users})
    {:reply, {:ok, snapshot(state)}, state}
  end

  def handle_call({:leave, user_id}, _from, state) do
    state = %{state | users: Map.delete(state.users, user_id)}

    state =
      if map_size(state.users) == 0 do
        schedule_cleanup(state)
      else
        broadcast(state, {:users_updated, state.users})
        state
      end

    {:reply, :ok, state}
  end

  def handle_call(:get_state, _from, state) do
    {:reply, snapshot(state), state}
  end

  @impl true
  def handle_info(:check_empty, state) do
    if map_size(state.users) == 0 do
      {:stop, :normal, state}
    else
      {:noreply, state}
    end
  end

  # Private helpers

  defp current_position(%{play_state: :playing} = state) do
    elapsed = (System.monotonic_time(:millisecond) - state.last_sync_at) / 1000
    state.current_time + elapsed
  end

  defp current_position(state), do: state.current_time

  defp snapshot(state) do
    %{
      room_id: state.room_id,
      users: state.users,
      queue: state.queue,
      current_index: state.current_index,
      play_state: state.play_state,
      current_time: current_position(state),
      server_time: System.monotonic_time(:millisecond),
      playback_rate: state.playback_rate
    }
  end

  defp schedule_cleanup(state) do
    ref = Process.send_after(self(), :check_empty, state.empty_timeout)
    %{state | cleanup_ref: ref}
  end

  defp cancel_cleanup(%{cleanup_ref: nil} = state), do: state

  defp cancel_cleanup(%{cleanup_ref: ref} = state) do
    Process.cancel_timer(ref)
    %{state | cleanup_ref: nil}
  end

  defp maybe_set_host(%{host_id: nil} = state, user_id), do: %{state | host_id: user_id}
  defp maybe_set_host(state, _user_id), do: state

  defp broadcast(state, message) do
    Phoenix.PubSub.broadcast(WatchParty.PubSub, "room:#{state.room_id}", message)
  end
end
