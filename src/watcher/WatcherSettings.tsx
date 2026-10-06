// Watcher fork settings (Settings -> Hotkeys, bottom). English-only by design:
// a personal fork; an upstream PR would need i18n keys in every locale.

import { useCallback, useEffect, useRef, useState } from "react";
import { HotkeyInput } from "../components/ui/HotkeyInput";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Toggle } from "../components/ui/toggle";
import {
  SectionHeader,
  SettingsPanel,
  SettingsPanelRow,
} from "../components/ui/SettingsSection";
import type { WatcherConfig, WatcherStatus } from "./types";

const HOTKEYS: Array<{ field: "rewriteKey" | "revertKey" | "discardKey"; label: string }> = [
  { field: "rewriteKey", label: "Rewrite last dictation" },
  { field: "revertKey", label: "Revert to original" },
  { field: "discardKey", label: "Discard last dictation" },
];

const PROVIDERS: Array<{ id: keyof WatcherConfig["providers"]; label: string }> = [
  { id: "groq", label: "Groq (uses the Groq key from AI Models)" },
  { id: "cerebras", label: "Cerebras" },
  { id: "openrouter", label: "OpenRouter (uses the OpenRouter key from AI Models)" },
];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <SettingsPanelRow>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted-foreground/80">{label}</span>
        <div className="flex items-center gap-2">{children}</div>
      </div>
    </SettingsPanelRow>
  );
}

export default function WatcherSettings() {
  const api = window.electronAPI;
  const [status, setStatus] = useState<WatcherStatus | null>(null);
  const [prompt, setPrompt] = useState("");
  const [cerebrasKey, setCerebrasKey] = useState("");
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!api?.watcherGetConfig) return;
    api.watcherGetConfig().then((s) => {
      setStatus(s);
      setPrompt(s.config.systemPrompt);
    });
    api.getCerebrasKey?.().then((k) => setCerebrasKey(k || ""));
  }, [api]);

  const save = useCallback(
    async (patch: Partial<WatcherConfig>) => {
      if (!api?.watcherSetConfig) return;
      setStatus(await api.watcherSetConfig(patch));
    },
    [api]
  );

  const saveCerebrasKey = (value: string) => {
    setCerebrasKey(value);
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => api?.saveCerebrasKey?.(value.trim()), 600);
  };

  if (!status) return null;
  const { config } = status;

  return (
    <div>
      <SectionHeader
        title="Watcher controller"
        description="Rewrite, revert or discard the last dictation in place (Backspace + paste). Swaps are refused if the window changed, you typed or clicked, or the dictation is too old."
      />
      {!status.platformSupported && (
        <p className="mb-2 text-xs text-muted-foreground">Windows only for now.</p>
      )}
      {status.platformSupported && !status.helperAvailable && (
        <p className="mb-2 text-xs text-destructive">
          watcher-input.exe is missing: run "npm run compile:watcher-input".
        </p>
      )}
      <SettingsPanel>
        <Row label="Enabled">
          <Toggle checked={config.enabled} onChange={(enabled) => save({ enabled })} />
        </Row>
        {HOTKEYS.map(({ field, label }) => (
          <SettingsPanelRow key={field}>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-xs text-muted-foreground/80">{label}</span>
              {config.enabled && status.hotkeys[field] === false && (
                <span className="text-xs text-destructive">Could not register</span>
              )}
            </div>
            <HotkeyInput
              value={config[field]}
              onChange={(hotkey) => save({ [field]: hotkey })}
              onClear={() => save({ [field]: "" })}
            />
          </SettingsPanelRow>
        ))}
        <Row label="Max age before swaps are refused (minutes)">
          <Input
            type="number"
            min={1}
            max={60}
            className="w-20"
            value={Math.round(config.maxAgeMs / 60000)}
            onChange={(e) => {
              const minutes = Number(e.target.value);
              if (minutes >= 1 && minutes <= 60) save({ maxAgeMs: minutes * 60000 });
            }}
          />
        </Row>
      </SettingsPanel>

      <div className="mt-4">
        <SectionHeader
          title="Rewrite providers"
          description="Tried in order; moves on after a rate limit, error or timeout."
        />
        <SettingsPanel>
          {PROVIDERS.map(({ id, label }) => (
            <SettingsPanelRow key={id}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground/80">{label}</span>
                <Toggle
                  checked={config.providers[id].enabled}
                  onChange={(enabled) =>
                    save({
                      providers: { ...config.providers, [id]: { ...config.providers[id], enabled } },
                    })
                  }
                />
              </div>
              <Input
                className="mt-2"
                value={config.providers[id].model}
                onChange={(e) =>
                  setStatus({
                    ...status,
                    config: {
                      ...config,
                      providers: {
                        ...config.providers,
                        [id]: { ...config.providers[id], model: e.target.value },
                      },
                    },
                  })
                }
                onBlur={() => save({ providers: config.providers })}
              />
            </SettingsPanelRow>
          ))}
          <Row label="Cerebras API key">
            <Input
              type="password"
              className="w-64"
              autoComplete="off"
              placeholder="csk-..."
              value={cerebrasKey}
              onChange={(e) => saveCerebrasKey(e.target.value)}
            />
          </Row>
          <Row label="Timeout per provider (seconds)">
            <Input
              type="number"
              min={1}
              max={30}
              className="w-20"
              value={Math.round(config.timeoutMs / 1000)}
              onChange={(e) => {
                const seconds = Number(e.target.value);
                if (seconds >= 1 && seconds <= 30) save({ timeoutMs: seconds * 1000 });
              }}
            />
          </Row>
        </SettingsPanel>
      </div>

      <div className="mt-4">
        <SectionHeader title="Rewrite prompt" description="System prompt sent with the RAW text." />
        <SettingsPanel>
          <SettingsPanelRow>
            <Textarea
              rows={7}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onBlur={() => prompt.trim() && save({ systemPrompt: prompt })}
            />
          </SettingsPanelRow>
        </SettingsPanel>
      </div>
    </div>
  );
}
