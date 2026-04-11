# Firefox AMO Listing

## Name
byob - Bring Your Own Binge

## Summary
Syncs video playback with byob.video rooms. Watch YouTube and other streaming sites together in real-time with friends — synchronized play, pause, seek, queue, and SponsorBlock integration.

## Description
byob (Bring Your Own Binge) lets you watch videos together in sync with friends.

**Features:**
- Synchronized YouTube playback (play, pause, seek) across all room members
- Video queue with auto-advance
- SponsorBlock integration — auto-skip sponsors, show segment colors on the YouTube seek bar
- Extension hooks into non-YouTube sites (Crunchyroll, etc.) by detecting `<video>` elements
- Dark/light theme
- Room history and persistence

**How it works:**
1. Create a room at byob.video
2. Share the room link with friends
3. Paste video URLs and watch together

The extension enables two things: syncing non-YouTube video sites via `<video>` element detection, and rendering SponsorBlock segment colors directly on YouTube's embedded seek bar.

Source code: https://github.com/joegoldin/byob.video

## Checkboxes
- [x] This add-on is experimental
- [ ] This add-on requires payment...

## Categories
- Photos, Music & Videos
- Social & Communication
- Tabs

## Support email
(your email)

## Support website
https://github.com/joegoldin/byob.video

## License
MIT License

## Privacy Policy
No — we declared `"required": ["none"]` for data collection.

## Notes to Reviewer
This extension is the companion to byob.video, a self-hosted another sync extension clone built with Elixir/Phoenix. The extension does two things:

1. For non-YouTube sites (e.g., Crunchyroll): the content script detects `<video>` elements via MutationObserver and relays play/pause/seek events through a service worker WebSocket connection to the byob server, enabling synchronized playback.

2. For YouTube embeds on the byob site: the content script runs inside the YouTube embed iframe and injects colored SponsorBlock segment indicators into YouTube's native seek bar DOM, similar to how the SponsorBlock extension works on youtube.com.

The extension uses `<all_urls>` permission because it needs to detect video elements on any site the user opens from a byob room, and to run inside YouTube embed iframes. It connects to the user's byob server via WebSocket (Phoenix Channels) only when explicitly triggered by the user clicking "Open" in a byob room.

No data is collected or transmitted to any third party. All communication is between the user's browser and their byob server instance.

Source code: https://github.com/joegoldin/byob.video
Build instructions: `nix build .#firefox-extension` or `cd extension && zip -r byob.xpi .`
