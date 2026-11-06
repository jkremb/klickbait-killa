import { CARD_SELECTOR, readCard, type CardInfo } from "../youtube/page";
import type { Settings } from "../shared/settings";
import type { JobView } from "../shared/types";
import { client } from "./client";
import { applyTheme, createHost } from "./ui";
import { SummaryView } from "./view";

const TRIGGER_LABEL = "Summarize";

/**
 * A single button and popover float above the page in the addon's own layer, so no YouTube element
 * is changed and reused cards can't show a stale button.
 */
export class FeedUi {
  private readonly host: HTMLElement;
  private readonly trigger = document.createElement("button");
  private readonly popover = document.createElement("div");
  private readonly view: SummaryView;
  private active: CardInfo | undefined;
  private popoverAnchor: Element | undefined;
  private popoverVideoId: string | undefined;
  private returnFocus: HTMLElement | undefined;

  constructor(private settings: Settings) {
    const { host, root } = createHost();
    this.host = host;

    this.trigger.className = "trigger hover-trigger";
    this.trigger.type = "button";
    this.trigger.hidden = true;
    this.trigger.textContent = TRIGGER_LABEL;
    this.trigger.setAttribute("aria-keyshortcuts", "Alt+Shift+K");
    this.trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.active) this.openPopover(this.active);
    });

    this.view = new SummaryView((videoId, seconds) => {
      window.open(`https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`, "_blank", "noopener");
    });

    this.popover.className = "popover";
    this.popover.hidden = true;
    this.popover.tabIndex = -1;
    this.popover.setAttribute("role", "dialog");
    this.popover.setAttribute("aria-label", "Klickbait Killa summary");
    const titleRow = document.createElement("div");
    titleRow.className = "title-row";
    const brand = document.createElement("span");
    brand.className = "brand";
    brand.textContent = "Klickbait Killa";
    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.closePopover());
    titleRow.append(brand, close);
    this.popover.append(titleRow, this.view.element);
    this.popover.style.display = "none";
    root.append(this.trigger, this.popover);
    document.documentElement.append(host);

    document.addEventListener("mouseover", (e) => this.onHover(e), { passive: true });
    document.addEventListener("focusin", (e) => this.onHover(e), { passive: true });
    document.addEventListener("keydown", (e) => this.onKey(e));
    document.addEventListener("mousedown", (e) => this.onOutsideClick(e));
    window.addEventListener("scroll", () => this.reposition(), { passive: true, capture: true });
    window.addEventListener("resize", () => this.reposition(), { passive: true });
    client.onAnyUpdate((view) => this.onStatus(view));
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    if (!settings.feedEnabled) {
      this.hideTrigger();
      this.closePopover();
    }
  }

  onNavigate(): void {
    this.hideTrigger();
    this.closePopover();
  }

  private isEligible(card: CardInfo): boolean {
    return (
      this.settings.feedEnabled &&
      card.durationSeconds !== undefined &&
      card.durationSeconds >= this.settings.minFeedMinutes * 60
    );
  }

  private onHover(event: Event): void {
    const target = event.target;
    // Events from our own layer are retargeted to the host.
    if (target === this.host) return;
    if (!(target instanceof Element)) return;
    if (!target.closest(CARD_SELECTOR)) {
      // YouTube's hover preview covers the thumbnail from outside the card, so check the position too.
      if (!this.pointerStillOverActive(event)) this.hideTrigger();
      return;
    }
    // Read fresh on every interaction, as YouTube reuses card elements.
    const card = readCard(target);
    if (!card || !this.isEligible(card)) {
      this.hideTrigger();
      return;
    }
    const changed = this.active?.videoId !== card.videoId;
    this.active = card;
    if (changed) {
      applyTheme(this.host);
      this.setTriggerState("idle");
      client.send({ t: "status", videoId: card.videoId });
    }
    this.positionTrigger();
  }

  private pointerStillOverActive(event: Event): boolean {
    if (!this.active || !(event instanceof MouseEvent)) return false;
    const { clientX: x, clientY: y } = event;
    return [this.active.card, this.active.thumbnail].some((element) => {
      const rect = element.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    });
  }

  private hideTrigger(): void {
    this.active = undefined;
    this.trigger.hidden = true;
  }

  private positionTrigger(): void {
    if (!this.active) return;
    const rect = this.active.thumbnail.getBoundingClientRect();
    if (rect.width === 0) {
      this.trigger.hidden = true;
      return;
    }
    this.trigger.style.left = `${rect.left + 8}px`;
    this.trigger.style.top = `${rect.top + 8}px`;
    this.trigger.hidden = false;
  }

  private onStatus(view: JobView): void {
    if (view.videoId !== this.active?.videoId) return;
    const working = ["queued", "fetching", "streaming", "needs_unlock", "needs_confirmation"].includes(view.status);
    this.setTriggerState(working ? "working" : view.status === "done" ? "ready" : "idle");
  }

  private setTriggerState(state: "idle" | "working" | "ready"): void {
    this.trigger.dataset["state"] = state;
    this.trigger.textContent = state === "working" ? "Working…" : state === "ready" ? "Summary " : TRIGGER_LABEL;
  }

  private openPopover(card: CardInfo): void {
    this.closePopover();
    applyTheme(this.host);
    this.popoverAnchor = card.thumbnail;
    this.popoverVideoId = card.videoId;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.popover.hidden = false;
    this.popover.style.display = "block";
    this.view.open(card.videoId, true);
    this.reposition();
    this.popover.focus();
  }

  private closePopover(): void {
    if (!this.popoverVideoId) return;
    this.view.close();
    this.popoverVideoId = undefined;
    this.popoverAnchor = undefined;
    this.popover.hidden = true;
    this.popover.style.display = "none";
    this.returnFocus?.focus({ preventScroll: true });
    this.returnFocus = undefined;
  }

  /** Keeps the popover on screen, flipping to the other side of the thumbnail when needed. */
  private reposition(): void {
    this.positionTrigger();
    if (!this.popoverAnchor) return;
    const anchor = this.popoverAnchor.getBoundingClientRect();
    const box = this.popover.getBoundingClientRect();
    const margin = 8;
    const fitsRight = anchor.right + margin + box.width <= window.innerWidth;
    const left = fitsRight ? anchor.right + margin : Math.max(margin, anchor.left - margin - box.width);
    const top = Math.min(Math.max(margin, anchor.top), window.innerHeight - box.height - margin);
    this.popover.style.left = `${left}px`;
    this.popover.style.top = `${Math.max(margin, top)}px`;
  }

  private onKey(event: KeyboardEvent): void {
    if (event.key === "Escape" && this.popoverVideoId) {
      this.closePopover();
    } else if (event.altKey && event.shiftKey && event.code === "KeyK" && this.active) {
      event.preventDefault();
      this.openPopover(this.active);
    }
  }

  private onOutsideClick(event: MouseEvent): void {
    if (this.popoverVideoId && event.target !== this.host) this.closePopover();
  }
}
