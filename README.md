# Metasteps Orientation Guide – Custom Recognition Edition

English | [Deutsch](README.de.md)

This repository contains the exhibition-specific `v0.10.1` edition of the Metasteps browser guide. It provides a German, menu-driven tutorial for mouse controls, map navigation, exhibit interaction, and local recognition of the six exhibits configured for the original installation.

The extension runs only on desktop Chrome and Edge pages matching `https://*.metasteps.com/viewer/*`.

## Features

- German step-by-step guidance for movement, map use, and exhibit interaction.
- Automatic narration when the guide opens and whenever a new step appears.
- Local, on-demand recognition for the exhibition it was configured for.
- Local screenshot processing; no recognition image is uploaded to a server.
- A manual continuation path when recognition cannot determine the current state.

## Installation

1. Download or clone this repository.
2. Open `chrome://extensions/` in Chrome or `edge://extensions/` in Edge.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose this directory, which contains `manifest.json`.
6. Open or refresh a matching Metasteps Viewer page.

The guide opens automatically on a supported Viewer page. The browser toolbar button can reopen or close it.

## Repository contents

- `src/` – extension runtime code and German guide flows.
- `assets/reference-scenes/` – reference scenes used by the configured recognition flow.
- `assets/reference-source/map-open/` – map-state references required at runtime.
- `assets/runtime-references/` – compact local recognition catalog and runtime references.
- `tests/` – manifest, asset, flow, and capture-worker checks for this public edition.

Large offline training captures, generated 3D/model material, internal worktrees, and development renders are intentionally not included. They are not required to load or run the extension.

## Verification

Node.js 18 or newer is recommended. Run:

```powershell
npm test
```

## Privacy and permissions

Recognition is performed locally in the browser. Screenshots are used only for the active recognition attempt and are not uploaded by the extension. The extension requests `activeTab` and `<all_urls>` because its background worker must capture the currently visible tab; the content script itself is restricted to Metasteps Viewer pages.

## Scope

This edition is customized for one exhibition and its configured exhibit references. It should not be presented as a universal recognition system. For other exhibitions, use the Universal Guide edition.
