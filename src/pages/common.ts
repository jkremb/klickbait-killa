import { describeError } from "../shared/errors";
import type { PageRequest, PageResponse, ProviderId } from "../shared/types";

export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

export function callBackground(request: PageRequest): Promise<PageResponse> {
  return browser.runtime.sendMessage(request) as Promise<PageResponse>;
}

export function failureText(response: PageResponse): string {
  if (response.ok) return "";
  if (response.reason === "wrong_passphrase") return "That passphrase isn't right.";
  if (response.reason === "passphrase_too_short") return "Use at least 8 characters.";
  return response.error ? describeError(response.error).message : "Something went wrong.";
}

export interface ProviderInfo {
  name: string;
  origin: string;
  keyUrl: string;
  summary: string;
  dataNote: string;
}

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    name: "Anthropic (Claude)",
    origin: "https://api.anthropic.com/*",
    keyUrl: "https://platform.claude.com/settings/keys",
    summary: "Requires a paid API account.",
    dataNote: "Anthropic handles what you send under its API terms. Review them to see how long data is kept and how it's used.",
  },
  openai: {
    name: "OpenAI (GPT)",
    origin: "https://api.openai.com/*",
    keyUrl: "https://platform.openai.com/api-keys",
    summary: "Requires a paid API account.",
    dataNote: "OpenAI handles what you send under its API terms. Review them to see how long data is kept and how it's used.",
  },
  gemini: {
    name: "Google Gemini",
    origin: "https://generativelanguage.googleapis.com/*",
    keyUrl: "https://aistudio.google.com/apikey",
    summary: "Has a free tier, with limits. Google may use free-tier content to improve its products.",
    dataNote: "On Gemini's free tier, Google says it may use your content to improve its products. On the paid tier, it says it doesn't.",
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDER_INFO) as ProviderId[];
