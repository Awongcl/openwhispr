// Watcher fork: shapes shared by the settings UI and src/watcher/config.js.

export interface WatcherProviderConfig {
  enabled: boolean;
  model: string;
}

export interface WatcherConfig {
  enabled: boolean;
  linkEnabled: boolean;
  audioSource: "watcher" | "pc-mic";
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

// Main -> renderer: one Watcher talk's decoded audio (O13).
export interface WatcherTalkAudio {
  session: number;
  wav: Uint8Array; // 16 kHz mono 16-bit WAV
  durationSeconds: number;
}

// Main -> renderer: a Watcher talk is live (pill listening state + waveform level).
export interface WatcherTalkLive {
  session: number;
  active: boolean;
  level?: number; // RMS 0..1 of the latest decoded frame; absent on the start/stop updates
}
