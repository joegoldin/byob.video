defmodule ByobWeb.RoomLive.Components do
  @moduledoc """
  Function components extracted from the RoomLive render/1 template.

  Covers: url_preview_dropdown, queue_panel, history_panel,
  activity_log, users_card, and sb_row.
  """

  use Phoenix.Component

  # ── URL Preview Dropdown ──────────────────────────────────────────

  attr :url_preview_loading, :boolean, required: true
  attr :url_preview, :any, default: nil

  def url_preview_dropdown(assigns) do
    ~H"""
    <div
      :if={@url_preview_loading || @url_preview}
      class="absolute top-full left-0 right-0 mt-1 bg-base-200 rounded-lg shadow-xl border border-base-300 z-50"
    >
      <div :if={@url_preview_loading} class="flex items-center gap-3 p-3 animate-pulse">
        <div class="w-16 h-10 bg-base-300 rounded flex-shrink-0" />
        <div class="flex-1 space-y-2">
          <div class="h-3 bg-base-300 rounded w-3/4" />
          <div class="h-2 bg-base-300 rounded w-1/2" />
        </div>
      </div>
      <div
        :if={@url_preview && @url_preview.source_type == :youtube}
        class="flex items-center gap-2 p-3"
      >
        <img
          :if={@url_preview.thumbnail_url}
          src={@url_preview.thumbnail_url}
          class="w-16 h-10 object-cover rounded flex-shrink-0"
        />
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium line-clamp-3">{@url_preview.title}</p>
          <p :if={@url_preview.author_name} class="text-xs text-base-content/50">
            {@url_preview.author_name}
          </p>
        </div>
        <div class="flex gap-1 flex-shrink-0">
          <button type="button" phx-click="preview:play_now" class="btn btn-primary btn-xs">
            Play Now
          </button>
          <button type="button" phx-click="preview:queue" class="btn btn-outline btn-xs">
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
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-base-content/30" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M15.91 11.672a.375.375 0 010 .656l-5.603 3.113a.375.375 0 01-.557-.328V8.887c0-.286.307-.466.557-.327l5.603 3.112z" />
          </svg>
        </div>
        <div class="flex-1 min-w-0">
          <p :if={@url_preview.title} class="text-sm font-medium line-clamp-3">{@url_preview.title}</p>
          <p :if={!@url_preview.title} class="text-sm font-medium truncate">{@url_preview.url || "Direct video"}</p>
          <p class="text-xs text-base-content/50">Direct video file</p>
        </div>
        <div class="flex gap-1 flex-shrink-0">
          <button type="button" phx-click="preview:play_now" class="btn btn-primary btn-xs">
            Play Now
          </button>
          <button type="button" phx-click="preview:queue" class="btn btn-outline btn-xs">
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
          <p :if={@url_preview.title} class="text-sm font-medium line-clamp-3">{@url_preview.title}</p>
          <p :if={!@url_preview.title} class="text-sm font-medium">External site</p>
          <p class="text-xs text-warning byob-no-ext">
            <a href="https://github.com/joegoldin/byob.video" target="_blank" class="underline">
              Extension required
            </a>
            to sync this site
          </p>
        </div>
        <div class="flex gap-1 flex-shrink-0">
          <button type="button" phx-click="preview:play_now" class="btn btn-primary btn-xs">
            Play Now
          </button>
          <button type="button" phx-click="preview:queue" class="btn btn-outline btn-xs">
            Queue
          </button>
        </div>
      </div>
    </div>
    """
  end

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
        <div class="flex items-center gap-2 p-2 rounded-lg bg-primary/10 ring-1 ring-primary/30 text-sm">
          <img
            :if={now_playing.thumbnail_url}
            src={now_playing.thumbnail_url}
            class="w-14 h-9 object-cover rounded flex-shrink-0"
          />
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
            <span :if={show_url?(now_playing)} title={now_playing.url} class="block text-xs text-base-content/50 line-clamp-2">
              {now_playing.url}
            </span>
            <span :if={now_playing.added_by_name} class="block text-xs text-base-content/40 mt-0.5">
              {now_playing.added_by_name}
              <time :if={format_time(now_playing.added_at)} datetime={format_time(now_playing.added_at)} phx-hook="LocalTime" id={"time-np-#{now_playing.id}"}></time>
            </span>
          </div>
        </div>
      </div>

      <%!-- Up Next --%>
      <% up_next =
        @queue
        |> Enum.with_index()
        |> Enum.filter(fn {_item, idx} -> idx > (@current_index || -1) end)
      %>
      <div :if={up_next != []}>
        <div class="text-xs font-semibold text-base-content/40 uppercase tracking-wide mb-1">
          Up Next
        </div>
        <ul class="space-y-1" id="queue-sortable" phx-hook="DragSort">
          <li
            :for={{item, idx} <- up_next}
            draggable="true"
            data-queue-idx={idx}
            data-url={item.url}
            phx-hook="QueueContextMenu"
            id={"queue-item-#{item.id}"}
            class="flex items-center gap-2 p-2 rounded-lg text-sm hover:bg-base-300 transition-colors cursor-grab active:cursor-grabbing"
          >
            <span class="text-base-content/20 flex-shrink-0 text-xs select-none">&#x2807;</span>
            <img
              :if={item.thumbnail_url}
              src={item.thumbnail_url}
              class="w-14 h-9 object-cover rounded flex-shrink-0"
            />
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
                <time :if={format_time(item.added_at)} datetime={format_time(item.added_at)} phx-hook="LocalTime" id={"time-q-#{item.id}"}></time>
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
        class="flex items-center gap-2 p-2 rounded-lg text-sm hover:bg-base-300 transition-colors cursor-pointer"
      >
        <img
          :if={entry.item.thumbnail_url}
          src={entry.item.thumbnail_url}
          class="w-14 h-9 object-cover rounded flex-shrink-0"
        />
        <div
          :if={!entry.item.thumbnail_url}
          class="w-14 h-9 bg-base-300 rounded flex-shrink-0 flex items-center justify-center"
        >
          <span class="text-xs text-base-content/30">?</span>
        </div>
        <div class="flex-1 min-w-0">
          <span :if={entry.item.title} title={entry.item.title} class="block text-xs font-medium line-clamp-2">
            {entry.item.title}
          </span>
          <span :if={!entry.item.title} class="block text-xs text-base-content/50 truncate">
            {entry.item.url}
          </span>
          <span class="block text-xs text-base-content/40 mt-0.5">
            {if entry.item.added_by_name, do: entry.item.added_by_name, else: ""}
            <time :if={format_time(entry.played_at)} datetime={format_time(entry.played_at)} phx-hook="LocalTime" id={"time-h-#{entry.item.id}-#{System.unique_integer([:positive])}"}></time>
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
    <div class="card bg-base-200 mt-2 flex-shrink-0">
      <div class="card-body p-3">
        <h3 class="card-title text-xs text-base-content/40">Activity</h3>
        <ul id="activity-log" phx-hook="ScrollBottom" class="space-y-0.5 mt-1 max-h-32 overflow-y-auto text-[11px] text-base-content/50 leading-relaxed">
          <li :for={entry <- Enum.reverse(Enum.take(@activity_log, 30))} class="flex gap-1">
            <span :if={entry.action == :joined} class="text-success/60 flex-shrink-0">+</span>
            <span :if={entry.action == :left} class="text-error/60 flex-shrink-0">-</span>
            <span :if={entry.action == :now_playing} class="text-primary/60 flex-shrink-0">&#9654;</span>
            <span :if={entry.action == :play} class="text-success/60 flex-shrink-0">&#9654;</span>
            <span :if={entry.action == :pause} class="text-warning/60 flex-shrink-0">&#10074;&#10074;</span>
            <span :if={entry.action == :added} class="text-primary/60 flex-shrink-0">+</span>
            <span :if={entry.action == :skipped} class="text-base-content/40 flex-shrink-0">&#9197;</span>
            <span :if={entry.action == :seeked} class="text-info/60 flex-shrink-0">&#8644;</span>
            <span :if={entry.action == :renamed} class="text-base-content/40 flex-shrink-0">&#9998;</span>
            <span class="flex-1 line-clamp-2">{format_log_entry(entry)}</span>
            <time
              :if={entry.at}
              datetime={DateTime.to_iso8601(entry.at)}
              phx-hook="LocalTime"
              id={"log-#{System.unique_integer([:positive])}"}
              class="text-base-content/30 flex-shrink-0 whitespace-nowrap"
            ></time>
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
    <div class="card bg-base-200 mt-4 mb-4 flex-shrink-0">
      <div class="card-body p-4">
        <h3 class="card-title text-sm">
          Users
          <span class="badge badge-sm">{@users |> Enum.map(fn {_, u} -> u.username end) |> Enum.uniq() |> length()}</span>
        </h3>
        <ul class="space-y-2 mt-1 max-h-48 overflow-y-auto">
          <li
            :for={{uid, user} <- dedup_users(@users, @user_id)}
            data-user-id={uid}
            class="flex items-center gap-2 text-sm"
          >
            <div class={"w-2 h-2 rounded-full flex-shrink-0 #{if user.connected, do: "bg-success", else: "bg-base-content/20"}"}  />
            <%!-- Other users: just show name --%>
            <span :if={!is_self_user(uid, @user_id)} class="truncate">{user.username}</span>
            <%!-- Self: show name + tab indicator --%>
            <span
              :if={is_self_user(uid, @user_id) && !@editing_username}
              class="truncate flex-1"
            >
              <span class="font-bold">{user.username}</span>
              <span :if={uid == @user_id} class="text-base-content/40 font-normal">(you)</span>
              <span :if={uid != @user_id} class="text-base-content/30 font-normal text-xs">(other tab)</span>
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
  def format_log_entry(%{action: :play, user: user, detail: title}), do: "#{user} resumed #{title}"
  def format_log_entry(%{action: :pause, user: user, detail: nil}), do: "#{user} paused"
  def format_log_entry(%{action: :pause, user: user, detail: title}), do: "#{user} paused #{title}"
  def format_log_entry(%{action: :added, user: user, detail: url}), do: "#{user} added #{url}"
  def format_log_entry(%{action: :seeked, user: user, detail: detail}), do: "#{user} seeked #{detail}"
  def format_log_entry(%{action: :skipped}), do: "Skipped to next"
  def format_log_entry(%{action: :renamed, detail: detail}), do: "Renamed: #{detail}"
  def format_log_entry(_), do: nil

  def show_url?(item) do
    has_title = is_binary(item.title) and item.title != ""
    is_youtube = is_binary(item.url) and (String.contains?(item.url, "youtube.com") or String.contains?(item.url, "youtu.be"))
    not (has_title and is_youtube)
  end

  def dedup_users(users, my_user_id) do
    users
    |> Enum.sort_by(fn {id, u} ->
      {(if is_self_user(id, my_user_id), do: 0, else: 1),
       (if u.connected, do: 0, else: 1)}
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
end
