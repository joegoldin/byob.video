defmodule ByobWeb.Router do
  use ByobWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {ByobWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug ByobWeb.Plugs.SessionIdentity
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  pipeline :api_public_create do
    plug ByobWeb.Plugs.RateLimit, limit: 5, window: 60, by: :ip
  end

  pipeline :api_public_docs do
    plug ByobWeb.Plugs.RateLimit, limit: 30, window: 60, by: :ip
  end

  pipeline :api_auth_read do
    plug ByobWeb.Plugs.ApiAuth
    plug ByobWeb.Plugs.RateLimit, limit: 60, window: 60, by: :api_key
  end

  pipeline :api_auth_mutate do
    plug ByobWeb.Plugs.ApiAuth
    plug ByobWeb.Plugs.RateLimit, limit: 20, window: 60, by: :api_key
  end

  # Health check for Fly.io (excluded from force_ssl)
  get "/health", ByobWeb.HealthController, :index

  scope "/", ByobWeb do
    pipe_through :browser

    live_session :default, on_mount: [ByobWeb.Hooks.AssignUser] do
      live "/", HomeLive
      live "/room/:id", RoomLive
    end
  end

  # Public API: docs (serves HTML, no :api pipeline)
  scope "/api", ByobWeb do
    pipe_through [:api_public_docs]

    get "/", ApiController, :docs
  end

  # Public API: create room
  scope "/api", ByobWeb do
    pipe_through [:api, :api_public_create]

    post "/rooms", ApiController, :create_room
  end

  # Authenticated API: read endpoints
  scope "/api/rooms/:id", ByobWeb do
    pipe_through [:api, :api_auth_read]

    get "/", ApiController, :show_room
    get "/queue", ApiController, :show_queue
    get "/users", ApiController, :list_users
  end

  # Authenticated API: mutation endpoints
  scope "/api/rooms/:id", ByobWeb do
    pipe_through [:api, :api_auth_mutate]

    post "/queue", ApiController, :add_to_queue
    delete "/queue/:item_id", ApiController, :remove_from_queue
    put "/queue/reorder", ApiController, :reorder_queue
    post "/skip", ApiController, :skip
    post "/play", ApiController, :play
    post "/pause", ApiController, :pause
    put "/username", ApiController, :change_username
  end
end
