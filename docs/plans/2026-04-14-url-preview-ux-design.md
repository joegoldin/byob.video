# URL Preview UX Overhaul — Design

## Problem

The URL search bar has two UX gaps:

1. **Non-URL input is silently ignored.** If the user pastes a byob room link (common accidental paste), a Netflix URL, or random text, the dropdown stays empty. No feedback that anything went wrong.
2. **Typing a URL mixed with other text fails.** Pasting `hey watch this https://youtu.be/abc` rejects the whole string as invalid because `URI.parse/1` only handles a clean URL.

Combined with a 300ms debounce on `phx-change`, the field can also feel unresponsive in the brief window between keystroke and server response.

## Goals

- Give explicit, immediate feedback for every input state.
- Detect the common failure modes (self-reference, DRM sites, non-URLs) and explain them.
- Let users paste a URL after arbitrary other text without thinking about it.
- Keep all URL classification logic in Elixir — one source of truth.

## Non-Goals

- Auto-prepending `https://` to scheme-less URLs (scope creep; common but separate concern).
- Runtime detection of DRM / unsupported sites (requires probing / extension coordination; out of scope).
- Client-side URL validation duplication (kept server-side).

## State Machine

The dropdown has four mutually exclusive states:

| State | Condition | UI |
|---|---|---|
| **Placeholder** | Input focused, input empty | Supported-sites hint (already built) |
| **Checking** | Input focused, has text, no server result yet | Loading skeleton |
| **Preview** | Server resolved a playable URL | Existing preview card with Play Now / Queue buttons |
| **Error** | Server flagged the URL | Error card: icon, one-line reason, no action buttons |

Transitions are triggered by `:focus-within` (CSS, instant) and `phx-change` events (server, post-debounce).

## Error Types

Detected server-side in `Byob.MediaItem.parse_url/1`. Returned as `{:error, reason}` or `{:error, reason, detail}`.

| Reason | Trigger | Copy |
|---|---|---|
| `:self_reference` | Host is `byob.video`, `www.byob.video`, or the runtime `PHX_HOST` (dev localhost included) | "That's a byob room link — paste a video URL instead." |
| `:drm_site` | Host matches the DRM block list (see below) | "{Service} uses DRM and can't be synced." — service name derived from the host |
| `:invalid_url` | Not parseable as http(s) with a host, or uses `javascript:` / `data:` / `file:` / etc. | "Doesn't look like a video URL." |

### DRM block list

Hardcoded in `Byob.MediaItem`:

```elixir
@drm_hosts %{
  "netflix.com"        => "Netflix",
  "www.netflix.com"    => "Netflix",
  "disneyplus.com"     => "Disney+",
  "www.disneyplus.com" => "Disney+",
  "max.com"            => "Max",
  "www.max.com"        => "Max",
  "hbomax.com"         => "Max",
  "www.hbomax.com"     => "Max",
  "hulu.com"           => "Hulu",
  "www.hulu.com"       => "Hulu",
  "primevideo.com"     => "Prime Video",
  "www.primevideo.com" => "Prime Video",
  "tv.apple.com"       => "Apple TV+",
  "peacocktv.com"      => "Peacock",
  "www.peacocktv.com"  => "Peacock",
  "paramountplus.com"  => "Paramount+",
  "www.paramountplus.com" => "Paramount+"
}
```

Maintenance cost is small; services don't change frequently.

## URL Extraction

The parser processes the **last `http(s)://` URL in the input**.

**Rationale:** Users commonly paste-on-top or type context before pasting. "Last wins" matches observed behavior and is simple to explain.

### Algorithm

```elixir
def extract_url(text) when is_binary(text) do
  ~r{https?://\S+}
  |> Regex.scan(text)
  |> List.last()
  |> case do
    nil -> nil
    [url] -> String.trim_trailing(url, ~c",.;:)]}>\"'")
  end
end
```

Trailing punctuation is stripped so URLs copied from sentences work: `https://youtu.be/abc.` → `https://youtu.be/abc`.

### Input / extracted examples

| Raw input | Extracted |
|---|---|
| `https://youtu.be/abc` | `https://youtu.be/abc` |
| `hey check this https://youtu.be/abc` | `https://youtu.be/abc` |
| `link1 https://youtu.be/abc link2 https://youtu.be/xyz` | `https://youtu.be/xyz` |
| `https://youtu.be/xyz https://byob.video/room/x` | `https://byob.video/room/x` (error: self_reference) |
| `hello world` | `nil` (error: invalid_url) |
| `https://netflix.com/title/123` | `https://netflix.com/title/123` (error: drm_site) |

## Display vs. Resolution

Two assigns, clear separation:

- `@preview_url` — the **raw user text**, bound to the input `value`. Unchanged from today; LiveView keeps the input in sync with what the user typed.
- `@resolved_url` *(new)* — the **extracted URL** (or `nil`). Used by Play Now, Queue, and form submit handlers when calling `RoomServer.add_to_queue/4`.

This avoids the LiveView footgun of overwriting the user's input text with the extracted URL on every re-render.

## Instant Loading Feedback

A 300ms `phx-debounce` means the Checking state wouldn't appear for 300ms with a server-only implementation. Fix: CSS-driven skeleton visibility.

- The skeleton container is always rendered inside the `group` wrapper.
- It's shown when `input:not(:placeholder-shown)` is true inside the group (Tailwind: `group-[:has(input:not(:placeholder-shown))]:flex`).
- It's hidden when a preview or error card exists (those render *above* the skeleton in source order, and the skeleton uses `:if={!@url_preview && !@url_preview_error}`).

Net effect:
- Text appears in input → skeleton shows instantly (CSS).
- Server resolves → preview or error card renders; skeleton `:if` goes false.
- Input cleared → skeleton hidden by `:placeholder-shown`.

No Phoenix hook required.

## Data Flow

```
user types / pastes
   └─ phx-change "preview_url" (debounce 300ms)
      └─ handle_preview_url(%{"url" => raw})
         ├─ preview_url      := raw        (bound to input)
         ├─ extract_url(raw) := extracted | nil
         └─ case extracted do
               nil      -> url_preview_error: :invalid_url
               url      -> parse_url(url) |> case do
                  {:ok, %{source_type: :youtube}}  -> async OEmbed fetch → url_preview
                  {:ok, %{source_type: :direct_url}} -> url_preview (synthesized)
                  {:ok, %{source_type: :extension_required}} -> async OG fetch → url_preview
                  {:error, :self_reference}        -> url_preview_error: :self_reference
                  {:error, :drm_site, service}     -> url_preview_error: {:drm_site, service}
                  {:error, :invalid_url}           -> url_preview_error: :invalid_url
               end
            end
         └─ resolved_url := extracted
```

## Assign Changes

| Assign | Before | After |
|---|---|---|
| `preview_url` | raw text | raw text (unchanged) |
| `resolved_url` | — | extracted URL or nil |
| `url_preview` | struct or nil | struct or nil (unchanged) |
| `url_preview_loading` | bool | bool (unchanged) |
| `url_preview_error` | — | atom or tuple or nil |

## File Changes

- **`lib/byob/media_item.ex`**
  - Add `@drm_hosts` map.
  - Add `extract_url/1`.
  - Extend `parse_url/1`:
    - Classify `byob.video` / `www.byob.video` / `PHX_HOST` as `:self_reference`.
    - Classify DRM hosts as `:drm_site` with service label.
    - Keep existing `:youtube` / `:direct_url` / `:extension_required` branches.
  - Tests updated.

- **`lib/byob_web/live/room_live/url_preview.ex`**
  - `handle_preview_url/2` runs `extract_url/1`, then routes by parse result into preview or error state. Sets `resolved_url`.
  - `handle_add_url/2`, `handle_play_now/2`, `handle_queue/2` submit `@resolved_url`. If `@resolved_url` is `nil` (no extractable URL), the handler is a no-op — no queue insert, no analytics event. This means hitting Enter on invalid input silently does nothing (the error card already communicates why).
  - Clear functions reset `url_preview_error` and `resolved_url` alongside existing fields.

- **`lib/byob_web/live/room_live.ex`**
  - Add `resolved_url: nil`, `url_preview_error: nil` to initial assigns.
  - `clear_url` event handler resets both.
  - Pass new assigns to `Components.room_nav`.

- **`lib/byob_web/live/room_live/components.ex`**
  - `room_nav` accepts `url_preview_error` and `resolved_url` attrs.
  - `url_preview_dropdown`:
    - Add `@url_preview_error` attr.
    - Render error card (icon + one-line message, styled with `alert alert-warning` or equivalent).
    - Render loading skeleton with `:if={!@url_preview && !@url_preview_error}` and CSS `group-[:has(input:not(:placeholder-shown))]:flex` for instant show.

## Error Card UI

A single-row card matching the preview card's dimensions so the dropdown doesn't resize:

```
┌──────────────────────────────────────────────┐
│ ⚠  Netflix uses DRM and can't be synced.     │
└──────────────────────────────────────────────┘
```

No action buttons. Icon color indicates severity (warning yellow for DRM/self-reference, neutral gray for invalid URL).

## Testing

Unit tests in `test/byob/media_item_test.exs`:

- `extract_url/1` — empty, clean URL, URL with prefix text, URL with suffix text, multiple URLs (last wins), trailing punctuation, no URL present.
- `parse_url/1` — each error variant, each success variant (already partially covered).

No LiveView integration tests (existing pattern in this repo doesn't have them for URL preview).

## Rollout

Single commit. No config changes. No migration. Safe to deploy immediately.
