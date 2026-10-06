const test = require("node:test");
const assert = require("node:assert/strict");

const { createSwapController } = require("../../src/watcher/swapController");
const { createInsertionTracker } = require("../../src/watcher/insertionTracker");

function setup({ fg = "A1", lastInput = null, rewriteImpl, deleteResult = "OK" } = {}) {
  let t = 1000;
  const now = () => t;
  const tracker = createInsertionTracker({ now });
  const toasts = [];
  const ops = [];
  const state = { fg, lastInput, rewriteCalls: 0 };
  const controller = createSwapController({
    tracker,
    now,
    input: {
      isAvailable: () => true,
      foregroundId: async () => state.fg,
      lastUserInputAt: async () => state.lastInput,
    },
    chain: {
      rewrite: async (text, prompt) => {
        state.rewriteCalls++;
        if (rewriteImpl) return rewriteImpl(text, prompt, state);
        return { text: `Goal: ${text}` };
      },
    },
    deleteAndPaste: async (n, id, text) => {
      ops.push({ n, id, text });
      return deleteResult;
    },
    toast: (kind, detail) => toasts.push(detail?.reason ? `${kind}:${detail.reason}` : kind),
    getSettings: () => ({ systemPrompt: "SYS", maxAgeMs: 60000 }),
  });
  tracker.record({ pasted: "fix the bug ", target: { id: "0xA1" } });
  t = 2000;
  return { controller, tracker, toasts, ops, state, advance: (ms) => (t += ms) };
}

test("rewrite -> revert -> rewrite uses one API call and swaps by N", async () => {
  const { controller, toasts, ops, state } = setup();
  assert.deepEqual(await controller.rewrite(), { ok: true });
  assert.deepEqual(ops[0], { n: 12, id: "0xA1", text: "Goal: fix the bug " });

  assert.deepEqual(await controller.revert(), { ok: true });
  assert.deepEqual(ops[1], { n: 18, id: "0xA1", text: "fix the bug " });

  assert.deepEqual(await controller.rewrite(), { ok: true });
  assert.equal(state.rewriteCalls, 1);
  assert.deepEqual(toasts, ["rewriting", "rewritten", "reverted", "rewritten"]);
});

test("rewrite sends trimmed RAW with the system prompt", async () => {
  let seen;
  const { controller } = setup({
    rewriteImpl: (text, prompt) => {
      seen = { text, prompt };
      return { text: "x" };
    },
  });
  await controller.rewrite();
  assert.deepEqual(seen, { text: "fix the bug", prompt: "SYS" });
});

test("refuses when focus changed; nothing deleted", async () => {
  const { controller, ops, toasts } = setup({ fg: "B2" });
  assert.equal((await controller.rewrite()).reason, "focus_changed");
  assert.equal(ops.length, 0);
  assert.deepEqual(toasts, ["refused:focus_changed"]);
});

test("re-checks guard after the API call", async () => {
  const { controller, ops, toasts } = setup({
    rewriteImpl: (text, prompt, state) => {
      state.lastInput = 2500; // user typed while waiting
      return { text: "x" };
    },
  });
  assert.equal((await controller.rewrite()).reason, "user_input");
  assert.equal(ops.length, 0);
  assert.deepEqual(toasts, ["rewriting", "refused:user_input"]);
});

test("rewrite failure keeps RAW", async () => {
  const { controller, ops, toasts, tracker } = setup({
    rewriteImpl: () => {
      throw Object.assign(new Error("all failed"), { attempts: [] });
    },
  });
  assert.equal((await controller.rewrite()).reason, "rewrite_failed");
  assert.equal(ops.length, 0);
  assert.equal(tracker.get().current, "raw");
  assert.deepEqual(toasts, ["rewriting", "rewrite_failed"]);
});

test("revert with nothing rewritten is a no-op", async () => {
  const { controller, ops } = setup();
  assert.deepEqual(await controller.revert(), { ok: true, reason: "already" });
  assert.equal(ops.length, 0);
});

test("discard deletes and clears", async () => {
  const { controller, ops, tracker, toasts } = setup();
  assert.deepEqual(await controller.discard(), { ok: true });
  assert.deepEqual(ops[0], { n: 12, id: "0xA1", text: null });
  assert.equal(tracker.get(), null);
  assert.equal((await controller.discard()).reason, "nothing");
  assert.deepEqual(toasts, ["discarded", "nothing"]);
});

test("helper refusal (modifiers held) leaves tracker unchanged", async () => {
  const { controller, tracker, toasts } = setup({ deleteResult: "modifiers" });
  assert.equal((await controller.discard()).reason, "modifiers");
  assert.ok(tracker.get());
  assert.deepEqual(toasts, ["refused:modifiers"]);
});

test("paste failure after delete clears the tracker", async () => {
  const { controller, tracker } = setup({ deleteResult: "paste_failed" });
  assert.equal((await controller.rewrite()).reason, "paste_failed");
  assert.equal(tracker.get(), null);
});

test("second command while busy is rejected", async () => {
  let release;
  const { controller, toasts } = setup({
    rewriteImpl: () => new Promise((resolve) => (release = () => resolve({ text: "x" }))),
  });
  const first = controller.rewrite();
  await new Promise((r) => setImmediate(r));
  assert.equal((await controller.revert()).reason, "busy");
  release();
  await first;
  assert.ok(toasts.includes("busy"));
});
