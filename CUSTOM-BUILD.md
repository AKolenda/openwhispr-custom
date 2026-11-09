# Custom Windows build

This unsigned OpenWhispr 1.10.2 build adds three changes:

- OpenRouter requests can pin an upstream provider, including Groq when OpenRouter lists it for the selected model.
- **Escape cancels dictation** is off by default and can be enabled in **Settings > Hotkeys**.
- The built-in `OpenWhispr` assistant name is removed from the custom dictionary. User-chosen assistant names remain supported.

Revision 5 restores the official OpenWhispr API and authentication endpoints that were missing from revision 4.

Revision 6 adds Grok STT streaming: with xAI as the dictation provider on your own key, dictation streams to xAI while you speak and the text is ready about 0.2 s after you stop, with the live preview updating about every half second (see "Custom Linux build" below).

The build keeps the official application ID, product name, production profile path, and Windows Credential Manager service. Install it over the existing copy under the same Windows account. Do not uninstall OpenWhispr or delete `%APPDATA%\open-whispr` first.

The installer is unsigned. Windows displays an unknown-publisher warning. The workflow builds it from the public source in this repository and publishes a SHA-256 file beside the EXE.

On a prepared Windows builder, run `pwsh -File scripts/build-custom-windows.ps1`. After `gh auth login`, run `pwsh -File scripts/build-custom-windows.ps1 -PublishOnly` to publish the built files.

# Custom Linux build

The Linux build adds one change on top of the Windows build's three:

- **Grok STT streams while you speak.** With xAI as the dictation provider on your own key, dictation sends 16 kHz PCM to `wss://api.x.ai/v1/stt` as it is heard (`src/helpers/xaiStreaming.js`). On stop it sends `audio.done` and waits for `transcript.done`, about 0.1–0.2 s, instead of uploading the whole clip. If the stream fails, or hasn't answered 2.5 s after the audio ended, the WebM recording is uploaded as before. Notes and meetings keep their own providers.

Build it on Linux x64 with Node 24:

1. `npm ci`, then `npm run prebuild:linux`.
2. `resources/bin/linux-fast-paste` needs the X11, XTest, GIO and AT-SPI headers (`libx11-dev libxtst-dev libxext-dev libglib2.0-dev libatspi2.0-dev`). Without them the prebuild silently drops portal paste and the pill's input region, so check its log. Copy `linux-system-audio-helper` from an official build if `gio-2.0` and PipeWire headers are missing.
3. Write `.env` with `OPENWHISPR_CHANNEL=production` and the calendar client IDs, as the Windows workflow does.
4. With `umask 022`, so every packaged file stays readable: `VITE_OPENWHISPR_API_URL=https://api.openwhispr.com VITE_AUTH_URL=https://auth.openwhispr.com npm run build:renderer`, then `npx electron-builder --linux deb --x64 --publish never --config electron-builder.custom-linux.json`.

Install the .deb over the existing package with `sudo dpkg -i`. The profile in `~/.config/open-whispr` is kept.
