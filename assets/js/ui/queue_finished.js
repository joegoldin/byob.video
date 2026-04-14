/**
 * Queue-finished screen — displayed when all items have been played.
 */

/**
 * Build and display the "Queue finished" screen inside the player element.
 *
 * @param {HTMLElement} el    – the player root element
 * @param {string}      title – title of the last played item
 * @param {string|null} thumbnail – URL of the last played thumbnail (may be null)
 */
export function showQueueFinished(el, title, thumbnail) {
  const container = document.createElement("div");
  container.className =
    "absolute inset-0 flex flex-col items-center justify-center gap-4 bg-base-300";

  const icon = document.createElement("div");
  icon.className =
    "w-12 h-12 rounded-full bg-success/20 flex items-center justify-center";
  icon.innerHTML =
    '<svg class="w-6 h-6 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
  container.appendChild(icon);

  const heading = document.createElement("p");
  heading.className = "text-base font-semibold text-base-content/60";
  heading.textContent = "Queue finished";
  container.appendChild(heading);

  const card = document.createElement("div");
  card.className =
    "flex items-center gap-3 bg-base-100/30 rounded-lg p-3 max-w-sm";

  if (thumbnail) {
    const img = document.createElement("img");
    img.src = thumbnail;
    img.className = "w-20 h-12 object-cover rounded flex-shrink-0";
    card.appendChild(img);
  }

  const info = document.createElement("div");
  info.className = "flex-1 min-w-0";
  const titleEl = document.createElement("p");
  titleEl.className = "text-sm text-base-content/50 line-clamp-2";
  titleEl.textContent = title;
  info.appendChild(titleEl);
  const sub = document.createElement("p");
  sub.className = "text-xs text-base-content/30";
  sub.textContent = "Last played";
  info.appendChild(sub);
  card.appendChild(info);
  container.appendChild(card);

  const hint = document.createElement("p");
  hint.className = "text-xs text-base-content/25 mt-2";
  hint.textContent = "Paste a URL above to keep watching";
  container.appendChild(hint);

  el.innerHTML = "";
  el.appendChild(container);
}
