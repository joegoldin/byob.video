defmodule ByobWeb.RoomLive.Comments do
  @moduledoc """
  Handles YouTube comments load-more pagination for RoomLive.
  """

  import Phoenix.Component, only: [assign: 2]

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
