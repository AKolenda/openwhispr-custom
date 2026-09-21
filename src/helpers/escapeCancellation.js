/**
 * Owns only the temporary dictation-cancel hotkey and one NON-SECRET preference.
 * OFF by default for this community build. Never reads/writes keys or history.
 * Dependencies are injected so registration races and persistence are testable.
 */
const path = require("node:path");

const SETTINGS_VERSION = 1;
const isPlainEscape = (key) => /^(escape|esc)$/i.test(String(key).trim());

function readEnabled(fs, filename, warn) {
  try {
    const data = JSON.parse(fs.readFileSync(filename, "utf8"));
    return data?.version === SETTINGS_VERSION && data.escapeCancelsDictation === true;
  } catch (error) {
    if (error?.code !== "ENOENT") warn("Could not read Escape preference; protecting dictation.");
    return false;
  }
}

function createEscapeCancellationController({
  fs,
  filename,
  hotkeyManager,
  onChange = () => {},
  warn = () => {},
}) {
  let enabled = readEnabled(fs, filename, warn);
  let requested = null;
  let revision = 0;
  let queue = Promise.resolve();

  function save(value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.tmp`;
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify({ version: SETTINGS_VERSION, escapeCancelsDictation: value }) + "\n",
        { mode: 0o600 }
      );
      fs.renameSync(temporary, filename);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch {}
    }
  }

  async function reconcile() {
    // Unregister, not merely ignore: when disabled, Escape belongs to the app
    // with focus (editors, terminals, menus), not to OpenWhispr's global hook.
    hotkeyManager.unregisterSlot("cancel");
    const intent = requested;
    const generation = revision;
    if (!intent || (isPlainEscape(intent.key) && !enabled)) {
      return { success: true, enabled, shortcutActive: false };
    }
    try {
      const result = await hotkeyManager.registerSlot("cancel", intent.key, () => {
        // Protect against an old callback retained by an async/native listener.
        if (intent !== requested || generation !== revision) return;
        if (isPlainEscape(intent.key) && !enabled) return;
        intent.callback();
      });
      if (generation !== revision || intent !== requested) {
        hotkeyManager.unregisterSlot("cancel");
        return { success: true, enabled, shortcutActive: false };
      }
      if (result === false || result?.success === false) {
        hotkeyManager.unregisterSlot("cancel");
        return {
          success: false,
          enabled,
          shortcutActive: false,
          error: result?.error || "The cancel hotkey could not be registered.",
        };
      }
      return { success: true, enabled, shortcutActive: true };
    } catch (error) {
      hotkeyManager.unregisterSlot("cancel");
      return {
        success: false,
        enabled,
        shortcutActive: false,
        error: error?.message || "The cancel hotkey could not be registered.",
      };
    }
  }

  function schedule() {
    // All native registrations are serialized; a late registration can never
    // overwrite a newer unregister when preference changes during mic startup.
    queue = queue.then(reconcile, reconcile).catch((error) => ({
      success: false,
      enabled,
      shortcutActive: false,
      error: error?.message || "Hotkey update failed.",
    }));
    return queue;
  }

  return {
    getEnabled: () => enabled,
    request(key, callback) {
      if (
        typeof key !== "string" ||
        !key.trim() ||
        key.length > 128 ||
        typeof callback !== "function"
      ) {
        return Promise.resolve({ success: false, enabled, error: "Invalid cancel hotkey." });
      }
      requested = { key: key.trim(), callback };
      revision += 1;
      return schedule();
    },
    clear() {
      requested = null;
      revision += 1;
      return schedule();
    },
    setEnabled(value) {
      if (typeof value !== "boolean") {
        return Promise.resolve({
          success: false,
          enabled,
          error: "Escape preference must be a boolean.",
        });
      }
      try {
        save(value);
      } catch (error) {
        return Promise.resolve({
          success: false,
          enabled,
          error: error?.message || "Could not save Escape preference.",
        });
      }
      enabled = value;
      revision += 1;
      try {
        onChange(enabled);
      } catch {
        warn("Escape preference changed, but a window notification failed.");
      }
      return schedule();
    },
  };
}

module.exports = { createEscapeCancellationController, isPlainEscape };
