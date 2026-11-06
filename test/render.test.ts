// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { parseInline, parseSummary, renderSummary } from "../src/content/render";

const SUMMARY = `Verdict: Title overstates
It only works in one case.

Key points
- [03:12] First point
- [1:02:03] Second point

Worth watching? Probably not.`;

describe("parseInline", () => {
  it("makes valid timestamps clickable and leaves invalid ones as text", () => {
    expect(parseInline("[01:00] ok [99:00] too late", 120)).toEqual([
      { kind: "time", label: "01:00", seconds: 60 },
      { kind: "text", text: " ok [99:00] too late" },
    ]);
  });
  it("makes nothing clickable when the length is unknown", () => {
    expect(parseInline("[01:00] x", 0)).toEqual([{ kind: "text", text: "[01:00] x" }]);
  });
});

describe("parseSummary", () => {
  it("parses each part of the format", () => {
    expect(parseSummary(SUMMARY, 4000).map((b) => b.kind)).toEqual(["verdict", "para", "heading", "point", "point", "worth"]);
  });
  it("tolerates partial text and stray markdown while streaming", () => {
    expect(parseSummary("**Verdict:** Title matches\n## Key points\n- [0:0", 100).map((b) => b.kind)).toEqual(["verdict", "heading", "point"]);
    expect(parseSummary("", 100)).toEqual([]);
  });
});

describe("renderSummary", () => {
  it("wires timestamps to seek and groups points in one list", () => {
    const container = document.createElement("div");
    const onSeek = vi.fn();
    renderSummary(container, parseSummary(SUMMARY, 4000), onSeek);
    expect(container.querySelectorAll("ul")).toHaveLength(1);
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector(".verdict")?.className).toContain("warn");
    (container.querySelector("button.time") as HTMLButtonElement).click();
    expect(onSeek).toHaveBeenCalledWith(192);
  });

  it("never turns model output into HTML, links or images", () => {
    const container = document.createElement("div");
    const hostile = `Verdict: <img src=x onerror=alert(1)>
<script>alert(1)</script>
- [Click here](https://evil.example) <a href="https://evil.example">link</a>
- ![pixel](https://evil.example/track.png)
Worth watching? <b>yes</b>`;
    renderSummary(container, parseSummary(hostile, 100), vi.fn());
    for (const selector of ["img", "script", "a", "b", "iframe"]) {
      expect(container.querySelector(selector)).toBeNull();
    }
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
