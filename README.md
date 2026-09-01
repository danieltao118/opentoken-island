# OpenToken Island

A macOS menu bar companion for OpenToken.

It combines:

- A real macOS status bar item
- A compact Apple-style Dynamic Island event popup
- A popover extension panel with rank, quota, agent usage, and GLM trend data
- Live data from the local `opentoken` CLI
- Manual upload through `opentoken upload`

## Install Locally

Install the app:

```bash
./scripts/install.sh
```

The installer:

- Finds an existing local `opentoken` binary from `PATH`, `~/.local/bin`, Homebrew, or common app folders
- Reads `~/.opentoken/config.json`
- Stores the original scys upload URL in `~/.opentoken/island-state.json`
- Rewrites `webhook_url` to the local proxy at `http://127.0.0.1:4174/...`
- Builds and installs `/Applications/OpenToken Island.app`
- Registers a login LaunchAgent at `~/Library/LaunchAgents/com.opentoken.island.plist`

After that, OpenToken keeps using its own upload mechanism. OpenToken Island validates the aggregate payload against a strict allowlist, forwards only the approved SCYS protocol fields, maintains a local aggregate snapshot, and renders independent local, GLM, and leaderboard views.

If `opentoken` is installed in a non-standard location, pass it explicitly:

```bash
OPENTOKEN_BIN="/path/to/opentoken" ./scripts/install.sh
```

The local API port defaults to `4174`; override it with `OPENTOKEN_ISLAND_PORT=4175` if needed.

## Windows GUI

Windows support is implemented as a Tauri tray shell around the existing local proxy and Web UI. It does not require .NET SDK.

See [docs/windows-gui.md](docs/windows-gui.md) for setup, development, and build commands.

## Data semantics and privacy

- **Local actual Token** is raw usage from this computer only. It is never merged with SCYS leaderboard score.
- **GLM quota and 24h/7d/30d trends** come only from the configured Z.ai usage API and retain the latest successful aggregate buckets locally.
- **SCYS score/rank/tool composition/city** comes only from the SCYS leaderboard response. Hermes and OpenClaw from other computers appear in this section, not in the local total.
- First-time bind only appears when this computer has not matched the personal public row yet; the panel does not offer switching accounts afterward. The choice is a public leaderboard ID stored only on this computer; switching the SCYS webhook account clears the prior binding and leaderboard state.
- City rank is shown only when the bound user ID is found in a public city board (`?city=`). The client does not guess a city from member counts.
- Uploads reject unknown fields and sensitive-looking values, pin the destination to the SCYS HTTPS endpoint, and persist only aggregate summaries, status, and payload hashes.
- `/api/summary` reads local projections only; scans and network refreshes run through the background coordinator. GLM fallback is period-specific and expires after 12 hours instead of being shown indefinitely.

The non-negotiable invariants and compatibility rules are documented in [docs/data-contract.md](docs/data-contract.md).

## Build Installer Package

Build a local macOS installer package:

```bash
./scripts/build-pkg.sh
```

The package installs `OpenToken Island.app` into `/Applications`, writes the user LaunchAgent, and starts the menu bar app after install. The App icon is generated from the circular SCYS symbol in `assets/scys/icon_topnav.png`.

## Debug Island Popup

Trigger the Dynamic Island popup once:

```bash
curl -sS -X POST "http://127.0.0.1:4174/api/debug/island"
```

Watch the listener log:

```bash
tail -f ~/.opentoken/island-events.log
```

## Files

- `OpenTokenIsland.swift` - native AppKit menu bar shell
- `server.js` - local API bridge to the `opentoken` CLI
- `popover.html` - extension popover UI
- `island.html` - Dynamic Island notification UI
- `index.html` - browser dashboard backed by the same live summary API
- `scripts/install.sh` - local installer and OpenToken detector
- `scripts/build-pkg.sh` - macOS `.pkg` installer builder
