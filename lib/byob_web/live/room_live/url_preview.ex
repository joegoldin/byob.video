defmodule ByobWeb.RoomLive.UrlPreview do
  @moduledoc """
  Handles URL preview event handlers extracted from RoomLive.

  Covers: preview_url, add_url (submit drives Play Now / Queue via hidden mode input),
  and the {:url_preview_result, _} info messages.
  """

  import Phoenix.Component, only: [assign: 2]

  alias Byob.RoomServer

  def handle_preview_url(%{"url" => raw}, socket) do
    trimmed = String.trim(raw)

    cond do
      trimmed == "" ->
        {:noreply, reset_preview(socket)}

      true ->
        extracted = Byob.MediaItem.extract_url(raw)
        route_preview(extracted, raw, socket)
    end
  end

  defp route_preview(nil, raw, socket) do
    {:noreply,
     assign(socket,
       preview_url: raw,
       resolved_url: nil,
       url_preview: nil,
       url_preview_loading: false,
       url_preview_error: :invalid_url
     )}
  end

  defp route_preview(extracted, raw, socket) do
    base =
      assign(socket,
        preview_url: raw,
        resolved_url: extracted,
        url_preview_error: nil
      )

    case Byob.MediaItem.parse_url(extracted) do
      {:ok, %{source_type: :youtube, source_id: source_id}} ->
        socket = assign(base, url_preview_loading: true, url_preview: nil)
        pid = self()

        Task.start(fn ->
          meta =
            case source_id && Byob.YouTube.Videos.fetch(source_id) do
              {:ok, data} ->
                Map.put(data, :source_type, :youtube)

              _ ->
                case Byob.OEmbed.fetch_youtube(extracted) do
                  {:ok, data} -> Map.put(data, :source_type, :youtube)
                  _ -> %{title: nil, thumbnail_url: nil, source_type: :youtube}
                end
            end

          send(pid, {:url_preview_result, meta})
        end)

        {:noreply, socket}

      {:ok, %{source_type: :vimeo}} ->
        socket = assign(base, url_preview_loading: true, url_preview: nil)
        pid = self()

        Task.start(fn ->
          meta =
            case Byob.OEmbed.fetch_vimeo(extracted) do
              {:ok, data} -> data
              _ -> %{title: nil, thumbnail_url: nil, source_type: :vimeo}
            end

          send(pid, {:url_preview_result, meta})
        end)

        {:noreply, socket}

      {:ok, %{source_type: :direct_url}} ->
        filename = extracted |> URI.parse() |> Map.get(:path, "") |> Path.basename()

        preview = %{
          source_type: :direct_url,
          title: filename,
          thumbnail_url: nil,
          url: extracted
        }

        {:noreply, assign(base, url_preview: preview, url_preview_loading: false)}

      {:ok, %{source_type: :extension_required}} ->
        socket = assign(base, url_preview_loading: true, url_preview: nil)
        me = self()

        Task.start(fn ->
          case Byob.OEmbed.fetch_opengraph(extracted) do
            {:ok, meta} ->
              send(me, {:url_preview_result, Map.put(meta, :source_type, :extension_required)})

            _ ->
              send(
                me,
                {:url_preview_result,
                 %{title: nil, thumbnail_url: nil, source_type: :extension_required}}
              )
          end
        end)

        {:noreply, socket}

      {:error, :self_reference} ->
        {:noreply, preview_error(base, :self_reference)}

      {:error, :drm_site, service} ->
        {:noreply, preview_error(base, {:drm_site, service})}

      {:error, :invalid_url} ->
        {:noreply, preview_error(base, :invalid_url)}

      _ ->
        {:noreply, preview_error(base, :invalid_url)}
    end
  end

  defp preview_error(socket, reason) do
    assign(socket,
      url_preview: nil,
      url_preview_loading: false,
      url_preview_error: reason,
      resolved_url: nil
    )
  end

  defp reset_preview(socket) do
    assign(socket,
      url_preview: nil,
      url_preview_loading: false,
      preview_url: nil,
      url_preview_error: nil,
      resolved_url: nil
    )
  end

  def handle_add_url(%{"url" => raw, "mode" => mode}, socket) do
    case Byob.MediaItem.extract_url(raw) do
      nil ->
        # Invalid input — leave error card visible, don't queue.
        {:noreply, socket}

      resolved ->
        mode_atom = if mode == "now", do: :now, else: :queue

        source_type =
          case Byob.MediaItem.parse_url(resolved) do
            {:ok, %{source_type: st}} -> st
            _ -> :unknown
          end

        Byob.Analytics.video_added(
          socket.assigns[:browser_id] || socket.assigns.user_id,
          socket.assigns.room_id,
          source_type
        )

        RoomServer.add_to_queue(
          socket.assigns.room_pid,
          socket.assigns.user_id,
          resolved,
          mode_atom
        )

        {:noreply, reset_preview(socket)}
    end
  end

  def handle_preview_result(nil, socket) do
    {:noreply, assign(socket, url_preview: nil, url_preview_loading: false)}
  end

  def handle_preview_result(meta, socket) do
    preview = %{
      title: meta[:title],
      thumbnail_url: meta[:thumbnail_url],
      author_name: meta[:author_name],
      duration: meta[:duration],
      published_at: meta[:published_at],
      source_type: meta[:source_type] || :youtube
    }

    {:noreply, assign(socket, url_preview: preview, url_preview_loading: false)}
  end
end
