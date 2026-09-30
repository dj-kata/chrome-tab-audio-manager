# Tab Audio Router

Tab Audio Router is a Chrome Manifest V3 extension that captures the current tab's audio and replays it through the Web Audio API so each captured tab can have its own volume, stereo pan, and output device setting.

## Supported Environment

- Google Chrome 116 or later
- Windows 11 is the primary target
- Manifest V3
- No npm install or build step is required

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this repository directory.

## Usage

1. Open a tab that is playing audio.
2. Open the extension popup.
3. Click **Enable audio processing**.
4. Adjust **Volume** from 0% to 200%.
5. Adjust **Pan** from left to right.
6. Choose an output device from **Output**, or click **Add / Select audio device** if Chrome needs explicit permission for a non-default device.
7. Click **Stop processing** to return the tab to normal Chrome playback.

Multiple tabs can be processed at the same time. Each tab has an independent in-session audio session.

## Permissions

- `activeTab`: reads and starts processing the tab the user is currently operating from the popup.
- `tabCapture`: captures audio from the selected tab after the user clicks the enable button.
- `offscreen`: creates an offscreen document where Web Audio can run outside the Manifest V3 service worker.
- `storage`: stores the current tab's volume, pan, and selected output device while the tab exists.

The extension does not request host permissions such as `<all_urls>` and does not send user data anywhere.

## Output Device Permission

Chrome may require the user to explicitly approve non-default audio output devices. The popup uses `navigator.mediaDevices.selectAudioOutput()` when available. If that API is unavailable, the **Add / Select audio device** button opens `device-permission.html` in a normal extension tab. That page requests temporary microphone access with `navigator.mediaDevices.getUserMedia({ audio: true })`, immediately stops the stream, stores the exposed output devices, and lets the popup use them after it is reopened. The offscreen audio session applies the selected device with `AudioContext.setSinkId()`.

If `AudioContext.setSinkId()` or audio output selection is unavailable in the current Chrome build, the extension keeps volume and pan processing enabled and disables only output device routing.

## Architecture

- `service-worker.js`: handles popup requests, creates the offscreen document, obtains `chrome.tabCapture.getMediaStreamId()` IDs, stores tab settings, and cleans up closed tabs.
- `offscreen.html` / `offscreen.js`: turns tab stream IDs into `MediaStream` objects, owns per-tab `AudioSession` objects, and connects `MediaStreamAudioSourceNode -> GainNode -> StereoPannerNode -> AudioContext.destination`.
- `popup.html` / `popup.css` / `popup.js`: displays the current tab controls, lists output devices when possible, and reports user-facing errors.

## Known Limitations

- Chrome internal pages such as `chrome://` pages cannot be captured.
- Device labels may be blank until Chrome grants media device permission.
- A selected output device can disappear. In that case the extension falls back to System Default.
- Navigation within a captured tab is allowed to continue when Chrome keeps the captured stream alive. If the stream ends, the session is cleaned up.
- `tabId` settings are stored only for the lifetime of that tab and should not be treated as stable after Chrome restarts.

## Development And Debugging

- Load the repository with **Load unpacked** and inspect errors from `chrome://extensions`.
- Click **service worker** on the extension card to inspect background logs.
- Inspect the extension popup by right-clicking the popup and choosing **Inspect**.
- Test with two separate audio-playing tabs to verify independent volume, pan, and output settings.

## Manual Verification Checklist

1. The extension loads unpacked without Manifest V3 errors.
2. A normal audio-playing tab can be enabled from the popup.
3. Audio remains audible after enabling processing.
4. Volume 0% is silent.
5. Volume 100% is approximately original volume.
6. Left pan removes the right side.
7. Right pan removes the left side.
8. Center pan returns normal stereo.
9. Output devices can be selected when supported by Chrome.
10. Two tabs can be captured at the same time with different volume and pan settings.
11. Stop processing closes the stream and audio context.
12. Closing a captured tab cleans up its session.
13. Errors are shown in the popup instead of only in the console.
