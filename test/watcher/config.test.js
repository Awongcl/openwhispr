const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { sanitize, createConfigStore, DEFAULT_CONFIG } = require("../../src/watcher/config");
const { buildProviders } = require("../../src/watcher/index.js");

test("sanitize fills defaults and rejects bad values", () => {
  assert.deepEqual(sanitize(null), sanitize({}));
  const c = sanitize({
    enabled: "yes",
    rewriteKey: " Control+Alt+F7 ",
    maxAgeMs: 10,
    timeoutMs: 99999,
    systemPrompt: "  ",
    providers: { groq: { enabled: false, model: "" }, bogus: { enabled: true } },
  });
  assert.equal(c.enabled, true);
  assert.equal(c.rewriteKey, "Control+Alt+F7");
  assert.equal(c.maxAgeMs, DEFAULT_CONFIG.maxAgeMs);
  assert.equal(c.timeoutMs, DEFAULT_CONFIG.timeoutMs);
  assert.equal(c.systemPrompt, DEFAULT_CONFIG.systemPrompt);
  assert.deepEqual(c.providers.groq, { enabled: false, model: "openai/gpt-oss-120b" });
  assert.equal(c.providers.bogus, undefined);
});

test("store persists merged config atomically", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-cfg-"));
  const file = path.join(dir, "watcher-config.json");
  const store = createConfigStore(file);
  assert.equal(store.get().rewriteKey, "Control+Alt+F5");
  store.set({ revertKey: "" });
  const reread = createConfigStore(file).get();
  assert.equal(reread.revertKey, "");
  assert.equal(reread.rewriteKey, "Control+Alt+F5");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("buildProviders keeps order, drops disabled, applies model", () => {
  const c = sanitize({ providers: { cerebras: { enabled: false }, openrouter: { model: "x:free" } } });
  const list = buildProviders(c);
  assert.deepEqual(list.map((p) => p.id), ["groq", "openrouter"]);
  assert.equal(list[1].model, "x:free");
  assert.equal(list[0].keyEnv, "GROQ_API_KEY");
});
