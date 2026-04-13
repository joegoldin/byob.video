# Extension Store Listing

## Name

byob - Bring Your Own Binge

## Summary

Watch videos together in sync with byob.video — synchronized playback for YouTube, direct video files, and any streaming site with the extension.

## Description

byob (Bring Your Own Binge) is a free, open-source another sync extension alternative. Create a room, share the link, and watch together.

**What the extension does:**

- Syncs non-YouTube streaming sites (Crunchyroll, anime sites, etc.) by hooking into `<video>` elements
- Shows SponsorBlock segment colors on YouTube's embedded seek bar
- Displays a sync status bar on external player pages (Playing/Paused with timestamps)

**What byob.video supports (with or without the extension):**

- Synchronized YouTube playback — play, pause, seek in real-time
- Direct video file URLs (.mp4, .webm, .ogg, .mov, .mkv) with a built-in synced HTML5 player
- Video queue with drag-to-reorder and auto-advance
- SponsorBlock integration with per-room category settings (auto-skip or show in bar)
- Room history and persistence across server restarts
- Dark/light theme
- Random usernames, renamable, visible in user list

**How it works:**

1. Create a room at byob.video
2. Share the room link with friends
3. Paste video URLs and watch together
4. For non-YouTube sites, click "Open Player Window" and the extension syncs playback automatically

Source code: https://github.com/joegoldin/byob.video

## Categories

- Photos, Music & Videos
- Social & Communication

## Support website

https://github.com/joegoldin/byob.video

## License

MIT License

## Privacy Policy

No data is collected. All communication is between the user's browser and their byob server instance. No third-party analytics, tracking, or telemetry.

- Chrome Web Store: "This developer has not provided information about the collection or usage of your data."
- Firefox AMO: declared `data_collection_permissions: required: ["none"]`

## Notes to Reviewer (Chrome / Firefox)

This extension is the companion to byob.video, a self-hosted another sync extension clone built with Elixir/Phoenix. The extension does two things:

1. For non-YouTube sites (e.g., Crunchyroll): the content script detects `<video>` elements via MutationObserver and relays play/pause/seek events through a service worker WebSocket connection to the byob server, enabling synchronized playback.

2. For YouTube embeds on the byob site: the content script runs inside the YouTube embed iframe and injects colored SponsorBlock segment indicators into YouTube's native seek bar DOM.

The extension uses `<all_urls>` permission because it needs to detect video elements on any site the user opens from a byob room, and to run inside YouTube embed iframes. It connects to the user's byob server via WebSocket (Phoenix Channels) only when explicitly triggered by the user clicking "Open Player Window" in a byob room. Connection is authenticated with a signed token.

No data is collected or transmitted to any third party.

Source code: https://github.com/joegoldin/byob.video
Build instructions: `just chrome` or `just firefox` (requires Nix)
