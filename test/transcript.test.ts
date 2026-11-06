import { describe, expect, it } from "vitest";
import { AddonFailure } from "../src/shared/errors";
import {
  buildPanelParams,
  checkAvailability,
  extractJsonAfter,
  fetchTranscript,
  normalizeCues,
  parsePanelResponse,
  parseTimedText,
  parseTimestamp,
  selectTrack,
  type Fetcher,
} from "../src/youtube/transcript";

// Synthetic data that mirrors the structure of real responses. No real captions are stored in the repo.
const segment = (timestamp: string, simpleText: string) => ({
  macroMarkersPanelItemViewModel: {
    item: { timelineItemViewModel: { contentItems: [{ transcriptSegmentViewModel: { timestamp, simpleText } }] } },
  },
});
const panel = (...segments: unknown[]) => ({
  responseContext: {},
  content: {
    engagementPanelSectionListRenderer: {
      content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: segments } }] } },
    },
  },
});

const player = (overrides: object = {}) => ({
  videoDetails: { title: "A title", author: "A channel", lengthSeconds: "600" },
  playabilityStatus: { status: "OK" },
  captions: {
    playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?v=x", languageCode: "en" }] },
  },
  ...overrides,
});
const page = (data: object) =>
  `<script>var ytInitialPlayerResponse = ${JSON.stringify(data)};var x = {};</script>
   <script>ytcfg.set({"INNERTUBE_CONTEXT":{"client":{"clientName":"WEB","clientVersion":"2.1"}},"OTHER":1});</script>`;

function mockFetcher(html: string, routes: { panel?: () => Response; caption?: () => Response }): Fetcher {
  return async (url) => {
    if (url.includes("/watch?v=")) return new Response(html);
    if (url.includes("get_panel")) return routes.panel?.() ?? new Response("{}", { status: 400 });
    return routes.caption?.() ?? new Response("");
  };
}

async function failure(promise: Promise<unknown>): Promise<AddonFailure> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AddonFailure);
  return error as AddonFailure;
}

describe("extractJsonAfter", () => {
  it("handles braces and quotes inside strings", () => {
    const html = `a = {"t":"} {\\" }","n":{"x":1}};b={}`;
    expect(extractJsonAfter(html, "a = ")).toEqual({ t: '} {" }', n: { x: 1 } });
  });
  it("returns undefined when absent or malformed", () => {
    expect(extractJsonAfter("nothing", "a = ")).toBeUndefined();
    expect(extractJsonAfter("a = {bad}", "a = ")).toBeUndefined();
  });
});

describe("buildPanelParams", () => {
  it("matches the value YouTube's site sends", () => {
    expect(buildPanelParams("dQw4w9WgXcQ")).toBe("qgkPCgtkUXc0dzlXZ1hjURgC");
  });
});

describe("parsePanelResponse", () => {
  it("reads segments, including multi-part timestamps", () => {
    expect(parsePanelResponse(panel(segment("0:18", "one"), segment("1:02:03", "two")))).toEqual([
      { seconds: 18, text: "one" },
      { seconds: 3723, text: "two" },
    ]);
  });
  it("returns nothing for an unexpected shape", () => {
    expect(parsePanelResponse({ responseContext: {} })).toEqual([]);
  });
});

describe("parseTimedText", () => {
  it("parses the JSON caption format and treats empty bodies as no data", () => {
    expect(parseTimedText(JSON.stringify({ events: [{ tStartMs: 1500, segs: [{ utf8: "hi " }, { utf8: "there" }] }, { tStartMs: 2000 }] }))).toEqual([
      { seconds: 1.5, text: "hi there" },
    ]);
    expect(parseTimedText("")).toEqual([]);
  });
});

describe("parseTimestamp", () => {
  it("rejects anything that isn't a timestamp", () => {
    expect(parseTimestamp("4K")).toBeUndefined();
    expect(parseTimestamp("LIVE")).toBeUndefined();
    expect(parseTimestamp("12:34")).toBe(754);
  });
});

describe("normalizeCues", () => {
  it("merges into roughly 30-second blocks, removes repeats and decodes entities", () => {
    const result = normalizeCues([
      { seconds: 0, text: "Tom &amp; Jerry" },
      { seconds: 5, text: "Tom &amp; Jerry" },
      { seconds: 10, text: "  next\n line " },
      { seconds: 40, text: "later" },
      { seconds: 3700, text: "much later" },
      { seconds: 3701, text: "   " },
    ]);
    expect(result).toBe("[0:00] Tom & Jerry next line\n[0:40] later\n[1:01:40] much later");
  });
});

describe("selectTrack", () => {
  const manual = (languageCode: string) => ({ baseUrl: "", languageCode });
  const auto = (languageCode: string) => ({ baseUrl: "", languageCode, kind: "asr" });

  it("follows the spec's order", () => {
    const pick = (tracks: Parameters<typeof selectTrack>[0]) => selectTrack(tracks, "de", "en")?.languageCode + (selectTrack(tracks, "de", "en")?.kind ?? "");
    expect(pick([manual("de"), manual("en-US"), auto("en")])).toBe("en-US");
    expect(pick([manual("fr"), manual("de"), auto("en")])).toBe("de");
    expect(pick([manual("fr"), auto("en")])).toBe("fr");
    expect(pick([auto("fr"), auto("en")])).toBe("enasr");
    expect(pick([auto("fr")])).toBe("frasr");
    expect(pick([])).toBe("undefined");
  });
});

describe("checkAvailability", () => {
  const code = (data: object) => {
    try {
      checkAvailability(data);
      return "ok";
    } catch (error) {
      return (error as AddonFailure).detail.code;
    }
  };
  it("classifies each failure", () => {
    expect(code(player())).toBe("ok");
    expect(code(player({ videoDetails: { isLive: true } }))).toBe("NOT_AVAILABLE_YET");
    expect(code(player({ videoDetails: { isUpcoming: true } }))).toBe("NOT_AVAILABLE_YET");
    expect(code(player({ playabilityStatus: { status: "LIVE_STREAM_OFFLINE" } }))).toBe("NOT_AVAILABLE_YET");
    expect(code(player({ playabilityStatus: { status: "LOGIN_REQUIRED" } }))).toBe("RESTRICTED");
    expect(code(player({ captions: undefined }))).toBe("NO_CAPTIONS");
  });
});

describe("fetchTranscript", () => {
  const options = (fetcher: Fetcher, extra = {}) => ({ summaryLanguage: "en", fetcher, ...extra });

  it("uses the panel route, sending the chosen language", async () => {
    let body: { context: { client: { hl: string } }; panelId: string } | undefined;
    const fetcher: Fetcher = async (url, init) => {
      if (url.includes("/watch")) return new Response(page(player()));
      body = JSON.parse(init!.body as string);
      return new Response(JSON.stringify(panel(segment("0:01", "hello"))));
    };
    const result = await fetchTranscript("abcdefghijk", options(fetcher));
    expect(result.transcript).toBe("[0:01] hello");
    expect(result.video).toEqual({ id: "abcdefghijk", title: "A title", channel: "A channel", durationSeconds: 600 });
    expect(body?.context.client.hl).toBe("en");
    expect(body?.panelId).toBe("PAmodern_transcript_view");
  });

  it("falls back to the caption URL, then the page", async () => {
    const caption = () => new Response(JSON.stringify({ events: [{ tStartMs: 0, segs: [{ utf8: "from url" }] }] }));
    const viaUrl = await fetchTranscript("abcdefghijk", options(mockFetcher(page(player()), { caption })));
    expect(viaUrl.transcript).toBe("[0:00] from url");

    const viaPage = await fetchTranscript("abcdefghijk", options(mockFetcher(page(player()), {}), {
      readFromPage: async () => [{ seconds: 3, text: "from page" }],
    }));
    expect(viaPage.transcript).toBe("[0:03] from page");
  });

  it("reports which routes failed, and treats thrown route errors as failures", async () => {
    const fetcher = mockFetcher(page(player()), { panel: () => { throw new Error("boom"); } });
    const error = await failure(fetchTranscript("abcdefghijk", options(fetcher)));
    expect(error.detail.code).toBe("YOUTUBE_CHANGED");
    expect(error.detail.step).toBe("routes_failed:get_panel,caption_url");
  });

  it("reports YOUTUBE_CHANGED when the page has no player data", async () => {
    const error = await failure(fetchTranscript("abcdefghijk", options(mockFetcher("<html></html>", {}))));
    expect(error.detail.step).toBe("player_response_missing");
  });

  it("never requests a transcript for an unavailable video", async () => {
    let calls = 0;
    const fetcher: Fetcher = async () => {
      calls++;
      return new Response(page(player({ captions: undefined })));
    };
    expect((await failure(fetchTranscript("abcdefghijk", options(fetcher)))).detail.code).toBe("NO_CAPTIONS");
    expect(calls).toBe(1);
  });
});
