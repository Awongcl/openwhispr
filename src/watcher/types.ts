// Watcher fork: shapes shared by the settings UI and src/watcher/config.js.

export interface WatcherProviderConfig {
  enabled: boolean;
  model: string;
}

export interface WatcherConfig {
  enabled: boolean;
  linkEnabled: boolean;
  rewriteKey: string;
  revertKey: string;
  discardKey: string;
  systemPrompt: string;
  maxAgeMs: number;
  timeoutMs: number;
  providers: Record<"groq" | "cerebras" | "openrouter", WatcherProviderConfig>;
}

export interface WatcherBattery {
  percent: number | null;
  charging: boolean;
  low: boolean;
  critical: boolean;
  docked: boolean;
}

export interface WatcherLinkDevice {
  address: string;
  name: string | null;
  connected: boolean;
  mtu: number | null;
  firmware: string | null;
  battery: WatcherBattery | null;
}

export interface WatcherStatus {
  config: WatcherConfig;
  platformSupported: boolean;
  helperAvailable: boolean;
  hotkeys: Partial<Record<"rewriteKey" | "revertKey" | "discardKey", boolean>>;
  dictationKey: string;
  dictationConflicts: Array<"rewriteKey" | "revertKey" | "discardKey">;
  link: { available: boolean; running: boolean; devices: WatcherLinkDevice[] };
}
