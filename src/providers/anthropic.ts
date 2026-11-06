import { AddonFailure } from "../shared/errors";
import { parseSse, providerFetch, type Provider, type SummaryRequest } from "./types";

const URL = "https://api.anthropic.com/v1/messages";

function headers(key: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2026-10-21",
    // Required by Anthropic for calls made directly from a browser context with the user's own key.
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

interface StreamData {
  type?: string;
  delta?: { type?: string; text?: string; stop_reason?: string };
  error?: { type?: string };
}

function body(req: SummaryRequest, stream: boolean): string {
  return JSON.stringify({
    model: req.model,
    max_tokens: req.maxOutputTokens,
    stream,
    system: req.system,
    messages: [{ role: "user", content: req.user }],
    ...(req.lowEffort ? { output_config: { effort: "low" } } : {}),
  });
}

export const anthropic: Provider = {
  id: "anthropic",

  async *stream(req, key, signal) {
    const response = await providerFetch("anthropic", URL, {
      method: "POST",
      headers: headers(key),
      body: body(req, true),
      signal,
    });
    let finished = false;
    for await (const { data } of parseSse(response.body!)) {
      const parsed = JSON.parse(data) as StreamData;
      if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
        yield parsed.delta.text ?? "";
      } else if (parsed.type === "message_delta") {
        if (parsed.delta?.stop_reason === "refusal") {
          throw new AddonFailure({ code: "REFUSED", provider: "anthropic" });
        }
        if (parsed.delta?.stop_reason === "max_tokens") {
          throw new AddonFailure({ code: "TRUNCATED", provider: "anthropic" });
        }
      } else if (parsed.type === "message_stop") {
        finished = true;
      } else if (parsed.type === "error") {
        const overloaded = parsed.error?.type === "overloaded_error" || parsed.error?.type === "rate_limit_error";
        throw new AddonFailure({
          code: overloaded ? "RATE_LIMITED" : "PROVIDER_ERROR",
          provider: "anthropic",
          step: "stream_error",
        });
      }
    }
    if (!finished) throw new AddonFailure({ code: "NETWORK", provider: "anthropic", step: "stream_ended_early" });
  },

  async testKey(key, model) {
    const response = await providerFetch("anthropic", URL, {
      method: "POST",
      headers: headers(key),
      body: body({ model, system: "Reply with OK.", user: "OK?", maxOutputTokens: 16, lowEffort: false }, false),
    });
    await response.body?.cancel();
  },
};
