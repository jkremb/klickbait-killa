import { AddonFailure } from "../shared/errors";
import type { AddonError, ErrorCode, ProviderId } from "../shared/types";

export interface SummaryRequest {
  model: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  /** Provider-specific low-effort setting, used only for models known to support it. */
  lowEffort: boolean;
}

export interface Provider {
  id: ProviderId;
  stream(req: SummaryRequest, key: string, signal: AbortSignal): AsyncIterable<string>;
  /** Makes a minimal request and throws an AddonFailure if the key or model doesn't work. */
  testKey(key: string, model: string): Promise<void>;
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Parses a server-sent event stream, handling events split across network chunks. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];

  const consumeLine = (line: string): SseEvent | undefined => {
    if (line === "") {
      const complete = data.length ? { event, data: data.join("\n") } : undefined;
      event = undefined;
      data = [];
      return complete;
    }
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    return undefined;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      // Streaming mode keeps a multi-byte character intact when it's split across chunks.
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const complete = consumeLine(line);
        if (complete) yield complete;
      }
    }
    if (buffer) consumeLine(buffer);
    const last = consumeLine("");
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

/** Maps an HTTP error to an addon error, using provider error text to separate similar statuses. */
export async function errorFromResponse(response: Response, provider: ProviderId): Promise<AddonFailure> {
  const body = (await response.text().catch(() => "")).toLowerCase();
  const retryAfter = Number(response.headers.get("retry-after"));
  const fail = (code: ErrorCode, extra: Partial<AddonError> = {}) =>
    new AddonFailure({ code, provider, step: `http_${response.status}`, ...extra });

  const mentions = (...words: string[]) => words.some((w) => body.includes(w));
  if (mentions("credit balance", "insufficient_quota", "billing", "exceeded your current quota")) return fail("NO_CREDITS");
  if (mentions("prompt is too long", "context_length", "maximum context", "input token count", "too many tokens")) {
    return fail("TOO_LONG");
  }
  switch (response.status) {
    case 401:
    case 403:
      return fail("INVALID_KEY");
    case 400:
      if (mentions("api key not valid", "api_key_invalid", "invalid api key")) return fail("INVALID_KEY");
      if (mentions("model")) return fail("MODEL_NOT_FOUND");
      return fail("PROVIDER_ERROR");
    case 402:
      return fail("NO_CREDITS");
    case 404:
      return fail("MODEL_NOT_FOUND");
    case 429:
    case 503:
    case 529:
      return fail("RATE_LIMITED", Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {});
    default:
      return fail("PROVIDER_ERROR");
  }
}

/** Wraps fetch so connection failures surface as a typed error, while aborts pass through. */
export async function providerFetch(provider: ProviderId, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if ((error as Error).name === "AbortError") throw error;
    throw new AddonFailure({ code: "NETWORK", provider, step: "fetch" });
  }
  if (!response.ok) throw await errorFromResponse(response, provider);
  if (!response.body) throw new AddonFailure({ code: "PROVIDER_ERROR", provider, step: "empty_body" });
  return response;
}
