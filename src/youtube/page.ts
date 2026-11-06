// Reads from YouTube's live page. Selectors live here so a redesign needs fixing in one place.

import type { Cue, Fetcher } from "./transcript";
import { parseTimestamp } from "./transcript";

export const CARD_SELECTOR = "ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model";
const SHORTS_SELECTOR = "ytm-shorts-lockup-view-model, ytd-reel-item-renderer, ytd-rich-shelf-renderer[is-shorts]";
const DURATION_SELECTOR = "yt-thumbnail-badge-view-model badge-shape, ytd-thumbnail-overlay-time-status-renderer badge-shape, ytd-thumbnail-overlay-time-status-renderer";

/**
 * Firefox's `content.fetch` sends a normal same-origin request from the page.
 * The plain `fetch` in a content script would run with the addon's privileges instead.
 */
export const pageFetch: Fetcher = (url, init) => {
  const contentFetch = (globalThis as unknown as { content?: { fetch: Fetcher } }).content?.fetch;
  return contentFetch ? contentFetch(url, init) : fetch(url, init);
};

export function videoIdFromHref(href: string | null): string | undefined {
  if (!href) return undefined;
  try {
    const url = new URL(href, "https://www.youtube.com");
    if (url.pathname !== "/watch") return undefined;
    const id = url.searchParams.get("v");
    return id && /^[\w-]{11}$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export interface CardInfo {
  card: Element;
  videoId: string;
  thumbnail: Element;
  durationSeconds: number | undefined;
}

/** Reads the card at interaction time, because YouTube reuses card elements for different videos. */
export function readCard(target: Element): CardInfo | undefined {
  const card = target.closest(CARD_SELECTOR);
  if (!card || card.closest(SHORTS_SELECTOR)) return undefined;
  const link = Array.from(card.querySelectorAll("a[href]")).find((a) =>
    a.querySelector("img, yt-image, yt-thumbnail-view-model") && videoIdFromHref(a.getAttribute("href")),
  );
  const videoId = videoIdFromHref(link?.getAttribute("href") ?? null);
  if (!link || !videoId) return undefined;
  const badges = Array.from(card.querySelectorAll(DURATION_SELECTOR));
  const durationSeconds = badges.map((b) => parseTimestamp(b.textContent ?? "")).find((v) => v !== undefined);
  return { card, videoId, thumbnail: link, durationSeconds };
}

export function currentWatchVideoId(): string | undefined {
  if (location.pathname !== "/watch") return undefined;
  return videoIdFromHref(location.pathname + location.search);
}

export function seekPlayer(seconds: number): boolean {
  const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
  if (!video) return false;
  video.currentTime = seconds;
  return true;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Last-resort route. Opens the transcript panel, exactly as a click on YouTube's own button would. */
export async function readTranscriptFromPage(videoId: string): Promise<Cue[]> {
  if (currentWatchVideoId() !== videoId) return [];
  document.querySelector<HTMLElement>("#description-inline-expander #expand")?.click();
  await delay(300);
  const button = document.querySelector<HTMLElement>("ytd-video-description-transcript-section-renderer button");
  if (!button) return [];
  button.click();
  for (let i = 0; i < 20; i++) {
    await delay(400);
    const segments = document.querySelectorAll("transcript-segment-view-model, ytd-transcript-segment-renderer");
    if (segments.length) return Array.from(segments).flatMap(readSegment);
  }
  return [];
}

function readSegment(segment: Element): Cue[] {
  const raw = (segment as HTMLElement).innerText ?? segment.textContent ?? "";
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const stampIndex = lines.findIndex((l) => parseTimestamp(l) !== undefined);
  if (stampIndex < 0) return [];
  const seconds = parseTimestamp(lines[stampIndex]!)!;
  // The line after a timestamp may be its spoken label ("18 seconds"); the caption is the last line.
  const text = lines[lines.length - 1]!;
  return stampIndex === lines.length - 1 ? [] : [{ seconds, text }];
}
