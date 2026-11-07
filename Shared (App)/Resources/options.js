const browserApi = globalThis.browser ?? globalThis.chrome;

const form = document.getElementById("options-form");
const baseUrlInput = document.getElementById("baseUrl");
const apiTokenInput = document.getElementById("apiToken");
const tagsInput = document.getElementById("tags");
const unreadDefaultInput = document.getElementById("unreadDefault");
const sharedDefaultInput = document.getElementById("sharedDefault");
const autoCloseInput = document.getElementById("autoCloseOnSuccess");
const statusEl = document.getElementById("status");

const storageGet = (keys) =>
  new Promise((resolve) => {
    browserApi.storage.local.get(keys, (result) => resolve(result));
  });

const storageSet = (values) =>
  new Promise((resolve) => {
    browserApi.storage.local.set(values, () => resolve());
  });

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = type;
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/, "");
}

async function initialize() {
  const stored = await storageGet(["baseUrl", "apiToken", "tags", "unreadDefault", "sharedDefault", "autoCloseOnSuccess"]);
  baseUrlInput.value = stored.baseUrl || "";
  apiTokenInput.value = stored.apiToken || "";
  tagsInput.value = stored.tags || "";
  unreadDefault.checked = Boolean(stored.unreadDefault);
  sharedDefault.checked = Boolean(stored.sharedDefault);
  autoCloseInput.checked = Boolean(stored.autoCloseOnSuccess);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const baseUrl = normalizeBaseUrl(baseUrlInput.value.trim());
  const apiToken = apiTokenInput.value.trim();
  const tags = tagsInput.value.trim();
  const unreadDefault = unreadDefaultInput.checked;
  const sharedDefault = sharedDefaultInput.checked;
  const autoCloseOnSuccess = autoCloseInput.checked;

  if (!baseUrl || !apiToken) {
    setStatus("Please enter Linkding URL and API token.", "error");
    return;
  }

  await storageSet({ baseUrl, apiToken, tags, unreadDefault, sharedDefault, autoCloseOnSuccess });
  setStatus("✅ Settings saved.", "success");
});

initialize();
