const test = require("node:test");
const assert = require("node:assert/strict");

const { checkSwap, sameHwnd } = require("../../src/watcher/swapGuard");

const entry = { target: { id: "0x00A1" }, insertedAt: 1000, swappedAt: null };
const base = { entry, foregroundId: "0x00a1", lastUserInputAt: 500, now: 2000, maxAgeMs: 60000 };

test("allows swap when window same, no input, fresh", () => {
  assert.deepEqual(checkSwap(base), { ok: true });
  assert.deepEqual(checkSwap({ ...base, lastUserInputAt: null }), { ok: true });
});

test("refuses with no insertion or unknown target", () => {
  assert.equal(checkSwap({ ...base, entry: null }).reason, "nothing");
  assert.equal(checkSwap({ ...base, foregroundId: null }).reason, "unknown_target");
  assert.equal(checkSwap({ ...base, entry: { ...entry, target: null } }).reason, "unknown_target");
});

test("refuses when focus moved", () => {
  assert.equal(checkSwap({ ...base, foregroundId: "0x00B2" }).reason, "focus_changed");
  assert.equal(checkSwap({ ...base, foregroundId: "zz" }).reason, "focus_changed");
});

test("matches hwnds across %p formats", () => {
  assert.ok(sameHwnd("00000000000000A1", "0xa1"));
  assert.ok(!sameHwnd("A1", "A2"));
});

test("refuses on user input after insertion, measured from last swap", () => {
  assert.equal(checkSwap({ ...base, lastUserInputAt: 1500 }).reason, "user_input");
  const swapped = { ...entry, swappedAt: 1800 };
  assert.deepEqual(checkSwap({ ...base, entry: swapped, lastUserInputAt: 1500 }), { ok: true });
  assert.equal(
    checkSwap({ ...base, entry: swapped, lastUserInputAt: 1900 }).reason,
    "user_input"
  );
});

test("refuses when older than max age", () => {
  assert.equal(checkSwap({ ...base, now: 1000 + 60001 }).reason, "expired");
});
