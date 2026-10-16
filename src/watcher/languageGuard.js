// Watcher fork: allowed-languages guard for cloud Whisper (Groq).
//
// Whisper's auto language detection keeps labelling Singapore-accented English
// as Malay/Indonesian, and then "transcribes" it as a Malay translation (seen
// on Groq whisper-large-v3 with 35-55 s clips, spec R24). The guard keeps auto
// detection, asks for verbose_json so the response names the detected language,
// and when that language is not allowed transcribes the same audio again with
// English forced. Chinese stays on auto, so mixed EN/ZH dictation keeps working.

export const ALLOWED_LANGUAGES = ["en", "zh"];
export const FALLBACK_LANGUAGE = "en";

// verbose_json reports a language name or a code; Groq sends ISO names with a
// qualifier ("Malay (macrolanguage)"), so the parenthetical is dropped.
const NAME_TO_CODE = {
  english: "en",
  chinese: "zh",
  mandarin: "zh",
  malay: "ms",
  indonesian: "id",
};

export function normalizeLanguage(value) {
  if (typeof value !== "string") return null;
  const v = value
    .replace(/\(.*?\)/g, "")
    .trim()
    .toLowerCase();
  if (!v) return null;
  return NAME_TO_CODE[v] || v.split(/[-_]/)[0];
}

// Only Groq's Whisper models, and only while the user leaves the language on auto.
export function languageGuardActive({ provider, language, model }) {
  return provider === "groq" && !language && typeof model === "string" && /^whisper/i.test(model);
}

// Same request with the language forced and the plain json response.
export function withForcedLanguage(formData, language = FALLBACK_LANGUAGE) {
  const next = new FormData();
  for (const [key, value] of formData.entries()) {
    if (key === "language" || key === "response_format") continue;
    next.append(key, value);
  }
  next.append("language", language);
  return next;
}

// `retry(language)` re-sends the request and resolves to the parsed JSON result.
// Never throws for a failed retry: the first transcript is kept instead.
export async function applyLanguageGuard(
  result,
  { retry, allowed = ALLOWED_LANGUAGES, fallback = FALLBACK_LANGUAGE, logger = null }
) {
  const detected = normalizeLanguage(result?.language);
  if (!detected || allowed.includes(detected)) return result;
  logger?.info?.(
    "Transcript language not allowed, retrying with forced language",
    { detected: result.language, fallback },
    "watcher"
  );
  try {
    const retried = await retry(fallback);
    if (retried?.text?.trim()) return { ...retried, language: fallback, guardedFrom: detected };
    logger?.warn?.("Forced-language retry returned no text", { detected }, "watcher");
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    logger?.warn?.("Forced-language retry failed", { detected, error: error?.message }, "watcher");
  }
  return result;
}
