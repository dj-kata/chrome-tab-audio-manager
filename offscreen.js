const sessions = new Map();
const DEFAULT_DEVICE_ID = "default";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "offscreen") {
    return false;
  }

  handleMessage(message)
    .then(sendResponse)
    .catch((error) => {
      console.error("Offscreen request failed", message, error);
      sendResponse({ ok: false, error: normalizeError(error) });
    });
  return true;
});

async function handleMessage(message) {
  switch (message.type) {
    case "START_CAPTURE":
      return startCapture(message.tabId, message.streamId, message.settings);
    case "STOP_CAPTURE":
      return stopCapture(message.tabId, "Stopped.");
    case "SET_VOLUME":
      return setVolume(message.tabId, message.volume);
    case "SET_PAN":
      return setPan(message.tabId, message.pan);
    case "SET_LIMITER":
      return setLimiter(message.tabId, message.limiterEnabled);
    case "SET_OUTPUT_DEVICE":
      return setOutputDevice(message.tabId, message.outputDeviceId);
    case "GET_SESSION_STATE":
      return getSessionState(message.tabId);
    case "LIST_OUTPUT_DEVICES":
      return listOutputDevices();
    case "TAB_CLOSED":
      return stopCapture(message.tabId, "Tab closed.");
    case "TAB_NAVIGATED":
      return handleTabNavigated(message.tabId);
    default:
      throw new Error(`Unknown offscreen message type: ${message.type}`);
  }
}

async function startCapture(tabId, streamId, settings = {}) {
  await stopCapture(tabId, "Restarting capture.");

  const volume = clampNumber(settings.volume, 0, 6, 1);
  const pan = clampNumber(settings.pan, -1, 1, 0);
  const limiterEnabled = Boolean(settings.limiterEnabled);
  const outputDeviceId = normalizeDeviceId(settings.outputDeviceId);
  const stream = await getTabMediaStream(streamId);
  const audioContext = new AudioContext();
  const sourceNode = audioContext.createMediaStreamSource(stream);
  const gainNode = audioContext.createGain();
  const panNode = audioContext.createStereoPanner();
  const compressorNode = audioContext.createDynamicsCompressor();
  configureLimiter(compressorNode);

  gainNode.gain.value = volume;
  panNode.pan.value = pan;
  sourceNode.connect(gainNode).connect(panNode);

  const session = {
    tabId,
    stream,
    audioContext,
    sourceNode,
    gainNode,
    panNode,
    compressorNode,
    outputDeviceId,
    volume,
    pan,
    limiterEnabled,
    error: ""
  };

  connectAudioGraph(session);

  stream.getAudioTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      const activeSession = sessions.get(tabId);
      if (activeSession?.stream === stream) {
        activeSession.error = "The captured tab audio stream ended.";
        cleanupSession(activeSession);
        sessions.delete(tabId);
      }
    });
  });

  sessions.set(tabId, session);

  const outputResult = await applyOutputDevice(session, outputDeviceId);
  if (!outputResult.ok) {
    session.error = outputResult.error;
  }

  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  return {
    ok: true,
    state: serializeSession(session),
    support: getOutputSupport(),
    output: outputResult
  };
}

async function stopCapture(tabId, reason) {
  const session = sessions.get(tabId);
  if (!session) {
    return { ok: true, active: false, message: reason || "No active session." };
  }

  await cleanupSession(session);
  sessions.delete(tabId);
  return { ok: true, active: false, message: reason || "Stopped." };
}

async function setVolume(tabId, value) {
  const session = requireSession(tabId);
  session.volume = clampNumber(value, 0, 6, 1);
  session.gainNode.gain.setTargetAtTime(session.volume, session.audioContext.currentTime, 0.01);
  return { ok: true, state: serializeSession(session) };
}

async function setPan(tabId, value) {
  const session = requireSession(tabId);
  session.pan = clampNumber(value, -1, 1, 0);
  session.panNode.pan.setTargetAtTime(session.pan, session.audioContext.currentTime, 0.01);
  return { ok: true, state: serializeSession(session) };
}

async function setLimiter(tabId, value) {
  const session = requireSession(tabId);
  session.limiterEnabled = Boolean(value);
  connectAudioGraph(session);
  return { ok: true, state: serializeSession(session) };
}

async function setOutputDevice(tabId, outputDeviceId) {
  const session = requireSession(tabId);
  const requestedDeviceId = normalizeDeviceId(outputDeviceId);
  const result = await applyOutputDevice(session, requestedDeviceId);
  return { ...result, state: serializeSession(session) };
}

function getSessionState(tabId) {
  const session = sessions.get(tabId);
  if (!session) {
    return {
      ok: true,
      active: false,
      state: null,
      support: getOutputSupport()
    };
  }

  return {
    ok: true,
    active: true,
    state: serializeSession(session),
    support: getOutputSupport()
  };
}

async function listOutputDevices() {
  return {
    ok: true,
    devices: await enumerateAudioOutputs(),
    support: getOutputSupport()
  };
}

async function handleTabNavigated(tabId) {
  const session = sessions.get(tabId);
  if (!session) {
    return { ok: true, active: false };
  }

  if (session.stream.getAudioTracks().some((track) => track.readyState === "ended")) {
    await stopCapture(tabId, "The tab navigated and the captured audio stream ended.");
    return { ok: true, active: false, message: "The tab navigated and capture stopped." };
  }

  return { ok: true, active: true, state: serializeSession(session) };
}

async function getTabMediaStream(streamId) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
  } catch (error) {
    throw new Error(`Could not open captured tab audio: ${normalizeError(error)}`);
  }
}

async function applyOutputDevice(session, outputDeviceId) {
  if (!supportsAudioContextSinkId()) {
    session.outputDeviceId = DEFAULT_DEVICE_ID;
    return {
      ok: false,
      error: "This Chrome build does not support AudioContext output device selection."
    };
  }

  try {
    await session.audioContext.setSinkId(outputDeviceId);
    session.outputDeviceId = outputDeviceId;
    session.error = "";
    return { ok: true };
  } catch (error) {
    console.warn("setSinkId failed; falling back to system default", error);
    try {
      await session.audioContext.setSinkId(DEFAULT_DEVICE_ID);
    } catch (fallbackError) {
      console.warn("setSinkId default fallback failed", fallbackError);
    }
    session.outputDeviceId = DEFAULT_DEVICE_ID;
    session.error = "The selected output device is unavailable. Using System Default.";
    return { ok: false, error: session.error };
  }
}

async function enumerateAudioOutputs() {
  const devices = [{ deviceId: DEFAULT_DEVICE_ID, label: "System Default" }];

  if (!navigator.mediaDevices?.enumerateDevices) {
    return devices;
  }

  try {
    const mediaDevices = await navigator.mediaDevices.enumerateDevices();
    const outputs = mediaDevices
      .filter((device) => device.kind === "audiooutput")
      .filter((device) => device.deviceId && device.deviceId !== DEFAULT_DEVICE_ID)
      .map((device) => ({
        deviceId: device.deviceId,
        label: device.label || "Audio output device"
      }));

    const seen = new Set(devices.map((device) => device.deviceId));
    for (const device of outputs) {
      if (!seen.has(device.deviceId)) {
        devices.push(device);
        seen.add(device.deviceId);
      }
    }
  } catch (error) {
    console.warn("Unable to enumerate output devices", error);
  }

  return devices;
}

async function cleanupSession(session) {
  try {
    session.sourceNode.disconnect();
    session.gainNode.disconnect();
    session.panNode.disconnect();
    session.compressorNode.disconnect();
  } catch (error) {
    console.debug("Audio node disconnect failed", error);
  }

  for (const track of session.stream.getTracks()) {
    track.stop();
  }

  if (session.audioContext.state !== "closed") {
    await session.audioContext.close();
  }
}

function connectAudioGraph(session) {
  try {
    session.panNode.disconnect();
    session.compressorNode.disconnect();
  } catch (error) {
    console.debug("Audio graph reconnect cleanup failed", error);
  }

  if (session.limiterEnabled) {
    session.panNode.connect(session.compressorNode).connect(session.audioContext.destination);
  } else {
    session.panNode.connect(session.audioContext.destination);
  }
}

function configureLimiter(compressorNode) {
  compressorNode.threshold.value = -3;
  compressorNode.knee.value = 0;
  compressorNode.ratio.value = 20;
  compressorNode.attack.value = 0.003;
  compressorNode.release.value = 0.1;
}

function requireSession(tabId) {
  const session = sessions.get(tabId);
  if (!session) {
    throw new Error("Audio processing is not enabled for this tab.");
  }
  return session;
}

function serializeSession(session) {
  return {
    active: true,
    volume: session.volume,
    pan: session.pan,
    limiterEnabled: session.limiterEnabled,
    outputDeviceId: session.outputDeviceId,
    audioContextState: session.audioContext.state,
    error: session.error || ""
  };
}

function getOutputSupport() {
  return {
    setSinkId: supportsAudioContextSinkId(),
    selectAudioOutput: Boolean(navigator.mediaDevices?.selectAudioOutput),
    enumerateDevices: Boolean(navigator.mediaDevices?.enumerateDevices)
  };
}

function supportsAudioContextSinkId() {
  return typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
}

function normalizeDeviceId(deviceId) {
  return deviceId || DEFAULT_DEVICE_ID;
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
