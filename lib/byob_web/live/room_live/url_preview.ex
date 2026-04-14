defmodule ByobWeb.RoomLive.UrlPreview do
  @moduledoc """
  Handles URL preview event handlers extracted from RoomLive.

  Covers: url:focus, url:blur, preview_url, add_url, preview:play_now,
  preview:queue, and the {:url_preview_result, _} info messages.
  """

  import Phoenix.Component, only: [assign: 2]

  alias Byob.RoomServer

  def handle_url_focus(_params, socket) do
    {:noreply, assign(socket, url_focused: true)}
  end

  def handle_url_blur(_params, socket) do
    # Delay clearing the preview so that clicks on "Play Now"/"Queue" buttons
    # in the dropdown can fire before the preview disappears
    Process.send_after(self(), :clear_url_preview, 200)
    {:noreply, assign(socket, url_focused: false)}
  end

  def handle_preview_url(%{"url" => url}, socket) do
    url = String.trim(url)

    if url == "" do
      {:noreply, assign(socket, url_preview: nil, url_preview_loading: false, preview_url: nil)}
    else
      case Byob.MediaItem.parse_url(url) do
        {:ok, %{source_type: :youtube}} ->
          socket = assign(socket, url_preview_loading: true, url_preview: nil, preview_url: url)
          pid = self()

          Task.start(fn ->
            case Byob.OEmbed.fetch_youtube(url) do
              {:ok, meta} -> send(pid, {:url_preview_result, meta})
              _ -> send(pid, {:url_preview_result, nil})
            end
          end)

          {:noreply, socket}

        {:ok, %{source_type: :direct_url}} ->
          # Direct video URLs don't need metadata fetching
          filename = url |> URI.parse() |> Map.get(:path, "") |> Path.basename()
          preview = %{
            source_type: :direct_url,
            title: filename,
            thumbnail_url: nil,
            url: url
          }
          {:noreply, assign(socket, url_preview: preview, url_preview_loading: false, preview_url: url)}

        {:ok, %{source_type: :extension_required}} ->
          socket = assign(socket, url_preview_loading: true, url_preview: nil, preview_url: url)
          me = self()

          Task.start(fn ->
            case Byob.OEmbed.fetch_opengraph(url) do
              {:ok, meta} ->
                send(me, {:url_preview_result, Map.put(meta, :source_type, :extension_required)})
              _ ->
                send(me, {:url_preview_result, %{title: nil, thumbnail_url: nil, source_type: :extension_required}})
            end
          end)

          {:noreply, socket}

        _ ->
          {:noreply, assign(socket, url_preview: nil, url_preview_loading: false)}
      end
    end
  end

  def handle_add_url(%{"url" => url, "mode" => mode}, socket) do
    mode_atom = if mode == "now", do: :now, else: :queue
    RoomServer.add_to_queue(socket.assigns.room_pid, socket.assigns.user_id, url, mode_atom)
    {:noreply, assign(socket, url_preview: nil, url_preview_loading: false, preview_url: nil)}
  end

  def handle_play_now(_params, socket) do
    if url = socket.assigns.preview_url do
      source_type = if(socket.assigns.url_preview, do: socket.assigns.url_preview.source_type, else: :unknown)
      Byob.Analytics.video_added(socket.assigns[:browser_id] || socket.assigns.user_id, socket.assigns.room_id, source_type)
      RoomServer.add_to_queue(socket.assigns.room_pid, socket.assigns.user_id, url, :now)
    end
    {:noreply, assign(socket, url_preview: nil, url_preview_loading: false, preview_url: nil)}
  end

  def handle_queue(_params, socket) do
    if url = socket.assigns.preview_url do
      source_type = if(socket.assigns.url_preview, do: socket.assigns.url_preview.source_type, else: :unknown)
      Byob.Analytics.video_added(socket.assigns[:browser_id] || socket.assigns.user_id, socket.assigns.room_id, source_type)
      RoomServer.add_to_queue(socket.assigns.room_pid, socket.assigns.user_id, url, :queue)
    end
    {:noreply, assign(socket, url_preview: nil, url_preview_loading: false, preview_url: nil)}
  end

  def handle_clear_preview(socket) do
    {:noreply, assign(socket, url_preview: nil, url_preview_loading: false, preview_url: nil)}
  end

  def handle_preview_result(nil, socket) do
    {:noreply, assign(socket, url_preview: nil, url_preview_loading: false)}
  end

  def handle_preview_result(meta, socket) do
    preview = %{
      title: meta[:title],
      thumbnail_url: meta[:thumbnail_url],
      author_name: meta[:author_name],
      source_type: meta[:source_type] || :youtube
    }

    {:noreply, assign(socket, url_preview: preview, url_preview_loading: false)}
  end
end
