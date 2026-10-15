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

// Optional keyboard fallback for the Watcher wheel. Alt+Shift+F-keys: unbound in
// Windows and common apps, and no Ctrl, so a modifier-only dictation key such as
// RightControl never fires with them (ghost dictations, R22). Ctrl+digit switches tabs;
// Ctrl+Alt+F8/F11/F12 belong to GPU/vendor utilities.
const DEFAULT_CONFIG = {
  enabled: true,
  linkEnabled: true, // BLE link to paired Watchers (O14)
  audioSource: "watcher", // Watcher talk audio: "watcher" (its mic, O13) | "pc-mic"
  rewriteKey: "Alt+Shift+F5",
  revertKey: "Alt+Shift+F6",
  discardKey: "Alt+Shift+F7",
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
const AUDIO_SOURCES = ["watcher", "pc-mic"];

function sanitize(input) {
  const src = input && typeof input === "object" ? input : {};
  const out = { ...DEFAULT_CONFIG, providers: {} };
  if (typeof src.enabled === "boolean") out.enabled = src.enabled;
  if (typeof src.linkEnabled === "boolean") out.linkEnabled = src.linkEnabled;
  if (AUDIO_SOURCES.includes(src.audioSource)) out.audioSource = src.audioSource;
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

// A modifier-only push-to-talk key (e.g. "RightControl") also fires when that
// modifier is part of a Watcher hotkey, starting a ghost dictation whose tiny
// paste then becomes the "last insertion".
const MODIFIER_FAMILY = {
  control: "control",
  ctrl: "control",
  commandorcontrol: "control",
  leftcontrol: "control",
  rightcontrol: "control",
  alt: "alt",
  option: "alt",
  leftalt: "alt",
  rightalt: "alt",
  leftoption: "alt",
  rightoption: "alt",
  shift: "shift",
  leftshift: "shift",
  rightshift: "shift",
  super: "super",
  meta: "super",
  command: "super",
  cmd: "super",
  win: "super",
};

function findDictationConflicts(dictationKey, config) {
  const parts = String(dictationKey || "")
    .split("+")
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length || !parts.every((p) => MODIFIER_FAMILY[p])) return [];
  const families = new Set(parts.map((p) => MODIFIER_FAMILY[p]));
  return HOTKEY_FIELDS.filter((field) =>
    String(config[field] || "")
      .split("+")
      .some((p) => families.has(MODIFIER_FAMILY[p.trim().toLowerCase()]))
  );
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
  AUDIO_SOURCES,
  findDictationConflicts,
};
