import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropic } from "../src/providers/anthropic";
import { gemini } from "../src/providers/gemini";
import { openai } from "../src/providers/openai";
import { parseSse, type Provider, type SummaryRequest } from "../src/providers/types";
import { AddonFailure } from "../src/shared/errors";

const request: SummaryRequest = { model: "m", system: "sys", user: "usr", maxOutputTokens: 100, lowEffort: true };

function sseResponse(...chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  );
}
const data = (obj: object) => `data: ${JSON.stringify(obj)}\n\n`;

async function run(provider: Provider, response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  const text: string[] = [];
  let code: string | undefined;
  try {
    for await (const t of provider.stream(request, "secret-key", new AbortController().signal)) text.push(t);
  } catch (error) {
    code = (error as AddonFailure).detail.code;
  }
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { text: text.join(""), code, url, init };
}

afterEach(() => vi.unstubAllGlobals());

describe("parseSse", () => {
  it("handles events split across chunks, CRLF and multi-line data", async () => {
    const events = [];
    for await (const e of parseSse(sseResponse("event: a\r\nda", "ta: 1\r\ndata: 2\r\n\r\ndata: last").body!)) events.push(e);
    expect(events).toEqual([{ event: "a", data: "1\n2" }, { event: undefined, data: "last" }]);
  });
  it("handles a character split across chunks", async () => {
    const bytes = new TextEncoder().encode("data: ü\n\n");
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 7));
        c.enqueue(bytes.slice(7));
        c.close();
      },
    });
    const events = [];
    for await (const e of parseSse(stream)) events.push(e);
    expect(events[0]?.data).toBe("ü");
  });
});

describe("anthropic", () => {
  const delta = (text: string) => data({ type: "content_block_delta", delta: { type: "text_delta", text } });
  it("streams text and sends the required headers", async () => {
    const r = await run(anthropic, sseResponse(data({ type: "message_start" }), delta("Hel"), delta("lo"), data({ type: "message_stop" })));
    expect(r.text).toBe("Hello");
    expect(r.code).toBeUndefined();
    const headers = r.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("secret-key");
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
    const body = JSON.parse(r.init.body as string);
    expect(body.stream).toBe(true);
    expect(body.output_config).toEqual({ effort: "low" });
  });
  it("ignores thinking deltas", async () => {
    const thinking = data({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: "secret" } });
    const r = await run(anthropic, sseResponse(thinking, delta("A"), data({ type: "message_stop" })));
    expect(r.text).toBe("A");
  });
  it("maps refusal, truncation, stream errors and early endings", async () => {
    expect((await run(anthropic, sseResponse(data({ type: "message_delta", delta: { stop_reason: "refusal" } })))).code).toBe("REFUSED");
    expect((await run(anthropic, sseResponse(data({ type: "message_delta", delta: { stop_reason: "max_tokens" } })))).code).toBe("TRUNCATED");
    expect((await run(anthropic, sseResponse(data({ type: "error", error: { type: "overloaded_error" } })))).code).toBe("RATE_LIMITED");
    const early = await run(anthropic, sseResponse(delta("par")));
    expect(early.code).toBe("NETWORK");
    expect(early.text).toBe("par");
  });
});

describe("openai", () => {
  it("streams text with a bearer token", async () => {
    const r = await run(openai, sseResponse(
      data({ type: "response.output_text.delta", delta: "Hi" }),
      data({ type: "response.completed", response: {} }),
    ));
    expect(r.text).toBe("Hi");
    expect((r.init.headers as Record<string, string>)["authorization"]).toBe("Bearer secret-key");
    expect(JSON.parse(r.init.body as string).store).toBe(false);
  });
  it("maps refusal, incomplete and failed events", async () => {
    expect((await run(openai, sseResponse(data({ type: "response.refusal.delta", delta: "no" })))).code).toBe("REFUSED");
    expect((await run(openai, sseResponse(data({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } })))).code).toBe("TRUNCATED");
    expect((await run(openai, sseResponse(data({ type: "response.failed", response: { error: { code: "server_error" } } })))).code).toBe("PROVIDER_ERROR");
  });
});

describe("gemini", () => {
  const part = (text: string, finishReason?: string, thought?: boolean) =>
    data({ candidates: [{ content: { parts: [{ text, thought }] }, finishReason }] });
  it("streams text, skips thoughts, and keeps the key out of the URL", async () => {
    const r = await run(gemini, sseResponse(part("hidden", undefined, true), part("A"), part("B", "STOP")));
    expect(r.text).toBe("AB");
    expect(r.url).not.toContain("secret-key");
    expect((r.init.headers as Record<string, string>)["x-goog-api-key"]).toBe("secret-key");
  });
  it("maps blocks and truncation", async () => {
    expect((await run(gemini, sseResponse(data({ promptFeedback: { blockReason: "SAFETY" } })))).code).toBe("REFUSED");
    expect((await run(gemini, sseResponse(part("A", "RECITATION")))).code).toBe("REFUSED");
    expect((await run(gemini, sseResponse(part("A", "MAX_TOKENS")))).code).toBe("TRUNCATED");
    expect((await run(gemini, sseResponse(part("A")))).code).toBe("NETWORK");
  });
});

describe("HTTP errors", () => {
  const status = async (code: number, body = "", headers: Record<string, string> = {}) =>
    (await run(anthropic, new Response(body, { status: code, headers }))).code;

  it("maps statuses and provider messages", async () => {
    expect(await status(401)).toBe("INVALID_KEY");
    expect(await status(404)).toBe("MODEL_NOT_FOUND");
    expect(await status(429)).toBe("RATE_LIMITED");
    expect(await status(529)).toBe("RATE_LIMITED");
    expect(await status(500)).toBe("PROVIDER_ERROR");
    expect(await status(400, "Your credit balance is too low")).toBe("NO_CREDITS");
    expect(await status(429, "You exceeded your current quota")).toBe("NO_CREDITS");
    expect(await status(400, "prompt is too long")).toBe("TOO_LONG");
    expect(await status(400, "API key not valid")).toBe("INVALID_KEY");
  });

  it("maps connection failures and never leaks the key into errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    const stream = anthropic.stream(request, "secret-key", new AbortController().signal);
    const error = await stream[Symbol.asyncIterator]().next().catch((e: AddonFailure) => e) as AddonFailure;
    expect(error.detail.code).toBe("NETWORK");
    expect(JSON.stringify(error.detail)).not.toContain("secret-key");
  });
});
