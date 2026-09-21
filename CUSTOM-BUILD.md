# Custom Windows build

This unsigned OpenWhispr 1.10.2 build adds three changes:

- OpenRouter requests can pin an upstream provider, including Groq when OpenRouter lists it for the selected model.
- **Escape cancels dictation** is off by default and can be enabled in **Settings > Hotkeys**.
- The built-in `OpenWhispr` assistant name is removed from the custom dictionary. User-chosen assistant names remain supported.

The build keeps the official application ID, product name, production profile path, and Windows Credential Manager service. Install it over the existing copy under the same Windows account. Do not uninstall OpenWhispr or delete `%APPDATA%\open-whispr` first.

The installer is unsigned. Windows displays an unknown-publisher warning. The workflow builds it from the public source in this repository and publishes a SHA-256 file beside the EXE.
