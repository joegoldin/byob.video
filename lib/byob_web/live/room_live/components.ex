defmodule ByobWeb.RoomLive.Components do
  @moduledoc """
  Function components extracted from the RoomLive render/1 template.

  Covers: room_nav, settings_modal, url_preview_dropdown, queue_panel,
  history_panel, activity_log, users_card, and sb_row.
  """

  use Phoenix.Component

  use Phoenix.VerifiedRoutes,
    endpoint: ByobWeb.Endpoint,
    router: ByobWeb.Router,
    statics: ByobWeb.static_paths()

  # ── Room Nav Bar ─────────────────────────────────────────────────

  attr :room_id, :string, required: true
  attr :url_preview_loading, :boolean, required: true
  attr :url_preview, :any, default: nil
  attr :url_preview_error, :any, default: nil
  attr :preview_url, :string, default: nil
  attr :resolved_url, :string, default: nil

  def room_nav(assigns) do
    ~H"""
    <nav
      id="room-nav"
      phx-hook="ReplaceLayoutNav"
      class="navbar min-h-0 h-10 bg-base-200 border-b border-base-300 px-2 sm:px-4"
      style="margin: -0.5rem -1rem 0.5rem -1rem; width: calc(100% + 2rem);"
    >
      <div class="flex-1 flex items-center gap-2">
        <a href="/" class="flex items-center gap-1.5 flex-shrink-0">
          <img src={~p"/images/favicon.svg"} class="w-5 h-5" />
          <span class="text-base font-bold tracking-tight">byob</span>
        </a>
        <button
          id="copy-url"
          onclick={"
            var btn = this;
            navigator.clipboard.writeText('#{url(~p"/room/#{@room_id}")}').then(function() {
              var svg = btn.querySelector('svg');
              btn.textContent = 'Copied!';
              if (svg) btn.prepend(svg);
              setTimeout(function() {
                btn.lastChild.textContent = ' Copy Room Link';
              }, 1500);
            });
          "}
          class="btn btn-ghost btn-sm gap-1 text-base-content/60 flex-shrink-0"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
            />
          </svg>
          <span class="hidden sm:inline">Copy Room Link</span>
        </button>
        <div class="relative flex-1 min-w-0 max-w-[40vw] group">
          <form phx-submit="add_url" phx-change="preview_url" id="url-form">
            <input type="hidden" name="mode" value="queue" id="url-form-mode" />
            <div class="relative flex items-center" id="url-input-wrapper">
              <input
                type="text"
                name="url"
                value={@preview_url || ""}
                placeholder="Paste a video URL..."
                class="input input-bordered input-xs w-full pr-6"
                autocomplete="off"
                phx-debounce="300"
                oninput="this.parentElement.querySelector('.url-clear-btn').classList.toggle('hidden', !this.value)"
              />
              <button
                id="url-clear-btn"
                type="button"
                phx-click="clear_url"
                onmousedown="event.preventDefault()"
                class={"url-clear-btn absolute inset-y-0 right-0 flex items-center pr-2 text-base-content/30 hover:text-base-content/60 transition-colors #{if !@preview_url || @preview_url == "", do: "hidden"}"}
              >
                <svg
                  class="w-3 h-3"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  stroke-width="2.5"
                >
                  <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </form>
          <%!-- Supported sites hint (shown on focus with empty input) --%>
          <div
            :if={!@url_preview_loading && !@url_preview && !@url_preview_error}
            class="hidden group-[&:focus-within:has(input[name=url]:placeholder-shown)]:block absolute top-full left-0 right-0 mt-1 bg-base-200 rounded-lg shadow-xl border border-base-300 z-50 p-3"
          >
            <p class="text-xs font-semibold text-base-content/60 mb-2">
              Paste a URL to watch together
            </p>
            <div class="space-y-1.5">
              <div class="flex items-center gap-2 text-xs text-base-content/50">
                <svg
                  class="w-4 h-4 flex-shrink-0 text-red-500"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
                </svg>
                <span>
                  YouTube — synced playback with
                  <a href={Byob.Links.sponsor_block()} target="_blank" class="link link-primary">
                    SponsorBlock
                  </a>
                </span>
              </div>
              <div class="flex items-center gap-2 text-xs text-base-content/50">
                <svg
                  class="w-4 h-4 flex-shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <circle cx="12" cy="12" r="10" />
                  <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
                </svg>
                <span>Direct video files — .mp4, .webm, .ogg, .mov, .mkv</span>
              </div>
              <div class="flex items-center gap-2 text-xs text-base-content/50">
                <svg
                  class="w-4 h-4 flex-shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25"
                  />
                </svg>
                <span>Any site — via browser extension (Crunchyroll, etc.)</span>
              </div>
            </div>
          </div>
          <%!-- Instant CSS-driven skeleton: fills the 300ms debounce gap --%>
          <div
            :if={!@url_preview && !@url_preview_error && !@url_preview_loading}
            class="hidden group-[&:focus-within:has(input[name=url]:not(:placeholder-shown))]:flex absolute top-full left-0 right-0 mt-1 bg-base-200 rounded-lg shadow-xl border border-base-300 z-40 items-center gap-3 p-3 pointer-events-none"
            aria-hidden="true"
          >
            <div class="w-16 h-10 bg-base-300 rounded flex-shrink-0 animate-pulse" />
            <div class="flex-1 space-y-2">
              <div class="h-3 bg-base-300 rounded w-3/4 animate-pulse" />
              <div class="h-2 bg-base-300 rounded w-1/2 animate-pulse" />
            </div>
          </div>
          <%!-- Preview dropdown --%>
          <.url_preview_dropdown
            url_preview_loading={@url_preview_loading}
            url_preview={@url_preview}
            url_preview_error={@url_preview_error}
          />
        </div>
      </div>
      <div class="flex-none flex items-center gap-1">
        <button
          class="btn btn-ghost btn-xs btn-circle"
          onclick="document.getElementById('sb-settings-modal')?.showModal()"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="2"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
        <label class="swap swap-rotate btn btn-ghost btn-xs btn-circle">
          <input
            type="checkbox"
            id="theme-toggle-room"
            onchange="document.documentElement.setAttribute('data-theme', this.checked ? 'dark' : 'light'); localStorage.setItem('phx:theme', this.checked ? 'dark' : 'light')"
          />
          <svg
            class="swap-off h-4 w-4 fill-current"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
          >
            <path d="M5.64,17l-.71.71a1,1,0,0,0,0,1.41,1,1,0,0,0,1.41,0l.71-.71A1,1,0,0,0,5.64,17ZM5,12a1,1,0,0,0-1-1H3a1,1,0,0,0,0,2H4A1,1,0,0,0,5,12Zm7-7a1,1,0,0,0,1-1V3a1,1,0,0,0-2,0V4A1,1,0,0,0,12,5ZM5.64,7.05a1,1,0,0,0,.7.29,1,1,0,0,0,.71-.29,1,1,0,0,0,0-1.41l-.71-.71A1,1,0,0,0,4.93,6.34Zm12,.29a1,1,0,0,0,.7-.29l.71-.71a1,1,0,1,0-1.41-1.41L17,5.64a1,1,0,0,0,0,1.41A1,1,0,0,0,17.66,7.34ZM21,11H20a1,1,0,0,0,0,2h1a1,1,0,0,0,0-2Zm-9,8a1,1,0,0,0-1,1v1a1,1,0,0,0,2,0V20A1,1,0,0,0,12,19ZM18.36,17A1,1,0,0,0,17,18.36l.71.71a1,1,0,0,0,1.41,0,1,1,0,0,0,0-1.41ZM12,6.5A5.5,5.5,0,1,0,17.5,12,5.51,5.51,0,0,0,12,6.5Zm0,9A3.5,3.5,0,1,1,15.5,12,3.5,3.5,0,0,1,12,15.5Z" />
          </svg>
          <svg
            class="swap-on h-4 w-4 fill-current"
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
          >
            <path d="M21.64,13a1,1,0,0,0-1.05-.14,8.05,8.05,0,0,1-3.37.73A8.15,8.15,0,0,1,9.08,5.49a8.59,8.59,0,0,1,.25-2A1,1,0,0,0,8,2.36,10.14,10.14,0,1,0,22,14.05,1,1,0,0,0,21.64,13Zm-9.5,6.69A8.14,8.14,0,0,1,7.08,5.22v.27A10.15,10.15,0,0,0,17.22,15.63a9.79,9.79,0,0,0,2.1-.22A8.11,8.11,0,0,1,12.14,19.73Z" />
          </svg>
        </label>
      </div>
    </nav>
    """
  end

  # ── Settings Modal ─────────────────────────────────────────────────

  attr :sb_settings, :any, required: true
  attr :api_key, :any, default: nil
  attr :show_comments, :boolean, default: true

  def settings_modal(assigns) do
    ~H"""
    <dialog id="sb-settings-modal" class="modal">
      <div class="modal-box max-w-md relative">
        <form method="dialog">
          <button class="btn btn-sm btn-circle btn-ghost absolute right-3 top-3">✕</button>
        </form>
        <%!-- About section --%>
        <div class="flex flex-col items-center mb-4 p-3 bg-base-100 rounded-xl">
          <img src={~p"/images/logo.svg"} class="w-64 h-64" />
        </div>
        <div class="text-xs text-base-content/50 space-y-1 mb-4 pb-4 border-b border-base-300 text-center">
          <p>
            <a
              href={Byob.Links.source_code()}
              target="_blank"
              class="text-base-content/50 hover:text-base-content/70"
              title="Source on GitHub"
            >
              <svg class="w-4 h-4 inline" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
            </a>
            <span class="mx-1">&middot;</span>
            <a href={Byob.Links.privacy_policy()} target="_blank" class="link link-primary">
              Privacy
            </a>
            <span class="mx-1">&middot;</span>
            <a
              href="https://github.com/joegoldin/byob.video/blob/main/CHANGELOG.md"
              target="_blank"
              class="link link-primary"
            >
              v{Application.spec(:byob, :vsn)}
            </a>
          </p>
        </div>

        <%!-- YouTube Comments toggle --%>
        <div class="flex items-center justify-between mb-4 pb-4 border-b border-base-300">
          <div>
            <h4 class="font-semibold text-sm">YouTube Comments</h4>
            <p class="text-xs text-base-content/50">Show comments below the video player</p>
          </div>
          <input
            type="checkbox"
            class="toggle toggle-sm toggle-primary"
            checked={@show_comments}
            phx-click="toggle_comments"
          />
        </div>

        <%!-- SponsorBlock settings --%>
        <h3 class="font-bold text-lg mb-1">
          <a href={Byob.Links.sponsor_block()} target="_blank" class="link">SponsorBlock</a> Settings
        </h3>
        <p class="text-xs text-base-content/50 mb-4">
          Settings apply to this room for all users.
        </p>
        <div class="space-y-2">
          <.sb_row
            :for={{cat, action} <- @sb_settings}
            category={cat}
            action={action}
          />
        </div>
        <%!-- Room API Key --%>
        <div :if={@api_key} class="mt-4 pt-4 border-t border-base-300">
          <h4 class="font-semibold text-sm mb-2">Room API Key</h4>
          <div class="flex items-center gap-2">
            <code class="text-xs bg-base-100 px-2 py-1 rounded flex-1 truncate select-all">
              {@api_key}
            </code>
            <button
              onclick={"navigator.clipboard.writeText('#{@api_key}')"}
              class="btn btn-xs btn-ghost"
            >
              Copy
            </button>
          </div>
          <a href="/api" target="_blank" class="text-xs link link-primary mt-1 block">
            API Documentation
          </a>
        </div>
        <%!-- Attribution --%>
        <div class="mt-4 pt-4 border-t border-base-300 text-xs text-base-content/40 space-y-1">
          <p>
            <a href={Byob.Links.sponsor_block()} target="_blank" class="link link-primary">
              SponsorBlock
            </a>
            API by
            <a href="https://ajay.app" target="_blank" class="link link-primary">Ajay Ramachandran</a>
            (GPLv3)
          </p>
          <p>
            Built with <a
              href="https://phoenixframework.org"
              target="_blank"
              class="link link-primary"
            >Phoenix</a>, <a href="https://daisyui.com" target="_blank" class="link link-primary">daisyUI</a>,
            and
            <a href="https://tailwindcss.com" target="_blank" class="link link-primary">
              Tailwind CSS
            </a>
          </p>
          <p>
            byob.video is
            <a href={Byob.Links.source_code()} target="_blank" class="link link-primary">
              open source
            </a>
            under MIT License
          </p>
        </div>
      </div>
      <form method="dialog" class="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
    """
  end

  # ── URL Preview Dropdown ──────────────────────────────────────────

  attr :url_preview_loading, :boolean, required: true
  attr :url_preview, :any, default: nil
  attr :url_preview_error, :any, default: nil

  def url_preview_dropdown(assigns) do
    ~H"""
    <div
      :if={@url_preview_loading || @url_preview || @url_preview_error}
      onmousedown="event.preventDefault()"
      class="hidden group-focus-within:block absolute top-full left-0 right-0 mt-1 bg-base-200 rounded-lg shadow-xl border border-base-300 z-50"
    >
      <div :if={@url_preview_loading} class="flex items-center gap-3 p-3">
        <div class="w-16 h-10 bg-base-300 rounded flex-shrink-0 animate-pulse" />
        <div class="flex-1 space-y-2">
          <div class="h-3 bg-base-300 rounded w-3/4 animate-pulse" />
          <div class="h-2 bg-base-300 rounded w-1/2 animate-pulse" />
        </div>
      </div>
      <div
        :if={@url_preview && @url_preview.source_type == :youtube}
        class="flex items-center gap-2 p-3"
      >
        <div :if={@url_preview.thumbnail_url} class="relative flex-shrink-0">
          <img
            src={@url_preview.thumbnail_url}
            class="w-16 h-10 object-cover rounded"
          />
          <span
            :if={format_duration(@url_preview[:duration])}
            class="absolute bottom-0.5 right-0.5 px-1 py-px text-[9px] leading-none font-semibold text-white bg-black/75 rounded"
          >
            {format_duration(@url_preview[:duration])}
          </span>
        </div>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium line-clamp-3">{@url_preview.title || "YouTube video"}</p>
          <p :if={@url_preview.author_name} class="text-xs text-base-content/50">
            {@url_preview.author_name}
            <%= if format_relative_date(@url_preview[:published_at]) do %>
              <span class="text-base-content/30">
                · {format_relative_date(@url_preview[:published_at])}
              </span>
            <% end %>
          </p>
          <p
            :if={!@url_preview.author_name && format_relative_date(@url_preview[:published_at])}
            class="text-xs text-base-content/50"
          >
            {format_relative_date(@url_preview[:published_at])}
          </p>
        </div>
        <div class="flex gap-1 flex-shrink-0">
          <button
            type="submit"
            form="url-form"
            onmousedown="event.preventDefault()"
            onclick="document.getElementById('url-form-mode').value='now'; document.querySelector('input[name=url]').blur();"
            class="btn btn-primary btn-xs"
          >
            Play Now
          </button>
          <button
            type="submit"
            form="url-form"
            onmousedown="event.preventDefault()"
            onclick="document.getElementById('url-form-mode').value='queue'; document.querySelector('input[name=url]').blur();"
            class="btn btn-outline btn-xs"
          >
            Queue
          </button>
        </div>
      </div>
      <%!-- Direct URL preview --%>
      <div
        :if={@url_preview && @url_preview.source_type == :direct_url}
        class="flex items-center gap-2 p-3"
      >
        <div class="w-16 h-10 bg-base-300 rounded flex-shrink-0 flex items-center justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-5 w-5 text-base-content/30"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            stroke-width="1.5"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M15.91 11.672a.375.375 0 010 .656l-5.603 3.113a.375.375 0 01-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112z"
            />
          </svg>
        </div>
        <div class="flex-1 min-w-0">
          <p :if={@url_preview.title} class="text-sm font-medium line-clamp-3">
            {@url_preview.title}
          </p>
          <p :if={!@url_preview.title} class="text-sm font-medium truncate">
            {@url_preview.url || "Direct video"}
          </p>
          <p class="text-xs text-base-content/50">Direct video file</p>
        </div>
        <div class="flex gap-1 flex-shrink-0">
          <button
            type="submit"
            form="url-form"
            onmousedown="event.preventDefault()"
            onclick="document.getElementById('url-form-mode').value='now'; document.querySelector('input[name=url]').blur();"
            class="btn btn-primary btn-xs"
          >
            Play Now
          </button>
          <button
            type="submit"
            form="url-form"
            onmousedown="event.preventDefault()"
            onclick="document.getElementById('url-form-mode').value='queue'; document.querySelector('input[name=url]').blur();"
            class="btn btn-outline btn-xs"
          >
            Queue
          </button>
        </div>
      </div>
      <%!-- Extension-required preview --%>
      <div
        :if={@url_preview && @url_preview.source_type == :extension_required}
        class="flex items-center gap-2 p-3"
      >
        <img
          :if={@url_preview.thumbnail_url}
          src={@url_preview.thumbnail_url}
          class="w-16 h-10 object-cover rounded flex-shrink-0"
        />
        <div
          :if={!@url_preview.thumbnail_url}
          class="w-16 h-10 bg-base-300 rounded flex-shrink-0 flex items-center justify-center"
        >
          <span class="text-xs text-base-content/30">EXT</span>
        </div>
        <div class="flex-1 min-w-0">
          <p :if={@url_preview.title} class="text-sm font-medium line-clamp-3">
            {@url_preview.title}
          </p>
          <p :if={!@url_preview.title} class="text-sm font-medium">External site</p>
          <p class="text-xs text-warning byob-no-ext">
            <a href="#" onclick={"#{Byob.Links.extension_js()}; return false;"} class="underline">
              Extension required
            </a>
            to sync this site
          </p>
        </div>
        <div class="flex gap-1 flex-shrink-0">
          <button
            type="submit"
            form="url-form"
            onmousedown="event.preventDefault()"
            onclick="document.getElementById('url-form-mode').value='now'; document.querySelector('input[name=url]').blur();"
            class="btn btn-primary btn-xs"
          >
            Play Now
          </button>
          <button
            type="submit"
            form="url-form"
            onmousedown="event.preventDefault()"
            onclick="document.getElementById('url-form-mode').value='queue'; document.querySelector('input[name=url]').blur();"
            class="btn btn-outline btn-xs"
          >
            Queue
          </button>
        </div>
      </div>
      <%!-- Error card --%>
      <div :if={@url_preview_error} class="flex items-center gap-2 p-3">
        <svg
          class={"w-5 h-5 flex-shrink-0 " <> error_icon_color(@url_preview_error)}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          stroke-width="2"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
          />
        </svg>
        <p class="text-sm text-base-content/80">{error_message(@url_preview_error)}</p>
      </div>
    </div>
    """
  end

  defp error_message(:self_reference),
    do: "That's a byob room link — paste a video URL instead."

  defp error_message({:drm_site, service}),
    do: "#{service} uses DRM and can't be synced."

  defp error_message(:invalid_url), do: "Doesn't look like a video URL."
  defp error_message(_), do: "Doesn't look like a video URL."

  defp error_icon_color(:self_reference), do: "text-warning"
  defp error_icon_color({:drm_site, _}), do: "text-warning"
  defp error_icon_color(_), do: "text-base-content/50"

  # ── Queue Panel ───────────────────────────────────────────────────

  attr :queue, :list, required: true
  attr :current_index, :integer, default: nil

  def queue_panel(assigns) do
    ~H"""
    <div
      :if={@queue != []}
      class="overflow-y-auto flex-1 space-y-2"
    >
      <%!-- Now Playing --%>
      <div :if={@current_index != nil && Enum.at(@queue, @current_index)} class="mb-1">
        <div class="text-xs font-semibold text-primary uppercase tracking-wide mb-1">
          Now Playing
        </div>
        <% now_playing = Enum.at(@queue, @current_index) %>
        <div
          class="flex items-center gap-2 p-2 rounded-lg bg-primary/10 ring-1 ring-primary/30 text-sm"
          data-url={now_playing.url}
          data-ctx-menu="restart,copy"
          phx-hook="QueueContextMenu"
          id={"now-playing-#{now_playing.id}"}
        >
          <div :if={now_playing.thumbnail_url} class="relative flex-shrink-0">
            <img
              src={now_playing.thumbnail_url}
              class="w-14 h-9 object-cover rounded"
            />
            <span
              :if={format_duration(now_playing.duration)}
              class="absolute bottom-0.5 right-0.5 px-1 py-px text-[9px] leading-none font-semibold text-white bg-black/75 rounded"
            >
              {format_duration(now_playing.duration)}
            </span>
          </div>
          <div
            :if={!now_playing.thumbnail_url}
            class="w-14 h-9 bg-base-300 rounded flex-shrink-0 flex items-center justify-center"
          >
            <span class="text-xs text-base-content/30">?</span>
          </div>
          <div class="flex-1 min-w-0">
            <span
              :if={now_playing.title}
              title={now_playing.title}
              class="block text-sm font-medium line-clamp-3"
            >
              {now_playing.title}
            </span>
            <span
              :if={show_url?(now_playing)}
              title={now_playing.url}
              class="block text-xs text-base-content/50 line-clamp-2"
            >
              {now_playing.url}
            </span>
            <span :if={now_playing.added_by_name} class="block text-xs text-base-content/40 mt-0.5">
              {now_playing.added_by_name}
              <time
                :if={format_time(now_playing.added_at)}
                datetime={format_time(now_playing.added_at)}
                phx-hook="LocalTime"
                id={"time-np-#{now_playing.id}"}
              >
              </time>
            </span>
          </div>
        </div>
      </div>

      <%!-- Up Next --%>
      <% up_next =
        @queue
        |> Enum.with_index()
        |> Enum.filter(fn {_item, idx} -> idx > (@current_index || -1) end) %>
      <div :if={up_next != []}>
        <div class="text-xs font-semibold text-base-content/40 uppercase tracking-wide mb-1">
          Up Next
        </div>
        <ul class="space-y-1" id="queue-sortable" phx-hook="DragSort">
          <li
            :for={{item, idx} <- up_next}
            draggable="true"
            data-queue-idx={idx}
            data-queue-index={idx}
            data-item-id={item.id}
            data-url={item.url}
            data-ctx-menu="play-now-queue,remove,copy"
            phx-hook="QueueContextMenu"
            id={"queue-item-#{item.id}"}
            class="flex items-center gap-2 p-2 rounded-lg text-sm hover:bg-base-300 transition-colors cursor-grab active:cursor-grabbing"
          >
            <span class="text-base-content/20 flex-shrink-0 text-xs select-none">&#x2807;</span>
            <div :if={item.thumbnail_url} class="relative flex-shrink-0">
              <img
                src={item.thumbnail_url}
                class="w-14 h-9 object-cover rounded"
              />
              <span
                :if={format_duration(item.duration)}
                class="absolute bottom-0.5 right-0.5 px-1 py-px text-[9px] leading-none font-semibold text-white bg-black/75 rounded"
              >
                {format_duration(item.duration)}
              </span>
            </div>
            <div
              :if={!item.thumbnail_url}
              class="w-14 h-9 bg-base-300 rounded flex-shrink-0 flex items-center justify-center"
            >
              <span class="text-xs text-base-content/30">?</span>
            </div>
            <button
              phx-click="queue:play_index"
              phx-value-index={idx}
              class="flex-1 text-left min-w-0"
            >
              <span :if={item.title} title={item.title} class="block text-xs font-medium line-clamp-2">
                {item.title}
              </span>
              <span :if={!item.title} class="block text-xs text-base-content/50 truncate">
                {item.url}
              </span>
              <span :if={item.added_by_name} class="block text-[10px] text-base-content/40 mt-0.5">
                {item.added_by_name}
                <time
                  :if={format_time(item.added_at)}
                  datetime={format_time(item.added_at)}
                  phx-hook="LocalTime"
                  id={"time-q-#{item.id}"}
                >
                </time>
              </span>
            </button>
            <button
              phx-click="queue:remove"
              phx-value-item_id={item.id}
              class="btn btn-xs btn-ghost btn-circle opacity-50 hover:opacity-100"
            >
              x
            </button>
          </li>
        </ul>
      </div>
    </div>
    <p
      :if={@queue == []}
      class="text-sm text-base-content/40 flex-1 flex items-center justify-center"
    >
      No videos in queue
    </p>
    """
  end

  # ── History Panel ─────────────────────────────────────────────────

  attr :history, :list, required: true

  def history_panel(assigns) do
    ~H"""
    <ul
      :if={@history != []}
      class="space-y-2 overflow-y-auto flex-1"
    >
      <li
        :for={entry <- @history}
        phx-click="history:play"
        phx-value-url={entry.item.url}
        data-url={entry.item.url}
        data-ctx-menu="play-now-history,requeue,copy"
        phx-hook="QueueContextMenu"
        id={"history-item-#{entry.item.id}-#{DateTime.to_unix(entry.played_at, :millisecond)}"}
        class="flex items-center gap-2 p-2 rounded-lg text-sm hover:bg-base-300 transition-colors cursor-pointer"
      >
        <div :if={entry.item.thumbnail_url} class="relative flex-shrink-0">
          <img
            src={entry.item.thumbnail_url}
            class="w-14 h-9 object-cover rounded"
          />
          <span
            :if={format_duration(entry.item.duration)}
            class="absolute bottom-0.5 right-0.5 px-1 py-px text-[9px] leading-none font-semibold text-white bg-black/75 rounded"
          >
            {format_duration(entry.item.duration)}
          </span>
        </div>
        <div
          :if={!entry.item.thumbnail_url}
          class="w-14 h-9 bg-base-300 rounded flex-shrink-0 flex items-center justify-center"
        >
          <span class="text-xs text-base-content/30">?</span>
        </div>
        <div class="flex-1 min-w-0">
          <span
            :if={entry.item.title}
            title={entry.item.title}
            class="block text-xs font-medium line-clamp-2"
          >
            {entry.item.title}
          </span>
          <span :if={!entry.item.title} class="block text-xs text-base-content/50 truncate">
            {entry.item.url}
          </span>
          <span class="block text-xs text-base-content/40 mt-0.5">
            {if entry.item.added_by_name, do: entry.item.added_by_name, else: ""}
            <time
              :if={format_time(entry.played_at)}
              datetime={format_time(entry.played_at)}
              phx-hook="LocalTime"
              id={"time-h-#{entry.item.id}-#{System.unique_integer([:positive])}"}
            >
            </time>
          </span>
        </div>
      </li>
    </ul>
    <p
      :if={@history == []}
      class="text-sm text-base-content/40 flex-1 flex items-center justify-center"
    >
      No history yet
    </p>
    """
  end

  # ── Activity Log ──────────────────────────────────────────────────

  attr :activity_log, :list, required: true

  def activity_log(assigns) do
    ~H"""
    <div class="card bg-base-200 flex-shrink-0">
      <div class="card-body p-3">
        <h3 class="card-title text-xs text-base-content/40">Activity</h3>
        <ul
          id="activity-log"
          phx-hook="ScrollBottom"
          class="space-y-0.5 mt-1 max-h-32 overflow-y-auto text-[11px] text-base-content/50 leading-relaxed"
        >
          <li :for={entry <- Enum.reverse(Enum.take(@activity_log, 30))} class="flex gap-1">
            <span :if={entry.action == :joined} class="text-success/60 flex-shrink-0">+</span>
            <span :if={entry.action == :left} class="text-error/60 flex-shrink-0">-</span>
            <span :if={entry.action == :now_playing} class="text-primary/60 flex-shrink-0">
              &#9654;
            </span>
            <span :if={entry.action == :play} class="text-success/60 flex-shrink-0">&#9654;</span>
            <span :if={entry.action == :pause} class="text-warning/60 flex-shrink-0">
              &#10074;&#10074;
            </span>
            <span :if={entry.action == :added} class="text-primary/60 flex-shrink-0">+</span>
            <span :if={entry.action == :skipped} class="text-base-content/40 flex-shrink-0">
              &#9197;
            </span>
            <span :if={entry.action == :seeked} class="text-info/60 flex-shrink-0">&#8644;</span>
            <span :if={entry.action == :renamed} class="text-base-content/40 flex-shrink-0">
              &#9998;
            </span>
            <span class="flex-1 line-clamp-2">{format_log_entry(entry)}</span>
            <time
              :if={entry.at}
              datetime={DateTime.to_iso8601(entry.at)}
              phx-hook="LocalTime"
              id={"log-#{System.unique_integer([:positive])}"}
              class="text-base-content/30 flex-shrink-0 whitespace-nowrap"
            >
            </time>
          </li>
          <li :if={@activity_log == []} class="text-base-content/30 italic">No activity yet</li>
        </ul>
      </div>
    </div>
    """
  end

  # ── Users Card ────────────────────────────────────────────────────

  attr :users, :map, required: true
  attr :user_id, :string, required: true
  attr :editing_username, :boolean, required: true

  def users_card(assigns) do
    ~H"""
    <div class="card bg-base-200 flex-shrink-0">
      <div class="card-body p-4">
        <h3 class="card-title text-sm">
          Users
          <span class="badge badge-sm">
            {@users |> Enum.map(fn {_, u} -> u.username end) |> Enum.uniq() |> length()}
          </span>
        </h3>
        <ul class="space-y-2 mt-1 max-h-48 overflow-y-auto">
          <li
            :for={{uid, user} <- dedup_users(@users, @user_id)}
            data-user-id={uid}
            class="flex items-center gap-2 text-sm"
          >
            <div class={"w-2 h-2 rounded-full flex-shrink-0 #{if user.connected, do: "bg-success", else: "bg-base-content/20"}"} />
            <%!-- Other users: just show name --%>
            <span :if={!is_self_user(uid, @user_id)} class="truncate">{user.username}</span>
            <%!-- Self: show name + tab indicator --%>
            <span
              :if={is_self_user(uid, @user_id) && !@editing_username}
              class="truncate flex-1"
            >
              <span class="font-bold">{user.username}</span>
              <span :if={uid == @user_id} class="text-base-content/40 font-normal">(you)</span>
              <span :if={uid != @user_id} class="text-base-content/30 font-normal text-xs">
                (other tab)
              </span>
            </span>
            <button
              :if={uid == @user_id && !@editing_username}
              phx-click="username:edit"
              class="btn btn-xs btn-ghost opacity-50 hover:opacity-100"
            >
              edit
            </button>
            <form
              :if={uid == @user_id && @editing_username}
              phx-submit="username:change"
              class="flex gap-1 flex-1 min-w-0"
            >
              <input
                type="text"
                name="username"
                value={user.username}
                class="input input-xs input-bordered flex-1 min-w-0"
                autofocus
              />
              <button type="submit" class="btn btn-xs btn-ghost">ok</button>
            </form>
          </li>
        </ul>
      </div>
    </div>
    """
  end

  # ── SponsorBlock Row ──────────────────────────────────────────────

  @sb_labels %{
    "sponsor" => {"Sponsor", "#00d400"},
    "selfpromo" => {"Self Promotion", "#ffff00"},
    "interaction" => {"Interaction", "#cc00ff"},
    "intro" => {"Intro", "#00ffff"},
    "outro" => {"Outro", "#0202ed"},
    "preview" => {"Preview/Recap", "#008fd6"},
    "music_offtopic" => {"Non-Music", "#ff9900"},
    "filler" => {"Filler/Tangent", "#7300FF"}
  }

  attr :category, :string, required: true
  attr :action, :string, required: true

  def sb_row(assigns) do
    {label, color} = Map.get(@sb_labels, assigns.category, {assigns.category, "#888"})
    assigns = assign(assigns, label: label, color: color)

    ~H"""
    <div class="flex items-center gap-3">
      <div class="w-3 h-3 rounded-sm flex-shrink-0" style={"background: #{@color}"} />
      <span class="text-sm flex-1">{@label}</span>
      <form phx-change="sb:update" class="m-0">
        <input type="hidden" name="category" value={@category} />
        <select name="action" class="select select-xs select-bordered w-32">
          <option value="auto_skip" selected={@action == "auto_skip"}>Auto Skip</option>
          <option value="show_bar" selected={@action == "show_bar"}>Show in Bar</option>
          <option value="disabled" selected={@action == "disabled"}>Disabled</option>
        </select>
      </form>
    </div>
    """
  end

  # ── Helper functions ──────────────────────────────────────────────

  def format_log_entry(%{action: :joined, user: user}), do: "#{user} joined"
  def format_log_entry(%{action: :left, user: user}), do: "#{user} left"
  def format_log_entry(%{action: :now_playing, detail: detail}), do: "Now playing: #{detail}"
  def format_log_entry(%{action: :play, user: user, detail: nil}), do: "#{user} resumed"

  def format_log_entry(%{action: :play, user: user, detail: title}),
    do: "#{user} resumed #{title}"

  def format_log_entry(%{action: :pause, user: user, detail: nil}), do: "#{user} paused"

  def format_log_entry(%{action: :pause, user: user, detail: title}),
    do: "#{user} paused #{title}"

  def format_log_entry(%{action: :added, user: user, detail: url}), do: "#{user} added #{url}"

  def format_log_entry(%{action: :seeked, user: user, detail: detail}),
    do: "#{user} seeked #{detail}"

  def format_log_entry(%{action: :skipped}), do: "Skipped to next"
  def format_log_entry(%{action: :renamed, detail: detail}), do: "Renamed: #{detail}"
  def format_log_entry(_), do: nil

  def show_url?(item) do
    has_title = is_binary(item.title) and item.title != ""

    is_youtube =
      is_binary(item.url) and
        (String.contains?(item.url, "youtube.com") or String.contains?(item.url, "youtu.be"))

    not (has_title and is_youtube)
  end

  def dedup_users(users, my_user_id) do
    users
    |> Enum.sort_by(fn {id, u} ->
      {if(is_self_user(id, my_user_id), do: 0, else: 1), if(u.connected, do: 0, else: 1)}
    end)
    |> Enum.uniq_by(fn {_id, u} -> u.username end)
  end

  def is_self_user(uid, my_user_id) do
    [my_base | _] = String.split(my_user_id, ":", parts: 2)
    String.starts_with?(uid, my_base <> ":")
  end

  def format_time(nil), do: nil
  def format_time(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  def format_time(_), do: nil

  @doc """
  Format total seconds as `M:SS` or `H:MM:SS`. Returns `nil` for nil/invalid.
  """
  def format_duration(nil), do: nil

  def format_duration(seconds) when is_integer(seconds) and seconds >= 0 do
    hours = div(seconds, 3600)
    minutes = div(rem(seconds, 3600), 60)
    secs = rem(seconds, 60)

    if hours > 0 do
      :io_lib.format("~B:~2..0B:~2..0B", [hours, minutes, secs]) |> IO.iodata_to_binary()
    else
      :io_lib.format("~B:~2..0B", [minutes, secs]) |> IO.iodata_to_binary()
    end
  end

  def format_duration(_), do: nil

  @doc """
  Format an ISO 8601 datetime string (or DateTime) as a relative date:
  "3 days ago", "2 months ago", "1 year ago". Returns `nil` for nil/invalid.
  """
  def format_relative_date(nil), do: nil

  def format_relative_date(iso) when is_binary(iso) do
    case DateTime.from_iso8601(iso) do
      {:ok, dt, _} -> format_relative_date(dt)
      _ -> nil
    end
  end

  def format_relative_date(%DateTime{} = dt) do
    diff = DateTime.diff(DateTime.utc_now(), dt, :second)

    cond do
      diff < 60 -> "just now"
      diff < 3600 -> pluralize(div(diff, 60), "minute") <> " ago"
      diff < 86_400 -> pluralize(div(diff, 3600), "hour") <> " ago"
      diff < 604_800 -> pluralize(div(diff, 86_400), "day") <> " ago"
      diff < 2_592_000 -> pluralize(div(diff, 604_800), "week") <> " ago"
      diff < 31_536_000 -> pluralize(div(diff, 2_592_000), "month") <> " ago"
      true -> pluralize(div(diff, 31_536_000), "year") <> " ago"
    end
  end

  def format_relative_date(_), do: nil

  defp pluralize(1, unit), do: "1 #{unit}"
  defp pluralize(n, unit), do: "#{n} #{unit}s"
end
