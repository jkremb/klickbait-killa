import { byId, callBackground, failureText } from "./common";

const isWindow = new URLSearchParams(location.search).has("window");
if (!isWindow) document.body.classList.add("frame");

const form = byId<HTMLFormElement>("form");
const input = byId<HTMLInputElement>("passphrase");
const message = byId("message");
const submit = byId<HTMLButtonElement>("submit");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  submit.disabled = true;
  message.textContent = "";
  const response = await callBackground({ t: "unlock", passphrase: input.value });
  submit.disabled = false;
  if (!response.ok) {
    message.textContent = failureText(response);
    input.select();
    return;
  }
  input.value = "";
  form.hidden = true;
  byId("done").hidden = false;
  if (isWindow) window.close();
});

byId("forgot").addEventListener("click", (event) => {
  event.preventDefault();
  void browser.runtime.openOptionsPage();
});
