const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  createEscapeCancellationController,
  isPlainEscape,
} = require("../../src/helpers/escapeCancellation.js");

function fixture(t, initial, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-escape-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "dictation-escape.json");
  if (initial !== undefined)
    fs.writeFileSync(filename, typeof initial === "string" ? initial : JSON.stringify(initial));
  const events = [];
  let active = null;
  const manager = {
    unregisterSlot(slot) {
      events.push(["unregister", slot]);
      active = null;
    },
    async registerSlot(slot, key, callback) {
      events.push(["register", slot, key]);
      active = callback;
      return { success: true };
    },
  };
  const notifications = [];
  const warnings = [];
  const controller = createEscapeCancellationController({
    fs,
    filename,
    hotkeyManager: manager,
    onChange: (v) => notifications.push(v),
    warn: (s) => warnings.push(s),
    ...overrides,
  });
  return {
    controller,
    manager,
    events,
    notifications,
    warnings,
    filename,
    directory,
    fire: () => active?.(),
    active: () => active,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const tick = () => new Promise((r) => setImmediate(r));

test("new profile defaults OFF and creates no preference file", (t) => {
  const f = fixture(t);
  assert.equal(f.controller.getEnabled(), false);
  assert.equal(fs.existsSync(f.filename), false);
});
test("disabled preference does not register or swallow global Escape", async (t) => {
  const f = fixture(t);
  let calls = 0;
  const result = await f.controller.request("Escape", () => calls++);
  assert.equal(result.success, true);
  assert.equal(result.shortcutActive, false);
  assert.equal(f.events.filter(([type]) => type === "register").length, 0);
  f.fire();
  assert.equal(calls, 0);
});
test("ON persists a boolean atomically and broadcasts without registering when idle", async (t) => {
  const f = fixture(t);
  await f.controller.setEnabled(true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.filename, "utf8")), {
    version: 1,
    escapeCancelsDictation: true,
  });
  assert.equal(fs.existsSync(f.filename + ".tmp"), false);
  assert.deepEqual(f.notifications, [true]);
  assert.equal(f.events.filter(([kind]) => kind === "register").length, 0);
});
test("persisted ON restores on restart", (t) => {
  const f = fixture(t, { version: 1, escapeCancelsDictation: true });
  assert.equal(f.controller.getEnabled(), true);
});
test("persisted OFF restores on restart", (t) => {
  const f = fixture(t, { version: 1, escapeCancelsDictation: false });
  assert.equal(f.controller.getEnabled(), false);
});
test("malformed preference fails safe OFF without overwriting it", (t) => {
  const f = fixture(t, "{broken");
  assert.equal(f.controller.getEnabled(), false);
  assert.equal(fs.readFileSync(f.filename, "utf8"), "{broken");
  assert.equal(f.warnings.length, 1);
});
test("unknown versions and truthy nonbooleans do not enable cancellation", (t) => {
  for (const initial of [
    { version: 2, escapeCancelsDictation: true },
    { version: 1, escapeCancelsDictation: "true" },
    { escapeCancelsDictation: true },
  ]) {
    assert.equal(fixture(t, initial).controller.getEnabled(), false);
  }
});
test("ON permits one cancellation callback during active recording", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await f.controller.setEnabled(true);
  await f.controller.request("Escape", () => calls++);
  f.fire();
  assert.equal(calls, 1);
});
test("turning OFF mid-recording releases key and invalidates previous callback", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await f.controller.setEnabled(true);
  await f.controller.request("Escape", () => calls++);
  const stale = f.active();
  const saving = f.controller.setEnabled(false);
  stale(); // deliberately called before queued native unregister finishes
  await saving;
  assert.equal(calls, 0);
  assert.equal(f.active(), null);
});
test("turning ON mid-recording registers the remembered intent", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await f.controller.request("Escape", () => calls++);
  await f.controller.setEnabled(true);
  f.fire();
  assert.equal(calls, 1);
});
test("recording stop clears intent so later enabling cannot register a stale cancel", async (t) => {
  const f = fixture(t);
  await f.controller.request("Escape", () => assert.fail("ended recording cancelled"));
  await f.controller.clear();
  await f.controller.setEnabled(true);
  assert.equal(f.active(), null);
});
test("clearing intent invalidates a stale callback synchronously", async (t) => {
  const f = fixture(t);
  let calls = 0;
  await f.controller.setEnabled(true);
  await f.controller.request("Escape", () => calls++);
  const stale = f.active();
  const clearing = f.controller.clear();
  stale();
  await clearing;
  assert.equal(calls, 0);
});
test("OFF during delayed registration cannot leave Escape captured", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  let callback;
  let registered = false;
  let calls = 0;
  f.manager.registerSlot = async (_slot, _key, cb) => {
    callback = cb;
    await gate.promise;
    registered = true;
    return { success: true };
  };
  f.manager.unregisterSlot = () => {
    registered = false;
  };
  await f.controller.setEnabled(true);
  const starting = f.controller.request("Escape", () => calls++);
  await tick();
  const disabling = f.controller.setEnabled(false);
  callback();
  gate.resolve();
  await Promise.all([starting, disabling]);
  assert.equal(registered, false);
  assert.equal(calls, 0);
});
test("recording end during delayed registration does not capture Escape afterwards", async (t) => {
  const f = fixture(t);
  const gate = deferred();
  let registered = false;
  f.manager.registerSlot = async () => {
    await gate.promise;
    registered = true;
    return true;
  };
  f.manager.unregisterSlot = () => {
    registered = false;
  };
  await f.controller.setEnabled(true);
  const starting = f.controller.request("Escape", () => {});
  await tick();
  const ending = f.controller.clear();
  gate.resolve();
  await Promise.all([starting, ending]);
  assert.equal(registered, false);
});
test("replacement recording invalidates callback from preceding recording", async (t) => {
  const f = fixture(t);
  let old = 0;
  let current = 0;
  await f.controller.setEnabled(true);
  await f.controller.request("Escape", () => old++);
  const stale = f.active();
  const next = f.controller.request("Escape", () => current++);
  stale();
  await next;
  f.fire();
  assert.equal(old, 0);
  assert.equal(current, 1);
});
test("invalid setter input cannot write or enable preference", async (t) => {
  const f = fixture(t);
  assert.equal((await f.controller.setEnabled("true")).success, false);
  assert.equal(f.controller.getEnabled(), false);
  assert.equal(fs.existsSync(f.filename), false);
});
test("invalid key or callback is rejected without native registration", async (t) => {
  const f = fixture(t);
  for (const key of [null, 5, "", " ", "x".repeat(129)])
    assert.equal((await f.controller.request(key, () => {})).success, false);
  assert.equal((await f.controller.request("Escape", null)).success, false);
  assert.equal(f.events.length, 0);
});
test("write failure preserves old value and does not broadcast", async (t) => {
  const f = fixture(t);
  const badFs = Object.create(fs);
  badFs.writeFileSync = () => {
    throw new Error("disk unavailable");
  };
  const c = createEscapeCancellationController({
    fs: badFs,
    filename: f.filename,
    hotkeyManager: f.manager,
    onChange: () => assert.fail("should not broadcast"),
  });
  const result = await c.setEnabled(true);
  assert.equal(result.success, false);
  assert.equal(c.getEnabled(), false);
});
test("failed registration is surfaced and a later request can recover", async (t) => {
  const f = fixture(t);
  await f.controller.setEnabled(true);
  const original = f.manager.registerSlot;
  f.manager.registerSlot = async () => {
    throw new Error("binding unavailable");
  };
  assert.equal((await f.controller.request("Escape", () => {})).success, false);
  f.manager.registerSlot = original;
  assert.equal((await f.controller.request("Escape", () => {})).success, true);
});
test("notification failure does not lose persisted setting or key release", async (t) => {
  const f = fixture(t, undefined, {
    onChange: () => {
      throw new Error("window closed");
    },
  });
  assert.equal((await f.controller.setEnabled(true)).success, true);
  assert.equal(f.controller.getEnabled(), true);
});
test("preference writes do not touch existing secret, dictionary, or database files", async (t) => {
  const f = fixture(t);
  for (const name of [".env", "keys.enc", "history.db", "dictionary.json"])
    fs.writeFileSync(path.join(f.directory, name), "untouched");
  await f.controller.setEnabled(true);
  await f.controller.setEnabled(false);
  for (const name of [".env", "keys.enc", "history.db", "dictionary.json"])
    assert.equal(fs.readFileSync(path.join(f.directory, name), "utf8"), "untouched");
});
test("only plain Escape names are identified; modified keys are not reclassified", () => {
  for (const key of ["Escape", "Esc", "escape", " Esc "]) assert.equal(isPlainEscape(key), true);
  for (const key of ["Ctrl+Escape", "Alt+Escape", "C"]) assert.equal(isPlainEscape(key), false);
});
