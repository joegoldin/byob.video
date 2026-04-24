# Crunchyroll DRM Sequencer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Crunchyroll receiver stalls by queuing out-of-order DRM `play` commands until the matching `seek` lands or a short timeout expires.

**Architecture:** Keep server and channel semantics unchanged, and add a DRM-only play/seek sequencer in the extension content script. Cover the new behavior with a focused JS regression harness and keep existing Elixir channel coverage green.

**Tech Stack:** Phoenix, Elixir, ExUnit, browser extension JavaScript, Node built-in test runner

---

### Task 1: Add a focused JS regression harness for extension command sequencing

**Files:**
- Create: `extension/content_runtime.js`
- Create: `extension/tests/content_runtime.test.js`

- [ ] **Step 1: Write the failing test**

```js
test("drm queued play waits for matching seek before calling play", async () => {
  const video = makeVideo({ paused: true, currentTime: 100 });
  const runtime = createContentRuntime({ video, isDrmSite: true });

  runtime.handleCommand({ type: "command:play", position: 400 });
  runtime.handleCommand({ type: "command:seek", position: 400 });

  assert.equal(video.playCalls, 0);
  await runtime.flushTimers();
  assert.deepEqual(video.ops, ["seek:400", "play"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test extension/tests/content_runtime.test.js`
Expected: FAIL because `extension/content_runtime.js` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

```js
export function createContentRuntime({ video, isDrmSite }) {
  return {
    handleCommand(msg) {
      if (isDrmSite && msg.type === "command:play") {
        this.queued = msg.position;
        return;
      }
      if (isDrmSite && msg.type === "command:seek" && this.queued === msg.position) {
        video.currentTime = msg.position;
        queueMicrotask(() => video.play());
      }
    },
    flushTimers() {
      return new Promise(resolve => setTimeout(resolve, 0));
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test extension/tests/content_runtime.test.js`
Expected: PASS for the new queued-play regression.

- [ ] **Step 5: Commit**

```bash
git add extension/content_runtime.js extension/tests/content_runtime.test.js
git commit -m "test: add DRM command sequencer regression coverage"
```

### Task 2: Wire the runtime into `extension/content.js`

**Files:**
- Modify: `extension/content.js`
- Modify: `extension/content_runtime.js`
- Test: `extension/tests/content_runtime.test.js`

- [ ] **Step 1: Extend the failing tests for timeout fallback and non-DRM behavior**

```js
test("drm queued play falls back to play when matching seek never arrives", async () => {
  const video = makeVideo({ paused: true, currentTime: 100 });
  const runtime = createContentRuntime({ video, isDrmSite: true });

  runtime.handleCommand({ type: "command:play", position: 400 });
  await runtime.flushTimers();

  assert.deepEqual(video.ops, ["play"]);
});

test("non-drm play stays immediate", async () => {
  const video = makeVideo({ paused: true, currentTime: 100 });
  const runtime = createContentRuntime({ video, isDrmSite: false });

  runtime.handleCommand({ type: "command:play", position: 400 });

  assert.deepEqual(video.ops, ["play"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test extension/tests/content_runtime.test.js`
Expected: FAIL because fallback and non-DRM behaviors are not implemented yet.

- [ ] **Step 3: Implement the real sequencer and integrate it**

```js
if (shouldQueueDrmPlay(video, msg)) {
  queueDrmPlay(msg.position);
  return;
}

if (consumeQueuedDrmPlay(msg.position)) {
  applyPausedSeek(msg.position);
  scheduleQueuedPlayRelease();
  return;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test extension/tests/content_runtime.test.js`
Expected: PASS for queued play, timeout fallback, and non-DRM cases.

- [ ] **Step 5: Commit**

```bash
git add extension/content.js extension/content_runtime.js extension/tests/content_runtime.test.js
git commit -m "fix: queue DRM play until matching seek settles"
```

### Task 3: Verify Phoenix-side behavior stays intact

**Files:**
- Modify: `test/byob_web/channels/extension_channel_test.exs`

- [ ] **Step 1: Write the failing test**

```elixir
test "video play and seek still broadcast separately", %{socket: socket, room_id: room_id} do
  Phoenix.PubSub.subscribe(Byob.PubSub, "room:#{room_id}")

  ExtensionChannel.handle_in("video:play", %{"position" => 10.0}, socket)
  ExtensionChannel.handle_in("video:seek", %{"position" => 30.0}, socket)

  assert_receive {:sync_play, %{time: 10.0}}
  assert_receive {:sync_seek, %{time: 30.0}}
end
```

- [ ] **Step 2: Run test to verify it passes as a safety check**

Run: `mix test test/byob_web/channels/extension_channel_test.exs`
Expected: PASS, confirming backend semantics are unchanged by the client-side fix.

- [ ] **Step 3: Keep or refine the assertion if needed**

```elixir
assert_receive {:sync_play, %{time: 10.0}}
assert_receive {:sync_seek, %{time: 30.0}}
```

- [ ] **Step 4: Run the focused tests again**

Run: `mix test test/byob_web/channels/extension_channel_test.exs && node --test extension/tests/content_runtime.test.js`
Expected: PASS for both Elixir and JS regression suites.

- [ ] **Step 5: Commit**

```bash
git add test/byob_web/channels/extension_channel_test.exs
git commit -m "test: preserve backend sync ordering contract"
```

### Task 4: Final verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `VERSION` (only if you intend to cut a new extension build version in the same change)

- [ ] **Step 1: Document the fix**

```md
# v5.0.22

### Queue DRM play until matching seek lands

- On DRM sites, receivers now hold an out-of-order `CMD:play` briefly when it targets a materially different paused position.
- If the matching `CMD:seek` arrives in that window, the receiver seeks while paused and only then resumes playback.
- Non-DRM sites keep the old immediate behavior.
```

- [ ] **Step 2: Run project verification**

Run: `mix precommit`
Expected: PASS for compile, format, and tests.

- [ ] **Step 3: Run the JS regression suite after precommit**

Run: `node --test extension/tests/content_runtime.test.js`
Expected: PASS.

- [ ] **Step 4: Build extension artifacts if desired**

Run: `nix build .#chrome-extension`
Expected: build succeeds and packages the updated extension.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md VERSION
git commit -m "fix: prevent Crunchyroll receiver stalls on remote seek"
```
