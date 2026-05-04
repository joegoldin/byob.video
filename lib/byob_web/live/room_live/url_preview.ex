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
        # Playlist-aware: if the URL has a `list=PL…` (or UU/FL/OL),
        # try the Playlists API first. Fall back to single-video
        # preview for missing API key, quota out, or auto-generated
        # mixes (RD…) the API can't enumerate.
        socket = assign(base, url_preview_loading: true, url_preview: nil)
        pid = self()

        Task.start(fn ->
          meta = fetch_youtube_preview(extracted, source_id)
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

      {:ok, %{source_type: :twitch}} ->
        # OpenGraph scrape on Twitch's HTML works for both VODs (gives the
        # episode title) and live channel pages (gives the streamer's
        # display name + current category as title). Same path as
        # extension_required's metadata fetch.
        socket = assign(base, url_preview_loading: true, url_preview: nil)
        me = self()

        Task.start(fn ->
          case Byob.OEmbed.fetch_opengraph(extracted) do
            {:ok, meta} ->
              send(me, {:url_preview_result, Map.put(meta, :source_type, :twitch)})

            _ ->
              send(
                me,
                {:url_preview_result,
                 %{title: nil, thumbnail_url: nil, source_type: :twitch}}
              )
          end
        end)

        {:noreply, socket}

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

  @doc """
  Toggle a single playlist item's checked state.
  """
  def handle_playlist_select(%{"video_id" => video_id} = params, socket) do
    preview = socket.assigns[:url_preview] || %{}

    if Map.get(preview, :source_type) != :playlist do
      {:noreply, socket}
    else
      checked = params["checked"] == "true" or params["checked"] == true
      selected = Map.get(preview, :selected, MapSet.new())

      selected =
        if checked, do: MapSet.put(selected, video_id), else: MapSet.delete(selected, video_id)

      {:noreply, assign(socket, url_preview: Map.put(preview, :selected, selected))}
    end
  end

  def handle_playlist_select(_, socket), do: {:noreply, socket}

  @doc """
  "Play All" / "Queue All" / "Play Selected" / "Queue Selected" buttons.
  Params: `mode` ∈ {"now", "queue"}, `scope` ∈ {"all", "selected"}.
  """
  def handle_playlist_add(%{"mode" => mode, "scope" => scope}, socket) do
    preview = socket.assigns[:url_preview] || %{}

    cond do
      Map.get(preview, :source_type) != :playlist ->
        {:noreply, socket}

      true ->
        items = Map.get(preview, :items, [])
        selected = Map.get(preview, :selected, MapSet.new())

        items =
          case scope do
            "selected" -> Enum.filter(items, &MapSet.member?(selected, &1.video_id))
            _ -> items
          end

        if items == [] do
          {:noreply, socket}
        else
          mode_atom = if mode == "now", do: :now, else: :queue

          Byob.Analytics.video_added(
            socket.assigns[:browser_id] || socket.assigns.user_id,
            socket.assigns.room_id,
            :youtube
          )

          RoomServer.add_playlist_items(
            socket.assigns.room_pid,
            socket.assigns.user_id,
            items,
            mode_atom
          )

          {:noreply, reset_preview(socket)}
        end
    end
  end

  def handle_playlist_add(_, socket), do: {:noreply, socket}

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
    preview =
      case meta[:source_type] do
        :playlist ->
          # Pass-through verbatim — the playlist preview has its own
          # shape (items, total_count, truncated?, focus_video_id).
          meta

        _ ->
          %{
            title: meta[:title],
            thumbnail_url: meta[:thumbnail_url],
            author_name: meta[:author_name],
            duration: meta[:duration],
            published_at: meta[:published_at],
            source_type: meta[:source_type] || :youtube
          }
      end

    {:noreply, assign(socket, url_preview: preview, url_preview_loading: false)}
  end

  # ── YouTube preview routing ────────────────────────────────────────────
  # Splits the YouTube case so the same code path covers single-video
  # URLs AND playlist URLs (with or without a `v=` focus video). Falls
  # back to the single-video preview whenever Playlists.fetch fails for
  # any reason (no API key, quota out, private playlist, autogen mix).
  defp fetch_youtube_preview(url, source_id) do
    case Byob.MediaItem.youtube_playlist(url) do
      {:ok, list_id, focus} ->
        case Byob.YouTube.Playlists.fetch(list_id) do
          {:ok, %{items: items} = pl} when items != [] ->
            %{
              source_type: :playlist,
              playlist_id: list_id,
              title: pl[:title],
              channel_title: pl[:channel_title],
              total_count: pl[:total_count] || length(items),
              truncated?: pl[:truncated?] || false,
              focus_video_id: focus,
              items: sort_with_focus_first(items, focus)
            }

          _ ->
            single_video_preview(url, source_id)
        end

      :none ->
        single_video_preview(url, source_id)
    end
  end

  defp single_video_preview(url, source_id) do
    case source_id && Byob.YouTube.Videos.fetch(source_id) do
      {:ok, data} ->
        Map.put(data, :source_type, :youtube)

      _ ->
        case Byob.OEmbed.fetch_youtube(url) do
          {:ok, data} -> Map.put(data, :source_type, :youtube)
          _ -> %{title: nil, thumbnail_url: nil, source_type: :youtube}
        end
    end
  end

  # If the user pasted `youtube.com/watch?v=X&list=Y`, X is the video
  # they actually clicked. Hoist it to position 0 of the rendered list
  # so the preview matches expectation; everything else keeps its
  # natural playlist order.
  defp sort_with_focus_first(items, nil), do: items

  defp sort_with_focus_first(items, focus) do
    case Enum.split_with(items, &(&1.video_id == focus)) do
      {[], rest} -> rest
      {focused, rest} -> focused ++ rest
    end
  end
end
