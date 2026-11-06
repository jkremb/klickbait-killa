import { findModel, MODELS, PRICES_CHECKED } from "../background/pricing";
import { DONATE_URL, ISSUES_URL } from "../shared/config";
import { loadSettings, saveSettings, type Settings } from "../shared/settings";
import type { DetailLevel, ProviderId } from "../shared/types";
import { byId, callBackground, failureText, PROVIDER_IDS, PROVIDER_INFO } from "./common";

const LANGUAGES = ["en", "de", "es", "fr", "it", "nl", "pl", "pt", "sv", "tr", "uk", "ru", "ar", "hi", "id", "ja", "ko", "zh"];

const providerSelect = byId<HTMLSelectElement>("provider");
const modelSelect = byId<HTMLSelectElement>("model");
const customModel = byId<HTMLInputElement>("custom-model");
const language = byId<HTMLSelectElement>("language");
const detail = byId<HTMLSelectElement>("detail");
const instructions = byId<HTMLTextAreaElement>("instructions");
const feed = byId<HTMLInputElement>("feed");
const minLength = byId<HTMLInputElement>("min-length");
const costLimit = byId<HTMLInputElement>("cost-limit");
const cacheDays = byId<HTMLInputElement>("cache-days");

let settings: Settings;

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function setMessage(id: string, text: string, ok: boolean): void {
  const node = byId(id);
  node.textContent = text;
  node.className = ok ? "success" : "error";
}

let savedTimer: ReturnType<typeof setTimeout> | undefined;
async function save(patch: Partial<Settings>): Promise<void> {
  settings = await saveSettings(patch);
  const saved = byId("saved");
  saved.textContent = "Saved";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (saved.textContent = ""), 1500);
}

function selectedModel(): string {
  return settings.models[settings.provider];
}

function renderProvider(): void {
  const provider = settings.provider;
  const info = PROVIDER_INFO[provider];
  providerSelect.value = provider;
  byId("data-note").textContent = info.dataNote;
  byId<HTMLAnchorElement>("key-link").href = info.keyUrl;

  const models = MODELS.filter((m) => m.provider === provider);
  modelSelect.replaceChildren(
    ...models.map((m) => option(m.id, `${m.label}${m.recommended ? " (recommended, low cost)" : ""}`)),
  );
  const current = selectedModel();
  const known = models.some((m) => m.id === current);
  if (known) modelSelect.value = current;
  customModel.value = known ? "" : current;

  const model = findModel(current);
  byId("price").textContent = model
    ? `$${model.input} input and $${model.output} output per million tokens (estimate).`
    : "Prices aren't known for custom models, so the addon warns by size instead.";
  void renderPermission();
}

async function renderPermission(): Promise<void> {
  const granted = await browser.permissions.contains({ origins: [PROVIDER_INFO[settings.provider].origin] });
  byId("permission-box").hidden = granted;
}

async function renderStats(): Promise<void> {
  const stats = await callBackground({ t: "cache_stats" });
  if (stats.ok) {
    const kilobytes = Math.ceil((stats.bytes ?? 0) / 1024);
    byId("cache-stats").textContent = `${stats.entries ?? 0} saved, using about ${kilobytes} KB. Stored unencrypted on this device.`;
  }
}

async function renderLock(): Promise<void> {
  const state = await callBackground({ t: "lock_state" });
  if (state.ok) {
    byId("lock-state").textContent = !state.hasVault
      ? "No API key is stored yet."
      : state.unlocked
        ? "Unlocked until you close Firefox."
        : "Locked. You'll be asked for your passphrase when a summary needs it.";
    byId<HTMLButtonElement>("lock").disabled = !state.unlocked;
  }
}

function fill(): void {
  renderProvider();
  language.value = settings.language;
  detail.value = settings.detail;
  instructions.value = settings.customInstructions;
  feed.checked = settings.feedEnabled;
  minLength.value = String(settings.minFeedMinutes);
  costLimit.value = String(settings.costLimit);
  cacheDays.value = String(settings.cacheDays);
}

function numberValue(input: HTMLInputElement, fallback: number): number {
  const value = Number(input.value);
  return input.value !== "" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function bind(): void {
  providerSelect.addEventListener("change", () => {
    void save({ provider: providerSelect.value as ProviderId }).then(renderProvider);
  });
  modelSelect.addEventListener("change", () => {
    void save({ models: { ...settings.models, [settings.provider]: modelSelect.value } }).then(renderProvider);
  });
  customModel.addEventListener("change", () => {
    const id = customModel.value.trim() || MODELS.find((m) => m.provider === settings.provider && m.recommended)!.id;
    void save({ models: { ...settings.models, [settings.provider]: id } }).then(renderProvider);
  });
  byId("grant").addEventListener("click", () => {
    void browser.permissions.request({ origins: [PROVIDER_INFO[settings.provider].origin] }).then(renderPermission);
  });
  language.addEventListener("change", () => void save({ language: language.value }));
  detail.addEventListener("change", () => void save({ detail: detail.value as DetailLevel }));
  instructions.addEventListener("change", () => void save({ customInstructions: instructions.value }));
  feed.addEventListener("change", () => void save({ feedEnabled: feed.checked }));
  minLength.addEventListener("change", () => void save({ minFeedMinutes: numberValue(minLength, settings.minFeedMinutes) }));
  costLimit.addEventListener("change", () => void save({ costLimit: numberValue(costLimit, settings.costLimit) }));
  cacheDays.addEventListener("change", () => void save({ cacheDays: Math.max(1, numberValue(cacheDays, settings.cacheDays)) }));

  byId("save-key").addEventListener("click", () => {
    void (async () => {
      const key = byId<HTMLInputElement>("new-key").value.trim();
      const passphrase = byId<HTMLInputElement>("key-pass").value;
      if (!key) return setMessage("key-message", "Paste your API key first.", false);
      setMessage("key-message", "Testing…", true);
      const test = await callBackground({ t: "test_key", provider: settings.provider, key, model: selectedModel() });
      if (!test.ok) return setMessage("key-message", failureText(test), false);
      const saved = await callBackground({ t: "save_key", provider: settings.provider, key, passphrase });
      if (!saved.ok) return setMessage("key-message", failureText(saved), false);
      byId<HTMLInputElement>("new-key").value = "";
      byId<HTMLInputElement>("key-pass").value = "";
      setMessage("key-message", "Key saved.", true);
      await renderLock();
    })();
  });

  byId("lock").addEventListener("click", () => void callBackground({ t: "lock" }).then(renderLock));

  byId("change-pass").addEventListener("click", () => {
    void (async () => {
      const current = byId<HTMLInputElement>("current-pass");
      const nextPass = byId<HTMLInputElement>("next-pass");
      const response = await callBackground({ t: "change_passphrase", current: current.value, next: nextPass.value });
      if (!response.ok) return setMessage("pass-message", failureText(response), false);
      current.value = "";
      nextPass.value = "";
      setMessage("pass-message", "Passphrase changed.", true);
      await renderLock();
    })();
  });

  byId("clear-cache").addEventListener("click", () => {
    if (confirm("Delete all saved summaries?")) void callBackground({ t: "cache_clear" }).then(renderStats);
  });

  byId("full-reset").addEventListener("click", () => {
    const ok = confirm(
      "This permanently deletes your API keys, settings and saved summaries, then restarts setup. Continue?",
    );
    if (ok) void callBackground({ t: "full_reset" }).then(() => window.close());
  });
}

function renderAbout(): void {
  byId("version").textContent = browser.runtime.getManifest().version;
  byId("prices-date").textContent = PRICES_CHECKED;
  const links = byId("links");
  for (const [label, url] of [["Report an issue", ISSUES_URL], ["Support this project", DONATE_URL]] as const) {
    if (!url) continue;
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = label;
    links.append(link, document.createTextNode("  "));
  }
}

async function start(): Promise<void> {
  settings = await loadSettings();
  providerSelect.append(...PROVIDER_IDS.map((id) => option(id, PROVIDER_INFO[id].name)));
  const names = new Intl.DisplayNames(["en"], { type: "language" });
  language.append(option("auto", "Same as Firefox"), ...LANGUAGES.map((code) => option(code, names.of(code) ?? code)));
  fill();
  bind();
  renderAbout();
  await Promise.all([renderStats(), renderLock()]);
}

void start();
