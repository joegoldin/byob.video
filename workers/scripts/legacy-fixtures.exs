# Run from the repository root with: elixir workers/scripts/legacy-fixtures.exs
# These fixtures execute the original implementation, without starting Phoenix,
# opening a database or fetching metadata from external services.
Logger.configure(level: :error)

sources = [
  "lib/byob/media_item.ex",
  "lib/byob/sync_decision.ex",
  "lib/byob/room_server/round.ex"
]

Enum.each(sources, &Code.require_file/1)
Application.put_env(:byob, ByobWeb.Endpoint, url: [host: "preview.example.test"])

urls = [
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLfoo&t=120",
  "https://youtu.be/dQw4w9WgXcQ",
  "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://youtube.com/embed/dQw4w9WgXcQ",
  "https://youtube.com/shorts/dQw4w9WgXcQ",
  "https://youtube.com/live/dQw4w9WgXcQ",
  " www.youtube.com/watch?v=dQw4w9WgXcQ ",
  "https://vimeo.com/123456789",
  "https://player.vimeo.com/video/123456789",
  "https://www.twitch.tv/person/about",
  "https://twitch.tv/videos/1234567890",
  "https://media.example.test/movie.MP4?token=fixture",
  "https://media.example.test/movie.webm",
  "https://crunchyroll.com/watch/some-episode",
  "https://byob.video/room/abc",
  "https://www.byob.video",
  "https://preview.example.test/room/abc",
  "https://www.netflix.com/watch/1",
  "https://play.hbomax.com/feature/x",
  "https://www.disneyplus.com/video/x",
  "https://www.hulu.com/watch/1",
  "https://www.primevideo.com/detail/x",
  "https://tv.apple.com/show/x",
  "https://www.peacocktv.com/watch/x",
  "https://www.paramountplus.com/shows/x",
  "javascript:alert(1)",
  "data:text/html,x",
  "file:///etc/passwd",
  "not a url",
  ""
]

media =
  Enum.map(urls, fn input ->
    expected =
      case Byob.MediaItem.parse_url(input) do
        {:ok, item} -> %{ok: Map.take(item, [:url, :source_type, :source_id, :is_live])}
        {:error, code} -> %{error: code}
        {:error, code, service} -> %{error: code, service: service}
      end

    %{input: input, expected: expected}
  end)

roulette =
  for seed <- [0, 1, 65_535, 65_536, 1_234_567, 2_147_483_647, 4_294_967_295],
      count <- [1, 5, 12, 24] do
    %{seed: seed, count: count, slice: Byob.RoomServer.Round.simulate_landing_slice(seed, count)}
  end

{sync, _state} =
  Enum.map_reduce(
    [
      {1_000_000, -800, 0, 0},
      {1_000_500, -800, 0, 200},
      {1_000_600, 150, 0, 250},
      {1_001_000, 900, 150, 0},
      {1_015_000, -1_200, 0, 0},
      {1_015_500, -1_200, 0, 0}
    ],
    Byob.SyncDecision.new(),
    fn {now, drift, noise, observed}, state ->
      data = %{drift_ms: drift, noise_floor_ms: noise, rtt_ms: 100, observed_l_ms: observed}
      room = %{expected_position: 10 + (now - 1_000_000) / 1_000, room_jitter_ms: 20}

      {seek, next} =
        case Byob.SyncDecision.evaluate(state, data, room, now) do
          {:no_seek, next} -> {nil, next}
          {:seek, seek, next} -> {seek, next}
        end

      {%{now: now, data: data, room: room, seek: seek, state: Map.from_struct(next)}, next}
    end
  )

fixtures = %{
  sources:
    Map.new(sources, fn path ->
      {path, Base.encode16(:crypto.hash(:sha256, File.read!(path)), case: :lower)}
    end),
  media: media,
  roulette: roulette,
  sync: sync
}

File.mkdir_p!("workers/test/fixtures")
File.write!("workers/test/fixtures/legacy.json", JSON.encode!(fixtures) <> "\n")
IO.puts("Wrote legacy media, roulette and sync fixtures without opening the database.")
