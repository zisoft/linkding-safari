const browserApi = globalThis.browser ?? globalThis.chrome;

const storageGet = (keys) =>
  new Promise((resolve) => {
    browserApi.storage.local.get(keys, (result) => resolve(result));
  });

const getActiveTab = () =>
  new Promise((resolve, reject) => {
    browserApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (browserApi.runtime.lastError) {
        reject(new Error(browserApi.runtime.lastError.message));
        return;
      }

      if (!tabs || tabs.length === 0) {
        reject(new Error("Kein aktiver Tab gefunden."));
        return;
      }

      resolve(tabs[0]);
    });
  });

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/, "");
}

async function flashBadge(text, color = "#187a2f") {
  if (!browserApi.action?.setBadgeText) {
    return;
  }

  await browserApi.action.setBadgeBackgroundColor({ color });
  await browserApi.action.setBadgeText({ text });
  setTimeout(() => {
    browserApi.action.setBadgeText({ text: "" });
  }, 1800);
}

async function checkDuplicate(baseUrl, apiToken, url) {
  const response = await fetch(
    `${baseUrl}/api/bookmarks/check/?url=${encodeURIComponent(url)}`,
    {
      headers: {
        Authorization: `Token ${apiToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Duplikat-Prüfung fehlgeschlagen (HTTP ${response.status})`);
  }

  const data = await response.json();
  return Boolean(data.exists);
}

async function createBookmark(baseUrl, apiToken, payload) {
  const response = await fetch(`${baseUrl}/api/bookmarks/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${apiToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let details = "";
    try {
      details = JSON.stringify(await response.json());
    } catch {
      details = await response.text();
    }
    throw new Error(`HTTP ${response.status}: ${details}`);
  }
}

browserApi.commands.onCommand.addListener(async (command) => {
  if (command !== "save-current-page") {
    return;
  }

  try {
    const stored = await storageGet(["baseUrl", "apiToken"]);
    const baseUrl = normalizeBaseUrl((stored.baseUrl || "").trim());
    const apiToken = (stored.apiToken || "").trim();

    if (!baseUrl || !apiToken) {
      await flashBadge("ERR", "#b50000");
      return;
    }

    const tab = await getActiveTab();
    const title = tab.title || "";
    const url = tab.url || "";

    if (!title || !url) {
      await flashBadge("ERR", "#b50000");
      return;
    }

    const exists = await checkDuplicate(baseUrl, apiToken, url);
    if (exists) {
      await flashBadge("DUP", "#b58900");
      return;
    }

    await createBookmark(baseUrl, apiToken, {
      url,
      title,
      description: "",
      tag_names: [],
    });

    await flashBadge("OK", "#187a2f");
  } catch (error) {
    console.error("Linkding save-current-page failed", error);
    await flashBadge("ERR", "#b50000");
  }
});
