defmodule WatchPartyWeb.Router do
  use WatchPartyWeb, :router

  pipeline :browser do
    plug :accepts, ["html"]
    plug :fetch_session
    plug :fetch_live_flash
    plug :put_root_layout, html: {WatchPartyWeb.Layouts, :root}
    plug :protect_from_forgery
    plug :put_secure_browser_headers
    plug WatchPartyWeb.Plugs.SessionIdentity
  end

  pipeline :api do
    plug :accepts, ["json"]
  end

  scope "/", WatchPartyWeb do
    pipe_through :browser

    live_session :default, on_mount: [WatchPartyWeb.Hooks.AssignUser] do
      live "/", HomeLive
      live "/room/:id", RoomLive
    end
  end

  # Other scopes may use custom stacks.
  # scope "/api", WatchPartyWeb do
  #   pipe_through :api
  # end
end
