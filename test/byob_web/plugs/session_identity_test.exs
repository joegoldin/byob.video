defmodule ByobWeb.Plugs.SessionIdentityTest do
  use ByobWeb.ConnCase, async: true

  alias ByobWeb.Plugs.SessionIdentity

  describe "call/2" do
    test "assigns user_id and username when session is empty" do
      conn =
        build_conn()
        |> init_test_session(%{})
        |> SessionIdentity.call([])

      assert get_session(conn, :user_id) != nil
      assert get_session(conn, :username) != nil
      assert get_session(conn, :user_id) =~ ~r/^[0-9a-f\-]{36}$/
    end

    test "preserves existing user_id and username" do
      conn =
        build_conn()
        |> init_test_session(%{user_id: "existing-id", username: "ExistingUser"})
        |> SessionIdentity.call([])

      assert get_session(conn, :user_id) == "existing-id"
      assert get_session(conn, :username) == "ExistingUser"
    end
  end
end
