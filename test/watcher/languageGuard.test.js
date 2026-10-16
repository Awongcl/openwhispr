const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/watcher/languageGuard.js");

test("normalizeLanguage maps Whisper names and codes", async () => {
  const { normalizeLanguage } = await load();
  assert.equal(normalizeLanguage("english"), "en");
  assert.equal(normalizeLanguage("English"), "en");
  assert.equal(normalizeLanguage("chinese"), "zh");
  assert.equal(normalizeLanguage("malay"), "ms");
  assert.equal(normalizeLanguage("Malay (macrolanguage)"), "ms"); // Groq's form (seen 2026-10-16)
  assert.equal(normalizeLanguage("Chinese (Mandarin)"), "zh");
  assert.equal(normalizeLanguage("zh-CN"), "zh");
  assert.equal(normalizeLanguage(""), null);
  assert.equal(normalizeLanguage(undefined), null);
});

test("guard only for Groq Whisper with the language on auto", async () => {
  const { languageGuardActive } = await load();
  assert.equal(
    languageGuardActive({ provider: "groq", language: undefined, model: "whisper-large-v3" }),
    true
  );
  assert.equal(
    languageGuardActive({ provider: "groq", language: "en", model: "whisper-large-v3" }),
    false
  );
  assert.equal(
    languageGuardActive({ provider: "openai", language: undefined, model: "whisper-1" }),
    false
  );
  assert.equal(
    languageGuardActive({ provider: "groq", language: undefined, model: "distil-x" }),
    false
  );
});

test("allowed or unknown language keeps the first transcript", async () => {
  const { applyLanguageGuard } = await load();
  let retries = 0;
  const retry = async () => {
    retries++;
    return { text: "x" };
  };
  const en = { text: "hello", language: "english" };
  const zh = { text: "你好", language: "chinese" };
  const none = { text: "hi" };
  assert.equal(await applyLanguageGuard(en, { retry }), en);
  assert.equal(await applyLanguageGuard(zh, { retry }), zh);
  assert.equal(await applyLanguageGuard(none, { retry }), none);
  assert.equal(retries, 0);
});

test("a disallowed language is transcribed again with English forced", async () => {
  const { applyLanguageGuard } = await load();
  const forced = [];
  const out = await applyLanguageGuard(
    { text: "Saya perlukan anda", language: "malay" },
    {
      retry: async (lang) => {
        forced.push(lang);
        return { text: "I need you" };
      },
    }
  );
  assert.deepEqual(forced, ["en"]);
  assert.equal(out.text, "I need you");
  assert.equal(out.guardedFrom, "ms");
});

test("a failed or empty retry keeps the first transcript; abort propagates", async () => {
  const { applyLanguageGuard } = await load();
  const first = { text: "Saya", language: "malay" };
  assert.equal(
    await applyLanguageGuard(first, {
      retry: async () => {
        throw new Error("API Error: 500");
      },
    }),
    first
  );
  assert.equal(await applyLanguageGuard(first, { retry: async () => ({ text: "  " }) }), first);
  const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
  await assert.rejects(
    applyLanguageGuard(first, {
      retry: async () => {
        throw abort;
      },
    }),
    abort
  );
});

test("withForcedLanguage copies the request with the language forced", async () => {
  const { withForcedLanguage } = await load();
  const fd = new FormData();
  fd.append("file", new Blob([new Uint8Array([1, 2])], { type: "audio/wav" }), "audio.wav");
  fd.append("model", "whisper-large-v3");
  fd.append("prompt", "OpenWhispr");
  fd.append("response_format", "verbose_json");
  const next = withForcedLanguage(fd, "en");
  assert.equal(next.get("language"), "en");
  assert.equal(next.get("response_format"), null);
  assert.equal(next.get("model"), "whisper-large-v3");
  assert.equal(next.get("prompt"), "OpenWhispr");
  assert.equal(next.get("file").name, "audio.wav");
});
