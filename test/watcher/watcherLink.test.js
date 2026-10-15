const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const { WatcherLink } = require("../../src/watcher/watcherLink");

function fakeProc() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stdout.setEncoding = () => {};
  proc.written = [];
  proc.stdin = {
    write: (s) => proc.written.push(s),
    end: (s) => {
      proc.written.push(s);
      proc.emit("exit", 0);
    },
  };
  proc.kill = () => {};
  proc.say = (line) => proc.stdout.emit("data", `${line}\n`);
  return proc;
}

function setup() {
  const procs = [];
  const timers = [];
  const link = new WatcherLink({
    binary: "watcher-ble.exe",
    spawnImpl: () => {
      const p = fakeProc();
      procs.push(p);
      return p;
    },
    now: () => new Date(1760500000 * 1000),
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  link.isAvailable = () => true;
  return { link, procs, timers };
}

test("connect syncs time and reports device info", () => {
  const { link, procs } = setup();
  const connected = [];
  link.on("connected", (d) => connected.push(d));
  link.start();
  const p = procs[0];
  p.say("READY");
  p.say("PAIRED E0:72:A1:FA:40:9A Watcher AI 409A");
  assert.equal(link.status().devices[0].connected, false);
  p.say("CONN E0:72:A1:FA:40:9A 247 0150006162");
  const time = p.written[0].trim().split(" ");
  assert.equal(time[0], "W");
  assert.equal(time[1], "E0:72:A1:FA:40:9A");
  assert.equal(time[2].slice(0, 2), "01");
  assert.equal(Buffer.from(time[2], "hex").readUInt32LE(1), 1760500000);
  assert.equal(connected.length, 1);
  assert.deepEqual(link.status().devices[0], {
    address: "E0:72:A1:FA:40:9A",
    name: "Watcher AI 409A",
    connected: true,
    mtu: 247,
    firmware: "ab",
    battery: { percent: 80, charging: false, low: false, critical: false, docked: false },
  });
});

test("events are parsed; battery updates status", () => {
  const { link, procs } = setup();
  const events = [];
  link.on("event", (e, d) => events.push([e.name, d.address]));
  link.start();
  procs[0].say("CONN AA 247 -");
  procs[0].say("EVT AA 0004");
  procs[0].say("EVT AA 01100a00");
  procs[0].say("EVT AA ff"); // malformed: ignored
  assert.deepEqual(events, [
    ["rewrite", "AA"],
    ["battery", "AA"],
  ]);
  assert.equal(link.status().devices[0].battery.percent, 10);
});

test("disconnect, helper crash with backoff respawn, restart", () => {
  const { link, procs, timers } = setup();
  const disc = [];
  link.on("disconnected", (d) => disc.push(d.address));
  link.start();
  procs[0].say("CONN AA 247 -");
  procs[0].say("DISC AA");
  assert.deepEqual(disc, ["AA"]);
  assert.equal(link.connectedCount(), 0);

  procs[0].say("CONN AA 247 -");
  procs[0].emit("exit", 1); // crash
  assert.deepEqual(disc, ["AA", "AA"]);
  assert.equal(link.status().devices.length, 0);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 1000);
  timers.shift().fn();
  assert.equal(procs.length, 2);

  link.restart(); // e.g. after resume
  assert.equal(procs.length, 3);
  assert.ok(procs[1].written.includes("QUIT\n"));

  link.stop();
  assert.equal(link.write("*", [1]), false);
});
