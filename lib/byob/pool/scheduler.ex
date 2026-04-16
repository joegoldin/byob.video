defmodule Byob.Pool.Scheduler do
  @moduledoc """
  Periodically scrapes Trending + Subreddit sources (hourly) and Curated
  playlists (daily). Each scrape fans out via `Task.async_stream/3` with
  a 60s timeout per source so one slow/failing source can't block the
  others.

  Both ticks use ±10-20 min jitter so a fly restart doesn't pile all
  scrapers onto the same wallclock instant.
  """

  use GenServer
  require Logger

  alias Byob.Pool
  alias Byob.Pool.Sources.{Trending, Subreddit, Curated}

  @hourly_base_ms :timer.minutes(60)
  @hourly_jitter_ms :timer.minutes(10)
  @daily_base_ms :timer.hours(24)
  @daily_jitter_ms :timer.hours(2)

  @cold_start_hourly_ms :timer.seconds(60)
  @cold_start_daily_ms :timer.minutes(5)

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "Force an immediate hourly scrape (mostly for dev/testing)."
  def scrape_now(:hourly), do: send(__MODULE__, :hourly_tick)
  def scrape_now(:daily), do: send(__MODULE__, :daily_tick)

  @impl true
  def init(opts) do
    auto_start = Keyword.get(opts, :auto_start, true)

    if auto_start do
      Process.send_after(self(), :hourly_tick, @cold_start_hourly_ms)
      Process.send_after(self(), :daily_tick, @cold_start_daily_ms)
    end

    {:ok, %{}}
  end

  @impl true
  def handle_info(:hourly_tick, state) do
    run_hourly()
    Process.send_after(self(), :hourly_tick, next_delay(@hourly_base_ms, @hourly_jitter_ms))
    {:noreply, state}
  end

  def handle_info(:daily_tick, state) do
    run_daily()
    Process.send_after(self(), :daily_tick, next_delay(@daily_base_ms, @daily_jitter_ms))
    {:noreply, state}
  end

  # Late/stray messages from a completed Task.async_stream timeout are sent
  # to the GenServer; ignore rather than crash.
  def handle_info({ref, _result}, state) when is_reference(ref) do
    Process.demonitor(ref, [:flush])
    {:noreply, state}
  end

  def handle_info({:DOWN, _ref, :process, _pid, _reason}, state) do
    {:noreply, state}
  end

  # --- scrape runs ---

  defp run_hourly do
    Logger.info("[pool/scheduler] hourly tick start")

    results =
      [Trending, Subreddit]
      |> Task.async_stream(
        fn mod -> safe_fetch_and_upsert(mod) end,
        timeout: 60_000,
        on_timeout: :kill_task
      )
      |> Enum.to_list()

    summary =
      results
      |> Enum.map(fn
        {:ok, {mod, count}} -> "#{inspect(mod)}=#{count}"
        {:exit, reason} -> "exit=#{inspect(reason)}"
      end)
      |> Enum.join(" ")

    counts = Byob.Persistence.pool_counts_by_source()
    Logger.info("[pool/scheduler] hourly done: #{summary}; pool sizes: #{inspect(counts)}")
  end

  defp run_daily do
    Logger.info("[pool/scheduler] daily tick start")
    {mod, count} = safe_fetch_and_upsert(Curated)
    Logger.info("[pool/scheduler] daily done: #{inspect(mod)}=#{count}")
  end

  defp safe_fetch_and_upsert(mod) do
    entries =
      try do
        mod.fetch()
      rescue
        e ->
          Logger.warning("[pool/scheduler] #{inspect(mod)} raised: #{Exception.message(e)}")
          []
      end

    case Pool.upsert(entries) do
      {:ok, n} -> {mod, n}
      _ -> {mod, 0}
    end
  end

  defp next_delay(base, jitter) do
    base + :rand.uniform(jitter) - div(jitter, 2)
  end
end
