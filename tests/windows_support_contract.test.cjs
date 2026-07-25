const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));

const pkg = readJson("package.json");
assert.equal(pkg.scripts.test, "node tests/windows_support_contract.test.cjs && node tests/build_summary.test.cjs");
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
assert.match(popoverHtml, /fetch\(API \+ '\/summary', \{ cache: 'no-store' \}\)/, "Popover summary reads should bypass WebView HTTP cache");
assert.match(popoverHtml, /visibilitychange[\s\S]*load\(\)/, "Popover should refresh when a hidden WebView becomes visible again");
assert.match(popoverHtml, /addEventListener\('focus', load\)/, "Popover should refresh when the pinned panel receives focus");
assert.match(popoverHtml, /pointerenter[\s\S]*load\(\)/, "Popover should refresh when the tray-hover panel is shown again");
assert.match(popoverHtml, /id="logButton"/, "Log icon button should have an explicit behavior hook");
assert.match(popoverHtml, /function openLogs/, "Log icon button should open the local event log");
assert.match(popoverHtml, /id="leaderboardButton"/, "Panel should expose a button for the public SCYS token ranking");
assert.match(popoverHtml, /function openLeaderboard/, "Leaderboard button should open the real ranking page through the local API");
assert.match(popoverHtml, /\/open-leaderboard/, "Leaderboard button should call the local default-browser opener");
assert.match(popoverHtml, /actualTotalLabel/, "Popover hero should emphasize the actual fresh input and output total");
assert.match(popoverHtml, /\.rank\{display:none\}/, "Popover should not visually attach raw leaderboard rank to the actual usage hero");
assert.match(popoverHtml, /tool\.detail/, "Tool rows should expose the raw leaderboard score as secondary detail");
assert.match(popoverHtml, /id="usageTrend"/, "Panel bottom should show useful usage trend data");
assert.match(popoverHtml, /function renderUsageTrend/, "Panel should render GLM usage trend bars");
assert.match(popoverHtml, /trend-bars/, "GLM daily, seven-day, and thirty-day stats should render as bar charts");
assert.match(popoverHtml, /activeTrendPeriod\s*=\s*'24h'/, "Popover should default GLM trends to the recent 24 hours");
assert.match(popoverHtml, /class="trend-tabs"/, "Popover should switch 24h, 7d, and 30d trends in one compact chart");
assert.match(popoverHtml, /function setTrendPeriod/, "Trend tabs should update the focused usage period without crowding the panel");
assert.match(popoverHtml, /class="trend-detail"/, "Hourly trend bars should expose readable in-panel details");
assert.match(popoverHtml, /data-trend-index/, "Trend bars should support selecting an hour to inspect exact usage");
assert.doesNotMatch(popoverHtml, /class="badges"|function renderBadges|function renderQuests|Hot Streak|Daily Quest/, "Low-value gamification badges and quests should not crowd out quota data");
assert.doesNotMatch(popoverHtml, /Builder Lv|XP|class="game"|rankDelta|xpText|rankGap|level-line|battle/, "Panel must not show synthetic level, XP, or game battle data");
assert.match(popoverHtml, /id="rankFacts"/, "Panel should replace game data with real leaderboard facts");
assert.match(popoverHtml, /function renderRankFacts/, "Panel should render leaderboard facts from the summary payload");
assert.doesNotMatch(popoverHtml, /Codex Main/, "Static badge placeholders should not flash Codex while it is hidden");
assert.doesNotMatch(popoverHtml, /label: 'Codex'/, "Codex quota fallback should be hidden for now");
assert.doesNotMatch(popoverHtml, /Codex[\s\S]{0,80}周额度/, "Codex quota card should be hidden for now");
assert.doesNotMatch(popoverHtml, /Waiting GPT\/OpenAI rows/, "Quota UI should not show GPT/OpenAI as the Codex quota card");
assert.doesNotMatch(popoverHtml, /[^<]\/(?:span|strong)>/, "Popover HTML must not contain malformed closing tags that corrupt layout");
assert.doesNotMatch(popoverHtml, /\uFFFD|鎺|鐩|璇|绛|涓婃姤|浜縛|涓嘸/, "Popover must not contain mojibake strings");

const islandHtml = fs.readFileSync(path.join(root, "island.html"), "utf8");
assert.doesNotMatch(islandHtml, /data\.game|xpPct|Builder Lv|XP/, "Island notification must not depend on synthetic game or XP fields");
assert.match(islandHtml, /rankProgressPct/, "Island progress should use real leaderboard-derived progress");

const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
assert.doesNotMatch(indexHtml, /Builder Lv|XP|rankDelta|xpText|rankGap|High Output|Codex Main|Hot Streak|216k|#17/, "Browser dashboard must not contain old synthetic demo metrics");
assert.match(indexHtml, /renderRankFacts/, "Browser dashboard should render real leaderboard facts");
assert.match(indexHtml, /actualTotalLabel/, "Browser dashboard hero should emphasize the actual fresh input and output total");
assert.match(indexHtml, /fetch\(API \+ '\/summary', \{ cache: 'no-store' \}\)/, "Browser dashboard should fetch the live summary payload without HTTP cache");

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
const officialRsCandidate = 'home.join(".opentoken").join("bin").join("opentoken.exe")';
const legacyRsCandidate = 'home.join(".local").join("bin").join("opentoken.exe")';
assert.ok(
  windowsSupport.indexOf(officialRsCandidate) >= 0 && windowsSupport.indexOf(legacyRsCandidate) >= 0,
  "Windows GUI should know both the official .opentoken and legacy .local OpenToken binaries"
);
assert.ok(
  windowsSupport.indexOf(officialRsCandidate) < windowsSupport.indexOf(legacyRsCandidate),
  "Windows GUI must prefer the official .opentoken binary over the legacy .local command"
);

const serverJs = fs.readFileSync(path.join(root, "server.js"), "utf8");
const officialOpenTokenCandidate = 'path.join(HOME, ".opentoken", "bin", "opentoken.exe")';
const legacyOpenTokenCandidate = 'path.join(HOME, ".local", "bin", "opentoken.exe")';
assert.ok(
  serverJs.indexOf(officialOpenTokenCandidate) < serverJs.indexOf(legacyOpenTokenCandidate),
  "Windows GUI must prefer the official .opentoken binary over a legacy .local command"
);
assert.match(
  serverJs,
  /const rawBoard = isSameLocalDate\(state\.leaderboard\?\.updatedAt, today\) \? state\.leaderboard : null;[\s\S]{0,200}const previewSnapshot = rawBoard\?\.own[\s\S]{0,120}await openTokenPreviewSnapshot\(today\)/,
  "Summary reads with a matched same-day leaderboard must not block on a local preview scan"
);
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
assert.match(serverJs, /QUOTA_ERROR_CACHE_TTL_MS\s*=\s*30 \* 1000/, "Transient Z.ai quota errors should only be cached briefly");
assert.match(serverJs, /function quotaCacheTtl/, "Z.ai quota cache TTL should depend on success or error state");
assert.match(serverJs, /quotaCacheTtl\(quotaCache\.zai\)/, "Cached Z.ai quota errors should not reuse the full success TTL");
assert.match(serverJs, /TOKENRANK_URL = "https:\/\/scys\.com\/tokenrank\/"/, "Server should keep the public ranking URL in one audited constant");
assert.match(serverJs, /\/api\/open-leaderboard/, "Server should expose an endpoint to open the public ranking page");
assert.match(serverJs, /openExternalUrl\(TOKENRANK_URL\)/, "Leaderboard endpoint should use the system default browser opener");
assert.match(serverJs, /\/api\/open-logs/, "Server should expose an API endpoint for the log icon button");
assert.match(serverJs, /function openLogsFile/, "Server should open the local OpenToken Island event log");
assert.match(serverJs, /function buildSyncStatus/, "Summary payload must explain upload and leaderboard sync state");
assert.match(serverJs, /leaderboardMatched/, "Sync state must distinguish uploaded data from leaderboard matches");
assert.match(serverJs, /if \(!uploadSummary && leaderboardMatched\)[\s\S]{0,260}status: "leaderboard"/, "A matched public leaderboard must remain visible when the latest local payload has no token rows");
assert.match(serverJs, /function openTokenPreviewSnapshot/, "Summary payload should prefer a full local OpenToken preview snapshot over incremental upload payloads");
assert.match(serverJs, /\["preview", "--since", date, "--json"\]/, "OpenToken preview snapshots should use the JSON rows that represent the full local daily state");
assert.doesNotMatch(serverJs, /const uploadByTool = uploadRowsSummary\?\.rowCount[\s\S]{0,80}\? uploadRowsSummary\.byTool/, "Summary must not treat incremental upload payloads as the full local usage source");
assert.match(serverJs, /url\.searchParams\.get\("refresh"\) === "1"[\s\S]{0,120}previewCache = \{ at: 0, date: "", snapshot: null \}/, "Manual summary refresh should force a fresh local OpenToken preview");
assert.match(serverJs, /排行榜仅返回前/, "Sync detail should explain when the current account is not in the returned leaderboard page");
assert.match(serverJs, /function requestTextWithRetry/, "Upload forwarding should retry transient network failures");
assert.match(serverJs, /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT/, "Retry logic should cover common DNS and socket failures");
assert.match(serverJs, /requestTextWithRetry\("POST", upstreamUrl/, "OpenToken upload forwarding must use retry logic");
assert.match(serverJs, /function isAnyLocalWebhook/, "Proxy setup must detect localhost webhooks even when they were created by a different temporary port");
assert.match(serverJs, /isAnyLocalWebhook\(current\)[\s\S]*state\.upstreamUrl = upstreamFromLocal\(current\)/, "Proxy setup must never persist a localhost webhook as the real upstream URL");
assert.match(serverJs, /state\.upstreamUrl && isAnyLocalWebhook\(state\.upstreamUrl\)[\s\S]*state\.upstreamUrl = upstreamFromLocal\(state\.upstreamUrl\)/, "Proxy setup should repair previously poisoned localhost upstream URLs");
assert.match(serverJs, /5小时额度/, "Server should label the five-hour quota bucket");
assert.match(serverJs, /MCP额度/, "Server should label the Z.ai MCP quota bucket");
assert.match(serverJs, /周额度/, "Server should label the weekly quota bucket");
assert.match(serverJs, /Ready|准备|就绪|OpenToken/, "Service detection should treat a ready Windows scheduled task as healthy");
assert.match(serverJs, /function normalizeToolName/, "Tool names should be normalized before ranking");
assert.match(serverJs, /normalizedByTool/, "Upload summaries should preserve normalized usage per tool");
assert.match(serverJs, /function isSameLocalDate/, "Summary must compare persisted timestamps against the current local day");
assert.doesNotMatch(serverJs, /openTokenPreviewSnapshot\(uploadSummary\?\.date \|\| localDateString\(\)\)/, "Daily summary must not keep previewing yesterday because the last upload summary is stale");
assert.match(serverJs, /const today = localDateString\(\)/, "Summary should anchor all local preview and stale-cache checks to today's date");
assert.match(serverJs, /rawUploadSummary\?\.date === today/, "Summary should ignore persisted upload summaries from previous days");
assert.match(serverJs, /isSameLocalDate\(state\.leaderboard\?\.updatedAt, today\)/, "Summary should ignore persisted leaderboard matches from previous days");
assert.match(serverJs, /LEADERBOARD_AUTO_REFRESH_INTERVAL_MS/, "Normal panel refreshes should retry stale leaderboard matches without hammering SCYS");
assert.match(serverJs, /function leaderboardBehindUsage/, "Summary should detect when a persisted leaderboard row is behind today's uploaded usage");
assert.match(serverJs, /score < usageTotal/, "A leaderboard score below the local uploaded total must be treated as stale");
assert.match(serverJs, /function refreshLeaderboardIfStale/, "Summary endpoint should automatically retry public leaderboard refresh after eventual-consistency lag");
assert.match(serverJs, /url\.searchParams\.set\("_ts"/, "Leaderboard refresh should bypass stale intermediary cache");
assert.match(serverJs, /"cache-control": "no-cache"/, "Leaderboard refresh should explicitly request uncached data");
assert.doesNotMatch(serverJs, /boardIsBehind[\s\S]*own: null/, "A lagging leaderboard must retain its last known official score and rank as secondary facts");
assert.match(serverJs, /const useLeaderboardForMain = hasLeaderboardScore\b(?!\s*&&)/, "The main visible total must always follow the matched public leaderboard score so it mirrors the SCYS webpage");
assert.match(serverJs, /status: "leaderboard-refreshing"/, "Sync status should say the public leaderboard is still refreshing instead of claiming synced");
assert.match(serverJs, /const usageSource = previewSnapshot\?\.summary\?\.rowCount[\s\S]*\? "local-preview"[\s\S]*: uploadRowsSummary\?\.rowCount[\s\S]*\? "upload"/, "Summary source should say upload when preview fails and upload rows are used as fallback");
assert.doesNotMatch(serverJs, /own\?\.score \|\| uploadSummary\?\.total/, "Leaderboard score must not fall back to upload totals when the account is not in the leaderboard");
assert.match(serverJs, /const leaderboardTotal = Number\(own\?\.score \|\| 0\)/, "Leaderboard total should only come from the matched SCYS leaderboard row");
assert.match(serverJs, /leaderboardTotalLabel: hasLeaderboardScore \? formatCount\(leaderboardTotal\) : "--"/, "Leaderboard label should be blank when no leaderboard row is matched");
  assert.match(serverJs, /(const|let) displayByTool = useLeaderboardForMain[\s\S]*\? leaderboardByTool[\s\S]*: byTool/, "A fresh matched leaderboard should drive the visible total and tool rows");
  assert.match(serverJs, /openTokenClaudeCodeUsage[\s\S]*"preview",\s*"--tool",\s*"claude-code"/, "Claude Code usage should be backfilled via a single-tool preview scan that avoids the full-scan timeout");
  assert.match(serverJs, /const claudeByTool = await openTokenClaudeCodeUsage\(today\)[\s\S]*claudeByTool\.claudeValue > 0[\s\S]*displayByTool = \{ \.\.\.displayByTool, "claude-code": claudeByTool\.claudeValue \}/, "Claude Code usage from the local full preview should always override the unreliable upload/leaderboard view");
  assert.match(serverJs, /function augmentClaudeCodeRows/, "Upload proxy must expose a helper that augments missing claude-code rows before forwarding to SCYS");
  assert.match(serverJs, /let forwardBody = body[\s\S]*augmentClaudeCodeRows\(\)[\s\S]*forwardBody = JSON\.stringify\(augmentedPayload\)/, "Upload proxy must backfill real claude-code rows into the forwarded payload, not just the local display");
  assert.match(serverJs, /payload\.rows\.filter\(\(r\) => !\(r && r\.tool === "claude-code"\)\)/, "Upload proxy must drop stale claude-code rows from the payload before injecting the authoritative local preview rows, so an under-counted (date,model) row can not pin the SCYS leaderboard score below the top-200 cutoff");
  assert.match(serverJs, /useLeaderboardForMain\s*\?\s*leaderboardTotal\s*:[\s\S]*actualUsage\.total/, "When the leaderboard is matched the main total must stay pinned to the leaderboard score even after Claude Code backfill");
assert.match(serverJs, /const actualTotal = Number\(\s*useLeaderboardForMain\s*\? leaderboardTotal/, "The main visible total should use local usage while the public leaderboard is still catching up");
assert.match(serverJs, /actualTotalLabel/, "Summary payload should expose the leaderboard-aligned usage total for the main UI");
assert.match(serverJs, /totalLabel: usageSummary \|\| uploadSummary \|\| hasLeaderboardScore \? formatCount\(total\) : "--"/, "A matched leaderboard score must render even after a token-free activity upload");
assert.match(serverJs, /leaderboardTotalLabel/, "Summary payload should keep the raw leaderboard score as secondary metadata");
assert.match(serverJs, /label: "榜单分"/, "Rank facts should label raw leaderboard score separately from actual usage");
assert.match(serverJs, /label: "榜单排名"/, "Rank facts should label ranking as a raw leaderboard fact");
assert.match(serverJs, /label: "同步状态"/, "Rank facts should show sync state without exposing misleading accepted row counts");
assert.doesNotMatch(serverJs, /label: "上报接收"[\s\S]*`\$\{accepted\} 条`/, "Panel facts must not show accepted row counts as a visible usage metric");
assert.match(serverJs, /function toolsFromUsageMaps/, "Tool usage rows should distinguish normalized usage from raw leaderboard score");
assert.match(serverJs, /rawValueLabel/, "Tool usage rows should expose the raw leaderboard score separately");
assert.match(serverJs, /normalizedValue/, "Tool usage rows should expose normalized effective usage separately");
assert.doesNotMatch(serverJs, /const value = normalizedValue > 0 \? normalizedValue : rawValue/, "Tool rows must not use normalized input+output as the primary visible usage");
assert.match(serverJs, /const value = rawValue > 0 \? rawValue : normalizedValue/, "Tool rows should use raw actual usage as the primary visible value");
assert.match(serverJs, /function actualUsageSummary/, "Summary should build one audited actual-usage total across live sources");
assert.match(serverJs, /const hasTokenUsage = Boolean\(summary\.date\) && Number\(summary\.total \|\| 0\) > 0;/, "Token-free activity payloads must not overwrite the last daily usage snapshot");
assert.match(serverJs, /if \(hasTokenUsage\) \{[\s\S]{0,260}state\.lastUpload =/, "Only payloads with token rows may replace the last daily usage snapshot");
assert.doesNotMatch(serverJs, /usageToolEntry\(\s*"glm"[\s\S]*Coding Quota Bar 24h/, "Coding Quota Bar GLM provider trends must not be included in the actual usage total");
assert.match(serverJs, /const codexValue = Number\(rawByTool\.codex \|\| 0\)/, "Codex actual usage should use raw OpenToken tokens including cache reads");
assert.match(serverJs, /const claudeValue = Number\(rawByTool\["claude-code"\] \|\| 0\)[\s\S]*if \(claudeValue > 0\)/, "Claude Code OpenToken rows should remain in the actual usage total");
assert.doesNotMatch(serverJs, /const actualByTool = normalizedByTool/, "Actual totals must not collapse to normalized OpenToken rows only");
assert.match(serverJs, /summarizeRows\(rowsFromPayload\(state\.lastUpload\?\.payload\)/, "Summary should rebuild normalized tool usage from the last upload payload");
assert.match(serverJs, /function zaiUsagePeriod/, "Server should build GLM usage periods from Coding Quota Bar model-usage data");
assert.match(serverJs, /history1d[\s\S]*history7d[\s\S]*history30d/, "Server should expose GLM daily, seven-day, and thirty-day trend data");
assert.match(serverJs, /history24h/, "Server should expose a recent-24-hour GLM trend for the default panel view");
assert.match(serverJs, /zaiUsagePeriod\("24h",\s*"24h"[\s\S]*24/, "Recent-24-hour GLM trend should keep hourly buckets instead of compacting to three coarse blocks");
assert.match(serverJs, /periods:\s*\[history24h,\s*history7d,\s*history30d\]/, "Server should order trend periods for compact 24h-first switching");
assert.match(serverJs, /model-usage\?startTime/, "GLM trends should use the same model-usage endpoint as Coding Quota Bar");
assert.match(serverJs, /usageTrends/, "Summary payload should include chart-ready usage trends");
assert.match(serverJs, /function buildQuotaAudit/, "Summary payload should explain which agents have reliable quota sources");
assert.match(serverJs, /function buildRankFacts/, "Summary payload should expose real leaderboard facts for the panel");
assert.doesNotMatch(serverJs, /function buildGame|Builder Lv|rewardLabel|High Output|Codex Main|xpMax|quests: game|badges: game/, "Summary must not expose synthetic game data");
assert.match(serverJs, /glm[\s\S]*GLM \/ Z\.ai/, "GLM/Z.ai usage should have an explicit label");
assert.match(serverJs, /codexQuotaFromTools/, "Quota feeds should expose a Codex quota card");
assert.doesNotMatch(serverJs, /function gptQuotaFromTools/, "Quota feeds should not use the old GPT/OpenAI card");
assert.match(serverJs, /toFixed\(2\)}亿/, "Large token counts should render with the 亿 unit");
assert.match(serverJs, /toFixed\(1\)}万/, "Mid-size token counts should render with the 万 unit");
assert.doesNotMatch(serverJs, /\uFFFD|浜縛|涓嘸|鎺掑悕|鐜嬪骇|浠诲姟/, "Server user-facing strings must not contain mojibake");

console.log("windows scaffold contract ok");
