import type { DetailLevel, ProviderId } from "./types";

export interface Settings {
  setupComplete: boolean;
  provider: ProviderId;
  /** Selected model per provider. May be a custom ID. */
  models: Record<ProviderId, string>;
  /** "auto" follows the browser language. */
  language: string;
  detail: DetailLevel;
  customInstructions: string;
  /** Kill switch for all feed features. */
  feedEnabled: boolean;
  minFeedMinutes: number;
  costLimit: number;
  cacheDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  setupComplete: false,
  provider: "anthropic",
  models: {
    anthropic: "claude-haiku-5-5",
    openai: "gpt-6-luna",
    gemini: "gemini-3.1-flash-lite",
  },
  language: "auto",
  detail: "standard",
  customInstructions: "",
  feedEnabled: true,
  minFeedMinutes: 5,
  costLimit: 0.1,
  cacheDays: 30,
};

const SETTINGS_KEY = "settings";

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  const saved = (stored[SETTINGS_KEY] ?? {}) as Partial<Settings>;
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    models: { ...DEFAULT_SETTINGS.models, ...saved.models },
  };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await browser.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function resolveLanguage(setting: string, browserLanguage: string): string {
  return setting === "auto" ? browserLanguage : setting;
}
