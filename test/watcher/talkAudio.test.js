const test = require("node:test");
const assert = require("node:assert/strict");
const OpusScript = require("opusscript");

const {
  createTalkAssembler,
  encodeWav,
  FRAME_SAMPLES,
  MAX_GAP_FRAMES,
  SAMPLE_RATE,
} = require("../../src/watcher/talkAudio");
const { parseAudio } = require("../../src/watcher/linkProtocol");

const FRAME_BYTES = FRAME_SAMPLES * 2;

// 440 Hz tone as `count` Opus frames, like the Watcher's encoder (16 kHz mono, 20 ms).
function opusFrames(count, amplitude = 8000) {
  const encoder = new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  const frames = [];
  for (let f = 0; f < count; f++) {
    const pcm = Buffer.alloc(FRAME_BYTES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const n = f * FRAME_SAMPLES + i;
      pcm.writeInt16LE(
        Math.round(amplitude * Math.sin((2 * Math.PI * 440 * n) / SAMPLE_RATE)),
        i * 2
      );
    }
    frames.push(encoder.encode(pcm, FRAME_SAMPLES));
  }
  encoder.delete();
  return frames;
}

// Audio notification bytes: [session u8][seq u16 LE][opus frame].
function packet(session, seq, frame) {
  const head = Buffer.alloc(3);
  head[0] = session;
  head.writeUInt16LE(seq, 1);
  return parseAudio(Buffer.concat([head, frame]));
}

function rms(pcm, fromFrame, toFrame) {
  let sum = 0;
  let n = 0;
  for (let i = fromFrame * FRAME_SAMPLES; i < toFrame * FRAME_SAMPLES; i++) {
    const v = pcm.readInt16LE(i * 2);
    sum += v * v;
    n++;
  }
  return Math.sqrt(sum / n);
}

test("decodes a whole talk to 16 kHz PCM", () => {
  const frames = opusFrames(50);
  const a = createTalkAssembler();
  a.start(7);
  frames.forEach((f, seq) => assert.equal(a.push(packet(7, seq, f)), true));
  const { pcm, stats } = a.finish(7, 50);
  assert.equal(pcm.length, 50 * FRAME_BYTES);
  assert.deepEqual(
    { received: stats.received, lost: stats.lost, late: stats.late, durationMs: stats.durationMs },
    { received: 50, lost: 0, late: 0, durationMs: 1000 }
  );
  // The tone survives the codec (past the decoder's start-up).
  assert.ok(rms(pcm, 10, 50) > 3000, `rms ${rms(pcm, 10, 50)}`);
  assert.equal(a.session, null);
});

test("fills lost frames with silence, keeping timing", () => {
  const frames = opusFrames(30);
  const a = createTalkAssembler();
  a.start(1);
  frames.forEach((f, seq) => {
    if (seq >= 10 && seq < 15) return; // 5 lost notifications
    a.push(packet(1, seq, f));
  });
  const { pcm, stats } = a.finish(1, 30);
  assert.equal(pcm.length, 30 * FRAME_BYTES);
  assert.equal(stats.received, 25);
  assert.equal(stats.lost, 5);
  assert.equal(rms(pcm, 10, 15), 0);
  assert.ok(rms(pcm, 20, 30) > 3000);
});

test("counts a missing tail from talk_end.frames without padding it", () => {
  const frames = opusFrames(10);
  const a = createTalkAssembler();
  a.start(2);
  frames.slice(0, 8).forEach((f, seq) => a.push(packet(2, seq, f)));
  const { pcm, stats } = a.finish(2, 10);
  assert.equal(pcm.length, 8 * FRAME_BYTES);
  assert.equal(stats.lost, 2);
});

test("drops late and repeated frames", () => {
  const frames = opusFrames(5);
  const a = createTalkAssembler();
  a.start(3);
  a.push(packet(3, 0, frames[0]));
  a.push(packet(3, 1, frames[1]));
  assert.equal(a.push(packet(3, 1, frames[1])), false);
  assert.equal(a.push(packet(3, 0, frames[0])), false);
  a.push(packet(3, 2, frames[2]));
  const { pcm, stats } = a.finish(3, 3);
  assert.equal(pcm.length, 3 * FRAME_BYTES);
  assert.equal(stats.late, 2);
  assert.equal(stats.lost, 0);
});

test("caps the fill for an implausible seq jump", () => {
  const frames = opusFrames(2);
  const a = createTalkAssembler();
  a.start(4);
  a.push(packet(4, 0, frames[0]));
  a.push(packet(4, 5000, frames[1]));
  const { pcm, stats } = a.finish(4, 5001);
  assert.equal(pcm.length, (2 + MAX_GAP_FRAMES) * FRAME_BYTES);
  assert.equal(stats.lost, 4999);
});

test("ignores frames for another session and before start", () => {
  const [f] = opusFrames(1);
  const a = createTalkAssembler();
  assert.equal(a.push(packet(9, 0, f)), false);
  a.start(9);
  assert.equal(a.push(packet(8, 0, f)), false);
  assert.equal(a.finish(8, 1), null);
  assert.equal(a.finish(9, 0).stats.received, 0);
});

test("a corrupt frame becomes one frame of silence", () => {
  const a = createTalkAssembler({
    createDecoder: () => ({
      decode: (p) => {
        if (p[0] === 0xee) throw new Error("Decode error");
        return Buffer.alloc(FRAME_BYTES, 1);
      },
      destroy() {},
    }),
  });
  a.start(1);
  a.push(packet(1, 0, Buffer.from([1])));
  a.push(packet(1, 1, Buffer.from([0xee])));
  a.push(packet(1, 2, Buffer.from([1])));
  const { pcm, stats } = a.finish(1, 3);
  assert.equal(pcm.length, 3 * FRAME_BYTES);
  assert.equal(stats.badFrames, 1);
  assert.equal(pcm.readInt16LE(FRAME_BYTES + 10), 0);
});

test("cancel and a new start drop the talk and free the decoder", () => {
  let destroyed = 0;
  const a = createTalkAssembler({
    createDecoder: () => ({ decode: () => Buffer.alloc(FRAME_BYTES), destroy: () => destroyed++ }),
  });
  a.start(1);
  a.push(packet(1, 0, Buffer.from([1])));
  a.cancel(2); // other session: no-op
  assert.equal(a.session, 1);
  a.cancel(1);
  assert.equal(a.session, null);
  assert.equal(a.finish(1, 1), null);
  a.start(2);
  a.push(packet(2, 0, Buffer.from([1])));
  a.start(3);
  assert.equal(destroyed, 2);
});

test("encodeWav writes a 16 kHz mono 16-bit RIFF header", () => {
  const pcm = Buffer.alloc(640, 0x11);
  const wav = encodeWav(pcm);
  assert.equal(wav.length, 44 + 640);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(4), 36 + 640);
  assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
  assert.equal(wav.readUInt16LE(20), 1);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(28), 32000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.toString("ascii", 36, 40), "data");
  assert.equal(wav.readUInt32LE(40), 640);
  assert.equal(wav[44], 0x11);
});
