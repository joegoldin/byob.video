defmodule ByobWeb.RoomLive.CommentsTest do
  use ExUnit.Case, async: true

  import Phoenix.LiveViewTest, only: [rendered_to_string: 1]

  alias ByobWeb.RoomLive.Comments

  describe "timestamp_segments/1" do
    test "splits timestamps out of surrounding text" do
      assert Comments.timestamp_segments("skip to 1:23 for the drop") == [
               {:text, "skip to "},
               {:timestamp, "1:23", 83},
               {:text, " for the drop"}
             ]
    end

    test "handles h:mm:ss" do
      assert Comments.timestamp_segments("1:02:03") == [{:timestamp, "1:02:03", 3723}]
    end

    test "leaves near-misses alone" do
      for text <- ["ratio was 3:70", "1234:56", "60 minutes"] do
        assert Comments.timestamp_segments(text) == [{:text, text}]
      end
    end

    test "tolerates nil text" do
      assert Comments.timestamp_segments(nil) == []
    end
  end

  describe "comment_text/1" do
    test "renders timestamps as seek buttons without disturbing the text" do
      html =
        %{text: "watch 0:45 then 12:30 later", __changed__: nil}
        |> Comments.comment_text()
        |> rendered_to_string()

      assert html =~ ~s(phx-click="comments:seek")
      assert html =~ ~s(phx-value-seconds="45")
      assert html =~ ~s(phx-value-seconds="750")

      # Markup whitespace collapses in the browser, so compare the way it
      # will read: tags stripped, runs of whitespace squeezed to one space.
      text_only =
        html
        |> String.replace(~r/<[^>]*>/, "")
        |> String.replace(~r/\s+/, " ")
        |> String.trim()

      assert text_only == "watch 0:45 then 12:30 later"
    end
  end
end
