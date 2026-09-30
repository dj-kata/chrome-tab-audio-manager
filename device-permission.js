const grantButton = document.getElementById("grantButton");
const statusElement = document.getElementById("status");
const deviceList = document.getElementById("deviceList");

grantButton.addEventListener("click", grantAudioDeviceAccess);
document.addEventListener("DOMContentLoaded", refreshDeviceList);

async function grantAudioDeviceAccess() {
  if (!navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices) {
    showStatus("This browser cannot request or list audio devices from this extension page.", "error");
    return;
  }

  let stream;
  grantButton.disabled = true;
  showStatus("Requesting audio device access...", "ok");

  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const outputs = await enumerateAudioOutputs();
    await chrome.storage.local.set({ knownOutputDevices: outputs });
    renderDevices(outputs);

    if (outputs.length <= 1) {
      showStatus("Access was granted, but no non-default output devices were exposed.", "error");
      return;
    }

    showStatus("Audio devices saved. Return to the Tab Audio Router popup and choose an output.", "ok");
  } catch (error) {
    showStatus("Audio device access was not granted: " + normalizeError(error), "error");
  } finally {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
    }
    grantButton.disabled = false;
  }
}

async function refreshDeviceList() {
  const values = await chrome.storage.local.get("knownOutputDevices");
  if (Array.isArray(values.knownOutputDevices)) {
    renderDevices(values.knownOutputDevices);
  }
}

async function enumerateAudioOutputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const outputs = [
    { deviceId: "default", label: "System Default" },
    ...devices
      .filter((device) => device.kind === "audiooutput" && device.deviceId !== "default")
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label || "Audio output device"
      }))
  ];

  const seen = new Set();
  return outputs.filter((device) => {
    if (!device.deviceId || seen.has(device.deviceId)) {
      return false;
    }
    seen.add(device.deviceId);
    return true;
  });
}

function renderDevices(devices) {
  deviceList.replaceChildren(
    ...devices.map((device) => {
      const item = document.createElement("li");
      item.textContent = device.label || "Audio output device";
      return item;
    })
  );
}

function showStatus(message, kind) {
  statusElement.textContent = message;
  statusElement.className = `status ${kind}`;
}

function normalizeError(error) {
  if (!error) {
    return "Unknown error.";
  }
  return error.message || String(error);
}
