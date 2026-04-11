// Generation counter for suppressing echoed player events after programmatic commands
export class Suppression {
  constructor() {
    this.gen = 0;
    this.suppressUntilGen = 0;
    this.expectedState = null;
    this.safetyTimeout = null;
  }

  // Call before applying a remote command to the player
  suppress(expectedState) {
    this.gen++;
    this.suppressUntilGen = this.gen;
    this.expectedState = expectedState;

    if (this.safetyTimeout) clearTimeout(this.safetyTimeout);
    this.safetyTimeout = setTimeout(() => {
      this.suppressUntilGen = 0;
      this.expectedState = null;
    }, 3000);
  }

  // Call from player state change handler. Returns true if event should be swallowed.
  shouldSuppress(currentState) {
    if (this.suppressUntilGen === 0) return false;

    if (currentState === this.expectedState) {
      // Reached terminal state — clear suppression, but still swallow this one
      this.suppressUntilGen = 0;
      this.expectedState = null;
      if (this.safetyTimeout) {
        clearTimeout(this.safetyTimeout);
        this.safetyTimeout = null;
      }
    }

    return true;
  }

  isActive() {
    return this.suppressUntilGen > 0;
  }

  destroy() {
    if (this.safetyTimeout) {
      clearTimeout(this.safetyTimeout);
      this.safetyTimeout = null;
    }
  }
}
