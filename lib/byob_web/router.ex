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

  scope "/", ByobWeb do
    pipe_through :browser

    live_session :default, on_mount: [ByobWeb.Hooks.AssignUser] do
      live "/", HomeLive
      live "/room/:id", RoomLive
    end
  end

  # Other scopes may use custom stacks.
  # scope "/api", ByobWeb do
  #   pipe_through :api
  # end
end
