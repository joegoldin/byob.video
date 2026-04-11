defmodule Byob.SponsorBlock do
  @api_url "https://sponsor.ajay.app/api/skipSegments"

  @categories ~w(sponsor selfpromo interaction intro outro preview music_offtopic filler)

  def fetch_segments(video_id) do
    params = [
      videoID: video_id,
      categories: Jason.encode!(@categories)
    ]

    case Req.get(@api_url, params: params) do
      {:ok, %{status: 200, body: body}} when is_list(body) ->
        segments =
          Enum.map(body, fn seg ->
            %{
              segment: seg["segment"],
              category: seg["category"],
              action_type: seg["actionType"],
              uuid: seg["UUID"]
            }
          end)

        {:ok, segments}

      {:ok, %{status: 404}} ->
        {:ok, []}

      {:ok, %{status: status}} ->
        {:error, {:http_error, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end
end
