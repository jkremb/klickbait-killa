import { AddonFailure } from "../shared/errors";
import type { JobView, ToBackground, ToContent } from "../shared/types";
import { fetchTranscript } from "../youtube/transcript";
import { pageFetch, readTranscriptFromPage } from "../youtube/page";

type Listener = (view: JobView) => void;

/** The tab's connection to the background script. Reconnects if Firefox unloaded the background page. */
class BackgroundClient {
  private port: browser.runtime.Port | undefined;
  private readonly views = new Map<string, JobView>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly statusListeners = new Set<Listener>();

  private connect(): browser.runtime.Port {
    if (this.port) return this.port;
    const port = browser.runtime.connect({ name: "klickbait" });
    port.onMessage.addListener((message) => this.onMessage(message as ToContent));
    port.onDisconnect.addListener(() => {
      this.port = undefined;
      // Any job still in progress died with the background page.
      for (const view of this.views.values()) {
        if (["queued", "fetching", "streaming"].includes(view.status)) {
          this.emit({ ...view, status: "failed", error: { code: "BACKGROUND_RESTARTED" } });
        }
      }
    });
    this.port = port;
    return port;
  }

  send(message: ToBackground): void {
    this.connect().postMessage(message);
  }

  /** Subscribes to a video's updates and returns a function that unsubscribes. */
  subscribe(videoId: string, listener: Listener): () => void {
    const set = this.listeners.get(videoId) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(videoId, set);
    return () => set.delete(listener);
  }

  onAnyUpdate(listener: Listener): void {
    this.statusListeners.add(listener);
  }

  private emit(view: JobView): void {
    this.views.set(view.videoId, view);
    for (const listener of this.listeners.get(view.videoId) ?? []) listener(view);
    for (const listener of this.statusListeners) listener(view);
  }

  private onMessage(message: ToContent): void {
    switch (message.t) {
      case "update":
        this.emit(message.view);
        break;
      case "delta": {
        const view = this.views.get(message.videoId);
        if (view) this.emit({ ...view, text: view.text + message.text });
        break;
      }
      case "fetch_transcript":
        void this.fetchAndSubmit(message.videoId, message.summaryLanguage);
        break;
    }
  }

  private async fetchAndSubmit(videoId: string, summaryLanguage: string): Promise<void> {
    try {
      const result = await fetchTranscript(videoId, {
        summaryLanguage,
        fetcher: pageFetch,
        readFromPage: () => readTranscriptFromPage(videoId),
      });
      this.send({ t: "transcript", videoId, result });
    } catch (error) {
      this.send({
        t: "transcript_error",
        videoId,
        error: error instanceof AddonFailure ? error.detail : { code: "YOUTUBE_CHANGED", step: "unexpected" },
      });
    }
  }
}

export const client = new BackgroundClient();
