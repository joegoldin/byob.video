defmodule Byob.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    :ets.new(:youtube_comments_cache, [:named_table, :public, :set])
    :ets.new(:youtube_videos_cache, [:named_table, :public, :set])

    children = [
      ByobWeb.Telemetry,
      {DNSCluster, query: Application.get_env(:byob, :dns_cluster_query) || :ignore},
      {Phoenix.PubSub, name: Byob.PubSub},
      {Registry, keys: :unique, name: Byob.RoomRegistry},
      {DynamicSupervisor, name: Byob.RoomSupervisor, strategy: :one_for_one},
      Byob.Persistence,
      {Byob.Pool.Scheduler, auto_start: start_pool_scheduler?()},
      ByobWeb.Endpoint
    ]

    # See https://hexdocs.pm/elixir/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: Byob.Supervisor]
    Supervisor.start_link(children, opts)
  end

  # Tell Phoenix to update the endpoint configuration
  # whenever the application is updated.
  @impl true
  def config_change(changed, _new, removed) do
    ByobWeb.Endpoint.config_change(changed, removed)
    :ok
  end

  # Don't run background scrapers under `mix test` — each test would then
  # fight the scheduler for the shared DB connection. Controlled by
  # application config set in config/test.exs.
  defp start_pool_scheduler? do
    Application.get_env(:byob, :start_pool_scheduler, true)
  end
end
