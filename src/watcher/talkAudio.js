// Watcher fork (spec O13): turns one talk's Opus frames from the Audio
// characteristic into 16 kHz mono PCM, then a WAV for OpenWhispr's transcription.
// Contract: firmware/docs/link-protocol.md (W12) in the watcher-ai repo.

const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms
const FRAME_BYTES = FRAME_SAMPLES * 2;
// A lost run longer than this is not a few dropped notifications but a bad
// seq; filling it would add seconds of silence to the transcript.
const MAX_GAP_FRAMES = 50;
// The Watcher queues ~32 s; anything past this is a runaway session.
const MAX_FRAMES = 60 * 50;

// libopus (WASM, no native build). Decoder state is per talk.
function createOpusDecoder() {
  const OpusScript = require("opusscript");
  const decoder = new OpusScript(SAMPLE_RATE, 1);
  return {
    decode: (packet) => decoder.decode(packet),
    destroy: () => decoder.delete(),
  };
}

// RMS of 16-bit PCM, 0..1 (same scale as the renderer's mic level for the pill waveform).
function rmsLevel(pcm) {
  const n = Math.floor(pcm.length / 2);
  if (!n) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

// Frames missing from a session are filled with 20 ms of silence each (libopus
// PLC here always conceals 120+ ms, so it would stretch the audio). Late or
// repeated frames are dropped; seq is u16 and wraps.
function createTalkAssembler({ createDecoder = createOpusDecoder, logger = null } = {}) {
  let talk = null;

  function close() {
    if (!talk) return;
    try {
      talk.decoder?.destroy();
    } catch {}
    talk = null;
  }

  function appendSilence(frames) {
    talk.chunks.push(Buffer.alloc(frames * FRAME_BYTES));
    talk.frames += frames;
  }

  return {
    get session() {
      return talk ? talk.session : null;
    },

    // Level of the last decoded frame (0 for a bad or missing frame), for the live pill waveform.
    get level() {
      return talk ? talk.level : 0;
    },

    start(session) {
      close();
      talk = {
        session,
        decoder: null,
        chunks: [],
        frames: 0, // 20 ms frames in `chunks`, including fill
        nextSeq: 0,
        received: 0,
        lost: 0,
        late: 0,
        badFrames: 0,
        level: 0,
        decoderError: null, // createDecoder threw (first message)
        decodeError: null, // first per-frame decode exception
      };
    },

    push({ session, seq, frame }) {
      if (!talk || session !== talk.session) return false;
      const ahead = (seq - talk.nextSeq) & 0xffff;
      if (ahead >= 0x8000) {
        talk.late++;
        return false;
      }
      if (talk.frames >= MAX_FRAMES) return false;
      if (ahead > 0) {
        const fill = Math.min(ahead, MAX_GAP_FRAMES, MAX_FRAMES - talk.frames);
        if (fill > 0) appendSilence(fill);
        talk.lost += ahead;
        if (talk.frames >= MAX_FRAMES) return false;
      }
      talk.nextSeq = (seq + 1) & 0xffff;
      talk.received++;
      let pcm = null;
      // A decoder that cannot be created (e.g. opusscript missing) fails every
      // frame; say so once per talk instead of silently feeding Whisper silence.
      if (!talk.decoder && !talk.decoderError) {
        try {
          talk.decoder = createDecoder();
        } catch (error) {
          talk.decoderError = error?.message || String(error);
          logger?.error?.(
            "Watcher Opus decoder could not be created",
            { session, error: talk.decoderError },
            "watcher"
          );
        }
      }
      if (talk.decoder) {
        try {
          pcm = talk.decoder.decode(frame);
        } catch (error) {
          pcm = null;
          if (!talk.decodeError) {
            talk.decodeError = error?.message || String(error);
            logger?.warn?.(
              "Watcher Opus frame decode failed",
              { session, seq, error: talk.decodeError },
              "watcher"
            );
          }
        }
      }
      if (!pcm || pcm.length === 0) {
        talk.badFrames++;
        talk.level = 0;
        appendSilence(1);
        return true;
      }
      talk.level = rmsLevel(pcm);
      talk.chunks.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length));
      talk.frames += Math.max(1, Math.round(pcm.length / FRAME_BYTES));
      return true;
    },

    // talk_end: `expected` is the Watcher's frame count. Returns null for a
    // session that is not the active one.
    finish(session, expected) {
      if (!talk || session !== talk.session) return null;
      const missingTail = Math.max(0, (expected ?? 0) - talk.received - talk.lost);
      const pcm = Buffer.concat(talk.chunks);
      const stats = {
        session,
        expected: expected ?? null,
        received: talk.received,
        lost: talk.lost + missingTail,
        late: talk.late,
        badFrames: talk.badFrames,
        durationMs: Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000),
        decoderError: talk.decoderError,
        decodeError: talk.decodeError,
        // Every received frame failed: the PCM is pure fill, not speech.
        undecodable: talk.received > 0 && talk.badFrames === talk.received,
      };
      close();
      if (stats.undecodable) logger?.error?.("Watcher audio undecodable", stats, "watcher");
      else if (stats.lost || stats.badFrames)
        logger?.info?.("Watcher audio gaps", stats, "watcher");
      return { pcm, stats };
    },

    cancel(session) {
      if (talk && (session == null || session === talk.session)) close();
    },
  };
}

// 16-bit PCM mono -> RIFF/WAVE.
function encodeWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

module.exports = {
  rmsLevel,
  createTalkAssembler,
  createOpusDecoder,
  encodeWav,
  SAMPLE_RATE,
  FRAME_SAMPLES,
  MAX_GAP_FRAMES,
  MAX_FRAMES,
};
