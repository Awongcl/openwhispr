const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createInsertionTracker,
  deleteCount,
  withAffixes,
} = require("../../src/watcher/insertionTracker");

test("deleteCount counts code points and collapses CRLF", () => {
  assert.equal(deleteCount("hello "), 6);
  assert.equal(deleteCount("帮我检查"), 4);
  assert.equal(deleteCount("a\r\nb"), 3);
  assert.equal(deleteCount("a\nb"), 3);
  assert.equal(deleteCount("ok 👍"), 4);
});

test("withAffixes keeps RAW's surrounding whitespace", () => {
  assert.equal(withAffixes(" raw text ", "\nGoal: x\n"), " Goal: x ");
  assert.equal(withAffixes("raw", "  new  "), "new");
  assert.equal(withAffixes("   ", "x"), "   x");
});

test("record / rewrite / revert cycle tracks current text and N", () => {
  let t = 1000;
  const tracker = createInsertionTracker({ now: () => t });
  assert.equal(tracker.get(), null);

  tracker.record({ pasted: "hi there ", target: { id: "0x1", exeName: "code.exe" } });
  let s = tracker.get();
  assert.equal(s.current, "raw");
  assert.equal(s.n, 9);
  assert.equal(s.insertedAt, 1000);
  assert.equal(s.target.id, "0x1");

  assert.throws(() => tracker.switchTo("rewrite"), /no rewrite/);
  tracker.setRewrite("Goal: greet");
  t = 2000;
  s = tracker.switchTo("rewrite");
  assert.equal(s.text, "Goal: greet ");
  assert.equal(s.n, 12);
  assert.equal(s.swappedAt, 2000);

  s = tracker.switchTo("raw");
  assert.equal(s.text, "hi there ");
  assert.equal(s.rewrite, "Goal: greet ");

  tracker.clear();
  assert.equal(tracker.get(), null);
});

test("new record drops the previous rewrite cache", () => {
  const tracker = createInsertionTracker();
  tracker.record({ pasted: "one" });
  tracker.setRewrite("ONE");
  tracker.record({ pasted: "two" });
  assert.equal(tracker.get().rewrite, null);
});
