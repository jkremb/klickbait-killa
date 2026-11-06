import type { AddonError, ErrorCode, ProviderId } from "./types";

export class AddonFailure extends Error {
  constructor(public readonly detail: AddonError) {
    super(detail.code);
  }
}

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google Gemini",
};

export type ErrorAction = "retry" | "settings" | "open_video" | "report" | "setup";

export function describeError(error: AddonError): { message: string; actions: ErrorAction[] } {
  const provider = error.provider ? PROVIDER_NAMES[error.provider] : "Your AI provider";
  const table: Record<ErrorCode, { message: string; actions: ErrorAction[] }> = {
    NO_CAPTIONS: { message: "This video has no captions, so it can't be summarized.", actions: [] },
    NOT_AVAILABLE_YET: {
      message: "Not available yet. Try again after the stream or premiere ends and captions are published.",
      actions: [],
    },
    RESTRICTED: { message: "YouTube doesn't make this video's captions available to this addon.", actions: ["open_video"] },
    YOUTUBE_CHANGED: {
      message: "Couldn't summarize from here. YouTube may have changed something.",
      actions: ["retry", "open_video", "report"],
    },
    INVALID_KEY: { message: `${provider} rejected your API key.`, actions: ["settings"] },
    NO_CREDITS: { message: `Your ${provider} account is out of credits or over its limit.`, actions: ["settings"] },
    RATE_LIMITED: { message: `${provider} is busy or rate limiting your account.`, actions: ["retry"] },
    MODEL_NOT_FOUND: { message: "This model isn't available on your account.", actions: ["settings"] },
    TOO_LONG: {
      message: "This video's transcript is too long for the selected model. Choose a model with a larger context limit.",
      actions: ["settings"],
    },
    REFUSED: { message: `${provider} declined to summarize this video.`, actions: [] },
    TRUNCATED: { message: "The summary was cut off before it finished.", actions: ["retry"] },
    NETWORK: { message: `Couldn't finish contacting ${provider}. Check your connection.`, actions: ["retry"] },
    PROVIDER_ERROR: { message: `${provider} returned an unexpected error.`, actions: ["retry", "report"] },
    PERMISSION_MISSING: { message: `Klickbait Killa needs permission to contact ${provider}.`, actions: ["settings"] },
    NEEDS_SETUP: { message: "Finish setting up Klickbait Killa first.", actions: ["setup"] },
    BACKGROUND_RESTARTED: { message: "The addon was restarted before this summary finished.", actions: ["retry"] },
  };
  return table[error.code];
}
