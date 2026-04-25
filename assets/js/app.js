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

const ExtOpenBtn = {
  mounted() { this._setup(); },
  updated() { this._updateLabel(); },
  _setup() {
    this._updateLabel();
    this._interval = setInterval(() => this._updateLabel(), 500);
    this.el.addEventListener("click", () => {
      // window.open with the same target name reuses an existing popup
      // (and re-navigates it) or opens a new one — idempotent either way,
      // and survives a stale reference if the user manually closed the
      // popup. Use window.location.origin instead of the server-rendered
      // Endpoint.url() so LAN-access sessions don't end up with
      // server_url=http://localhost:4000.
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
      if (window._byobPlayerWindow) {
        try { window._byobPlayerWindow.focus(); } catch (_) {}
      }
      setTimeout(() => this._updateLabel(), 100);
    });
  },
  _updateLabel() {
    // See click-handler comment — .closed is unreliable across COOP
    // boundaries, so just check the reference.
    const isOpen = !!window._byobPlayerWindow;
    this.el.textContent = isOpen ? "Focus Player Window" : "Open Player Window";
  },
  destroyed() {
    if (this._interval) clearInterval(this._interval);
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
  hooks: {...colocatedHooks, VideoPlayer, CopyUrl, ReplaceLayoutNav, LocalTime, ExtOpenBtn, DragSort, QueueContextMenu, ExpandWhenCramped, ScrollBottom, RouletteWheel, RoundTimer,
    PreserveModal: {
      beforeUpdate() { this._wasOpen = this.el.open; },
      updated() { if (this._wasOpen && !this.el.open) this.el.showModal(); }
    },
    PreserveDetails: {
      beforeUpdate() { this._wasOpen = this.el.open; },
      updated() { this.el.open = this._wasOpen; }
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

