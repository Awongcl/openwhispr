// Watcher fork: shapes shared by the settings UI and src/watcher/config.js.

export interface WatcherProviderConfig {
  enabled: boolean;
  model: string;
}

export interface WatcherConfig {
  enabled: boolean;
  rewriteKey: string;
  revertKey: string;
  discardKey: string;
  systemPrompt: string;
  maxAgeMs: number;
  timeoutMs: number;
  providers: Record<"groq" | "cerebras" | "openrouter", WatcherProviderConfig>;
}

export interface WatcherStatus {
  config: WatcherConfig;
  platformSupported: boolean;
  helperAvailable: boolean;
  hotkeys: Partial<Record<"rewriteKey" | "revertKey" | "discardKey", boolean>>;
}
