const test = require("node:test");
const assert = require("node:assert/strict");

const { createLinkBridge, stateAfterSwap } = require("../../src/watcher/linkBridge");
const { createInsertionTracker } = require("../../src/watcher/insertionTracker");
const { STATE, parseEvent } = require("../../src/watcher/linkProtocol");

function setup({ swapResults = {}, enter = "OK" } = {}) {
  let t = 1000;
  const now = () => t;
  const tracker = createInsertionTracker({ now });
  const states = [];
  const calls = [];
  const toasts = [];
  const timers = [];
  let busy = false;
  const controller = {
    isBusy: () => busy,
    async rewrite() {
      calls.push("rewrite");
      const r = swapResults.rewrite || { ok: true };
      if (r.ok) {
        tracker.setRewrite("Goal: x");
        tracker.switchTo("rewrite");
      }
      return r;
    },
    async revert() {
      calls.push("revert");
      const r = swapResults.revert || { ok: true };
      if (r.ok) tracker.switchTo("raw");
      return r;
    },
    async discard() {
      calls.push("discard");
      const r = swapResults.discard || { ok: true };
      if (r.ok) tracker.clear();
      return r;
    },
  };
  const talk = {
    start: (a) => calls.push(["talk.start", a]),
    end: (a) => calls.push(["talk.end", a]),
    cancel: (a) => calls.push(["talk.cancel", a]),
    audio: (p) => calls.push(["talk.audio", p.seq]),
  };
  const bridge = createLinkBridge({
    controller,
    talk,
    tracker,
    sendEnter: async () => {
      calls.push("enter");
      return enter;
    },
    sendState: (state, address) => states.push(address ? [state, address] : state),
    toast: (kind, detail) => toasts.push(detail?.reason ? `${kind}:${detail.reason}` : kind),
    getSettings: () => ({ maxAgeMs: 300000 }),
    now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, done: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => timer && (timer.done = true),
  });
  const fire = () => {
    for (const timer of timers.splice(0)) if (!timer.done) timer.fn();
  };
  const insert = () => {
    tracker.record({ pasted: "fix the bug ", target: { id: "0xA1" } });
    bridge.onInsertion();
  };
  const ev = (...bytes) => bridge.handleEvent(parseEvent([0, ...bytes]), { address: "AA" });
  return {
    bridge,
    tracker,
    states,
    calls,
    toasts,
    fire,
    insert,
    ev,
    setBusy: (b) => (busy = b),
    advance: (ms) => (t += ms),
  };
}

test("talk events drive the talk source", () => {
  const s = setup();
  s.ev(0x01, 7, 0);
  s.bridge.onAudio({ session: 7, seq: 0, frame: Buffer.alloc(0) });
  s.ev(0x02, 7, 50, 0);
  assert.deepEqual(s.calls, [
    ["talk.start", { session: 7, latched: false }],
    ["talk.audio", 0],
    ["talk.end", { session: 7, frames: 50 }],
  ]);
});

test("dictation: busy while transcribing, raw once pasted", () => {
  const s = setup();
  s.ev(0x01, 1, 0);
  s.ev(0x02, 1, 10, 0);
  s.bridge.onDictationLifecycle("processing");
  s.bridge.onDictationLifecycle("idle");
  s.insert();
  s.fire();
  assert.deepEqual(s.states, [STATE.BUSY, STATE.RAW]);
});

test("dictation: paste before the lifecycle ends still reports raw", () => {
  const s = setup();
  s.ev(0x02, 1, 10, 0);
  s.bridge.onDictationLifecycle("processing");
  s.insert();
  s.bridge.onDictationLifecycle("idle");
  s.fire();
  assert.deepEqual(s.states, [STATE.BUSY, STATE.RAW]);
});

test("Watcher talk that pastes nothing reports error", () => {
  const s = setup();
  s.ev(0x02, 1, 10, 0);
  s.bridge.onDictationLifecycle("processing");
  s.bridge.onDictationLifecycle("idle");
  s.fire();
  assert.deepEqual(s.states, [STATE.BUSY, STATE.ERROR]);
});

test("Watcher talk that never reaches transcription reports error", () => {
  const s = setup();
  s.ev(0x02, 1, 10, 0);
  s.fire();
  assert.deepEqual(s.states, [STATE.ERROR]);
});

test("keyboard dictation that pastes nothing just resyncs", () => {
  const s = setup();
  s.insert();
  s.bridge.onDictationLifecycle("processing");
  s.bridge.onDictationLifecycle("idle");
  s.fire();
  assert.deepEqual(s.states, [STATE.RAW, STATE.BUSY, STATE.RAW]);
});

test("talk_cancel cancels and resyncs", () => {
  const s = setup();
  s.ev(0x01, 2, 1);
  s.ev(0x03, 2);
  s.fire();
  assert.deepEqual(s.calls.at(-1), ["talk.cancel", { session: 2 }]);
  assert.deepEqual(s.states, [STATE.IDLE]);
});

test("rewrite: busy then rewritten; revert: raw; discard: idle", async () => {
  const s = setup();
  s.insert();
  await s.ev(0x04);
  await s.ev(0x05);
  await s.ev(0x06);
  assert.deepEqual(s.calls, ["rewrite", "revert", "discard"]);
  assert.deepEqual(s.states, [STATE.RAW, STATE.BUSY, STATE.REWRITTEN, STATE.RAW, STATE.IDLE]);
});

test("failed swaps: nothing -> idle, refused -> error", async () => {
  const s = setup({
    swapResults: {
      rewrite: { ok: false, reason: "rewrite_failed" },
      revert: { ok: false, reason: "nothing" },
      discard: { ok: false, reason: "user_input" },
    },
  });
  s.insert();
  await s.ev(0x04);
  await s.ev(0x05);
  await s.ev(0x06);
  assert.deepEqual(s.states, [STATE.RAW, STATE.BUSY, STATE.ERROR, STATE.IDLE, STATE.ERROR]);
});

test("send injects Enter and clears the insertion", async () => {
  const s = setup();
  s.insert();
  const r = await s.ev(0x07);
  assert.equal(r.ok, true);
  assert.equal(s.tracker.get(), null);
  assert.deepEqual(s.states, [STATE.RAW, STATE.IDLE]);
});

test("send failure reports error and keeps the insertion", async () => {
  const s = setup({ enter: "modifiers" });
  s.insert();
  await s.ev(0x07);
  assert.notEqual(s.tracker.get(), null);
  assert.deepEqual(s.toasts, ["refused:modifiers"]);
  assert.deepEqual(s.states.at(-1), STATE.ERROR);
});

test("send while a swap runs is refused as busy", async () => {
  const s = setup();
  s.insert();
  s.setBusy(true);
  await s.ev(0x07);
  assert.ok(!s.calls.includes("enter"));
  assert.deepEqual(s.toasts, ["busy"]);
});

test("connect pushes the current state to that Watcher only", () => {
  const s = setup();
  s.bridge.onConnected({ address: "AA" });
  s.insert();
  s.bridge.onConnected({ address: "BB" });
  s.advance(400000); // older than max age
  s.bridge.onConnected({ address: "CC" });
  assert.deepEqual(s.states, [
    [STATE.IDLE, "AA"],
    STATE.RAW,
    [STATE.RAW, "BB"],
    [STATE.IDLE, "CC"],
  ]);
});

test("battery toasts once per low/critical transition, not while charging", () => {
  const s = setup();
  s.ev(0x10, 40, 0);
  s.ev(0x10, 15, 0b010);
  s.ev(0x10, 14, 0b010);
  s.ev(0x10, 5, 0b110);
  s.ev(0x10, 5, 0b111);
  s.ev(0x10, 50, 0b001);
  s.ev(0x10, 14, 0b011);
  assert.deepEqual(s.toasts, ["battery_low", "battery_critical"]);
});

test("stateAfterSwap", () => {
  const cur = () => STATE.RAW;
  assert.equal(stateAfterSwap({ ok: true }, cur), STATE.RAW);
  assert.equal(stateAfterSwap({ ok: false, reason: "busy" }, cur), STATE.RAW);
  assert.equal(stateAfterSwap({ ok: false, reason: "nothing" }, cur), STATE.IDLE);
  assert.equal(stateAfterSwap({ ok: false, reason: "focus_changed" }, cur), STATE.ERROR);
});
