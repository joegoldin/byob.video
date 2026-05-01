// Time-window suppression for echoed player events after programmatic commands.
// Suppresses ALL events for a window after a programmatic command, clearing
// after the terminal state is reached + a short settling timer, or a safety timeout.
export class Suppression {
  constructor() {
    this.gen = 0;
    this.suppressUntilGen = 0;
    this.expectedState = null;
    this.safetyTimeout = null;
    this.settleTimeout = null;
  }

  // Call before applying a remote command to the player.
  // expectedState: the state we expect to see ("playing", "paused", or null for seek).
  suppress(expectedState) {
    this.gen++;
    this.suppressUntilGen = this.gen;
    this.expectedState = expectedState;

    if (this.safetyTimeout) clearTimeout(this.safetyTimeout);
    if (this.settleTimeout) clearTimeout(this.settleTimeout);
    this.settleTimeout = null;

    this.safetyTimeout = setTimeout(() => {
      this._clear();
    }, 3000);
  }

  // Call from player state change handler. Returns true if event should be swallowed.
  shouldSuppress(currentState) {
    if (this.suppressUntilGen === 0) return false;

    if (currentState === this.expectedState || this.expectedState === null) {
      // Terminal state reached — schedule auto-clear after 200ms settling
      // to catch YouTube's double-fire patterns, then release.
      if (!this.settleTimeout) {
        this.settleTimeout = setTimeout(() => this._clear(), 200);
      }
    }

    // Suppress ALL events while active, not just matching ones
    return true;
  }

  isActive() {
    return this.suppressUntilGen > 0;
  }

  // Abort the pending settle timer, keeping the suppression alive. Called
  // from `_onPlayerStateChange` when the player enters BUFFERING — YouTube
  // routinely fires PLAYING → BUFFERING → PLAYING after a seek, and the
  // second PLAYING would otherwise leak past the 200 ms settle, echoing
  // back to peers as a stale `:sync_play` and causing a join-time hitch.
  cancelSettle() {
    if (this.settleTimeout) {
      clearTimeout(this.settleTimeout);
      this.settleTimeout = null;
    }
  }

  _clear() {
    this.suppressUntilGen = 0;
    this.expectedState = null;
    if (this.safetyTimeout) {
      clearTimeout(this.safetyTimeout);
      this.safetyTimeout = null;
    }
    if (this.settleTimeout) {
      clearTimeout(this.settleTimeout);
      this.settleTimeout = null;
    }
  }

  destroy() {
    this._clear();
  }
}
