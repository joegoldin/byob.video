defmodule Byob.DB.MigrationsTest do
  use ExUnit.Case, async: true

  alias Byob.DB.Migrations

  describe "current_version/0" do
    test "returns current schema version" do
      assert is_integer(Migrations.current_version())
      assert Migrations.current_version() >= 1
    end
  end

  describe "run/3" do
    test "returns state unchanged when from == to" do
      state = %{queue: [], history: []}
      assert Migrations.run(state, 1, 1) == state
    end

    test "returns state unchanged when from > to" do
      state = %{queue: [], history: []}
      assert Migrations.run(state, 2, 1) == state
    end

    test "runs migrate_1_to_2 when migrating from 1 to 2" do
      state = %{queue: ["a"], history: ["b"]}
      result = Migrations.run(state, 1, 2)
      # migrate_1_to_2 is identity for now
      assert result == state
    end
  end
end
