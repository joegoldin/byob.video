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
import CopyUrl from "./hooks/copy_url"

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
      if (window._byobPlayerWindow && !window._byobPlayerWindow.closed) {
        window._byobPlayerWindow.focus();
      } else {
        window.postMessage({
          type: "byob:open-external",
          url: this.el.dataset.url,
          room_id: this.el.dataset.roomId,
          server_url: this.el.dataset.serverUrl,
          token: this.el.dataset.token,
        }, "*");
        window._byobPlayerWindow = window.open(
          this.el.dataset.url, "byob_player",
          "width=1280,height=800,menubar=no,toolbar=no,location=yes,status=no"
        );
      }
      setTimeout(() => this._updateLabel(), 100);
    });
  },
  _updateLabel() {
    const isOpen = window._byobPlayerWindow && !window._byobPlayerWindow.closed;
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

const QueueContextMenu = {
  mounted() { this._bind(); },
  updated() { this._bind(); },
  _bind() {
    this.el.oncontextmenu = (e) => {
      e.preventDefault();
      // Remove any existing menu
      document.querySelector(".byob-ctx-menu")?.remove();

      const url = this.el.dataset.url;
      if (!url) return;

      const menu = document.createElement("div");
      menu.className = "byob-ctx-menu";
      menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:99999;background:var(--b2,#1f2937);border:1px solid var(--b3,#374151);border-radius:6px;padding:4px 0;min-width:200px;font-size:12px;font-family:system-ui;box-shadow:0 4px 12px rgba(0,0,0,0.3);`;

      // URL display (grayed, not clickable)
      const urlItem = document.createElement("div");
      urlItem.style.cssText = "padding:6px 12px;color:rgba(255,255,255,0.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:300px;cursor:default;";
      urlItem.textContent = url;
      menu.appendChild(urlItem);

      // Divider
      const divider = document.createElement("div");
      divider.style.cssText = "height:1px;background:rgba(255,255,255,0.1);margin:2px 0;";
      menu.appendChild(divider);

      // Copy URL option
      const copyItem = document.createElement("div");
      copyItem.style.cssText = "padding:6px 12px;color:rgba(255,255,255,0.8);cursor:pointer;";
      copyItem.textContent = "Copy URL";
      copyItem.onmouseenter = () => copyItem.style.background = "rgba(255,255,255,0.1)";
      copyItem.onmouseleave = () => copyItem.style.background = "none";
      copyItem.onclick = () => { navigator.clipboard.writeText(url); menu.remove(); };
      menu.appendChild(copyItem);

      document.body.appendChild(menu);

      // Close on click outside
      const close = (ev) => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("click", close); } };
      setTimeout(() => document.addEventListener("click", close), 0);
    };
  },
}

const LocalTime = {
  mounted() { this._format() },
  updated() { this._format() },
  _format() {
    const dt = this.el.getAttribute("datetime");
    if (!dt) return;
    const d = new Date(dt);
    this.el.textContent = " at " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  },
}

// Stable per-browser ID: all tabs in same browser share one identity
if (!localStorage.getItem("byob_browser_id")) {
  localStorage.setItem("byob_browser_id", crypto.randomUUID())
}

// Detect duplicate room tabs — show a small notice, don't block
(() => {
  const path = window.location.pathname;
  const roomMatch = path.match(/^\/room\/([a-z0-9]+)$/);
  if (!roomMatch) return;

  const bc = new BroadcastChannel(`byob_room_${roomMatch[1]}`);
  const myId = crypto.randomUUID();

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
    tab_id: localStorage.getItem("byob_browser_id"),
  }),
  hooks: {...colocatedHooks, VideoPlayer, CopyUrl, ReplaceLayoutNav, LocalTime, ExtOpenBtn, DragSort, QueueContextMenu},
})

// Listen for username changes to persist to localStorage
window.addEventListener("phx:store-username", (e) => {
  localStorage.setItem("watchparty_username", e.detail.username)
})

// Show progress bar on live navigation and form submits
topbar.config({barColors: {0: "#29d"}, shadowColor: "rgba(0, 0, 0, .3)"})
window.addEventListener("phx:page-loading-start", _info => topbar.show(300))
window.addEventListener("phx:page-loading-stop", _info => topbar.hide())

// connect if there are any LiveViews on the page
liveSocket.connect()

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

