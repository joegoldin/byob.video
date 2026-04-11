> **Disclaimer:** This software is provided "as is", without warranty of any
> kind. It is experimental, untested, non-production-ready code built with the
> assistance of LLMs (large language models). Use at your own risk. The
> author(s) accept no liability for any damage, data loss, or other issues
> arising from its use. See [LICENSE](LICENSE) for details.

# BYOB(1)

## NAME

byob - bring your own binge - watch videos together in sync

## SYNOPSIS

    mix phx.server                          start the server
    just build                              build all packages
    just chrome                             build Chrome extension
    just firefox                            build Firefox extension
    just docker                             build Docker image

## DESCRIPTION

Self-hosted another sync extension clone. Create ephemeral rooms, paste video
URLs, and watch in sync with friends. YouTube plays embedded with
native controls. Other sites (anime, Crunchyroll, Dailymotion, etc.)
open in a popup window synced via the browser extension.

Built with Elixir/Phoenix LiveView, GenServer-per-room architecture,
and Chrome/Firefox MV3 browser extensions.

## FEATURES

    YouTube embedded playback       native controls, synced play/pause/seek
    Extension-synced playback       hooks <video> elements on any site
    SponsorBlock integration        auto-skip sponsors, colored seek bar
    Video queue                     play now, queue, auto-advance, history
    Room persistence                SQLite, survives server restarts
    User presence                   green/gray dots, rename, per-tab identity
    Dark/light theme                DaisyUI, persists to localStorage
    OpenGraph metadata              title + thumbnail for all URLs
    Clock sync                      NTP-style, drift correction with hysteresis
    Room settings                   per-room SponsorBlock category config

## ARCHITECTURE

    Phoenix LiveView                room UI, sync via push_event/handleEvent
    GenServer per room              canonical state, PubSub broadcast
    ExtensionChannel                dedicated Phoenix Channel for extension
    Chrome MV3 extension            content script + service worker
    SQLite (exqlite)                room persistence, no Ecto
    Tailwind + DaisyUI              styling, dark/light themes

### Sync Protocol

The server maintains canonical playback state (position, play/pause,
queue index). Clients sync via:

    1. NTP-style clock sync (5-probe burst on join, 30s maintenance)
    2. Generation counter event suppression (prevents echo loops)
    3. Drift correction (playbackRate 0.95-1.05 for <2s, hard seek for >2s)
    4. 100ms reconcile tick with hysteresis to prevent oscillation

### Extension Architecture

    Content Script      MutationObserver for <video>, Shadow DOM patching,
                        play/pause/seek hooks with generation counter
    Service Worker      port-based SW keepalive, Phoenix Channel client,
                        bidirectional event routing
    Sync Bar            bottom-of-window status bar with collapse toggle

## INSTALL

### Server (Nix)

    nix develop                     enter dev shell
    mix setup                       install deps + build assets
    mix phx.server                  start at http://localhost:4000

### Server (Docker)

    docker build -t byob .
    docker run -p 4000:4000 \
      -e SECRET_KEY_BASE=$(mix phx.gen.secret) \
      -e PHX_HOST=byob.video \
      byob

### Chrome Extension

    just chrome
    # result-chrome/byob-chrome.crx    installable .crx
    # result-chrome/byob-chrome.zip    for Chrome Web Store
    # result-chrome/unpacked/          for developer mode

Or load `extension/` as unpacked in `chrome://extensions`.

### Firefox Extension

    just firefox
    # result-firefox/byob-firefox.xpi  installable .xpi

### Nix Flake

    nix build .#chrome-extension
    nix build .#firefox-extension
    nix build .#docker

## CONFIGURATION

### Environment Variables

    SECRET_KEY_BASE     required for production
    PHX_HOST            hostname (default: localhost)
    PHX_SERVER          set to "true" in production
    PORT                HTTP port (default: 4000)

### Room Limits

    Max rooms           100 (returns capacity error)
    Max history          99 entries per room
    Room cleanup         5 min after last user disconnects
    Persist interval    30s + on terminate

### SponsorBlock Defaults

    Sponsor             auto skip
    Self Promotion      show in bar
    Interaction         show in bar
    Intro               show in bar
    Outro               show in bar
    Preview/Recap       show in bar
    Non-Music           disabled
    Filler/Tangent      show in bar

Settings are per-room, synced to all users.

## FILES

    lib/byob/                       server application
    lib/byob/room_server.ex         GenServer per room
    lib/byob/room_manager.ex        room lifecycle
    lib/byob/persistence.ex         SQLite storage
    lib/byob/sponsor_block.ex       SponsorBlock API client
    lib/byob/oembed.ex              YouTube oEmbed + OpenGraph
    lib/byob_web/live/room_live.ex  room LiveView
    assets/js/hooks/video_player.js YouTube + sync engine
    assets/js/sync/                 clock sync, reconcile, suppression
    extension/                      Chrome/Firefox extension
    extension/content.js            video detection + sync bar
    extension/background.js         service worker + Phoenix Channel
    priv/byob.db                    SQLite database (gitignored)

## EXAMPLES

    # Create a room and watch YouTube together
    1. Open http://localhost:4000
    2. Click "Create Room"
    3. Share the room URL with friends
    4. Paste a YouTube URL, click "Play Now"

    # Watch anime together (requires extension)
    1. Install the Chrome/Firefox extension
    2. Paste an anime site URL in the room
    3. Click "Open Player Window"
    4. Click play on the video - extension hooks it
    5. Playback syncs across all room members

    # Self-host for friends
    docker run -d -p 4000:4000 \
      -e SECRET_KEY_BASE=$(openssl rand -hex 64) \
      -e PHX_HOST=byob.video \
      -v byob-data:/app/priv \
      byob

## SEE ALSO

another sync extension.com, syncplay, jellyfin-mpv-shim, cytube

## LICENSE

MIT
