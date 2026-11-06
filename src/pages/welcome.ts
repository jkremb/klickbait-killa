import { findModel } from "../background/pricing";
import { MIN_PASSPHRASE_LENGTH } from "../shared/config";
import { DEFAULT_SETTINGS, saveSettings } from "../shared/settings";
import type { ProviderId } from "../shared/types";
import { byId, callBackground, failureText, PROVIDER_IDS, PROVIDER_INFO } from "./common";

const STEPS = ["intro", "provider", "key", "consent", "passphrase", "done"] as const;
type Step = (typeof STEPS)[number];

let index = 0;
let provider: ProviderId = "gemini";
let keyTested = false;

const steps = Array.from(document.querySelectorAll<HTMLElement>(".step"));
const next = byId<HTMLButtonElement>("next");
const back = byId<HTMLButtonElement>("back");
const keyInput = byId<HTMLInputElement>("key");
const keyMessage = byId("key-message");
const consent = byId<HTMLInputElement>("consent");
const passMessage = byId("pass-message");

function current(): Step {
  return STEPS[index]!;
}

function render(): void {
  for (const step of steps) step.hidden = step.dataset["step"] !== current();
  byId("progress").textContent = current() === "done" ? "" : `Step ${index + 1} of ${STEPS.length - 1}`;
  back.hidden = index === 0 || current() === "done";
  next.hidden = current() === "done";
  next.textContent = current() === "passphrase" ? "Finish setup" : "Continue";
  next.disabled =
    (current() === "key" && !keyTested) || (current() === "consent" && !consent.checked);

  const info = PROVIDER_INFO[provider];
  byId<HTMLAnchorElement>("key-link").href = info.keyUrl;
  byId("provider-data-note").textContent = info.dataNote;
  for (const node of document.querySelectorAll(".provider-name")) node.textContent = info.name;
}

function renderProviders(): void {
  const box = byId("providers");
  for (const id of PROVIDER_IDS) {
    const info = PROVIDER_INFO[id];
    const label = document.createElement("label");
    label.className = "choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "provider";
    input.checked = id === provider;
    input.addEventListener("change", () => {
      provider = id;
      keyTested = false;
      keyMessage.textContent = "";
    });
    const model = findModel(DEFAULT_SETTINGS.models[id]);
    const name = document.createElement("strong");
    name.textContent = info.name;
    const note = document.createElement("div");
    note.className = "muted";
    note.textContent = `${info.summary} Default model: ${model?.label ?? DEFAULT_SETTINGS.models[id]}.`;
    label.append(input, name);
    if (info.recommended) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = "Recommended";
      label.append(tag);
    }
    label.append(note);
    box.append(label);
  }
}

async function testKey(): Promise<void> {
  const key = keyInput.value.trim();
  if (!key) {
    keyMessage.textContent = "Paste your API key first.";
    keyMessage.className = "error";
    return;
  }
  keyMessage.textContent = "Testing…";
  keyMessage.className = "muted";
  const response = await callBackground({ t: "test_key", provider, key, model: DEFAULT_SETTINGS.models[provider] });
  keyTested = response.ok;
  keyMessage.textContent = response.ok ? "That key works." : failureText(response);
  keyMessage.className = response.ok ? "success" : "error";
  render();
}

async function finish(): Promise<boolean> {
  const pass1 = byId<HTMLInputElement>("pass1").value;
  const pass2 = byId<HTMLInputElement>("pass2").value;
  passMessage.textContent = "";
  if (pass1.length < MIN_PASSPHRASE_LENGTH) {
    passMessage.textContent = `Use at least ${MIN_PASSPHRASE_LENGTH} characters.`;
    return false;
  }
  if (pass1 !== pass2) {
    passMessage.textContent = "The passphrases don't match.";
    return false;
  }
  next.disabled = true;
  const response = await callBackground({
    t: "create_vault",
    keys: { [provider]: keyInput.value.trim() },
    passphrase: pass1,
  });
  if (!response.ok) {
    passMessage.textContent = failureText(response);
    next.disabled = false;
    return false;
  }
  await saveSettings({ setupComplete: true, provider });
  byId<HTMLInputElement>("pass1").value = "";
  byId<HTMLInputElement>("pass2").value = "";
  keyInput.value = "";
  return true;
}

next.addEventListener("click", () => {
  void (async () => {
    if (current() === "provider") {
      // Must be requested directly in the click handler for Firefox to show the prompt.
      const granted = await browser.permissions.request({
        origins: [PROVIDER_INFO[provider].origin, "https://www.youtube.com/*"],
      });
      byId("provider-message").textContent = granted
        ? ""
        : "The addon can't contact your provider without this permission.";
      if (!granted) return;
    }
    if (current() === "passphrase" && !(await finish())) return;
    index = Math.min(index + 1, STEPS.length - 1);
    render();
  })();
});

back.addEventListener("click", () => {
  index = Math.max(index - 1, 0);
  render();
});

byId("test-key").addEventListener("click", () => void testKey());
keyInput.addEventListener("input", () => {
  keyTested = false;
  keyMessage.textContent = "";
  render();
});
consent.addEventListener("change", render);

renderProviders();
render();
