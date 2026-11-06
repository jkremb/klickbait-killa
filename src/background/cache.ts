import { MAX_CACHE_ENTRIES } from "../shared/config";
import { PROMPT_VERSION } from "./prompt";

export interface CacheIdentity {
  videoId: string;
  provider: string;
  model: string;
  language: string;
  detail: string;
  customInstructions: string;
}

export interface CacheEntry {
  videoId: string;
  text: string;
  title: string;
  channel: string;
  durationSeconds: number;
  createdAt: number;
}

export type CacheMap = Record<string, CacheEntry>;

const DAY_MS = 86_400_000;

/** Changing any part of the identity produces a separate summary. */
export async function cacheKey(identity: CacheIdentity, promptVersion = PROMPT_VERSION): Promise<string> {
  const { videoId, provider, model, language, detail, customInstructions } = identity;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(customInstructions));
  const hash = Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
  return [`v${promptVersion}`, videoId, provider, model, language, detail, hash].join("|");
}

export function isExpired(entry: CacheEntry, cacheDays: number, now: number): boolean {
  return now - entry.createdAt > cacheDays * DAY_MS;
}

/** Removes expired entries, then the oldest entries beyond the size limit. */
export function pruneEntries(entries: CacheMap, cacheDays: number, now: number, maxEntries = MAX_CACHE_ENTRIES): CacheMap {
  const live = Object.entries(entries).filter(([, entry]) => !isExpired(entry, cacheDays, now));
  live.sort(([, a], [, b]) => b.createdAt - a.createdAt);
  return Object.fromEntries(live.slice(0, maxEntries));
}

const STORAGE_KEY = "summaries";

export const summaryCache = {
  async all(): Promise<CacheMap> {
    return ((await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY] ?? {}) as CacheMap;
  },

  async get(key: string, cacheDays: number): Promise<CacheEntry | undefined> {
    const entry = (await this.all())[key];
    return entry && !isExpired(entry, cacheDays, Date.now()) ? entry : undefined;
  },

  async put(key: string, entry: CacheEntry, cacheDays: number): Promise<void> {
    const entries = pruneEntries({ ...(await this.all()), [key]: entry }, cacheDays, Date.now());
    await browser.storage.local.set({ [STORAGE_KEY]: entries });
  },

  async clear(): Promise<void> {
    await browser.storage.local.remove(STORAGE_KEY);
  },
};
