# Windows Tauri GUI Design

## Goal

Build a Windows desktop companion for OpenToken Island that behaves like a native tray app while reusing the existing local OpenToken proxy and Web UI.

## Current Context

The repository currently contains a macOS AppKit shell (`OpenTokenIsland.swift`), a cross-platform Node local proxy (`server.js`), and browser-rendered UI pages (`popover.html`, `island.html`, `index.html`). On this Windows machine, `server.js` already runs at `http://127.0.0.1:4174`, captures OpenToken uploads, forwards them to `scys.com`, and exposes `/api/summary` and `/api/upload`.

## Product Decision

Use Tauri for the Windows GUI. Do not install or depend on the .NET SDK for this implementation. Tauri gives us a native Windows tray shell and WebView-backed windows while preserving the existing HTML UI. The first Windows version should not rewrite the data layer into Rust; it should launch and supervise the existing Node server.

## UX Shape

The app is primarily a tray utility, not a large dashboard.

- Left click the tray icon to open a compact stats panel.
- Right click the tray icon to show menu actions.
- The panel loads the existing `popover.html` from the local server.
- A separate small borderless window loads `island.html` for upload/rank feedback.
- Menu actions include open panel, show island, open browser UI, open logs, and quit.
- The panel remains visually consistent with the existing dark SCYS/OpenToken style.

## Architecture

The Windows Tauri shell owns native integration:

- Creates the system tray icon and menu.
- Starts `server.js` if port `4174` is not already listening.
- Passes `OPENTOKEN_ISLAND_PORT=4174` and the detected OpenToken binary to the Node process, preferring `%USERPROFILE%\.local\bin\opentoken.exe` and falling back to `%USERPROFILE%\.opentoken\bin\opentoken.exe`.
- Opens local WebView windows pointing at `http://127.0.0.1:4174/popover.html` and `http://127.0.0.1:4174/island.html`.
- Terminates only the child server process it started. If an external Island server is already running, it leaves it alone.

The Node proxy remains responsible for:

- Maintaining `~/.opentoken/config.json` proxy routing.
- Capturing and forwarding upload payloads.
- Fetching leaderboard data.
- Serving the UI assets.

## Files

Expected new files:

- `package.json` - npm scripts and Tauri CLI dev dependency.
- `src-tauri/Cargo.toml` - Rust package and Tauri dependencies.
- `src-tauri/build.rs` - Tauri build hook.
- `src-tauri/tauri.conf.json` - Windows app metadata and bundle settings.
- `src-tauri/src/main.rs` - Tauri entrypoint.
- `src-tauri/src/windows_support.rs` - testable helpers for port checks, paths, and process launch decisions.
- `src-tauri/icons/icon.png` - initial app icon derived from existing SCYS assets.
- `tests/windows_support_contract.test.cjs` - lightweight repository contract checks for scaffolded files.
- `docs/windows-gui.md` - user-facing build/run notes.

Existing files to keep:

- `server.js`
- `popover.html`
- `island.html`
- `assets/scys/*`

## Build And Runtime

Development command:

```powershell
npm install
npm run tauri dev
```

Validation command:

```powershell
npm test
npm run tauri build
```

The packaged Windows app should produce Tauri Windows bundle output under `src-tauri/target/release/bundle/` when the local build toolchain is available.

## Privacy And Safety

The app must not print or persist the full SCYS webhook URL in normal user-facing output. Existing OpenToken config remains in `C:\Users\ty\.opentoken`. The GUI reads local API summaries and does not upload code or conversation content.

## Non-Goals

- Do not port `server.js` to Rust in this iteration.
- Do not implement a .NET/WPF/WinUI version.
- Do not remove the browser UI fallback.
- Do not publish, push, or deploy anything externally.
- Do not require code signing for the first local build.

## Acceptance Criteria

- A Windows Tauri app builds locally or reports the exact missing prerequisite.
- The tray icon appears when launched.
- Opening the panel shows the existing OpenToken stats UI.
- The app starts `server.js` when port `4174` is closed.
- The app reuses an already-running server when port `4174` is open.
- Quitting the app does not kill an externally-started Island server.
- Existing browser fallback `http://127.0.0.1:4174/popover.html` still works.
