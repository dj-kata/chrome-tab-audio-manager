const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_DOCUMENT_URL = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
const DEFAULT_SETTINGS = {
  volume: 1,
  pan: 0,
  outputDeviceId: "default",
  limiterEnabled: false
};

let creatingOffscreenDocument;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return false;
  }

  handleRuntimeMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      console.error("Request failed", message, error);
      sendResponse({ ok: false, error: normalizeError(error) });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sendToOffscreen({ type: "TAB_CLOSED", tabId }, { create: false }).catch((error) => {
    console.debug("Unable to notify offscreen document about tab close", error);
  });
  removeStoredTabSettings(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    sendToOffscreen({ type: "TAB_NAVIGATED", tabId }, { create: false }).catch((error) => {
      console.debug("Unable to notify offscreen document about tab navigation", error);
    });
  }
});

async function handleRuntimeMessage(message) {
  if (!message || typeof message.type !== "string") {
    throw new Error("Invalid message.");
  }

  switch (message.type) {
    case "START_CAPTURE":
      return startCapture(message.tabId);
    case "STOP_CAPTURE":
      return stopCapture(message.tabId);
    case "SET_VOLUME":
      return updateAudioSetting(message.tabId, "volume", message.volume, "SET_VOLUME");
    case "SET_PAN":
      return updateAudioSetting(message.tabId, "pan", message.pan, "SET_PAN");
    case "SET_LIMITER":
      return updateAudioSetting(message.tabId, "limiterEnabled", Boolean(message.limiterEnabled), "SET_LIMITER");
    case "SET_OUTPUT_DEVICE":
      return updateAudioSetting(
        message.tabId,
        "outputDeviceId",
        normalizeOutputDeviceId(message.outputDeviceId),
        "SET_OUTPUT_DEVICE"
      );
    case "GET_SESSION_STATE":
      return getSessionState(message.tabId);
    case "LIST_OUTPUT_DEVICES":
      return sendToOffscreen({ type: "LIST_OUTPUT_DEVICES" }, { create: false });
    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

async function startCapture(tabId) {
  const tab = await getTab(tabId);
  assertCapturableTab(tab);
  await setupOffscreenDocument();

  const settings = await getStoredTabSettings(tab.id);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  const response = await sendToOffscreen({
    type: "START_CAPTURE",
    tabId: tab.id,
    streamId,
    settings
  });

  if (response.ok) {
    await setStoredTabSettings(tab.id, response.state || settings);
  }

  return response;
}

async function stopCapture(tabId) {
  const tab = await getTab(tabId);
  return sendToOffscreen({ type: "STOP_CAPTURE", tabId: tab.id }, { create: false });
}

async function updateAudioSetting(tabId, key, value, messageType) {
  const tab = await getTab(tabId);
  const response = await sendToOffscreen({
    type: messageType,
    tabId: tab.id,
    [key]: value
  }, { create: false });

  if (response.ok) {
    const current = await getStoredTabSettings(tab.id);
    await setStoredTabSettings(tab.id, { ...current, [key]: value });
  }
  return response;
}

async function getSessionState(tabId) {
  const tab = await getTab(tabId);
  const storedSettings = await getStoredTabSettings(tab.id);

  if (!(await hasOffscreenDocument())) {
    return {
      ok: true,
      active: false,
      settings: storedSettings
    };
  }

  const response = await sendToOffscreen({ type: "GET_SESSION_STATE", tabId: tab.id }, { create: false });

  return {
    ...response,
    settings: {
      ...storedSettings,
      ...(response.state || {})
    }
  };
}

async function setupOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (!creatingOffscreenDocument) {
    creatingOffscreenDocument = chrome.offscreen.createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
      justification: "Capture tab audio and replay it through Web Audio with per-tab controls."
    });
  }

  try {
    await creatingOffscreenDocument;
  } finally {
    creatingOffscreenDocument = undefined;
  }
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_DOCUMENT_URL]
  });
  return contexts.length > 0;
}

async function sendToOffscreen(message, options = {}) {
  const create = options.create !== false;
  if (create) {
    await setupOffscreenDocument();
  } else if (!(await hasOffscreenDocument())) {
    return { ok: true, active: false };
  }

  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

async function getTab(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new Error("No active tab was found.");
  }
  return chrome.tabs.get(tabId);
}

function assertCapturableTab(tab) {
  const url = tab.url || "";
  const restrictedSchemes = ["chrome:", "chrome-extension:", "edge:", "about:", "devtools:"];
  if (restrictedSchemes.some((scheme) => url.startsWith(scheme))) {
    throw new Error("This tab cannot be captured by Chrome extensions.");
  }
}

async function getStoredTabSettings(tabId) {
  const key = storageKey(tabId);
  const values = await chrome.storage.local.get(key);
  return { ...DEFAULT_SETTINGS, ...(values[key] || {}) };
}

async function setStoredTabSettings(tabId, settings) {
  await chrome.storage.local.set({
    [storageKey(tabId)]: {
      volume: clampNumber(settings.volume, 0, 6, DEFAULT_SETTINGS.volume),
      pan: clampNumber(settings.pan, -1, 1, DEFAULT_SETTINGS.pan),
      outputDeviceId: normalizeOutputDeviceId(settings.outputDeviceId),
      limiterEnabled: Boolean(settings.limiterEnabled)
    }
  });
}

async function removeStoredTabSettings(tabId) {
  await chrome.storage.local.remove(storageKey(tabId));
}

function storageKey(tabId) {
  return `tabSettings:${tabId}`;
}

function normalizeOutputDeviceId(outputDeviceId) {
  return outputDeviceId || "default";
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function normalizeError(error) {
  if (!error) {
    return "Unknown error.";
  }
  return error.message || String(error);
}
