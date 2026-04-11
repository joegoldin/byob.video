defmodule ByobWeb.HomeLiveTest do
  use ByobWeb.ConnCase, async: true

  import Phoenix.LiveViewTest

  describe "HomeLive" do
    test "renders create room button", %{conn: conn} do
      {:ok, view, html} = live(conn, "/")
      assert html =~ "Create Room"
      assert has_element?(view, "button", "Create Room")
    end

    test "clicking create room redirects to /room/:id", %{conn: conn} do
      {:ok, view, _html} = live(conn, "/")

      {:error, {:live_redirect, %{to: path}}} =
        view |> element("button", "Create Room") |> render_click()

      assert path =~ ~r"^/room/[0-9a-z]{8}$"
    end
  end
end
