/**
 * Toast notifications — action toasts and SponsorBlock skip toasts.
 */

/**
 * Ensure the shared toast animation keyframes exist in <head>.
 */
function ensureToastStyles() {
  if (document.getElementById("sb-toast-style")) return;
  const style = document.createElement("style");
  style.id = "sb-toast-style";
  style.textContent = `
    @keyframes sb-toast-in { from { opacity:0; transform:translateX(-50%) translateY(10px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
    @keyframes sb-toast-out { from { opacity:1; } to { opacity:0; } }
  `;
  document.head.appendChild(style);
}

/**
 * Show a brief action toast at the bottom-center of the viewport.
 *
 * @param {string} text – message to display
 */
export function showToast(text) {
  if (!text) return;
  const existing = document.querySelector(".byob-action-toast");
  if (existing) existing.remove();

  ensureToastStyles();

  const toast = document.createElement("div");
  toast.className = "byob-action-toast";
  toast.style.cssText = `
    position:fixed;bottom:16px;left:50%;transform:translateX(-50%);
    padding:6px 16px;border-radius:8px;
    background:rgba(0,0,0,0.8);color:rgba(255,255,255,0.8);
    font-size:12px;z-index:9998;pointer-events:none;
    animation:sb-toast-in 0.2s ease-out;
    max-width:400px;text-align:center;
  `;
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = "sb-toast-out 0.3s ease-in forwards";
    setTimeout(() => toast.remove(), 300);
  }, 2500);
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
 * Show a category-colored "Skipped <label>" toast.
 *
 * @param {string} category – SponsorBlock category key
 */
export function showSkipToast(category) {
  const label = SKIP_LABELS[category] || category;
  const color = SKIP_COLORS[category] || "#00d400";

  document.querySelector(".sb-skip-toast")?.remove();

  ensureToastStyles();

  const toast = document.createElement("div");
  toast.className = "sb-skip-toast";
  toast.style.cssText = `
    position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
    padding:8px 16px;border-radius:8px;
    background:rgba(0,0,0,0.85);color:white;
    font-size:13px;z-index:9999;
    display:flex;align-items:center;gap:8px;
    animation:sb-toast-in 0.2s ease-out;
  `;
  toast.innerHTML = `
    <span style="width:10px;height:10px;border-radius:2px;background:${color};flex-shrink:0;"></span>
    Skipped ${label}
  `;

  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = "sb-toast-out 0.3s ease-in forwards";
    setTimeout(() => toast.remove(), 300);
  }, 2000);
}
