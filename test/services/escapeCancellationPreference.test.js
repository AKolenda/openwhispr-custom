const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createEscapePreferenceClient, shouldProtectDictationFromEscape } = require(
  process.env.ESCAPE_PREFERENCE_TEST_MODULE ||
    path.resolve(__dirname, "../../src/services/escapeCancellationPreference.ts")
);
const tick = () => new Promise((r) => setImmediate(r));
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function bridge() {
  const initial = deferred();
  let change;
  let subscriptions = 0;
  let removals = 0;
  const api = {
    getEscapeCancelsDictation: () => initial.promise,
    onEscapeCancelsDictationChanged: (callback) => {
      change = callback;
      subscriptions++;
      return () => {
        removals++;
      };
    },
    setEscapeCancelsDictation: async (enabled) => {
      change?.(enabled);
      return { success: true, enabled };
    },
  };
  return {
    api,
    initial,
    change: (v) => change?.(v),
    subscriptions: () => subscriptions,
    removals: () => removals,
  };
}
test("renderer starts protected while IPC preference is loading", () => {
  const c = createEscapePreferenceClient(undefined);
  assert.equal(c.getSnapshot().enabled, false);
});
test("setting ON is hydrated from main process", async () => {
  const b = bridge();
  const c = createEscapePreferenceClient(b.api);
  const stop = c.connect();
  b.initial.resolve(true);
  await tick();
  assert.equal(c.getSnapshot().enabled, true);
  assert.equal(c.getSnapshot().ready, true);
  stop();
});
test("new change notification wins over a stale initial read", async () => {
  const b = bridge();
  const c = createEscapePreferenceClient(b.api);
  const stop = c.connect();
  b.change(false);
  b.initial.resolve(true);
  await tick();
  assert.equal(c.getSnapshot().enabled, false);
  stop();
});
test("main notification updates event-time snapshot synchronously", () => {
  const b = bridge();
  const c = createEscapePreferenceClient(b.api);
  const stop = c.connect();
  b.change(true);
  assert.equal(c.getSnapshot().enabled, true);
  b.change(false);
  assert.equal(c.getSnapshot().enabled, false);
  stop();
});
test("several React consumers share one subscription", () => {
  const b = bridge();
  const c = createEscapePreferenceClient(b.api);
  const a = c.connect();
  const d = c.connect();
  assert.equal(b.subscriptions(), 1);
  a();
  assert.equal(b.removals(), 0);
  d();
  assert.equal(b.removals(), 1);
  d();
  assert.equal(b.removals(), 1);
});
test("unmounted initial read and notification cannot modify active snapshot", async () => {
  const b = bridge();
  const c = createEscapePreferenceClient(b.api);
  const stop = c.connect();
  stop();
  b.change(true);
  b.initial.resolve(true);
  await tick();
  assert.equal(c.getSnapshot().enabled, false);
});
test("invalid incoming notification is ignored", () => {
  const b = bridge();
  const c = createEscapePreferenceClient(b.api);
  const stop = c.connect();
  b.change("true");
  assert.equal(c.getSnapshot().enabled, false);
  stop();
});
test("missing preload bridge leaves safe OFF and visible error", () => {
  const c = createEscapePreferenceClient(undefined);
  const stop = c.connect();
  assert.equal(c.getSnapshot().enabled, false);
  assert.match(c.getSnapshot().error, /unavailable/);
  stop();
});
test("saving updates all subscribers and no longer loading", async () => {
  const b = bridge();
  const c = createEscapePreferenceClient(b.api);
  const stop = c.connect();
  let notifications = 0;
  const unsubscribe = c.subscribe(() => notifications++);
  await c.setEnabled(true);
  assert.equal(c.getSnapshot().enabled, true);
  assert.equal(c.getSnapshot().saving, false);
  assert.ok(notifications > 0);
  unsubscribe();
  stop();
});
test("saving failure does not pretend the setting was persisted", async () => {
  const b = bridge();
  b.api.setEscapeCancelsDictation = async () => ({
    success: false,
    enabled: false,
    error: "Disk full",
  });
  const c = createEscapePreferenceClient(b.api);
  await c.setEnabled(true);
  assert.equal(c.getSnapshot().enabled, false);
  assert.equal(c.getSnapshot().error, "Disk full");
  assert.equal(c.getSnapshot().saving, false);
});
test("OFF protects capture, microphone startup, stopping, and cleanup separately", () => {
  for (const phase of ["isRecording", "isPreparing", "isProcessing", "isStopping"])
    assert.equal(shouldProtectDictationFromEscape(false, { [phase]: true }), true);
});
test("ON allows original Escape behavior in every phase", () => {
  for (const phase of ["isRecording", "isPreparing", "isProcessing", "isStopping"])
    assert.equal(shouldProtectDictationFromEscape(true, { [phase]: true }), false);
});
test("OFF does not alter idle menu/panel Escape behavior", () => {
  assert.equal(shouldProtectDictationFromEscape(false, {}), false);
});
