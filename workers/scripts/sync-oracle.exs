# A batch oracle for the native port's differential tests. No application,
# database, network connection or dependency compilation is started here.
Logger.configure(level: :error)
Code.require_file("../../lib/byob/sync_decision.ex", __DIR__)

input = IO.read(:stdio, :eof) |> JSON.decode!()
fields = [:over_tolerance_count, :seek_streak, :last_seek_at, :learned_l_ms]

results =
  Enum.map(input, fn entry ->
    state =
      Enum.reduce(fields, Byob.SyncDecision.new(), fn key, state ->
        Map.put(state, key, Map.fetch!(entry["state"], Atom.to_string(key)))
      end)

    data =
      Map.new([:drift_ms, :noise_floor_ms, :rtt_ms, :observed_l_ms], fn key ->
        {key, Map.get(entry["data"], Atom.to_string(key))}
      end)

    room = %{
      expected_position: entry["room"]["expected_position"],
      room_jitter_ms: entry["room"]["room_jitter_ms"]
    }

    now = entry["now"]

    {seek, updated} =
      case Byob.SyncDecision.evaluate(state, data, room, now) do
        {:no_seek, updated} -> {nil, updated}
        {:seek, seek, updated} -> {seek, updated}
      end

    %{
      result: %{seek: seek, state: Map.from_struct(updated)},
      tolerance: Byob.SyncDecision.tolerance_ms(data, room, state, now),
      cooldown: Byob.SyncDecision.cooldown_remaining_ms(state, now),
      reset: Byob.SyncDecision.reset_for_new_video(state) |> Map.from_struct()
    }
  end)

IO.write(JSON.encode!(results))
