// Watcher fork entry point (main process). Upstream hooks:
//   main.js       initWatcher(...) after environment init (gets windowManager for
//                 Watcher talk -> dictation and the dictation lifecycle)
//   ipcHandlers   paste-text calls onTextInserted({ pasted, target })
//   preload.js    watcherGetConfig / watcherSetConfig
// Windows only for now; other platforms get a no-op.

const path = require("path");
const { app, globalShortcut, ipcMain, powerMonitor } = require("electron");

const { createConfigStore, findDictationConflicts, HOTKEY_FIELDS } = require("./config");
const { createInsertionTracker } = require("./insertionTracker");
const { createLinkBridge } = require("./linkBridge");
const { encodeState } = require("./linkProtocol");
const { createProviderChain, DEFAULT_CHAIN } = require("./providerChain");
const { createSwapController } = require("./swapController");
const { createPcMicTalkSource } = require("./talkSource");
const { createToast } = require("./toast");
const { WatcherInput } = require("./watcherInput");
const { WatcherLink } = require("./watcherLink");

// After resume the Bluetooth stack needs a moment before WinRT sessions work.
const RESUME_RESTART_MS = 3000;

function buildProviders(config) {
  return DEFAULT_CHAIN.filter((p) => config.providers[p.id]?.enabled).map((p) => ({
    ...p,
    model: config.providers[p.id].model,
  }));
}

function initWatcher({ ipcHandlers, clipboardManager, sidecarRegistry, windowManager, logger }) {
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

  const link = new WatcherLink({ logger });
  const bridge = createLinkBridge({
    controller,
    talk: createPcMicTalkSource({ windowManager, logger }),
    sendEnter: () => input.enter(),
    tracker,
    sendState: (state, address) => link.write(address || "*", encodeState(state)),
    toast: (kind, detail) => toast.show(kind, detail),
    getSettings: () => store.get(),
    logger,
  });
  link.on("event", (event, device) => {
    Promise.resolve(bridge.handleEvent(event, device)).catch((error) =>
      logger?.warn?.("Watcher event error", { name: event.name, error: error.message }, "watcher")
    );
  });
  link.on("audio", (packet) => bridge.onAudio(packet));
  link.on("connected", (device) => bridge.onConnected(device));

  // Busy/error feedback for the Watcher follows OpenWhispr's dictation lifecycle.
  if (windowManager?.setDictationLifecycleState) {
    const setLifecycle = windowManager.setDictationLifecycleState.bind(windowManager);
    windowManager.setDictationLifecycleState = (state, inputKind) => {
      setLifecycle(state, inputKind);
      bridge.onDictationLifecycle(windowManager._dictationLifecycleState);
    };
  }

  function syncLink() {
    const config = store.get();
    if (isWindows && config.enabled && config.linkEnabled) {
      if (!link.wanted) link.start();
    } else if (link.wanted) {
      link.stop();
    }
  }

  let resumeTimer = null;
  powerMonitor?.on?.("resume", () => {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => link.restart(), RESUME_RESTART_MS);
  });

  const actions = {
    rewriteKey: () => bridge.rewrite(),
    revertKey: () => bridge.revert(),
    discardKey: () => bridge.discard(),
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
          logger?.info?.("Watcher hotkey", { field }, "watcher");
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
    const config = store.get();
    return {
      config,
      platformSupported: isWindows,
      helperAvailable: input.isAvailable(),
      hotkeys: hotkeyStatus,
      dictationKey: process.env.DICTATION_KEY || "",
      dictationConflicts: findDictationConflicts(process.env.DICTATION_KEY, config),
      link: link.status(),
    };
  }

  ipcMain.handle("watcher-get-config", () => status());
  ipcMain.handle("watcher-set-config", (_event, patch) => {
    store.set(patch || {});
    registerHotkeys();
    syncLink();
    return status();
  });

  ipcHandlers.onTextInserted = ({ pasted, target }) => {
    if (!isWindows || !store.get().enabled) return;
    const entry = tracker.record({ pasted, target });
    logger?.info?.(
      "Insertion recorded",
      { n: entry.n, target: target?.id ?? null, exe: target?.exeName ?? null },
      "watcher"
    );
    bridge.onInsertion();
  };

  sidecarRegistry?.register?.("watcher-input", () => {
    input.stop();
    link.stop();
    clearTimeout(resumeTimer);
    toast.destroy();
  });

  registerHotkeys();
  syncLink();
  logger?.info?.(
    "Watcher fork initialized",
    { helper: input.isAvailable(), link: link.isAvailable() },
    "watcher"
  );
  return { controller, tracker, bridge, link, status };
}

module.exports = { initWatcher, buildProviders };
