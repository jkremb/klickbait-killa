import { ISSUES_URL } from "../shared/config";
import { describeError, type ErrorAction } from "../shared/errors";
import type { AddonError, JobView } from "../shared/types";
import { client } from "./client";
import { parseSummary, renderSummary } from "./render";

function button(label: string, onClick: () => void, className = ""): HTMLButtonElement {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function formatCost(cost: number): string {
  return cost < 0.01 ? "under $0.01" : `about $${cost.toFixed(2)}`;
}

function issueUrl(error: AddonError): string | undefined {
  if (!ISSUES_URL) return undefined;
  const version = browser.runtime.getManifest().version;
  const body = [
    `Addon version: ${version}`,
    `Browser: ${navigator.userAgent}`,
    `Error: ${error.code}`,
    `Step: ${error.step ?? "unknown"}`,
    "",
    "What happened:",
  ].join("\n");
  return `${ISSUES_URL}/new?title=${encodeURIComponent(`Error: ${error.code}`)}&body=${encodeURIComponent(body)}`;
}

const STATUS_TEXT: Partial<Record<JobView["status"], string>> = {
  queued: "Queued",
  fetching: "Reading the transcript…",
};

/** Displays one video's summary. Used by both the watch-page panel and the feed popover. */
export class SummaryView {
  readonly element = document.createElement("div");
  private readonly status = document.createElement("div");
  private readonly body = document.createElement("div");
  private readonly actions = document.createElement("div");
  private unsubscribe: (() => void) | undefined;
  private videoId: string | undefined;
  private view: JobView | undefined;
  private renderScheduled = false;
  private unlockFrame: HTMLElement | undefined;

  constructor(private readonly onSeek: (videoId: string, seconds: number) => void) {
    this.element.className = "view";
    this.status.className = "status";
    this.status.setAttribute("role", "status");
    this.body.className = "body";
    this.body.setAttribute("aria-live", "polite");
    this.actions.className = "actions";
    this.element.append(this.status, this.body, this.actions);
  }

  /** Shows a video's current state. Starts a summary when `start` is set. */
  open(videoId: string, start: boolean): void {
    this.close();
    this.videoId = videoId;
    this.unsubscribe = client.subscribe(videoId, (view) => this.onUpdate(view));
    client.send(start ? { t: "request", videoId } : { t: "status", videoId });
  }

  /** Stops displaying the video. A running job continues and stays cached. */
  close(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.videoId) client.send({ t: "detach", videoId: this.videoId });
    this.videoId = undefined;
    this.view = undefined;
    this.unlockFrame = undefined;
    this.status.textContent = "";
    this.body.replaceChildren();
    this.actions.replaceChildren();
  }

  private onUpdate(view: JobView): void {
    this.view = view;
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      if (this.view) this.render(this.view);
    });
  }

  private render(view: JobView): void {
    this.status.classList.remove("error");
    if (view.status === "needs_unlock") {
      this.renderUnlock();
      return;
    }
    this.unlockFrame = undefined;

    if (view.status === "needs_confirmation" && view.confirm) {
      this.renderConfirm(view);
      return;
    }

    this.status.textContent = STATUS_TEXT[view.status] ?? (view.status === "streaming" && !view.text ? "Summarizing…" : "");
    if (view.text) {
      renderSummary(this.body, parseSummary(view.text, view.durationSeconds ?? 0), (s) => this.onSeek(view.videoId, s));
    } else {
      this.body.replaceChildren();
    }

    this.actions.replaceChildren();
    switch (view.status) {
      case "queued":
      case "fetching":
      case "streaming":
        this.actions.append(button("Stop", () => client.send({ t: "stop", videoId: view.videoId })));
        break;
      case "done":
        this.renderDoneActions(view);
        break;
      case "failed":
        this.renderError(view);
        break;
      case "cancelled":
        this.status.textContent = "Stopped.";
        this.body.replaceChildren();
        this.actions.append(this.retryButton(view, "Summarize"));
        break;
      case "idle":
        this.actions.append(this.retryButton(view, "Summarize"));
        break;
    }
  }

  private retryButton(view: JobView, label: string): HTMLButtonElement {
    return button(label, () => client.send({ t: "request", videoId: view.videoId }), "primary");
  }

  private renderDoneActions(view: JobView): void {
    if (view.summarizedAt) {
      this.status.textContent = `Summarized on ${new Date(view.summarizedAt).toLocaleDateString()}`;
    }
    const copy = button("Copy", () => {
      void navigator.clipboard.writeText(view.text).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      });
    });
    this.actions.append(
      copy,
      button("Regenerate", () => client.send({ t: "request", videoId: view.videoId, regenerate: true })),
      Object.assign(document.createElement("span"), {
        className: "note",
        textContent: "AI summary of the transcript. It may contain mistakes.",
      }),
    );
  }

  private renderError(view: JobView): void {
    const error = view.error ?? { code: "PROVIDER_ERROR" as const };
    const { message, actions } = describeError(error);
    this.status.textContent = view.text ? `Incomplete. ${message}` : message;
    this.status.classList.add("error");
    const factories: Record<ErrorAction, () => HTMLElement | undefined> = {
      retry: () => this.retryButton(view, "Retry"),
      settings: () => button("Open settings", () => client.send({ t: "open_page", page: "options" })),
      setup: () => button("Finish setup", () => client.send({ t: "open_page", page: "welcome" }), "primary"),
      open_video: () => button("Open video", () => window.open(`https://www.youtube.com/watch?v=${view.videoId}`, "_blank", "noopener")),
      report: () => {
        const url = issueUrl(error);
        return url ? button("Report issue", () => window.open(url, "_blank", "noopener")) : undefined;
      },
    };
    for (const action of actions) {
      const node = factories[action]();
      if (node) this.actions.append(node);
    }
  }

  private renderConfirm(view: JobView): void {
    const { estimatedTokens, estimatedCost } = view.confirm!;
    const size = `about ${estimatedTokens.toLocaleString()} tokens`;
    this.status.textContent =
      estimatedCost === undefined
        ? `This summary needs ${size}. Its cost isn't known for this model.`
        : `This summary needs ${size}, estimated at ${formatCost(estimatedCost)}.`;
    this.body.replaceChildren();
    this.actions.replaceChildren(
      button("Continue", () => client.send({ t: "confirm", videoId: view.videoId }), "primary"),
      button("Cancel", () => client.send({ t: "stop", videoId: view.videoId })),
    );
  }

  /** The passphrase field is in an extension frame, so YouTube's page scripts can't observe typing. */
  private renderUnlock(): void {
    if (this.unlockFrame) return;
    this.status.textContent = "";
    const frame = document.createElement("iframe");
    frame.className = "unlock";
    frame.title = "Unlock Klickbait Killa";
    frame.src = browser.runtime.getURL("pages/unlock.html");
    this.unlockFrame = frame;
    this.body.replaceChildren(frame);
    this.actions.replaceChildren(
      button("Open in a window instead", () => client.send({ t: "open_page", page: "unlock_window" })),
    );
  }
}
