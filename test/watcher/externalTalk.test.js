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
