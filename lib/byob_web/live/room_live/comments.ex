defmodule ByobWeb.RoomLive.Comments do
  @moduledoc """
  Handles YouTube comments load-more pagination for RoomLive,
  and provides the comments panel function component.
  """

  use Phoenix.Component

  alias Byob.RoomServer

  # m:ss, mm:ss or h:mm:ss, not glued to more digits (so "1234:56" and
  # dates like "2:30:00.5" don't half-match).
  @timestamp_re ~r/(?<!\d)(\d{1,3}:[0-5]\d(?::[0-5]\d)?)(?!\d)/

  @doc """
  Renders the YouTube comments panel below the video player.
  """
  attr :comments, :list, default: nil
  attr :comments_next_page, :string, default: nil
  attr :collapsed, :boolean, default: false
  attr :expanded, :boolean, default: false

  def comments_panel(assigns) do
    ~H"""
    <div
      :if={@comments && @comments != []}
      id="comments-panel"
      class={
        [
          "byob-comments-panel relative bg-base-200 rounded-lg",
          unless @collapsed do
            if @expanded do
              "lg:h-[400px] lg:flex-shrink-0 overflow-y-auto"
            else
              # min-h-[220px] so comments stay legible on tall viewports where
              # flex-1 would otherwise squeeze them too short, but without
              # the `lg:min-h` override that was pushing the main column past
              # the viewport and killing the sidebar's sticky scroll.
              "min-h-[220px] max-h-[300px] lg:flex-1 lg:max-h-none lg:min-h-0 overflow-y-auto"
            end
          end
        ]
      }
    >
      <%!-- Header --%>
      <div class="sticky top-0 bg-base-200 px-3 py-2 border-b border-base-300 z-10 flex items-center justify-between rounded-t-lg">
        <span class="text-xs font-semibold text-base-content/60">Comments</span>
        <button
          phx-click="toggle_comments_collapse"
          class="text-base-content/40 hover:text-base-content/60 transition-colors"
        >
          <svg
            class={"w-4 h-4 transition-transform #{if @collapsed, do: "rotate-180"}"}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      <%!-- Comment list (hidden when collapsed) --%>
      <div :if={!@collapsed} class="divide-y divide-base-300/50">
        <div :for={comment <- @comments} class="flex gap-2.5 px-3 py-2.5">
          <img src={comment.author_avatar} class="w-7 h-7 rounded-full flex-shrink-0 mt-0.5" />
          <div class="flex-1 min-w-0">
            <div class="flex items-baseline gap-1.5">
              <span class="text-xs font-semibold text-base-content/80">{comment.author}</span>
              <span class="text-[10px] text-base-content/30">
                {relative_time(comment.published_at)}
              </span>
            </div>
            <.comment_text text={comment.text} />
            <div class="flex gap-3 mt-1">
              <span :if={comment.likes > 0} class="text-[10px] text-base-content/30">
                👍 {comment.likes}
              </span>
              <span :if={comment.reply_count > 0} class="text-[10px] text-base-content/30">
                💬 {comment.reply_count}
              </span>
            </div>
          </div>
        </div>
      </div>

      <%!-- Load more (hidden when collapsed) --%>
      <div
        :if={!@collapsed && @comments_next_page}
        class="px-3 py-2 text-center border-t border-base-300"
      >
        <button phx-click="comments:load_more" class="text-xs text-primary hover:underline">
          Load more comments
        </button>
      </div>

      <%!-- Expand button (JS hook reveals it when panel height is cramped, or when already expanded) --%>
      <div
        :if={!@collapsed}
        class="sticky bottom-0 flex justify-end px-2 pb-2 pt-1 pointer-events-none z-10"
      >
        <button
          id="comments-expand-btn"
          phx-hook="ExpandWhenCramped"
          phx-click="toggle_comments_expand"
          data-expanded={if @expanded, do: "true", else: "false"}
          data-tip={if @expanded, do: "Hide comments viewer", else: "Expand comments viewer"}
          style="display:none"
          class="tooltip tooltip-left pointer-events-auto btn btn-circle btn-xs bg-base-200/95 border border-base-300 shadow-md hover:bg-base-300"
        >
          <svg
            class={"w-3 h-3 transition-transform " <> if(@expanded, do: "rotate-45", else: "")}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2.5"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
    </div>
    """
  end

  @doc """
  Comment body with `12:34`-style timestamps turned into buttons that
  seek the room to that position, the way YouTube's own comments do.
  """
  attr :text, :string, default: nil

  def comment_text(assigns) do
    assigns = assign(assigns, :segments, timestamp_segments(assigns.text))

    ~H"""
    <p class="text-xs text-base-content/60 mt-0.5 break-words">
      <.comment_segment :for={segment <- @segments} segment={segment} />
    </p>
    """
  end

  # `whitespace-pre-line` sits on the text spans rather than the paragraph:
  # a comment's own newlines still show, while the newlines HEEx leaves
  # between segments collapse like any other markup whitespace instead of
  # breaking a sentence in half around a timestamp.
  defp comment_segment(%{segment: {:timestamp, label, seconds}} = assigns) do
    assigns = assign(assigns, label: label, seconds: seconds)

    ~H"""
    <button
      type="button"
      phx-click="comments:seek"
      phx-value-seconds={@seconds}
      class="text-primary hover:underline"
    >
      {@label}
    </button>
    """
  end

  defp comment_segment(%{segment: {:text, text}} = assigns) do
    assigns = assign(assigns, :body, text)

    ~H"""
    <span class="whitespace-pre-line">{@body}</span>
    """
  end

  @doc false
  def timestamp_segments(text) when is_binary(text) do
    @timestamp_re
    |> Regex.split(text, include_captures: true)
    |> Enum.reject(&(&1 == ""))
    |> Enum.map(fn part ->
      case parse_timestamp(part) do
        nil -> {:text, part}
        seconds -> {:timestamp, part, seconds}
      end
    end)
  end

  def timestamp_segments(_), do: []

  defp parse_timestamp(part) do
    if Regex.match?(~r/^\d{1,3}:[0-5]\d(?::[0-5]\d)?$/, part) do
      part |> String.split(":") |> Enum.map(&String.to_integer/1) |> to_seconds()
    end
  end

  defp to_seconds([m, s]), do: m * 60 + s
  defp to_seconds([h, m, s]), do: h * 3600 + m * 60 + s

  @doc """
  Seek the room from a timestamp click in a comment. Same path as any
  other user seek, so everyone in the room jumps together.
  """
  def handle_seek(%{"seconds" => seconds}, socket) do
    case Integer.parse(seconds) do
      {position, ""} when position >= 0 ->
        RoomServer.seek(socket.assigns.room_pid, socket.assigns.user_id, position)

      _ ->
        :ok
    end

    {:noreply, socket}
  end

  def handle_seek(_params, socket), do: {:noreply, socket}

  defp relative_time(iso_string) when is_binary(iso_string) do
    case DateTime.from_iso8601(iso_string) do
      {:ok, dt, _} ->
        diff = DateTime.diff(DateTime.utc_now(), dt, :second)

        cond do
          diff < 60 -> "just now"
          diff < 3600 -> "#{div(diff, 60)} min ago"
          diff < 86_400 -> "#{div(diff, 3600)}h ago"
          diff < 604_800 -> "#{div(diff, 86_400)}d ago"
          diff < 2_592_000 -> "#{div(diff, 604_800)}w ago"
          diff < 31_536_000 -> "#{div(diff, 2_592_000)}mo ago"
          true -> "#{div(diff, 31_536_000)}y ago"
        end

      _ ->
        ""
    end
  end

  defp relative_time(_), do: ""

  def handle_load_more(_params, socket) do
    video_id = socket.assigns[:comments_video_id]
    next_page_token = socket.assigns[:comments_next_page]

    if video_id && next_page_token do
      me = self()

      Task.start(fn ->
        case Byob.YouTube.Comments.fetch(video_id, page_token: next_page_token) do
          {:ok, result} -> send(me, {:comments_page_result, video_id, {:ok, result}})
          error -> send(me, {:comments_page_result, video_id, error})
        end
      end)

      {:noreply, socket}
    else
      {:noreply, socket}
    end
  end

  def handle_page_result({:comments_page_result, video_id, {:ok, result}}, socket) do
    if video_id == socket.assigns[:comments_video_id] do
      existing = socket.assigns[:comments] || []

      {:noreply,
       assign(socket,
         comments: existing ++ result.comments,
         comments_next_page: result.next_page_token,
         comments_total: result.total_count
       )}
    else
      {:noreply, socket}
    end
  end

  def handle_page_result({:comments_page_result, _video_id, _error}, socket) do
    {:noreply, socket}
  end
end
