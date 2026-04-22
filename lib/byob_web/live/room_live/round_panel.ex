defmodule ByobWeb.RoomLive.RoundPanel do
  @moduledoc """
  Renders the roulette / voting round panel. Slots into the right column
  above the YouTube comments. Silent, non-intrusive — collapsible per-user,
  no modal, no auto-focus.
  """

  use Phoenix.Component

  import ByobWeb.RoomLive.Components, only: [format_duration: 1]

  attr :round, :any, required: true
  attr :collapsed, :boolean, default: false
  attr :current_user_id, :string, required: true

  def round_panel(assigns) do
    ~H"""
    <div
      :if={@round}
      id="round-panel"
      phx-hook="RoundTimer"
      data-expires-at={@round.expires_at}
      data-server-time={@round.server_time}
      data-mode={@round.mode}
      data-phase={@round.phase}
      class="card bg-base-200 mb-3 flex-shrink-0 overflow-hidden"
    >
      <div class="card-body p-3">
        <.header round={@round} collapsed={@collapsed} current_user_id={@current_user_id} />

        <div :if={not @collapsed} class="mt-2">
          <.voting_body :if={@round.mode == :voting} round={@round} current_user_id={@current_user_id} />
          <.roulette_body :if={@round.mode == :roulette} round={@round} />
        </div>
      </div>
    </div>
    """
  end

  # --- header ---

  attr :round, :any, required: true
  attr :collapsed, :boolean, required: true
  attr :current_user_id, :string, required: true

  defp header(assigns) do
    ~H"""
    <div class="flex items-center gap-2">
      <span class="text-base leading-none">
        {if @round.mode == :voting, do: "🗳️", else: "🎰"}
      </span>
      <span class="font-medium text-sm">
        {if @round.mode == :voting, do: "Voting", else: "Roulette"}
      </span>
      <span
        :if={@round.phase == :active}
        id="round-timer-label"
        class="text-xs text-base-content/60 tabular-nums"
      >
        —
      </span>
      <span
        :if={@round.phase == :revealing}
        class="text-xs text-base-content/60"
      >
        {if @round.mode == :voting, do: "winner!", else: "landing…"}
      </span>

      <div class="ml-auto flex items-center gap-1">
        <button
          class="btn btn-ghost btn-xs btn-circle"
          phx-click="round:toggle_collapse"
          aria-label="Collapse round panel"
          title={if @collapsed, do: "Expand", else: "Collapse"}
        >
          <span class="text-[10px]">{if @collapsed, do: "▸", else: "▾"}</span>
        </button>
        <button
          :if={@round.started_by == @current_user_id and @round.phase == :active}
          class="btn btn-ghost btn-xs btn-circle text-error/70 hover:text-error"
          phx-click="round:cancel"
          phx-value-round_id={@round.id}
          aria-label="Cancel round"
          title="Cancel round"
        >
          <span class="text-xs">✕</span>
        </button>
      </div>
    </div>
    """
  end

  # --- voting ---

  defp voting_body(assigns) do
    max_tally =
      assigns.round.tallies
      |> Map.values()
      |> Enum.max(fn -> 0 end)

    voted_for = voted_for(assigns.round, assigns.current_user_id)
    assigns = assign(assigns, :max_tally, max_tally) |> assign(:voted_for, voted_for)

    ~H"""
    <div class="space-y-1.5">
      <button
        :for={c <- @round.candidates}
        type="button"
        phx-click="round:vote"
        phx-value-round_id={@round.id}
        phx-value-external_id={c.external_id}
        disabled={@round.phase != :active}
        class={[
          "w-full flex items-center gap-2 rounded p-1.5 text-left transition-colors",
          (@voted_for == c.external_id && "bg-primary/20 hover:bg-primary/30") ||
            "hover:bg-base-300/60",
          @round.phase != :active && "opacity-60 cursor-default",
          @round.winner_external_id == c.external_id &&
            "ring-2 ring-warning"
        ]}
      >
        <img
          :if={c.thumbnail_url}
          src={c.thumbnail_url}
          alt=""
          class="w-14 h-10 object-cover rounded bg-base-300 flex-shrink-0"
        />
        <div class="flex-1 min-w-0">
          <div class="text-xs font-medium truncate">{c.title}</div>
          <div class="text-[10px] text-base-content/50 flex items-center gap-1 mt-0.5">
            <span :if={c.channel} class="truncate">{c.channel}</span>
            <span :if={c.channel && c.duration_s} class="text-base-content/30">·</span>
            <span :if={c.duration_s}>{format_duration(c.duration_s)}</span>
            <span class="ml-auto text-[10px] text-base-content/40 flex-shrink-0">
              {source_label(c.source_type)}
            </span>
          </div>
          <div class="mt-1 flex items-center gap-1">
            <div class="flex-1 h-1 bg-base-300 rounded overflow-hidden">
              <div
                class="h-full bg-primary/60 transition-all"
                style={"width: #{tally_pct(@round, c, @max_tally)}%"}
              />
            </div>
            <span class="text-[10px] tabular-nums text-base-content/60 w-4 text-right">
              {Map.get(@round.tallies, c.external_id, 0)}
            </span>
          </div>
        </div>
        <span
          :if={@voted_for == c.external_id}
          class="text-xs text-primary flex-shrink-0"
          title="Your vote"
        >
          🎯
        </span>
      </button>
    </div>
    """
  end

  # --- roulette ---

  # Palette of slice fallback colors (used when a thumbnail URL is missing
  # or fails to load). daisyUI 5 theme vars (`--color-*`) don't resolve
  # inside SVG fill= attributes, so we hard-code a dark-theme-friendly set.
  @slice_palette [
    "#4338ca", "#a21caf", "#be185d", "#b45309",
    "#15803d", "#0e7490", "#7c3aed", "#c026d3",
    "#dc2626", "#ca8a04", "#16a34a", "#0284c7"
  ]

  defp roulette_body(assigns) do
    candidates = assigns.round.candidates
    slices = length(candidates)

    slice_info =
      candidates
      |> Enum.with_index()
      |> Enum.map(fn {c, i} ->
        angle_per = if slices > 0, do: 360 / slices, else: 0
        start_angle = angle_per * i - 90
        end_angle = start_angle + angle_per
        {x1, y1} = polar(100, 100, 96, start_angle)
        {x2, y2} = polar(100, 100, 96, end_angle)
        large_arc = if angle_per > 180, do: 1, else: 0

        path =
          "M 100 100 L #{Float.round(x1, 2)} #{Float.round(y1, 2)} " <>
            "A 96 96 0 #{large_arc} 1 #{Float.round(x2, 2)} #{Float.round(y2, 2)} Z"

        # Slice center in "from-top, clockwise" degrees (0 = 12 o'clock).
        slice_center_from_top = angle_per * (i + 0.5)

        # Slice midpoint in SVG coords (0° = +X axis, clockwise +Y down).
        svg_angle_deg = slice_center_from_top - 90
        rad = svg_angle_deg * :math.pi() / 180
        mid_r = 58
        text_mid_x = 100 + mid_r * :math.cos(rad)
        text_mid_y = 100 + mid_r * :math.sin(rad)

        # Card fly target (slightly closer to hub so convergence is obvious).
        card_target_r = 50
        card_target_x = 100 + card_target_r * :math.cos(rad)
        card_target_y = 100 + card_target_r * :math.sin(rad)

        # Text baseline runs RADIALLY — parallel to the slice's axis
        # (hub → outer edge). We position a <g> at the slice midpoint,
        # then rotate by the slice's SVG angle so local +X points outward
        # along the radial. If that rotation would put glyphs upside-
        # down / right-to-left (svg_angle ∈ (90°, 270°)), flip 180° so
        # they stay readable from the viewer's perspective.
        radial_rotate = svg_angle_deg
        flip? = radial_rotate > 90 and radial_rotate < 270
        text_rotate = if flip?, do: radial_rotate - 180, else: radial_rotate

        # 2 lines of up to 18 chars, word-boundary split. Radial text
        # has the slice's full radial length (~65 units) along the
        # baseline, so we can fit much more text than with the old
        # tangent layout.
        {line1, line2} = split_title_for_slice(c.title, 18)

        %{
          index: i,
          candidate: c,
          path: path,
          pattern_id: "wheel-thumb-#{i}",
          fallback_fill: Enum.at(@slice_palette, rem(i, length(@slice_palette))),
          text_mid_x: Float.round(text_mid_x, 2),
          text_mid_y: Float.round(text_mid_y, 2),
          text_rotate: Float.round(text_rotate, 2),
          title_line1: line1,
          title_line2: line2,
          slice_cx: Float.round(card_target_x, 2),
          slice_cy: Float.round(card_target_y, 2),
          is_winner: assigns.round.winner_external_id == c.external_id
        }
      end)

    assigns =
      assigns
      |> assign(:slices, slices)
      |> assign(:slice_info, slice_info)

    ~H"""
    <div
      id="roulette-wheel"
      phx-hook="RouletteWheel"
      data-slices={@slices}
      data-phase={@round.phase}
      class="flex flex-col items-center gap-2 select-none"
    >
      <%!-- The wheel stage is visible from the start. Slices begin with the
           fallback color only; each slice's thumbnail is revealed as its
           preview card flies into it during the preroll. Hook-owned: after
           mount LiveView must NOT patch inline styles (opacities etc), so
           mark the whole subtree ignore. --%>
      <div
        id="roulette-wheel-stage"
        phx-update="ignore"
        class="relative w-[26rem] h-[26rem] mx-auto"
      >
        <svg viewBox="0 0 200 200" class="w-full h-full">
          <defs>
            <clipPath id="wheel-clip"><circle cx="100" cy="100" r="96" /></clipPath>
            <%= for s <- @slice_info, s.candidate.thumbnail_url do %>
              <pattern
                id={s.pattern_id}
                patternUnits="userSpaceOnUse"
                x="4"
                y="4"
                width="192"
                height="192"
              >
                <image
                  href={s.candidate.thumbnail_url}
                  x="4"
                  y="4"
                  width="192"
                  height="192"
                  preserveAspectRatio="xMidYMid slice"
                />
              </pattern>
            <% end %>
          </defs>

          <circle cx="100" cy="100" r="96" fill="#0f172a" />

          <g class="wheel-slices">
            <%= for s <- @slice_info do %>
              <g class="wheel-slice" data-slice-index={s.index}>
                <%!-- Base color (always visible) --%>
                <path d={s.path} fill={s.fallback_fill} opacity="0.9" />

                <%!-- Thumbnail overlay: starts invisible, hook fades in when
                     the card flies into this slice. --%>
                <path
                  :if={s.candidate.thumbnail_url}
                  class="slice-thumb"
                  data-slice-index={s.index}
                  d={s.path}
                  fill={"url(##{s.pattern_id})"}
                  style="opacity: 0; transition: opacity 300ms ease-out;"
                />

                <%!-- Dark overlay to boost text legibility (also gated) --%>
                <path
                  class="slice-dark"
                  data-slice-index={s.index}
                  d={s.path}
                  fill="black"
                  opacity="0"
                  style="transition: opacity 300ms ease-out;"
                />
                <path
                  d={s.path}
                  fill="none"
                  stroke="rgba(255,255,255,0.25)"
                  stroke-width="1"
                />

                <%!-- Winner outline: only visible once the ball fully
                     settles. The JS hook toggles opacity via the
                     `.wheel-slice-win` marker class on the slice group. --%>
                <path
                  d={s.path}
                  fill="none"
                  stroke="#facc15"
                  stroke-width="3.5"
                  class="slice-winner-outline"
                  data-slice-index={s.index}
                  style="opacity: 0; transition: opacity 200ms ease-out;"
                />

                <%!-- Title: translated to the slice midpoint, then rotated
                     so its baseline runs RADIALLY (along the slice's axis
                     from hub to outer edge). 2 lines stack perpendicular
                     to the baseline. Hidden until the card flies in. --%>
                <g
                  class="slice-text"
                  data-slice-index={s.index}
                  transform={"translate(#{s.text_mid_x} #{s.text_mid_y}) rotate(#{s.text_rotate})"}
                  style="opacity: 0; transition: opacity 300ms ease-out;"
                >
                  <text
                    x="0"
                    y="-1"
                    text-anchor="middle"
                    font-size="7"
                    font-weight="700"
                    fill="white"
                    style="paint-order: stroke; stroke: rgba(0,0,0,0.9); stroke-width: 2.5px;"
                  >
                    {s.title_line1}
                  </text>
                  <text
                    :if={s.title_line2}
                    x="0"
                    y="8"
                    text-anchor="middle"
                    font-size="7"
                    font-weight="700"
                    fill="white"
                    style="paint-order: stroke; stroke: rgba(0,0,0,0.9); stroke-width: 2.5px;"
                  >
                    {s.title_line2}
                  </text>
                </g>
              </g>
            <% end %>
          </g>

          <circle
            cx="100"
            cy="100"
            r="96"
            fill="none"
            stroke="rgba(255,255,255,0.25)"
            stroke-width="2"
          />

          <circle
            cx="100"
            cy="100"
            r="18"
            fill="#1e293b"
            stroke="rgba(255,255,255,0.2)"
            stroke-width="2"
          />
          <text
            x="100"
            y="104"
            text-anchor="middle"
            font-size="12"
            fill="white"
            font-weight="700"
          >
            🎰
          </text>

          <circle
            id="roulette-ball"
            cx="100"
            cy="4"
            r="6"
            fill="#facc15"
            stroke="#1e293b"
            stroke-width="2"
            style="filter: drop-shadow(0 1px 3px rgba(0,0,0,0.6)); opacity: 0;"
          />
        </svg>

        <%!-- 3-second loading overlay. Hook fades this out when it
             transitions to the card preview phase. Gives viewers time
             to see that a round has started, read the header, and
             scroll into view if needed. --%>
        <div
          id="roulette-loading"
          class="absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 bg-base-200/70 backdrop-blur-sm rounded-full"
          style="opacity: 1; transition: opacity 240ms ease-out;"
        >
          <span class="loading loading-spinner loading-lg text-primary"></span>
          <span class="text-sm font-semibold text-base-content/80">Loading candidates…</span>
          <span class="text-xs text-base-content/50">Get ready</span>
        </div>

        <%!-- Pie-slice countdown: mirrors the autoplay overlay's visual
             language so users know the round is about to finalize. Hidden
             until the ball lands + settles. --%>
        <div
          id="roulette-pie"
          class="absolute top-2 right-2 w-14 h-14 rounded-full pointer-events-none flex items-center justify-center text-white font-semibold text-sm"
          style="opacity: 0; z-index: 50; isolation: isolate; transition: opacity 240ms ease-out; background: conic-gradient(#facc15 var(--byob-roulette-pie-angle, 0deg), rgba(15, 23, 42, 0.85) 0); box-shadow: 0 2px 10px rgba(0,0,0,0.6), 0 0 0 2px rgba(0,0,0,0.4); text-shadow: 0 1px 2px rgba(0,0,0,0.8);"
        >
          <span id="roulette-pie-label">—</span>
        </div>

        <%!-- Per-candidate preview cards. Positioned above the wheel by the
             hook and animated into their slice positions one at a time. --%>
        <div
          id="roulette-cards"
          class="pointer-events-none absolute inset-0"
        >
          <%= for s <- @slice_info do %>
            <div
              class="roulette-card absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-52 rounded-lg bg-base-200 shadow-xl border border-base-300 overflow-hidden"
              data-slice-index={s.index}
              data-target-x={Float.round((s.slice_cx - 100) / 200 * 100, 3)}
              data-target-y={Float.round((s.slice_cy - 100) / 200 * 100, 3)}
              style="opacity: 0; transform: translate(-50%, -50%) scale(0.85);"
            >
              <img
                :if={s.candidate.thumbnail_url}
                src={s.candidate.thumbnail_url}
                alt=""
                class="w-full h-28 object-cover bg-base-300"
              />
              <div class="p-2">
                <div class="text-sm font-semibold leading-tight line-clamp-2">
                  {s.candidate.title}
                </div>
                <div class="text-[10px] text-base-content/60 mt-1 flex items-center gap-1.5">
                  <span>{source_label(s.candidate.source_type)}</span>
                  <span :if={s.candidate.channel} class="truncate">
                    · {s.candidate.channel}
                  </span>
                </div>
              </div>
            </div>
          <% end %>
        </div>
      </div>

      <div class="text-[11px] text-base-content/60 text-center min-h-[1em]" id="roulette-status">
        getting ready…
      </div>
      <div
        :if={@round.phase == :revealing and @round.winner_external_id}
        id="roulette-winner-text"
        class="text-sm font-semibold text-center text-warning hidden"
      >
        🎉 {winner_title(@round)}
      </div>
    </div>
    """
  end

  # Split a title into up to 2 lines for slice rendering. Tries to break on
  # a word boundary near `per_line`; falls back to a hard cut.
  defp split_title_for_slice(nil, _), do: {"", nil}

  defp split_title_for_slice(title, per_line) when is_binary(title) do
    trimmed = String.trim(title)

    if String.length(trimmed) <= per_line do
      {trimmed, nil}
    else
      # Try to split at a space near per_line
      case best_split(trimmed, per_line) do
        {first, rest} ->
          # Cap second line length too, with ellipsis if needed
          second =
            if String.length(rest) > per_line do
              String.slice(rest, 0, per_line - 1) <> "…"
            else
              rest
            end

          {first, second}
      end
    end
  end

  defp best_split(s, per_line) do
    # Look backwards from per_line for a space; fall back to hard cut.
    window = String.slice(s, 0, per_line)

    case String.split(window, ~r/\s+/) |> Enum.reverse() do
      [_only] ->
        # No space in the window — hard cut
        first = String.slice(s, 0, per_line)
        rest = String.slice(s, per_line, String.length(s))
        {first, String.trim_leading(rest)}

      [_last | _before] ->
        case :binary.match(window, " ") do
          :nomatch ->
            first = String.slice(s, 0, per_line)
            rest = String.slice(s, per_line, String.length(s))
            {first, String.trim_leading(rest)}

          _ ->
            # Last space position
            last_space = find_last_space(window)

            if last_space && last_space > div(per_line, 2) do
              first = String.slice(s, 0, last_space) |> String.trim_trailing()
              rest = String.slice(s, last_space + 1, String.length(s))
              {first, String.trim_leading(rest)}
            else
              first = String.slice(s, 0, per_line)
              rest = String.slice(s, per_line, String.length(s))
              {first, String.trim_leading(rest)}
            end
        end
    end
  end

  defp find_last_space(s) do
    positions =
      s
      |> String.graphemes()
      |> Enum.with_index()
      |> Enum.filter(fn {ch, _} -> ch == " " end)
      |> Enum.map(fn {_, i} -> i end)

    List.last(positions)
  end


  # --- helpers ---

  defp polar(cx, cy, r, angle_deg) do
    rad = angle_deg * :math.pi() / 180
    {cx + r * :math.cos(rad), cy + r * :math.sin(rad)}
  end

  defp tally_pct(_round, _c, 0), do: 0

  defp tally_pct(round, candidate, max_tally) do
    tally = Map.get(round.tallies, candidate.external_id, 0)
    round(tally / max_tally * 100)
  end

  defp voted_for(%{voter_ids_by_candidate: by_cand}, user_id) when is_map(by_cand) do
    Enum.find_value(by_cand, fn {ext, ids} -> if user_id in ids, do: ext end)
  end

  defp voted_for(_, _), do: nil

  defp source_label(:trending), do: "🔥 trending"
  defp source_label(:subreddit), do: "🤖 reddit"
  defp source_label(:curated), do: "⭐ curated"
  defp source_label(other) when is_binary(other), do: other
  defp source_label(other), do: to_string(other)

  defp winner_title(round) do
    case Enum.find(round.candidates, &(&1.external_id == round.winner_external_id)) do
      %{title: t} -> t
      _ -> ""
    end
  end
end
