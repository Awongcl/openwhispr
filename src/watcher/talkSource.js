// Watcher fork: where a Watcher talk (hold wheel) gets its audio.
//
// Interface (one talk at a time, keyed by the Watcher's session id):
//   start({ session, latched })   talk_start
//   audio({ session, seq, frame }) one Opus frame (16 kHz mono, 20 ms) from the Audio characteristic
//   end({ session, frames })      talk_end: finalise, transcribe, paste RAW (O1)
//   cancel({ session })           talk_cancel: drop, paste nothing
//
// Sources (Settings: audio source, default Watcher):
//   watcher  decodes the Watcher's Opus frames (O13) and hands the WAV to
//            OpenWhispr's transcription + paste path (renderer: externalTalk.js)
//   pc-mic   PC microphone through OpenWhispr's own dictation (start/stop like
//            the push-to-talk hotkey); Watcher frames are ignored

const { createTalkAssembler, encodeWav } = require("./talkAudio");

const TALK_AUDIO_CHANNEL = "watcher-talk-audio";
// Frames are continuous while talking (VBR, no DTX), so a silent link is a dead talk.
const TALK_IDLE_MS = 2000;

function createPcMicTalkSource({ windowManager, logger = null }) {
  let active = null;
  return {
    kind: "pc-mic",
    start({ session }) {
      active = session;
      logger?.info?.("Watcher talk start (PC mic)", { session }, "watcher");
      windowManager?.sendStartDictation?.();
    },
    audio() {},
    end({ session, frames }) {
      if (active !== session) return;
      active = null;
      logger?.info?.("Watcher talk end", { session, frames }, "watcher");
      windowManager?.sendStopDictation?.();
    },
    cancel({ session }) {
      if (active !== session) return;
      active = null;
      logger?.info?.("Watcher talk cancel", { session }, "watcher");
      windowManager?.sendCancelActiveDictation?.();
    },
  };
}

// Default delivery: the dictation window's renderer, which owns transcription
// and paste. Returns false when there is no window to take it.
function sendToDictationWindow(windowManager, payload) {
  const win = windowManager?.mainWindow;
  if (!win || win.isDestroyed?.()) return false;
  windowManager.showDictationPanel?.({ reposition: true });
  win.webContents.send(TALK_AUDIO_CHANNEL, payload);
  return true;
}

function createWatcherTalkSource({
  windowManager,
  logger = null,
  assembler = createTalkAssembler({ logger }),
  deliver = (payload) => sendToDictationWindow(windowManager, payload),
  // The window the user talks into, probed like a dictation start does: the
  // paste restores it and the insertion records it (swapGuard needs its id).
  captureTarget = () => windowManager?.selectionManager?.captureTarget?.({ force: true }),
  idleMs = TALK_IDLE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let idleTimer = null;

  function stopIdle() {
    clearTimer(idleTimer);
    idleTimer = null;
  }

  // Spec O13: drop the session when no frame arrives for `idleMs`.
  function armIdle(session) {
    stopIdle();
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (assembler.session !== session) return;
      assembler.cancel(session);
      logger?.warn?.("Watcher talk dropped: no audio", { session, idleMs }, "watcher");
    }, idleMs);
  }

  return {
    kind: "watcher",
    start({ session, latched }) {
      assembler.start(session);
      armIdle(session);
      Promise.resolve()
        .then(captureTarget)
        .catch((error) =>
          logger?.warn?.("Watcher target capture failed", { error: error?.message }, "watcher")
        );
      logger?.info?.("Watcher talk start (Watcher mic)", { session, latched }, "watcher");
    },
    audio(packet) {
      if (assembler.push(packet)) armIdle(packet.session);
    },
    end({ session, frames }) {
      const result = assembler.finish(session, frames);
      if (!result) return;
      stopIdle();
      const { pcm, stats } = result;
      logger?.info?.("Watcher talk end", stats, "watcher");
      // Nothing heard: no transcription starts, so the bridge's talk-end
      // timeout reports the error on the Watcher.
      if (stats.received === 0) return;
      const delivered = deliver({
        session,
        wav: encodeWav(pcm),
        durationSeconds: stats.durationMs / 1000,
      });
      if (!delivered) logger?.warn?.("Watcher audio not delivered", { session }, "watcher");
    },
    cancel({ session }) {
      if (assembler.session !== session) return;
      stopIdle();
      assembler.cancel(session);
      logger?.info?.("Watcher talk cancel", { session }, "watcher");
    },
  };
}

// Picks the source at talk_start and keeps it for that talk, so changing the
// setting mid-talk cannot split one talk across two sources.
function createSelectableTalkSource({ sources, getAudioSource }) {
  let current = null;
  const pick = () => sources[getAudioSource()] || sources.watcher;
  return {
    get kind() {
      return (current || pick()).kind;
    },
    start(event) {
      // A new talk_start replaces an unfinished one (talk_end lost on a drop).
      if (current) current.source.cancel({ session: current.session });
      const source = pick();
      current = { source, session: event.session };
      source.start(event);
    },
    audio(packet) {
      current?.source.audio(packet);
    },
    end(event) {
      const source = current?.source;
      if (current?.session === event.session) current = null;
      source?.end(event);
    },
    cancel(event) {
      const source = current?.source;
      if (current?.session === event.session) current = null;
      source?.cancel(event);
    },
  };
}

module.exports = {
  TALK_AUDIO_CHANNEL,
  TALK_IDLE_MS,
  createPcMicTalkSource,
  createWatcherTalkSource,
  createSelectableTalkSource,
  sendToDictationWindow,
};
