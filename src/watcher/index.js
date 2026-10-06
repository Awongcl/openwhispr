// Watcher fork entry point (main process). Upstream hooks:
//   main.js       initWatcher(...) after environment init
//   ipcHandlers   paste-text calls onTextInserted({ pasted, target })
//   preload.js    watcherGetConfig / watcherSetConfig
// Windows only for now; other platforms get a no-op.

const path = require("path");
const { app, globalShortcut, ipcMain } = require("electron");

const { createConfigStore, HOTKEY_FIELDS } = require("./config");
const { createInsertionTracker } = require("./insertionTracker");
const { createProviderChain, DEFAULT_CHAIN } = require("./providerChain");
const { createSwapController } = require("./swapController");
const { createToast } = require("./toast");
const { WatcherInput } = require("./watcherInput");

function buildProviders(config) {
  return DEFAULT_CHAIN.filter((p) => config.providers[p.id]?.enabled).map((p) => ({
    ...p,
    model: config.providers[p.id].model,
  }));
}

function initWatcher({ ipcHandlers, clipboardManager, sidecarRegistry, logger }) {
  const isWindows = process.platform === "win32";
  const store = createConfigStore(path.join(app.getPath("userData"), "watcher-config.json"));
  const tracker = createInsertionTracker();
  const input = new WatcherInput({ logger });
  const toast = createToast();
  let registered = {}; // field -> accelerator actually registered
  let hotkeyStatus = {};

  async function deleteAndPaste(n, targetId, text) {
    const bs = await clipboardManager.runClipboardOperation(() => input.backspace(n, targetId));
    if (bs !== "OK") return bs;
    if (text == null) return "OK";
    try {
      const result = await clipboardManager.pasteText(text, {
        targetWindow: targetId,
        silentAccessibilityCheck: true,
      });
      return result?.pasted === false ? "paste_failed" : "OK";
    } catch {
      return "paste_failed";
    }
  }

  const controller = createSwapController({
    tracker,
    input,
    deleteAndPaste,
    toast: (kind, detail) => toast.show(kind, detail),
    getSettings: () => store.get(),
    logger,
    chain: {
      rewrite: (text, systemPrompt) => {
        const config = store.get();
        return createProviderChain({
          providers: buildProviders(config),
          timeoutMs: config.timeoutMs,
          logger,
        }).rewrite(text, systemPrompt);
      },
    },
  });

  const actions = {
    rewriteKey: () => controller.rewrite(),
    revertKey: () => controller.revert(),
    discardKey: () => controller.discard(),
  };

  function registerHotkeys() {
    for (const accelerator of Object.values(registered)) {
      try {
        globalShortcut.unregister(accelerator);
      } catch {}
    }
    registered = {};
    hotkeyStatus = {};
    const config = store.get();
    if (!isWindows || !config.enabled) return;

    for (const field of HOTKEY_FIELDS) {
      const accelerator = config[field];
      if (!accelerator) continue;
      let ok = false;
      try {
        ok = globalShortcut.register(accelerator, () => {
          actions[field]().catch((error) =>
            logger?.warn?.("Watcher action error", { field, error: error.message }, "watcher")
          );
        });
      } catch {
        ok = false;
      }
      hotkeyStatus[field] = ok;
      if (ok) registered[field] = accelerator;
      else logger?.warn?.("Watcher hotkey unavailable", { field, accelerator }, "watcher");
    }

    // The Watcher's own keys (and the dictation key) are not "user input".
    input.setIgnoredHotkeys([...Object.values(registered), process.env.DICTATION_KEY || ""]);
    input.warmUp();
  }

  function status() {
    return {
      config: store.get(),
      platformSupported: isWindows,
      helperAvailable: input.isAvailable(),
      hotkeys: hotkeyStatus,
    };
  }

  ipcMain.handle("watcher-get-config", () => status());
  ipcMain.handle("watcher-set-config", (_event, patch) => {
    store.set(patch || {});
    registerHotkeys();
    return status();
  });

  ipcHandlers.onTextInserted = ({ pasted, target }) => {
    if (!isWindows || !store.get().enabled) return;
    tracker.record({ pasted, target });
  };

  sidecarRegistry?.register?.("watcher-input", () => {
    input.stop();
    toast.destroy();
  });

  registerHotkeys();
  logger?.info?.("Watcher fork initialized", { helper: input.isAvailable() }, "watcher");
  return { controller, tracker, status };
}

module.exports = { initWatcher, buildProviders };
