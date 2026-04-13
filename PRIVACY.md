# Privacy Policy

**byob** (bring your own binge) does not collect, store, or transmit any personal data.

## What byob does

- All communication is between your browser and the byob server instance you are connected to
- Room state (queue, history, playback position) is stored on the server in a local SQLite database
- Usernames are randomly generated and stored only in your browser's localStorage and the server's in-memory room state
- No cookies are used for tracking. The only cookie is the Phoenix session cookie required for CSRF protection

## What the extension does

- The browser extension communicates only with the byob server URL you explicitly connect to from a room
- Extension config (room ID, server URL) is stored in chrome.storage.local and cleared when you leave the room
- The extension does not run on any page unless you activate it from a byob room
- No browsing history, page content, or personal information is collected or transmitted

## Third-party services

- **SponsorBlock API** ([sponsor.ajay.app](https://sponsor.ajay.app)): When a YouTube video is played, the server fetches skip segment data from the SponsorBlock API using the video ID. No user-identifying information is sent.
- **YouTube oEmbed API**: When a YouTube URL is pasted, the server fetches video metadata (title, thumbnail) from YouTube's public oEmbed endpoint. No user-identifying information is sent.
- **OpenGraph fetching**: When a non-YouTube URL is pasted, the server fetches the page to extract og:title and og:image metadata. No user-identifying information is sent.

## What byob does NOT do

- No analytics or telemetry
- No advertising
- No third-party tracking scripts
- No data sharing with any third party
- No account system or email collection

## Data retention

- Room state is ephemeral and deleted when rooms are inactive
- The SQLite database stores up to 100 rooms with up to 99 history entries each
- No data is backed up or exported

## Contact

For questions about this privacy policy, open an issue at [github.com/joegoldin/byob.video](https://github.com/joegoldin/byob.video).
