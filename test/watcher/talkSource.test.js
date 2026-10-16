const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createPcMicTalkSource,
  createSelectableTalkSource,
  createWatcherTalkSource,
  sendToDictationWindow,
  TALK_AUDIO_CHANNEL,
  TALK_IDLE_MS,
  LEVEL_EVERY_FRAMES,
} = require("../../src/watcher/talkSource");
const { createTalkAssembler } = require("../../src/watcher/talkAudio");

const FRAME_BYTES = 640;

function fakeAssembler() {
  return createTalkAssembler({
    createDecoder: () => ({ decode: () => Buffer.alloc(FRAME_BYTES, 1), destroy() {} }),
  });
}

function watcherSource() {
  const delivered = [];
  const timers = [];
  const source = createWatcherTalkSource({
    assembler: fakeAssembler(),
    deliver: (payload) => {
      delivered.push(payload);
      return true;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
  });
  const fireIdle = () =>
    timers
      .filter((t) => !t.cleared)
      .forEach((t) => {
        t.cleared = true;
        t.fn();
      });
  return { source, delivered, timers, fireIdle };
}

test("watcher source delivers a WAV of the talk on talk_end", () => {
  const { source, delivered } = watcherSource();
  source.start({ session: 4, latched: false });
  for (let seq = 0; seq < 50; seq++) source.audio({ session: 4, seq, frame: Buffer.from([1]) });
  source.end({ session: 4, frames: 50 });
  assert.equal(delivered.length, 1);
  const { session, wav, durationSeconds } = delivered[0];
  assert.equal(session, 4);
  assert.equal(durationSeconds, 1);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.length, 44 + 50 * FRAME_BYTES);
});

test("watcher source: talk_cancel and empty talks deliver nothing", () => {
  const { source, delivered } = watcherSource();
  source.start({ session: 1 });
  source.audio({ session: 1, seq: 0, frame: Buffer.from([1]) });
  source.cancel({ session: 1 });
  source.end({ session: 1, frames: 1 });
  source.start({ session: 2 });
  source.end({ session: 2, frames: 0 });
  source.end({ session: 9, frames: 3 }); // never started
  assert.equal(delivered.length, 0);
});

test("watcher source: an undecodable talk is not transcribed and raises an error", () => {
  const delivered = [];
  const toasts = [];
  const errors = [];
  const source = createWatcherTalkSource({
    assembler: createTalkAssembler({
      createDecoder: () => {
        throw new Error("Cannot find module 'opusscript'");
      },
    }),
    deliver: (payload) => delivered.push(payload),
    toast: (kind) => toasts.push(kind),
    logger: { info() {}, warn() {}, error: (msg, data) => errors.push({ msg, data }) },
    setTimer: () => null,
    clearTimer: () => {},
  });
  source.start({ session: 3 });
  for (let seq = 0; seq < 10; seq++) source.audio({ session: 3, seq, frame: Buffer.from([1]) });
  source.end({ session: 3, frames: 10 });
  assert.equal(delivered.length, 0);
  assert.deepEqual(toasts, ["audio_undecodable"]);
  const skip = errors.find((e) => e.msg === "Watcher talk not transcribed: audio undecodable");
  assert.ok(skip);
  assert.match(skip.data.decoderError, /opusscript/);
});

test("watcher source captures the target window at talk_start (paste + swap guard)", async () => {
  const captures = [];
  const windowManager = {
    selectionManager: { captureTarget: async (opts) => captures.push(opts) },
  };
  const source = createWatcherTalkSource({
    windowManager,
    assembler: fakeAssembler(),
    deliver: () => true,
    setTimer: () => null,
    clearTimer: () => {},
  });
  source.start({ session: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(captures, [{ force: true }]);

  // A failing probe never breaks the talk.
  const failing = createWatcherTalkSource({
    assembler: fakeAssembler(),
    captureTarget: () => {
      throw new Error("no helper");
    },
    deliver: () => true,
    setTimer: () => null,
    clearTimer: () => {},
  });
  failing.start({ session: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(failing.kind, "watcher");
});

test("watcher source drops a talk after 2 s without frames", () => {
  const { source, delivered, timers, fireIdle } = watcherSource();
  source.start({ session: 5 });
  assert.equal(timers.at(-1).ms, TALK_IDLE_MS);
  source.audio({ session: 5, seq: 0, frame: Buffer.from([1]) });
  // Each frame re-arms the timer: only the latest is live.
  assert.equal(timers.filter((t) => !t.cleared).length, 1);
  fireIdle();
  source.end({ session: 5, frames: 1 });
  assert.equal(delivered.length, 0);

  // A finished talk leaves no live timer behind.
  source.start({ session: 6 });
  source.audio({ session: 6, seq: 0, frame: Buffer.from([1]) });
  source.end({ session: 6, frames: 1 });
  assert.equal(timers.filter((t) => !t.cleared).length, 0);
  assert.equal(delivered.length, 1);
});

test("selectable source picks per talk and keeps it until the talk ends", () => {
  const calls = [];
  const fake = (kind) => ({
    kind,
    start: (e) => calls.push(`${kind}:start:${e.session}`),
    audio: (p) => calls.push(`${kind}:audio:${p.seq}`),
    end: (e) => calls.push(`${kind}:end:${e.session}`),
    cancel: (e) => calls.push(`${kind}:cancel:${e.session}`),
  });
  let setting = "watcher";
  const talk = createSelectableTalkSource({
    sources: { watcher: fake("watcher"), "pc-mic": fake("pc-mic") },
    getAudioSource: () => setting,
  });
  talk.start({ session: 1 });
  setting = "pc-mic"; // changed mid-talk
  talk.audio({ session: 1, seq: 0 });
  talk.end({ session: 1 });
  talk.start({ session: 2 });
  talk.cancel({ session: 2 });
  talk.audio({ session: 2, seq: 1 }); // after the talk: dropped
  setting = "bogus";
  talk.start({ session: 3 });
  talk.start({ session: 4 }); // replaces an unfinished talk
  assert.deepEqual(calls, [
    "watcher:start:1",
    "watcher:audio:0",
    "watcher:end:1",
    "pc-mic:start:2",
    "pc-mic:cancel:2",
    "watcher:start:3",
    "watcher:cancel:3",
    "watcher:start:4",
  ]);
});

test("sendToDictationWindow shows the panel and sends on the talk-audio channel", () => {
  const sent = [];
  let shown = 0;
  const windowManager = {
    mainWindow: { isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } },
    showDictationPanel: () => shown++,
  };
  assert.equal(sendToDictationWindow(windowManager, { session: 1 }), true);
  assert.deepEqual(sent, [[TALK_AUDIO_CHANNEL, { session: 1 }]]);
  assert.equal(shown, 1);
  assert.equal(sendToDictationWindow({ mainWindow: null }, {}), false);
});

test("pc-mic source drives OpenWhispr dictation and ignores frames", () => {
  const calls = [];
  const windowManager = {
    sendStartDictation: () => calls.push("start"),
    sendStopDictation: () => calls.push("stop"),
    sendCancelActiveDictation: () => calls.push("cancel"),
  };
  const talk = createPcMicTalkSource({ windowManager });
  talk.start({ session: 1 });
  talk.audio({ session: 1, seq: 0, frame: Buffer.from([1]) });
  talk.end({ session: 1, frames: 1 });
  talk.start({ session: 2 });
  talk.cancel({ session: 2 });
  assert.deepEqual(calls, ["start", "stop", "start", "cancel"]);
});

test("watcher source: live state brackets the talk, levels every LEVEL_EVERY_FRAMES frames", () => {
  const live = [];
  const order = [];
  const source = createWatcherTalkSource({
    assembler: fakeAssembler(),
    deliver: () => {
      order.push("deliver");
      return true;
    },
    live: (p) => {
      live.push(p);
      if (!p.active) order.push("stop");
    },
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  source.start({ session: 7 });
  for (let seq = 0; seq < 6; seq++) source.audio({ session: 7, seq, frame: Buffer.from([1]) });
  source.end({ session: 7, frames: 6 });
  assert.deepEqual(live[0], { session: 7, active: true });
  const levels = live.filter((p) => p.level !== undefined);
  assert.equal(levels.length, 6 / LEVEL_EVERY_FRAMES);
  // fake decoder: every byte 1 -> int16 0x0101 = 257 -> RMS 257/32768
  assert.ok(Math.abs(levels[0].level - 257 / 32768) < 1e-9);
  assert.deepEqual(live.at(-1), { session: 7, active: false });
  assert.deepEqual(order, ["stop", "deliver"]); // pill leaves listening before processing starts
});

test("watcher source: cancel and idle drop end the live state; a throwing live never breaks the talk", () => {
  const live = [];
  const timers = [];
  const source = createWatcherTalkSource({
    assembler: fakeAssembler(),
    deliver: () => true,
    live: (p) => live.push(p),
    setTimer: (fn) => {
      const t = { fn };
      timers.push(t);
      return t;
    },
    clearTimer: () => {},
  });
  source.start({ session: 1 });
  source.cancel({ session: 1 });
  assert.deepEqual(live.at(-1), { session: 1, active: false });
  source.start({ session: 2 });
  timers.at(-1).fn(); // no frames: idle drop
  assert.deepEqual(live.at(-1), { session: 2, active: false });

  const delivered = [];
  const throwing = createWatcherTalkSource({
    assembler: fakeAssembler(),
    deliver: (p) => delivered.push(p),
    live: () => {
      throw new Error("window gone");
    },
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  throwing.start({ session: 3 });
  for (let seq = 0; seq < 4; seq++) throwing.audio({ session: 3, seq, frame: Buffer.from([1]) });
  throwing.end({ session: 3, frames: 4 });
  assert.equal(delivered.length, 1);
});
