const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMeter,
  createUsageMeters,
  parseDuration,
  parseGroqHeaders,
} = require("../../src/watcher/usageMeters");

const NOW = 1_800_000_000_000;

function groqHeaders(limit, remaining, reset) {
  return {
    "x-ratelimit-limit-requests": [String(limit)],
    "X-RateLimit-Remaining-Requests": [String(remaining)],
    "x-ratelimit-reset-requests": [reset],
  };
}

test("parseDuration reads Groq reset formats", () => {
  assert.equal(parseDuration("7.66s"), 7.66);
  assert.equal(parseDuration("2m59.5s"), 179.5);
  assert.equal(parseDuration("1h2m3s"), 3723);
  assert.equal(parseDuration("120ms"), 0.12);
  assert.equal(parseDuration(""), null);
  assert.equal(parseDuration("soon"), null);
});

test("parseGroqHeaders: daily requests, case-insensitive headers", () => {
  const s = parseGroqHeaders(groqHeaders(2000, 1500, "1m0s"), NOW);
  assert.deepEqual(s, { limit: 2000, remaining: 1500, resetAt: NOW / 1000 + 60, at: NOW });
  assert.equal(parseGroqHeaders({}, NOW), null);
});

test("buildMeter: worst endpoint is the headline", () => {
  const m = buildMeter(
    {
      speech: { limit: 2000, remaining: 1500, resetAt: NOW / 1000 + 60 },
      text: { limit: 1000, remaining: 100, resetAt: NOW / 1000 + 600 },
    },
    NOW
  );
  assert.equal(m.provider, "groq");
  assert.equal(m.pct_used, 90);
  assert.equal(m.reset_at, NOW / 1000 + 600);
  assert.equal(m.detail, "100 text req left");
  assert.deepEqual(
    m.breakdown.map((i) => [i.label, i.pct_used]),
    [
      ["speech/day", 25],
      ["text/day", 90],
    ]
  );
});

test("buildMeter: a window past its reset reads 0 %", () => {
  const m = buildMeter({ speech: { limit: 2000, remaining: 10, resetAt: NOW / 1000 - 1 } }, NOW);
  assert.equal(m.pct_used, 0);
  assert.equal(m.reset_at, null);
});

function setup({ url = "http://srv:8000/", token = "tok", status = 204 } = {}) {
  const calls = [];
  const timers = [];
  const meters = createUsageMeters({
    getUrl: () => url,
    getToken: () => token,
    fetchImpl: async (u, opts) => {
      calls.push({ u, opts });
      return { ok: status < 300, status };
    },
    now: () => NOW,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimer: () => {},
  });
  return { meters, calls, timers };
}

test("Groq responses are batched into one push with the device token", async () => {
  const { meters, calls, timers } = setup();
  const headers = groqHeaders(2000, 1990, "30s");
  meters.onGroqResponse({
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    responseHeaders: headers,
  });
  meters.onGroqResponse({
    url: "https://api.groq.com/openai/v1/chat/completions",
    responseHeaders: headers,
  });
  meters.onGroqResponse({ url: "https://api.groq.com/openai/v1/models", responseHeaders: headers }); // ignored
  assert.equal(timers.length, 1);
  await timers[0].fn();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].u, "http://srv:8000/push");
  assert.equal(calls[0].opts.headers.Authorization, "Bearer tok");
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(
    body.meters[0].breakdown.map((i) => i.label),
    ["speech/day", "text/day"]
  );
});

test("no push without server URL or token", async () => {
  const { meters, calls, timers } = setup({ token: "" });
  meters.onGroqResponse({
    url: "https://api.groq.com/openai/v1/audio/transcriptions",
    responseHeaders: groqHeaders(10, 5, "1s"),
  });
  assert.equal(await timers[0].fn(), false);
  assert.equal(calls.length, 0);
});

test("responses without rate-limit headers schedule nothing", () => {
  const { meters, timers } = setup();
  meters.onGroqResponse({
    url: "https://api.groq.com/openai/v1/chat/completions",
    responseHeaders: {},
  });
  assert.equal(timers.length, 0);
});
