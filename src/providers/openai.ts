import { AddonFailure } from "../shared/errors";
import { parseSse, providerFetch, type Provider, type SummaryRequest } from "./types";

const URL = "https://api.openai.com/v1/responses";

function headers(key: string): Record<string, string> {
  return { "content-type": "application/json", authorization: `Bearer ${key}` };
}

function body(req: SummaryRequest, stream: boolean): string {
  return JSON.stringify({
    model: req.model,
    stream,
    instructions: req.system,
    input: req.user,
    max_output_tokens: req.maxOutputTokens,
    // Summaries are retained only in the addon's local cache, not at the provider's request.
    store: false,
    ...(req.lowEffort ? { reasoning: { effort: "low" } } : {}),
  });
}

interface StreamData {
  type?: string;
  delta?: string;
  response?: { incomplete_details?: { reason?: string }; error?: { code?: string } };
  error?: { code?: string };
  code?: string;
}

export const openai: Provider = {
  id: "openai",

  async *stream(req, key, signal) {
    const response = await providerFetch("openai", URL, {
      method: "POST",
      headers: headers(key),
      body: body(req, true),
      signal,
    });
    let finished = false;
    for await (const { data } of parseSse(response.body!)) {
      if (data === "[DONE]") continue;
      const parsed = JSON.parse(data) as StreamData;
      switch (parsed.type) {
        case "response.output_text.delta":
          yield parsed.delta ?? "";
          break;
        case "response.refusal.delta":
        case "response.refusal.done":
          throw new AddonFailure({ code: "REFUSED", provider: "openai" });
        case "response.completed":
          finished = true;
          break;
        case "response.incomplete": {
          const reason = parsed.response?.incomplete_details?.reason;
          throw new AddonFailure({
            code: reason === "content_filter" ? "REFUSED" : "TRUNCATED",
            provider: "openai",
          });
        }
        case "response.failed":
        case "error": {
          const code = parsed.response?.error?.code ?? parsed.error?.code ?? parsed.code;
          throw new AddonFailure({
            code: code === "rate_limit_exceeded" ? "RATE_LIMITED" : "PROVIDER_ERROR",
            provider: "openai",
            step: "stream_error",
          });
        }
      }
    }
    if (!finished) throw new AddonFailure({ code: "NETWORK", provider: "openai", step: "stream_ended_early" });
  },

  async testKey(key, model) {
    const response = await providerFetch("openai", URL, {
      method: "POST",
      headers: headers(key),
      body: body({ model, system: "Reply with OK.", user: "OK?", maxOutputTokens: 16, lowEffort: false }, false),
    });
    await response.body?.cancel();
  },
};
