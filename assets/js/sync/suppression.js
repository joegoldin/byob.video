// Time-window suppression for echoed player events after programmatic commands.
// Suppresses ALL events for a window after a programmatic command, clearing
// only after the terminal state is reached + a settling period, or a safety timeout.
export class Suppression {
  constructor() {
    this.gen = 0;
    this.suppressUntilGen = 0;
    this.expectedState = null;
    this.terminalReached = false;
    this.terminalAt = null;
    this.safetyTimeout = null;
  }

  // Call before applying a remote command to the player.
  // expectedState: the state we expect to see ("playing", "paused", or null for seek).
  suppress(expectedState) {
    this.gen++;
    this.suppressUntilGen = this.gen;
    this.expectedState = expectedState;
    this.terminalReached = false;
    this.terminalAt = null;

    if (this.safetyTimeout) clearTimeout(this.safetyTimeout);
    this.safetyTimeout = setTimeout(() => {
      this._clear();
    }, 3000);
  }

  // Call from player state change handler. Returns true if event should be swallowed.
  shouldSuppress(currentState) {
    if (this.suppressUntilGen === 0) return false;

    if (currentState === this.expectedState || this.expectedState === null) {
      if (!this.terminalReached) {
        this.terminalReached = true;
        this.terminalAt = performance.now();
      }
      // Keep suppressing for 200ms after terminal state to catch double-fires
      if (performance.now() - this.terminalAt > 200) {
        this._clear();
      }
    }

    // Suppress ALL events while active, not just matching ones
    return true;
  }

  isActive() {
    return this.suppressUntilGen > 0;
  }

  _clear() {
    this.suppressUntilGen = 0;
    this.expectedState = null;
    this.terminalReached = false;
    this.terminalAt = null;
    if (this.safetyTimeout) {
      clearTimeout(this.safetyTimeout);
      this.safetyTimeout = null;
    }
  }

  destroy() {
    this._clear();
  }
}
