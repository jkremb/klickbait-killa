// Turns model output into DOM nodes using only createElement and textContent.
// Model output is untrusted: it never becomes HTML, a link or an image.
// The only clickable items are timestamps, which the addon constructs after validating them.

import { parseTimestamp } from "../youtube/transcript";

export type Inline = { kind: "text"; text: string } | { kind: "time"; label: string; seconds: number };

export type Block =
  | { kind: "verdict"; rating: string }
  | { kind: "heading"; text: string }
  | { kind: "point"; parts: Inline[] }
  | { kind: "worth"; text: string }
  | { kind: "para"; parts: Inline[] };

/** Timestamps beyond the video's length are left as plain text. An unknown length (0) rejects all of them. */
export function parseInline(line: string, durationSeconds: number): Inline[] {
  const parts: Inline[] = [];
  let last = 0;
  for (const match of line.matchAll(/\[(\d{1,2}(?::\d{2}){1,2})\]/g)) {
    const seconds = parseTimestamp(match[1]!);
    if (seconds === undefined || seconds > durationSeconds) continue;
    if (match.index > last) parts.push({ kind: "text", text: line.slice(last, match.index) });
    parts.push({ kind: "time", label: match[1]!, seconds });
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push({ kind: "text", text: line.slice(last) });
  return parts;
}

function stripMarkup(line: string): string {
  return line.replace(/^#+\s*/, "").replace(/\*\*/g, "").trim();
}

/** Tolerates partial lines, because it re-parses the text as it streams. */
export function parseSummary(text: string, durationSeconds: number): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.split("\n")) {
    const line = stripMarkup(raw);
    if (!line) continue;
    const verdict = /^Verdict:\s*(.*)$/i.exec(line);
    const worth = /^Worth watching\?\s*(.*)$/i.exec(line);
    const bullet = /^[-*•]\s+(.*)$/.exec(line);
    if (verdict) blocks.push({ kind: "verdict", rating: verdict[1]! });
    else if (/^Key points:?$/i.test(line)) blocks.push({ kind: "heading", text: "Key points" });
    else if (worth) blocks.push({ kind: "worth", text: worth[1]! });
    else if (bullet) blocks.push({ kind: "point", parts: parseInline(bullet[1]!, durationSeconds) });
    else blocks.push({ kind: "para", parts: parseInline(line, durationSeconds) });
  }
  return blocks;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function appendInline(parent: HTMLElement, parts: Inline[], onSeek: (seconds: number) => void): void {
  for (const part of parts) {
    if (part.kind === "text") {
      parent.append(document.createTextNode(part.text));
    } else {
      const button = el("button", "time", part.label);
      button.type = "button";
      button.addEventListener("click", () => onSeek(part.seconds));
      parent.append(button);
    }
  }
}

function ratingClass(rating: string): string {
  const value = rating.toLowerCase();
  if (value.includes("skip it")) return "bad";
  if (value.includes("watch parts")) return "warn";
  if (value.includes("watch it")) return "good";
  return "";
}

export function renderSummary(container: HTMLElement, blocks: Block[], onSeek: (seconds: number) => void): void {
  container.replaceChildren();
  let list: HTMLUListElement | undefined;
  for (const block of blocks) {
    if (block.kind !== "point") list = undefined;
    switch (block.kind) {
      case "verdict":
        container.append(el("p", `verdict ${ratingClass(block.rating)}`, block.rating));
        break;
      case "heading":
        container.append(el("h3", "heading", block.text));
        break;
      case "point": {
        if (!list) {
          list = el("ul", "points");
          container.append(list);
        }
        const item = el("li", "");
        appendInline(item, block.parts, onSeek);
        list.append(item);
        break;
      }
      case "worth": {
        const paragraph = el("p", "worth");
        paragraph.append(el("strong", "", "Worth watching? "), document.createTextNode(block.text));
        container.append(paragraph);
        break;
      }
      case "para": {
        const paragraph = el("p", "para");
        appendInline(paragraph, block.parts, onSeek);
        container.append(paragraph);
        break;
      }
    }
  }
}
