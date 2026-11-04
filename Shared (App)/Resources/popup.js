const browserApi = globalThis.browser ?? globalThis.chrome;

const form = document.getElementById("bookmark-form");
const saveButton = document.getElementById("save");
const statusEl = document.getElementById("status");

const titleInput = document.getElementById("title");
const urlInput = document.getElementById("url");
const descriptionInput = document.getElementById("description");
const notesInput = document.getElementById("notes");
const tagsInput = document.getElementById("tags");
const tagSuggestionsEl = document.getElementById("tagSuggestions");

let availableTags = [];
let duplicateContext = null;

const MAX_DESCRIPTION_LENGTH = 500;

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
        reject(new Error("No active tab found."));
        return;
      }

      resolve(tabs[0]);
    });
  });

function truncateText(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength).trimEnd();
}

async function getPageDescription(tabId) {
  if (!browserApi.scripting?.executeScript) {
    return "";
  }

  try {
    const [result] = await browserApi.scripting.executeScript({
      target: { tabId },
      func: () => {
        const pick = (selector) => {
          const el = document.querySelector(selector);
          return el?.getAttribute("content")?.trim() || "";
        };

        return (
          pick('meta[name="description"]') ||
          pick('meta[property="og:description"]') ||
          pick('meta[name="twitter:description"]') ||
          ""
        );
      },
    });

    return typeof result?.result === "string" ? result.result.trim() : "";
  } catch {
    return "";
  }
}

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = type;
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/, "");
}

function parseTags(raw) {
  return raw
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function resetDuplicateState() {
  const hadDuplicateState = Boolean(duplicateContext);
  duplicateContext = null;
  saveButton.textContent = "Save bookmark";

  if (hadDuplicateState) {
    setStatus("");
  }
}

function setDuplicateState(context) {
  duplicateContext = context;
  saveButton.textContent = "Overwrite bookmark";
}

function getPayloadFromForm() {
  return {
    url: urlInput.value.trim(),
    title: titleInput.value.trim(),
    description: descriptionInput.value.trim(),
    notes: notesInput.value.trim(),
    tag_names: parseTags(tagsInput.value),
  };
}

async function readErrorDetails(response) {
  try {
    const json = await response.json();
    return JSON.stringify(json);
  } catch {
    return (await response.text()) || "No details.";
  }
}

function humanApiError(context, status, details = "") {
  if (status === 401 || status === 403) {
    return `${context}: authentication failed. Please verify API token.`;
  }

  if (status === 404) {
    return `${context}: API endpoint not found. Verify Linkding URL (without /api).`;
  }

  if (status >= 500) {
    return `${context}: Linkding returned a server error (HTTP ${status}).`;
  }

  return `${context} (HTTP ${status})${details ? `: ${details}` : ""}`;
}

function humanNetworkError(context, error) {
  if (error instanceof TypeError) {
    return `${context}: network error. Check URL, connection, and host permission.`;
  }

  return `${context}: ${error.message}`;
}

async function checkDuplicate(baseUrl, apiToken, url) {
  try {
    const response = await fetch(`${baseUrl}/api/bookmarks/check/?url=${encodeURIComponent(url)}`, {
      headers: {
        Authorization: `Token ${apiToken}`,
      },
    });

    if (!response.ok) {
      const details = await readErrorDetails(response);
      throw new Error(humanApiError("Duplicate check failed", response.status, details));
    }

    const data = await response.json();
    const bookmarkId = data.bookmark?.id ?? data.bookmark_id ?? data.id ?? null;
    const exists =
      data.exists === true ||
      data.is_duplicate === true ||
      Boolean(data.bookmark) ||
      bookmarkId !== null;

    return {
      exists,
      bookmarkId,
    };
  } catch (error) {
    if (error.message.startsWith("Duplicate check failed")) {
      throw error;
    }

    throw new Error(humanNetworkError("Duplicate check failed", error));
  }
}

async function createBookmark(baseUrl, apiToken, payload) {
  try {
    const response = await fetch(`${baseUrl}/api/bookmarks/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${apiToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const details = await readErrorDetails(response);
      throw new Error(humanApiError("Save failed", response.status, details));
    }
  } catch (error) {
    if (error.message.startsWith("Save failed")) {
      throw error;
    }

    throw new Error(humanNetworkError("Save failed", error));
  }
}

async function updateBookmark(baseUrl, apiToken, bookmarkId, payload) {
  try {
    const response = await fetch(`${baseUrl}/api/bookmarks/${bookmarkId}/`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${apiToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const details = await readErrorDetails(response);
      throw new Error(humanApiError("Update failed", response.status, details));
    }
  } catch (error) {
    if (error.message.startsWith("Update failed")) {
      throw error;
    }

    throw new Error(humanNetworkError("Update failed", error));
  }
}

async function fetchTags(baseUrl, apiToken) {
  try {
    const tagSet = new Set();
    let nextUrl = `${baseUrl}/api/tags/?limit=100`;

    while (nextUrl) {
      const response = await fetch(nextUrl, {
        headers: {
          Authorization: `Token ${apiToken}`,
        },
      });

      if (!response.ok) {
        return;
      }

      const data = await response.json();

      if (Array.isArray(data)) {
        for (const item of data) {
          if (item?.name) {
            tagSet.add(item.name);
          }
        }
        nextUrl = null;
      } else {
        if (Array.isArray(data.results)) {
          for (const item of data.results) {
            if (item?.name) {
              tagSet.add(item.name);
            }
          }
        }
        nextUrl = data.next || null;
      }
    }

    availableTags = Array.from(tagSet).sort((a, b) => a.localeCompare(b));
  } catch {
    // Autocomplete is optional.
  }
}

function getCurrentTagToken(raw) {
  return raw.split(",").pop()?.trim().toLowerCase() || "";
}

function replaceCurrentTag(raw, newTag) {
  const parts = raw.split(",");
  const committed = parts.slice(0, -1).map((part) => part.trim()).filter(Boolean);
  return `${[...committed, newTag].join(", ")}, `;
}

function renderTagSuggestions() {
  const currentToken = getCurrentTagToken(tagsInput.value);
  const selectedTags = new Set(parseTags(tagsInput.value).map((tag) => tag.toLowerCase()));

  tagSuggestionsEl.innerHTML = "";

  if (!currentToken || availableTags.length === 0) {
    return;
  }

  const matches = availableTags
    .filter((tag) => tag.toLowerCase().startsWith(currentToken) && !selectedTags.has(tag.toLowerCase()))
    .slice(0, 8);

  for (const tag of matches) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tag-suggestion";
    btn.textContent = tag;
    btn.addEventListener("mousedown", (event) => {
      event.preventDefault();
      tagsInput.value = replaceCurrentTag(tagsInput.value, tag);
      tagsInput.focus();
      renderTagSuggestions();
      resetDuplicateState();
    });
    tagSuggestionsEl.appendChild(btn);
  }
}

// Keep duplicate/overwrite state when editing metadata.
  // Only URL changes can invalidate duplicate status.
  urlInput.addEventListener("input", resetDuplicateState);
tagsInput.addEventListener("input", () => {
  renderTagSuggestions();
});

tagsInput.addEventListener("blur", () => {
  setTimeout(() => {
    tagSuggestionsEl.innerHTML = "";
  }, 120);
});

async function initialize() {
  resetDuplicateState();
  const stored = await storageGet(["baseUrl", "apiToken"]);

  if (!stored.baseUrl || !stored.apiToken) {
    setStatus("Please set Linkding URL and API token in Settings.", "error");
  }

  try {
    const tab = await getActiveTab();
    titleInput.value = tab.title || "";
    urlInput.value = tab.url || "";

    const pageDescription = await getPageDescription(tab.id);
    if (pageDescription && !descriptionInput.value.trim()) {
      descriptionInput.value = truncateText(pageDescription, MAX_DESCRIPTION_LENGTH);
    }
  } catch (error) {
    setStatus(`Could not read active tab: ${error.message}`, "error");
  }

  if (stored.baseUrl && stored.apiToken) {
    await fetchTags(normalizeBaseUrl(stored.baseUrl.trim()), stored.apiToken.trim());
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const stored = await storageGet(["baseUrl", "apiToken", "autoCloseOnSuccess"]);
  const baseUrl = normalizeBaseUrl((stored.baseUrl || "").trim());
  const apiToken = (stored.apiToken || "").trim();
  const payload = getPayloadFromForm();

  if (!baseUrl || !apiToken) {
    setStatus("Please set Linkding URL and API token in Settings.", "error");
    return;
  }

  if (!payload.title || !payload.url) {
    setStatus("Please fill all required fields.", "error");
    return;
  }

  saveButton.disabled = true;

  try {
    if (duplicateContext) {
      setStatus("Updating existing bookmark …");
      if (duplicateContext.bookmarkId) {
        await updateBookmark(baseUrl, apiToken, duplicateContext.bookmarkId, payload);
      } else {
        await createBookmark(baseUrl, apiToken, payload);
      }

      setStatus("✅ Bookmark updated.", "success");
      resetDuplicateState();

      if (stored.autoCloseOnSuccess) {
        setTimeout(() => window.close(), 500);
      }
      return;
    }

    setStatus("Checking for duplicates …");
    const duplicate = await checkDuplicate(baseUrl, apiToken, payload.url);

    if (duplicate.exists) {
      setDuplicateState({ bookmarkId: duplicate.bookmarkId });
      setStatus('Duplicate found. Click "Overwrite bookmark" to update existing entry.', "error");
      return;
    }

    setStatus("Saving bookmark …");
    await createBookmark(baseUrl, apiToken, payload);

    setStatus("✅ Bookmark saved.", "success");

    if (stored.autoCloseOnSuccess) {
      setTimeout(() => window.close(), 500);
    }
  } catch (error) {
    setStatus(error.message || "Unknown error while saving.", "error");
  } finally {
    saveButton.disabled = false;
  }
});

initialize();
