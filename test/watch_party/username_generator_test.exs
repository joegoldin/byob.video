defmodule WatchParty.UsernameGeneratorTest do
  use ExUnit.Case, async: true

  alias WatchParty.UsernameGenerator

  describe "generate/0" do
    test "returns a string" do
      assert is_binary(UsernameGenerator.generate())
    end

    test "matches AdjectiveAnimal## pattern" do
      name = UsernameGenerator.generate()
      assert name =~ ~r/^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/
    end

    test "generates different names" do
      names = for _ <- 1..10, do: UsernameGenerator.generate()
      # At least 2 unique names out of 10
      assert length(Enum.uniq(names)) > 1
    end
  end
end
