const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

const pkg = readJson("package.json");
assert.equal(pkg.scripts.test, "node tests/windows_support_contract.test.cjs");
assert.equal(pkg.scripts["tauri:dev"], "tauri dev");
assert.equal(pkg.scripts["tauri:build"], "tauri build");
assert.equal(pkg.devDependencies["@tauri-apps/cli"], "^2.11.3");

const config = readJson("src-tauri/tauri.conf.json");
assert.equal(config.identifier, "com.opentoken.island.windows");
assert.equal(config.productName, "OpenToken Island");
assert.equal(config.build.frontendDist, "../desktop-placeholder");
assert.equal(config.app.withGlobalTauri, false);
assert.deepEqual(config.bundle.targets, ["nsis"]);
assert.ok(config.bundle.icon.includes("icons/icon.png"));
assert.ok(config.bundle.icon.includes("icons/icon.ico"));
assert.ok(fs.existsSync(path.join(root, "src-tauri/icons/icon.ico")));

const cargoToml = fs.readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
assert.match(cargoToml, /tauri = \{ version = "2"/);
assert.match(cargoToml, /features = \["tray-icon", "image-png"\]/);

const mainRs = fs.readFileSync(path.join(root, "src-tauri/src/main.rs"), "utf8");
const popoverHtml = fs.readFileSync(path.join(root, "popover.html"), "utf8");
assert.match(
  mainRs,
  /#!\[cfg_attr\(\s*all\(not\(debug_assertions\), target_os = "windows"\),\s*windows_subsystem = "windows"\s*\)\]/,
  "Windows release builds must use GUI subsystem so no cmd window appears"
);
assert.match(
  mainRs,
  /prewarm_windows\(app\.handle\(\)\)\?/,
  "Panel WebView should be created hidden during setup so first tray hover/click is fast"
);
assert.match(
  mainRs,
  /ensure_startup_registration\(\)\?/,
  "Windows release builds must register the tray app in HKCU Run for startup residency"
);
assert.match(
  mainRs,
  /MenuItem::with_id\(app, "show-quota-bar", "Show Quota Bar"/,
  "Tray menu must expose a persistent Coding Quota Bar style compact window"
);
assert.match(
  mainRs,
  /MenuItem::with_id\(app, "hide-quota-bar", "Hide Quota Bar"/,
  "Tray menu must let users hide the persistent compact quota bar"
);
assert.match(
  mainRs,
  /ensure_quota_bar_window\(app\)\?/,
  "The persistent quota bar should be prewarmed so opening it is fast"
);
assert.match(
  mainRs,
  /fn show_quota_bar\([\s\S]*?window\.show\(\)\?;[\s\S]*?Ok\(\(\)\)/,
  "Show Quota Bar must reveal the compact window"
);
assert.doesNotMatch(
  mainRs.match(/fn show_quota_bar[\s\S]*?fn /)?.[0] || "",
  /schedule_hide_island|schedule_hide_quota_bar/,
  "Show Quota Bar must stay resident instead of auto-hiding after a timer"
);
assert.match(
  mainRs,
  /TrayIconEvent::Enter[\s\S]*show_hover_panel/,
  "Tray hover must show the full quota panel when the cursor enters the tray icon"
);
assert.match(
  mainRs,
  /TrayIconEvent::Move[\s\S]*show_hover_panel/,
  "Tray hover should keep the full quota panel aligned while the cursor moves over the tray icon"
);
assert.match(
  mainRs,
  /TrayIconEvent::Leave[\s\S]*schedule_hide_panel/,
  "Tray hover must schedule the panel to hide after the cursor leaves the tray icon"
);
assert.match(
  mainRs,
  /TrayIconEvent::Click[\s\S]*pin_panel/,
  "Left click must pin the panel so it stays visible"
);
assert.match(
  mainRs,
  /WindowEvent::Focused\(false\)[\s\S]*hide_pinned_panel_on_blur/,
  "Pinned tray panel must hide when the user clicks outside and the window loses focus"
);
assert.match(
  mainRs,
  /external_url\("popover\.html"\)[\s\S]*WebviewWindowBuilder::new\(app, PANEL_LABEL/,
  "The tray panel must render the same popover UI used by the browser panel"
);
assert.match(
  mainRs,
  /WebviewWindowBuilder::new\(app, PANEL_LABEL[\s\S]*\.decorations\(false\)[\s\S]*\.transparent\(true\)[\s\S]*\.skip_taskbar\(true\)[\s\S]*\.always_on_top\(true\)/,
  "The tray panel must be a transparent, borderless floating layer"
);
assert.match(
  mainRs,
  /const PANEL_ANCHOR_GAP: i32 = 430;/,
  "The full tray panel should lift as far as possible above the Windows hidden-icons flyout"
);
assert.match(
  mainRs,
  /floating_position\(\s*app,\s*cursor,\s*rect,\s*PANEL_WINDOW_WIDTH,\s*PANEL_WINDOW_HEIGHT,\s*FLOATING_MARGIN,\s*PANEL_ANCHOR_GAP,?\s*\)/,
  "The full tray panel must use a larger anchor gap than the screen edge clamp margin"
);
assert.doesNotMatch(
  mainRs,
  /show_hover_island/,
  "Hover must not use the short island surface"
);
assert.match(
  popoverHtml,
  /backdrop-filter:blur\(26px\)/,
  "Popover panel should use glass blur for a refined floating surface"
);
assert.match(
  popoverHtml,
  /background:linear-gradient\([^;]+rgba\(18,18,20,\.82\)/,
  "Popover panel should have translucent glass background"
);
assert.match(
  popoverHtml,
  /body\{[^}]*padding:18px/,
  "Popover body should leave enough transparent padding for shadow and rounded corners"
);
assert.match(popoverHtml, /quotaList/, "Popover must render GLM/GPT quota rows");

const windowsSupport = fs.readFileSync(path.join(root, "src-tauri/src/windows_support.rs"), "utf8");
assert.match(
  windowsSupport,
  /STARTUP_RUN_KEY: &str = r"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"/,
  "Startup registration must use the current user's Run key"
);
assert.match(
  windowsSupport,
  /STARTUP_RUN_VALUE_NAME: &str = "OpenTokenIsland"/,
  "Startup Run value should be stable across releases"
);
assert.match(
  windowsSupport,
  /startup_registry_args\(exe: &Path\) -> Vec<String>/,
  "Startup registry arguments should be generated in a testable helper"
);

const serverJs = fs.readFileSync(path.join(root, "server.js"), "utf8");
assert.match(serverJs, /CODING_QUOTA_CONFIG_PATH/, "Server must know where Coding Quota Bar stores provider config");
assert.match(serverJs, /fetchZaiQuota/, "Server must fetch the existing Z AI quota feed");
assert.match(serverJs, /quotaFeeds/, "Summary payload must expose quota feeds to the UI");
assert.match(serverJs, /function normalizeToolName/, "Tool names should be normalized before ranking");
assert.match(serverJs, /glm[\s\S]*GLM \/ Z\.ai/, "GLM/Z.ai usage should have an explicit label");
assert.match(serverJs, /gpt[\s\S]*GPT \/ OpenAI/, "GPT/OpenAI usage should have an explicit label");

console.log("windows scaffold contract ok");
