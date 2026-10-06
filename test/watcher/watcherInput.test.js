const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { WatcherInput, hotkeyToVks } = require("../../src/watcher/watcherInput");

test("hotkeyToVks maps modifiers and F-keys", () => {
  assert.deepEqual(hotkeyToVks("Control+Alt+F10"), [0x11, 0x12, 0x79]);
  assert.deepEqual(hotkeyToVks("CommandOrControl+Shift+F24"), [0x11, 0x10, 0x87]);
  assert.deepEqual(hotkeyToVks("Alt+K"), [0x12, 0x4b]);
  assert.deepEqual(hotkeyToVks(""), []);
});

function fakeSpawn(respond) {
  const calls = [];
  const spawned = {};
  const spawnImpl = (bin, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stdout.setEncoding = () => {};
    proc.stdin = {
      write: (line) => {
        calls.push(line.trim());
        setImmediate(() => proc.stdout.emit("data", `${respond(line.trim())}\n`));
      },
      end: () => {},
    };
    spawned.args = args;
    setImmediate(() => proc.stdout.emit("data", "READY\n"));
    return proc;
  };
  return { spawnImpl, calls, spawned };
}

function makeInput(respond) {
  const { spawnImpl, calls, spawned } = fakeSpawn(respond);
  const input = new WatcherInput({ binary: "x.exe", spawnImpl });
  input.isAvailable = () => true;
  return { input, calls, spawned };
}

test("protocol: IDLE, FG, BS", async () => {
  const { input, calls } = makeInput((cmd) =>
    cmd === "IDLE" ? "IDLE 250" : cmd === "FG" ? "FG 00000000000A1B2C" : "ERR focus"
  );
  const before = Date.now();
  const last = await input.lastUserInputAt();
  assert.ok(last <= before - 250 + 50 && last >= before - 300);
  assert.equal(await input.foregroundId(), "00000000000A1B2C");
  assert.equal(await input.backspace(5, "0xA1"), "focus");
  assert.deepEqual(calls, ["IDLE", "FG", "BS 5 A1"]);
});

test("IDLE -1 means no input seen; BS 0 sends nothing", async () => {
  const { input, calls } = makeInput(() => "IDLE -1");
  assert.equal(await input.lastUserInputAt(), null);
  assert.equal(await input.backspace(0, "A1"), "OK");
  assert.deepEqual(calls, ["IDLE"]);
});

test("ignore list is passed as hex VKs", async () => {
  const { input, spawned } = makeInput(() => "IDLE -1");
  input.setIgnoredHotkeys(["Control+Alt+F10", "Control+Alt+F11"]);
  await input.lastUserInputAt();
  assert.deepEqual(spawned.args, ["--ignore", "0x11,0x12,0x79,0x7a"]);
});
