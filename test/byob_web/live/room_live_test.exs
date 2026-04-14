defmodule ByobWeb.RoomLiveTest do
  use ByobWeb.ConnCase, async: false

  import Phoenix.LiveViewTest

  describe "RoomLive" do
    test "renders room page with room ID", %{conn: conn} do
      {:ok, _view, html} = live(conn, "/room/testroom1")
      assert html =~ "testroom1"
    end

    test "user's username appears in user list", %{conn: conn} do
      {:ok, _view, html} = live(conn, "/room/testroom2")
      # The session identity plug assigns a username matching our pattern
      assert html =~ ~r/[A-Z][a-z]+[A-Z][a-z]+\d{2}/
    end

    test "two connections show both usernames", %{conn: conn} do
      {:ok, view1, _html} = live(conn, "/room/testroom3")

      # Second connection with different session
      conn2 = Phoenix.ConnTest.build_conn()
      {:ok, _view2, _html} = live(conn2, "/room/testroom3")

      # Give PubSub a moment to propagate
      Process.sleep(50)

      html = render(view1)
      # Player div has data-user-id too, so 3 total (1 player + 2 user list items)
      assert length(Regex.scan(~r/data-user-id/, html)) == 3
    end

    test "submitting a YouTube URL adds it to the queue", %{conn: conn} do
      {:ok, view, _html} = live(conn, "/room/testroomqueue")

      view
      |> render_submit("add_url", %{"url" => "https://youtube.com/watch?v=dQw4w9WgXcQ", "mode" => "queue"})

      # Give PubSub a moment
      Process.sleep(50)
      html = render(view)
      assert html =~ "dQw4w9WgXcQ"
    end

    test "navigating to any room ID creates the room", %{conn: conn} do
      {:ok, _view, html} = live(conn, "/room/anyrandomid")
      assert html =~ "anyrandomid"
    end
  end
end
