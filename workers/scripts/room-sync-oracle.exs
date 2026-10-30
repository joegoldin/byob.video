# Execute the real room sync handlers without starting Phoenix or timers.
# Only time, timer registration and PubSub delivery are replaced by test seams.
Logger.configure(level: :error)
Code.require_file("../../lib/byob/sync_decision.ex", __DIR__)
source = File.read!(Path.expand("../../lib/byob/room_server.ex", __DIR__))
{:defmodule, _, [_, [do: {:__block__, _, definitions}]]} = Code.string_to_quoted!(source)

helpers = [
  :current_position,
  :clamp_to_duration,
  :current_item_duration,
  :user_hidden?,
  :current_media_is_live?,
  :clock_adjust_target,
  :run_sync_decision,
  :maybe_finish_ready_check,
  :current_media_id,
  :current_media_item,
  :visible_connected_user_ids
]

attributes = [
  :drift_sample_stale_ms,
  :user_seek_clock_freeze_ms,
  :clock_adjust_min_drift_ms,
  :clock_adjust_max_per_pass_ms
]

selected =
  Enum.filter(definitions, fn
    {:@, _, [{name, _, _}]} ->
      name in attributes

    {:defp, _, [{name, _, _} | _]} ->
      name in helpers

    {:def, _, [head | _]} ->
      text = Macro.to_string(head)

      String.starts_with?(text, "handle_info({:sync_client_stats,") or
        String.starts_with?(text, "handle_info(:adjust_room_clock,")

    _ ->
      false
  end)

selected =
  Macro.prewalk(selected, fn
    {{:., _, [{:__aliases__, _, [:System]}, :monotonic_time]}, _, [:millisecond]} ->
      quote(do: Process.get(:oracle_now))

    {{:., _, [{:__aliases__, _, [:Process]}, :send_after]}, _, _} ->
      nil

    node ->
      node
  end)

Code.compile_quoted(
  quote do
    defmodule RoomSyncOracle do
      unquote_splicing(selected)

      defp broadcast(_state, event),
        do: Process.put(:oracle_events, [event | Process.get(:oracle_events, [])])

      def run(action, state, now) do
        Process.put(:oracle_now, now)
        Process.put(:oracle_events, [])
        {:noreply, next} = handle_info(action, Map.put(state, :clock_adjust_ref, nil))

        %{
          state: Map.delete(next, :clock_adjust_ref),
          events: Enum.reverse(Process.get(:oracle_events))
        }
      end

      # Observe the original quorum decision without scheduling or cancelling timers.
      defp finish_ready_check(state, _reason), do: %{state | play_state: :playing}
      def ready?(state), do: maybe_finish_ready_check(state).play_state == :playing

      def position(state, now) do
        Process.put(:oracle_now, now)
        current_position(state)
      end
    end
  end
)

defmodule RoomSyncOracleJSON do
  @keys Map.new(
          [
            :room_id,
            :id,
            :media_loaded_for,
            :users,
            :hidden,
            :connected,
            :queue,
            :current_index,
            :duration,
            :is_live,
            :current_time,
            :last_sync_at,
            :playback_rate,
            :play_state,
            :drift_samples,
            :drift_ms,
            :updated_at,
            :noise_floor_ms,
            :rtt_ms,
            :observed_l_ms,
            :user_sync_states,
            :over_tolerance_count,
            :seek_streak,
            :last_seek_at,
            :learned_l_ms,
            :last_user_seek_at_global,
            :user_id
          ],
          fn key -> {Atom.to_string(key), key} end
        )
  def decode(value) when is_map(value) do
    Map.new(value, fn {key, value} ->
      value =
        case {key, value} do
          {"play_state", "playing"} -> :playing
          {"play_state", "paused"} -> :paused
          _ -> decode(value)
        end

      {Map.get(@keys, key, key), value}
    end)
  end

  def decode(value) when is_list(value), do: Enum.map(value, &decode/1)
  def decode(value), do: value
  def encode(%Byob.SyncDecision{} = value), do: value |> Map.from_struct() |> encode()

  def encode(value) when is_map(value),
    do: Map.new(value, fn {key, value} -> {key, encode(value)} end)

  def encode(value) when is_tuple(value), do: value |> Tuple.to_list() |> encode()
  def encode(value) when is_list(value), do: Enum.map(value, &encode/1)
  def encode(value), do: value
end

results =
  IO.read(:stdio, :eof)
  |> JSON.decode!()
  |> Enum.map(fn entry ->
    state = RoomSyncOracleJSON.decode(entry["state"])

    case entry["action"] do
      "ready" ->
        RoomSyncOracle.ready?(state)

      "position" ->
        RoomSyncOracle.position(state, entry["now"])

      "adjust" ->
        RoomSyncOracle.run(:adjust_room_clock, state, entry["now"])

      "drift" ->
        RoomSyncOracle.run(
          {:sync_client_stats, RoomSyncOracleJSON.decode(entry["data"])},
          state,
          entry["now"]
        )
    end
  end)

IO.write(JSON.encode!(RoomSyncOracleJSON.encode(results)))
