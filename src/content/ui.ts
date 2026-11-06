import css from "./styles.css";

/** Creates one of the addon's own Shadow DOM hosts. Nothing belonging to YouTube is changed. */
export function createHost(): { host: HTMLElement; root: ShadowRoot } {
  const host = document.createElement("klickbait-killa");
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = css;
  root.append(style);
  applyTheme(host);
  return { host, root };
}

export function applyTheme(host: HTMLElement): void {
  host.dataset["theme"] = document.documentElement.hasAttribute("dark") ? "dark" : "light";
}
