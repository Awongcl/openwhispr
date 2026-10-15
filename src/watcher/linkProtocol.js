// Watcher fork (spec O12, O14): the Watcher GATT link protocol v1, pure helpers.
// Contract: firmware/docs/link-protocol.md in the watcher-ai repo.

const EVT = Object.freeze({
  TALK_START: 0x01,
  TALK_END: 0x02,
  TALK_CANCEL: 0x03,
  REWRITE: 0x04,
  REVERT: 0x05,
  DISCARD: 0x06,
  SEND: 0x07,
  BATTERY: 0x10,
});

const EVT_NAMES = Object.freeze({
  [EVT.TALK_START]: "talk_start",
  [EVT.TALK_END]: "talk_end",
  [EVT.TALK_CANCEL]: "talk_cancel",
  [EVT.REWRITE]: "rewrite",
  [EVT.REVERT]: "revert",
  [EVT.DISCARD]: "discard",
  [EVT.SEND]: "send",
  [EVT.BATTERY]: "battery",
});

const MSG = Object.freeze({ TIME: 0x01, STATE: 0x02, METERS: 0x03, CONFIG: 0x04 });

// Insertion state pushed to the Watcher (drives the wheel's "after paste" row).
const STATE = Object.freeze({ IDLE: 0, RAW: 1, REWRITTEN: 2, BUSY: 3, ERROR: 4 });

const BATTERY_FLAGS = Object.freeze({ CHARGING: 1, LOW: 2, CRITICAL: 4, DOCKED: 8 });

function battery(percent, flags) {
  return {
    percent: percent === 0xff ? null : percent,
    charging: !!(flags & BATTERY_FLAGS.CHARGING),
    low: !!(flags & BATTERY_FLAGS.LOW),
    critical: !!(flags & BATTERY_FLAGS.CRITICAL),
    docked: !!(flags & BATTERY_FLAGS.DOCKED),
  };
}

// Event notification: [seq u8][evt u8][payload]. Returns null if malformed.
function parseEvent(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 2) return null;
  const seq = b[0];
  const code = b[1];
  const p = b.subarray(2);
  const name = EVT_NAMES[code] || `0x${code.toString(16).padStart(2, "0")}`;
  const event = { seq, code, name };
  switch (code) {
    case EVT.TALK_START:
      if (p.length < 2) return null;
      return { ...event, session: p[0], latched: !!p[1] };
    case EVT.TALK_END:
      if (p.length < 3) return null;
      return { ...event, session: p[0], frames: p.readUInt16LE(1) };
    case EVT.TALK_CANCEL:
      if (p.length < 1) return null;
      return { ...event, session: p[0] };
    case EVT.BATTERY:
      if (p.length < 2) return null;
      return { ...event, battery: battery(p[0], p[1]) };
    default:
      return event;
  }
}

// Audio notification: [session u8][seq u16 LE][opus frame] (W12; decoded by O13).
function parseAudio(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 3) return null;
  return { session: b[0], seq: b.readUInt16LE(1), frame: b.subarray(3) };
}

// Info characteristic: [proto u8][battery % u8][battery flags u8][fw version ASCII].
function parseInfo(bytes) {
  const b = Buffer.from(bytes || []);
  if (b.length < 3) return null;
  return { proto: b[0], battery: battery(b[1], b[2]), firmware: b.subarray(3).toString("ascii") };
}

// [msg][unix s u32 LE][UTC offset min i16 LE] (O12). `date` is local wall clock.
function encodeTime(date = new Date()) {
  const b = Buffer.alloc(7);
  b[0] = MSG.TIME;
  b.writeUInt32LE(Math.floor(date.getTime() / 1000) >>> 0, 1);
  b.writeInt16LE(-date.getTimezoneOffset(), 5);
  return b;
}

function encodeState(state) {
  return Buffer.from([MSG.STATE, state & 0xff]);
}

// True when `seq` does not follow `last` (u8 wrap); a gap means a lost notification.
function isSeqGap(last, seq) {
  return last != null && seq !== ((last + 1) & 0xff);
}

// One stdout line of resources/watcher-ble.exe -> message object (null = ignore).
function parseHelperLine(line) {
  const text = String(line).trim();
  if (!text) return null;
  const space = text.indexOf(" ");
  const kind = space < 0 ? text : text.slice(0, space);
  const rest = space < 0 ? "" : text.slice(space + 1);
  const [address, a, b] = rest.split(" ");
  switch (kind) {
    case "READY":
      return { type: "ready" };
    case "PAIRED":
      return { type: "paired", address, name: rest.slice(address.length + 1) };
    case "UNPAIRED":
      return { type: "unpaired", address };
    case "CONN":
      return {
        type: "connected",
        address,
        mtu: Number(a) || null,
        info: b && b !== "-" ? parseInfo(Buffer.from(b, "hex")) : null,
      };
    case "DISC":
      return { type: "disconnected", address };
    case "EVT":
      return { type: "event", address, data: Buffer.from(a || "", "hex") };
    case "AUDIO":
      return { type: "audio", address, data: Buffer.from(a || "", "hex") };
    case "WERR":
      return { type: "write_error", address, reason: a || "unknown" };
    case "LOG":
      return { type: "log", message: rest };
    default:
      return { type: "log", message: text };
  }
}

module.exports = {
  EVT,
  EVT_NAMES,
  MSG,
  STATE,
  parseEvent,
  parseAudio,
  parseInfo,
  encodeTime,
  encodeState,
  isSeqGap,
  parseHelperLine,
};
