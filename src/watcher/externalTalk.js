// Watcher fork (spec O13, renderer): a Watcher talk's decoded audio (16 kHz mono
// WAV from main, talkAudio.js) goes through the same transcription and paste as
// a finished PC-mic dictation: processAudio -> onTranscriptionComplete -> paste.
// The WAV doubles as rawWav, so local engines skip the FFmpeg decode.

import logger from "../utils/logger";

// A live talk with no update for this long is over (main lost the stop, e.g. a crash),
// so the pill never stays stuck in listening.
export const WATCHER_LIVE_STALE_MS = 3000;

// Live talk state from main (talkSource.js): `state` is { session, level, timer },
// owned by the caller; setTalking(bool) drives the pill's listening state.
export function applyWatcherTalkLive(
  state,
  payload,
  setTalking,
  { setTimer = setTimeout, clearTimer = clearTimeout, staleMs = WATCHER_LIVE_STALE_MS } = {}
) {
  if (!state || !payload) return;
  const stop = () => {
    clearTimer(state.timer);
    state.timer = null;
    state.session = null;
    state.level = null;
    setTalking(false);
  };
  if (!payload.active) {
    if (state.session === payload.session) stop();
    return;
  }
  if (state.session !== payload.session) {
    state.session = payload.session;
    state.level = 0;
    setTalking(true);
  }
  if (typeof payload.level === "number") state.level = payload.level;
  clearTimer(state.timer);
  state.timer = setTimer(stop, staleMs);
}

// Waveform level while a Watcher talk is live, else null (waveform rests).
export function watcherTalkLevel(state) {
  return state?.session != null ? (state.level ?? 0) : null;
}

// Returns "ok" | "busy" | "empty". Never throws: processAudio reports its own
// failures through onError, and the Watcher's state follows the lifecycle.
export async function transcribeWatcherAudio(audioManager, payload) {
  const bytes = payload?.wav;
  if (!audioManager || !bytes?.byteLength) return "empty";
  if (audioManager.isRecording || audioManager.isProcessing) {
    logger.info("Watcher audio dropped: dictation busy", { session: payload.session }, "watcher");
    return "busy";
  }

  // A Watcher talk is plain dictation: no assistant, translation or selection edit.
  audioManager.setVoiceAgentRequested(false);
  audioManager.setTranslationRequested(false);
  audioManager._localSpeechGateState = null;

  const blob = new Blob([bytes], { type: "audio/wav" });
  const pipeline = audioManager._startProcessingPipeline();
  audioManager.isProcessing = true;
  audioManager.lastAudioBlob = blob;
  audioManager.onStateChange?.({
    isRecording: false,
    isProcessing: true,
    micCaptureStatus: "inactive",
  });

  const durationSeconds = Number(payload.durationSeconds) || null;
  logger.info(
    "Watcher audio received",
    { session: payload.session, bytes: blob.size, durationSeconds },
    "watcher"
  );
  const startedAt = Date.now() - (durationSeconds || 0) * 1000;
  await audioManager.processAudio(
    blob,
    {
      durationSeconds,
      analyticsOccurredAt: new Date(startedAt).toISOString(),
      rawWav: blob,
    },
    pipeline
  );
  return "ok";
}
