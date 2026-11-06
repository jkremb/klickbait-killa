import { UNKNOWN_PRICE_TOKEN_LIMIT } from "../shared/config";
import type { CostConfirmation, DetailLevel, ProviderId } from "../shared/types";

export interface ModelInfo {
  id: string;
  label: string;
  provider: ProviderId;
  contextLimit: number;
  /** US dollars per million tokens. */
  input: number;
  output: number;
  /** Higher rates that apply to the whole request once input exceeds a threshold. */
  longContext?: { above: number; input: number; output: number };
  /** Whether the provider's low-effort setting can be sent to this model. */
  lowEffort: boolean;
  recommended?: boolean;
}

/** Prices were checked against each provider's documentation on this date. */
export const PRICES_CHECKED = "2026-11-05";

export const MODELS: ModelInfo[] = [
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", provider: "anthropic", contextLimit: 1_000_000, input: 0.1, output: 0.5,
    longContext: { above: 100_000, input: 0.5, output: 2.5 }, lowEffort: true, recommended: true },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", provider: "anthropic", contextLimit: 1_000_000, input: 2, output: 10, lowEffort: true },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic", contextLimit: 1_000_000, input: 4, output: 20, lowEffort: true },

  { id: "gpt-6-luna", label: "GPT-6 Luna", provider: "openai", contextLimit: 1_050_000, input: 0.1, output: 0.5, lowEffort: true, recommended: true },
  { id: "gpt-6.1-terra", label: "GPT-6.1 Terra", provider: "openai", contextLimit: 1_050_000, input: 1, output: 5, lowEffort: true },

  // Context limits for Gemini weren't listed on the pricing page; 1M is an assumption.
  { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", provider: "gemini", contextLimit: 1_000_000, input: 0.25, output: 1.5, lowEffort: false, recommended: true },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", provider: "gemini", contextLimit: 1_000_000, input: 0.3, output: 2.5, lowEffort: false },
  // Uses the rate announced from January 1, 2027, so estimates don't understate cost.
  { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "gemini", contextLimit: 1_000_000, input: 1.5, output: 7.5, lowEffort: false },
];

export function findModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}

export const OUTPUT_TOKENS: Record<DetailLevel, number> = { brief: 400, standard: 900, detailed: 2500 };

/** Rough rule of thumb: about 4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateCost(model: ModelInfo, inputTokens: number, outputTokens: number): number {
  const rates = model.longContext && inputTokens > model.longContext.above ? model.longContext : model;
  return (inputTokens * rates.input + outputTokens * rates.output) / 1_000_000;
}

export type Preflight =
  | { action: "start" }
  | { action: "confirm"; confirm: CostConfirmation }
  | { action: "too_long" };

export function preflight(modelId: string, promptText: string, detail: DetailLevel, costLimit: number): Preflight {
  const estimatedTokens = estimateTokens(promptText);
  const model = findModel(modelId);
  if (!model) {
    return estimatedTokens > UNKNOWN_PRICE_TOKEN_LIMIT ? { action: "confirm", confirm: { estimatedTokens } } : { action: "start" };
  }
  if (estimatedTokens > model.contextLimit) return { action: "too_long" };
  const estimatedCost = estimateCost(model, estimatedTokens, OUTPUT_TOKENS[detail]);
  return estimatedCost > costLimit ? { action: "confirm", confirm: { estimatedTokens, estimatedCost } } : { action: "start" };
}
