const test = require("node:test");
const assert = require("node:assert/strict");

const {
  EVT,
  STATE,
  parseEvent,
  parseAudio,
  parseInfo,
  encodeTime,
  encodeState,
  isSeqGap,
  parseHelperLine,
} = require("../../src/watcher/linkProtocol");

test("parses every event code with its payload", () => {
  assert.deepEqual(parseEvent([5, 0x01, 7, 1]), {
    seq: 5,
    code: EVT.TALK_START,
    name: "talk_start",
    session: 7,
    latched: true,
  });
  assert.deepEqual(parseEvent([6, 0x02, 7, 0x2c, 0x01]), {
    seq: 6,
    code: EVT.TALK_END,
    name: "talk_end",
    session: 7,
    frames: 300,
  });
  assert.equal(parseEvent([7, 0x03, 7]).session, 7);
  for (const [code, name] of [
    [0x04, "rewrite"],
    [0x05, "revert"],
    [0x06, "discard"],
    [0x07, "send"],
  ]) {
    assert.deepEqual(parseEvent([1, code]), { seq: 1, code, name });
  }
  assert.deepEqual(parseEvent([9, 0x10, 12, 0b0011]).battery, {
    percent: 12,
    charging: true,
    low: true,
    critical: false,
    docked: false,
  });
});

test("rejects short events and names unknown codes", () => {
  assert.equal(parseEvent([1]), null);
  assert.equal(parseEvent([1, 0x01, 7]), null);
  assert.equal(parseEvent([1, 0x02, 7, 1]), null);
  assert.equal(parseEvent([1, 0x10, 50]), null);
  assert.equal(parseEvent([1, 0x42]).name, "0x42");
});

test("parses audio and info", () => {
  const a = parseAudio([3, 0x01, 0x02, 0xaa, 0xbb]);
  assert.equal(a.session, 3);
  assert.equal(a.seq, 0x0201);
  assert.deepEqual([...a.frame], [0xaa, 0xbb]);
  const info = parseInfo(Buffer.from("016408656330386632312d6469727479", "hex"));
  assert.equal(info.proto, 1);
  assert.equal(info.battery.percent, 100);
  assert.equal(info.battery.docked, true);
  assert.equal(info.firmware, "ec08f21-dirty");
  assert.equal(parseInfo([1, 0xff, 0]).battery.percent, null);
});

test("encodes time with the local UTC offset (O12)", () => {
  const date = new Date(1760500000 * 1000);
  const b = encodeTime(date);
  assert.equal(b[0], 0x01);
  assert.equal(b.readUInt32LE(1), 1760500000);
  assert.equal(b.readInt16LE(5), -date.getTimezoneOffset());
  assert.deepEqual([...encodeState(STATE.REWRITTEN)], [0x02, 2]);
});

test("detects sequence gaps with u8 wrap", () => {
  assert.equal(isSeqGap(null, 0), false);
  assert.equal(isSeqGap(4, 5), false);
  assert.equal(isSeqGap(255, 0), false);
  assert.equal(isSeqGap(4, 6), true);
});

test("parses helper lines", () => {
  assert.deepEqual(parseHelperLine("READY"), { type: "ready" });
  assert.deepEqual(parseHelperLine("PAIRED E0:72:A1:FA:40:9A Watcher AI 409A"), {
    type: "paired",
    address: "E0:72:A1:FA:40:9A",
    name: "Watcher AI 409A",
  });
  const conn = parseHelperLine("CONN E0:72:A1:FA:40:9A 247 0164086162");
  assert.equal(conn.type, "connected");
  assert.equal(conn.mtu, 247);
  assert.equal(conn.info.firmware, "ab");
  assert.equal(parseHelperLine("CONN AA 23 -").info, null);
  assert.deepEqual([...parseHelperLine("EVT AA 0104").data], [1, 4]);
  assert.equal(parseHelperLine("DISC AA").type, "disconnected");
  assert.equal(parseHelperLine("WERR AA offline").reason, "offline");
  assert.equal(parseHelperLine("LOG hello world").message, "hello world");
  assert.equal(parseHelperLine("  "), null);
});
