const test = require("node:test");
const assert = require("node:assert/strict");

const { createProviderChain, ProviderChainError } = require("../../src/watcher/providerChain");

const providers = [
  { id: "a", baseUrl: "https://a.test/v1", model: "m-a", keyEnv: "KEY_A" },
  { id: "b", baseUrl: "https://b.test/v1/", model: "m-b", keyEnv: "KEY_B" },
];
const keys = { KEY_A: "ka", KEY_B: "kb" };

function reply(content, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

test("returns first provider's rewrite", async () => {
  const calls = [];
  const chain = createProviderChain({
    providers,
    getKey: (k) => keys[k],
    fetchImpl: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return reply("rewritten");
    },
  });
  const result = await chain.rewrite("raw", "SYS");
  assert.equal(result.text, "rewritten");
  assert.equal(result.provider, "a");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://a.test/v1/chat/completions");
  assert.equal(calls[0].auth, "Bearer ka");
  assert.deepEqual(calls[0].body.messages, [
    { role: "system", content: "SYS" },
    { role: "user", content: "raw" },
  ]);
});

test("fails over on 429 and strips trailing slash", async () => {
  const urls = [];
  const chain = createProviderChain({
    providers,
    getKey: (k) => keys[k],
    fetchImpl: async (url) => {
      urls.push(url);
      return url.startsWith("https://a.test") ? reply("", 429) : reply("from b");
    },
  });
  const result = await chain.rewrite("raw", "SYS");
  assert.equal(result.provider, "b");
  assert.deepEqual(result.attempts.map((a) => a.reason), ["http_429"]);
  assert.equal(urls[1], "https://b.test/v1/chat/completions");
});

test("fails over on timeout", async () => {
  const chain = createProviderChain({
    providers,
    timeoutMs: 20,
    getKey: (k) => keys[k],
    fetchImpl: (url, { signal }) =>
      url.startsWith("https://a.test")
        ? new Promise((_, reject) =>
            signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            })
          )
        : Promise.resolve(reply("from b")),
  });
  const result = await chain.rewrite("raw", "SYS");
  assert.equal(result.provider, "b");
  assert.equal(result.attempts[0].reason, "timeout");
});

test("skips providers without a key and strips think blocks", async () => {
  const chain = createProviderChain({
    providers,
    getKey: (k) => (k === "KEY_B" ? "kb" : ""),
    fetchImpl: async () => reply("<think>hmm</think>\n final "),
  });
  const result = await chain.rewrite("raw", "SYS");
  assert.equal(result.text, "final");
  assert.deepEqual(result.attempts, [{ id: "a", reason: "no_key" }]);
});

test("throws ProviderChainError when all fail, without leaking keys", async () => {
  const chain = createProviderChain({
    providers,
    getKey: (k) => keys[k],
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(chain.rewrite("raw", "SYS"), (err) => {
    assert.ok(err instanceof ProviderChainError);
    assert.deepEqual(err.attempts.map((a) => a.reason), ["network", "network"]);
    assert.ok(!err.message.includes("kb") && !err.message.includes("Bearer"));
    return true;
  });
});

test("empty content fails over", async () => {
  let n = 0;
  const chain = createProviderChain({
    providers,
    getKey: (k) => keys[k],
    fetchImpl: async () => reply(n++ === 0 ? "   " : "ok"),
  });
  const result = await chain.rewrite("raw", "SYS");
  assert.equal(result.provider, "b");
  assert.equal(result.attempts[0].reason, "empty");
});
