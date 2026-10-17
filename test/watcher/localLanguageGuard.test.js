// Watcher fork: EN/ZH language guard on the local whisper.cpp path (Watcher mic, O13).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

// debugLogger reads Electron's `app` on Windows when loaded; plain Node has none.
const noop = () => {};
require.cache[require.resolve("../../src/helpers/debugLogger")] = {
  loaded: true,
  exports: new Proxy({}, { get: () => noop }),
};

const WhisperServerManager = require("../../src/helpers/whisperServer");
const WhisperManager = require("../../src/helpers/whisper");

const load = () => import("../../src/watcher/languageGuard.js");

function startCapturingServer(response) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("latin1"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, bodies }));
  });
}

function createManager(port) {
  const manager = new WhisperServerManager();
  manager.ready = true;
  manager.hostname = "127.0.0.1";
  manager.port = port;
  manager.canConvert = true;
  manager.process = {};
  manager.modelPath = "/tmp/model.bin";
  manager._convertToWav = async (buffer) => buffer;
  return manager;
}

function fieldValue(body, name) {
  const match = body.match(
    new RegExp(`Content-Disposition: form-data; name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`)
  );
  return match ? match[1] : null;
}

test("whisper-server request asks for verbose_json only when requested", async (t) => {
  // Shape of whisper-server v1.x verbose_json (checked against the bundled binary).
  const { server, port, bodies } = await startCapturingServer({
    task: "transcribe",
    language: "english",
    text: " hello\n",
  });
  t.after(() => server.close());

  const manager = createManager(port);
  await manager.transcribe(Buffer.from("audio"), { responseFormat: "verbose_json" });
  await manager.transcribe(Buffer.from("audio"), { language: "en" });
  await manager.transcribe(Buffer.from("audio"), { responseFormat: "srt" });
  assert.equal(fieldValue(bodies[0], "response_format"), "verbose_json");
  assert.equal(fieldValue(bodies[0], "language"), "auto");
  assert.equal(fieldValue(bodies[1], "response_format"), "json");
  assert.equal(fieldValue(bodies[2], "response_format"), "json");
});

test("transcribeLocalWhisper plumbs responseFormat and returns the detected language", async () => {
  const manager = new WhisperManager();
  const captured = [];
  manager.serverManager.isAvailable = () => true;
  manager.serverManager.start = async () => {};
  manager.serverManager.transcribe = async (_buffer, options) => {
    captured.push(options);
    return options.responseFormat === "verbose_json"
      ? { task: "transcribe", language: "malay", text: " Saya perlukan\n" }
      : { text: " I need\n" };
  };
  manager.getModelPath = () => __filename;

  const verbose = await manager.transcribeLocalWhisper(Buffer.from("audio"), {
    model: "base",
    responseFormat: "verbose_json",
  });
  assert.equal(captured[0].responseFormat, "verbose_json");
  assert.deepEqual(verbose, { success: true, text: "Saya perlukan", language: "malay" });

  const plain = await manager.transcribeLocalWhisper(Buffer.from("audio"), {
    model: "base",
    language: "en",
  });
  assert.equal(captured[1].responseFormat, undefined);
  assert.deepEqual(plain, { success: true, text: "I need" });
});

test("local guard only while the language is on auto", async () => {
  const { localLanguageGuardActive } = await load();
  assert.equal(localLanguageGuardActive({ model: "medium" }), true);
  assert.equal(localLanguageGuardActive({ model: "medium", language: "zh" }), false);
  assert.equal(localLanguageGuardActive(), true);
});

test("whisper.cpp language names: Chinese variants stay, Malay is redone in English", async () => {
  const { normalizeLanguage, applyLanguageGuard } = await load();
  assert.equal(normalizeLanguage("cantonese"), "zh");
  assert.equal(normalizeLanguage("yue"), "zh");

  const forced = [];
  const retry = async (language) => {
    forced.push(language);
    return { success: true, text: "I need you" };
  };
  const zh = { success: true, text: "帮我检查", language: "chinese" };
  assert.equal(await applyLanguageGuard(zh, { retry }), zh);
  const out = await applyLanguageGuard(
    { success: true, text: "Saya perlukan anda", language: "malay" },
    { retry }
  );
  assert.deepEqual(forced, ["en"]);
  assert.deepEqual(out, { success: true, text: "I need you", language: "en", guardedFrom: "ms" });

  // A failed local retry ({ success: false }, no text) keeps the first transcript.
  const first = { success: true, text: "Saya", language: "malay" };
  assert.equal(
    await applyLanguageGuard(first, { retry: async () => ({ success: false, message: "x" }) }),
    first
  );
});
