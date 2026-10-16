const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/watcher/externalTalk.js");

function fakeAudioManager({ isRecording = false, isProcessing = false } = {}) {
  const calls = [];
  const am = {
    isRecording,
    isProcessing,
    voiceAgentRequested: true,
    translationRequested: true,
    _localSpeechGateState: { windowCount: 3 },
    setVoiceAgentRequested(v) {
      this.voiceAgentRequested = v;
    },
    setTranslationRequested(v) {
      this.translationRequested = v;
    },
    _startProcessingPipeline() {
      return { id: "p1" };
    },
    onStateChange: (s) => calls.push(["state", s]),
    async processAudio(blob, metadata, pipeline) {
      calls.push(["process", blob, metadata, pipeline]);
    },
  };
  return { am, calls };
}

const payload = () => ({ session: 3, wav: new Uint8Array(1044), durationSeconds: 1.5 });

test("feeds the Watcher WAV into processAudio as plain dictation", async () => {
  const { transcribeWatcherAudio } = await load();
  const { am, calls } = fakeAudioManager();
  assert.equal(await transcribeWatcherAudio(am, payload()), "ok");
  assert.equal(am.isProcessing, true);
  assert.equal(am.voiceAgentRequested, false);
  assert.equal(am.translationRequested, false);
  assert.equal(am._localSpeechGateState, null);
  assert.deepEqual(calls[0], [
    "state",
    { isRecording: false, isProcessing: true, micCaptureStatus: "inactive" },
  ]);
  const [, blob, metadata, pipeline] = calls[1];
  assert.equal(blob.type, "audio/wav");
  assert.equal(blob.size, 1044);
  assert.equal(metadata.rawWav, blob);
  assert.equal(metadata.durationSeconds, 1.5);
  assert.deepEqual(pipeline, { id: "p1" });
  assert.equal(am.lastAudioBlob, blob);
});

test("drops Watcher audio while a dictation is recording or processing", async () => {
  const { transcribeWatcherAudio } = await load();
  for (const state of [{ isRecording: true }, { isProcessing: true }]) {
    const { am, calls } = fakeAudioManager(state);
    assert.equal(await transcribeWatcherAudio(am, payload()), "busy");
    assert.equal(calls.length, 0);
  }
  assert.equal(
    await transcribeWatcherAudio(fakeAudioManager().am, { wav: new Uint8Array(0) }),
    "empty"
  );
  assert.equal(await transcribeWatcherAudio(null, payload()), "empty");
});

test("live talk: start, levels, stop drive the pill state", async () => {
  const { applyWatcherTalkLive, watcherTalkLevel } = await load();
  const state = { session: null, level: null, timer: null };
  const talking = [];
  const timers = [];
  const opts = {
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      if (t) t.cleared = true;
    },
  };
  assert.equal(watcherTalkLevel(state), null);
  applyWatcherTalkLive(state, { session: 5, active: true }, (v) => talking.push(v), opts);
  assert.deepEqual(talking, [true]);
  assert.equal(watcherTalkLevel(state), 0);
  applyWatcherTalkLive(
    state,
    { session: 5, active: true, level: 0.04 },
    (v) => talking.push(v),
    opts
  );
  assert.equal(watcherTalkLevel(state), 0.04);
  assert.deepEqual(talking, [true]); // levels do not re-trigger the state
  applyWatcherTalkLive(state, { session: 4, active: false }, (v) => talking.push(v), opts);
  assert.deepEqual(talking, [true]); // stop of another session ignored
  applyWatcherTalkLive(state, { session: 5, active: false }, (v) => talking.push(v), opts);
  assert.deepEqual(talking, [true, false]);
  assert.equal(watcherTalkLevel(state), null);
});

test("live talk: a talk with no updates goes stale instead of sticking", async () => {
  const { applyWatcherTalkLive, watcherTalkLevel, WATCHER_LIVE_STALE_MS } = await load();
  const state = { session: null, level: null, timer: null };
  const talking = [];
  let pending = null;
  applyWatcherTalkLive(state, { session: 9, active: true }, (v) => talking.push(v), {
    setTimer: (fn, ms) => {
      pending = { fn, ms };
      return pending;
    },
    clearTimer: () => {},
  });
  assert.equal(pending.ms, WATCHER_LIVE_STALE_MS);
  pending.fn();
  assert.deepEqual(talking, [true, false]);
  assert.equal(watcherTalkLevel(state), null);
});
