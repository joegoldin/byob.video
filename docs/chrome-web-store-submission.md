# Chrome Web Store Submission Answers

## Single purpose

Synchronizes video playback with byob.video watch party rooms. The extension detects video elements on streaming sites and relays play/pause/seek events to the byob server so all room members watch in sync. It also injects SponsorBlock segment indicators into YouTube's embedded seek bar.

## Permission justification

### storage

The extension uses chrome.storage.local to store the active room configuration (room ID, server URL, authentication token) when the user clicks "Open Player Window" from a byob.video room. This config is read by the content script to determine whether to activate on the current page. The data is cleared when the user leaves the room or closes the player window.

### Host permission (<all_urls> via content_scripts)

The extension needs to run on any URL because byob.video rooms can link to video content on any website (Crunchyroll, anime streaming sites, video hosting platforms, etc.). The content script must detect `<video>` elements on these arbitrary domains to synchronize playback. It also needs to run inside YouTube embed iframes on the byob.video domain to inject SponsorBlock seek bar segments. The extension only activates when the user explicitly opens a player window from a byob.video room — it does not run or collect data on pages the user visits normally.

## Remote code

**No, I am not using remote code.**

All JavaScript is bundled in the extension package. The only vendored dependency is lib/phoenix.mjs (Phoenix Channel client for WebSocket communication). No external scripts are loaded, no eval() is used, and no code is fetched at runtime.

## Data usage

**None of the listed categories apply.**

The extension does not collect personally identifiable information, health information, financial information, authentication information, personal communications, location data, web history, user activity, or website content.

The only data transmitted is video playback state (play/pause/seek position, video duration) sent to the user's own byob server instance for synchronization with other room members. No data is sent to any third party.

### Certifications

- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

## Privacy policy URL

https://github.com/joegoldin/byob.video/blob/main/PRIVACY.md
