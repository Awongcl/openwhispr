// Watcher fork (spec O11): Groq usage for the Watcher's usage page. Groq has no usage API, so the
// rate-limit headers of the app's own Groq calls (Whisper transcription, cleanup / rewrite) are read
// and pushed as a meter to the usage service (`POST <url>/push`, device bearer token).
// Config from userData .env: WATCHER_METERS_URL, WATCHER_METERS_TOKEN. The token is never logged.

const GROQ_URLS = ["https://api.groq.com/*"];
const PUSH_DELAY_MS = 15 * 1000; // batch a burst of calls (transcribe + cleanup) into one push
const MIN_PUSH_INTERVAL_MS = 60 * 1000;

// Groq reset values look like "7.66s", "2m59.56s", "1h2m3s" or "120ms".
function parseDuration(value) {
  if (typeof value !== "string" || !value) return null;
  let total = 0;
  let matched = false;
  for (const [, num, unit] of value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    matched = true;
    const n = Number(num);
    total += unit === "h" ? n * 3600 : unit === "m" ? n * 60 : unit === "s" ? n : n / 1000;
  }
  return matched ? total : null;
}

function header(headers, name) {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const v = key === undefined ? undefined : headers[key];
  return Array.isArray(v) ? v[0] : v;
}

// requests = per day (RPD), tokens = per minute (TPM) on Groq.
function parseGroqHeaders(headers, nowMs = Date.now()) {
  const limit = Number(header(headers, "x-ratelimit-limit-requests"));
  const remaining = Number(header(headers, "x-ratelimit-remaining-requests"));
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null;
  const resetS = parseDuration(header(headers, "x-ratelimit-reset-requests"));
  return {
    limit,
    remaining: Math.max(0, Math.min(limit, remaining)),
    resetAt: resetS == null ? null : Math.round(nowMs / 1000 + resetS),
    at: nowMs,
  };
}

function endpointLabel(url) {
  if (/\/audio\//.test(url)) return "speech";
  if (/\/chat\//.test(url)) return "text";
  return null;
}

function buildMeter(samples, nowMs = Date.now()) {
  const items = [];
  for (const [label, s] of Object.entries(samples)) {
    // Past the reset the window is fresh again, as the header said.
    const expired = s.resetAt != null && s.resetAt * 1000 <= nowMs;
    const used = expired ? 0 : s.limit - s.remaining;
    items.push({
      label: `${label}/day`,
      pct_used: Math.round((1000 * used) / s.limit) / 10,
      reset_at: expired ? null : s.resetAt,
      count: expired ? s.limit : s.remaining,
    });
  }
  if (!items.length) return null;
  const worst = items.reduce((a, b) => (b.pct_used > a.pct_used ? b : a));
  return {
    provider: "groq",
    label: "Groq",
    pct_used: worst.pct_used,
    reset_at: worst.reset_at,
    detail: `${worst.count} ${worst.label.split("/")[0]} req left`,
    breakdown: items,
  };
}

function createUsageMeters({
  getUrl = () => process.env.WATCHER_METERS_URL || "",
  getToken = () => process.env.WATCHER_METERS_TOKEN || "",
  fetchImpl = globalThis.fetch,
  logger = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const samples = {}; // label -> latest parsed headers
  let timer = null;
  let lastPush = 0;
  let warnedConfig = false;

  async function push() {
    timer = null;
    const url = getUrl().replace(/\/+$/, "");
    const token = getToken();
    if (!url || !token) {
      if (!warnedConfig) {
        warnedConfig = true;
        logger?.info?.(
          "Groq meter not pushed: WATCHER_METERS_URL / WATCHER_METERS_TOKEN not set",
          {},
          "watcher"
        );
      }
      return false;
    }
    const meter = buildMeter(samples, now());
    if (!meter) return false;
    lastPush = now();
    try {
      const res = await fetchImpl(`${url}/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ meters: [meter] }),
      });
      if (!res.ok) {
        logger?.warn?.("Groq meter push failed", { status: res.status }, "watcher");
        return false;
      }
      logger?.debug?.("Groq meter pushed", { pct: meter.pct_used }, "watcher");
      return true;
    } catch (error) {
      logger?.warn?.("Groq meter push failed", { error: error.message }, "watcher");
      return false;
    }
  }

  function schedule() {
    if (timer) return;
    const wait = Math.max(PUSH_DELAY_MS, lastPush + MIN_PUSH_INTERVAL_MS - now());
    timer = setTimer(push, wait);
  }

  // details: Electron webRequest onCompleted ({ url, statusCode, responseHeaders }).
  function onGroqResponse(details) {
    const label = endpointLabel(details?.url || "");
    const parsed = label && parseGroqHeaders(details.responseHeaders, now());
    if (!parsed) return;
    samples[label] = parsed;
    schedule();
  }

  function attach(session) {
    session.webRequest.onCompleted({ urls: GROQ_URLS }, onGroqResponse);
  }

  function stop() {
    if (timer) clearTimer(timer);
    timer = null;
  }

  return { attach, onGroqResponse, push, stop, samples };
}

module.exports = { createUsageMeters, parseGroqHeaders, parseDuration, buildMeter, endpointLabel };
