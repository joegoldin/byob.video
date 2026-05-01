// If you want to use Phoenix channels, run `mix help phx.gen.channel`
// to get started and then uncomment the line below.
// import "./user_socket.js"

// You can include dependencies in two ways.
//
// The simplest option is to put them in assets/vendor and
// import them using relative paths:
//
//     import "../vendor/some-package.js"
//
// Alternatively, you can `npm install some-package --prefix assets` and import
// them using a path starting with the package name:
//
//     import "some-package"
//
// If you have dependencies that try to import CSS, esbuild will generate a separate `app.css` file.
// To load it, simply add a second `<link>` to your `root.html.heex` file.

// Include phoenix_html to handle method=PUT/DELETE in forms and buttons.
import "phoenix_html"
// Establish Phoenix Socket and LiveView configuration.
import {Socket} from "phoenix"
import {LiveSocket} from "phoenix_live_view"
import {hooks as colocatedHooks} from "phoenix-colocated/byob"
import topbar from "../vendor/topbar"
import VideoPlayer from "./hooks/video_player"
import { LV_EVT } from "./sync/event_names"
import CopyUrl from "./hooks/copy_url"
import RouletteWheel from "./hooks/roulette_wheel"
import RoundTimer from "./hooks/round_timer"
import StatsPanel from "./hooks/stats_panel"

const ReplaceLayoutNav = {
  mounted() {
    // Hide the layout nav bar, this LiveView renders its own
    const layoutNav = document.getElementById("layout-nav-slot");
    if (layoutNav) layoutNav.style.display = "none";
    // Sync theme toggle state
    const theme = localStorage.getItem("phx:theme") ||
      (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const cb = this.el.querySelector("#theme-toggle-room");
    if (cb) cb.checked = (theme === "dark");
  },
  destroyed() {
    const layoutNav = document.getElementById("layout-nav-slot");
    if (layoutNav) layoutNav.style.display = "";
  },
}

// Server's ready_count payload is the source of truth for "does this user
// already have a hooked-video popup open?". `window._byobPlayerWindow`
// can't be trusted: COOP severs both `.closed` and named-target reuse
// once the popup loads YouTube, so the parent never gets accurate state
// from JS alone. The BG-side port-disconnect detection fans out via the
// room channel's ready_count broadcast and lands here.
const ExtOpenBtn = {
  mounted() {
    this._setup();
    this.handleEvent("ready:count", (data) => {
      this._lastReadyCount = data;
      this._updateLabel();
    });
  },
  updated() { this._updateLabel(); },
  _setup() {
    this._updateLabel();
    this.el.addEventListener("click", () => {
      if (this._userHasPopup()) {
        // BG-mediated focus — content.js relays the postMessage to BG via
        // chrome.runtime.sendMessage; BG calls chrome.tabs.update +
        // chrome.windows.update on the user's hooked tab. Works across
        // COOP boundaries where window-side focus() doesn't.
        window.postMessage({ type: LV_EVT.PW_FOCUS_EXTERNAL }, "*");
      } else {
        // Use window.location.origin instead of the server-rendered
        // Endpoint.url() so LAN-access sessions don't end up with
        // server_url=http://localhost:4000 which fails on their machine.
        window.postMessage({
          type: LV_EVT.PW_OPEN_EXTERNAL,
          url: this.el.dataset.url,
          room_id: this.el.dataset.roomId,
          server_url: window.location.origin,
          token: this.el.dataset.token,
          username: this.el.dataset.username,
        }, "*");
        window._byobPlayerWindow = window.open(
          this.el.dataset.url, "byob_player",
          "width=1280,height=800,menubar=no,toolbar=no,location=yes,status=no"
        );
      }
      setTimeout(() => this._updateLabel(), 100);
    });
  },
  _userHasPopup() {
    const username = this.el.dataset.username;
    const rc = this._lastReadyCount;
    if (!username || !rc) return false;
    const needsOpen = Array.isArray(rc.needs_open) ? rc.needs_open : [];
    return !needsOpen.includes(username);
  },
  _updateLabel() {
    const isOpen = this._userHasPopup();
    this.el.textContent = isOpen ? "Focus Player Window" : "Open Player Window";
  },
}

const DragSort = {
  mounted() {
    this.el.addEventListener("dragstart", (e) => {
      const li = e.target.closest("[data-queue-idx]");
      if (!li) return;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", li.dataset.queueIdx);
      li.classList.add("opacity-30");
    });
    this.el.addEventListener("dragend", (e) => {
      const li = e.target.closest("[data-queue-idx]");
      if (li) li.classList.remove("opacity-30");
    });
    this.el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const li = e.target.closest("[data-queue-idx]");
      if (li) li.classList.add("bg-base-300/50");
    });
    this.el.addEventListener("dragleave", (e) => {
      const li = e.target.closest("[data-queue-idx]");
      if (li) li.classList.remove("bg-base-300/50");
    });
    this.el.addEventListener("drop", (e) => {
      e.preventDefault();
      const li = e.target.closest("[data-queue-idx]");
      if (li) li.classList.remove("bg-base-300/50");
      const from = e.dataTransfer.getData("text/plain");
      const to = li?.dataset.queueIdx;
      if (from != null && to != null && from !== to) {
        this.pushEvent("queue:reorder", { from, to });
      }
    });
  },
}

// Shows/hides the expand button based on whether the comments panel is cramped
// (height < threshold). When server-rendered as data-expanded="true", the button
// stays visible so the user can collapse back.
const ExpandWhenCramped = {
  mounted() {
    this._panel = this.el.closest(".byob-comments-panel") || this.el.parentElement;
    this._onResize = () => this._update();
    this._observer = new ResizeObserver(this._onResize);
    this._observer.observe(this._panel);
    this._update();
  },
  updated() { this._update(); },
  destroyed() {
    this._observer?.disconnect();
    this._observer = null;
  },
  _update() {
    const expanded = this.el.dataset.expanded === "true";
    const cramped = this._panel.offsetHeight < 180;
    this.el.style.display = (expanded || cramped) ? "flex" : "none";
  }
}

const QueueContextMenu = {
  mounted() {
    this._handler = (e) => this._onContextMenu(e);
    this.el.addEventListener("contextmenu", this._handler);
  },
  destroyed() {
    if (this._handler) {
      this.el.removeEventListener("contextmenu", this._handler);
      this._handler = null;
    }
  },
  _onContextMenu(e) {
    e.preventDefault();
    // Remove any existing menu
    document.querySelector(".byob-ctx-menu")?.remove();

    const url = this.el.dataset.url;
    if (!url) return;

    const menuType = this.el.dataset.ctxMenu || ""; // e.g. "play-now-queue,remove,copy"
    const actionIds = menuType.split(",").map((s) => s.trim()).filter(Boolean);

    const menu = document.createElement("div");
    menu.className = "byob-ctx-menu";
    menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:99999;background:var(--b2,#1f2937);border:1px solid var(--b3,#374151);border-radius:6px;padding:4px 0;min-width:200px;font-size:12px;font-family:system-ui;box-shadow:0 4px 12px rgba(0,0,0,0.3);`;

    // URL display (grayed, not clickable)
    const urlItem = document.createElement("div");
    urlItem.style.cssText = "padding:6px 12px;color:rgba(255,255,255,0.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px;cursor:default;";
    urlItem.textContent = url;
    menu.appendChild(urlItem);

    // Divider
    const divider = () => {
      const d = document.createElement("div");
      d.style.cssText = "height:1px;background:rgba(255,255,255,0.1);margin:2px 0;";
      return d;
    };
    menu.appendChild(divider());

    const addItem = (label, onclick) => {
      const item = document.createElement("div");
      item.style.cssText = "padding:6px 12px;color:rgba(255,255,255,0.85);cursor:pointer;";
      item.textContent = label;
      item.onmouseenter = () => item.style.background = "rgba(255,255,255,0.1)";
      item.onmouseleave = () => item.style.background = "none";
      item.onclick = () => { try { onclick(); } finally { menu.remove(); } };
      menu.appendChild(item);
    };

    const ds = this.el.dataset;

    for (const id of actionIds) {
      switch (id) {
        case "play-now-queue":
          if (ds.queueIndex != null) {
            addItem("Play Now", () => this.pushEvent("queue:play_index", { index: ds.queueIndex }));
          }
          break;
        case "play-now-history":
          addItem("Play Now", () => this.pushEvent("history:play", { url }));
          break;
        case "requeue":
          addItem("Add to Queue", () => this.pushEvent("queue:readd", { url }));
          break;
        case "remove":
          if (ds.itemId != null) {
            addItem("Remove from Queue", () => this.pushEvent("queue:remove", { item_id: ds.itemId }));
          }
          break;
        case "restart":
          addItem("Restart", () => this.pushEvent("video:restart", {}));
          break;
        case "copy":
          // Always add Copy URL at the end; falls through to the default handler below.
          addItem("Copy URL", () => navigator.clipboard.writeText(url));
          break;
      }
    }

    document.body.appendChild(menu);

    // Close on click outside
    const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("click", close); } };
    setTimeout(() => document.addEventListener("click", close), 0);
  },
}

const ScrollBottom = {
  mounted() { this._scroll(); },
  updated() { this._scroll(); },
  _scroll() { this.el.scrollTop = this.el.scrollHeight; },
}

const LocalTime = {
  mounted() { this._format() },
  updated() { this._format() },
  _format() {
    const dt = this.el.getAttribute("datetime");
    if (!dt) return;
    const d = new Date(dt);
    this.el.textContent = " at " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }).toLowerCase();
  },
}

// crypto.randomUUID() is only available in secure contexts (HTTPS or localhost).
// Fall back to getRandomValues for http://<lan-ip> dev access.
function uuidv4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, "0"));
  return `${h.slice(0,4).join("")}-${h.slice(4,6).join("")}-${h.slice(6,8).join("")}-${h.slice(8,10).join("")}-${h.slice(10,16).join("")}`;
}

// Per-tab ID: each tab is an independent user for sync purposes
if (!sessionStorage.getItem("byob_tab_id")) {
  sessionStorage.setItem("byob_tab_id", uuidv4())
}
// Per-browser ID for analytics (all tabs = same person)
if (!localStorage.getItem("byob_browser_id")) {
  localStorage.setItem("byob_browser_id", uuidv4())
}

// Detect duplicate room tabs — show a small notice, don't block
(() => {
  const path = window.location.pathname;
  const roomMatch = path.match(/^\/room\/([a-z0-9]+)$/);
  if (!roomMatch) return;

  const bc = new BroadcastChannel(`byob_room_${roomMatch[1]}`);
  const myId = uuidv4();

  bc.postMessage({ type: "ping", from: myId });
  bc.onmessage = (e) => {
    if (e.data.from === myId) return;
    if (e.data.type === "ping") bc.postMessage({ type: "pong", from: myId });
    if (e.data.type === "pong" && !document.getElementById("byob-dupe-notice")) {
      const notice = document.createElement("div");
      notice.id = "byob-dupe-notice";
      notice.style.cssText = "position:fixed;bottom:8px;right:8px;z-index:9999;background:rgba(245,158,11,0.9);color:#000;padding:4px 12px;border-radius:6px;font-size:11px;font-family:system-ui;cursor:pointer;";
      notice.textContent = "Room open in another tab";
      notice.onclick = () => notice.remove();
      document.body.appendChild(notice);
      setTimeout(() => notice.remove(), 5000);
    }
  };
})();

const csrfToken = document.querySelector("meta[name='csrf-token']").getAttribute("content")
const liveSocket = new LiveSocket("/live", Socket, {
  longPollFallbackMs: 2500,
  params: () => ({
    _csrf_token: csrfToken,
    stored_username: localStorage.getItem("watchparty_username"),
    tab_id: sessionStorage.getItem("byob_tab_id"),
    browser_id: localStorage.getItem("byob_browser_id"),
    has_extension: document.documentElement.hasAttribute("data-byob-extension"),
    show_comments: localStorage.getItem("byob_show_comments") !== "false",
  }),
  hooks: {...colocatedHooks, VideoPlayer, CopyUrl, ReplaceLayoutNav, LocalTime, ExtOpenBtn, DragSort, QueueContextMenu, ExpandWhenCramped, ScrollBottom, RouletteWheel, RoundTimer, StatsPanel,
    PreserveModal: {
      beforeUpdate() { this._wasOpen = this.el.open; },
      updated() { if (this._wasOpen && !this.el.open) this.el.showModal(); }
    },
    // Tab-title notification badge. While the tab is hidden, count
    // server-pushed `notify` events (joins / leaves / queue adds /
    // round winners) and prefix document.title with `(N) `. Reset
    // on visibilitychange to visible.
    TabNotifier: {
      mounted() {
        this._count = 0;
        this._origTitle = document.title.replace(/^\(\d+\)\s+/, "");
        this._onVisibilityChange = () => {
          if (!document.hidden) this._reset();
        };
        document.addEventListener("visibilitychange", this._onVisibilityChange);
        this.handleEvent(LV_EVT.NOTIFY, () => {
          if (!document.hidden) return;
          this._count++;
          this._render();
        });
      },
      destroyed() {
        if (this._onVisibilityChange) document.removeEventListener("visibilitychange", this._onVisibilityChange);
        this._reset();
      },
      _render() {
        // Re-derive the original from the current title — LV may have
        // updated it for other reasons since mount.
        const stripped = document.title.replace(/^\(\d+\)\s+/, "");
        if (stripped) this._origTitle = stripped;
        document.title = this._count > 0
          ? `(${this._count}) ${this._origTitle}`
          : this._origTitle;
      },
      _reset() {
        if (this._count === 0) return;
        this._count = 0;
        this._render();
      },
    },
    PreserveDetails: {
      beforeUpdate() { this._wasOpen = this.el.open; },
      updated() { this.el.open = this._wasOpen; }
    },
    // Save and restore the element's scrollTop across LV updates AND across
    // toggles of any descendant <details>. The modal-box re-renders on
    // every drift report (1 Hz/peer) — without this, scrollTop reset to 0
    // each tick, which made hidden-section toggles look like "scroll
    // resets to top" because the user's first click happened to coincide
    // with an LV update.
    PreserveScroll: {
      mounted() {
        this._lastScrollTop = 0;
        // Track user scroll continuously so we always have a fresh value
        // to restore after an LV-driven re-render.
        this._onScroll = () => { this._lastScrollTop = this.el.scrollTop; };
        this.el.addEventListener("scroll", this._onScroll, { passive: true });
      },
      beforeUpdate() {
        this._lastScrollTop = this.el.scrollTop;
      },
      updated() {
        // Defer one frame: if the update changed content height, the
        // browser may have clamped scrollTop. Restoring on the next frame
        // catches the case where the new layout has settled.
        const target = this._lastScrollTop;
        requestAnimationFrame(() => { this.el.scrollTop = target; });
      },
      destroyed() {
        if (this._onScroll) this.el.removeEventListener("scroll", this._onScroll);
      },
    },
    // Settings → "Forget cleared popups". Each child item declares the
    // localStorage key it represents via data-storage-key. On mount, items
    // whose key isn't actually set are hidden; if none are set, the whole
    // container hides itself. The data-reset-all button clears every set
    // key in scope and re-runs the visibility pass.
    DismissedPopups: {
      mounted() {
        this._refresh = () => {
          const items = this.el.querySelectorAll("[data-storage-key]");
          let any = false;
          items.forEach((item) => {
            const key = item.dataset.storageKey;
            const set = (() => { try { return localStorage.getItem(key) === "1"; } catch (_) { return false; } })();
            item.style.display = set ? "" : "none";
            if (set) any = true;
          });
          this.el.style.display = any ? "" : "none";
        };
        this._refresh();
        this._onClick = (e) => {
          const btn = e.target.closest("[data-reset-all]");
          if (!btn || !this.el.contains(btn)) return;
          this.el.querySelectorAll("[data-storage-key]").forEach((item) => {
            try { localStorage.removeItem(item.dataset.storageKey); } catch (_) {}
          });
          this._refresh();
        };
        document.addEventListener("click", this._onClick);
      },
      destroyed() {
        if (this._onClick) document.removeEventListener("click", this._onClick);
      },
    },
    // Local-only nickname overlay. Each `[data-byob-username="X"]` element
    // is rendered as the canonical username; this hook walks them on mount
    // / update / DOM mutation and appends a sibling `<span>` with the user's
    // nickname (if set) in muted text. `[data-byob-nickname-btn="X"]`
    // buttons trigger an inline prompt; submitted text is saved to
    // localStorage under `byob_nicknames`. State is per-browser, never
    // sent to the server.
    Nicknames: {
      mounted() {
        this._read();
        this._scheduled = false;
        this._refreshing = false;
        // Scan document.body, not just this.el — settings modal /
        // autoplay-help modal / toasts are rendered as siblings of the
        // hook's element, so a hook-scoped scan would miss usernames
        // inside them (e.g. Stats for nerds → Connected clients rows).
        this._scope = document.body;
        this._refresh();
        this._onClick = (e) => {
          const btn = e.target.closest("[data-byob-nickname-btn]");
          if (!btn) return;
          this._editFor(btn.dataset.byobNicknameBtn);
        };
        document.addEventListener("click", this._onClick);
        // Observer watches for LV-driven DOM changes; coalesce + skip our
        // own mutations (the suffix add/remove inside _refresh would
        // otherwise re-trigger the callback synchronously and lock the
        // page in a tight loop).
        this._observer = new MutationObserver(() => this._scheduleRefresh());
        this._observer.observe(this._scope, { childList: true, subtree: true });
      },
      updated() { this._scheduleRefresh(); },
      destroyed() {
        if (this._onClick) document.removeEventListener("click", this._onClick);
        if (this._observer) this._observer.disconnect();
      },
      _read() {
        try {
          this._map = JSON.parse(localStorage.getItem("byob_nicknames") || "{}");
        } catch (_) { this._map = {}; }
      },
      _save() {
        try { localStorage.setItem("byob_nicknames", JSON.stringify(this._map || {})); } catch (_) {}
      },
      _scheduleRefresh() {
        if (this._refreshing) return; // we are the source of this mutation
        if (this._scheduled) return;
        this._scheduled = true;
        // Coalesce bursts of mutations from a single LV diff into one pass.
        Promise.resolve().then(() => {
          this._scheduled = false;
          this._refresh();
        });
      },
      _refresh() {
        if (!this._map) this._read();
        // Detach the observer for the duration of our own mutations so
        // adding/removing suffix spans doesn't fire the observer back at
        // us. (Reconnecting after handles any further LV diffs.)
        this._refreshing = true;
        if (this._observer) this._observer.disconnect();
        try {
          (this._scope || document.body).querySelectorAll("[data-byob-username]").forEach((el) => {
            const username = el.dataset.byobUsername;
            const nickname = (username && this._map[username]) || null;
            let suffix = el.nextElementSibling;
            if (suffix && !suffix.classList.contains("byob-nickname-suffix")) suffix = null;
            if (nickname) {
              if (!suffix) {
                suffix = document.createElement("span");
                suffix.className = "byob-nickname-suffix text-base-content/40 text-xs";
                el.after(suffix);
              }
              const want = ` (${nickname})`;
              if (suffix.textContent !== want) suffix.textContent = want;
            } else if (suffix) {
              suffix.remove();
            }
          });
        } finally {
          if (this._observer) {
            this._observer.observe(this._scope || document.body, { childList: true, subtree: true });
          }
          this._refreshing = false;
        }
      },
      _editFor(username) {
        if (!username) return;
        const current = (this._map && this._map[username]) || "";
        const next = window.prompt(`Nickname for ${username} (leave blank to clear):`, current);
        if (next === null) return;
        if (!this._map) this._map = {};
        const trimmed = next.trim();
        if (trimmed === "") delete this._map[username];
        else this._map[username] = trimmed;
        this._save();
        this._refresh();
      },
    },
  },
})

// Listen for username changes to persist to localStorage
window.addEventListener("phx:store-username", (e) => {
  localStorage.setItem("watchparty_username", e.detail.username)
})

// Listen for comments toggle to persist to localStorage
window.addEventListener("phx:store-show-comments", (e) => {
  localStorage.setItem("byob_show_comments", e.detail.show)
})

// Re-open a dialog modal after LiveView re-render
window.addEventListener("phx:reopen-modal", (e) => {
  const modal = document.getElementById(e.detail.id)
  if (modal && !modal.open) modal.showModal()
})

// Scroll the round panel (roulette wheel or voting panel) into view when
// the server indicates nothing is playing. Happens on `:round_started`.
window.addEventListener("phx:round:scroll_into_view", () => {
  const panel = document.getElementById("round-panel")
  if (!panel) return
  // Defer one tick so the panel's phx-update="ignore" mount completes first
  requestAnimationFrame(() => {
    try {
      panel.scrollIntoView({ behavior: "smooth", block: "center" })
    } catch (_) {
      panel.scrollIntoView()
    }
  })
})

// Show progress bar on live navigation and form submits
topbar.config({barColors: {0: "#29d"}, shadowColor: "rgba(0, 0, 0, .3)"})
window.addEventListener("phx:page-loading-start", _info => topbar.show(300))
window.addEventListener("phx:page-loading-stop", _info => topbar.hide())

// connect if there are any LiveViews on the page
liveSocket.connect()

// Auto-reload on extended server disconnect (deploy/restart).
// A full page reload destroys the YouTube iframe and loses the autoplay
// permission granted by prior user gesture — so subsequent videos require a
// click to play. We only reload after a long disconnect, and we wait longer
// while a video is actively playing so normal deploys don't interrupt playback.
// If LiveView reconnects within the window, the VideoPlayer hook's
// `reconnected()` callback handles resync without disturbing the iframe.
let disconnectedAt = null;
window.addEventListener("phx:page-loading-start", (info) => {
  if (info.detail?.kind === "error") {
    disconnectedAt = disconnectedAt || Date.now();
  }
});
window.addEventListener("phx:page-loading-stop", () => {
  disconnectedAt = null;
});
setInterval(() => {
  if (!disconnectedAt) return;
  const elapsed = Date.now() - disconnectedAt;
  // The VideoPlayer hook sets this flag while a video is actively playing.
  const playing = window.__byobPlaying === true;
  const threshold = playing ? 120_000 : 30_000;
  if (elapsed > threshold) {
    disconnectedAt = null;
    window.location.reload();
  }
}, 2000);

// expose liveSocket on window for web console debug logs and latency simulation:
// >> liveSocket.enableDebug()
// >> liveSocket.enableLatencySim(1000)  // enabled for duration of browser session
// >> liveSocket.disableLatencySim()
window.liveSocket = liveSocket

// The lines below enable quality of life phoenix_live_reload
// development features:
//
//     1. stream server logs to the browser console
//     2. click on elements to jump to their definitions in your code editor
//
if (process.env.NODE_ENV === "development") {
  window.addEventListener("phx:live_reload:attached", ({detail: reloader}) => {
    // Enable server log streaming to client.
    // Disable with reloader.disableServerLogs()
    reloader.enableServerLogs()

    // Open configured PLUG_EDITOR at file:line of the clicked element's HEEx component
    //
    //   * click with "c" key pressed to open at caller location
    //   * click with "d" key pressed to open at function component definition location
    let keyDown
    window.addEventListener("keydown", e => keyDown = e.key)
    window.addEventListener("keyup", _e => keyDown = null)
    window.addEventListener("click", e => {
      if(keyDown === "c"){
        e.preventDefault()
        e.stopImmediatePropagation()
        reloader.openEditorAtCaller(e.target)
      } else if(keyDown === "d"){
        e.preventDefault()
        e.stopImmediatePropagation()
        reloader.openEditorAtDef(e.target)
      }
    }, true)

    window.liveReloader = reloader
  })
}

