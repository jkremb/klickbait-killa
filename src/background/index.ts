import { anthropic } from "../providers/anthropic";
import { gemini } from "../providers/gemini";
import { openai } from "../providers/openai";
import type { Provider } from "../providers/types";
import { AddonFailure } from "../shared/errors";
import { MIN_PASSPHRASE_LENGTH } from "../shared/config";
import { loadSettings } from "../shared/settings";
import type { PageRequest, PageResponse, ProviderId, ToBackground, ToContent } from "../shared/types";
import { cacheKey, summaryCache } from "./cache";
import { JobManager, type Client } from "./jobs";
import { vaultStore } from "./vault";

const PROVIDERS: Record<ProviderId, Provider> = { anthropic, openai, gemini };
const PROVIDER_ORIGINS: Record<ProviderId, string> = {
  anthropic: "https://api.anthropic.com/*",
  openai: "https://api.openai.com/*",
  gemini: "https://generativelanguage.googleapis.com/*",
};

// Firefox can unload an idle event page, which would end a running stream.
// Calling an extension API regularly keeps it alive only while jobs are running.
const KEEP_ALIVE_MS = 20_000;
let keepAlive: ReturnType<typeof setInterval> | undefined;
function updateKeepAlive(active: number): void {
  if (active > 0 && keepAlive === undefined) {
    keepAlive = setInterval(() => void browser.runtime.getPlatformInfo(), KEEP_ALIVE_MS);
  } else if (active === 0 && keepAlive !== undefined) {
    clearInterval(keepAlive);
    keepAlive = undefined;
  }
}

const jobs = new JobManager({
  loadSettings,
  browserLanguage: () => browser.i18n.getUILanguage(),
  unlockedKeys: () => vaultStore.unlockedKeys(),
  hasPermission: (provider) => browser.permissions.contains({ origins: [PROVIDER_ORIGINS[provider]] }),
  provider: (id) => PROVIDERS[id],
  cacheKey,
  cacheGet: (key, days) => summaryCache.get(key, days),
  cachePut: (key, entry, days) => summaryCache.put(key, entry, days),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onActiveChange: updateKeepAlive,
});

function openExtensionPage(page: "options" | "welcome" | "unlock_window"): void {
  if (page === "options") {
    void browser.runtime.openOptionsPage();
  } else if (page === "welcome") {
    void browser.tabs.create({ url: browser.runtime.getURL("pages/welcome.html") });
  } else {
    void browser.windows.create({
      url: browser.runtime.getURL("pages/unlock.html?window=1"),
      type: "popup",
      width: 420,
      height: 320,
    });
  }
}

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "klickbait") return;
  const client: Client = {
    send(message: ToContent) {
      try {
        port.postMessage(message);
      } catch {
        // The tab has gone; onDisconnect cleans up.
      }
    },
  };
  port.onMessage.addListener((raw) => {
    const message = raw as ToBackground;
    if (message.t === "open_page") openExtensionPage(message.page);
    else void jobs.handle(client, message);
  });
  port.onDisconnect.addListener(() => jobs.disconnect(client));
});

async function handlePageRequest(request: PageRequest): Promise<PageResponse> {
  switch (request.t) {
    case "test_key":
      await PROVIDERS[request.provider].testKey(request.key, request.model);
      return { ok: true };
    case "create_vault":
      if (request.passphrase.length < MIN_PASSPHRASE_LENGTH) return { ok: false, reason: "passphrase_too_short" };
      await vaultStore.create(request.keys, request.passphrase);
      return { ok: true };
    case "save_key": {
      const keys = await vaultStore.open(request.passphrase);
      if (!keys) return { ok: false, reason: "wrong_passphrase" };
      await vaultStore.create({ ...keys, [request.provider]: request.key }, request.passphrase);
      await jobs.onUnlocked();
      return { ok: true };
    }
    case "unlock": {
      if (!(await vaultStore.unlock(request.passphrase))) return { ok: false, reason: "wrong_passphrase" };
      await jobs.onUnlocked();
      return { ok: true };
    }
    case "lock":
      await vaultStore.lock();
      return { ok: true };
    case "lock_state":
      return { ok: true, unlocked: !!(await vaultStore.unlockedKeys()), hasVault: await vaultStore.hasVault() };
    case "change_passphrase": {
      if (request.next.length < MIN_PASSPHRASE_LENGTH) return { ok: false, reason: "passphrase_too_short" };
      const keys = await vaultStore.open(request.current);
      if (!keys) return { ok: false, reason: "wrong_passphrase" };
      await vaultStore.create(keys, request.next);
      return { ok: true };
    }
    case "full_reset":
      await browser.storage.local.clear();
      await browser.storage.session.clear();
      openExtensionPage("welcome");
      return { ok: true };
    case "cache_stats": {
      const entries = await summaryCache.all();
      return { ok: true, entries: Object.keys(entries).length, bytes: JSON.stringify(entries).length };
    }
    case "cache_clear":
      await summaryCache.clear();
      return { ok: true };
  }
}

browser.runtime.onMessage.addListener((raw: unknown, sender: browser.runtime.MessageSender) => {
  // Only the addon's own pages may use these. Content scripts report YouTube's URL here.
  if (!sender.url?.startsWith(browser.runtime.getURL(""))) return undefined;
  return handlePageRequest(raw as PageRequest).catch((error: unknown): PageResponse => {
    if (error instanceof AddonFailure) return { ok: false, error: error.detail };
    return { ok: false, error: { code: "NETWORK", step: "page_request" } };
  });
});

browser.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === "install" && !(await loadSettings()).setupComplete) openExtensionPage("welcome");
});

browser.action.onClicked.addListener(() => {
  void browser.runtime.openOptionsPage();
});
