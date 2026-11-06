const browserApi = globalThis.browser ?? globalThis.chrome;

const form = document.getElementById("bookmark-form");
const saveButton = document.getElementById("save");
const deleteButton = document.getElementById("deleteBookmark");
const openSettingsButton = document.getElementById("openSettings");
const openInstanceButton = document.getElementById("openInstance");
const statusEl = document.getElementById("status");
const duplicateHintEl = document.getElementById("duplicateHint");

const titleInput = document.getElementById("title");
const urlInput = document.getElementById("url");
const descriptionInput = document.getElementById("description");
const notesInput = document.getElementById("notes");
const unreadInput = document.getElementById("unread");
const tagsInput = document.getElementById("tags");
const tagSuggestionsEl = document.getElementById("tagSuggestions");

let availableTags = [];
let duplicateContext = null;
let visibleTagSuggestions = [];
let activeTagSuggestionIndex = -1;
let pendingDeleteConfirmation = false;

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

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = type;
}

function setDuplicateHintVisible(visible) {
  duplicateHintEl.hidden = !visible;
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/, "");
}

function parseTags(raw) {
  return raw
    .trim()
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function truncateText(value, maxLength) {
  if (!value || value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength).trimEnd();
}

function resetDuplicateState() {
  duplicateContext = null;
  pendingDeleteConfirmation = false;
  deleteButton.disabled = true;
  setDuplicateHintVisible(false);
}

function getPayloadFromForm() {
  return {
    url: urlInput.value.trim(),
    title: titleInput.value.trim(),
    description: descriptionInput.value.trim(),
    notes: notesInput.value.trim(),
    unread: unreadInput.checked,
    tag_names: parseTags(tagsInput.value),
  };
}

function extractBookmarkTags(bookmark) {
  if (Array.isArray(bookmark.tag_names)) {
    return bookmark.tag_names.filter((t) => typeof t === "string" && t.trim().length > 0);
  }

  if (typeof bookmark.tag_names === "string") {
    return bookmark.tag_names
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  if (Array.isArray(bookmark.tags)) {
    return bookmark.tags
      .map((t) => (typeof t === "string" ? t : t?.name))
      .filter((t) => typeof t === "string" && t.trim().length > 0);
  }

  return [];
}

function applyBookmarkToForm(bookmark) {
  if (!bookmark) {
    return;
  }

  if (typeof bookmark.title === "string") {
    titleInput.value = bookmark.title;
  }

  if (typeof bookmark.description === "string") {
    descriptionInput.value = truncateText(bookmark.description, MAX_DESCRIPTION_LENGTH);
  }

  if (typeof bookmark.notes === "string") {
    notesInput.value = bookmark.notes;
  }

  if (typeof bookmark.unread === "boolean") {
    unreadInput.checked = bookmark.unread;
  }

  const tags = extractBookmarkTags(bookmark);
  if (tags.length > 0) {
    tagsInput.value = tags.join(" ");
  }
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
      bookmark: data.bookmark ?? null,
    };
  } catch (error) {
    if (error.message.startsWith("Duplicate check failed")) {
      throw error;
    }

    throw new Error(humanNetworkError("Duplicate check failed", error));
  }
}

async function fetchBookmarkById(baseUrl, apiToken, bookmarkId) {
  const response = await fetch(`${baseUrl}/api/bookmarks/${bookmarkId}/`, {
    headers: {
      Authorization: `Token ${apiToken}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  return response.json();
}

async function resolveBookmarkIdByUrl(baseUrl, apiToken, url) {
  const response = await fetch(`${baseUrl}/api/bookmarks/?q=${encodeURIComponent(url)}&limit=50`, {
    headers: {
      Authorization: `Token ${apiToken}`,
    },
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  const results = Array.isArray(data?.results) ? data.results : Array.isArray(data) ? data : [];
  const normalizedUrl = normalizeBaseUrl(url);

  const exactMatch = results.find((item) => {
    if (typeof item?.url !== "string") {
      return false;
    }
    return item.url === url || normalizeBaseUrl(item.url) === normalizedUrl;
  });

  const candidate = exactMatch ?? results[0];
  return candidate?.id ?? null;
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

async function deleteBookmark(baseUrl, apiToken, bookmarkId) {
  try {
    const response = await fetch(`${baseUrl}/api/bookmarks/${bookmarkId}/`, {
      method: "DELETE",
      headers: {
        Authorization: `Token ${apiToken}`,
      },
    });

    if (!response.ok) {
      const details = await readErrorDetails(response);
      throw new Error(humanApiError("Delete failed", response.status, details));
    }
  } catch (error) {
    if (error.message.startsWith("Delete failed")) {
      throw error;
    }

    throw new Error(humanNetworkError("Delete failed", error));
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

function getCurrentTagToken(raw) {
  return raw.trim().split(/[\s,]+/).pop()?.trim().toLowerCase() || "";
}

function replaceCurrentTag(raw, newTag) {
  const tokens = raw.trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length > 0) {
    tokens.pop();
  }
  return `${[...tokens, newTag].join(" ")} `;
}

function closeTagSuggestions() {
  visibleTagSuggestions = [];
  activeTagSuggestionIndex = -1;
  tagSuggestionsEl.hidden = true;
  tagSuggestionsEl.innerHTML = "";
}

function commitActiveTagSuggestion() {
  if (activeTagSuggestionIndex < 0 || activeTagSuggestionIndex >= visibleTagSuggestions.length) {
    return false;
  }

  const tag = visibleTagSuggestions[activeTagSuggestionIndex];
  tagsInput.value = replaceCurrentTag(tagsInput.value, tag);
  tagsInput.focus();
  closeTagSuggestions();
  return true;
}

function renderTagSuggestions() {
  const currentToken = getCurrentTagToken(tagsInput.value);
  const selectedTags = new Set(parseTags(tagsInput.value).map((tag) => tag.toLowerCase()));

  if (!currentToken || availableTags.length === 0) {
    closeTagSuggestions();
    return;
  }

  visibleTagSuggestions = availableTags
    .filter((tag) => tag.toLowerCase().startsWith(currentToken) && !selectedTags.has(tag.toLowerCase()))
    .slice(0, 8);

  if (visibleTagSuggestions.length === 0) {
    closeTagSuggestions();
    return;
  }

  if (activeTagSuggestionIndex >= visibleTagSuggestions.length || activeTagSuggestionIndex < 0) {
    activeTagSuggestionIndex = 0;
  }

  tagSuggestionsEl.hidden = false;
  tagSuggestionsEl.innerHTML = "";

  visibleTagSuggestions.forEach((tag, index) => {
    const item = document.createElement("li");
    item.className = `tag-suggestion${index === activeTagSuggestionIndex ? " active" : ""}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", index === activeTagSuggestionIndex ? "true" : "false");
    item.textContent = tag;
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      activeTagSuggestionIndex = index;
      commitActiveTagSuggestion();
    });
    tagSuggestionsEl.appendChild(item);
  });
}

function scrollActiveTagSuggestionIntoView() {
  const item = tagSuggestionsEl.children[activeTagSuggestionIndex];
  if (!item) {
    return;
  }

  const listTop = tagSuggestionsEl.scrollTop;
  const listBottom = listTop + tagSuggestionsEl.clientHeight;
  const itemTop = item.offsetTop;
  const itemBottom = itemTop + item.offsetHeight;

  if (itemTop < listTop) {
    tagSuggestionsEl.scrollTop = itemTop;
  } else if (itemBottom > listBottom) {
    tagSuggestionsEl.scrollTop = itemBottom - tagSuggestionsEl.clientHeight;
  }
}

urlInput.addEventListener("input", resetDuplicateState);

titleInput.addEventListener("input", () => {
  pendingDeleteConfirmation = false;
});

descriptionInput.addEventListener("input", () => {
  pendingDeleteConfirmation = false;
});

notesInput.addEventListener("input", () => {
  pendingDeleteConfirmation = false;
});

unreadInput.addEventListener("change", () => {
  pendingDeleteConfirmation = false;
});
tagsInput.addEventListener("input", () => {
  renderTagSuggestions();
});

tagsInput.addEventListener("keydown", (event) => {
  if (tagSuggestionsEl.hidden || visibleTagSuggestions.length === 0) {
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    activeTagSuggestionIndex = (activeTagSuggestionIndex + 1) % visibleTagSuggestions.length;
    renderTagSuggestions();
    scrollActiveTagSuggestionIntoView();
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    activeTagSuggestionIndex =
      (activeTagSuggestionIndex - 1 + visibleTagSuggestions.length) % visibleTagSuggestions.length;
    renderTagSuggestions();
    scrollActiveTagSuggestionIntoView();
    return;
  }

  if (event.key === "Enter") {
    event.preventDefault();
    commitActiveTagSuggestion();
    return;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeTagSuggestions();
  }
});

tagsInput.addEventListener("blur", () => {
  setTimeout(() => {
    closeTagSuggestions();
  }, 120);
});

async function prefillFromExistingBookmark(baseUrl, apiToken, targetUrl) {
  if (!targetUrl) {
    resetDuplicateState();
    return;
  }

  const duplicate = await checkDuplicate(baseUrl, apiToken, targetUrl);
  if (!duplicate.exists) {
    resetDuplicateState();
    return;
  }

  let bookmarkId = duplicate.bookmarkId;
  if (!bookmarkId) {
    bookmarkId = await resolveBookmarkIdByUrl(baseUrl, apiToken, targetUrl);
  }

  duplicateContext = { bookmarkId };
  deleteButton.disabled = false;
  setDuplicateHintVisible(true);

  if (duplicate.bookmark) {
    applyBookmarkToForm(duplicate.bookmark);

    const hasTags = extractBookmarkTags(duplicate.bookmark).length > 0;
    if (hasTags || !bookmarkId) {
      return;
    }
  }

  if (bookmarkId) {
    const bookmark = await fetchBookmarkById(baseUrl, apiToken, bookmarkId);
    applyBookmarkToForm(bookmark);
  }
}

function focusPrimaryInput() {
  const target = titleInput;
  target.focus();
  const len = target.value.length;
  target.setSelectionRange(len, len);
}

async function initialize() {
  resetDuplicateState();
  const stored = await storageGet(["baseUrl", "apiToken", "unreadDefault"]);

  if (!stored.baseUrl || !stored.apiToken) {
    setStatus("Please set Linkding URL and API token in Settings.", "error");
  }

  try {
    const tab = await getActiveTab();
    titleInput.value = tab.title || "";
    urlInput.value = tab.url || "";
	unreadInput.checked = stored.unreadDefault;

    const pageDescription = await getPageDescription(tab.id);
    if (pageDescription && !descriptionInput.value.trim()) {
      descriptionInput.value = truncateText(pageDescription, MAX_DESCRIPTION_LENGTH);
    }

    if (stored.baseUrl && stored.apiToken) {
      await prefillFromExistingBookmark(
        normalizeBaseUrl(stored.baseUrl.trim()),
        stored.apiToken.trim(),
        (tab.url || "").trim(),
      );
    }
  } catch (error) {
    setStatus(`Could not read active tab: ${error.message}`, "error");
  }

  if (stored.baseUrl && stored.apiToken) {
    await fetchTags(normalizeBaseUrl(stored.baseUrl.trim()), stored.apiToken.trim());
  }

  focusPrimaryInput();
}

openSettingsButton.addEventListener("click", () => {
  window.open("options.html", "_blank", "noreferrer");
});

openInstanceButton.addEventListener("click", async () => {
  const stored = await storageGet(["baseUrl"]);
  const baseUrl = normalizeBaseUrl((stored.baseUrl || "").trim());

  if (!baseUrl) {
    setStatus("Please set Linkding URL in Settings.", "error");
    return;
  }

  browserApi.tabs.create({ url: `${baseUrl}/bookmarks` });
});

deleteButton.addEventListener("click", async () => {
  if (!pendingDeleteConfirmation) {
    pendingDeleteConfirmation = true;
    setStatus("Click delete again to confirm removal.", "error");
    setTimeout(() => {
      pendingDeleteConfirmation = false;
    }, 2500);
    return;
  }

  pendingDeleteConfirmation = false;

  const stored = await storageGet(["baseUrl", "apiToken", "autoCloseOnSuccess"]);
  const baseUrl = normalizeBaseUrl((stored.baseUrl || "").trim());
  const apiToken = (stored.apiToken || "").trim();

  if (!baseUrl || !apiToken) {
    setStatus("Please set Linkding URL and API token in Settings.", "error");
    return;
  }

  let bookmarkId = duplicateContext?.bookmarkId || null;
  if (!bookmarkId) {
    bookmarkId = await resolveBookmarkIdByUrl(baseUrl, apiToken, urlInput.value.trim());
    if (duplicateContext) {
      duplicateContext.bookmarkId = bookmarkId;
    } else {
      duplicateContext = { bookmarkId };
    }
  }

  if (!bookmarkId) {
    setStatus("Could not determine bookmark ID for deletion.", "error");
    return;
  }

  deleteButton.disabled = true;
  saveButton.disabled = true;

  try {
    await deleteBookmark(baseUrl, apiToken, bookmarkId);
    setStatus("✅ Bookmark deleted.", "success");
    resetDuplicateState();

    if (stored.autoCloseOnSuccess) {
      setTimeout(() => window.close(), 500);
    }
  } catch (error) {
    setStatus(error.message || "Delete failed.", "error");
    deleteButton.disabled = false;
  } finally {
    saveButton.disabled = false;
  }
});

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
    if (duplicateContext && duplicateContext.bookmarkId) {
      setStatus("Updating existing bookmark …");
      await updateBookmark(baseUrl, apiToken, duplicateContext.bookmarkId, payload);
      setStatus("✅ Bookmark updated.", "success");
    } else {
      setStatus("Saving bookmark …");
      await createBookmark(baseUrl, apiToken, payload);
      setStatus("✅ Bookmark saved.", "success");
    }

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
