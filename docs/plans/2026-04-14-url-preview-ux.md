# URL Preview UX Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace silent/missing feedback in the URL preview bar with explicit states (placeholder, checking, preview, error), and support pasting URLs after arbitrary other text.

**Architecture:** Server-side classification in `Byob.MediaItem` (self-reference, DRM, invalid as explicit error variants). Client-side instant feedback via CSS `:focus-within` and `:placeholder-shown` — no Phoenix hooks, no client-side URL parsing. Two assigns separate display (raw user text) from resolution (extracted URL). A regex-based `extract_url/1` takes the last `http(s)://` URL in the input so messy paste works.

**Tech Stack:** Elixir 1.19, Phoenix 1.8 LiveView, Tailwind v4 + daisyUI.

**Design spec:** `docs/plans/2026-04-14-url-preview-ux-design.md`

---

## Conventions

- Every code-changing task starts with a failing test (where feasible) and ends with a `mix test` run and a commit.
- Use the existing test file `test/byob/media_item_test.exs` — add new `describe` blocks.
- Keep commit messages short and imperative (`parser: detect self-reference URLs`).
- Never skip tests or use `--no-verify`. If `mix compile` warns, fix it before moving on.
- Run `mix format` before each commit.

## Files Modified or Created

| File | Role |
|---|---|
| `lib/byob/media_item.ex` | Add `extract_url/1`, `@drm_hosts`, new error variants in `parse_url/1`. |
| `test/byob/media_item_test.exs` | Tests for `extract_url/1`, new error variants; update existing Netflix test. |
| `lib/byob_web/live/room_live/url_preview.ex` | Route parse results to preview/error; submit `@resolved_url`. |
| `lib/byob_web/live/room_live.ex` | Add `resolved_url` / `url_preview_error` assigns; wire through `clear_url` and `render/1`. |
| `lib/byob_web/live/room_live/components.ex` | Error card; loading skeleton with instant-show CSS; pass new assigns through `room_nav` and `url_preview_dropdown`. |

No new files.

---

## Phase 1 — Parser (TDD)

All changes in `lib/byob/media_item.ex` and `test/byob/media_item_test.exs`.

### 1.1 `extract_url/1`

- [ ] Add a new `describe "extract_url/1"` block to `test/byob/media_item_test.exs` with these cases. Each assertion should be a separate `test` so failures are pinpointed:
  - Empty string → `nil`
  - `"hello world"` (no URL) → `nil`
  - Clean URL `"https://youtu.be/abc"` → `"https://youtu.be/abc"`
  - Prefix text `"hey watch this https://youtu.be/abc"` → `"https://youtu.be/abc"`
  - Two URLs `"https://foo.com https://youtu.be/abc"` → `"https://youtu.be/abc"` (last wins)
  - Trailing comma `"see https://youtu.be/abc, thanks"` → `"https://youtu.be/abc"`
  - Trailing period `"watch https://youtu.be/abc."` → `"https://youtu.be/abc"`
  - Trailing paren `"(https://youtu.be/abc)"` → `"https://youtu.be/abc"`
  - `http://` scheme `"http://example.com/x.mp4"` → `"http://example.com/x.mp4"`
  - Non-string input `nil` → `nil` (guard clause)
- [ ] Run `mix test test/byob/media_item_test.exs` — confirm all new tests fail (function undefined).
- [ ] Add `extract_url/1` implementation:
  ```elixir
  @trailing_punct ~c",.;:)]}>\"'"

  def extract_url(text) when is_binary(text) do
    case Regex.scan(~r{https?://\S+}, text) do
      [] -> nil
      matches ->
        [[url]] = [List.last(matches)]
        String.trim_trailing(url, @trailing_punct)
    end
  end

  def extract_url(_), do: nil
  ```
  Note: `String.trim_trailing/2` with a charlist trims any of those characters from the end — handles `"abc.,"` too.
- [ ] Run tests again. All green.
- [ ] `mix format`.
- [ ] Commit: `parser: add MediaItem.extract_url/1`

### 1.2 DRM site classification

- [ ] In the same test file, add a `describe "parse_url/1 DRM sites"` block. Include tests for at least: Netflix, Disney+, Max, HBO Max (old domain), Hulu, Prime Video, Apple TV+, Peacock, Paramount+. Each expects `{:error, :drm_site, service_name}` with the correct service name.
  - Example:
    ```elixir
    test "netflix returns drm_site" do
      assert {:error, :drm_site, "Netflix"} =
        MediaItem.parse_url("https://www.netflix.com/watch/12345")
    end
    ```
- [ ] **Update the existing test** `"another non-youtube URL"` (currently expects `:extension_required` for Netflix) to match the new behavior. Rename or rewrite; don't leave a lying test.
- [ ] Run tests — new tests fail, updated test also fails.
- [ ] Add the `@drm_hosts` map (module attribute, full list from the design spec).
- [ ] Update `classify/2` in `media_item.ex`:
  - Before the existing `cond` branches, check `Map.has_key?(@drm_hosts, host)`.
  - When matched, return `{:drm_site, Map.fetch!(@drm_hosts, host)}`.
  - The outer `parse_url/1` needs to translate this to `{:error, :drm_site, service}`. Restructure so the `{source_type, source_id}` tuple is only built for the `{:ok, ...}` case — easiest via `case classify(...) do` at the call site.
- [ ] Run tests. All green.
- [ ] `mix format`.
- [ ] Commit: `parser: flag DRM sites with error reason`

### 1.3 Self-reference classification

- [ ] Add tests in a `describe "parse_url/1 self-reference"` block:
  - `"https://byob.video/room/abc"` → `{:error, :self_reference}`
  - `"https://www.byob.video"` → `{:error, :self_reference}`
  - A URL with the runtime host: read `Application.get_env(:byob, ByobWeb.Endpoint)[:url][:host]` in the test and assert a URL with that host returns self-reference. In test env the host may be `"localhost"` or similar — the test should work regardless.
- [ ] Run tests — self-reference tests fail.
- [ ] Update `classify/2`:
  - Compute the set of "self" hosts at call time: `["byob.video", "www.byob.video", Application.get_env(:byob, ByobWeb.Endpoint)[:url][:host]]` filtered of `nil`.
  - Check before DRM and before `:extension_required`.
  - Return `:self_reference` atom, translated to `{:error, :self_reference}` at the `parse_url/1` level.
- [ ] Run tests. All green.
- [ ] `mix format`.
- [ ] Commit: `parser: flag byob self-reference URLs`

### 1.4 Invalid URL tightening

- [ ] Add tests:
  - `"javascript:alert(1)"` → `{:error, :invalid_url}`
  - `"data:text/html,x"` → `{:error, :invalid_url}`
  - `"file:///etc/passwd"` → `{:error, :invalid_url}`
- [ ] These may already pass because `parse_url/1` requires `scheme in ["http", "https"]`. Run to confirm.
- [ ] If they already pass, no code change needed. Still commit the tests:
- [ ] Commit: `parser: cover non-http schemes in invalid_url tests`

---

## Phase 2 — Event handlers

All changes in `lib/byob_web/live/room_live/url_preview.ex`.

### 2.1 `handle_preview_url` routing

- [ ] In `handle_preview_url/2`:
  - Top of function: `extracted = Byob.MediaItem.extract_url(url)` (before the `String.trim/1` check — extract operates on the raw string).
  - If the raw `url` is empty after `String.trim/1`: reset everything (existing behavior) including the two new assigns: `url_preview_error: nil, resolved_url: nil`.
  - If `extracted == nil` and raw is non-empty: assign `url_preview_error: :invalid_url, url_preview: nil, url_preview_loading: false, preview_url: url, resolved_url: nil`. Return.
  - Otherwise call `Byob.MediaItem.parse_url(extracted)`.
  - Replace the existing case. Success clauses set `url_preview_error: nil, resolved_url: extracted, preview_url: url`. Error clauses:
    - `{:error, :self_reference}` → `url_preview_error: :self_reference, url_preview: nil, url_preview_loading: false, resolved_url: nil, preview_url: url`
    - `{:error, :drm_site, service}` → `url_preview_error: {:drm_site, service}, ...` same nil'd fields
    - `{:error, :invalid_url}` → `url_preview_error: :invalid_url, ...`
    - Any other `_` fallback → treat as `:invalid_url` for safety
- [ ] Also handle the existing `{:error, :invalid_url}` from `parse_url/1` (guard clauses for non-string input) — same as `:invalid_url` branch above.
- [ ] Compile: `mix compile --warnings-as-errors`.
- [ ] Start dev server briefly to sanity-check (`mix phx.server`, hit /, poke the URL field with a DRM URL, quit). Optional — if the UI isn't in yet (it's not until Phase 4), skip.
- [ ] Commit: `url_preview: route parse errors into url_preview_error`

### 2.2 Submit handlers use `resolved_url`

- [ ] In `handle_add_url/2`:
  - The form submit delivers the raw `url`. Extract first: `resolved = Byob.MediaItem.extract_url(url)`.
  - If `resolved == nil`, return `{:noreply, socket}` without queueing. Don't reset assigns — let the error card stay visible.
  - Otherwise call `RoomServer.add_to_queue(..., resolved, mode_atom)` and reset assigns (including the two new ones).
- [ ] In `handle_play_now/2` and `handle_queue/2`:
  - Replace `socket.assigns.preview_url` with `socket.assigns[:resolved_url]`.
  - Keep the existing `if url = ... do` guard — it now falls through when `resolved_url` is nil, which is the desired no-op.
  - On success, also reset `url_preview_error: nil, resolved_url: nil`.
- [ ] Compile clean.
- [ ] Commit: `url_preview: submit resolved_url instead of raw input`

---

## Phase 3 — LiveView state wiring

All changes in `lib/byob_web/live/room_live.ex`.

### 3.1 Initial assigns

- [ ] Add `resolved_url: nil,` and `url_preview_error: nil,` to the initial `assign/2` call (near `preview_url`).
- [ ] Compile clean.

### 3.2 `clear_url` handler

- [ ] Update the handler body to reset the new assigns too:
  ```elixir
  {:noreply, assign(socket,
    url_preview: nil,
    url_preview_loading: false,
    preview_url: nil,
    url_preview_error: nil,
    resolved_url: nil
  )}
  ```
- [ ] Compile clean.

### 3.3 Pass assigns to `room_nav`

- [ ] Update the `<Components.room_nav ...>` call in `render/1` to include `url_preview_error={@url_preview_error}` and `resolved_url={@resolved_url}`. (`resolved_url` is used by the component only for `data-` attributes — see Phase 4.)
- [ ] Compile clean.
- [ ] Commit: `room_live: wire url_preview_error and resolved_url assigns`

---

## Phase 4 — UI components

All changes in `lib/byob_web/live/room_live/components.ex`.

### 4.1 Attr declarations

- [ ] On `room_nav/1`: add `attr :url_preview_error, :any, default: nil` and `attr :resolved_url, :any, default: nil`.
- [ ] On `url_preview_dropdown/1`: add `attr :url_preview_error, :any, default: nil`.
- [ ] `room_nav` must pass `url_preview_error={@url_preview_error}` to `<.url_preview_dropdown />`.
- [ ] Compile clean.

### 4.2 Instant loading skeleton

The skeleton already exists inside `url_preview_dropdown/1` — it's the `animate-pulse` block gated by `@url_preview_loading`. Goal: keep the server-driven path AND add an instant CSS fallback that fires the moment the input has text.

- [ ] In `url_preview_dropdown/1`, change the outer wrapper `:if` to include the error case:
  ```elixir
  :if={@url_preview_loading || @url_preview || @url_preview_error}
  ```
- [ ] Add a **second** skeleton wrapper (sibling of the existing dropdown, inside `room_nav/1`, alongside the `url_preview_dropdown` call). This one renders unconditionally and uses Tailwind's `:has()` variants for instant visibility:
  ```heex
  <%!-- Instant CSS-driven skeleton: fills the 300ms debounce gap --%>
  <div
    class="hidden group-[:has(input:not(:placeholder-shown))]:flex absolute top-full left-0 right-0 mt-1 bg-base-200 rounded-lg shadow-xl border border-base-300 z-40 items-center gap-3 p-3 animate-pulse pointer-events-none"
    aria-hidden="true"
  >
    <div class="w-16 h-10 bg-base-300 rounded flex-shrink-0" />
    <div class="flex-1 space-y-2">
      <div class="h-3 bg-base-300 rounded w-3/4" />
      <div class="h-2 bg-base-300 rounded w-1/2" />
    </div>
  </div>
  ```
  Note the `z-40` — the resolved dropdown has `z-50` so when the server response renders, it stacks on top. `pointer-events-none` prevents this from blocking clicks.
- [ ] Also remove the `animate-pulse` skeleton from inside `url_preview_dropdown/1`'s `@url_preview_loading` branch — it's now the CSS-driven one plus the resolved content. Wait: the server-driven skeleton still serves a purpose (it's shown during the fetch for `:youtube` / `:extension_required` where metadata takes seconds). Keep it. The CSS skeleton is purely a 300ms bridge.
- [ ] Actually — simpler: the CSS skeleton and the `@url_preview_loading` skeleton look identical. Consolidate: the CSS skeleton renders whenever the input has text AND no preview/error is resolved. The `:if={@url_preview_loading}` branch can stay since `url_preview_loading=true` correlates with "server is fetching" and the CSS skeleton will hide once preview/error renders. They overlap cleanly — both show during loading, only one shows on resolution.
- [ ] To prevent a visible double-skeleton (the one inside `url_preview_dropdown` overlapping the CSS one), hide the CSS skeleton when the dropdown is rendered. Easiest: wrap the CSS skeleton in `:if={!@url_preview && !@url_preview_error && !@url_preview_loading}`. That keeps the instant CSS behavior (before server responds, none of those are true) and hides it once server state catches up.
- [ ] Compile clean. Start dev server, type into URL field with throttled network if possible. Verify: skeleton appears on first keystroke, transitions cleanly to preview or error.
- [ ] Commit: `components: instant loading skeleton for URL input`

### 4.3 Error card

Inside `url_preview_dropdown/1`, after the existing preview variant blocks and before the closing `</div>`:

- [ ] Add:
  ```heex
  <%!-- Error card --%>
  <div
    :if={@url_preview_error}
    class="flex items-center gap-2 p-3"
  >
    <svg
      class={"w-5 h-5 flex-shrink-0 " <> error_icon_color(@url_preview_error)}
      fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
    >
      <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
    </svg>
    <p class="text-sm text-base-content/80">{error_message(@url_preview_error)}</p>
  </div>
  ```
- [ ] Add private helpers at the bottom of the module (or wherever helpers live; colocate with `url_preview_dropdown/1`):
  ```elixir
  defp error_message(:self_reference),
    do: "That's a byob room link — paste a video URL instead."
  defp error_message({:drm_site, service}),
    do: "#{service} uses DRM and can't be synced."
  defp error_message(:invalid_url),
    do: "Doesn't look like a video URL."

  defp error_icon_color({:drm_site, _}), do: "text-warning"
  defp error_icon_color(:self_reference), do: "text-warning"
  defp error_icon_color(:invalid_url), do: "text-base-content/50"
  ```
- [ ] Compile clean.
- [ ] Start dev server, manually verify each error path:
  - Paste `https://byob.video/room/x` → self-reference copy.
  - Paste `https://www.netflix.com/watch/1` → "Netflix uses DRM…".
  - Type `hello` → "Doesn't look like a video URL" (after 300ms).
  - Paste `hey watch this https://youtu.be/dQw4w9WgXcQ` → YouTube preview (extraction works end-to-end).
- [ ] Commit: `components: error card for rejected URLs`

---

## Phase 5 — Verification

- [ ] `mix format`
- [ ] `mix compile --warnings-as-errors`
- [ ] `mix test` — all green, including the updated Netflix test.
- [ ] Manual smoke test in browser:
  - Focus empty field → placeholder hint appears instantly (existing behavior, not regressed).
  - Start typing → skeleton appears on first keystroke (not after 300ms).
  - Finish typing a YouTube URL → preview card with Play Now / Queue.
  - Click Play Now / Queue buttons with mixed-text input like `hey https://youtu.be/abc` → queued URL is the extracted one.
  - Enter key on invalid input → nothing queued, error card remains.
  - Clear button → full reset.
- [ ] Final commit if any formatting / small fixes: `ux: URL preview polish`

---

## Out of scope (explicitly)

- Auto-prepending `https://` — separate change.
- Client-side URL parsing — single source of truth in Elixir.
- DRM detection at runtime (via extension ping) — static list only.
- Changing the existing supported-sites placeholder UI.
- Adding LiveView integration tests — repo currently has none for this component.

## Rollback

If this introduces a regression in production, revert the branch. No schema or config changes; no migration needed.
