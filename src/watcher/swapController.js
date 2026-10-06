// Watcher fork (spec O3, O4, O6): rewrite / revert / discard the last insertion
// in place. Never uses Ctrl+A / Ctrl+Z: only Backspace x N then a clipboard paste.

const { checkSwap } = require("./swapGuard");

// Toast kinds (O9): rewriting, rewritten, reverted, discarded, refused,
// rewrite_failed, nothing, busy, unavailable.

function createSwapController({
  tracker,
  input, // WatcherInput-like: foregroundId(), lastUserInputAt(), backspace(n, id), isAvailable()
  chain, // providerChain: rewrite(text, systemPrompt)
  deleteAndPaste, // async (n, targetId, text|null) -> "OK" | error code
  toast = () => {},
  getSettings = () => ({}),
  now = () => Date.now(),
  logger = null,
}) {
  let busy = false;

  async function guard(entry) {
    const [foregroundId, lastUserInputAt] = await Promise.all([
      input.foregroundId(),
      input.lastUserInputAt(),
    ]);
    return checkSwap({
      entry,
      foregroundId,
      lastUserInputAt,
      now: now(),
      maxAgeMs: getSettings().maxAgeMs,
    });
  }

  // Deletes what is on screen and pastes `version` ("raw"/"rewrite") or nothing.
  async function replace(entry, version) {
    const text = version ? (version === "raw" ? entry.raw : entry.rewrite) : null;
    const result = await deleteAndPaste(entry.n, entry.target.id, text);
    if (result !== "OK") {
      // Deleted but not re-pasted: on-screen text no longer matches the cache.
      if (result === "paste_failed") tracker.clear();
      return { ok: false, reason: result };
    }
    if (version) tracker.switchTo(version);
    else tracker.clear();
    return { ok: true };
  }

  async function run(action, body) {
    if (busy) {
      toast("busy");
      return { ok: false, reason: "busy" };
    }
    if (!input.isAvailable()) {
      toast("unavailable");
      return { ok: false, reason: "unavailable" };
    }
    busy = true;
    try {
      return await body();
    } catch (error) {
      logger?.warn?.("Swap action failed", { action, error: error.message }, "watcher");
      toast("refused", { reason: "error" });
      return { ok: false, reason: "error" };
    } finally {
      busy = false;
    }
  }

  function refuse(reason) {
    if (reason === "nothing") toast("nothing");
    else toast("refused", { reason });
    return { ok: false, reason };
  }

  function rewrite() {
    return run("rewrite", async () => {
      let entry = tracker.get();
      if (!entry) return refuse("nothing");
      if (entry.current === "rewrite") return { ok: true, reason: "already" };

      let check = await guard(entry);
      if (!check.ok) return refuse(check.reason);

      if (entry.rewrite == null) {
        toast("rewriting");
        try {
          const result = await chain.rewrite(entry.raw.trim(), getSettings().systemPrompt);
          tracker.setRewrite(result.text);
        } catch (error) {
          logger?.warn?.("Rewrite failed", { attempts: error.attempts }, "watcher");
          toast("rewrite_failed");
          return { ok: false, reason: "rewrite_failed" };
        }
        // The API call took time; the user may have moved on meanwhile.
        entry = tracker.get();
        check = await guard(entry);
        if (!check.ok) return refuse(check.reason);
      }

      const swapped = await replace(entry, "rewrite");
      if (!swapped.ok) return refuse(swapped.reason);
      toast("rewritten");
      return { ok: true };
    });
  }

  function revert() {
    return run("revert", async () => {
      const entry = tracker.get();
      if (!entry) return refuse("nothing");
      if (entry.current === "raw") return { ok: true, reason: "already" };
      const check = await guard(entry);
      if (!check.ok) return refuse(check.reason);
      const swapped = await replace(entry, "raw");
      if (!swapped.ok) return refuse(swapped.reason);
      toast("reverted");
      return { ok: true };
    });
  }

  function discard() {
    return run("discard", async () => {
      const entry = tracker.get();
      if (!entry) return refuse("nothing");
      const check = await guard(entry);
      if (!check.ok) return refuse(check.reason);
      const removed = await replace(entry, null);
      if (!removed.ok) return refuse(removed.reason);
      toast("discarded");
      return { ok: true };
    });
  }

  return { rewrite, revert, discard, isBusy: () => busy };
}

module.exports = { createSwapController };
