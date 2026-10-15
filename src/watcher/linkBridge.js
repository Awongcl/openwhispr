// Watcher fork (spec O14, W1, §7): turns Watcher link events into fork actions
// and keeps the Watcher's insertion state (idle/raw/rewritten/busy/error) in step.
// Keyboard hotkeys go through the same rewrite/revert/discard so the state follows.

const { EVT, STATE } = require("./linkProtocol");

// Grace for the paste after transcription ends, and for a talk that never
// reached transcription (dictation blocked, mic failed to open).
const PASTE_GRACE_MS = 1500;
const TALK_END_TIMEOUT_MS = 4000;

// State after a swap action: success follows the tracker; "busy" changes nothing.
function stateAfterSwap(result, current) {
  if (result?.ok) return current();
  if (result?.reason === "nothing") return STATE.IDLE;
  if (result?.reason === "busy") return current();
  return STATE.ERROR;
}

function createLinkBridge({
  controller, // swapController: rewrite(), revert(), discard(), isBusy()
  talk, // talkSource (see talkSource.js)
  sendEnter, // async () -> "OK" | error code
  tracker,
  sendState, // (state, address?) -> void; address omitted = every connected Watcher
  toast = () => {},
  getSettings = () => ({}),
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = null,
}) {
  let processing = false; // OpenWhispr is transcribing
  let swapping = false; // rewrite in flight
  let insertions = 0;
  let pending = null; // { insertions, watcher } while waiting for a paste
  let graceTimer = null;
  let talkTimer = null;
  const batteryAlerts = new Map(); // address -> "low" | "critical" | null

  function current() {
    if (processing || swapping) return STATE.BUSY;
    const entry = tracker.get();
    if (!entry) return STATE.IDLE;
    const maxAgeMs = getSettings().maxAgeMs;
    const last = Math.max(entry.insertedAt, entry.swappedAt || 0);
    if (maxAgeMs && now() - last > maxAgeMs) return STATE.IDLE;
    return entry.current === "rewrite" ? STATE.REWRITTEN : STATE.RAW;
  }

  function push(state, address) {
    logger?.debug?.("Watcher state", { state, address: address || "*" }, "watcher");
    sendState(state, address);
  }

  function clearTimers() {
    clearTimer(graceTimer);
    clearTimer(talkTimer);
    graceTimer = talkTimer = null;
  }

  async function swap(kind) {
    const isRewrite = kind === "rewrite";
    if (isRewrite && !controller.isBusy()) {
      swapping = true;
      push(STATE.BUSY);
    }
    let result;
    try {
      result = await controller[kind]();
    } finally {
      if (isRewrite) swapping = false;
    }
    push(stateAfterSwap(result, current));
    return result;
  }

  async function send() {
    if (controller.isBusy() || processing) {
      toast("busy");
      push(current());
      return { ok: false, reason: "busy" };
    }
    let result;
    try {
      result = await sendEnter();
    } catch {
      result = "error";
    }
    if (result === "OK") {
      tracker.clear(); // submitted: nothing left to swap
      push(STATE.IDLE);
      return { ok: true };
    }
    logger?.info?.("Watcher send failed", { reason: result }, "watcher");
    toast("refused", { reason: result });
    push(STATE.ERROR);
    return { ok: false, reason: result };
  }

  function battery(event, device) {
    const b = event.battery;
    const level = b.critical ? "critical" : b.low ? "low" : null;
    const prev = batteryAlerts.get(device.address) || null;
    batteryAlerts.set(device.address, level);
    if (level && level !== prev && !b.charging && !b.docked) toast(`battery_${level}`);
  }

  function handleEvent(event, device = {}) {
    logger?.info?.("Watcher event", { name: event.name, seq: event.seq }, "watcher");
    switch (event.code) {
      case EVT.TALK_START:
        clearTimers();
        talk.start({ session: event.session, latched: event.latched });
        return null;
      case EVT.TALK_END:
        talk.end({ session: event.session, frames: event.frames });
        pending = { insertions, watcher: true };
        clearTimer(talkTimer);
        talkTimer = setTimer(() => {
          talkTimer = null;
          // Never reached transcription and nothing was pasted.
          if (!processing && pending && insertions === pending.insertions) {
            pending = null;
            push(STATE.ERROR);
          }
        }, TALK_END_TIMEOUT_MS);
        return null;
      case EVT.TALK_CANCEL:
        clearTimers();
        pending = null;
        talk.cancel({ session: event.session });
        push(current());
        return null;
      case EVT.REWRITE:
        return swap("rewrite");
      case EVT.REVERT:
        return swap("revert");
      case EVT.DISCARD:
        return swap("discard");
      case EVT.SEND:
        return send();
      case EVT.BATTERY:
        battery(event, device);
        return null;
      default:
        logger?.debug?.("Watcher event ignored", { code: event.code }, "watcher");
        return null;
    }
  }

  // OpenWhispr dictation lifecycle: idle | preparing | recording | processing.
  function onDictationLifecycle(lifecycle) {
    if (lifecycle === "processing") {
      if (processing) return;
      processing = true;
      clearTimer(talkTimer);
      talkTimer = null;
      if (!pending) pending = { insertions, watcher: false };
      push(STATE.BUSY);
      return;
    }
    if (!processing) return;
    processing = false;
    const waiting = pending;
    pending = null;
    clearTimer(graceTimer);
    if (!waiting || insertions !== waiting.insertions) {
      push(current()); // pasted while still processing
      return;
    }
    graceTimer = setTimer(() => {
      graceTimer = null;
      if (insertions !== waiting.insertions) return; // pasted since; onInsertion pushed
      // A Watcher talk that pasted nothing is an error (LED); otherwise just resync.
      push(waiting.watcher ? STATE.ERROR : current());
    }, PASTE_GRACE_MS);
  }

  function onInsertion() {
    insertions++;
    pending = null;
    clearTimers();
    if (!processing) push(current());
  }

  function onConnected(device) {
    push(current(), device.address);
  }

  return {
    handleEvent,
    onDictationLifecycle,
    onInsertion,
    onConnected,
    onAudio: (packet) => talk.audio(packet),
    rewrite: () => swap("rewrite"),
    revert: () => swap("revert"),
    discard: () => swap("discard"),
    send,
    currentState: current,
  };
}

module.exports = { createLinkBridge, stateAfterSwap, PASTE_GRACE_MS, TALK_END_TIMEOUT_MS };
