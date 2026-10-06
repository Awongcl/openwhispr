// Watcher fork: settings owned by main, persisted as JSON in userData.
// Holds no secrets (provider keys live in OpenWhispr's encrypted key store).

const fs = require("fs");
const path = require("path");

const DEFAULT_SYSTEM_PROMPT = [
  "Rewrite the dictated text into a clear prompt for an AI coding/work agent.",
  "Keep all facts, constraints, file names, numbers verbatim.",
  "Structure: Goal / Context / Constraints / Expected output.",
  "Remove filler and false starts. Do not add requirements.",
  "Keep the input language unless the input mixes languages, then use English.",
  "Output only the rewritten prompt.",
].join("\n");

const DEFAULT_CONFIG = {
  enabled: true,
  rewriteKey: "Control+Alt+F10",
  revertKey: "Control+Alt+F11",
  discardKey: "Control+Alt+F12",
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  maxAgeMs: 5 * 60 * 1000,
  timeoutMs: 5000,
  providers: {
    groq: { enabled: true, model: "openai/gpt-oss-120b" },
    cerebras: { enabled: true, model: "gpt-oss-120b" },
    openrouter: { enabled: true, model: "openai/gpt-oss-120b:free" },
  },
};

const HOTKEY_FIELDS = ["rewriteKey", "revertKey", "discardKey"];

function sanitize(input) {
  const src = input && typeof input === "object" ? input : {};
  const out = { ...DEFAULT_CONFIG, providers: {} };
  if (typeof src.enabled === "boolean") out.enabled = src.enabled;
  for (const field of HOTKEY_FIELDS) {
    if (typeof src[field] === "string") out[field] = src[field].trim();
  }
  if (typeof src.systemPrompt === "string" && src.systemPrompt.trim()) {
    out.systemPrompt = src.systemPrompt;
  }
  const age = Number(src.maxAgeMs);
  if (Number.isFinite(age) && age >= 5000 && age <= 3600000) out.maxAgeMs = age;
  const timeout = Number(src.timeoutMs);
  if (Number.isFinite(timeout) && timeout >= 1000 && timeout <= 30000) out.timeoutMs = timeout;
  for (const [id, def] of Object.entries(DEFAULT_CONFIG.providers)) {
    const p = src.providers?.[id] || {};
    out.providers[id] = {
      enabled: typeof p.enabled === "boolean" ? p.enabled : def.enabled,
      model: typeof p.model === "string" && p.model.trim() ? p.model.trim() : def.model,
    };
  }
  return out;
}

function createConfigStore(filePath) {
  let cache = null;
  return {
    path: filePath,
    get() {
      if (cache) return cache;
      try {
        cache = sanitize(JSON.parse(fs.readFileSync(filePath, "utf8")));
      } catch {
        cache = sanitize({});
      }
      return cache;
    },
    set(next) {
      cache = sanitize({ ...this.get(), ...next });
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), "utf8");
      fs.renameSync(tmp, filePath);
      return cache;
    },
  };
}

module.exports = {
  createConfigStore,
  sanitize,
  DEFAULT_CONFIG,
  DEFAULT_SYSTEM_PROMPT,
  HOTKEY_FIELDS,
};
