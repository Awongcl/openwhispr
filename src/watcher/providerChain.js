// Watcher fork (spec O7): OpenAI-compatible chat-completions failover chain for
// the rewrite step. Runs in main; keys come from process.env via getKey and are
// never logged.

const DEFAULT_TIMEOUT_MS = 5000;

const DEFAULT_CHAIN = [
  {
    id: "groq",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "openai/gpt-oss-120b",
    keyEnv: "GROQ_API_KEY",
    extraBody: { reasoning_effort: "low" },
  },
  {
    id: "cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    model: "gpt-oss-120b",
    keyEnv: "CEREBRAS_API_KEY",
    extraBody: { reasoning_effort: "low" },
  },
  {
    id: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "openai/gpt-oss-120b:free",
    keyEnv: "OPENROUTER_API_KEY",
  },
];

class ProviderChainError extends Error {
  constructor(attempts) {
    super(`All rewrite providers failed: ${attempts.map((a) => `${a.id}=${a.reason}`).join(", ")}`);
    this.name = "ProviderChainError";
    this.attempts = attempts;
  }
}

function stripReasoning(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function createProviderChain({
  providers = DEFAULT_CHAIN,
  getKey = (env) => process.env[env] || "",
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  logger = null,
} = {}) {
  async function callProvider(provider, apiKey, systemPrompt, text) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: text },
          ],
          temperature: 0.2,
          ...(provider.extraBody || {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, reason: `http_${response.status}` };
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      const cleaned = typeof content === "string" ? stripReasoning(content) : "";
      if (!cleaned) return { ok: false, reason: "empty" };
      return { ok: true, text: cleaned };
    } catch (error) {
      return { ok: false, reason: error?.name === "AbortError" ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  async function rewrite(text, systemPrompt) {
    const attempts = [];
    for (const provider of providers) {
      const apiKey = getKey(provider.keyEnv);
      if (!apiKey) {
        attempts.push({ id: provider.id, reason: "no_key" });
        continue;
      }
      const started = Date.now();
      const result = await callProvider(provider, apiKey, systemPrompt, text);
      const ms = Date.now() - started;
      if (result.ok) {
        logger?.info?.("Rewrite succeeded", { provider: provider.id, ms }, "watcher");
        return { text: result.text, provider: provider.id, model: provider.model, attempts };
      }
      attempts.push({ id: provider.id, reason: result.reason, ms });
      logger?.warn?.("Rewrite provider failed", { provider: provider.id, reason: result.reason, ms }, "watcher");
    }
    throw new ProviderChainError(attempts);
  }

  return { rewrite };
}

module.exports = { createProviderChain, ProviderChainError, DEFAULT_CHAIN, DEFAULT_TIMEOUT_MS };
