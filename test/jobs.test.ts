import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheEntry } from "../src/background/cache";
import { JobManager, type Client, type JobDeps } from "../src/background/jobs";
import { AddonFailure } from "../src/shared/errors";
import { DEFAULT_SETTINGS, type Settings } from "../src/shared/settings";
import type { JobView, ToContent, TranscriptResult } from "../src/shared/types";

const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

class TestClient implements Client {
  messages: ToContent[] = [];
  send(message: ToContent) {
    this.messages.push(message);
  }
  lastView(videoId: string): JobView | undefined {
    const updates = this.messages.flatMap((m) => (m.t === "update" && m.view.videoId === videoId ? [m.view] : []));
    return updates[updates.length - 1];
  }
  fetchRequests(): string[] {
    return this.messages.flatMap((m) => (m.t === "fetch_transcript" ? [m.videoId] : []));
  }
  deltas(videoId: string): string {
    return this.messages.flatMap((m) => (m.t === "delta" && m.videoId === videoId ? [m.text] : [])).join("");
  }
}

const result = (videoId: string, transcript = "[0:00] hi"): TranscriptResult => ({
  video: { id: videoId, title: "T", channel: "C", durationSeconds: 100 },
  transcript,
});

/** A provider whose streams the test controls. */
function controllableStream() {
  const pending: { emit: (text: string) => void; finish: () => void; fail: (e: unknown) => void; signal: AbortSignal }[] = [];
  const stream = (_req: unknown, _key: string, signal: AbortSignal) => (async function* () {
    const queue: string[] = [];
    let wake = () => {};
    let done = false;
    let failure: unknown;
    pending.push({
      emit: (t) => { queue.push(t); wake(); },
      finish: () => { done = true; wake(); },
      fail: (e) => { failure = e; wake(); },
      signal,
    });
    signal.addEventListener("abort", () => { failure = new DOMException("aborted", "AbortError"); wake(); });
    for (;;) {
      if (failure) throw failure;
      if (queue.length) { yield queue.shift()!; continue; }
      if (done) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  })();
  return { stream, pending };
}

let settings: Settings;
let keys: Record<string, string> | undefined;
let cache: Map<string, CacheEntry>;
let streams: ReturnType<typeof controllableStream>;
let deps: JobDeps;
let manager: JobManager;
let client: TestClient;

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS, setupComplete: true };
  keys = { anthropic: "k" };
  cache = new Map();
  streams = controllableStream();
  deps = {
    loadSettings: async () => settings,
    browserLanguage: () => "en",
    unlockedKeys: async () => keys,
    hasPermission: async () => true,
    provider: () => ({ id: "anthropic", stream: streams.stream, testKey: async () => {} }),
    cacheKey: async (i) => `${i.videoId}|${i.model}|${i.detail}`,
    cacheGet: async (key) => cache.get(key),
    cachePut: async (key, entry) => void cache.set(key, entry),
    sleep: async () => {},
  };
  manager = new JobManager(deps);
  client = new TestClient();
});

async function start(videoId: string, c = client) {
  await manager.handle(c, { t: "request", videoId });
  await flush();
}
async function supply(videoId: string, transcript?: string) {
  await manager.handle(client, { t: "transcript", videoId, result: result(videoId, transcript) });
  await flush();
}

describe("JobManager", () => {
  it("runs the full flow and caches the result", async () => {
    await start("a");
    expect(client.fetchRequests()).toEqual(["a"]);
    await supply("a");
    expect(client.lastView("a")?.status).toBe("streaming");
    streams.pending[0]!.emit("Hello");
    streams.pending[0]!.finish();
    await flush();
    expect(client.deltas("a")).toBe("Hello");
    expect(client.lastView("a")?.status).toBe("done");
    expect(cache.get("a|claude-haiku-5-5|standard")?.text).toBe("Hello");
  });

  it("serves the cache without fetching, and Regenerate bypasses it", async () => {
    cache.set("a|claude-haiku-5-5|standard", { videoId: "a", text: "old", title: "T", channel: "C", durationSeconds: 1, createdAt: 5 });
    await start("a");
    expect(client.fetchRequests()).toEqual([]);
    expect(client.lastView("a")).toMatchObject({ status: "done", text: "old", summarizedAt: 5 });
    await manager.handle(client, { t: "request", videoId: "a", regenerate: true });
    await flush();
    expect(client.fetchRequests()).toEqual(["a"]);
  });

  it("asks new users to finish setup", async () => {
    settings.setupComplete = false;
    await start("a");
    expect(client.lastView("a")?.error?.code).toBe("NEEDS_SETUP");
  });

  it("runs at most 3 jobs at once and queues the rest in order", async () => {
    for (const id of ["a", "b", "c", "d", "e"]) await start(id);
    expect(client.fetchRequests()).toEqual(["a", "b", "c"]);
    expect(client.lastView("d")?.status).toBe("queued");
    await manager.handle(client, { t: "stop", videoId: "a" });
    await flush();
    expect(client.fetchRequests()).toEqual(["a", "b", "c", "d"]);
  });

  it("joins an existing job instead of paying twice", async () => {
    const other = new TestClient();
    await start("a");
    await start("a", other);
    expect(client.fetchRequests()).toEqual(["a"]);
    await supply("a");
    streams.pending[0]!.emit("x");
    await flush();
    expect(streams.pending).toHaveLength(1);
    expect(other.deltas("a")).toBe("x");
  });

  it("waits for unlock and resumes without refetching", async () => {
    keys = undefined;
    await start("a");
    await supply("a");
    expect(client.lastView("a")?.status).toBe("needs_unlock");
    expect(streams.pending).toHaveLength(0);
    keys = { anthropic: "k" };
    await manager.onUnlocked();
    await flush();
    expect(client.lastView("a")?.status).toBe("streaming");
    expect(client.fetchRequests()).toEqual(["a"]);
  });

  it("waiting jobs don't block other videos", async () => {
    keys = undefined;
    for (const id of ["a", "b", "c"]) {
      await start(id);
      await supply(id);
    }
    await start("d");
    expect(client.fetchRequests()).toContain("d");
  });

  it("asks for confirmation above the limit and spends nothing until confirmed", async () => {
    settings.costLimit = 0.0000001;
    await start("a");
    await supply("a");
    expect(client.lastView("a")?.status).toBe("needs_confirmation");
    expect(client.lastView("a")?.confirm?.estimatedCost).toBeGreaterThan(0);
    expect(streams.pending).toHaveLength(0);
    await manager.handle(client, { t: "confirm", videoId: "a" });
    await flush();
    expect(client.lastView("a")?.status).toBe("streaming");
  });

  it("drops unattended waiting jobs with no spending", async () => {
    settings.costLimit = 0.0000001;
    await start("a");
    await supply("a");
    await manager.handle(client, { t: "detach", videoId: "a" });
    await manager.handle(client, { t: "status", videoId: "a" });
    await flush();
    expect(client.lastView("a")?.status).toBe("idle");
    expect(streams.pending).toHaveLength(0);
  });

  it("finishes and caches in the background after the view closes or the tab goes", async () => {
    await start("a");
    await supply("a");
    streams.pending[0]!.emit("par");
    await manager.handle(client, { t: "detach", videoId: "a" });
    manager.disconnect(client);
    streams.pending[0]!.emit("tial");
    streams.pending[0]!.finish();
    await flush();
    expect(cache.get("a|claude-haiku-5-5|standard")?.text).toBe("partial");
  });

  it("drops a job if its tab closes before the transcript arrives", async () => {
    await start("a");
    manager.disconnect(client);
    const next = new TestClient();
    await start("a", next);
    expect(next.fetchRequests()).toEqual(["a"]);
  });

  it("Stop aborts the request and doesn't cache partial text", async () => {
    await start("a");
    await supply("a");
    streams.pending[0]!.emit("par");
    await flush();
    await manager.handle(client, { t: "stop", videoId: "a" });
    await flush();
    expect(streams.pending[0]!.signal.aborted).toBe(true);
    expect(client.lastView("a")?.status).toBe("cancelled");
    expect(cache.size).toBe(0);
  });

  it("keeps partial text on failure, without caching it", async () => {
    await start("a");
    await supply("a");
    streams.pending[0]!.emit("par");
    await flush();
    streams.pending[0]!.fail(new AddonFailure({ code: "NETWORK", provider: "anthropic" }));
    await flush();
    expect(client.lastView("a")).toMatchObject({ status: "failed", text: "par", error: { code: "NETWORK" } });
    expect(cache.size).toBe(0);
  });

  it("retries once when busy, honoring Retry-After, only before text appears", async () => {
    const sleep = vi.fn(async () => {});
    deps.sleep = sleep;
    await start("a");
    await supply("a");
    streams.pending[0]!.fail(new AddonFailure({ code: "RATE_LIMITED", retryAfterSeconds: 7 }));
    await flush();
    expect(sleep).toHaveBeenCalledWith(7000);
    expect(streams.pending).toHaveLength(2);
    streams.pending[1]!.fail(new AddonFailure({ code: "RATE_LIMITED" }));
    await flush();
    expect(client.lastView("a")?.error?.code).toBe("RATE_LIMITED");
    expect(streams.pending).toHaveLength(2);
  });

  it("doesn't retry after text has appeared, or for a long Retry-After", async () => {
    await start("a");
    await supply("a");
    streams.pending[0]!.emit("x");
    await flush();
    streams.pending[0]!.fail(new AddonFailure({ code: "RATE_LIMITED" }));
    await flush();
    expect(streams.pending).toHaveLength(1);

    await start("b");
    await supply("b");
    streams.pending[1]!.fail(new AddonFailure({ code: "RATE_LIMITED", retryAfterSeconds: 600 }));
    await flush();
    expect(streams.pending).toHaveLength(2);
  });

  it("reports missing permission and missing key clearly", async () => {
    deps.hasPermission = async () => false;
    await start("a");
    await supply("a");
    expect(client.lastView("a")?.error?.code).toBe("PERMISSION_MISSING");

    deps.hasPermission = async () => true;
    keys = { openai: "other" };
    await start("b");
    await supply("b");
    expect(client.lastView("b")?.error?.code).toBe("INVALID_KEY");
  });

  it("passes YouTube failures to the view without calling the provider", async () => {
    await start("a");
    await manager.handle(client, { t: "transcript_error", videoId: "a", error: { code: "NO_CAPTIONS" } });
    expect(client.lastView("a")?.error?.code).toBe("NO_CAPTIONS");
    expect(streams.pending).toHaveLength(0);
  });

  it("reports running jobs so the background page can stay alive", async () => {
    const counts: number[] = [];
    deps.onActiveChange = (n) => counts.push(n);
    await start("a");
    await supply("a");
    expect(counts[counts.length - 1]).toBe(1);
    streams.pending[0]!.finish();
    await flush();
    expect(counts[counts.length - 1]).toBe(0);
  });
});
