# Custom Windows build

This unsigned OpenWhispr 1.10.2 build adds three changes:

- OpenRouter requests can pin an upstream provider, including Groq when OpenRouter lists it for the selected model.
- **Escape cancels dictation** is off by default and can be enabled in **Settings > Hotkeys**.
- The built-in `OpenWhispr` assistant name is removed from the custom dictionary. User-chosen assistant names remain supported.

Revision 5 restores the official OpenWhispr API and authentication endpoints that were missing from revision 4. The build now fails before packaging if either endpoint is absent, and its rendered Speech-to-Text and Dictation Cleanup panels are verified from the final packaged application.

The build keeps the official application ID, product name, production profile path, and Windows Credential Manager service. Install it over the existing copy under the same Windows account. Do not uninstall OpenWhispr or delete `%APPDATA%\open-whispr` first.

The installer is unsigned. Windows displays an unknown-publisher warning. The workflow builds it from the public source in this repository and publishes a SHA-256 file beside the EXE.

On a prepared Windows builder, run `pwsh -File scripts/build-custom-windows.ps1`. After `gh auth login`, run `pwsh -File scripts/build-custom-windows.ps1 -PublishOnly` to publish the verified files.
