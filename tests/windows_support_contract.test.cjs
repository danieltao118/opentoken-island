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
assert.ok(config.bundle.resources.includes("../server.js"));
assert.ok(config.bundle.resources.includes("../popover.html"));
assert.ok(config.bundle.resources.includes("../island.html"));
assert.ok(config.bundle.resources.includes("../index.html"));
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
assert.match(popoverHtml, /quotaList/, "Popover must render the GLM quota module");
assert.match(popoverHtml, /renderQuotaItems/, "Popover quota cards must render nested quota items");
assert.match(popoverHtml, /quota-items/, "Popover quota UI should support multiple rows per provider");
assert.match(popoverHtml, /renderGlmQuotaCard/, "Popover should render one focused GLM quota card");
assert.match(popoverHtml, /quota-card-wide/, "GLM quota card should span the panel width");
assert.match(popoverHtml, /quotaRemainingText/, "Quota rows should emphasize the remaining percentage");
assert.doesNotMatch(popoverHtml, /item\.usageLabel\s*\|\|\s*item\.rawValueLabel\s*\|\|\s*item\.valueLabel/, "Quota rows should not repeat raw used/total values beside the remaining percentage");
assert.match(popoverHtml, /5小时额度/, "Popover should show the five-hour quota bucket");
assert.match(popoverHtml, /MCP额度/, "Popover should show the Z.ai MCP quota bucket");
assert.match(popoverHtml, /重置/, "Popover should show reset time details from Coding Quota Bar");
assert.match(popoverHtml, /\.bar\{display:block/, "Quota and tool progress bars should render as real horizontal bars");
assert.doesNotMatch(popoverHtml, /visibleTools\(data\.tools\)/, "Tool usage rows should show every tracked agent, including Codex");
assert.doesNotMatch(popoverHtml, /!\s*\/\^codex\$\/i\.test/, "Codex usage should not be filtered out of agent usage stats");
assert.match(popoverHtml, /id="pauseButton"/, "Pause button should have an explicit behavior hook");
assert.match(popoverHtml, /function toggleRefreshPause/, "Pause button should pause and resume panel auto-refresh");
assert.match(popoverHtml, /id="logButton"/, "Log icon button should have an explicit behavior hook");
assert.match(popoverHtml, /function openLogs/, "Log icon button should open the local event log");
assert.match(popoverHtml, /tool\.detail/, "Tool rows should expose the raw leaderboard score as secondary detail");
assert.match(popoverHtml, /id="usageTrend"/, "Panel bottom should show useful usage trend data");
assert.match(popoverHtml, /function renderUsageTrend/, "Panel should render GLM usage trend bars");
assert.match(popoverHtml, /trend-bars/, "GLM daily, seven-day, and thirty-day stats should render as bar charts");
assert.doesNotMatch(popoverHtml, /class="badges"|function renderBadges|function renderQuests|Hot Streak|Daily Quest/, "Low-value gamification badges and quests should not crowd out quota data");
assert.doesNotMatch(popoverHtml, /Codex Main/, "Static badge placeholders should not flash Codex while it is hidden");
assert.doesNotMatch(popoverHtml, /label: 'Codex'/, "Codex quota fallback should be hidden for now");
assert.doesNotMatch(popoverHtml, /Codex[\s\S]{0,80}周额度/, "Codex quota card should be hidden for now");
assert.doesNotMatch(popoverHtml, /Waiting GPT\/OpenAI rows/, "Quota UI should not show GPT/OpenAI as the Codex quota card");
assert.doesNotMatch(popoverHtml, /[^<]\/(?:span|strong)>/, "Popover HTML must not contain malformed closing tags that corrupt layout");
assert.doesNotMatch(popoverHtml, /\uFFFD|鎺|鐩|璇|绛|涓婃姤|浜縛|涓嘸/, "Popover must not contain mojibake strings");

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
assert.match(serverJs, /function zaiQuotaItems/, "Z.ai quota feed must expose split quota buckets");
assert.match(serverJs, /function codexQuotaItems/, "Codex quota feed must expose five-hour and weekly buckets");
assert.match(serverJs, /function quotaUsageLabel/, "Z.ai quota items must expose raw used/total labels like Coding Quota Bar");
assert.match(serverJs, /usageLabel/, "Z.ai quota items should include un-compacted usage labels for the UI");
assert.match(serverJs, /remainingLabel/, "Z.ai quota items should include remaining percentage labels");
assert.match(serverJs, /levelLabel/, "Z.ai quota feed should expose the Coding Plan level");
assert.match(serverJs, /readWindowsUserEnv/, "Server should read user-level Z_AI_API_KEY when the process env is stale");
assert.match(serverJs, /HKCU\\\\Environment/, "Windows user env lookup should use HKCU Environment");
assert.match(serverJs, /enc:/, "Encrypted Coding Quota Bar keys should not be sent as raw bearer tokens");
assert.match(serverJs, /function requestTextOnce/, "HTTP requests should be retryable after a DNS fallback");
assert.match(serverJs, /Resolve-DnsName/, "Windows Node DNS failures should fall back to the OS resolver");
assert.match(serverJs, /servername: target\.hostname/, "DNS fallback must keep the original TLS SNI host");
assert.match(serverJs, /DNS_FALLBACK_TTL_MS/, "Windows DNS fallback should be cached between quota refreshes");
assert.match(serverJs, /quota\/limit[\s\S]*30000,\s*2/, "Z.ai quota reads need enough timeout for DNS fallback");
assert.match(serverJs, /requestTextWithRetry\([\s\S]*quota\/limit/, "Z.ai quota reads should use retry logic");
assert.match(serverJs, /\/api\/open-logs/, "Server should expose an API endpoint for the log icon button");
assert.match(serverJs, /function openLogsFile/, "Server should open the local OpenToken Island event log");
assert.match(serverJs, /function buildSyncStatus/, "Summary payload must explain upload and leaderboard sync state");
assert.match(serverJs, /leaderboardMatched/, "Sync state must distinguish uploaded data from leaderboard matches");
assert.match(serverJs, /排行榜仅返回前/, "Sync detail should explain when the current account is not in the returned leaderboard page");
assert.match(serverJs, /function requestTextWithRetry/, "Upload forwarding should retry transient network failures");
assert.match(serverJs, /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT/, "Retry logic should cover common DNS and socket failures");
assert.match(serverJs, /requestTextWithRetry\("POST", upstreamUrl/, "OpenToken upload forwarding must use retry logic");
assert.match(serverJs, /5小时额度/, "Server should label the five-hour quota bucket");
assert.match(serverJs, /MCP额度/, "Server should label the Z.ai MCP quota bucket");
assert.match(serverJs, /周额度/, "Server should label the weekly quota bucket");
assert.match(serverJs, /Ready|准备|就绪|OpenToken/, "Service detection should treat a ready Windows scheduled task as healthy");
assert.match(serverJs, /function normalizeToolName/, "Tool names should be normalized before ranking");
assert.match(serverJs, /normalizedByTool/, "Upload summaries should preserve normalized usage per tool");
assert.match(serverJs, /function toolsFromUsageMaps/, "Tool usage rows should distinguish normalized usage from raw leaderboard score");
assert.match(serverJs, /rawValueLabel/, "Tool usage rows should expose the raw leaderboard score separately");
assert.match(serverJs, /normalizedValue/, "Tool usage rows should expose normalized effective usage separately");
assert.match(serverJs, /summarizeRows\(rowsFromPayload\(state\.lastUpload\?\.payload\)/, "Summary should rebuild normalized tool usage from the last upload payload");
assert.match(serverJs, /function zaiUsagePeriod/, "Server should build GLM usage periods from Coding Quota Bar model-usage data");
assert.match(serverJs, /history1d[\s\S]*history7d[\s\S]*history30d/, "Server should expose GLM daily, seven-day, and thirty-day trend data");
assert.match(serverJs, /model-usage\?startTime/, "GLM trends should use the same model-usage endpoint as Coding Quota Bar");
assert.match(serverJs, /usageTrends/, "Summary payload should include chart-ready usage trends");
assert.match(serverJs, /function buildQuotaAudit/, "Summary payload should explain which agents have reliable quota sources");
assert.match(serverJs, /glm[\s\S]*GLM \/ Z\.ai/, "GLM/Z.ai usage should have an explicit label");
assert.match(serverJs, /codexQuotaFromTools/, "Quota feeds should expose a Codex quota card");
assert.doesNotMatch(serverJs, /function gptQuotaFromTools/, "Quota feeds should not use the old GPT/OpenAI card");
assert.match(serverJs, /toFixed\(2\)}亿/, "Large token counts should render with the 亿 unit");
assert.match(serverJs, /toFixed\(1\)}万/, "Mid-size token counts should render with the 万 unit");
assert.doesNotMatch(serverJs, /\uFFFD|浜縛|涓嘸|鎺掑悕|鐜嬪骇|浠诲姟/, "Server user-facing strings must not contain mojibake");

console.log("windows scaffold contract ok");
