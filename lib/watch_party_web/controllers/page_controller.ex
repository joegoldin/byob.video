defmodule WatchPartyWeb.PageController do
  use WatchPartyWeb, :controller

  def home(conn, _params) do
    render(conn, :home)
  end
end
