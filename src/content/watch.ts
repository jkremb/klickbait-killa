import { currentWatchVideoId, seekPlayer } from "../youtube/page";
import { applyTheme, createHost } from "./ui";
import { SummaryView } from "./view";

const ACTIONS_ROW = "ytd-watch-metadata #top-row";
const SIDE_COLUMN = "#secondary-inner";
const BELOW_VIDEO = "ytd-watch-metadata";

/** The watch page's button and panel. Both are the addon's own elements added beside YouTube's. */
export class WatchUi {
  private readonly buttonHost: HTMLElement;
  private readonly panelHost: HTMLElement;
  private readonly panel = document.createElement("div");
  private readonly view: SummaryView;
  private videoId: string | undefined;
  private panelOpen = false;
  private observer: MutationObserver | undefined;

  constructor() {
    const buttonParts = createHost();
    this.buttonHost = buttonParts.host;
    this.buttonHost.style.cssText = "display:block;flex:none;align-self:center;margin:12px 0 0 12px;";
    const trigger = document.createElement("button");
    trigger.className = "trigger";
    trigger.type = "button";
    trigger.textContent = "Summarize";
    trigger.setAttribute("aria-keyshortcuts", "Alt+Shift+K");
    trigger.addEventListener("click", () => this.openPanel());
    buttonParts.root.append(trigger);

    const panelParts = createHost();
    this.panelHost = panelParts.host;
    this.panelHost.style.display = "block";
    this.view = new SummaryView((videoId, seconds) => {
      if (videoId !== currentWatchVideoId() || !seekPlayer(seconds)) {
        window.open(`https://www.youtube.com/watch?v=${videoId}&t=${seconds}s`, "_blank", "noopener");
      }
    });
    this.panel.className = "panel";
    const row = document.createElement("div");
    row.className = "title-row";
    const brand = document.createElement("span");
    brand.className = "brand";
    brand.textContent = "Klickbait Killa";
    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.closePanel());
    row.append(brand, close);
    this.panel.append(row, this.view.element);
    panelParts.root.append(this.panel);

    document.addEventListener("keydown", (event) => {
      if (event.altKey && event.shiftKey && event.code === "KeyK" && this.videoId) {
        event.preventDefault();
        this.openPanel();
      }
    });
    window.addEventListener("resize", () => this.placePanel(), { passive: true });
  }

  /** Runs on every YouTube navigation. A running job continues in the background. */
  onNavigate(): void {
    const next = currentWatchVideoId();
    if (next === this.videoId) return;
    this.closePanel();
    this.videoId = next;
    this.observer?.disconnect();
    this.observer = undefined;
    if (!next) {
      this.buttonHost.remove();
      return;
    }
    this.placeButton();
  }

  /** YouTube builds and rebuilds this area after navigation, so keep the button attached. */
  private placeButton(): void {
    const tryPlace = () => {
      const row = document.querySelector(ACTIONS_ROW);
      const actions = row?.querySelector(":scope > #actions");
      if (!row || !actions) return;
      applyTheme(this.buttonHost);
      if (this.buttonHost.nextElementSibling !== actions) row.insertBefore(this.buttonHost, actions);
    };
    tryPlace();
    this.observer = new MutationObserver(tryPlace);
    const watch = document.querySelector("ytd-watch-flexy") ?? document.body;
    this.observer.observe(watch, { childList: true, subtree: true });
  }

  private openPanel(): void {
    if (!this.videoId) return;
    applyTheme(this.panelHost);
    this.panelOpen = true;
    this.placePanel();
    this.view.open(this.videoId, true);
    this.panelHost.scrollIntoView({ block: "nearest" });
  }

  private closePanel(): void {
    if (!this.panelOpen) return;
    this.panelOpen = false;
    this.view.close();
    this.panelHost.remove();
  }

  /** Uses the side column when it's visible, otherwise goes below the video details. */
  private placePanel(): void {
    if (!this.panelOpen) return;
    const side = document.querySelector<HTMLElement>(SIDE_COLUMN);
    if (side && side.getBoundingClientRect().width > 0 && !document.querySelector("ytd-watch-flexy[theater]")) {
      if (this.panelHost.parentElement !== side) side.prepend(this.panelHost);
      return;
    }
    const below = document.querySelector(BELOW_VIDEO);
    if (below && this.panelHost.previousElementSibling !== below) below.after(this.panelHost);
  }
}
