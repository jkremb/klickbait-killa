import { AddonFailure } from "../shared/errors";
import { parseSse, providerFetch, type Provider, type SummaryRequest } from "./types";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// The key goes in a header so it never appears in a URL.
function headers(key: string): Record<string, string> {
  return { "content-type": "application/json", "x-goog-api-key": key };
}

function body(req: SummaryRequest): string {
  return JSON.stringify({
    system_instruction: { parts: [{ text: req.system }] },
    contents: [{ role: "user", parts: [{ text: req.user }] }],
    generationConfig: { maxOutputTokens: req.maxOutputTokens },
  });
}

interface StreamData {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

const BLOCKED = new Set(["SAFETY", "RECITATION", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "LANGUAGE", "OTHER"]);

export const gemini: Provider = {
  id: "gemini",

  async *stream(req, key, signal) {
    const url = `${BASE}/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
    const response = await providerFetch("gemini", url, {
      method: "POST",
      headers: headers(key),
      body: body(req),
      signal,
    });
    let finished = false;
    for await (const { data } of parseSse(response.body!)) {
      const parsed = JSON.parse(data) as StreamData;
      if (parsed.promptFeedback?.blockReason) throw new AddonFailure({ code: "REFUSED", provider: "gemini" });
      const candidate = parsed.candidates?.[0];
      for (const part of candidate?.content?.parts ?? []) {
        if (part.text && !part.thought) yield part.text;
      }
      const reason = candidate?.finishReason;
      if (reason === "STOP") finished = true;
      else if (reason === "MAX_TOKENS") throw new AddonFailure({ code: "TRUNCATED", provider: "gemini" });
      else if (reason && BLOCKED.has(reason)) throw new AddonFailure({ code: "REFUSED", provider: "gemini" });
    }
    if (!finished) throw new AddonFailure({ code: "NETWORK", provider: "gemini", step: "stream_ended_early" });
  },

  async testKey(key, model) {
    const url = `${BASE}/${encodeURIComponent(model)}:generateContent`;
    const response = await providerFetch("gemini", url, {
      method: "POST",
      headers: headers(key),
      body: body({ model, system: "Reply with OK.", user: "OK?", maxOutputTokens: 16, lowEffort: false }),
    });
    await response.body?.cancel();
  },
};
