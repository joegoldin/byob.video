// Singleton YouTube IFrame API loader
let loadPromise = null;

export function loadYouTubeAPI() {
  if (loadPromise) return loadPromise;

  if (window.YT && window.YT.Player) {
    loadPromise = Promise.resolve(window.YT);
    return loadPromise;
  }

  loadPromise = new Promise((resolve) => {
    const existingCallback = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      if (existingCallback) existingCallback();
      resolve(window.YT);
    };

    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(script);
  });

  return loadPromise;
}
