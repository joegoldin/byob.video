defmodule ByobWeb.Plugs.RateLimit do
  @moduledoc """
  ETS-based sliding window rate limiter plug.

  Options:
    - `:limit` — max requests in window (required)
    - `:window` — window size in seconds (default 60)
    - `:by` — `:ip` or `:api_key` (default `:ip`)
  """
  import Plug.Conn

  def init(opts) do
    %{
      limit: Keyword.fetch!(opts, :limit),
      window: Keyword.get(opts, :window, 60),
      by: Keyword.get(opts, :by, :ip)
    }
  end

  def call(conn, %{limit: limit, window: window, by: by}) do
    ensure_table()

    key = rate_limit_key(conn, by)
    now = System.monotonic_time(:second)
    cutoff = now - window

    # Clean old entries and insert new one
    :ets.select_delete(:byob_rate_limit, [{{key, :"$1"}, [{:<, :"$1", cutoff}], [true]}])
    :ets.insert(:byob_rate_limit, {key, now})

    count = :ets.select_count(:byob_rate_limit, [{{key, :"$1"}, [{:>=, :"$1", cutoff}], [true]}])

    if count > limit do
      conn
      |> put_resp_header("retry-after", Integer.to_string(window))
      |> put_resp_content_type("application/json")
      |> send_resp(
        429,
        Jason.encode!(%{error: "Rate limit exceeded. Try again in #{window} seconds."})
      )
      |> halt()
    else
      conn
    end
  end

  defp rate_limit_key(conn, :ip) do
    ip =
      conn.remote_ip
      |> Tuple.to_list()
      |> Enum.join(".")

    {:ip, ip}
  end

  defp rate_limit_key(conn, :api_key) do
    {:api_key, conn.assigns[:api_key] || "unknown"}
  end

  defp ensure_table do
    case :ets.whereis(:byob_rate_limit) do
      :undefined ->
        :ets.new(:byob_rate_limit, [:named_table, :public, :duplicate_bag])

      _ ->
        :ok
    end
  end
end
