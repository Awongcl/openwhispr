// Watcher fork: where a Watcher talk (hold wheel) gets its audio.
//
// Interface (one talk at a time, keyed by the Watcher's session id):
//   start({ session, latched })   talk_start
//   audio({ session, seq, frame }) one Opus frame (16 kHz mono, 20 ms) from the Audio characteristic
//   end({ session, frames })      talk_end: finalise, transcribe, paste RAW (O1)
//   cancel({ session })           talk_cancel: drop, paste nothing
//
// Today: PC microphone through OpenWhispr's own dictation (start/stop like the
// push-to-talk hotkey); Watcher audio frames are ignored. O13 adds a source that
// decodes the frames and feeds the transcription path instead (Settings: audio
// source = Watcher / PC mic) behind this same interface.

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

module.exports = { createPcMicTalkSource };
