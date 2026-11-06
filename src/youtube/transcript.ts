// Everything that depends on YouTube's undocumented data formats lives in this folder.
//
// Legal hard limits (SPEC section 4): never generate attestation tokens, imitate YouTube's apps,
// play a video, or fetch anything before a user click.

import { AddonFailure } from "../shared/errors";
import type { TranscriptResult, VideoInfo } from "../shared/types";

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}

export interface Cue {
  seconds: number;
  text: string;
}

interface PlayerResponse {
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
    isLive?: boolean;
    isUpcoming?: boolean;
  };
  playabilityStatus?: { status?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      audioTracks?: { defaultCaptionTrackIndex?: number }[];
    };
  };
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const WATCH_ORIGIN = "https://www.youtube.com";
const BLOCK_SECONDS = 30;

/** Extracts the JSON object starting at the first `{` after `marker`, without running any page code. */
export function extractJsonAfter(html: string, marker: string): unknown {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const start = html.indexOf("{", markerIndex + marker.length);
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/** Fails with a specific reason if the video's transcript can't be obtained. */
export function checkAvailability(player: PlayerResponse): void {
  const status = player.playabilityStatus?.status;
  if (player.videoDetails?.isLive || player.videoDetails?.isUpcoming || status === "LIVE_STREAM_OFFLINE") {
    throw new AddonFailure({ code: "NOT_AVAILABLE_YET" });
  }
  if (status && status !== "OK") {
    throw new AddonFailure({ code: "RESTRICTED", step: `playability:${status}` });
  }
  if (!player.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length) {
    throw new AddonFailure({ code: "NO_CAPTIONS" });
  }
}

function sameLanguage(a: string, b: string): boolean {
  return a.split("-")[0]!.toLowerCase() === b.split("-")[0]!.toLowerCase();
}

export function guessOriginalLanguage(player: PlayerResponse): string | undefined {
  const list = player.captions?.playerCaptionsTracklistRenderer;
  const tracks = list?.captionTracks ?? [];
  const auto = tracks.find((t) => t.kind === "asr");
  if (auto) return auto.languageCode;
  const index = list?.audioTracks?.[0]?.defaultCaptionTrackIndex;
  return (index !== undefined ? tracks[index]?.languageCode : undefined) ?? tracks[0]?.languageCode;
}

/** SPEC section 4 order: manual original, manual summary language, other manual, auto original, other auto. */
export function selectTrack(
  tracks: CaptionTrack[],
  summaryLanguage: string,
  originalLanguage: string | undefined,
): CaptionTrack | undefined {
  const manual = tracks.filter((t) => t.kind !== "asr");
  const auto = tracks.filter((t) => t.kind === "asr");
  const matches = (language?: string) => (t: CaptionTrack) => !!language && sameLanguage(t.languageCode, language);
  return (
    manual.find(matches(originalLanguage)) ??
    manual.find(matches(summaryLanguage)) ??
    manual[0] ??
    auto.find(matches(originalLanguage)) ??
    auto[0]
  );
}

/** The panel's params are a small protobuf: { 165: { 1: videoId, 3: 2 } }. Video IDs are always 11 characters. */
export function buildPanelParams(videoId: string): string {
  const id = Array.from(new TextEncoder().encode(videoId));
  const inner = [0x0a, id.length, ...id, 0x18, 0x02];
  return btoa(String.fromCharCode(0xaa, 0x09, inner.length, ...inner));
}

export function parseTimestamp(value: string): number | undefined {
  if (!/^\d+(:\d{1,2}){1,2}$/.test(value.trim())) return undefined;
  return value
    .trim()
    .split(":")
    .reduce((total, part) => total * 60 + Number(part), 0);
}

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.floor(totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/** Finds transcript segments anywhere in a panel response, so wrapper changes don't break parsing. */
export function parsePanelResponse(json: unknown): Cue[] {
  const cues: Cue[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    const segment = record["transcriptSegmentViewModel"] as { simpleText?: string; timestamp?: string } | undefined;
    if (segment) {
      const seconds = parseTimestamp(segment.timestamp ?? "");
      if (seconds !== undefined && segment.simpleText) cues.push({ seconds, text: segment.simpleText });
      return;
    }
    for (const value of Object.values(record)) walk(value);
  };
  // Metadata lives under other top-level keys and contains no segments worth walking.
  walk((json as { content?: unknown } | undefined)?.content);
  return cues;
}

export function parseTimedText(body: string): Cue[] {
  if (!body.trim()) return [];
  const data = JSON.parse(body) as { events?: { tStartMs?: number; segs?: { utf8?: string }[] }[] };
  return (data.events ?? []).flatMap((event) => {
    const text = (event.segs ?? []).map((s) => s.utf8 ?? "").join("");
    return text.trim() ? [{ seconds: (event.tStartMs ?? 0) / 1000, text }] : [];
  });
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'", nbsp: " " };

function cleanCueText(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Merges cues into roughly 30-second blocks and drops repeats left by rolling captions. */
export function normalizeCues(cues: Cue[]): string {
  const blocks: { seconds: number; parts: string[] }[] = [];
  let previous = "";
  for (const cue of cues) {
    const text = cleanCueText(cue.text);
    if (!text || text === previous) continue;
    previous = text;
    const current = blocks[blocks.length - 1];
    if (current && cue.seconds - current.seconds < BLOCK_SECONDS) current.parts.push(text);
    else blocks.push({ seconds: cue.seconds, parts: [text] });
  }
  return blocks.map((b) => `[${formatTimestamp(b.seconds)}] ${b.parts.join(" ")}`).join("\n");
}

interface ClientContext {
  client?: { clientVersion?: string; hl?: string; clientName?: string };
}

async function fetchFromPanel(
  videoId: string,
  language: string,
  context: ClientContext,
  fetcher: Fetcher,
): Promise<Cue[]> {
  const body = {
    context: { ...context, client: { ...context.client, hl: language } },
    panelId: "PAmodern_transcript_view",
    params: buildPanelParams(videoId),
  };
  const response = await fetcher(`${WATCH_ORIGIN}/youtubei/v1/get_panel?prettyPrint=false`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-youtube-client-name": "1",
      "x-youtube-client-version": context.client?.clientVersion ?? "",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) return [];
  return parsePanelResponse(await response.json());
}

/** Returns cues only if the URL works as provided. There is deliberately no token handling. */
async function fetchFromCaptionUrl(track: CaptionTrack, fetcher: Fetcher): Promise<Cue[]> {
  const response = await fetcher(`${track.baseUrl}&fmt=json3`);
  if (!response.ok) return [];
  return parseTimedText(await response.text());
}

export interface TranscriptOptions {
  summaryLanguage: string;
  fetcher: Fetcher;
  /** Last-resort route that reads the transcript panel in the current page. */
  readFromPage?: () => Promise<Cue[]>;
}

export async function fetchTranscript(videoId: string, options: TranscriptOptions): Promise<TranscriptResult> {
  const { fetcher, summaryLanguage, readFromPage } = options;
  let html: string;
  try {
    html = await (await fetcher(`${WATCH_ORIGIN}/watch?v=${encodeURIComponent(videoId)}`)).text();
  } catch {
    throw new AddonFailure({ code: "YOUTUBE_CHANGED", step: "watch_page_fetch" });
  }

  const player = extractJsonAfter(html, "ytInitialPlayerResponse = ") as PlayerResponse | undefined;
  if (!player) throw new AddonFailure({ code: "YOUTUBE_CHANGED", step: "player_response_missing" });
  checkAvailability(player);

  const details = player.videoDetails;
  const video: VideoInfo = {
    id: videoId,
    title: details?.title ?? "",
    channel: details?.author ?? "",
    durationSeconds: Number(details?.lengthSeconds ?? 0),
  };

  const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const track = selectTrack(tracks, summaryLanguage, guessOriginalLanguage(player));
  if (!track) throw new AddonFailure({ code: "NO_CAPTIONS" });

  const context = extractJsonAfter(html, '"INNERTUBE_CONTEXT":') as ClientContext | undefined;
  const routes: [string, () => Promise<Cue[]>][] = [
    ["get_panel", async () => (context ? fetchFromPanel(videoId, track.languageCode, context, fetcher) : [])],
    ["caption_url", () => fetchFromCaptionUrl(track, fetcher)],
    ...(readFromPage ? ([["page_panel", readFromPage]] as [string, () => Promise<Cue[]>][]) : []),
  ];

  const failed: string[] = [];
  for (const [name, route] of routes) {
    try {
      const transcript = normalizeCues(await route());
      if (transcript) return { video, transcript };
    } catch {
      // Fall through to the next route; the final error reports which ones were tried.
    }
    failed.push(name);
  }
  throw new AddonFailure({ code: "YOUTUBE_CHANGED", step: `routes_failed:${failed.join(",")}` });
}
