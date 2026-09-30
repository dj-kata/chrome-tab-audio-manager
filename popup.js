const ui = {
  tabTitle: document.getElementById("tabTitle"),
  status: document.getElementById("status"),
  enableButton: document.getElementById("enableButton"),
  stopButton: document.getElementById("stopButton"),
  volumeRange: document.getElementById("volumeRange"),
  volumeValue: document.getElementById("volumeValue"),
  panRange: document.getElementById("panRange"),
  panValue: document.getElementById("panValue"),
  outputSelect: document.getElementById("outputSelect"),
  selectOutputButton: document.getElementById("selectOutputButton"),
  limiterToggle: document.getElementById("limiterToggle"),
  outputHelp: document.getElementById("outputHelp")
};

const DEFAULT_DEVICE = { deviceId: "default", label: "System Default" };

let currentTab;
let active = false;
let support = {
  setSinkId: false,
  selectAudioOutput: Boolean(navigator.mediaDevices?.selectAudioOutput),
  enumerateDevices: Boolean(navigator.mediaDevices?.enumerateDevices)
};
let devices = [DEFAULT_DEVICE];

document.addEventListener("DOMContentLoaded", init);
ui.enableButton.addEventListener("click", enableProcessing);
ui.stopButton.addEventListener("click", stopProcessing);
ui.volumeRange.addEventListener("input", onVolumeInput);
ui.volumeRange.addEventListener("change", onVolumeChange);
ui.panRange.addEventListener("input", onPanInput);
ui.panRange.addEventListener("change", onPanChange);
ui.limiterToggle.addEventListener("change", onLimiterChange);
ui.outputSelect.addEventListener("change", onOutputChange);
ui.selectOutputButton.addEventListener("click", selectAudioOutput);

async function init() {
  setBusy(true);
  try {
    currentTab = await getCurrentTab();
    ui.tabTitle.textContent = currentTab?.title || currentTab?.url || "Current tab";
    await refreshDevices();
    const response = await sendMessage({ type: "GET_SESSION_STATE", tabId: currentTab.id });
    mergeSupport(response.support);
    active = Boolean(response.active);
    applySettings(response.settings || response.state || {});
    renderState();
  } catch (error) {
    showStatus(normalizeError(error), "error");
    renderState();
  } finally {
    setBusy(false);
  }
}

async function enableProcessing() {
  setBusy(true);
  showStatus("Starting audio processing...", "ok");
  try {
    const response = await sendMessage({ type: "START_CAPTURE", tabId: currentTab.id });
    if (!response.ok) {
      throw new Error(response.error || "Could not start capture.");
    }
    active = true;
    mergeSupport(response.support);
    applySettings(response.state || {});
    await refreshDevices();
    renderState();
    showStatus("Audio processing is enabled.", "ok");
    showOutputWarning(response.output);
  } catch (error) {
    active = false;
    renderState();
    showStatus(normalizeError(error), "error");
  } finally {
    setBusy(false);
  }
}

async function stopProcessing() {
  setBusy(true);
  try {
    const response = await sendMessage({ type: "STOP_CAPTURE", tabId: currentTab.id });
    if (!response.ok) {
      throw new Error(response.error || "Could not stop processing.");
    }
    active = false;
    renderState();
    showStatus("Audio processing stopped.", "ok");
  } catch (error) {
    showStatus(normalizeError(error), "error");
  } finally {
    setBusy(false);
  }
}

function onVolumeInput() {
  ui.volumeValue.textContent = `${ui.volumeRange.value}%`;
}

async function onVolumeChange() {
  try {
    const volume = Number(ui.volumeRange.value) / 100;
    const response = await sendMessage({ type: "SET_VOLUME", tabId: currentTab.id, volume });
    if (!response.ok) {
      throw new Error(response.error || "Could not update volume.");
    }
  } catch (error) {
    showStatus(normalizeError(error), "error");
  }
}

function onPanInput() {
  ui.panValue.textContent = formatPan(Number(ui.panRange.value) / 100);
}

async function onPanChange() {
  try {
    const pan = Number(ui.panRange.value) / 100;
    const response = await sendMessage({ type: "SET_PAN", tabId: currentTab.id, pan });
    if (!response.ok) {
      throw new Error(response.error || "Could not update pan.");
    }
  } catch (error) {
    showStatus(normalizeError(error), "error");
  }
}

async function onLimiterChange() {
  try {
    const limiterEnabled = ui.limiterToggle.checked;
    const response = await sendMessage({
      type: "SET_LIMITER",
      tabId: currentTab.id,
      limiterEnabled
    });
    if (!response.ok) {
      throw new Error(response.error || "Could not update limiter.");
    }
  } catch (error) {
    showStatus(normalizeError(error), "error");
  }
}

async function onOutputChange() {
  try {
    const outputDeviceId = ui.outputSelect.value;
    const response = await sendMessage({
      type: "SET_OUTPUT_DEVICE",
      tabId: currentTab.id,
      outputDeviceId
    });
    if (!response.ok) {
      applySettings(response.state || { outputDeviceId: "default" });
      renderDeviceOptions();
      showStatus(response.error || "Could not change output device.", "error");
      return;
    }
    applySettings(response.state || { outputDeviceId });
    renderDeviceOptions();
  } catch (error) {
    showStatus(normalizeError(error), "error");
  }
}

async function selectAudioOutput() {
  if (navigator.mediaDevices?.selectAudioOutput) {
    try {
      const device = await navigator.mediaDevices.selectAudioOutput();
      if (device?.deviceId) {
        upsertDevice({
          deviceId: device.deviceId,
          label: device.label || "Selected audio output"
        });
        renderDeviceOptions(device.deviceId);
        if (active) {
          await onOutputChange();
        }
      }
    } catch (error) {
      showStatus("Output device selection was not completed: " + normalizeError(error), "error");
    }
    return;
  }

  await openDevicePermissionPage();
}

async function openDevicePermissionPage() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("device-permission.html"),
    active: true
  });
}

async function refreshDevices() {
  const storedDevices = await loadStoredOutputDevices();
  for (const device of storedDevices) {
    upsertDevice(device);
  }

  const listed = await listDevicesInPopup();
  for (const device of listed) {
    upsertDevice(device);
  }

  try {
    const response = await sendMessage({ type: "LIST_OUTPUT_DEVICES" });
    if (response.ok) {
      mergeSupport(response.support);
      for (const device of response.devices || []) {
        upsertDevice(device);
      }
    }
  } catch (error) {
    console.debug("Offscreen device listing unavailable", error);
  }

  renderDeviceOptions(ui.outputSelect.value || "default");
}

async function listDevicesInPopup() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return [DEFAULT_DEVICE];
  }

  try {
    const mediaDevices = await navigator.mediaDevices.enumerateDevices();
    return [
      DEFAULT_DEVICE,
      ...mediaDevices
        .filter((device) => device.kind === "audiooutput" && device.deviceId !== "default")
        .map((device) => ({
          deviceId: device.deviceId,
          label: device.label || "Audio output device"
        }))
    ];
  } catch (error) {
    console.debug("Popup device enumeration failed", error);
    return [DEFAULT_DEVICE];
  }
}

function applySettings(settings) {
  if (Number.isFinite(settings.volume)) {
    ui.volumeRange.value = String(Math.round(settings.volume * 100));
  }
  if (Number.isFinite(settings.pan)) {
    ui.panRange.value = String(Math.round(settings.pan * 100));
  }
  if (typeof settings.limiterEnabled === "boolean") {
    ui.limiterToggle.checked = settings.limiterEnabled;
  }
  if (settings.outputDeviceId) {
    renderDeviceOptions(settings.outputDeviceId);
  }
  onVolumeInput();
  onPanInput();
}

function renderState() {
  ui.enableButton.disabled = active;
  ui.stopButton.disabled = !active;
  ui.volumeRange.disabled = !active;
  ui.panRange.disabled = !active;
  ui.limiterToggle.disabled = !active;
  ui.outputSelect.disabled = !active || !support.setSinkId;
  ui.selectOutputButton.disabled = !support.setSinkId || !navigator.mediaDevices?.enumerateDevices;

  if (!support.setSinkId) {
    ui.outputHelp.textContent = "Output device routing is unavailable in this Chrome build.";
  } else if (!navigator.mediaDevices?.enumerateDevices) {
    ui.outputHelp.textContent = "This Chrome build cannot list audio output devices here.";
  } else if (!support.selectAudioOutput) {
    ui.outputHelp.textContent = "Click Add/Select to open the device permission page.";
  } else {
    ui.outputHelp.textContent = "";
  }
}

function renderDeviceOptions(selectedDeviceId = ui.outputSelect.value || "default") {
  const selected = selectedDeviceId || "default";
  ui.outputSelect.replaceChildren(
    ...devices.map((device) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || "Audio output device";
      option.selected = device.deviceId === selected;
      return option;
    })
  );

  if (![...ui.outputSelect.options].some((option) => option.value === selected)) {
    const option = document.createElement("option");
    option.value = selected;
    option.textContent = "Previously selected device";
    option.selected = true;
    ui.outputSelect.append(option);
  }
}

function showOutputWarning(outputResult) {
  if (outputResult && outputResult.ok === false) {
    showStatus(outputResult.error || "Output device changed to System Default.", "error");
  }
}

function showStatus(message, kind = "ok") {
  ui.status.textContent = message || "";
  ui.status.classList.toggle("is-visible", Boolean(message));
  ui.status.classList.toggle("is-ok", kind === "ok");
  ui.status.classList.toggle("is-error", kind === "error");
}

function setBusy(isBusy) {
  document.body.classList.toggle("is-busy", isBusy);
  ui.enableButton.textContent = isBusy && !active ? "Working..." : "Enable audio processing";
}

function upsertDevice(device) {
  if (!device?.deviceId) {
    return;
  }

  const index = devices.findIndex((item) => item.deviceId === device.deviceId);
  if (index >= 0) {
    devices[index] = {
      ...devices[index],
      label: device.label || devices[index].label
    };
  } else {
    devices.push(device);
  }
}

function mergeSupport(nextSupport = {}) {
  support = { ...support, ...nextSupport };
}

async function loadStoredOutputDevices() {
  try {
    const values = await chrome.storage.local.get("knownOutputDevices");
    return Array.isArray(values.knownOutputDevices) ? values.knownOutputDevices : [];
  } catch (error) {
    console.debug("Unable to load stored output devices", error);
    return [];
  }
}

function formatPan(pan) {
  if (Math.abs(pan) < 0.01) {
    return "Center";
  }
  return pan < 0 ? `${Math.round(Math.abs(pan) * 100)}% L` : `${Math.round(pan * 100)}% R`;
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("No active tab was found.");
  }
  return tab;
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function normalizeError(error) {
  if (!error) {
    return "Unknown error.";
  }
  return error.message || String(error);
}
