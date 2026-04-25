/**
 * Toast notifications — action toasts and SponsorBlock skip toasts.
 *
 * All toasts append to a single fixed-position container so multiple
 * messages stack rather than overlap. The container is column-reverse so
 * the newest toast sits at the bottom and older ones rise above it.
 */

const CONTAINER_ID = "byob-toast-container";
const STYLE_ID = "byob-toast-style";

/**
 * Ensure the shared toast keyframes + container exist in <head>/<body>.
 * Returns the stacking container element.
 */
function ensureToastInfra() {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes sb-toast-in { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
      @keyframes sb-toast-out { from { opacity:1; } to { opacity:0; } }
    `;
    document.head.appendChild(style);
  }

  let container = document.getElementById(CONTAINER_ID);
  if (!container) {
    container = document.createElement("div");
    container.id = CONTAINER_ID;
    container.style.cssText = `
      position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
      display:flex;flex-direction:column-reverse;align-items:center;gap:8px;
      z-index:9999;pointer-events:none;
      max-width:calc(100vw - 32px);
    `;
    document.body.appendChild(container);
  }
  return container;
}

/**
 * Append a toast element to the stacking container with fade-in/out.
 */
function appendStacking(toast, ttlMs) {
  const container = ensureToastInfra();
  toast.style.animation = "sb-toast-in 0.2s ease-out";
  container.appendChild(toast);
  if (ttlMs > 0) {
    setTimeout(() => {
      toast.style.animation = "sb-toast-out 0.3s ease-in forwards";
      setTimeout(() => toast.remove(), 300);
    }, ttlMs);
  }
}

/**
 * Show a brief action toast at the bottom-center of the viewport.
 *
 * @param {string} text – message to display
 */
export function showToast(text) {
  if (!text) return;
  const toast = document.createElement("div");
  toast.className = "byob-action-toast";
  toast.style.cssText = `
    padding:6px 16px;border-radius:8px;
    background:rgba(0,0,0,0.8);color:rgba(255,255,255,0.8);
    font-size:12px;pointer-events:none;
    text-align:center;
  `;
  toast.textContent = text;
  appendStacking(toast, 2500);
}

const SKIP_LABELS = {
  sponsor: "Sponsor",
  selfpromo: "Self Promotion",
  interaction: "Interaction",
  intro: "Intro",
  outro: "Outro",
  preview: "Preview",
  music_offtopic: "Non-Music",
  filler: "Filler",
};

const SKIP_COLORS = {
  sponsor: "#00d400",
  selfpromo: "#ffff00",
  interaction: "#cc00ff",
  intro: "#00ffff",
  outro: "#0202ed",
  preview: "#008fd6",
  music_offtopic: "#ff9900",
  filler: "#7300FF",
};

/**
 * Show a category-colored "Skipped <label>" toast. Optionally renders an
 * "Undo" button — clicking it calls `onUndo` and dismisses the toast
 * before its TTL.
 *
 * @param {string} category – SponsorBlock category key
 * @param {Function} [onUndo] – optional callback fired by the Undo button
 */
export function showSkipToast(category, onUndo) {
  const label = SKIP_LABELS[category] || category;
  const color = SKIP_COLORS[category] || "#00d400";

  const toast = document.createElement("div");
  toast.className = "sb-skip-toast";
  toast.style.cssText = `
    padding:8px 16px;border-radius:8px;
    background:rgba(0,0,0,0.85);color:white;
    font-size:13px;
    display:flex;align-items:center;gap:8px;
    pointer-events:auto;
  `;

  const swatch = document.createElement("span");
  swatch.style.cssText = `width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0;`;
  toast.appendChild(swatch);

  const text = document.createElement("span");
  text.textContent = `Skipped ${label}`;
  toast.appendChild(text);

  let ttl = 2000;
  if (typeof onUndo === "function") {
    ttl = 4500;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Undo";
    btn.style.cssText = `
      background:rgba(255,255,255,0.2);color:white;border:none;
      font:inherit;font-weight:600;font-size:12px;
      padding:3px 10px;border-radius:6px;cursor:pointer;
      margin-left:4px;
    `;
    btn.onmouseenter = () => { btn.style.background = "rgba(255,255,255,0.32)"; };
    btn.onmouseleave = () => { btn.style.background = "rgba(255,255,255,0.2)"; };
    btn.addEventListener("click", () => {
      try { onUndo(); } catch (_) {}
      toast.style.animation = "sb-toast-out 0.2s ease-in forwards";
      setTimeout(() => toast.remove(), 200);
    });
    toast.appendChild(btn);
  }

  appendStacking(toast, ttl);
}
