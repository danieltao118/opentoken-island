# Windows GUI

OpenToken Island now has a Windows tray shell powered by Tauri.

The Windows app keeps the existing architecture:

- `server.js` remains the local OpenToken proxy and API server.
- `popover.html` remains the compact stats panel.
- `island.html` remains the small notification surface.
- The Tauri app provides the native tray icon, menu, and WebView windows.

## Requirements

- Windows 10 or newer.
- Rust and Cargo.
- Node.js.
- Microsoft Edge WebView2 Runtime.
- Microsoft C++ Build Tools for local Tauri builds.

.NET SDK is not required.

## Run In Development

```powershell
npm install
npm run tauri:dev
```

The tray icon appears in the Windows notification area.

- Hover the tray icon to show the full quota panel temporarily near the notification area.
- Left click the tray icon to pin the prewarmed detail panel so it stays open.
- Right click the tray icon to open the menu.
- Use `Show Island` to display the compact notification window.
- Use `Open Browser UI` to open `http://127.0.0.1:4174/popover.html`.
- Use `Open Logs` to open `%USERPROFILE%\.opentoken\island-events.log`.

The panel and island WebViews are created hidden during startup. Hover uses the same `popover.html` panel as the main UI; left click switches that panel into a pinned state. The floating panel is borderless, transparent, clamped to the current monitor work area, keeps a 430 px gap from the tray anchor so it floats above the Windows hidden-icons flyout, and includes extra transparent padding so the glass panel shadow and rounded corners are not clipped.

If port `4174` is already open, the Tauri app reuses the existing local server. If the port is closed, it starts `server.js` with:

```text
OPENTOKEN_ISLAND_PORT=4174
OPENTOKEN_BIN=%USERPROFILE%\.local\bin\opentoken.exe
```

On Windows, the shell prefers `%USERPROFILE%\.local\bin\opentoken.exe` and falls back to `%USERPROFILE%\.opentoken\bin\opentoken.exe` for older installs.

## Build Installer

```powershell
npm run tauri:build
```

Successful builds are written under:

```text
src-tauri\target\release\bundle\
```

The configured bundle target is NSIS.

## Verify

```powershell
npm test
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

The quick helper-only test can be run without compiling all Tauri dependencies:

```powershell
rustc --test src-tauri\src\windows_support.rs -o src-tauri\target-windows-support-tests.exe
.\src-tauri\target-windows-support-tests.exe
```

## Notes

The existing browser fallback remains useful. It lets OpenToken Island work even when the native tray app is not running, and it keeps the Windows Tauri shell thin.
