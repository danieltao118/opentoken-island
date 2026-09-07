const http = require("http");
const https = require("https");
const tls = require("tls");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile, execFileSync } = require("child_process");

const PORT = Number(process.env.OPENTOKEN_ISLAND_PORT || 4174);
const ROOT = __dirname;
const HOME = process.env.HOME || os.homedir();
const CONFIG_PATH = path.join(HOME, ".opentoken", "config.json");
const STATE_PATH = path.join(HOME, ".opentoken", "island-state.json");
const EVENT_LOG_PATH = path.join(HOME, ".opentoken", "island-events.log");
const DEFAULT_UPSTREAM_ORIGIN = "https://scys.com";
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const CODING_QUOTA_CONFIG_PATH = path.join(APPDATA, "coding-quota-bar", "config.json");
const CODING_QUOTA_LOCAL_STATE_PATH = path.join(APPDATA, "coding-quota-bar", "Local State");
const TOKENRANK_URL = "https://scys.com/tokenrank/";
const ZAI_CODING_API_BASE = "https://api.z.ai";
const APP_ID = "opentoken-island";
const APP_VERSION = String(process.env.OPENTOKEN_ISLAND_APP_VERSION || "unmanaged").trim() || "unmanaged";
const API_PROTOCOL_VERSION = 3;
const STATE_SCHEMA_VERSION = 3;
const MAX_UPLOAD_BODY_BYTES = 4 * 1024 * 1024;
const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;
const QUOTA_ERROR_CACHE_TTL_MS = 30 * 1000;
const ZAI_STALE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const PREVIEW_CACHE_TTL_MS = 45 * 1000;
// 全量 preview 默认停用：0.3.x CLI 的 --since 只过滤输出、不裁剪扫描。
// 上报/preview 会把 CODEX_HOME 临时收成 since±1 天的 sessions 日期目录，避免 walk 整份历史。
// 设 OPENTOKEN_ENABLE_FULL_PREVIEW=1 可恢复旧的定时 preview。
const FULL_PREVIEW_ENABLED = /^(1|true|yes)$/i.test(process.env.OPENTOKEN_ENABLE_FULL_PREVIEW || "");
const FULL_PREVIEW_TIMEOUT_MS = Number(process.env.OPENTOKEN_FULL_PREVIEW_TIMEOUT_MS || 30 * 60 * 1000);
const FULL_PREVIEW_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
// 手动/自动上报都带 --since 当天：只上传当天的增量。超时上限 30 分钟，可用环境变量覆盖。
const UPLOAD_TIMEOUT_MS = Number(process.env.OPENTOKEN_UPLOAD_TIMEOUT_MS || 30 * 60 * 1000);
// 自动上报节奏：距上一次上报结束 ≥2 小时且当前无上传在跑时，自动跑一轮当天定向上传。
const AUTO_UPLOAD_INTERVAL_MS = Number(process.env.OPENTOKEN_AUTO_UPLOAD_INTERVAL_MS || 2 * 60 * 60 * 1000);
const BACKGROUND_TICK_INTERVAL_MS = 60 * 1000;
const LEADERBOARD_AUTO_REFRESH_INTERVAL_MS = 60 * 1000;
const LEADERBOARD_SYNC_MAX_ATTEMPTS = 6;
const LEADERBOARD_SYNC_RETRY_MS = [0, 1500, 3000, 6000, 10000, 15000];
const LEADERBOARD_CANDIDATE_TTL_MS = 5 * 60 * 1000;
const LEADERBOARD_ENDPOINT = "https://scys.com/tokenrank/api/subapp/leaderboard?board=total&range=today&limit=500";
const CITY_DISCOVERY_CONCURRENCY = 6;
const OFFICIAL_STATE_PATH = path.join(HOME, ".opentoken", "state.json");
const OFFICIAL_LOCK_PATH = path.join(HOME, ".opentoken", "upload.lock");
const OFFICIAL_HEALTH_PATH = path.join(HOME, ".opentoken", "daemon_health.json");
// 官方 daemon 在这台机器上会被自家看门狗杀掉并留下死锁；每小时体检一次即可自愈。
const DAEMON_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const DAEMON_LEDGER_GRACE_HOUR = 10;
const DNS_FALLBACK_TTL_MS = 10 * 60 * 1000;
const dnsFallbackCache = new Map();
// 被墙端点（chatgpt.com 等）node 直连必败：直连与 DNS 兜底都失败后，走本地 HTTP 代理的
// CONNECT 隧道重试（Clash 常驻 7892）。国内端点直连即成功，永远不会触发此兜底。
// 设 OPENTOKEN_UPSTREAM_PROXY=off 可禁用；未设置时默认本机 7892。
const UPSTREAM_PROXY_URL = (() => {
  const raw = (process.env.OPENTOKEN_UPSTREAM_PROXY || "").trim();
  if (/^(off|no|disabled)$/i.test(raw)) return "";
  return raw || "http://127.0.0.1:7892";
})();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

let state = migrateLoadedState(loadState());
let quotaCache = { at: 0, fingerprint: "", zai: null };
const zaiLastGoodByAccount = new Map();
const quotaRefreshPromises = new Map();
let zaiRuntime = { fingerprint: "", source: "unknown" };
let cursorQuotaCache = { at: 0, fingerprint: "", feed: null };
let grokQuotaCache = { at: 0, fingerprint: "", feed: null };
let codexQuotaCache = { at: 0, fingerprint: "", feed: null };
let kimiQuotaCache = { at: 0, fingerprint: "", feed: null };
let cursorRuntime = { fingerprint: "", source: "unknown" };
let grokRuntime = { fingerprint: "", source: "unknown" };
let codexRuntime = { fingerprint: "", source: "unknown" };
let kimiRuntime = { fingerprint: "", source: "unknown" };
const cursorLastGoodByAccount = new Map();
const grokLastGoodByAccount = new Map();
const codexLastGoodByAccount = new Map();
const kimiLastGoodByAccount = new Map();
let pythonBinaryCache = { at: 0, bin: "" };
const envSecretCache = new Map();
const ENV_SECRET_TTL_MS = 5 * 60 * 1000;
let codingQuotaMasterKeyCache = { at: 0, key: null };
let previewCache = { at: 0, date: "", snapshot: null };
// claude-code 单工具用量缓存：opentoken upload 全量扫描常超时漏传 claude-code，
// 这里用秒级的 `preview --tool claude-code` 单独补全本地真实用量。缓存同时保留原始
// rows，供上传中转补全 payload 复用（让真实 claude-code 消耗真正上传到 scys 榜单）。
let claudeCodeCache = { at: 0, date: "", status: "waiting", rows: [], summary: null, claudeValue: 0 };
const claudeCodeLastGoodByDate = new Map();
let usageRefresh = { date: "", promise: null };
let claudeCodeRefresh = { date: "", promise: null };
let leaderboardAutoRefresh = { at: 0, promise: null };
let leaderboardCandidateCache = { at: 0, accountKey: "", metadata: null, entries: [] };
let scysAccountGeneration = 0;
let serviceCache = { at: 0, status: { ok: false, text: "正在检查 OpenToken service", running: false } };
let backgroundTimer = null;
let officialDaemonCheck = { at: 0, failures: 0 };
let proxyRuntime = { upstreamUrl: String(state.upstreamUrl || ""), localWebhookUrl: "", proxied: false };
// Windows 上旧版桌面进程会遗留 OPENTOKEN_BIN=.local\\bin\\opentoken.exe。
// 已探测到官方新版时必须优先使用它，不能让陈旧环境变量把统计回退到 0.2.x。
const OPENTOKEN = findOpenTokenBinary() || process.env.OPENTOKEN_BIN || state.opentokenBin || "opentoken";

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function redactedUploadRecord(record) {
  if (!record || typeof record !== "object") return record || null;
  const upstream = record.upstream && typeof record.upstream === "object"
    ? {
        operationId: String(record.upstream.operationId || record.operationId || ""),
        sequence: Number(record.upstream.sequence || record.sequence || 0),
        finishedAt: String(record.upstream.finishedAt || ""),
        status: Number(record.upstream.status || 0),
        ok: Boolean(record.upstream.ok),
        accepted: record.upstream.accepted ?? record.upstream.json?.accepted ?? null,
        errorCode: String(record.upstream.errorCode || ""),
        accountKey: String(record.upstream.accountKey || record.accountKey || ""),
      }
    : undefined;
  return {
    operationId: String(record.operationId || ""),
    accountKey: String(record.accountKey || ""),
    sequence: Number(record.sequence || 0),
    capturedAt: String(record.capturedAt || ""),
    path: redactUploadPath(record.path || ""),
    payloadHash: String(record.payloadHash || ""),
    payloadKind: String(record.payloadKind || ""),
    summary: record.summary ? {
      date: String(record.summary.date || ""),
      total: Math.max(0, Number(record.summary.total || 0)),
      normalized: Math.max(0, Number(record.summary.normalized || 0)),
      byTool: normalizeToolMap(record.summary.byTool || {}),
      normalizedByTool: normalizeToolMap(record.summary.normalizedByTool || {}),
      rowCount: Math.max(0, Number(record.summary.rowCount || 0)),
    } : null,
    ...(upstream ? { upstream } : {}),
  };
}

function migrateLoadedState(input) {
  const next = input && typeof input === "object" ? { ...input } : {};
  next.schemaVersion = STATE_SCHEMA_VERSION;
  const legacyPayload = next.lastUpload?.payload;
  if (!next.localUsage && legacyPayload) {
    const rows = rowsFromPayload(legacyPayload);
    const date = next.lastUpload?.summary?.date || "";
    if (date && rows.length) {
      next.localUsage = mergeLocalUsageSnapshot(null, rows, {
        date,
        source: "legacy-upload-observed",
        updatedAt: next.lastUpload?.capturedAt,
      });
    }
  }
  if (
    !next.lastUpload?.upstream
    && next.uploadTransport?.operationId
    && next.uploadTransport.operationId === next.lastUpload?.operationId
  ) next.lastUpload.upstream = next.uploadTransport;
  delete next.uploadTransport;
  next.lastUpload = redactedUploadRecord(next.lastUpload);
  next.lastActivityUpload = redactedUploadRecord(next.lastActivityUpload);
  if (next.manualUpload?.status === "running") {
    next.manualUpload = {
      ...next.manualUpload,
      status: "interrupted",
      finishedAt: new Date().toISOString(),
      detail: "应用重启，上一次上报结果未知",
    };
  }
  return next;
}

function findOpenTokenBinary() {
  const candidates = process.platform === "win32"
    ? [
        path.join(HOME, ".opentoken", "bin", "opentoken.exe"),
        path.join(HOME, ".local", "bin", "opentoken.exe"),
      ]
    : [
        path.join(HOME, ".local", "bin", "opentoken"),
        "/opt/homebrew/bin/opentoken",
        "/usr/local/bin/opentoken",
      ];
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  return "";
}

function saveState() {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  state.schemaVersion = STATE_SCHEMA_VERSION;
  state.lastUpload = redactedUploadRecord(state.lastUpload);
  state.lastActivityUpload = redactedUploadRecord(state.lastActivityUpload);
  delete state.uploadTransport;
  const tempPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tempPath, STATE_PATH);
}

function logIslandEvent(message, details = {}) {
  fs.mkdirSync(path.dirname(EVENT_LOG_PATH), { recursive: true });
  const line = JSON.stringify({
    at: new Date().toISOString(),
    layer: "server",
    message,
    ...details,
  });
  fs.appendFileSync(EVENT_LOG_PATH, `${line}\n`);
}

function queueIslandEvent(reason = "manual") {
  const event = {
    id: Date.now(),
    createdAt: new Date().toISOString(),
    reason,
  };
  state.islandEvent = event;
  saveState();
  logIslandEvent("queued island event", event);
  return event;
}

function currentIslandEvent() {
  return state.islandEvent || { id: 0, createdAt: "", reason: "none" };
}

function redactUploadPath(pathname = "") {
  return String(pathname).replace(/(\/tokenrank\/api\/subapp\/u\/)[^/?#]+/, "$1<account>");
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

function isLocalWebhook(webhook) {
  try {
    const url = new URL(webhook);
    return ["127.0.0.1", "localhost"].includes(url.hostname) && Number(url.port) === PORT;
  } catch {
    return false;
  }
}

function isAnyLocalWebhook(webhook) {
  try {
    const url = new URL(webhook);
    return ["127.0.0.1", "localhost"].includes(url.hostname);
  } catch {
    return false;
  }
}

function validateScysUpstreamUrl(targetUrl) {
  try {
    const url = new URL(targetUrl);
    return url.origin === DEFAULT_UPSTREAM_ORIGIN
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && /^\/tokenrank\/api\/subapp\/u\/[A-Za-z0-9_-]{1,200}\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

function accountKeyForUpstreamUrl(targetUrl) {
  if (!validateScysUpstreamUrl(targetUrl)) return "";
  const pathname = new URL(targetUrl).pathname.replace(/\/$/, "");
  return crypto.createHash("sha256").update(pathname).digest("hex").slice(0, 24);
}

function isolateAccountState(input, previousAccountKey, nextAccountKey) {
  const next = input && typeof input === "object" ? { ...input } : {};
  const changed = previousAccountKey !== nextAccountKey && Boolean(previousAccountKey || nextAccountKey);
  if (changed) {
    delete next.userId;
    delete next.leaderboard;
    delete next.lastUpload;
    delete next.lastActivityUpload;
    delete next.uploadTransport;
    delete next.manualUpload;
    delete next.leaderboardNeedsRefresh;
    delete next.leaderboardSync;
    delete next.myCity;
    delete next.cityLookupDate;
  }
  if (nextAccountKey) next.accountKey = nextAccountKey;
  else delete next.accountKey;
  return { state: next, changed };
}

function localWebhookFor(upstreamUrl) {
  const upstream = new URL(upstreamUrl);
  return `http://127.0.0.1:${PORT}${upstream.pathname}`;
}

function upstreamFromLocal(localUrl) {
  const local = new URL(localUrl);
  return `${DEFAULT_UPSTREAM_ORIGIN}${local.pathname}${local.search}`;
}

function ensureProxyConfig() {
  const config = readConfig();
  const current = String(config.webhook_url || "");
  const previousAccountKey = String(state.accountKey || accountKeyForUpstreamUrl(state.upstreamUrl) || "");
  let stateChanged = false;

  if (OPENTOKEN !== "opentoken" && state.opentokenBin !== OPENTOKEN) {
    state.opentokenBin = OPENTOKEN;
    stateChanged = true;
  }

  if (state.upstreamUrl && isAnyLocalWebhook(state.upstreamUrl)) {
    state.upstreamUrl = upstreamFromLocal(state.upstreamUrl);
    stateChanged = true;
  }

  if (state.upstreamUrl && !validateScysUpstreamUrl(state.upstreamUrl)) {
    state.upstreamUrl = "";
    stateChanged = true;
  }

  if (current) {
    if (isAnyLocalWebhook(current)) {
      if (!state.upstreamUrl) {
        state.upstreamUrl = upstreamFromLocal(current);
        stateChanged = true;
      }
      const localWebhook = localWebhookFor(state.upstreamUrl);
      if (config.webhook_url !== localWebhook) {
        config.webhook_url = localWebhook;
        writeConfig(config);
      }
    } else if (validateScysUpstreamUrl(current)) {
      state.upstreamUrl = current;
      stateChanged = true;
      const localWebhook = localWebhookFor(current);
      if (config.webhook_url !== localWebhook) {
        config.webhook_url = localWebhook;
        writeConfig(config);
      }
    }
  } else if (state.upstreamUrl) {
    config.webhook_url = localWebhookFor(state.upstreamUrl);
    writeConfig(config);
  }

  const upstreamUrl = state.upstreamUrl || "";
  const nextAccountKey = accountKeyForUpstreamUrl(upstreamUrl);
  const accountKeyChanged = String(state.accountKey || "") !== nextAccountKey;
  const scoped = isolateAccountState(state, previousAccountKey, nextAccountKey);
  state = scoped.state;
  let adoptedLegacyScope = false;
  if (nextAccountKey) {
    for (const key of ["lastUpload", "lastActivityUpload"]) {
      if (state[key] && !state[key].accountKey) {
        state[key].accountKey = nextAccountKey;
        adoptedLegacyScope = true;
      }
      if (state[key]?.upstream && !state[key].upstream.accountKey) {
        state[key].upstream.accountKey = nextAccountKey;
        adoptedLegacyScope = true;
      }
    }
    if (state.leaderboard && !state.leaderboard.accountKey) {
      state.leaderboard.accountKey = nextAccountKey;
      adoptedLegacyScope = true;
    }
    if (state.manualUpload && !state.manualUpload.accountKey) {
      state.manualUpload.accountKey = nextAccountKey;
      adoptedLegacyScope = true;
    }
  }
  if (scoped.changed) {
    scysAccountGeneration += 1;
    leaderboardCandidateCache = { at: 0, accountKey: "", metadata: null, entries: [] };
    leaderboardAutoRefresh = { at: 0, promise: null };
    logIslandEvent("isolated SCYS account state after webhook change", {
      previousAccountKey,
      nextAccountKey,
    });
  }
  stateChanged = stateChanged || scoped.changed || accountKeyChanged || adoptedLegacyScope;
  if (nextAccountKey && state.accountKey !== nextAccountKey) state.accountKey = nextAccountKey;
  if (stateChanged) saveState();
  proxyRuntime = {
    upstreamUrl,
    localWebhookUrl: upstreamUrl ? localWebhookFor(upstreamUrl) : current,
    proxied: Boolean(current && isLocalWebhook(readConfig().webhook_url || current)),
  };
  return proxyRuntime;
}

function run(cmd, args, timeout = 30000, extra = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const options = { timeout, windowsHide: true };
    if (extra && extra.env) options.env = extra.env;
    execFile(cmd, args, options, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === "number" ? error.code : 0,
        // Windows 下超时被杀时 error.message 不含 timeout 字样，靠 elapsed>=timeout 且 killed 判定，
        // 让上传失败能如实显示「扫描超时」而不是笼统的 command-failed。
        timedOut: Boolean(error && error.killed && Date.now() - startedAt >= timeout - 1000),
        stdout: stdout || "",
        stderr: stderr || "",
        message: error ? error.message : "",
      });
    });
  });
}

// 手动 Upload now 使用一个持久 operation；重复点击 join 同一任务，GUI 能看到真实终态。
let backgroundUploadTask = null;
function manualUploadView(joined = false) {
  const operation = state.manualUpload || {};
  return {
    id: String(operation.id || ""),
    status: String(operation.status || "idle"),
    startedAt: String(operation.startedAt || ""),
    finishedAt: String(operation.finishedAt || ""),
    detail: String(operation.detail || ""),
    joined,
  };
}

function uploadFailureCode(result) {
  if (result?.timedOut) return "timeout";
  const message = String(result?.message || "");
  if (/timed out|timeout/i.test(message)) return "timeout";
  if (result?.code) return `exit-${result.code}`;
  return "command-failed";
}

function addCalendarDays(dateString, deltaDays) {
  const [year, month, day] = String(dateString || "").split("-").map(Number);
  const date = new Date(year, (month || 1) - 1, day || 1);
  date.setDate(date.getDate() + Number(deltaDays || 0));
  return localDateString(date);
}

function sessionRelForDate(dateString) {
  const [year, month, day] = String(dateString).split("-");
  return path.join("sessions", year, month, day);
}

function realCodexHome(override) {
  return path.resolve(override || process.env.CODEX_HOME || path.join(HOME, ".codex"));
}

function codexSessionDateDirs(sinceDate, untilDate = sinceDate) {
  const until = untilDate || sinceDate;
  const dates = [];
  let cursor = addCalendarDays(sinceDate, -1);
  while (cursor <= until) {
    dates.push(cursor);
    cursor = addCalendarDays(cursor, 1);
    if (dates.length > 8) break;
  }
  return dates;
}

function isScanJunction(fullPath, stats) {
  if (stats.isSymbolicLink()) return true;
  if (process.platform !== "win32") return false;
  try {
    fs.readlinkSync(fullPath);
    return true;
  } catch {
    return false;
  }
}

function removeScanTreeSafely(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    let stats;
    try {
      stats = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (isScanJunction(full, stats)) {
      try {
        fs.rmdirSync(full);
      } catch {
        try { fs.unlinkSync(full); } catch { /* ignore */ }
      }
      continue;
    }
    if (stats.isDirectory()) {
      removeScanTreeSafely(full);
      try { fs.rmdirSync(full); } catch { /* ignore */ }
      continue;
    }
    try { fs.unlinkSync(full); } catch { /* ignore */ }
  }
  try { fs.rmdirSync(dir); } catch { /* ignore */ }
}

function isManagedCodexScanHome(scanHome) {
  if (!scanHome) return false;
  const resolved = path.resolve(scanHome);
  const tmpRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  return resolved.startsWith(tmpRoot) && path.basename(resolved).startsWith("opentoken-codex-scan-");
}

function cleanupDatedCodexHome(scanHome) {
  if (!isManagedCodexScanHome(scanHome)) return;
  removeScanTreeSafely(path.resolve(scanHome));
}

function prepareDatedCodexHome(sinceDate, options = {}) {
  const realHome = realCodexHome(options.realHome);
  const dates = codexSessionDateDirs(sinceDate, options.untilDate || sinceDate);
  const links = dates
    .map((date) => ({ date, source: path.join(realHome, sessionRelForDate(date)) }))
    .filter((item) => {
      try {
        return fs.statSync(item.source).isDirectory();
      } catch {
        return false;
      }
    });
  if (!links.length) return "";
  const scanHome = fs.mkdtempSync(path.join(os.tmpdir(), "opentoken-codex-scan-"));
  try {
    for (const item of links) {
      const dest = path.join(scanHome, sessionRelForDate(item.date));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(item.source, dest, process.platform === "win32" ? "junction" : "dir");
    }
    return scanHome;
  } catch {
    cleanupDatedCodexHome(scanHome);
    return "";
  }
}

function datedCodexRunOptions(scanHome) {
  if (!scanHome) return {};
  return { env: { ...process.env, CODEX_HOME: scanHome } };
}

function uploadTransportAcked(result, transport, operationStartedAt) {
  const latestTransportAt = Date.parse(transport?.finishedAt || "");
  const started = typeof operationStartedAt === "number"
    ? operationStartedAt
    : Date.parse(operationStartedAt || "");
  return Boolean(
    transport?.ok
    && Number.isFinite(latestTransportAt)
    && Number.isFinite(started)
    && latestTransportAt >= started
  );
}

function finalizeManualUploadStatus(result, transportAcked) {
  if (transportAcked) {
    return {
      status: "succeeded",
      detail: "SCYS 已确认接收",
    };
  }
  if (result?.ok) {
    return {
      status: "completed",
      detail: "OpenToken 已完成；本轮没有新的可上传数据",
    };
  }
  return {
    status: "failed",
    detail: uploadFailureCode(result) === "timeout"
      ? "OpenToken 扫描超时（30 分钟上限）；可加大 OPENTOKEN_UPLOAD_TIMEOUT_MS 或精简 Codex 历史日志后重试"
      : `OpenToken 上报失败（${uploadFailureCode(result)}）`,
  };
}

function triggerBackgroundUpload({ via = "/api/upload" } = {}) {
  const accountKey = activeScysAccountKey();
  if (backgroundUploadTask) {
    if (backgroundUploadTask.accountKey === accountKey) return manualUploadView(true);
    return {
      id: "",
      status: "blocked",
      detail: "上一 SCYS 账号的上报进程仍在结束，请稍后重试",
      joined: false,
      blocked: true,
    };
  }
  const startedAt = new Date().toISOString();
  const operationId = crypto.randomUUID();
  state.manualUpload = {
    id: operationId,
    accountKey,
    status: "running",
    startedAt,
    finishedAt: "",
    detail: "OpenToken 正在扫描并上报",
  };
  saveState();
  logIslandEvent("manual upload started", { operationId: state.manualUpload.id, via });
  // --since 当天：只上传今天的增量。CODEX_HOME 收成 since±1 天日期目录，避免 walk 整份历史。
  const scanHome = prepareDatedCodexHome(localDateString());
  const taskPromise = run(OPENTOKEN, ["upload", "--since", localDateString()], UPLOAD_TIMEOUT_MS, datedCodexRunOptions(scanHome))
    .then((result) => {
      if (state.manualUpload?.id !== operationId || activeScysAccountKey() !== accountKey) {
        logIslandEvent("ignored manual upload completion after SCYS account change", { operationId });
        return;
      }
      if (result.ok) previewCache = { at: 0, date: "", snapshot: null };
      const transport = transportForActiveAccount();
      let transportAcked = uploadTransportAcked(result, transport, startedAt);
      let nextStatus = finalizeManualUploadStatus(result, transportAcked);
      if (nextStatus.status === "completed") {
        const today = localDateString();
        const claudeValue = Number((claudeCodeCache.date === today && claudeCodeCache.claudeValue) || 0);
        if (claudeValue > 0 && !officialLedgerHasClaude(today)) {
          nextStatus = { status: "completed", detail: "本机 Claude 未进入官方上报源，榜上不会有这段" };
        }
      }
      state.manualUpload = {
        ...state.manualUpload,
        status: nextStatus.status,
        finishedAt: new Date().toISOString(),
        detail: nextStatus.detail,
      };
      saveState();
      logIslandEvent("manual upload finished", {
        operationId: state.manualUpload.id,
        ok: Boolean(transportAcked || result.ok),
        status: state.manualUpload.status,
        scan: scanHome ? "dated" : "full",
        ...(nextStatus.status === "failed" ? { errorCode: uploadFailureCode(result) } : {}),
      });
      onManualUploadFinished({
        status: nextStatus.status,
        transportAcked,
        operationId: state.manualUpload.id,
      });
    })
    .finally(() => {
      cleanupDatedCodexHome(scanHome);
      if (backgroundUploadTask?.operationId === operationId) backgroundUploadTask = null;
    });
  backgroundUploadTask = { accountKey, operationId, promise: taskPromise };
  return manualUploadView(false);
}

// 自动上报：距上一次上报结束 ≥AUTO_UPLOAD_INTERVAL_MS 且当前没有上传在跑时触发，
// 与 GUI「立即上报」共用 triggerBackgroundUpload（via 标记 auto，面板可见真实终态）。
// 计划任务 \OpenToken 保持禁用（GUI 关闭时代理不在，daemon 上传必然失败还白烧扫描 CPU），
// 自动化由这里承担——GUI 经 HKCU Run 开机自启，代理常驻则自动上报常在。
function maybeTriggerAutoUpload() {
  if (backgroundUploadTask) return null;
  const finishedAt = Date.parse(state.manualUpload?.finishedAt || "");
  if (Number.isFinite(finishedAt) && Date.now() - finishedAt < AUTO_UPLOAD_INTERVAL_MS) return null;
  return triggerBackgroundUpload({ via: "auto-tick" });
}

function openExternalUrl(targetUrl) {
  return new Promise((resolve) => {
    const opener = process.platform === "win32"
      ? { cmd: "cmd", args: ["/c", "start", "", targetUrl] }
      : process.platform === "darwin"
        ? { cmd: "open", args: [targetUrl] }
        : { cmd: "xdg-open", args: [targetUrl] };

    execFile(opener.cmd, opener.args, { windowsHide: true }, (error) => {
      resolve({
        ok: !error,
        error: error ? error.message : "",
        url: targetUrl,
      });
    });
  });
}

function openLogsFile() {
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(path.dirname(EVENT_LOG_PATH), { recursive: true });
      fs.closeSync(fs.openSync(EVENT_LOG_PATH, "a"));
    } catch (error) {
      return resolve({ ok: false, error: error.message, path: EVENT_LOG_PATH });
    }

    const opener = process.platform === "win32"
      ? { cmd: "cmd", args: ["/c", "start", "", EVENT_LOG_PATH] }
      : process.platform === "darwin"
        ? { cmd: "open", args: [EVENT_LOG_PATH] }
        : { cmd: "xdg-open", args: [EVENT_LOG_PATH] };

    execFile(opener.cmd, opener.args, { windowsHide: true }, (error) => {
      resolve({
        ok: !error,
        error: error ? error.message : "",
        path: EVENT_LOG_PATH,
      });
    });
  });
}

function readBody(req, limit = MAX_UPLOAD_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function resolveHostViaPowerShell(hostname) {
  if (process.platform !== "win32" || !/^[a-z0-9.-]+$/i.test(hostname)) return "";
  const cached = dnsFallbackCache.get(hostname);
  if (cached && Date.now() - cached.at < DNS_FALLBACK_TTL_MS) return cached.address;
  const safeHost = hostname.replace(/'/g, "''");
  const command = [
    "$ErrorActionPreference='SilentlyContinue';",
    `(Resolve-DnsName -Name '${safeHost}' -Type A |`,
    "Where-Object { $_.IPAddress } |",
    "Select-Object -First 1 -ExpandProperty IPAddress)",
  ].join(" ");
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", command], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
    });
    const address = String(output || "").trim().split(/\s+/).find((item) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(item)) || "";
    if (address) dnsFallbackCache.set(hostname, { address, at: Date.now() });
    return address;
  } catch {
    return "";
  }
}

function requestTextOnce(method, targetUrl, body = "", headers = {}, timeout = 30000, extraOptions = {}) {
  return new Promise((resolve) => {
    const target = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
    const transport = target.protocol === "https:" ? https : http;
    const requestHeaders = { ...headers };
    if (body && !requestHeaders["content-length"]) {
      requestHeaders["content-length"] = Buffer.byteLength(body);
    }

    const req = transport.request(
      target,
      {
        method,
        headers: requestHeaders,
        timeout,
        ...extraOptions,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            headers: res.headers,
            body: text,
            json: safeJson(text),
          });
        });
      }
    );

    req.on("error", (error) => {
      resolve({ ok: false, status: 0, headers: {}, body: "", json: null, error: error.message });
    });
    req.on("timeout", () => {
      req.destroy(new Error("Request timed out"));
    });
    if (body) req.write(body);
    req.end();
  });
}

function tunnelViaHttpProxy(proxyUrl, targetHost, targetPort, timeout = 8000) {
  return new Promise((resolve, reject) => {
    let proxy;
    try {
      proxy = new URL(proxyUrl);
    } catch (error) {
      reject(error);
      return;
    }
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: "CONNECT",
      path: `${targetHost}:${targetPort}`,
      headers: { host: `${targetHost}:${targetPort}` },
      timeout,
    });
    req.on("connect", (res, socket) => {
      if (res.statusCode === 200) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed with status ${res.statusCode}`));
      }
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("proxy CONNECT timed out"));
    });
    req.end();
  });
}

// 复用 requestTextOnce 的响应形状，但 TCP 层来自代理 CONNECT 隧道（TLS 仍对目标域名握手）。
// 注意 https.request 没有 socket 选项——必须经 createConnection 注入已握手的 TLSSocket。
function requestTextOnceViaProxy(proxyUrl, method, target, body = "", headers = {}, timeout = 30000) {
  return tunnelViaHttpProxy(proxyUrl, target.hostname, Number(target.port || 443), Math.min(timeout, 8000)).then(
    (socket) =>
      new Promise((resolve) => {
        const requestHeaders = { ...headers };
        if (body && !requestHeaders["content-length"]) {
          requestHeaders["content-length"] = Buffer.byteLength(body);
        }
        const req = https.request(
          target,
          {
            method,
            headers: requestHeaders,
            timeout,
            // agent 必须保持未设置：node 只在"无 agent + createConnection"组合下才用自定义连接，
            // agent:false 会新建默认 Agent 并把隧道 socket 无视掉（连接又会走直连）。
            createConnection: () => tls.connect({ socket, servername: target.hostname }),
          },
          (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              resolve({
                ok: res.statusCode >= 200 && res.statusCode < 300,
                status: res.statusCode,
                headers: res.headers,
                body: text,
                json: safeJson(text),
              });
            });
          }
        );
        req.on("error", (error) => {
          resolve({ ok: false, status: 0, headers: {}, body: "", json: null, error: error.message });
        });
        req.on("timeout", () => {
          req.destroy(new Error("Request timed out"));
        });
        if (body) req.write(body);
        req.end();
      }),
    (error) => ({ ok: false, status: 0, headers: {}, body: "", json: null, error: error.message })
  );
}

async function requestText(method, targetUrl, body = "", headers = {}, timeout = 30000) {
  const target = new URL(targetUrl);
  let first = await requestTextOnce(method, target, body, headers, timeout);
  if (first.ok) return first;
  if (/ENOTFOUND|EAI_AGAIN/i.test(String(first.error || ""))) {
    const fallbackIp = resolveHostViaPowerShell(target.hostname);
    if (fallbackIp) {
      const fallbackUrl = new URL(target.href);
      fallbackUrl.hostname = fallbackIp;
      const viaDns = await requestTextOnce(method, fallbackUrl, body, { ...headers, host: target.host }, timeout, {
        servername: target.hostname,
      });
      if (viaDns.ok) return viaDns;
      first = viaDns;
    }
  }
  // 直连与 DNS 兜底都失败：最后尝试本地代理隧道（被墙端点的常规恢复路径）。
  if (UPSTREAM_PROXY_URL && target.protocol === "https:") {
    const viaProxy = await requestTextOnceViaProxy(UPSTREAM_PROXY_URL, method, target, body, headers, timeout);
    if (viaProxy.ok) return viaProxy;
    first = { ...first, proxyError: String(viaProxy.error || `status ${viaProxy.status}`) };
  }
  return first;
}

function retryableNetworkFailure(result) {
  const errorText = String(result?.error || result?.message || "");
  return result?.status === 0
    || /ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|timed out/i.test(errorText)
    || [408, 429, 500, 502, 503, 504].includes(Number(result?.status || 0));
}

async function requestTextWithRetry(method, targetUrl, body = "", headers = {}, timeout = 30000, attempts = 3) {
  let result = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = await requestText(method, targetUrl, body, headers, timeout);
    if (!retryableNetworkFailure(result) || attempt === attempts - 1) return result;
    await sleep(450 * (attempt + 1));
  }
  return result;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function formatCount(value) {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(Math.round(value));
}

function formatPercent(value) {
  return `${Math.round((Number.isFinite(value) ? value : 0) * 100)}%`;
}

function rowsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.v2_hourly)) {
    return payload.v2_hourly.map((row) => {
      const hour = String(row && row.hour_utc || "");
      return {
        date: hour.slice(0, 10),
        tool: row && row.tool,
        model: row && row.model,
        input: row && row.input,
        output: row && row.output,
        cache_read: row && row.cache_read,
        cache_write: row && row.cache_write,
      };
    });
  }
  return [];
}

function canRewriteV2Payload(payload) {
  return Boolean(payload && Array.isArray(payload.v2_hourly) && !payload.sig);
}

function claudeRowsToV2Hourly(rows, date) {
  const day = String(date || "");
  return (Array.isArray(rows) ? rows : []).filter((row) => (
    row && row.tool === "claude-code" && String(row.date || "") === day
  )).map((row) => ({
    hour_utc: day + "T00",
    tool: "claude-code",
    model: String(row.model || "unknown"),
    input: Number(row.input || 0),
    output: Number(row.output || 0),
    cache_read: Number(row.cache_read || 0),
    cache_write: Number(row.cache_write || 0),
  }));
}

function mergeClaudeIntoV2Hourly(existing, date, claudeHours) {
  const day = String(date || "");
  const hours = Array.isArray(existing) ? existing : [];
  const kept = hours.filter((row) => !(
    row && row.tool === "claude-code" && String(row.hour_utc || "").slice(0, 10) === day
  ));
  return kept.concat(Array.isArray(claudeHours) ? claudeHours : []);
}

function officialLedgerHasClaude(today) {
  const date = String(today || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(OFFICIAL_STATE_PATH, "utf8"));
    const usage = parsed && parsed.usage && typeof parsed.usage === "object" ? parsed.usage : null;
    if (!usage) return false;
    return Object.keys(usage).some((key) => {
      const item = String(key);
      return item.startsWith(date + "|") && /claude/i.test(item);
    });
  } catch {
    return false;
  }
}

﻿function officialLedgerRowCount(today) {
  const date = String(today || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(OFFICIAL_STATE_PATH, "utf8"));
    const usage = parsed && parsed.usage && typeof parsed.usage === "object" ? parsed.usage : null;
    if (!usage) return 0;
    return Object.keys(usage).filter((key) => String(key).startsWith(date + "|")).length;
  } catch {
    return 0;
  }
}

function readOfficialDaemonHealth() {
  try {
    const parsed = JSON.parse(fs.readFileSync(OFFICIAL_HEALTH_PATH, "utf8"));
    return {
      failures: Number(parsed?.failures || 0),
      lockSkips: Number(parsed?.lock_skips || 0),
      lastError: String(parsed?.last_error || "").slice(0, 200),
    };
  } catch {
    return { failures: 0, lockSkips: 0, lastError: "" };
  }
}
// EPERM means the pid exists but is owned by another user, so it is still alive.
function processAlive(pid) {
  const target = Number(pid || 0);
  if (!Number.isInteger(target) || target <= 0) return false;
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function readOfficialLock() {
  let raw;
  try {
    raw = fs.readFileSync(OFFICIAL_LOCK_PATH, "utf8").trim();
  } catch {
    return { present: false, pid: 0, stale: false };
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0) return { present: true, pid: 0, stale: false };
  return { present: true, pid, stale: !processAlive(pid) };
}
// The official watchdog kills the daemon mid-cycle and leaves its lock behind,
// which makes every later cycle skip. Clearing it is what lets a later cycle run.
function clearStaleOfficialLock() {
  const lock = readOfficialLock();
  if (!lock.present || !lock.stale) return false;
  try {
    fs.unlinkSync(OFFICIAL_LOCK_PATH);
    logIslandEvent("cleared stale official lock", { pid: lock.pid });
    return true;
  } catch {
    return false;
  }
}
// Pure so the contract test can cover every branch without touching disk.
function officialDaemonDiagnosis(input) {
  input = input || {};
  const rows = Math.max(0, Number(input.rows || 0));
  const hour = Number(input.hour);
  const failures = Math.max(0, Number(input.failures || 0));
  if (rows > 0) {
    return input.hasClaude
      ? { status: "ok", reason: "ledger-has-claude" }
      : { status: "blocked", reason: "ledger-missing-claude" };
  }
  if (Number.isFinite(hour) && hour < DAEMON_LEDGER_GRACE_HOUR) {
    return { status: "waiting", reason: "early-day" };
  }
  if (input.lockStale) return { status: "blocked", reason: "stale-lock" };
  if (failures > 0) return { status: "blocked", reason: "daemon-failing" };
  return { status: "blocked", reason: "ledger-empty" };
}
function maybeHealOfficialDaemon(now = Date.now()) {
  if (now - officialDaemonCheck.at < DAEMON_CHECK_INTERVAL_MS) return null;
  officialDaemonCheck.at = now;
  const today = localDateString();
  const lockCleared = clearStaleOfficialLock();
  const health = readOfficialDaemonHealth();
  if (health.failures > officialDaemonCheck.failures) {
    logIslandEvent("official daemon failures increased", health);
  }
  officialDaemonCheck.failures = health.failures;
  const rows = officialLedgerRowCount(today);
  const hour = new Date(now).getHours();
  if (rows === 0 && hour >= DAEMON_LEDGER_GRACE_HOUR && !backgroundUploadTask) {
    logIslandEvent("official ledger empty, retrying dated upload", { hour, lockCleared });
    triggerBackgroundUpload({ via: "self-heal" });
  }
  return { lockCleared, rows, health };
}

function rawTokens(row) {
  return Number(row.input || 0)
    + Number(row.output || 0)
    + Number(row.cache_read || 0)
    + Number(row.cache_write || 0);
}

function uploadRejected(reason) {
  throw new Error(`Upload payload rejected: ${reason}`);
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// 拒绝时只记录结构摘要（键名/类型/数组长度），绝不记录值，用于诊断未知 schema。
function payloadShapeSummary(value) {
  if (!plainObject(value)) return `type:${typeof value}`;
  const keys = Object.keys(value);
  const detail = {};
  for (const key of keys.slice(0, 24)) {
    const item = value[key];
    detail[key] = Array.isArray(item) ? `array[${item.length}]` : typeof item;
  }
  return JSON.stringify({ keys, detail });
}

function exactKeys(value, allowed, context) {
  if (!plainObject(value)) uploadRejected(`${context} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length) uploadRejected(`${context} contains unknown field ${extras[0]}`);
}

function safeProtocolString(value, field, maxLength = 160, { allowEmpty = false, sensitiveCheck = true } = {}) {
  if (typeof value !== "string") uploadRejected(`${field} must be a string`);
  const text = value.trim();
  if ((!allowEmpty && !text) || text.length > maxLength) uploadRejected(`${field} has invalid length`);
  if (sensitiveCheck && (
    /[\r\n]/.test(text)
    || /[a-z]:[\\/]/i.test(text)
    || /-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(text)
    || /(?:^|[\\/])(?:users|home|documents|desktop|private|\.ssh)(?:[\\/]|$)/i.test(text)
    || /(?:api[_-]?key|authorization|bearer|cookie|password|prompt|response|command|cwd)=/i.test(text)
  )) {
    uploadRejected(`${field} resembles sensitive content`);
  }
  return text;
}

function safeNonNegativeNumber(value, field) {
  if (value === undefined) return 0;
  if (typeof value !== "number") uploadRejected(`${field} must be a JSON number`);
  const number = value;
  if (!Number.isFinite(number) || number < 0) uploadRejected(`${field} must be a non-negative number`);
  return number;
}

// 0.3.5 CLI 的 client_health.unhoured 实测是数组（空 = 没有未入桶会话，取证日志 2026-08-17）。
// 信封带 sig 签名且转发走原始字节，这里只做有界闸门：数字（非负）/布尔/null/短字符串原样放行；
// 数组放行但限长、元素限有界原始值（防夹带敏感内容）；对象与其他类型拒绝。
function passthroughNonNegativeCount(value, field) {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) uploadRejected(`${field} must be non-negative`);
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length <= 64) return value;
    uploadRejected(`${field} string is too long`);
  }
  if (Array.isArray(value)) {
    if (value.length > 10000) uploadRejected(`${field} array is too large`);
    for (const item of value) {
      if (typeof item === "string" && item.length > 160) uploadRejected(`${field} entries must be bounded`);
      if (item !== null && !["string", "number", "boolean"].includes(typeof item)) {
        uploadRejected(`${field} entries must be primitives`);
      }
    }
    return value;
  }
  uploadRejected(`${field} must be a bounded primitive counter`);
}

function safeOpaqueToken(value, field, minLength = 8, maxLength = 512) {
  if (typeof value !== "string") uploadRejected(`${field} must be a string`);
  const text = value.trim();
  if (text.length < minLength || text.length > maxLength || !/^[A-Za-z0-9_-]+={0,2}$/.test(text)) {
    uploadRejected(`${field} must be a bounded hex or base64url token`);
  }
  return text;
}

function safeInteger(value, field) {
  const number = safeNonNegativeNumber(value, field);
  if (!Number.isInteger(number)) uploadRejected(`${field} must be an integer`);
  return number;
}

const USAGE_ROW_KEYS = ["date", "tool", "model", "input", "output", "cache_read", "cache_write", "normalized"];
function sanitizeUsageRow(row, index = 0) {
  exactKeys(row, USAGE_ROW_KEYS, `rows[${index}]`);
  const date = safeProtocolString(row.date, `rows[${index}].date`, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) uploadRejected(`rows[${index}].date is invalid`);
  return {
    date,
    tool: safeProtocolString(row.tool, `rows[${index}].tool`, 80),
    model: safeProtocolString(row.model ?? "unknown", `rows[${index}].model`, 160),
    input: safeNonNegativeNumber(row.input, `rows[${index}].input`),
    output: safeNonNegativeNumber(row.output, `rows[${index}].output`),
    cache_read: safeNonNegativeNumber(row.cache_read, `rows[${index}].cache_read`),
    cache_write: safeNonNegativeNumber(row.cache_write, `rows[${index}].cache_write`),
    normalized: safeNonNegativeNumber(row.normalized, `rows[${index}].normalized`),
  };
}

const SESSION_ROW_KEYS = ["date", "tool", "sessions", "messages", "user_messages", "active_seconds", "duration_seconds"];
function sanitizeSessionRow(row, index = 0) {
  exactKeys(row, SESSION_ROW_KEYS, `sessions[${index}]`);
  const date = safeProtocolString(row.date, `sessions[${index}].date`, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) uploadRejected(`sessions[${index}].date is invalid`);
  return {
    date,
    tool: safeProtocolString(row.tool, `sessions[${index}].tool`, 80),
    sessions: safeInteger(row.sessions, `sessions[${index}].sessions`),
    messages: safeInteger(row.messages, `sessions[${index}].messages`),
    user_messages: safeInteger(row.user_messages, `sessions[${index}].user_messages`),
    active_seconds: safeNonNegativeNumber(row.active_seconds, `sessions[${index}].active_seconds`),
    duration_seconds: safeNonNegativeNumber(row.duration_seconds, `sessions[${index}].duration_seconds`),
  };
}

// v2 事件流批数据（0.3.5 CLI 实际线格式，取自 upload --dry-run --v2 实测）：
// 根为 {v2_hourly:[...], v2_sessions:[...]}（真实发送可能另带 schema/nonce/sig 信封）。
const V2_HOURLY_KEYS = ["hour_utc", "tool", "model", "input", "output", "cache_read", "cache_write"];
// CLI 发小时桶 "YYYY-MM-DDTHH"；旧契约示例用过完整 ISO，两者都放行。
const HOUR_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}(:\d{2}:\d{2}(?:\.\d+)?Z?)?$/;
function sanitizeV2HourlyRow(row, index = 0) {
  exactKeys(row, V2_HOURLY_KEYS, `v2_hourly[${index}]`);
  const hourUtc = safeProtocolString(row.hour_utc, `v2_hourly[${index}].hour_utc`, 40);
  if (!HOUR_UTC_RE.test(hourUtc)) uploadRejected(`v2_hourly[${index}].hour_utc is invalid`);
  return {
    hour_utc: hourUtc,
    tool: safeProtocolString(row.tool, `v2_hourly[${index}].tool`, 80),
    model: safeProtocolString(row.model ?? "unknown", `v2_hourly[${index}].model`, 160),
    input: safeNonNegativeNumber(row.input, `v2_hourly[${index}].input`),
    output: safeNonNegativeNumber(row.output, `v2_hourly[${index}].output`),
    cache_read: safeNonNegativeNumber(row.cache_read, `v2_hourly[${index}].cache_read`),
    cache_write: safeNonNegativeNumber(row.cache_write, `v2_hourly[${index}].cache_write`),
  };
}

// 会话统计用 started/ended（Unix 秒整数）而非 ISO 字符串；session_key 为 40 位 hex。
const V2_SESSION_KEYS = ["date", "tool", "session_key", "started", "ended", "messages", "user_messages", "active_seconds"];
function sanitizeV2SessionRow(row, index = 0) {
  exactKeys(row, V2_SESSION_KEYS, `v2_sessions[${index}]`);
  const date = safeProtocolString(row.date, `v2_sessions[${index}].date`, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) uploadRejected(`v2_sessions[${index}].date is invalid`);
  return {
    date,
    tool: safeProtocolString(row.tool, `v2_sessions[${index}].tool`, 80),
    session_key: safeOpaqueToken(row.session_key, `v2_sessions[${index}].session_key`, 16, 160),
    started: safeInteger(row.started, `v2_sessions[${index}].started`),
    ended: safeInteger(row.ended, `v2_sessions[${index}].ended`),
    messages: safeInteger(row.messages, `v2_sessions[${index}].messages`),
    user_messages: safeInteger(row.user_messages, `v2_sessions[${index}].user_messages`),
    active_seconds: safeNonNegativeNumber(row.active_seconds, `v2_sessions[${index}].active_seconds`),
  };
}

function sanitizeActivityEvent(event, index = 0) {
  if (!plainObject(event)) uploadRejected(`events[${index}] must be an object`);
  const type = safeProtocolString(event.type, `events[${index}].type`, 40);
  // 0.3.5 CLI 实测事件类型是 "hourly"/"session"（取证日志 2026-08-17）；保留旧契约名 usage_hourly 兼容。
  // 消毒只校验不改写：类型名与字段原样透传，上游 scys 认 CLI 的原始形状。
  if (type === "usage_hourly" || type === "hourly") {
    exactKeys(event, ["type", ...V2_HOURLY_KEYS], `events[${index}]`);
    const { type: _typeTag, ...row } = event;
    return { type, ...sanitizeV2HourlyRow(row, index) };
  }
  if (type === "session") {
    // 新形状：started/ended Unix 秒 + date（dry-run 实测）；旧形状：started_at/ended_at ISO 字符串。
    if ("started" in event || "date" in event) {
      exactKeys(event, ["type", ...V2_SESSION_KEYS], `events[${index}]`);
      const { type: _typeTag, ...row } = event;
      return { type, ...sanitizeV2SessionRow(row, index) };
    }
    exactKeys(event, ["type", "tool", "session_key", "started_at", "ended_at", "messages", "user_messages", "active_seconds"], `events[${index}]`);
    return {
      type,
      tool: safeProtocolString(event.tool, `events[${index}].tool`, 80),
      session_key: safeProtocolString(event.session_key, `events[${index}].session_key`, 160),
      started_at: safeProtocolString(event.started_at, `events[${index}].started_at`, 40),
      ended_at: safeProtocolString(event.ended_at, `events[${index}].ended_at`, 40),
      messages: safeInteger(event.messages, `events[${index}].messages`),
      user_messages: safeInteger(event.user_messages, `events[${index}].user_messages`),
      active_seconds: safeNonNegativeNumber(event.active_seconds, `events[${index}].active_seconds`),
    };
  }
  if (type === "client_health") {
    exactKeys(event, ["type", "captured_at", "payload"], `events[${index}]`);
    exactKeys(event.payload, ["scan_ms", "ledger", "unhoured"], `events[${index}].payload`);
    exactKeys(event.payload.ledger, ["usage", "hourly", "v2_sessions"], `events[${index}].payload.ledger`);
    return {
      type,
      captured_at: safeProtocolString(event.captured_at, `events[${index}].captured_at`, 40),
      payload: {
        scan_ms: safeNonNegativeNumber(event.payload.scan_ms, `events[${index}].payload.scan_ms`),
        ledger: {
          usage: safeInteger(event.payload.ledger.usage, `events[${index}].payload.ledger.usage`),
          hourly: safeInteger(event.payload.ledger.hourly, `events[${index}].payload.ledger.hourly`),
          v2_sessions: safeInteger(event.payload.ledger.v2_sessions, `events[${index}].payload.ledger.v2_sessions`),
        },
        unhoured: passthroughNonNegativeCount(event.payload.unhoured, `events[${index}].payload.unhoured`),
      },
    };
  }
  uploadRejected(`events[${index}].type (${type}) is unsupported`);
}

function sanitizeUploadPayload(payload) {
  if (!plainObject(payload)) uploadRejected("root must be an object");
  if (Array.isArray(payload.rows)) {
    exactKeys(payload, ["version", "device", "rows", "sessions"], "root");
    if (payload.rows.length > 10000 || (payload.sessions || []).length > 10000) uploadRejected("too many rows");
    return {
      version: typeof payload.version === "string"
        ? safeProtocolString(payload.version, "version", 20)
        : safeNonNegativeNumber(payload.version, "version"),
      device: safeProtocolString(payload.device, "device", 160),
      rows: payload.rows.map(sanitizeUsageRow),
      sessions: (Array.isArray(payload.sessions) ? payload.sessions : uploadRejected("sessions must be an array")).map(sanitizeSessionRow),
    };
  }
  if (Array.isArray(payload.v2_hourly) || Array.isArray(payload.v2_sessions)) {
    exactKeys(payload, ["schema", "version", "device", "seq", "sent_at", "tz", "nonce", "sig", "v2_hourly", "v2_sessions"], "root");
    const hourly = Array.isArray(payload.v2_hourly) ? payload.v2_hourly : [];
    const sessions = Array.isArray(payload.v2_sessions) ? payload.v2_sessions : [];
    if (hourly.length > 10000 || sessions.length > 10000) uploadRejected("too many rows");
    const sanitized = {
      v2_hourly: hourly.map(sanitizeV2HourlyRow),
      v2_sessions: sessions.map(sanitizeV2SessionRow),
    };
    // 信封字段全部可选（dry-run 只发内层批数据；真实发送是否带信封以实测为准），逐个按类型消毒透传。
    if (payload.schema !== undefined) sanitized.schema = safeProtocolString(payload.schema, "schema", 80);
    if (payload.version !== undefined) {
      sanitized.version = typeof payload.version === "string"
        ? safeProtocolString(payload.version, "version", 20)
        : safeNonNegativeNumber(payload.version, "version");
    }
    if (payload.device !== undefined) sanitized.device = safeProtocolString(payload.device, "device", 160);
    if (payload.seq !== undefined) sanitized.seq = safeInteger(payload.seq, "seq");
    if (payload.sent_at !== undefined) sanitized.sent_at = safeProtocolString(payload.sent_at, "sent_at", 40);
    if (payload.tz !== undefined) sanitized.tz = safeProtocolString(payload.tz, "tz", 80);
    if (payload.nonce !== undefined) sanitized.nonce = safeOpaqueToken(payload.nonce, "nonce");
    if (payload.sig !== undefined) sanitized.sig = safeOpaqueToken(payload.sig, "sig", 16);
    return sanitized;
  }
  if (Array.isArray(payload.events)) {
    exactKeys(payload, ["schema", "version", "device", "seq", "sent_at", "tz", "nonce", "events", "sig"], "root");
    if (payload.events.length > 10000) uploadRejected("too many events");
    return {
      // 0.3.5 CLI 实测：schema 发数字、version 发字符串（取证日志 2026-08-16），两者都兼容。
      schema: typeof payload.schema === "string"
        ? safeProtocolString(payload.schema, "schema", 80)
        : safeNonNegativeNumber(payload.schema, "schema"),
      version: typeof payload.version === "string"
        ? safeProtocolString(payload.version, "version", 20)
        : safeNonNegativeNumber(payload.version, "version"),
      device: safeProtocolString(payload.device, "device", 160),
      seq: safeInteger(payload.seq, "seq"),
      sent_at: safeProtocolString(payload.sent_at, "sent_at", 40),
      // 0.3.5 CLI 夜间批次实测 tz 可为空串（取证日志 2026-08-17）；时区是纯元数据，放行空值。
      tz: safeProtocolString(payload.tz, "tz", 80, { allowEmpty: true }),
      nonce: safeOpaqueToken(payload.nonce, "nonce"),
      events: payload.events.map(sanitizeActivityEvent),
      sig: safeOpaqueToken(payload.sig, "sig", 16),
    };
  }
  uploadRejected("unknown schema");
}

function normalizeToolName(name) {
  const clean = String(name || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9.+-]/g, "");

  if (!clean) return "unknown";
  if (clean.includes("codex")) return "codex";
  if (clean.includes("claude")) return "claude-code";
  if (clean.includes("gemini")) return "gemini";
  if (clean.includes("openclaw")) return "openclaw";
  if (clean.includes("opencode")) return "opencode";
  if (
    clean === "gpt"
    || clean.startsWith("gpt")
    || clean.includes("chatgpt")
    || clean === "openai"
    || clean.startsWith("openai-")
  ) {
    return "gpt";
  }
  if (
    clean === "glm"
    || clean.startsWith("glm")
    || clean.includes("zhipu")
    || clean.includes("bigmodel")
    || clean === "zai"
    || clean === "z-ai"
    || clean.startsWith("zai-")
    || clean.startsWith("z-ai-")
  ) {
    return "glm";
  }
  return clean;
}

function normalizeToolMap(byTool = {}) {
  const normalized = {};
  for (const [name, value] of Object.entries(byTool || {})) {
    const tool = normalizeToolName(name);
    normalized[tool] = (normalized[tool] || 0) + Number(value || 0);
  }
  return normalized;
}

function summarizeRows(rows, preferredDate = "") {
  const dates = [...new Set(rows.map((row) => row.date).filter(Boolean))].sort();
  // 传入日期代表调用方要求严格的日边界；当天没有行时必须返回 0，不能悄悄回退到昨天。
  // 不传日期的上传解析仍保留“取 payload 最新日期”的行为。
  const date = preferredDate || dates[dates.length - 1] || "";
  const dayRows = rows.filter((row) => row.date === date);
  const byTool = {};
  const normalizedByTool = {};
  let normalized = 0;
  for (const row of dayRows) {
    const tool = normalizeToolName(row.tool || row.provider || row.client || "unknown");
    const rowNormalized = Number(row.normalized || 0);
    byTool[tool] = (byTool[tool] || 0) + rawTokens(row);
    normalizedByTool[tool] = (normalizedByTool[tool] || 0) + rowNormalized;
    normalized += rowNormalized;
  }
  const total = Object.values(byTool).reduce((sum, value) => sum + value, 0);
  return { date, total, normalized, byTool, normalizedByTool, rowCount: dayRows.length };
}

function localUsageRow(row, fallbackDate = "") {
  if (!row || typeof row !== "object") return null;
  const date = String(row.date || fallbackDate || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const tool = normalizeToolName(row.tool || row.provider || row.client || "unknown");
  const model = String(row.model || "unknown").slice(0, 160);
  const clean = { date, tool, model };
  for (const field of ["input", "output", "cache_read", "cache_write", "normalized"]) {
    const value = Number(row[field] || 0);
    clean[field] = Number.isFinite(value) && value >= 0 ? value : 0;
  }
  return clean;
}

function localUsageRowKey(row) {
  return `${row.date}\u0000${row.tool}\u0000${row.model}`;
}

function mergeLocalUsageSnapshot(previous, incomingRows = [], options = {}) {
  const date = String(options.date || localDateString());
  const replace = Boolean(options.replace);
  const reset = replace || previous?.date !== date;
  const rowsByKey = new Map();
  if (!reset) {
    for (const item of previous?.rows || []) {
      const row = localUsageRow(item, date);
      if (row && row.date === date) rowsByKey.set(localUsageRowKey(row), row);
    }
  }
  for (const item of incomingRows) {
    const row = localUsageRow(item, date);
    if (!row || row.date !== date) continue;
    const key = localUsageRowKey(row);
    const existing = rowsByKey.get(key);
    if (!existing || replace) {
      rowsByKey.set(key, row);
      continue;
    }
    rowsByKey.set(key, {
      ...existing,
      input: Math.max(existing.input, row.input),
      output: Math.max(existing.output, row.output),
      cache_read: Math.max(existing.cache_read, row.cache_read),
      cache_write: Math.max(existing.cache_write, row.cache_write),
      normalized: Math.max(existing.normalized, row.normalized),
    });
  }
  const rows = [...rowsByKey.values()].sort((a, b) => localUsageRowKey(a).localeCompare(localUsageRowKey(b)));
  const summary = summarizeRows(rows, date);
  const updatedAt = String(options.updatedAt || new Date().toISOString());
  return {
    schemaVersion: 1,
    revision: Math.max(0, Number(previous?.revision || 0)) + 1,
    date,
    source: String(options.source || (replace ? "preview" : "upload-observed")),
    completeness: replace || (!reset && previous?.completeness === "full") ? "full" : "observed",
    updatedAt,
    fullAt: replace ? updatedAt : String(!reset ? previous?.fullAt || "" : ""),
    rows,
    summary,
  };
}

function persistLocalUsageRows(rows, options = {}) {
  const date = String(options.date || localDateString());
  if (date !== localDateString() && state.localUsage?.date === localDateString()) return state.localUsage;
  state.localUsage = mergeLocalUsageSnapshot(state.localUsage, rows, { ...options, date });
  saveState();
  return state.localUsage;
}

function toolsFromUsageMaps(rawByTool = {}, normalizedByTool = {}) {
  const names = [
    ...new Set([
      ...Object.keys(rawByTool || {}),
      ...Object.keys(normalizedByTool || {}),
    ]),
  ];
  const entries = names
    .map((name) => {
      const rawValue = Number(rawByTool[name] || 0);
      const normalizedValue = Number(normalizedByTool[name] || 0);
      const value = rawValue > 0 ? rawValue : normalizedValue;
      return { name, value, rawValue, normalizedValue };
    })
    .filter((tool) => tool.value > 0 || tool.rawValue > 0)
    .sort((a, b) => b.value - a.value);
  const max = Math.max(1, ...entries.map((tool) => tool.value));
  return entries.map(({ name, value, rawValue, normalizedValue }) => ({
    name,
    value,
    rawValue,
    normalizedValue,
    label: toolLabel(name),
    valueLabel: formatCount(value),
    rawValueLabel: formatCount(rawValue),
    normalizedLabel: normalizedValue > 0 ? formatCount(normalizedValue) : "",
    detail: normalizedValue > 0 && normalizedValue !== value
      ? `新增 ${formatCount(normalizedValue)}`
      : "",
    pct: Math.max(4, Math.round((value / max) * 100)),
  }));
}

function toolsFromMap(byTool = {}) {
  return toolsFromUsageMaps(byTool, {});
}

function usageToolEntry(name, value, rawValue = value, normalizedValue = 0, detail = "") {
  const numericValue = Number(value || 0);
  const numericRaw = Number(rawValue || 0);
  const numericNormalized = Number(normalizedValue || 0);
  return {
    name,
    value: numericValue,
    rawValue: numericRaw,
    normalizedValue: numericNormalized,
    label: toolLabel(name),
    valueLabel: formatCount(numericValue),
    rawValueLabel: formatCount(numericRaw),
    normalizedLabel: numericNormalized > 0 ? formatCount(numericNormalized) : "",
    detail,
  };
}

function finalizeUsageTools(entries = []) {
  const filtered = entries
    .filter((tool) => Number(tool.value || 0) > 0)
    .sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
  const max = Math.max(1, ...filtered.map((tool) => Number(tool.value || 0)));
  return filtered.map((tool) => ({
    ...tool,
    pct: Math.max(4, Math.round((Number(tool.value || 0) / max) * 100)),
  }));
}

function scysLocalByTool(localByTool = {}, boardByTool = {}) {
  const scored = {};
  const board = normalizeToolMap(boardByTool);
  for (const [name, value] of Object.entries(normalizeToolMap(localByTool))) {
    const rawValue = Number(value || 0);
    if (rawValue <= 0) continue;
    const boardValue = Number(board[name] || 0);
    scored[name] = boardValue > 0 ? Math.min(rawValue, boardValue) : rawValue;
  }
  return scored;
}

function actualUsageSummary(rawByToolInput = {}, normalizedByToolInput = {}) {
  const rawByTool = normalizeToolMap(rawByToolInput);
  const normalizedByTool = normalizeToolMap(normalizedByToolInput);
  const entries = [];
  const codexValue = Number(rawByTool.codex || 0);

  if (codexValue > 0) {
    const normalizedValue = Number(normalizedByTool.codex || 0);
    entries.push(usageToolEntry(
      "codex",
      codexValue,
      codexValue,
      normalizedValue,
      normalizedValue > 0 ? `新增 ${formatCount(normalizedValue)}` : "OpenToken raw",
    ));
  }

  const claudeValue = Number(rawByTool["claude-code"] || 0);
  if (claudeValue > 0) {
    const normalizedValue = Number(normalizedByTool["claude-code"] || 0);
    entries.push(usageToolEntry(
      "claude-code",
      claudeValue,
      claudeValue,
      normalizedValue,
      normalizedValue > 0 ? `新增 ${formatCount(normalizedValue)}` : "OpenToken raw",
    ));
  }

  for (const [name, value] of Object.entries(rawByTool)) {
    if (["codex", "claude-code"].includes(name)) continue;
    const rawValue = Number(value || 0);
    if (rawValue <= 0) continue;
    const normalizedValue = Number(normalizedByTool[name] || 0);
    entries.push(usageToolEntry(
      name,
      rawValue,
      rawValue,
      normalizedValue,
      normalizedValue > 0 ? `新增 ${formatCount(normalizedValue)}` : "OpenToken raw",
    ));
  }

  const tools = finalizeUsageTools(entries);
  return {
    total: tools.reduce((sum, tool) => sum + Number(tool.value || 0), 0),
    tools,
  };
}

function toolLabel(name) {
  const labels = {
    "claude-code": "Claude Code",
    codex: "Codex",
    gemini: "Gemini",
    glm: "GLM / Z.ai",
    gpt: "GPT / OpenAI",
    openclaw: "OpenClaw",
    opencode: "opencode",
  };
  return labels[name] || name.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function toolIcon(name) {
  const icons = {
    "claude-code": "bot",
    codex: "zap",
    gemini: "sparkles",
    glm: "brain-circuit",
    gpt: "sparkle",
    openclaw: "terminal",
    opencode: "code-2",
  };
  return icons[name] || "terminal";
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function formatZaiDateTime(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function localDateString(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isSameLocalDate(value, expectedDate = localDateString()) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return localDateString(date) === expectedDate;
}

function localHourKey(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}`;
}

function quotaInstant(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 0 && value < 1e12 ? value * 1000 : value);
  }
  const text = String(value || "").trim();
  if (!text) return null;
  if (/^\d{10,13}$/.test(text)) {
    const number = Number(text);
    return new Date(text.length <= 10 ? number * 1000 : number);
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatResetTime(value) {
  const date = quotaInstant(value);
  if (!date) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function zaiFailureReason(message = "") {
  const text = String(message || "").toLowerCase();
  if (/(401|403|unauth|authentication|forbidden|invalid|expired|expire|\bkey\b|token|认证|授权|失效|无权|非法)/i.test(text)) {
    return "auth";
  }
  return "read";
}

function quotaUnavailableState(reason = "waiting") {
  const states = {
    "not-connected": { valueLabel: "未配置", detail: "前往 Coding Quota Bar 绑定 Z.ai" },
    auth: { valueLabel: "API Key 失效", detail: "请在 Coding Quota Bar 更新密钥" },
    read: { valueLabel: "无法读取额度", detail: "Z.ai 接口暂不可用" },
    waiting: { valueLabel: "--", detail: "等待额度上报" },
  };
  return states[reason] || states.waiting;
}

function quotaItemUnavailable(key, label, reason = "waiting") {
  const state = quotaUnavailableState(reason);
  return {
    key,
    label,
    status: reason === "waiting" ? "waiting" : "error",
    value: 0,
    total: 0,
    valueLabel: state.valueLabel,
    detail: state.detail,
    pct: 4,
  };
}

function quotaFeedUnavailable(key, label, reason = "waiting", items = []) {
  const state = quotaUnavailableState(reason);
  return {
    key,
    label,
    reason,
    status: reason === "waiting" ? "waiting" : "error",
    valueLabel: state.valueLabel,
    detail: state.detail,
    pct: 4,
    items: items.length ? items : [quotaItemUnavailable(`${key}-main`, label, reason)],
  };
}

const CURSOR_API_BASE = "https://api2.cursor.sh";
const CURSOR_ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const GROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const CURSOR_QUOTA_COPY = {
  "not-connected": { valueLabel: "未登录", detail: "本机未找到 Cursor 登录态" },
  auth: { valueLabel: "登录失效", detail: "请在 Cursor 中重新登录" },
  read: { valueLabel: "无法读取额度", detail: "Cursor 接口暂不可用" },
  waiting: { valueLabel: "--", detail: "等待 Cursor 额度" },
};
const GROK_QUOTA_COPY = {
  "not-connected": { valueLabel: "未登录", detail: "请先运行 grok login" },
  auth: { valueLabel: "登录过期", detail: "请重新运行 grok login" },
  read: { valueLabel: "无法读取额度", detail: "Grok 接口暂不可用" },
  waiting: { valueLabel: "--", detail: "等待 Grok CLI 额度" },
};
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_QUOTA_COPY = {
  "not-connected": { valueLabel: "未配置", detail: "OpenCodex 里没有 Kimi 编程套餐 key" },
  auth: { valueLabel: "密钥失效", detail: "Kimi 拒绝了当前 key，请在 OpenCodex 重新配置" },
  read: { valueLabel: "无法读取额度", detail: "Kimi 接口暂不可用" },
  waiting: { valueLabel: "--", detail: "等待 Kimi 编程套餐额度" },
};

const CODEX_QUOTA_COPY = {
  "not-connected": { valueLabel: "未登录", detail: "请先运行 codex auth login" },
  auth: { valueLabel: "登录失效", detail: "请重新运行 codex auth login" },
  read: { valueLabel: "无法读取额度", detail: "Codex 接口暂不可用" },
  waiting: { valueLabel: "--", detail: "等待 Codex CLI 额度" },
};

function quotaCopyState(copy, reason = "waiting") {
  return copy[reason] || copy.waiting;
}

function providerQuotaUnavailable(key, label, copy, itemDefs, reason = "waiting") {
  const state = quotaCopyState(copy, reason);
  return {
    key,
    label,
    reason,
    status: reason === "waiting" ? "waiting" : "error",
    valueLabel: state.valueLabel,
    detail: state.detail,
    pct: 4,
    items: itemDefs.map((item) => ({
      key: item.key,
      label: item.label,
      status: reason === "waiting" ? "waiting" : "error",
      value: 0,
      total: 0,
      valueLabel: state.valueLabel,
      remainingLabel: "--",
      resetLabel: "",
      detail: state.detail,
      pct: 4,
    })),
  };
}

function cursorQuotaUnavailable(reason = "waiting") {
  return providerQuotaUnavailable("cursor", "Cursor", CURSOR_QUOTA_COPY, [
    { key: "cursor-models", label: "Cursor 模型" },
    { key: "cursor-api", label: "其他模型" },
  ], reason);
}

function grokQuotaUnavailable(reason = "waiting") {
  return providerQuotaUnavailable("grok", "Grok", GROK_QUOTA_COPY, [
    { key: "grok-period", label: "周期额度" },
  ], reason);
}

function codexQuotaUnavailable(reason = "waiting") {
  return providerQuotaUnavailable("codex", "Codex", CODEX_QUOTA_COPY, [
    { key: "codex-5h", label: "5小时额度" },
    { key: "codex-weekly", label: "周额度" },
  ], reason);
}

function kimiQuotaUnavailable(reason = "waiting") {
  return providerQuotaUnavailable("kimi", "Kimi", KIMI_QUOTA_COPY, [
    { key: "kimi-5h", label: "5小时额度" },
    { key: "kimi-weekly", label: "周额度" },
  ], reason);
}

function moneyVal(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (value.val != null) return Number(value.val);
    if (value.value != null) return Number(value.value);
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function formatUsdCents(cents) {
  const amount = moneyVal(cents) / 100;
  return `$${(Number.isFinite(amount) ? amount : 0).toFixed(2)}`;
}

function quotaPercentParts(usedPct) {
  const pctRaw = clampPercent(usedPct);
  const remaining = Math.max(0, 100 - Math.round(pctRaw));
  return {
    pctRaw,
    pct: Math.max(4, Math.round(pctRaw)),
    remaining,
    remainingLabel: `剩余 ${remaining}%`,
  };
}

function cursorSpendItem(key, label, usedCents, limitCents, resetAt) {
  const used = Math.max(0, moneyVal(usedCents));
  const total = Math.max(0, moneyVal(limitCents));
  const parts = quotaPercentParts(total > 0 ? (used / total) * 100 : 0);
  const resetLabel = resetAt ? `${resetAt} 重置` : "";
  return {
    key,
    label,
    status: "ok",
    value: used,
    total,
    valueLabel: total > 0 ? `${formatUsdCents(used)} / ${formatUsdCents(total)}` : formatUsdCents(used),
    remainingLabel: parts.remainingLabel,
    resetLabel,
    detail: `${parts.remainingLabel}${resetLabel ? ` · ${resetLabel}` : ""}`,
    pct: parts.pct,
    resetAt,
  };
}

function cursorPercentItem(key, label, usedPct, caption = "") {
  const parts = quotaPercentParts(usedPct);
  const usedLabel = `已用 ${Math.round(parts.pctRaw)}%`;
  // 与其他供应商的额度卡一致：大字（valueLabel）显示剩余，已用退到明细行。
  const detail = [caption, usedLabel].filter(Boolean).join(" · ");
  return {
    key,
    label,
    status: "ok",
    value: parts.pctRaw,
    total: 100,
    valueLabel: parts.remainingLabel,
    usedLabel,
    remainingLabel: parts.remainingLabel,
    resetLabel: "",
    detail,
    pct: parts.pct,
  };
}

function cursorOnDemandItem(spendLimit, resetAt) {
  const onDemandLimit = moneyVal(spendLimit.individualLimit || spendLimit.pooledLimit);
  const onDemandUsed = moneyVal(spendLimit.individualUsed ?? spendLimit.pooledUsed ?? spendLimit.totalSpend);
  if (!(onDemandLimit > 0)) return null;
  return cursorSpendItem("cursor-ondemand", "按量超额", onDemandUsed, onDemandLimit, resetAt);
}

function buildCursorQuotaFeed(usageJson, planJson = null) {
  const payload = plainObject(usageJson) ? usageJson : {};
  const planUsage = plainObject(payload.planUsage) ? payload.planUsage : null;
  const included = moneyVal(planUsage?.includedSpend ?? planUsage?.totalSpend);
  const limit = moneyVal(planUsage?.limit);
  const autoPct = Number(planUsage?.autoPercentUsed);
  const apiPct = Number(planUsage?.apiPercentUsed);
  const hasAuto = Number.isFinite(autoPct);
  const hasApi = Number.isFinite(apiPct);
  if (!planUsage || !(limit > 0 || included > 0 || hasAuto || hasApi)) return cursorQuotaUnavailable("read");

  const resetAt = formatResetTime(payload.billingCycleEnd || planUsage.billingCycleEnd);
  const items = [];
  if (hasAuto || hasApi) {
    if (hasAuto) items.push(cursorPercentItem("cursor-models", "Cursor 模型", autoPct, "含 Grok / Composer"));
    if (hasApi) {
      items.push(cursorPercentItem(
        "cursor-api",
        "其他模型",
        apiPct,
        limit > 0 ? `至少 ${formatUsdCents(limit)} API` : "",
      ));
    }
  } else {
    items.push(cursorSpendItem("cursor-included", "套餐额度", included, limit || included, resetAt));
  }

  const spendLimit = plainObject(payload.spendLimitUsage) ? payload.spendLimitUsage : {};
  const onDemand = cursorOnDemandItem(spendLimit, resetAt);
  if (onDemand) items.push(onDemand);
  else if (!hasAuto && !hasApi) {
    items.push({
      key: "cursor-ondemand",
      label: "按量超额",
      status: "waiting",
      value: 0,
      total: 0,
      valueLabel: "未开启",
      remainingLabel: "--",
      resetLabel: "",
      detail: "当前套餐未开启按量超额",
      pct: 4,
    });
  }

  const planName = String(planJson?.planInfo?.planName || planJson?.planName || "").trim();
  const primary = items[0];
  const summaryBits = [
    resetAt ? `${resetAt} 重置` : "",
    onDemand ? "按量超额已开启" : (hasAuto || hasApi ? "按量超额已禁用" : ""),
  ].filter(Boolean);
  return {
    key: "cursor",
    label: "Cursor",
    status: "ok",
    reason: "",
    value: primary.value,
    total: primary.total,
    valueLabel: primary.usedLabel || primary.valueLabel,
    detail: summaryBits.join(" · ") || primary.detail,
    levelLabel: planName ? planName.toUpperCase() : "",
    pct: primary.pct,
    items,
  };
}

function grokBillingConfig(payload) {
  if (!plainObject(payload)) return {};
  if (plainObject(payload.config)) return { ...payload, ...payload.config };
  return payload;
}

function grokUsedPercent(payload) {
  const config = grokBillingConfig(payload);
  const direct = Number(config.creditUsagePercent);
  if (Number.isFinite(direct)) return clampPercent(direct);
  const used = moneyVal(config.used || config.usage?.totalUsed);
  const limit = moneyVal(config.monthlyLimit);
  if (limit > 0) return clampPercent((used / limit) * 100);
  const onDemandUsed = moneyVal(config.onDemandUsed || config.usage?.onDemandUsed);
  const onDemandCap = moneyVal(config.onDemandCap);
  if (onDemandCap > 0) return clampPercent((onDemandUsed / onDemandCap) * 100);
  return 0;
}

function buildGrokQuotaFeed(creditsJson, settingsJson = null) {
  const payload = plainObject(creditsJson) ? creditsJson : {};
  const config = grokBillingConfig(payload);
  const used = moneyVal(config.used || config.usage?.totalUsed);
  const monthlyLimit = moneyVal(config.monthlyLimit);
  const periodEnd = config.currentPeriod?.end
    || config.billingPeriodEnd
    || payload.billingCycle?.billingPeriodEnd
    || config.billingCycle?.billingPeriodEnd;
  const hasSignal = Number.isFinite(Number(config.creditUsagePercent))
    || monthlyLimit > 0
    || used > 0
    || Boolean(periodEnd);
  if (!hasSignal) return grokQuotaUnavailable("read");

  const usedPct = grokUsedPercent(payload);
  const parts = quotaPercentParts(usedPct);
  const resetAt = formatResetTime(periodEnd);
  const resetLabel = resetAt ? `${resetAt} 重置` : "";
  const periodItem = {
    key: "grok-period",
    label: "周期额度",
    status: "ok",
    value: used,
    total: monthlyLimit,
    valueLabel: monthlyLimit > 0 ? `${Math.round(used)} / ${Math.round(monthlyLimit)}` : `已用 ${Math.round(usedPct)}%`,
    remainingLabel: parts.remainingLabel,
    resetLabel,
    detail: `${parts.remainingLabel}${resetLabel ? ` · ${resetLabel}` : ""}`,
    pct: parts.pct,
    resetAt,
  };
  const tier = String(
    settingsJson?.subscription_tier_display
    || settingsJson?.subscriptionTierDisplay
    || settingsJson?.config?.subscription_tier_display
    || "",
  ).trim();
  return {
    key: "grok",
    label: "Grok",
    status: "ok",
    reason: "",
    value: periodItem.value,
    total: periodItem.total,
    valueLabel: periodItem.valueLabel,
    detail: periodItem.detail,
    levelLabel: tier ? tier.toUpperCase() : "",
    pct: periodItem.pct,
    items: [periodItem],
  };
}

function selectGrokCliAuth(authJson, now = Date.now()) {
  if (!plainObject(authJson)) return null;
  const entries = Object.entries(authJson).filter(([, value]) => plainObject(value) && value.key);
  if (!entries.length) return null;
  const preferred = entries.find(([key]) => String(key).startsWith("https://auth.x.ai::"))
    || entries.find(([key]) => String(key).includes("auth.x.ai"))
    || entries[0];
  const record = preferred[1];
  const expiresAt = Date.parse(record.expires_at || "");
  return {
    bearer: String(record.key),
    expired: Number.isFinite(expiresAt) ? expiresAt <= now : false,
    expiresAt: Number.isFinite(expiresAt) ? new Date(expiresAt).toISOString() : "",
    fingerprint: crypto.createHash("sha256").update(String(record.user_id || record.team_id || preferred[0])).digest("hex").slice(0, 16),
  };
}

function selectCodexCliAuth(authJson) {
  if (!plainObject(authJson)) return null;
  const tokens = plainObject(authJson.tokens) ? authJson.tokens : authJson;
  const bearer = String(tokens.access_token || "").trim();
  if (!bearer) return null;
  const accountId = String(tokens.account_id || "").trim();
  return {
    bearer,
    accountId,
    fingerprint: crypto.createHash("sha256").update(accountId || "codex").digest("hex").slice(0, 16),
  };
}

function codexWindowMeta(window) {
  const seconds = Number(window?.limit_window_seconds || 0);
  if (seconds >= 15000 && seconds <= 22000) return { key: "codex-5h", label: "5小时额度" };
  if (seconds >= 500000 && seconds <= 700000) return { key: "codex-weekly", label: "周额度" };
  if (seconds > 0) return { key: `codex-${seconds}`, label: `${Math.max(1, Math.round(seconds / 3600))}小时额度` };
  return { key: "codex-window", label: "周期额度" };
}

function codexRateWindowItem(window) {
  if (!plainObject(window) || !Number.isFinite(Number(window.used_percent))) return null;
  const usedPct = clampPercent(Number(window.used_percent));
  const parts = quotaPercentParts(usedPct);
  const resetAt = formatResetTime(window.reset_at || (Number(window.reset_after_seconds) > 0
    ? Date.now() + Number(window.reset_after_seconds) * 1000
    : ""));
  const resetLabel = resetAt ? `${resetAt} 重置` : "";
  const meta = codexWindowMeta(window);
  return {
    key: meta.key,
    label: meta.label,
    status: "ok",
    value: usedPct,
    total: 100,
    valueLabel: `已用 ${Math.round(usedPct)}%`,
    remainingLabel: parts.remainingLabel,
    resetLabel,
    detail: `${parts.remainingLabel}${resetLabel ? ` · ${resetLabel}` : ""}`,
    pct: parts.pct,
    resetAt,
  };
}

function buildCodexQuotaFeed(usageJson) {
  const payload = plainObject(usageJson) ? usageJson : {};
  const rate = plainObject(payload.rate_limit) ? payload.rate_limit : payload;
  const items = [rate.primary_window, rate.secondary_window]
    .map(codexRateWindowItem)
    .filter(Boolean);
  if (!items.length) return codexQuotaUnavailable("read");
  const planName = String(payload.plan_type || payload.planType || "").trim();
  const primary = items[0];
  return {
    key: "codex",
    label: "Codex",
    status: "ok",
    reason: "",
    value: primary.value,
    total: primary.total,
    valueLabel: primary.valueLabel,
    detail: primary.detail,
    levelLabel: planName ? planName.toUpperCase() : "",
    pct: primary.pct,
    items,
  };
}

// Kimi 编程套餐的 key 由 OpenCodex 代理持有，这里只读来查额度，绝不写进 island-state。
function kimiCodingConfigPath() {
  return path.join(HOME, ".opencodex", "config.json");
}

function loadKimiCodingAuth() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(kimiCodingConfigPath(), "utf8"));
  } catch {
    return null;
  }
  const provider = parsed?.providers?.kimicode;
  const apiKey = resolveConfiguredSecret(provider?.apiKey);
  if (!apiKey || apiKey.startsWith("${")) return null;
  return {
    apiKey,
    fingerprint: crypto.createHash("sha256").update(apiKey).digest("hex").slice(0, 16),
  };
}

function kimiWindowMeta(window) {
  const duration = Number(window?.duration || 0);
  const unit = String(window?.timeUnit || "");
  const minutes = unit === "TIME_UNIT_HOUR"
    ? duration * 60
    : unit === "TIME_UNIT_DAY"
      ? duration * 1440
      : duration;
  if (minutes >= 240 && minutes <= 360) return { key: "kimi-5h", label: "5小时额度" };
  if (minutes >= 8640) return { key: "kimi-weekly", label: "周额度" };
  if (minutes > 0) return { key: `kimi-${minutes}`, label: `${Math.max(1, Math.round(minutes / 60))}小时额度` };
  return { key: "kimi-window", label: "周期额度" };
}

// Kimi 只公布套餐占比，不公布绝对 token 数；limit / remaining 是字符串百分比。
function kimiQuotaItem(key, label, detail) {
  if (!plainObject(detail)) return null;
  const limit = Number(detail.limit);
  const remaining = Number(detail.remaining);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remaining)) return null;
  const usedPct = clampPercent(((limit - remaining) / limit) * 100);
  const parts = quotaPercentParts(usedPct);
  const resetAt = formatResetTime(detail.resetTime || "");
  const resetLabel = resetAt ? `${resetAt} 重置` : "";
  return {
    key,
    label,
    status: "ok",
    value: usedPct,
    total: 100,
    valueLabel: `已用 ${Math.round(usedPct)}%`,
    remainingLabel: parts.remainingLabel,
    resetLabel,
    detail: `${parts.remainingLabel}${resetLabel ? ` · ${resetLabel}` : ""}`,
    pct: parts.pct,
    resetAt,
  };
}

function kimiMembershipLabel(level) {
  const raw = String(level || "").trim();
  if (!raw) return "";
  return raw.replace(/^LEVEL_/, "").replace(/_/g, " ").toUpperCase();
}

function buildKimiQuotaFeed(usageJson) {
  const payload = plainObject(usageJson) ? usageJson : {};
  const items = [];
  const windows = Array.isArray(payload.limits) ? payload.limits : [];
  for (const entry of windows) {
    if (!plainObject(entry)) continue;
    const meta = kimiWindowMeta(entry.window);
    const item = kimiQuotaItem(meta.key, meta.label, entry.detail);
    if (item && !items.some((existing) => existing.key === item.key)) items.push(item);
  }
  const weekly = kimiQuotaItem("kimi-weekly", "周额度", payload.usage);
  if (weekly && !items.some((item) => item.key === "kimi-weekly")) items.push(weekly);
  if (!items.length) return kimiQuotaUnavailable("read");
  const primary = items[0];
  const parallel = Number(payload.parallel?.limit || 0);
  return {
    key: "kimi",
    label: "Kimi",
    status: "ok",
    reason: "",
    value: primary.value,
    total: primary.total,
    valueLabel: primary.valueLabel,
    detail: parallel > 0 ? `${primary.detail} · 并行 ${parallel}` : primary.detail,
    levelLabel: kimiMembershipLabel(payload.user?.membership?.level),
    pct: primary.pct,
    items,
  };
}

function zaiQuotaUnavailable(reason = "waiting") {
  return {
    ...quotaFeedUnavailable("glm", "GLM / Z.ai", reason, [
    quotaItemUnavailable("glm-5h", "5小时额度", reason),
    quotaItemUnavailable("glm-mcp", "MCP额度", reason),
    ]),
    quotaReason: reason,
    trendReason: reason,
    usageTrend: emptyZaiUsageTrend(reason),
  };
}

function quotaValueLabel(used, total) {
  if (total > 0) return `${formatCount(used)} / ${formatCount(total)}`;
  if (used > 0) return formatCount(used);
  return "--";
}

function quotaUsageLabel(used, total) {
  const usedText = String(Math.round(Number(used || 0)));
  const totalNumber = Number(total || 0);
  if (totalNumber > 0) return `${usedText} / ${Math.round(totalNumber)}`;
  return usedText;
}

function zaiQuotaLabel(item = {}) {
  if (item.type === "TOKENS_LIMIT" && Number(item.unit) === 3) return "5小时额度";
  if (item.type === "TIME_LIMIT") return "MCP额度";
  if (item.type === "TOKENS_LIMIT") return "周额度";
  return String(item.type || "额度");
}

function zaiQuotaKey(item = {}, index = 0) {
  if (item.type === "TOKENS_LIMIT" && Number(item.unit) === 3) return "glm-5h";
  if (item.type === "TIME_LIMIT") return "glm-mcp";
  if (item.type === "TOKENS_LIMIT") return "glm-weekly";
  return `glm-${index}`;
}

function zaiLimitTotal(item = {}, used = 0, pct = 0) {
  const explicitTotal = Number(item.total ?? item.limit ?? item.maxValue ?? item.usage ?? 0);
  const totalByRate = pct > 0 && used > 0 ? Math.round(used / (pct / 100)) : 0;
  return Math.max(used, Number.isFinite(explicitTotal) ? explicitTotal : 0, totalByRate);
}

function zaiQuotaItems(limits = [], usageResp = null) {
  const modelCalls = Number(usageResp?.json?.data?.totalUsage?.totalModelCallCount);
  const items = limits.map((item, index) => {
    const pct = clampPercent(item?.percentage || 0);
    let used = Number(item?.currentValue ?? item?.used ?? 0);
    if (item?.type === "TOKENS_LIMIT" && Number.isFinite(modelCalls) && modelCalls > 0) {
      used = modelCalls;
    }
    if (!Number.isFinite(used)) used = 0;
    const total = zaiLimitTotal(item, used, pct);
    const resetAt = item?.nextResetTime ? formatResetTime(item.nextResetTime) : "";
    const remaining = Math.max(0, 100 - Math.round(pct));
    const remainingLabel = `剩余 ${remaining}%`;
    const resetLabel = resetAt ? `${resetAt} 重置` : "";
    return {
      key: zaiQuotaKey(item, index),
      label: zaiQuotaLabel(item),
      status: "ok",
      value: used,
      total,
      valueLabel: quotaValueLabel(used, total),
      usageLabel: quotaUsageLabel(used, total),
      rawValueLabel: quotaUsageLabel(used, total),
      remainingLabel,
      resetLabel,
      detail: `${remainingLabel}${resetLabel ? ` · ${resetLabel}` : ""}`,
      pct: Math.max(4, Math.round(pct)),
      resetAt,
    };
  });

  const fiveHour = items.find((item) => item.key === "glm-5h");
  const mcp = items.find((item) => item.key === "glm-mcp");
  return [
    fiveHour || quotaItemUnavailable("glm-5h", "5小时额度", "waiting"),
    mcp || quotaItemUnavailable("glm-mcp", "MCP额度", "waiting"),
  ];
}

function zaiUsageUrl(start, end) {
  return `${ZAI_CODING_API_BASE}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatZaiDateTime(start))}&endTime=${encodeURIComponent(formatZaiDateTime(end))}`;
}

function zaiHistoryLabel(value = "") {
  const text = String(value || "");
  if (text.includes("T")) return text.slice(11, 13);
  if (text.length >= 10) return text.slice(5, 10);
  return text || "--";
}

function normalizeZaiHistoryTime(value) {
  const text = String(value || "").trim();
  const local = text.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/);
  if (local) {
    const [, year, month, day, hour, minute = "00", second = "00", millis = "0"] = local;
    const parsed = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(millis.padEnd(3, "0")),
    );
    if (
      parsed.getFullYear() === Number(year)
      && parsed.getMonth() === Number(month) - 1
      && parsed.getDate() === Number(day)
      && parsed.getHours() === Number(hour)
      && parsed.getMinutes() === Number(minute)
      && parsed.getSeconds() === Number(second)
    ) return localHourKey(parsed);
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? "" : localHourKey(parsed);
  }
  const daily = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!daily) return "";
  const parsed = new Date(Number(daily[1]), Number(daily[2]) - 1, Number(daily[3]), 12);
  return parsed.getFullYear() === Number(daily[1])
    && parsed.getMonth() === Number(daily[2]) - 1
    && parsed.getDate() === Number(daily[3])
    ? localDateString(parsed)
    : "";
}

function zaiUsageHistory(resp, includeEmpty = false) {
  const data = resp?.json?.data || {};
  const times = Array.isArray(data.x_time) ? data.x_time : [];
  const tokens = Array.isArray(data.tokensUsage) ? data.tokensUsage : [];
  const history = times.map((time, index) => {
    const date = normalizeZaiHistoryTime(time);
    const used = Number(tokens[index] || 0);
    return { date, used: Number.isFinite(used) && used >= 0 ? used : 0 };
  }).filter((item) => item.date);
  return includeEmpty ? history : history.filter((item) => item.used > 0);
}

function recentHourlyUsageHistory(resp, hours = 24) {
  const rawHistory = zaiUsageHistory(resp, true).filter((item) => String(item.date || "").length === 13);
  const byHour = new Map(rawHistory.map((item) => [item.date, Number(item.used || 0)]));
  const end = new Date();
  end.setMinutes(0, 0, 0);
  const history = [];
  for (let offset = hours - 1; offset >= 0; offset -= 1) {
    const hour = new Date(end.getTime() - offset * 60 * 60 * 1000);
    const date = localHourKey(hour);
    history.push({ date, used: byHour.get(date) || 0 });
  }
  return history;
}

function compactUsageBars(history = [], limit = 12) {
  if (!history.length) return [];
  const size = Math.max(1, Math.ceil(history.length / limit));
  const buckets = [];
  for (let index = 0; index < history.length; index += size) {
    const chunk = history.slice(index, index + size);
    const used = chunk.reduce((sum, item) => sum + Number(item.used || 0), 0);
    buckets.push({
      label: zaiHistoryLabel(chunk[chunk.length - 1]?.date),
      used,
    });
  }
  const max = Math.max(1, ...buckets.map((item) => item.used));
  return buckets.map((item) => ({
    ...item,
    valueLabel: formatCount(item.used),
    pct: item.used > 0 ? Math.max(6, Math.round((item.used / max) * 100)) : 0,
  }));
}

function usageBarSummary(bars = []) {
  const activeBars = bars.filter((bar) => Number(bar.used || 0) > 0);
  const peak = activeBars.reduce((best, bar) => (Number(bar.used || 0) > Number(best?.used || 0) ? bar : best), null);
  const latest = activeBars[activeBars.length - 1] || null;
  return {
    peakLabel: peak ? `${peak.label} · ${peak.valueLabel}` : "--",
    latestLabel: latest ? `${latest.label} · ${latest.valueLabel}` : "--",
  };
}

function aggregateUsageByDay(history = []) {
  const grouped = new Map();
  for (const item of history) {
    const day = String(item.date || "").slice(0, 10);
    if (!day) continue;
    grouped.set(day, (grouped.get(day) || 0) + Number(item.used || 0));
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, used]) => ({ date, used }));
}

function zaiUsageResponseState(resp) {
  if (!resp) return "waiting";
  if (!resp.ok || resp.json?.code !== 200) return "error";
  const data = resp.json?.data;
  if (!data || !Array.isArray(data.x_time) || !Array.isArray(data.tokensUsage)) return "error";
  if (data.x_time.length !== data.tokensUsage.length) return "error";
  const valid = data.x_time.every((time, index) => (
    Boolean(normalizeZaiHistoryTime(time))
    && Number.isFinite(Number(data.tokensUsage[index]))
    && Number(data.tokensUsage[index]) >= 0
  ));
  return valid ? "ok" : "error";
}

function usagePeriodFromHistory(key, label, history = [], limit = 12, status = "ok") {
  const normalized = Array.isArray(history) ? history : [];
  const total = normalized.reduce((sum, item) => sum + Number(item.used || 0), 0);
  const bars = compactUsageBars(normalized, limit);
  return {
    key,
    label,
    status,
    empty: (status === "ok" || status === "stale") && total === 0,
    bucketCount: bars.length,
    bucketUnit: key === "24h" ? "hour" : "day",
    total,
    totalLabel: status === "ok" || status === "stale" ? formatCount(total) : "--",
    bars,
    ...usageBarSummary(bars),
  };
}

function zaiUsagePeriod(key, label, resp, limit, groupByDay = false, historyOverride = null) {
  const status = zaiUsageResponseState(resp);
  if (status !== "ok") {
    const period = usagePeriodFromHistory(key, label, [], limit, status);
    const message = resp?.json?.msg || resp?.error || resp?.status || "";
    return { ...period, reason: status === "waiting" ? "waiting" : zaiFailureReason(message) };
  }

  const overridden = Array.isArray(historyOverride);
  const rawHistory = overridden ? historyOverride : zaiUsageHistory(resp);
  const history = groupByDay ? aggregateUsageByDay(rawHistory) : rawHistory;
  const period = usagePeriodFromHistory(key, label, history, limit, "ok");
  const responseTotal = resp?.json?.data?.totalUsage?.totalTokensUsage;
  if (!overridden && responseTotal !== undefined && Number.isFinite(Number(responseTotal))) {
    period.total = Number(responseTotal);
    period.totalLabel = formatCount(period.total);
  }
  return period;
}

function recentDailyUsageHistory(resp, days = 7) {
  const grouped = new Map(aggregateUsageByDay(zaiUsageHistory(resp, true))
    .map((item) => [item.date, Number(item.used || 0)]));
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const history = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const key = localDateString(date);
    history.push({ date: key, used: grouped.get(key) || 0 });
  }
  return history;
}

function trendStatus(periods = []) {
  const statuses = periods.map((period) => period?.status || "waiting");
  if (statuses.length && statuses.every((status) => status === "ok")) return "ok";
  if (statuses.length && statuses.every((status) => status === "stale")) return "stale";
  if (statuses.some((status) => status === "ok" || status === "stale")) return "partial";
  if (statuses.some((status) => status === "expired")) return "expired";
  if (statuses.length && statuses.every((status) => status === "waiting")) return "waiting";
  return "error";
}

function buildZaiUsageTrend(resp1d, resp30d) {
  const capturedAt = new Date().toISOString();
  const stamp = (period) => period.status === "ok" ? { ...period, capturedAt } : period;
  const history24h = stamp(zaiUsagePeriod("24h", "24小时", resp1d, 24, false, recentHourlyUsageHistory(resp1d, 24)));
  const history1d = stamp(zaiUsagePeriod("1d", "日", resp1d, 12));
  const history7d = stamp(zaiUsagePeriod("7d", "7天", resp30d, 7, false, recentDailyUsageHistory(resp30d, 7)));
  const history30d = stamp(zaiUsagePeriod("30d", "30天", resp30d, 30, false, recentDailyUsageHistory(resp30d, 30)));
  const periods = [history24h, history7d, history30d];
  return {
    key: "glm",
    label: "GLM 消耗趋势",
    source: "Z.ai 用量接口",
    status: trendStatus(periods),
    reason: periods.some((period) => period.status === "error" && period.reason === "auth")
      ? "auth"
      : periods.some((period) => period.status === "error")
        ? "read"
        : "",
    history24h,
    history1d,
    history7d,
    history30d,
    periods,
  };
}

function emptyZaiUsageTrend(reason = "waiting") {
  const status = reason === "waiting" ? "waiting" : "error";
  const history24h = { ...usagePeriodFromHistory("24h", "24小时", [], 24, status), reason };
  const history1d = { ...usagePeriodFromHistory("1d", "日", [], 12, status), reason };
  const history7d = { ...usagePeriodFromHistory("7d", "7天", [], 7, status), reason };
  const history30d = { ...usagePeriodFromHistory("30d", "30天", [], 30, status), reason };
  return {
    key: "glm",
    label: "GLM 消耗趋势",
    source: "Z.ai 用量接口",
    status,
    reason,
    history24h,
    history1d,
    history7d,
    history30d,
    periods: [history24h, history7d, history30d],
  };
}

function readCodingQuotaConfig() {
  try {
    return JSON.parse(fs.readFileSync(CODING_QUOTA_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function readWindowsUserEnv(name) {
  if (process.platform !== "win32") return "";
  try {
    const output = execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const line = output.split(/\r?\n/).find((item) => item.includes(name));
    const parts = String(line || "").trim().split(/\s{2,}/);
    return parts.length >= 3 ? parts.slice(2).join(" ").trim() : "";
  } catch {
    return "";
  }
}

// OpenCodex 允许把密钥写成 ${ENV_VAR} 占位符。原样当 Bearer 发出去只会换来 401，
// 所以这里解析成真实值；解析不到就当没配置，而不是拿占位符去碰接口。
function resolveEnvSecret(name) {
  const fromProcess = String(process.env[name] || "").trim();
  if (fromProcess) return fromProcess;
  const cached = envSecretCache.get(name);
  if (cached && Date.now() - cached.at < ENV_SECRET_TTL_MS) return cached.value;
  const value = String(readWindowsUserEnv(name) || "").trim();
  envSecretCache.set(name, { at: Date.now(), value });
  return value;
}

function resolveConfiguredSecret(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  return match ? resolveEnvSecret(match[1]) : value;
}

function decryptElectronV10Payload(masterKey, payload) {
  try {
    const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ""), "base64");
    if (raw.length < 31 || raw.subarray(0, 3).toString("utf8") !== "v10") return "";
    const key = Buffer.isBuffer(masterKey) ? masterKey : Buffer.from(masterKey);
    if (key.length !== 32) return "";
    const nonce = raw.subarray(3, 15);
    const tag = raw.subarray(raw.length - 16);
    const ciphertext = raw.subarray(15, raw.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function dpapiUnprotectCurrentUser(protectedBytes) {
  if (process.platform !== "win32" || !protectedBytes?.length) return null;
  const python = findPythonBinary();
  if (!python) return null;
  const script = [
    "import sys,ctypes",
    "class B(ctypes.Structure):",
    " _fields_=[('cbData',ctypes.c_uint32),('pbData',ctypes.POINTER(ctypes.c_char))]",
    "raw=sys.stdin.buffer.read()",
    "buf=ctypes.create_string_buffer(raw,len(raw))",
    "bi=B(len(raw),ctypes.cast(buf,ctypes.POINTER(ctypes.c_char)))",
    "bo=B()",
    "if not ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(bi),None,None,None,None,0,ctypes.byref(bo)):",
    " sys.exit(1)",
    "sys.stdout.buffer.write(ctypes.string_at(bo.pbData,bo.cbData))",
    "ctypes.windll.kernel32.LocalFree(bo.pbData)",
  ].join("\n");
  try {
    const args = python === "py" ? ["-3", "-c", script] : ["-c", script];
    const value = execFileSync(python, args, {
      input: protectedBytes,
      timeout: 8000,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    return Buffer.isBuffer(value) && value.length ? value : null;
  } catch {
    return null;
  }
}

function codingQuotaBarMasterKey() {
  if (codingQuotaMasterKeyCache.key && Date.now() - codingQuotaMasterKeyCache.at < 10 * 60 * 1000) {
    return codingQuotaMasterKeyCache.key;
  }
  try {
    const localState = JSON.parse(fs.readFileSync(CODING_QUOTA_LOCAL_STATE_PATH, "utf8"));
    const encryptedKey = Buffer.from(String(localState?.os_crypt?.encrypted_key || ""), "base64");
    if (encryptedKey.length < 6 || encryptedKey.subarray(0, 5).toString("utf8") !== "DPAPI") return null;
    const master = dpapiUnprotectCurrentUser(encryptedKey.subarray(5));
    if (!master || master.length !== 32) return null;
    codingQuotaMasterKeyCache = { at: Date.now(), key: master };
    return master;
  } catch {
    return null;
  }
}

function decryptCodingQuotaBarApiKey(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!text.startsWith("enc:")) return text;
  const master = codingQuotaBarMasterKey();
  if (!master) return "";
  const plain = decryptElectronV10Payload(master, Buffer.from(text.slice(4), "base64")).trim();
  if (!plain || plain.startsWith("enc:")) return "";
  return plain;
}

function enabledZaiAccounts({ includeWindowsUserEnv = true } = {}) {
  const config = readCodingQuotaConfig();
  const accounts = (config.providers?.zhipu?.accounts || [])
    .map((account) => {
      if (!account?.enabled) return null;
      const apiKey = decryptCodingQuotaBarApiKey(account.apiKey);
      if (!apiKey || apiKey.startsWith("enc:")) return null;
      return { ...account, apiKey, source: "config" };
    })
    .filter(Boolean);
  if (accounts.length) return accounts;
  const processEnvKey = String(process.env.Z_AI_API_KEY || "").trim();
  if (processEnvKey && !processEnvKey.startsWith("enc:")) {
    accounts.push({ enabled: true, apiKey: processEnvKey, label: "env", source: "process-env" });
  } else if (includeWindowsUserEnv) {
    const userEnvKey = String(readWindowsUserEnv("Z_AI_API_KEY") || "").trim();
    if (userEnvKey && !userEnvKey.startsWith("enc:")) {
      accounts.push({ enabled: true, apiKey: userEnvKey, label: "env", source: "windows-user-env" });
    }
  }
  return accounts;
}

function zaiAccountFingerprint(accounts = []) {
  if (!accounts.length) return "not-connected";
  const material = accounts.map((account) => String(account.apiKey || "").trim()).join("\u0000");
  return crypto.createHash("sha256").update(material).digest("hex").slice(0, 16);
}

async function fetchZaiQuotaForAccount(account) {
  const headers = {
    authorization: `Bearer ${String(account.apiKey).trim()}`,
    accept: "application/json",
    "user-agent": "opentoken-island/0.1",
  };
  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 86400000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const [quotaResp, usageResp, usage30dResp] = await Promise.all([
    requestTextWithRetry(
      "GET",
      `${ZAI_CODING_API_BASE}/api/monitor/usage/quota/limit`,
      "",
      headers,
      30000,
      2,
    ),
    requestTextWithRetry("GET", zaiUsageUrl(oneDayAgo, now), "", headers, 30000, 2),
    requestTextWithRetry("GET", zaiUsageUrl(thirtyDaysAgo, now), "", headers, 30000, 2),
  ]);

  return buildZaiQuotaFeed(account, quotaResp, usageResp, usage30dResp);
}

function buildZaiQuotaFeed(account, quotaResp, usageResp, usage30dResp) {
  const usageTrend = buildZaiUsageTrend(usageResp, usage30dResp);
  const quotaOk = Boolean(
    quotaResp.ok
    && quotaResp.json?.code === 200
    && Array.isArray(quotaResp.json?.data?.limits),
  );
  if (!quotaOk) {
    const message = quotaResp.json?.msg || quotaResp.error || "quota read failed";
    const reason = zaiFailureReason(message);
    // 其他三家失败都会留一行；GLM 以前是静默的，网络超时和密钥失效在日志里分不出来。
    logIslandEvent("zai quota refresh failed", {
      status: Number(quotaResp.status || 0),
      code: Number(quotaResp.json?.code || 0),
      reason,
      trendReason: usageTrend.reason || "",
    });
    const unavailable = zaiQuotaUnavailable(reason);
    const trendAvailable = hasUsableZaiData({ usageTrend });
    return {
      ...unavailable,
      label: account.label ? `GLM / Z.ai · ${account.label}` : "GLM / Z.ai",
      status: trendAvailable ? "partial" : unavailable.status,
      detail: trendAvailable ? "额度读取失败，GLM 趋势仍可用" : unavailable.detail,
      quotaReason: reason,
      trendReason: usageTrend.reason || "",
      usageTrend,
    };
  }

  const items = zaiQuotaItems(quotaResp.json.data.limits, usageResp);
  const primary = items.find((item) => item.key === "glm-5h") || items[0];
  const levelLabel = quotaResp.json.data.level ? String(quotaResp.json.data.level).toUpperCase() : "";
  const feedStatus = usageTrend.status === "ok" ? "ok" : "partial";
  const trendDetail = feedStatus === "ok" ? "" : " · 部分趋势读取失败，保留可用数据";

  return {
    key: "glm",
    label: account.label ? `GLM / Z.ai · ${account.label}` : "GLM / Z.ai",
    status: feedStatus,
    quotaReason: "",
    trendReason: usageTrend.reason || "",
    value: primary?.value || 0,
    total: primary?.total || 0,
    valueLabel: primary?.valueLabel || "--",
    detail: `${primary?.detail || "额度已读取"}${trendDetail}`,
    levelLabel,
    pct: Math.max(4, ...items.map((item) => Number(item.pct || 0))),
    items,
    usageTrend,
  };
}

function zaiFeedQuality(feed) {
  const periods = feed?.usageTrend?.periods || [];
  return periods.reduce((score, period) => (
    score + (period?.status === "ok" ? 2 : period?.status === "stale" ? 1 : 0)
  ), 0);
}

async function fetchZaiQuota(accounts = enabledZaiAccounts()) {
  if (!accounts.length) {
    return zaiQuotaUnavailable("not-connected");
  }

  let lastError = zaiQuotaUnavailable("read");
  let bestPartial = null;
  for (const account of accounts) {
    const result = await fetchZaiQuotaForAccount(account);
    if (result.status === "ok") return result;
    if (result.status === "partial" && (!bestPartial || zaiFeedQuality(result) > zaiFeedQuality(bestPartial))) {
      bestPartial = result;
    }
    lastError = result;
  }
  return bestPartial || lastError;
}

function quotaCacheTtl(feed) {
  return feed?.status === "ok" ? QUOTA_CACHE_TTL_MS : QUOTA_ERROR_CACHE_TTL_MS;
}

function staleUsagePeriod(period, fallbackCapturedAt = "", now = Date.now()) {
  if (!period || !["ok", "stale"].includes(period.status) || !Array.isArray(period.bars)) return null;
  const capturedAt = period.capturedAt || fallbackCapturedAt;
  if (zaiSnapshotExpired({ capturedAt }, now)) return null;
  return { ...period, status: "stale" };
}

function zaiSnapshotExpired(feed, now = Date.now()) {
  const capturedAt = Date.parse(feed?.capturedAt || "");
  return !Number.isFinite(capturedAt) || now - capturedAt > ZAI_STALE_MAX_AGE_MS;
}

function expireUsagePeriod(period, fallbackCapturedAt = "") {
  if (!period || !["ok", "stale", "expired"].includes(period.status)) return period || null;
  return {
    ...period,
    status: "expired",
    reason: "expired",
    capturedAt: period.capturedAt || fallbackCapturedAt,
    empty: false,
    bucketCount: 0,
    total: 0,
    totalLabel: "--",
    bars: [],
    peakLabel: "--",
    latestLabel: "--",
  };
}

function latestZaiSuccessfulAt(feed) {
  const values = [
    feed?.lastSuccessfulAt,
    feed?.capturedAt,
    ...((feed?.usageTrend?.periods || []).map((period) => period?.capturedAt)),
    feed?.usageTrend?.history1d?.capturedAt,
  ].map((value) => Date.parse(value || "")).filter(Number.isFinite);
  return values.length ? new Date(Math.max(...values)).toISOString() : "";
}

function normalizeZaiFeedFreshness(feed, now = Date.now()) {
  if (!feed?.usageTrend) return feed;
  const fallbackCapturedAt = feed.lastSuccessfulAt || feed.capturedAt || "";
  const normalizePeriod = (period) => {
    if (!period || !["ok", "stale"].includes(period.status)) return period;
    const capturedAt = period.capturedAt || fallbackCapturedAt;
    return zaiSnapshotExpired({ capturedAt }, now)
      ? expireUsagePeriod(period, fallbackCapturedAt)
      : { ...period, capturedAt };
  };
  const periods = (feed.usageTrend.periods || []).map(normalizePeriod).filter(Boolean);
  const periodByKey = new Map(periods.map((period) => [period.key, period]));
  const history1d = normalizePeriod(feed.usageTrend.history1d);
  const usageTrend = {
    ...feed.usageTrend,
    status: trendStatus(periods),
    history24h: periodByKey.get("24h") || feed.usageTrend.history24h,
    history1d: history1d || feed.usageTrend.history1d,
    history7d: periodByKey.get("7d") || feed.usageTrend.history7d,
    history30d: periodByKey.get("30d") || feed.usageTrend.history30d,
    periods,
  };
  const lastSuccessfulAt = latestZaiSuccessfulAt({ ...feed, usageTrend });
  let status = feed.status;
  if (usageTrend.status === "expired") status = "expired";
  else if (usageTrend.status === "partial") status = "partial";
  else if (usageTrend.status === "stale" && status !== "partial") status = "stale";
  return {
    ...feed,
    status,
    capturedAt: lastSuccessfulAt || feed.capturedAt,
    lastSuccessfulAt,
    ...(usageTrend.status === "expired" ? { expiredAt: lastSuccessfulAt || feed.expiredAt || "" } : {}),
    usageTrend,
  };
}

function retainLastGoodZaiQuota(fresh, lastGood, staleAt = new Date().toISOString(), now = Date.now()) {
  if (!lastGood || fresh?.status === "ok") return fresh;
  if (
    fresh?.reason === "not-connected"
    || fresh?.trendReason === "auth"
    || (fresh?.reason === "auth" && !fresh?.quotaReason)
  ) return fresh;
  if (zaiSnapshotExpired(lastGood, now)) {
    if (hasUsableZaiData(fresh)) return fresh;
    const oldTrend = lastGood?.usageTrend || emptyZaiUsageTrend("read");
    const currentByKey = new Map((fresh?.usageTrend?.periods || []).map((period) => [period.key, period]));
    const periods = (oldTrend.periods || []).map((period) => (
      ["ok", "stale", "expired"].includes(period?.status)
        ? expireUsagePeriod(period, lastGood.capturedAt)
        : currentByKey.get(period?.key) || period
    )).filter(Boolean);
    const periodByKey = new Map(periods.map((period) => [period.key, period]));
    const expiredDay = ["ok", "stale", "expired"].includes(oldTrend.history1d?.status)
      ? expireUsagePeriod(oldTrend.history1d, lastGood.capturedAt)
      : fresh?.usageTrend?.history1d || oldTrend.history1d;
    const usageTrend = {
      ...oldTrend,
      ...(fresh?.usageTrend || {}),
      status: trendStatus(periods),
      history24h: periodByKey.get("24h") || fresh?.usageTrend?.history24h,
      history1d: expiredDay,
      history7d: periodByKey.get("7d") || fresh?.usageTrend?.history7d,
      history30d: periodByKey.get("30d") || fresh?.usageTrend?.history30d,
      periods,
    };
    const lastSuccessfulAt = latestZaiSuccessfulAt(lastGood) || lastGood.capturedAt || "";
    return {
      ...fresh,
      status: "expired",
      reason: "expired",
      capturedAt: lastSuccessfulAt,
      lastSuccessfulAt,
      lastAttemptAt: staleAt,
      expiredAt: lastSuccessfulAt,
      detail: "最近成功的 GLM 数据已超过 12 小时，不再作为当前趋势显示",
      usageTrend,
    };
  }

  const freshTrend = fresh?.usageTrend;
  const oldTrend = lastGood?.usageTrend;
  if (!oldTrend) return fresh;
  const currentByKey = new Map((freshTrend?.periods || []).map((period) => [period.key, period]));
  const oldByKey = new Map((oldTrend.periods || []).map((period) => [period.key, period]));
  const periods = ["24h", "7d", "30d"].map((key) => {
    const current = currentByKey.get(key);
    if (current?.status === "ok") return current;
    if (current?.reason === "auth") return current;
    const old = oldByKey.get(key);
    return staleUsagePeriod(old, lastGood.capturedAt, now)
      || (["ok", "stale", "expired"].includes(old?.status) ? expireUsagePeriod(old, lastGood.capturedAt) : current);
  }).filter(Boolean);
  const periodByKey = new Map(periods.map((period) => [period.key, period]));
  const legacyDay = freshTrend?.history1d?.status === "ok"
    ? freshTrend.history1d
    : staleUsagePeriod(oldTrend.history1d, lastGood.capturedAt, now) || freshTrend?.history1d;
  const retainedStatus = trendStatus(periods);
  const usageTrend = {
    ...oldTrend,
    ...(freshTrend || {}),
    status: retainedStatus,
    history24h: periodByKey.get("24h") || freshTrend?.history24h,
    history1d: legacyDay || freshTrend?.history1d,
    history7d: periodByKey.get("7d") || freshTrend?.history7d,
    history30d: periodByKey.get("30d") || freshTrend?.history30d,
    periods,
  };
  const usesStaleData = periods.some((period) => period.status === "stale") || legacyDay?.status === "stale";
  const items = retainZaiQuotaItems(fresh, lastGood);
  if (!usesStaleData) return normalizeZaiFeedFreshness({ ...fresh, usageTrend, items }, now);
  return normalizeZaiFeedFreshness({
    ...lastGood,
    ...fresh,
    status: retainedStatus === "stale" ? "stale" : "partial",
    staleAt,
    detail: `${fresh?.detail || "Z.ai 接口暂不可用"} · 正在显示最近成功数据`,
    usageTrend,
    items,
  }, now);
}

function hasUsableZaiData(feed) {
  return (feed?.usageTrend?.periods || []).some((period) => ["ok", "stale"].includes(period?.status));
}

function retainZaiQuotaItems(fresh, lastGood) {
  if (fresh?.quotaReason === "auth" || fresh?.reason === "auth") {
    return Array.isArray(fresh?.items) ? fresh.items : [];
  }
  const oldItems = Array.isArray(lastGood?.items) ? lastGood.items : [];
  const freshItems = Array.isArray(fresh?.items) ? fresh.items : [];
  if (!oldItems.length) return freshItems;
  const oldByKey = new Map(oldItems.map((item) => [item.key, item]));
  const keys = [...new Set([
    ...freshItems.map((item) => item?.key).filter(Boolean),
    ...oldItems.map((item) => item?.key).filter(Boolean),
  ])];
  return keys.map((key) => {
    const current = freshItems.find((item) => item?.key === key);
    if (current?.status === "ok") return current;
    const old = oldByKey.get(key);
    if (old && ["ok", "stale"].includes(old.status)) {
      return { ...old, status: "stale" };
    }
    return current || old;
  }).filter(Boolean);
}

function storedZaiSnapshot(fingerprint) {
  const memory = zaiLastGoodByAccount.get(fingerprint);
  if (memory) return memory;
  const persisted = state.glmSnapshots?.[fingerprint];
  if (persisted && typeof persisted === "object") {
    zaiLastGoodByAccount.set(fingerprint, persisted);
    return persisted;
  }
  return null;
}

function persistZaiSnapshot(fingerprint, feed) {
  if (!hasUsableZaiData(feed)) return;
  const lastSuccessfulAt = latestZaiSuccessfulAt(feed) || feed.capturedAt || new Date().toISOString();
  const snapshot = { ...feed, capturedAt: lastSuccessfulAt, lastSuccessfulAt };
  zaiLastGoodByAccount.set(fingerprint, snapshot);
  state.glmSnapshots = { ...(state.glmSnapshots || {}), [fingerprint]: snapshot };
  state.glmActiveFingerprint = fingerprint;
  saveState();
}

async function refreshZaiQuota(accounts, fingerprint) {
  const activeRefresh = quotaRefreshPromises.get(fingerprint);
  if (activeRefresh) return activeRefresh;
  const refresh = (async () => {
    const lastAttemptAt = new Date().toISOString();
    let fresh;
    try {
      fresh = await fetchZaiQuota(accounts);
    } catch {
      fresh = zaiQuotaUnavailable("read");
    }
    fresh = { ...fresh, lastAttemptAt };
    const lastGood = storedZaiSnapshot(fingerprint);
    let retained = retainLastGoodZaiQuota(fresh, lastGood, lastAttemptAt);
    if (hasUsableZaiData(fresh)) {
      const lastSuccessfulAt = latestZaiSuccessfulAt(fresh) || lastAttemptAt;
      retained = { ...retained, capturedAt: lastSuccessfulAt, lastSuccessfulAt };
    }
    retained = normalizeZaiFeedFreshness(retained);
    if (hasUsableZaiData(retained)) persistZaiSnapshot(fingerprint, retained);
    quotaCache = { at: Date.now(), fingerprint, zai: retained };
    return retained;
  })();
  quotaRefreshPromises.set(fingerprint, refresh);
  try {
    return await refresh;
  } finally {
    if (quotaRefreshPromises.get(fingerprint) === refresh) quotaRefreshPromises.delete(fingerprint);
  }
}

async function cachedZaiQuota() {
  const accounts = enabledZaiAccounts();
  const fingerprint = zaiAccountFingerprint(accounts);
  zaiRuntime = {
    fingerprint,
    source: accounts.length && accounts.every((account) => account.source === "windows-user-env")
      ? "windows-user-env"
      : accounts.length
        ? "direct"
        : "not-connected",
  };
  if (quotaCache.zai && quotaCache.fingerprint === fingerprint
    && Date.now() - quotaCache.at < quotaCacheTtl(quotaCache.zai)) {
    return normalizeZaiFeedFreshness(quotaCache.zai);
  }
  const lastGood = storedZaiSnapshot(fingerprint);
  void refreshZaiQuota(accounts, fingerprint);
  if (lastGood) {
    return retainLastGoodZaiQuota(
      { key: "glm", status: "partial", detail: "正在刷新 Z.ai 数据", usageTrend: emptyZaiUsageTrend("read") },
      lastGood,
    );
  }
  return zaiQuotaUnavailable("waiting");
}

function selectZaiQuotaSnapshot(fingerprint, cache = {}, snapshots = {}, now = Date.now()) {
  if (!fingerprint || fingerprint === "not-connected") return zaiQuotaUnavailable("not-connected");
  if (cache?.zai && cache.fingerprint === fingerprint) return normalizeZaiFeedFreshness(cache.zai, now);
  const lastGood = snapshots?.[fingerprint] || null;
  if (lastGood) {
    return normalizeZaiFeedFreshness(retainLastGoodZaiQuota(
      { key: "glm", status: "partial", detail: "正在刷新 Z.ai 数据", usageTrend: emptyZaiUsageTrend("read") },
      lastGood,
      new Date(now).toISOString(),
      now,
    ), now);
  }
  return zaiQuotaUnavailable("waiting");
}

function peekZaiQuota() {
  const directAccounts = enabledZaiAccounts({ includeWindowsUserEnv: false });
  const fingerprint = zaiRuntime.source === "test-state"
    ? zaiRuntime.fingerprint
    : directAccounts.length
      ? zaiAccountFingerprint(directAccounts)
      : zaiRuntime.source === "windows-user-env"
        ? zaiRuntime.fingerprint
        : "not-connected";
  const snapshots = { ...(state.glmSnapshots || {}) };
  const memory = zaiLastGoodByAccount.get(fingerprint);
  if (memory) snapshots[fingerprint] = memory;
  return selectZaiQuotaSnapshot(fingerprint, quotaCache, snapshots);
}

function cursorStateDbPath() {
  return path.join(APPDATA, "Cursor", "User", "globalStorage", "state.vscdb");
}

function grokAuthPath() {
  return path.join(process.env.GROK_HOME || path.join(HOME, ".grok"), "auth.json");
}

function codexAuthPath() {
  return path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "auth.json");
}

function findPythonBinary() {
  if (pythonBinaryCache.bin && Date.now() - pythonBinaryCache.at < 10 * 60 * 1000) {
    return pythonBinaryCache.bin;
  }
  const candidates = [process.env.OPENTOKEN_PYTHON, "py", "python", "python3"].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, bin === "py" ? ["-3", "-c", "print(1)"] : ["-c", "print(1)"], {
        encoding: "utf8",
        timeout: 4000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      pythonBinaryCache = { at: Date.now(), bin };
      return bin;
    } catch {
      continue;
    }
  }
  pythonBinaryCache = { at: Date.now(), bin: "" };
  return "";
}

function readSqliteItemValue(dbPath, key) {
  if (!dbPath || !fs.existsSync(dbPath)) return "";
  const python = findPythonBinary();
  if (!python) return "";
  const script = [
    "import sqlite3,sys",
    "db,key=sys.argv[1],sys.argv[2]",
    "uri='file:'+db.replace(chr(92),'/')+'?mode=ro'",
    "try:",
    " con=sqlite3.connect(uri, uri=True, timeout=1)",
    "except Exception:",
    " con=sqlite3.connect(db, timeout=1)",
    "row=con.execute('SELECT value FROM ItemTable WHERE key=?',(key,)).fetchone()",
    "if row and row[0] is not None:",
    " val=row[0]",
    " sys.stdout.write(val.decode('utf-8') if isinstance(val, bytes) else str(val))",
  ].join("\n");
  try {
    const args = python === "py" ? ["-3", "-c", script, dbPath, key] : ["-c", script, dbPath, key];
    const value = execFileSync(python, args, {
      encoding: "utf8",
      timeout: 8000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return String(value || "").trim().replace(/^"|"$/g, "");
  } catch {
    return "";
  }
}

function readCursorAccessToken() {
  return readSqliteItemValue(cursorStateDbPath(), CURSOR_ACCESS_TOKEN_KEY);
}

function loadGrokCliAuth(now = Date.now()) {
  try {
    return selectGrokCliAuth(JSON.parse(fs.readFileSync(grokAuthPath(), "utf8")), now);
  } catch {
    return null;
  }
}

function loadCodexCliAuth() {
  try {
    return selectCodexCliAuth(JSON.parse(fs.readFileSync(codexAuthPath(), "utf8")));
  } catch {
    return null;
  }
}

function providerSnapshot(feed) {
  if (!feed || !["ok", "stale"].includes(feed.status)) return null;
  const capturedAt = feed.lastSuccessfulAt || feed.capturedAt || new Date().toISOString();
  return {
    key: feed.key,
    label: feed.label,
    status: feed.status,
    reason: feed.reason || "",
    value: feed.value,
    total: feed.total,
    valueLabel: feed.valueLabel,
    detail: feed.detail,
    levelLabel: feed.levelLabel || "",
    pct: feed.pct,
    items: Array.isArray(feed.items) ? feed.items.map((item) => ({
      key: item.key,
      label: item.label,
      status: item.status,
      value: item.value,
      total: item.total,
      valueLabel: item.valueLabel,
      usedLabel: item.usedLabel,
      remainingLabel: item.remainingLabel,
      resetLabel: item.resetLabel,
      detail: item.detail,
      pct: item.pct,
    })) : [],
    capturedAt,
    lastSuccessfulAt: capturedAt,
  };
}

function persistProviderQuota(storeKey, memory, fingerprint, feed) {
  const snapshot = providerSnapshot(feed);
  if (!snapshot || !fingerprint || fingerprint === "not-connected") return;
  memory.set(fingerprint, snapshot);
  state[storeKey] = { ...(state[storeKey] || {}), [fingerprint]: snapshot };
  saveState();
}

function retainLastGoodProviderQuota(fresh, lastGood, staleAt = new Date().toISOString()) {
  if (!lastGood || fresh?.status === "ok") return fresh;
  if (fresh?.reason === "not-connected" || fresh?.reason === "auth") return fresh;
  const capturedAt = Date.parse(lastGood.capturedAt || lastGood.lastSuccessfulAt || "");
  if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > ZAI_STALE_MAX_AGE_MS) {
    return { ...fresh, status: fresh.status === "error" ? "expired" : fresh.status };
  }
  return {
    ...lastGood,
    status: "stale",
    staleAt,
    lastAttemptAt: staleAt,
    detail: `${fresh.detail || "接口暂不可用"} · 正在显示最近成功数据`,
  };
}

function selectProviderQuotaSnapshot(fingerprint, cache, snapshots, unavailable, now = Date.now()) {
  if (!fingerprint || fingerprint === "not-connected") return unavailable("not-connected");
  if (cache?.feed && cache.fingerprint === fingerprint) return cache.feed;
  const lastGood = snapshots?.[fingerprint] || null;
  if (lastGood) {
    return retainLastGoodProviderQuota(
      { ...unavailable("waiting"), detail: "正在刷新额度" },
      lastGood,
      new Date(now).toISOString(),
    );
  }
  return unavailable("waiting");
}

async function fetchCursorQuota(token) {
  const headers = {
    authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
    accept: "application/json",
    "user-agent": "opentoken-island/0.1",
  };
  const [usageResp, planResp] = await Promise.all([
    requestTextWithRetry("POST", `${CURSOR_API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`, "{}", headers, 15000, 2),
    requestTextWithRetry("POST", `${CURSOR_API_BASE}/aiserver.v1.DashboardService/GetPlanInfo`, "{}", headers, 8000, 1),
  ]);
  if (usageResp.status === 401 || usageResp.status === 403) return cursorQuotaUnavailable("auth");
  if (!usageResp.ok || !plainObject(usageResp.json)) {
    logIslandEvent("cursor quota refresh failed", { status: Number(usageResp.status || 0) });
    return cursorQuotaUnavailable("read");
  }
  return buildCursorQuotaFeed(usageResp.json, planResp?.json || null);
}

async function fetchGrokQuota(auth) {
  if (!auth) return grokQuotaUnavailable("not-connected");
  if (auth.expired) return grokQuotaUnavailable("auth");
  const headers = {
    authorization: `Bearer ${auth.bearer}`,
    "x-xai-token-auth": "xai-grok-cli",
    accept: "application/json",
    "user-agent": "opentoken-island/0.1",
  };
  const [billingResp, settingsResp] = await Promise.all([
    requestTextWithRetry("GET", GROK_BILLING_URL, "", headers, 15000, 2),
    requestTextWithRetry("GET", GROK_SETTINGS_URL, "", headers, 2000, 1),
  ]);
  if (billingResp.status === 401 || billingResp.status === 403) return grokQuotaUnavailable("auth");
  if (!billingResp.ok || !plainObject(billingResp.json)) {
    logIslandEvent("grok quota refresh failed", { status: Number(billingResp.status || 0) });
    return grokQuotaUnavailable("read");
  }
  return buildGrokQuotaFeed(billingResp.json, settingsResp?.json || null);
}

async function refreshCursorQuota(token, fingerprint) {
  const refreshKey = `cursor:${fingerprint}`;
  const activeRefresh = quotaRefreshPromises.get(refreshKey);
  if (activeRefresh) return activeRefresh;
  const refresh = (async () => {
    const lastAttemptAt = new Date().toISOString();
    let fresh;
    try {
      fresh = await fetchCursorQuota(token);
    } catch {
      fresh = cursorQuotaUnavailable("read");
    }
    fresh = { ...fresh, lastAttemptAt };
    if (fresh.status === "ok") {
      fresh = { ...fresh, capturedAt: lastAttemptAt, lastSuccessfulAt: lastAttemptAt };
      persistProviderQuota("cursorSnapshots", cursorLastGoodByAccount, fingerprint, fresh);
    } else {
      const lastGood = cursorLastGoodByAccount.get(fingerprint) || state.cursorSnapshots?.[fingerprint];
      fresh = retainLastGoodProviderQuota(fresh, lastGood, lastAttemptAt);
    }
    cursorQuotaCache = { at: Date.now(), fingerprint, feed: fresh };
    return fresh;
  })();
  quotaRefreshPromises.set(refreshKey, refresh);
  try {
    return await refresh;
  } finally {
    if (quotaRefreshPromises.get(refreshKey) === refresh) quotaRefreshPromises.delete(refreshKey);
  }
}

async function refreshGrokQuota(auth) {
  const fingerprint = auth?.fingerprint || "not-connected";
  const refreshKey = `grok:${fingerprint}`;
  const activeRefresh = quotaRefreshPromises.get(refreshKey);
  if (activeRefresh) return activeRefresh;
  const refresh = (async () => {
    const lastAttemptAt = new Date().toISOString();
    let fresh;
    try {
      fresh = await fetchGrokQuota(auth);
    } catch {
      fresh = grokQuotaUnavailable("read");
    }
    fresh = { ...fresh, lastAttemptAt };
    if (fresh.status === "ok") {
      fresh = { ...fresh, capturedAt: lastAttemptAt, lastSuccessfulAt: lastAttemptAt };
      persistProviderQuota("grokSnapshots", grokLastGoodByAccount, fingerprint, fresh);
    } else {
      const lastGood = grokLastGoodByAccount.get(fingerprint) || state.grokSnapshots?.[fingerprint];
      fresh = retainLastGoodProviderQuota(fresh, lastGood, lastAttemptAt);
    }
    grokQuotaCache = { at: Date.now(), fingerprint, feed: fresh };
    return fresh;
  })();
  quotaRefreshPromises.set(refreshKey, refresh);
  try {
    return await refresh;
  } finally {
    if (quotaRefreshPromises.get(refreshKey) === refresh) quotaRefreshPromises.delete(refreshKey);
  }
}

async function cachedCursorQuota() {
  const dbPath = cursorStateDbPath();
  if (!fs.existsSync(dbPath)) {
    const feed = cursorQuotaUnavailable("not-connected");
    cursorRuntime = { fingerprint: "not-connected", source: "missing" };
    cursorQuotaCache = { at: Date.now(), fingerprint: "not-connected", feed };
    return feed;
  }
  const token = readCursorAccessToken();
  if (!findPythonBinary()) {
    const feed = cursorQuotaUnavailable("read");
    cursorRuntime = { fingerprint: "not-connected", source: "cursor-state-db" };
    cursorQuotaCache = { at: Date.now(), fingerprint: "not-connected", feed };
    return feed;
  }
  if (!token) {
    const feed = cursorQuotaUnavailable("auth");
    cursorRuntime = { fingerprint: "not-connected", source: "cursor-state-db" };
    cursorQuotaCache = { at: Date.now(), fingerprint: "not-connected", feed };
    return feed;
  }
  const fingerprint = crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
  cursorRuntime = { fingerprint, source: "cursor-state-db" };
  if (
    cursorQuotaCache.feed
    && cursorQuotaCache.fingerprint === fingerprint
    && Date.now() - cursorQuotaCache.at < quotaCacheTtl(cursorQuotaCache.feed)
  ) {
    return cursorQuotaCache.feed;
  }
  const lastGood = cursorLastGoodByAccount.get(fingerprint) || state.cursorSnapshots?.[fingerprint];
  void refreshCursorQuota(token, fingerprint);
  if (lastGood) {
    return retainLastGoodProviderQuota(
      { key: "cursor", status: "partial", detail: "正在刷新 Cursor 额度" },
      lastGood,
    );
  }
  return cursorQuotaUnavailable("waiting");
}

async function cachedGrokQuota() {
  const auth = loadGrokCliAuth();
  if (!auth) {
    const feed = grokQuotaUnavailable("not-connected");
    grokRuntime = { fingerprint: "not-connected", source: "missing" };
    grokQuotaCache = { at: Date.now(), fingerprint: "not-connected", feed };
    return feed;
  }
  grokRuntime = { fingerprint: auth.fingerprint, source: "grok-cli" };
  if (auth.expired) {
    const lastGood = grokLastGoodByAccount.get(auth.fingerprint) || state.grokSnapshots?.[auth.fingerprint];
    const feed = retainLastGoodProviderQuota(grokQuotaUnavailable("auth"), lastGood);
    grokQuotaCache = { at: Date.now(), fingerprint: auth.fingerprint, feed };
    return feed;
  }
  if (
    grokQuotaCache.feed
    && grokQuotaCache.fingerprint === auth.fingerprint
    && Date.now() - grokQuotaCache.at < quotaCacheTtl(grokQuotaCache.feed)
  ) {
    return grokQuotaCache.feed;
  }
  const lastGood = grokLastGoodByAccount.get(auth.fingerprint) || state.grokSnapshots?.[auth.fingerprint];
  void refreshGrokQuota(auth);
  if (lastGood) {
    return retainLastGoodProviderQuota(
      { key: "grok", status: "partial", detail: "正在刷新 Grok 额度" },
      lastGood,
    );
  }
  return grokQuotaUnavailable("waiting");
}

function peekCursorQuota() {
  if (cursorRuntime.source === "test-state") {
    return selectProviderQuotaSnapshot(
      cursorRuntime.fingerprint,
      cursorQuotaCache,
      { ...(state.cursorSnapshots || {}), ...(cursorLastGoodByAccount.get(cursorRuntime.fingerprint) ? { [cursorRuntime.fingerprint]: cursorLastGoodByAccount.get(cursorRuntime.fingerprint) } : {}) },
      cursorQuotaUnavailable,
    );
  }
  if (cursorQuotaCache.feed) return cursorQuotaCache.feed;
  const fingerprint = cursorRuntime.fingerprint;
  if (fingerprint && fingerprint !== "not-connected") {
    const lastGood = cursorLastGoodByAccount.get(fingerprint) || state.cursorSnapshots?.[fingerprint];
    if (lastGood) return retainLastGoodProviderQuota({ key: "cursor", status: "partial", detail: "正在刷新 Cursor 额度" }, lastGood);
  }
  if (!fs.existsSync(cursorStateDbPath())) return cursorQuotaUnavailable("not-connected");
  return cursorQuotaUnavailable("waiting");
}

function peekGrokQuota() {
  if (grokRuntime.source === "test-state") {
    return selectProviderQuotaSnapshot(
      grokRuntime.fingerprint,
      grokQuotaCache,
      state.grokSnapshots || {},
      grokQuotaUnavailable,
    );
  }
  if (grokQuotaCache.feed) return grokQuotaCache.feed;
  const auth = loadGrokCliAuth();
  if (!auth) return grokQuotaUnavailable("not-connected");
  const lastGood = grokLastGoodByAccount.get(auth.fingerprint) || state.grokSnapshots?.[auth.fingerprint];
  if (auth.expired && !lastGood) return grokQuotaUnavailable("auth");
  if (lastGood) return retainLastGoodProviderQuota(auth.expired ? grokQuotaUnavailable("auth") : { key: "grok", status: "partial", detail: "正在刷新 Grok 额度" }, lastGood);
  return grokQuotaUnavailable(auth.expired ? "auth" : "waiting");
}

async function fetchCodexQuota(auth) {
  if (!auth) return codexQuotaUnavailable("not-connected");
  const headers = {
    authorization: `Bearer ${auth.bearer}`,
    accept: "application/json",
    "user-agent": "opentoken-island/0.1",
  };
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
  const usageResp = await requestTextWithRetry("GET", CODEX_USAGE_URL, "", headers, 15000, 2);
  if (usageResp.status === 401 || usageResp.status === 403) return codexQuotaUnavailable("auth");
  if (!usageResp.ok || !plainObject(usageResp.json)) {
    logIslandEvent("codex quota refresh failed", {
      status: Number(usageResp.status || 0),
      error: String(usageResp.error || "").slice(0, 120),
      proxyError: String(usageResp.proxyError || "").slice(0, 120),
    });
    return codexQuotaUnavailable("read");
  }
  return buildCodexQuotaFeed(usageResp.json);
}

async function refreshCodexQuota(auth) {
  const fingerprint = auth?.fingerprint || "not-connected";
  const refreshKey = `codex:${fingerprint}`;
  const activeRefresh = quotaRefreshPromises.get(refreshKey);
  if (activeRefresh) return activeRefresh;
  const refresh = (async () => {
    const lastAttemptAt = new Date().toISOString();
    let fresh;
    try {
      fresh = await fetchCodexQuota(auth);
    } catch {
      fresh = codexQuotaUnavailable("read");
    }
    fresh = { ...fresh, lastAttemptAt };
    if (fresh.status === "ok") {
      fresh = { ...fresh, capturedAt: lastAttemptAt, lastSuccessfulAt: lastAttemptAt };
      persistProviderQuota("codexSnapshots", codexLastGoodByAccount, fingerprint, fresh);
    } else {
      const lastGood = codexLastGoodByAccount.get(fingerprint) || state.codexSnapshots?.[fingerprint];
      fresh = retainLastGoodProviderQuota(fresh, lastGood, lastAttemptAt);
    }
    codexQuotaCache = { at: Date.now(), fingerprint, feed: fresh };
    return fresh;
  })();
  quotaRefreshPromises.set(refreshKey, refresh);
  try {
    return await refresh;
  } finally {
    if (quotaRefreshPromises.get(refreshKey) === refresh) quotaRefreshPromises.delete(refreshKey);
  }
}

async function cachedCodexQuota() {
  const auth = loadCodexCliAuth();
  if (!auth) {
    const feed = codexQuotaUnavailable("not-connected");
    codexRuntime = { fingerprint: "not-connected", source: "missing" };
    codexQuotaCache = { at: Date.now(), fingerprint: "not-connected", feed };
    return feed;
  }
  codexRuntime = { fingerprint: auth.fingerprint, source: "codex-cli" };
  if (
    codexQuotaCache.feed
    && codexQuotaCache.fingerprint === auth.fingerprint
    && Date.now() - codexQuotaCache.at < quotaCacheTtl(codexQuotaCache.feed)
  ) {
    return codexQuotaCache.feed;
  }
  const lastGood = codexLastGoodByAccount.get(auth.fingerprint) || state.codexSnapshots?.[auth.fingerprint];
  void refreshCodexQuota(auth);
  if (lastGood) {
    return retainLastGoodProviderQuota(
      { key: "codex", status: "partial", detail: "正在刷新 Codex 额度" },
      lastGood,
    );
  }
  return codexQuotaUnavailable("waiting");
}

function peekCodexQuota() {
  if (codexRuntime.source === "test-state") {
    return selectProviderQuotaSnapshot(
      codexRuntime.fingerprint,
      codexQuotaCache,
      state.codexSnapshots || {},
      codexQuotaUnavailable,
    );
  }
  if (codexQuotaCache.feed) return codexQuotaCache.feed;
  const auth = loadCodexCliAuth();
  if (!auth) return codexQuotaUnavailable("not-connected");
  const lastGood = codexLastGoodByAccount.get(auth.fingerprint) || state.codexSnapshots?.[auth.fingerprint];
  if (lastGood) return retainLastGoodProviderQuota({ key: "codex", status: "partial", detail: "正在刷新 Codex 额度" }, lastGood);
  return codexQuotaUnavailable("waiting");
}

async function fetchKimiQuota(auth) {
  if (!auth) return kimiQuotaUnavailable("not-connected");
  const headers = {
    authorization: `Bearer ${auth.apiKey}`,
    accept: "application/json",
    "user-agent": "opentoken-island/0.1",
  };
  const resp = await requestTextWithRetry("GET", KIMI_USAGE_URL, "", headers, 15000, 2);
  if (resp.status === 401 || resp.status === 403) return kimiQuotaUnavailable("auth");
  if (!resp.ok || !plainObject(resp.json)) {
    logIslandEvent("kimi quota refresh failed", { status: Number(resp.status || 0) });
    return kimiQuotaUnavailable("read");
  }
  return buildKimiQuotaFeed(resp.json);
}

async function refreshKimiQuota(auth) {
  const fingerprint = auth?.fingerprint || "not-connected";
  const refreshKey = `kimi:${fingerprint}`;
  const activeRefresh = quotaRefreshPromises.get(refreshKey);
  if (activeRefresh) return activeRefresh;
  const refresh = (async () => {
    const lastAttemptAt = new Date().toISOString();
    let fresh;
    try {
      fresh = await fetchKimiQuota(auth);
    } catch {
      fresh = kimiQuotaUnavailable("read");
    }
    fresh = { ...fresh, lastAttemptAt };
    if (fresh.status === "ok") {
      fresh = { ...fresh, capturedAt: lastAttemptAt, lastSuccessfulAt: lastAttemptAt };
      persistProviderQuota("kimiSnapshots", kimiLastGoodByAccount, fingerprint, fresh);
    } else {
      const lastGood = kimiLastGoodByAccount.get(fingerprint) || state.kimiSnapshots?.[fingerprint];
      fresh = retainLastGoodProviderQuota(fresh, lastGood, lastAttemptAt);
    }
    kimiQuotaCache = { at: Date.now(), fingerprint, feed: fresh };
    return fresh;
  })();
  quotaRefreshPromises.set(refreshKey, refresh);
  try {
    return await refresh;
  } finally {
    if (quotaRefreshPromises.get(refreshKey) === refresh) quotaRefreshPromises.delete(refreshKey);
  }
}

async function cachedKimiQuota() {
  const auth = loadKimiCodingAuth();
  if (!auth) {
    const feed = kimiQuotaUnavailable("not-connected");
    kimiRuntime = { fingerprint: "not-connected", source: "missing" };
    kimiQuotaCache = { at: Date.now(), fingerprint: "not-connected", feed };
    return feed;
  }
  kimiRuntime = { fingerprint: auth.fingerprint, source: "opencodex" };
  if (
    kimiQuotaCache.feed
    && kimiQuotaCache.fingerprint === auth.fingerprint
    && Date.now() - kimiQuotaCache.at < quotaCacheTtl(kimiQuotaCache.feed)
  ) {
    return kimiQuotaCache.feed;
  }
  const lastGood = kimiLastGoodByAccount.get(auth.fingerprint) || state.kimiSnapshots?.[auth.fingerprint];
  void refreshKimiQuota(auth);
  if (lastGood) {
    return retainLastGoodProviderQuota(
      { key: "kimi", status: "partial", detail: "正在刷新 Kimi 额度" },
      lastGood,
    );
  }
  return kimiQuotaUnavailable("waiting");
}

function peekKimiQuota() {
  if (kimiRuntime.source === "test-state") {
    return selectProviderQuotaSnapshot(
      kimiRuntime.fingerprint,
      kimiQuotaCache,
      state.kimiSnapshots || {},
      kimiQuotaUnavailable,
    );
  }
  if (kimiQuotaCache.feed) return kimiQuotaCache.feed;
  const auth = loadKimiCodingAuth();
  if (!auth) return kimiQuotaUnavailable("not-connected");
  const lastGood = kimiLastGoodByAccount.get(auth.fingerprint) || state.kimiSnapshots?.[auth.fingerprint];
  if (lastGood) return retainLastGoodProviderQuota({ key: "kimi", status: "partial", detail: "正在刷新 Kimi 额度" }, lastGood);
  return kimiQuotaUnavailable("waiting");
}

function codexQuotaItems(byTool = {}) {
  const used = Number(byTool.codex || 0);
  const usageDetail = used > 0
    ? `今日 OpenToken 已上报 ${formatCount(used)}`
    : "等待今日 Codex 上报";
  return [
    {
      key: "codex-5h",
      label: "5小时额度",
      status: "waiting",
      value: 0,
      total: 0,
      valueLabel: "待接入",
      detail: `${usageDetail} · 需要 Codex 可读限额源`,
      pct: 4,
    },
    {
      key: "codex-weekly",
      label: "周额度",
      status: "waiting",
      value: 0,
      total: 0,
      valueLabel: "待接入",
      detail: "等待 Codex 周额度来源",
      pct: 4,
    },
  ];
}

function codexQuotaFromTools(byTool = {}, total = 0) {
  const used = Number(byTool.codex || 0);
  const items = codexQuotaItems(byTool);
  const share = total > 0 ? used / total : 0;
  if (used > 0) {
    return {
      key: "codex",
      label: "Codex",
      status: "usage",
      value: used,
      total,
      valueLabel: formatCount(used),
      detail: `今日 OpenToken 占比 ${formatPercent(share)}`,
      pct: Math.max(4, Math.round(share * 100)),
      items,
    };
  }
  return {
    key: "codex",
    label: "Codex",
    status: "waiting",
    value: 0,
    total: 0,
    valueLabel: "--",
    detail: "等待今日 Codex 上报",
    pct: 4,
    items,
  };
}

async function quotaFeeds(byTool = {}, total = 0) {
  return [
    peekZaiQuota(),
    peekCursorQuota(),
    peekGrokQuota(),
    peekCodexQuota(),
    peekKimiQuota(),
  ];
}

function usageTrends(feeds = []) {
  const glm = feeds.find((feed) => feed?.key === "glm");
  return {
    glm: glm?.usageTrend || emptyZaiUsageTrend("waiting"),
  };
}

function buildQuotaAudit(byTool = {}, feeds = []) {
  const glm = feeds.find((feed) => feed?.key === "glm");
  const glmStatus = glm?.status || "missing";
  const glmDetail = {
    ok: "已接入 Z.ai 5小时额度、MCP 额度和 24小时/7天/30天趋势",
    partial: "Z.ai 部分趋势读取失败，已保留其余可用数据",
    stale: "Z.ai 本轮读取失败，当前显示最近成功数据",
  }[glmStatus] || "未读到可用 Z.ai 额度源";
  const rows = [{
    key: "glm",
    label: "GLM / Z.ai",
    status: glmStatus,
    detail: glmDetail,
  }];
  const cursor = feeds.find((feed) => feed?.key === "cursor");
  rows.push({
    key: "cursor",
    label: "Cursor",
    status: cursor?.status || "missing",
    detail: cursor?.detail || "未读到 Cursor 套餐额度",
  });
  const grok = feeds.find((feed) => feed?.key === "grok");
  rows.push({
    key: "grok",
    label: "Grok",
    status: grok?.status || "missing",
    detail: grok?.detail || "未读到 Grok 订阅额度",
  });
  const codex = feeds.find((feed) => feed?.key === "codex");
  rows.push({
    key: "codex",
    label: "Codex",
    status: codex?.status || "missing",
    detail: codex?.detail || "未读到 Codex 套餐额度",
  });
  const kimi = feeds.find((feed) => feed?.key === "kimi");
  rows.push({
    key: "kimi",
    label: "Kimi",
    status: kimi?.status || "missing",
    detail: kimi?.detail || "未读到 Kimi 编程套餐额度",
  });

  const usageOnly = [
    ["claude-code", "Claude Code", "未找到可读官方额度源，仅显示 OpenToken 消耗"],
  ];

  for (const [key, label, detail] of usageOnly) {
    if (Number(byTool[key] || 0) > 0) {
      rows.push({ key, label, status: "usage-only", detail });
    }
  }

  for (const key of Object.keys(byTool)) {
    if (!["glm", "codex", "claude-code"].includes(key) && Number(byTool[key] || 0) > 0) {
      rows.push({
        key,
        label: toolLabel(key),
        status: "usage-only",
        detail: "已接入 OpenToken 消耗统计，未发现独立额度源",
      });
    }
  }

  return rows;
}

function leaderboardTools(byTool = {}) {
  return toolsFromMap(normalizeToolMap(byTool)).map((tool) => ({
    name: tool.name,
    label: tool.label,
    score: tool.value,
    scoreLabel: tool.valueLabel,
    value: tool.value,
    valueLabel: tool.valueLabel,
    pct: tool.pct,
    source: "scys",
    detail: "SCYS 榜单工具分（包含同账号其他电脑）",
  }));
}

function leaderboardCity(board) {
  const name = String(board?.myCity || "");
  const directoryEntry = (board?.cities || []).find((item) => String(item.city) === name) || null;
  const rank = normalizeRankValue(board?.cityRank);
  const totalScore = Math.max(0, Number(board?.cityStats?.total || 0));
  const users = Math.max(0, Number(board?.cityStats?.users || directoryEntry?.count || 0));
  const available = Boolean(name);
  return {
    status: available ? (rank ? (board?.stale ? "stale" : "ok") : "partial") : "unavailable",
    name,
    group: String(directoryEntry?.group || ""),
    rank,
    rankLabel: rank ? `#${rank}` : "#--",
    totalScore,
    totalScoreLabel: totalScore > 0 ? formatCount(totalScore) : "--",
    users,
    usersLabel: users > 0 ? String(users) : "--",
    updatedAt: String(board?.updatedAt || ""),
    reason: available ? (rank ? "SCYS 城市榜" : "今日该城无此账号") : "SCYS 未返回城市身份",
  };
}

function liveLeaderboardMatch(board) {
  return Boolean(board?.leaderboardMatched) && !board?.stale && Boolean(board?.own);
}

function publicWindowFromEntries(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  const last = list.length ? list[list.length - 1] : null;
  return {
    entriesCount: list.length,
    cutoffRank: last?.rank || list.length || null,
    cutoffScore: Math.max(0, Number(last?.score || 0)),
  };
}

function outsidePublicWindowError(window = {}) {
  const count = Math.max(0, Number(window.entriesCount || 0));
  const rank = Number(window.cutoffRank || count || 0);
  const score = Math.max(0, Number(window.cutoffScore || 0));
  if (!count) return "Current upload was not found in leaderboard yet";
  return `公开榜仅返回前 ${count} 名（第${rank}名 ${formatCount(score)}），已绑定账号不在窗口内`;
}

function leaderboardProjection(board, { accountConnected = false, boundUserId = "" } = {}) {
  const live = liveLeaderboardMatch(board);
  const own = live ? board.own : null;
  const cityOwn = board && board.cityOwn && typeof board.cityOwn === "object" ? board.cityOwn : null;
  const scoreSource = own || cityOwn;
  const score = Math.max(0, Number(scoreSource && scoreSource.score || 0));
  const rank = own?.rank ? Number(own.rank) : null;
  const byTool = normalizeToolMap((scoreSource && scoreSource.byTool) || {});
  const cutoffRank = Number(board?.cutoffRank || board?.entriesCount || 0) || null;
  const unmatchedCaption = cutoffRank ? `未进前${cutoffRank}` : "未进公开榜";
  return {
    source: "scys",
    status: live ? "ok" : (board?.own && board?.stale ? "stale" : (board?.error || accountConnected ? "unmatched" : "waiting")),
    board: String(board?.board || "total"),
    range: String(board?.range || "today"),
    matched: live,
    stale: Boolean(board?.stale),
    updatedAt: String(board?.updatedAt || ""),
    score,
    scoreLabel: live || cityOwn ? formatCount(score) : "--",
    rank,
    rankLabel: live && rank ? `#${rank}` : "#--",
    rankCaption: live ? "总榜" : unmatchedCaption,
    byTool,
    tools: leaderboardTools(byTool),
    previous: live ? board.previous || null : null,
    next: live ? board.next || null : null,
    gapToPrevious: live ? Math.max(0, Number(board?.gapToPrevious || 0)) : 0,
    leadOverNext: live ? Math.max(0, Number(board?.leadOverNext || 0)) : 0,
    city: leaderboardCity(board),
    cityDirectory: (board?.cities || []).map((item) => ({
      name: String(item.city || ""),
      group: String(item.group || ""),
      members: Math.max(0, Number(item.count || 0)),
    })).filter((item) => item.name),
    publicWindow: {
      entriesCount: Math.max(0, Number(board?.entriesCount || 0)),
      cutoffRank,
      cutoffScore: Math.max(0, Number(board?.cutoffScore || 0)),
      cutoffScoreLabel: Number(board?.cutoffScore || 0) > 0 ? formatCount(board.cutoffScore) : "",
    },
    identity: {
      status: live ? "matched" : accountConnected ? (boundUserId ? "outside-public-window" : "binding-required") : "not-connected",
      canBind: Boolean(accountConnected),
      bound: Boolean(boundUserId),
      detail: live
        ? "已绑定当前 SCYS 榜单账号"
        : boundUserId
          ? (board?.error || "已绑定账号，但今日公开榜单尚未返回该账号")
          : accountConnected
            ? "请选择一次公开榜单账号；后续按 webhook 账号隔离保存"
            : "请先配置 SCYS webhook",
    },
  };
}

function buildRankFacts({ rank, previous, next, gap, lead, sync, leaderboardTotal, city, localTotal, localTotalLabel }) {
  const matched = Boolean(sync?.leaderboardMatched);
  const localLabel = localTotalLabel || (Number(localTotal || 0) > 0 ? formatCount(localTotal) : "--");
  const distanceLabel = rank === 1 ? "领先下一名" : "距上一名";
  const distanceValue = matched
    ? formatCount(rank === 1 ? Number(lead || 0) : Number(gap || 0))
    : "--";
  const rankDetail = rank === 1
    ? (next?.name ? `领先 ${next.name}` : "榜单暂无下一名")
    : (previous?.name ? `距 ${previous.name}` : "等待榜单匹配");
  const syncValue = matched ? "已同步" : sync?.uploaded ? "已上报" : "等待";
  const syncDetail = matched
    ? "已匹配今日排行榜"
    : sync?.uploaded
      ? "已上传，等待榜单匹配"
      : "等待上传";

  return {
    source: matched ? "leaderboard" : "upload",
    items: [
      {
        key: "local-usage",
        label: "实际 Token（本机）",
        valueLabel: localLabel,
        detail: "仅这台电脑，不含其他设备",
        status: Number(localTotal || 0) > 0 || (localLabel && localLabel !== "--") ? "ok" : "waiting",
      },
      {
        key: "leaderboard-distance",
        label: distanceLabel,
        valueLabel: distanceValue,
        detail: matched ? rankDetail : (sync?.uploaded ? "公开榜未匹配到当前账号" : "等待榜单匹配"),
        status: matched ? "ok" : "waiting",
      },
      {
        key: "city-rank",
        label: city?.name ? `${city.name}城市榜` : "城市榜",
        valueLabel: city?.rankLabel || "#--",
        detail: city?.reason || "SCYS 未返回城市身份",
        status: city?.status || "unavailable",
      },
    ],
  };
}

function leaderboardEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const userId = String(entry.userId || "").slice(0, 200);
  if (!userId) return null;
  return {
    userId,
    name: String(entry.name || "").slice(0, 120),
    city: String(entry.city || "").slice(0, 80),
    rank: Number(entry.rank || 0) || null,
    score: Math.max(0, Number(entry.score || 0)),
    byTool: normalizeToolMap(entry.byTool || {}),
  };
}

function selectOwnEntry(entries, {
  claimedUserId = "",
  storedUserId = "",
} = {}) {
  const normalizedEntries = Array.isArray(entries) ? entries : [];
  const byId = (userId) => userId
    ? normalizedEntries.find((entry) => String(entry.userId) === String(userId)) || null
    : null;
  const claimed = byId(claimedUserId);
  if (claimed) return claimed;
  const stored = byId(storedUserId);
  if (stored) return stored;
  return null;
}

function findOwnEntry(entries, claimedUserId = "") {
  return selectOwnEntry(entries, {
    claimedUserId,
    storedUserId: state.userId,
  });
}

function activeScysAccountKey() {
  return String(state.accountKey || accountKeyForUpstreamUrl(proxyRuntime.upstreamUrl || state.upstreamUrl) || "");
}

function scysRequestIsCurrent(accountKey, generation) {
  return accountKey === activeScysAccountKey() && generation === scysAccountGeneration;
}

function transportForActiveAccount() {
  const accountKey = activeScysAccountKey();
  const record = state.lastUpload;
  const transport = record?.upstream;
  if (!accountKey || !transport || String(record.accountKey || "") !== accountKey) return {};
  if (String(transport.accountKey || "") !== accountKey) return {};
  if (transport.operationId && record.operationId && transport.operationId !== record.operationId) return {};
  return transport;
}

function currentLeaderboardSnapshot(today = localDateString()) {
  const board = state.leaderboard;
  const accountKey = activeScysAccountKey();
  if (!accountKey || !board || !isSameLocalDate(board.updatedAt, today)) return null;
  if (String(board.accountKey || "") !== accountKey) return null;
  return board;
}

function currentUploadSummary(today = localDateString()) {
  const record = state.lastUpload;
  const accountKey = activeScysAccountKey();
  if (!accountKey || !record?.summary || record.summary.date !== today) return null;
  if (String(record.accountKey || "") !== accountKey) return null;
  return record.summary;
}

function cacheLeaderboardCandidates(
  entries,
  metadata = null,
  expectedAccountKey = activeScysAccountKey(),
  capturedAt = Date.now(),
) {
  const accountKey = activeScysAccountKey();
  if (!accountKey || accountKey !== expectedAccountKey || !Array.isArray(entries)) return false;
  leaderboardCandidateCache = {
    at: capturedAt,
    accountKey,
    metadata,
    entries: entries.slice(0, 500),
  };
  return true;
}

function leaderboardCandidateView() {
  const accountKey = activeScysAccountKey();
  const valid = Boolean(accountKey && leaderboardCandidateCache.accountKey === accountKey);
  const entries = valid ? leaderboardCandidateCache.entries : [];
  return {
    updatedAt: valid && leaderboardCandidateCache.at ? new Date(leaderboardCandidateCache.at).toISOString() : "",
    selectedUserId: String(state.userId || ""),
    entries: entries.map((entry) => ({
      userId: entry.userId,
      name: entry.name || "未命名账号",
      rank: entry.rank,
      rankLabel: entry.rank ? `#${entry.rank}` : "#--",
      score: entry.score,
      scoreLabel: formatCount(entry.score),
      city: entry.city || "",
    })),
  };
}

function bindLeaderboardCandidate(userId) {
  const accountKey = activeScysAccountKey();
  if (!accountKey) return { ok: false, status: 409, error: "SCYS webhook 尚未配置" };
  if (leaderboardCandidateCache.accountKey !== accountKey) {
    return { ok: false, status: 409, error: "请先重新加载当前账号的公开榜单" };
  }
  if (Date.now() - leaderboardCandidateCache.at > LEADERBOARD_CANDIDATE_TTL_MS) {
    return { ok: false, status: 409, error: "公开榜单账号列表已过期，请刷新后重试" };
  }
  const own = leaderboardCandidateCache.entries.find((entry) => entry.userId === String(userId || ""));
  if (!own) return { ok: false, status: 400, error: "所选账号不在当前公开榜单中" };

  const entries = leaderboardCandidateCache.entries;
  const index = entries.findIndex((entry) => entry.userId === own.userId);
  const previous = own.rank > 1
    ? entries.find((entry) => entry.rank === own.rank - 1) || entries[index - 1] || null
    : null;
  const next = entries.find((entry) => entry.rank === own.rank + 1) || entries[index + 1] || null;
  const metadata = leaderboardCandidateCache.metadata || {};
  scysAccountGeneration += 1;
  leaderboardAutoRefresh = { at: 0, promise: null };
  state.userId = own.userId;
  state.leaderboard = {
    updatedAt: new Date().toISOString(),
    accountKey,
    ...metadata,
    publicDataFresh: true,
    myCity: own.city || metadata.myCity || "",
    cityRank: null,
    cityStats: null,
    entriesCount: entries.length,
    leaderboardMatched: true,
    own,
    previous,
    next,
    gapToPrevious: previous ? Math.max(0, Number(previous.score || 0) - Number(own.score || 0) + 1) : 0,
    leadOverNext: next ? Math.max(0, Number(own.score || 0) - Number(next.score || 0)) : 0,
    rankDelta: 0,
  };
  state.leaderboardNeedsRefresh = true;
  leaderboardAutoRefresh.at = 0;
  saveState();
  return { ok: true, status: 200, board: state.leaderboard };
}

function normalizeRankValue(value) {
  if (Number.isFinite(Number(value)) && Number(value) > 0) return Number(value);
  if (value && typeof value === "object" && Number(value.rank) > 0) return Number(value.rank);
  return null;
}

function normalizeLeaderboardMetadata(json = {}) {
  const cities = Array.isArray(json.cities) ? json.cities.slice(0, 500).map((item) => ({
    city: String(item?.city || "").slice(0, 80),
    count: Math.max(0, Number(item?.count || 0)),
    group: String(item?.group || "").slice(0, 80),
  })).filter((item) => item.city) : [];
  const groups = Array.isArray(json.groups) ? json.groups.slice(0, 100).map((item) => ({
    group: String(item?.group || "").slice(0, 80),
    count: Math.max(0, Number(item?.count || 0)),
    cities: Array.isArray(item?.cities) ? item.cities.map((city) => String(city || "").slice(0, 80)).filter(Boolean) : [],
  })).filter((item) => item.group) : [];
  const cityStats = json.cityStats && typeof json.cityStats === "object" ? {
    total: Math.max(0, Number(json.cityStats.total || 0)),
    users: Math.max(0, Number(json.cityStats.users || 0)),
  } : null;
  return {
    board: String(json.board || "total"),
    range: String(json.range || "today"),
    city: String(json.city || "").slice(0, 80),
    myCity: String(json.myCity || "").slice(0, 80),
    myRank: normalizeRankValue(json.myRank),
    cityStats,
    cities,
    groups,
    totalMembers: Math.max(0, Number(json.totalMembers || 0)),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withCacheBust(targetUrl) {
  const url = new URL(targetUrl);
  url.searchParams.set("_ts", String(Date.now()));
  return url.toString();
}

async function refreshLeaderboardCandidates({ force = false, timeoutMs = 8000 } = {}) {
  const accountKey = activeScysAccountKey();
  const generation = scysAccountGeneration;
  if (!accountKey) return { ok: false, error: "SCYS webhook 尚未配置", ...leaderboardCandidateView() };
  if (
    !force
    && leaderboardCandidateCache.accountKey === accountKey
    && Date.now() - leaderboardCandidateCache.at < LEADERBOARD_CANDIDATE_TTL_MS
  ) return { ok: true, ...leaderboardCandidateView() };

  const result = await requestTextWithRetry("GET", withCacheBust(LEADERBOARD_ENDPOINT), "", {
    accept: "application/json",
    "cache-control": "no-cache",
    pragma: "no-cache",
  }, timeoutMs, 1);
  if (!scysRequestIsCurrent(accountKey, generation)) {
    return { ok: false, error: "SCYS 账号已切换，请重新加载榜单", ...leaderboardCandidateView() };
  }
  if (!result.ok || !Array.isArray(result.json?.entries)) {
    return {
      ok: false,
      error: result.status ? `SCYS 排行榜返回 HTTP ${result.status}` : "SCYS 排行榜暂不可用",
      ...leaderboardCandidateView(),
    };
  }
  const entries = result.json.entries.map(leaderboardEntry).filter(Boolean);
  cacheLeaderboardCandidates(entries, normalizeLeaderboardMetadata(result.json), accountKey);
  return { ok: true, ...leaderboardCandidateView() };
}

function leaderboardOlderThanLastUpload(board) {
  const boardAt = Date.parse(board?.updatedAt || "");
  const uploadAt = Date.parse(state.lastUpload?.capturedAt || "");
  return Number.isFinite(boardAt) && Number.isFinite(uploadAt) && boardAt + 1000 < uploadAt;
}

function leaderboardSnapshotStale(board, now = Date.now(), maxAgeMs = LEADERBOARD_AUTO_REFRESH_INTERVAL_MS) {
  const boardAt = Date.parse(board?.updatedAt || "");
  if (!Number.isFinite(boardAt)) return true;
  return now - boardAt >= maxAgeMs;
}

function shouldRefreshLeaderboardForUpload(uploadSummary, board, today) {
  if (!uploadSummary || uploadSummary.date !== today || Number(uploadSummary.total || 0) <= 0) return false;
  if (!transportForActiveAccount().ok) return false;
  if (!board?.own || !board?.leaderboardMatched) return true;
  return leaderboardOlderThanLastUpload(board);
}

let leaderboardSyncTimer = null;

function emptyLeaderboardSync() {
  return {
    uploadOperationId: "",
    dueAt: "",
    status: "idle",
    reason: "",
    syncedForUploadId: "",
    attempt: 0,
  };
}

function leaderboardSyncState() {
  const sync = state.leaderboardSync && typeof state.leaderboardSync === "object"
    ? state.leaderboardSync
    : emptyLeaderboardSync();
  return {
    uploadOperationId: String(sync.uploadOperationId || ""),
    dueAt: String(sync.dueAt || ""),
    status: String(sync.status || "idle"),
    reason: String(sync.reason || ""),
    syncedForUploadId: String(sync.syncedForUploadId || ""),
    attempt: Math.max(0, Number(sync.attempt || 0)),
  };
}

function disarmLeaderboardSyncTimer() {
  if (!leaderboardSyncTimer) return;
  clearTimeout(leaderboardSyncTimer);
  leaderboardSyncTimer = null;
}

function armLeaderboardSyncTimer() {
  disarmLeaderboardSyncTimer();
  if (require.main !== module) return;
  const sync = leaderboardSyncState();
  if (sync.status !== "scheduled" && sync.status !== "failed") return;
  const due = Date.parse(sync.dueAt || "");
  if (!Number.isFinite(due)) return;
  const delay = Math.max(0, due - Date.now());
  leaderboardSyncTimer = setTimeout(() => {
    leaderboardSyncTimer = null;
    void runScheduledLeaderboardSync().catch(() => null);
  }, delay);
}

function scheduleLeaderboardSync({ dueAt, uploadOperationId, reason, attempt, now = Date.now() } = {}) {
  const dueMs = typeof dueAt === "number" ? dueAt : Date.parse(String(dueAt || ""));
  const dueIso = Number.isFinite(dueMs) ? new Date(dueMs).toISOString() : new Date(now).toISOString();
  state.leaderboardSync = {
    ...leaderboardSyncState(),
    uploadOperationId: String(uploadOperationId || ""),
    dueAt: dueIso,
    status: "scheduled",
    reason: String(reason || ""),
    attempt: Math.max(0, Number(attempt || 0)),
  };
  saveState();
  armLeaderboardSyncTimer();
  logIslandEvent("leaderboard sync scheduled", {
    uploadOperationId: state.leaderboardSync.uploadOperationId,
    reason: state.leaderboardSync.reason,
    dueAt: state.leaderboardSync.dueAt,
  });
  return leaderboardSyncState();
}

function leaderboardSyncDue(now = Date.now()) {
  const sync = leaderboardSyncState();
  if (sync.status === "done" && sync.syncedForUploadId && sync.syncedForUploadId === sync.uploadOperationId) {
    return false;
  }
  if (sync.status !== "scheduled" && sync.status !== "failed") return false;
  const due = Date.parse(sync.dueAt || "");
  return Number.isFinite(due) && now >= due;
}

function markLeaderboardSyncResult(ok) {
  const sync = leaderboardSyncState();
  if (ok) {
    state.leaderboardSync = {
      ...sync,
      status: "done",
      syncedForUploadId: sync.uploadOperationId,
    };
  } else if (sync.status === "running" || sync.status === "scheduled") {
    state.leaderboardSync = { ...sync, status: "failed" };
  }
  saveState();
  return leaderboardSyncState();
}

function leaderboardSyncRetryDelayMs(attempt) {
  const delays = LEADERBOARD_SYNC_RETRY_MS;
  const index = Math.max(0, Number(attempt || 0));
  if (!delays.length) return 0;
  return Number(delays[Math.min(index, delays.length - 1)] || 0);
}

function shouldFlushPendingLocalUsage() {
  return false;
}

async function flushPendingLocalUsage(input) {
  const operationId = input && input.operationId;
  const today = localDateString();
  const localSnapshot = state.localUsage && state.localUsage.date === today ? state.localUsage : null;
  if (state.usageV1Blocked) return { ok: false, skipped: true, reason: "v1-blocked" };
  if (!shouldFlushPendingLocalUsage(today, localSnapshot, state.lastUpload)) {
    return { ok: false, skipped: true };
  }
  let device = "";
  try {
    device = safeProtocolString(fs.readFileSync(path.join(HOME, ".opentoken", "device_id"), "utf8").trim(), "device", 160);
  } catch {
    return { ok: false, skipped: true, reason: "no-device" };
  }
  const proxy = ensureProxyConfig();
  const upstreamUrl = proxy.upstreamUrl || state.upstreamUrl || "";
  if (!validateScysUpstreamUrl(upstreamUrl)) return { ok: false, skipped: true, reason: "no-upstream" };
  const ccRows = augmentClaudeCodeRows(today);
  const baseRows = Array.isArray(localSnapshot.rows) ? localSnapshot.rows : [];
  const merged = ccRows.length
    ? baseRows.filter((row) => !(row && row.tool === "claude-code" && String(row.date || "") === today)).concat(ccRows)
    : baseRows;
  let payload;
  try {
    payload = sanitizeUploadPayload({ version: 1, device, rows: merged, sessions: [] });
  } catch (error) {
    logIslandEvent("blocked local usage flush", { reason: String(error.message || "").slice(0, 160) });
    return { ok: false, skipped: true, reason: "schema" };
  }
  const summary = summarizeRows(rowsFromPayload(payload), today);
  const forwardBody = JSON.stringify(payload);
  const accountKey = activeScysAccountKey();
  const sequence = Math.max(0, Number(state.uploadSequence || 0)) + 1;
  state.uploadSequence = sequence;
  const uploadRecord = {
    operationId: operationId || crypto.randomUUID(),
    accountKey,
    sequence,
    capturedAt: new Date().toISOString(),
    path: redactUploadPath(new URL(upstreamUrl).pathname),
    payloadHash: crypto.createHash("sha256").update(forwardBody).digest("hex"),
    payloadKind: "usage-v1",
    summary,
  };
  const previousUpload = state.lastUpload;
  logIslandEvent("flushing pending local usage", { date: today, total: summary.total, rowCount: summary.rowCount });
  const upstream = await requestText("POST", upstreamUrl, forwardBody, {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "opentoken-island/0.1",
  }, 30000);
  const transport = {
    operationId: uploadRecord.operationId,
    accountKey,
    sequence,
    finishedAt: new Date().toISOString(),
    status: upstream.status,
    ok: upstream.ok,
    accepted: upstream.json && upstream.json.accepted != null ? upstream.json.accepted : null,
    errorCode: upstream.ok ? "" : (upstream.status ? ("http-" + upstream.status) : "network-error"),
  };
  if (upstream.ok) {
    state.lastUpload = { ...uploadRecord, upstream: transport };
    saveState();
  } else {
    state.lastUpload = previousUpload;
    if (String((upstream.json && (upstream.json.error || upstream.json.message)) || "") === "client_version_blocked_upgrade_required") {
      state.usageV1Blocked = true;
      saveState();
    }
  }
  logIslandEvent("forwarded upload upstream", {
    operationId: uploadRecord.operationId,
    status: upstream.status,
    ok: upstream.ok,
    accepted: transport.accepted,
    error: String((upstream.json && (upstream.json.error || upstream.json.message)) || upstream.error || "").slice(0, 160),
  });
  return { ok: Boolean(upstream.ok), skipped: false };
}



function applyLeaderboardSyncOutcome(board, sync, now) {
  const current = sync && typeof sync === "object" ? sync : {};
  const reason = String(current.reason || "");
  const attempt = Math.max(0, Number(current.attempt || 0));
  const matched = Boolean(board && (board.leaderboardMatched || liveLeaderboardMatch(board)) && !board.stale);
  const fresh = Boolean(board && board.publicDataFresh);
  if (matched) return { action: "done" };
  const retryable = reason === "usage-ack" || reason === "no-new-rows";
  if (retryable && attempt + 1 < LEADERBOARD_SYNC_MAX_ATTEMPTS) {
    const nextAttempt = attempt + 1;
    return {
      action: "retry",
      attempt: nextAttempt,
      dueAt: Number(now || Date.now()) + leaderboardSyncRetryDelayMs(nextAttempt),
    };
  }
  if (fresh) return { action: "done" };
  return { action: "failed" };
}

function onManualUploadFinished(input) {
  const status = input && input.status;
  const transportAcked = Boolean(input && input.transportAcked);
  const operationId = input && input.operationId;
  const now = Number(input && input.now) || Date.now();
  if (status === "failed") return leaderboardSyncState();
  const existing = leaderboardSyncState();
  if (
    (transportAcked || status === "succeeded")
    && existing.reason === "usage-ack"
    && existing.status === "scheduled"
    && existing.uploadOperationId
  ) {
    return existing;
  }
  if (transportAcked || status === "succeeded") {
    return scheduleLeaderboardSync({
      dueAt: now,
      uploadOperationId: operationId || String((state.lastUpload && state.lastUpload.operationId) || ""),
      reason: "usage-ack",
      now,
    });
  }
  if (status === "completed") {
    return scheduleLeaderboardSync({
      dueAt: now,
      uploadOperationId: operationId || "",
      reason: "no-new-rows",
      now,
    });
  }
  return existing;
}

function withLeaderboardSyncView(payload, now = Date.now()) {
  const sync = leaderboardSyncState();
  const due = Date.parse(sync.dueAt || "");
  const remainingMs = Number.isFinite(due) ? Math.max(0, due - now) : 0;
  let caption = "";
  if (sync.status === "scheduled" && sync.reason === "no-new-rows") {
    caption = "本轮无新增，正在同步公开榜";
  } else if (sync.status === "scheduled" || sync.status === "running") {
    caption = "正在同步公开榜";
  } else if (sync.status === "failed") {
    caption = "榜单同步失败，将自动重试";
  }
  const overlay = { ...payload, leaderboardSync: { ...sync, remainingMs, caption } };
  if (caption && (sync.status === "scheduled" || sync.status === "running" || sync.status === "failed")) {
    overlay.label = caption;
    overlay.detail = caption;
    if (sync.status !== "failed") overlay.status = "leaderboard-refreshing";
  }
  return overlay;
}

async function runScheduledLeaderboardSync(options = {}) {
  if (!options.force && !leaderboardSyncDue()) return null;
  const sync = leaderboardSyncState();
  state.leaderboardSync = { ...sync, status: "running" };
  saveState();
  try {
    const board = await refreshLeaderboardIfStale(localDateString(), { force: true, request: options.request });
    const outcome = applyLeaderboardSyncOutcome(board, sync, Date.now());
    logIslandEvent("leaderboard sync result", {
      matched: Boolean(board && liveLeaderboardMatch(board)),
      cutoff: Math.max(0, Number(board && board.cutoffScore || 0)),
      cityRank: board && board.cityRank != null ? Number(board.cityRank) : null,
      attempt: Number(sync.attempt || 0),
      action: outcome.action,
    });
    if (outcome.action === "retry") {
      scheduleLeaderboardSync({
        dueAt: outcome.dueAt,
        uploadOperationId: sync.uploadOperationId,
        reason: sync.reason,
        attempt: outcome.attempt,
      });
      return board;
    }
    markLeaderboardSyncResult(outcome.action === "done");
    return board;
  } catch (error) {
    markLeaderboardSyncResult(false);
    throw error;
  }
}

function needsLeaderboardAutoRefresh(uploadSummary, board, today, now = Date.now()) {
  return leaderboardSyncDue(now);
}

function retainLeaderboardSnapshot(fresh, previous, today = localDateString()) {
  if (fresh?.accountKey && previous?.accountKey && fresh.accountKey !== previous.accountKey) return fresh;
  if (fresh?.own || !previous || !isSameLocalDate(previous.updatedAt, today)) return fresh;
  const publicDataFresh = Boolean(fresh?.publicDataFresh);
  const freshCity = String(fresh?.myCity || fresh?.city || "");
  const previousCity = String(previous?.myCity || previous?.city || "");
  const mayReusePreviousCity = !freshCity || freshCity === previousCity;
  const publicSnapshot = {
    ...fresh,
    cities: publicDataFresh ? (fresh?.cities || []) : (previous?.cities || []),
    groups: publicDataFresh ? (fresh?.groups || []) : (previous?.groups || []),
    totalMembers: publicDataFresh
      ? Math.max(0, Number(fresh?.totalMembers || 0))
      : Math.max(0, Number(previous?.totalMembers || 0)),
  };
  if (!previous?.own) {
    return {
      ...publicSnapshot,
      stale: !publicDataFresh,
      error: fresh?.error || (!publicDataFresh ? "排行榜刷新失败，保留最近成功的城市目录" : ""),
    };
  }
  return {
    ...publicSnapshot,
    own: previous.own,
    previous: previous.previous,
    next: previous.next,
    gapToPrevious: previous.gapToPrevious,
    leadOverNext: previous.leadOverNext,
    rankDelta: previous.rankDelta,
    myCity: fresh?.myCity || (mayReusePreviousCity ? previous.myCity : "") || "",
    city: fresh?.city || (mayReusePreviousCity ? previous.city : "") || "",
    cityStats: fresh?.cityStats || (mayReusePreviousCity ? previous.cityStats : null) || null,
    cityRank: fresh?.cityRank || (mayReusePreviousCity ? previous.cityRank : null) || null,
    updatedAt: fresh?.updatedAt || new Date().toISOString(),
    entriesCount: Number(fresh?.entriesCount || previous.entriesCount || 0),
    cutoffRank: Number(fresh?.cutoffRank || previous.cutoffRank || 0) || null,
    cutoffScore: Math.max(0, Number(fresh?.cutoffScore || previous.cutoffScore || 0)),
    stale: true,
    error: fresh?.error || "排行榜刷新暂未返回当前账号，保留最近成功的榜单快照",
  };
}

function retainedCityForUser(userId) {
  if (state.myCity) return String(state.myCity);
  const board = state.leaderboard;
  if (!board || String(board.own && board.own.userId || "") !== String(userId || "")) return "";
  return String(board.myCity || (board.own && board.own.city) || "");
}

function matchCityBoard(json, userId) {
  const entries = (Array.isArray(json && json.entries) ? json.entries : []).map(leaderboardEntry).filter(Boolean);
  const cityOwn = entries.find((entry) => String(entry.userId) === String(userId));
  const metadata = normalizeLeaderboardMetadata(json || {});
  return {
    matched: Boolean(cityOwn),
    city: String(metadata.city || ""),
    cityRank: cityOwn && cityOwn.rank || null,
    cityStats: metadata.cityStats || null,
    own: cityOwn || null,
  };
}

async function resolveLeaderboardCity(options) {
  const userId = options.userId;
  const knownCity = options.knownCity;
  const cities = options.cities;
  const request = options.request;
  const baseEndpoint = options.baseEndpoint;
  const timeoutMs = options.timeoutMs;
  const accountKey = options.accountKey;
  const generation = options.generation;
  const empty = { aborted: false, matched: false, city: "", cityRank: null, cityStats: null, own: null };
  if (!userId) return empty;
  const seen = new Set();
  const queue = [];
  const pushCity = (name) => {
    const city = String(name || "").trim();
    if (!city || seen.has(city)) return;
    seen.add(city);
    queue.push(city);
  };
  pushCity(knownCity);
  for (const item of cities || []) pushCity(item.city);
  if (!queue.length) return empty;

  const tryCity = async (city) => {
    if (!scysRequestIsCurrent(accountKey, generation)) return { aborted: true };
    const cityUrl = new URL(baseEndpoint);
    cityUrl.searchParams.set("city", city);
    const headers = { accept: "application/json", "cache-control": "no-cache" };
    const result = await request("GET", withCacheBust(cityUrl.toString()), "", headers, timeoutMs, 1);
    if (!scysRequestIsCurrent(accountKey, generation)) return { aborted: true };
    if (!result || !result.ok) return { aborted: false, matched: false, city };
    const match = matchCityBoard(result.json, userId);
    if (!match.matched) return { aborted: false, matched: false, city };
    return {
      aborted: false,
      matched: true,
      city: match.city || city,
      cityRank: match.cityRank,
      cityStats: match.cityStats,
      own: match.own || null,
    };
  };

  const first = await tryCity(queue.shift());
  if (first.aborted || first.matched) return first;

  for (let index = 0; index < queue.length; index += CITY_DISCOVERY_CONCURRENCY) {
    if (!scysRequestIsCurrent(accountKey, generation)) return { aborted: true };
    const batch = queue.slice(index, index + CITY_DISCOVERY_CONCURRENCY);
    const results = await Promise.all(batch.map(tryCity));
    const aborted = results.find((item) => item.aborted);
    if (aborted) return aborted;
    const hit = results.find((item) => item.matched);
    if (hit) return hit;
  }
  return empty;
}

async function refreshLeaderboard(summary, previousRank = null, options = {}) {
  const baseEndpoint = LEADERBOARD_ENDPOINT;
  const accountKey = activeScysAccountKey();
  const generation = scysAccountGeneration;
  if (!accountKey) return state.leaderboard || { leaderboardMatched: false, error: "SCYS webhook 尚未配置" };
  const outerAttempts = Number(options.outerAttempts || 4);
  const requestAttempts = Number(options.requestAttempts || 2);
  const timeoutMs = Number(options.timeoutMs || 15000);
  const request = typeof options.request === "function" ? options.request : requestTextWithRetry;
  let lastResult = null;

  for (let attempt = 0; attempt < outerAttempts; attempt += 1) {
    const endpoint = withCacheBust(baseEndpoint);
    const result = await request("GET", endpoint, "", {
      accept: "application/json",
      "cache-control": "no-cache",
      pragma: "no-cache",
    }, timeoutMs, requestAttempts);
    if (!scysRequestIsCurrent(accountKey, generation)) return state.leaderboard || { leaderboardMatched: false, error: "SCYS 账号或绑定已切换" };
    lastResult = result;
    const rawEntries = Array.isArray(result.json?.entries) ? result.json.entries : [];
    const entries = rawEntries.map(leaderboardEntry).filter(Boolean);
    const metadata = normalizeLeaderboardMetadata(result.json || {});
    if (result.ok && Array.isArray(result.json?.entries)) cacheLeaderboardCandidates(entries, metadata, accountKey);
    const claimedUserId = result.json?.myRank && typeof result.json.myRank === "object"
      ? result.json.myRank.userId
      : "";
    const own = findOwnEntry(entries, claimedUserId);

    if (own) {
      const index = entries.findIndex((entry) => entry.rank === own.rank || entry.userId === own.userId);
      const previous = own.rank > 1
        ? entries.find((entry) => entry.rank === own.rank - 1) || entries[index - 1] || null
        : null;
      const next = entries.find((entry) => entry.rank === own.rank + 1) || entries[index + 1] || null;
      const gapToPrevious = previous ? Math.max(0, Number(previous.score || 0) - Number(own.score || 0) + 1) : 0;
      const leadOverNext = next ? Math.max(0, Number(own.score || 0) - Number(next.score || 0)) : 0;
      const rankDelta = typeof previousRank === "number" ? previousRank - Number(own.rank || previousRank) : 0;

      let cityRank = null;
      let cityStats = metadata.cityStats;
      const cityIdentity = await resolveLeaderboardCity({
        userId: own.userId,
        knownCity: metadata.myCity || own.city || retainedCityForUser(own.userId),
        cities: metadata.cities,
        request,
        baseEndpoint,
        timeoutMs,
        accountKey,
        generation,
      });
      if (cityIdentity.aborted) {
        return state.leaderboard || { leaderboardMatched: false, error: "SCYS 账号或绑定已切换" };
      }
      const myCity = cityIdentity.city || metadata.myCity || own.city || "";
      if (cityIdentity.matched) {
        cityRank = cityIdentity.cityRank;
        cityStats = cityIdentity.cityStats || cityStats;
      }

      if (!scysRequestIsCurrent(accountKey, generation)) {
        return state.leaderboard || { leaderboardMatched: false, error: "SCYS 账号或绑定已切换" };
      }

      state.userId = own.userId;
      if (myCity) state.myCity = myCity;
      state.leaderboardNeedsRefresh = false;
      state.leaderboard = {
        updatedAt: new Date().toISOString(),
        accountKey,
        ...metadata,
        publicDataFresh: true,
        myCity,
        cityRank,
        cityStats,
        entriesCount: entries.length,
        leaderboardMatched: true,
        own,
        previous,
        next,
        gapToPrevious,
        leadOverNext,
        rankDelta,
      };
      saveState();
      return state.leaderboard;
    }

    if (attempt < outerAttempts - 1) await sleep(900);
  }

  const failedEntries = Array.isArray(lastResult?.json?.entries)
    ? lastResult.json.entries.map(leaderboardEntry).filter(Boolean)
    : [];
  const failedWindow = publicWindowFromEntries(failedEntries);
  const failedMeta = normalizeLeaderboardMetadata(lastResult?.json || {});
  let cityIdentity = { aborted: false, matched: false, city: "", cityRank: null, cityStats: null, own: null };
  const boundUserId = String(state.userId || "");
  if (boundUserId && lastResult && lastResult.ok) {
    const knownCity = failedMeta.myCity || state.myCity || "";
    const today = localDateString();
    const discoverCity = !String(knownCity) && String(state.cityLookupDate || "") !== today;
    cityIdentity = await resolveLeaderboardCity({
      userId: boundUserId,
      knownCity,
      cities: discoverCity ? (failedMeta.cities || []) : [],
      request,
      baseEndpoint,
      timeoutMs,
      accountKey,
      generation,
    });
    if (cityIdentity.aborted) {
      return state.leaderboard || { leaderboardMatched: false, error: "SCYS 账号或绑定已切换" };
    }
    if (discoverCity) state.cityLookupDate = today;
    if (cityIdentity.city) state.myCity = cityIdentity.city;
  }
  const failedSnapshot = {
    updatedAt: new Date().toISOString(),
    accountKey,
    ...failedMeta,
    publicDataFresh: Boolean(lastResult?.ok && Array.isArray(lastResult?.json?.entries)),
    entriesCount: failedWindow.entriesCount,
    cutoffRank: failedWindow.cutoffRank,
    cutoffScore: failedWindow.cutoffScore,
    leaderboardMatched: false,
    myCity: cityIdentity.city || failedMeta.myCity || String(state.myCity || ""),
    cityRank: cityIdentity.cityRank,
    cityStats: cityIdentity.cityStats,
    cityOwn: cityIdentity.own || null,
    error: lastResult?.ok === false
      ? (lastResult?.error || "Current upload was not found in leaderboard yet")
      : outsidePublicWindowError(failedWindow),
  };
  if (!scysRequestIsCurrent(accountKey, generation)) {
    return state.leaderboard || { leaderboardMatched: false, error: "SCYS 账号或绑定已切换" };
  }
  state.leaderboard = retainLeaderboardSnapshot(failedSnapshot, state.leaderboard);
  saveState();
  return state.leaderboard;
}

async function refreshLeaderboardIfStale(today, { force = false, request } = {}) {
  const uploadSummary = currentUploadSummary(today);
  const board = currentLeaderboardSnapshot(today);
  if (!force && !needsLeaderboardAutoRefresh(uploadSummary, board, today)) return null;
  if (!force && Date.now() - leaderboardAutoRefresh.at < LEADERBOARD_AUTO_REFRESH_INTERVAL_MS) return null;
  if (leaderboardAutoRefresh.promise) return leaderboardAutoRefresh.promise;

  leaderboardAutoRefresh.at = Date.now();
  const previousRank = state.leaderboard?.own?.rank ? Number(state.leaderboard.own.rank) : null;
  const options = force ? {} : { outerAttempts: 1, requestAttempts: 1, timeoutMs: 8000 };
  if (typeof request === "function") options.request = request;
  const tracked = refreshLeaderboard(uploadSummary, previousRank, options)
    .finally(() => {
      if (leaderboardAutoRefresh.promise === tracked) leaderboardAutoRefresh.promise = null;
    });
  leaderboardAutoRefresh.promise = tracked;
  return tracked;
}

function buildSyncStatus(uploadSummary, board) {
  return withLeaderboardSyncView(buildSyncStatusCore(uploadSummary, board));
}

function buildSyncStatusCore(uploadSummary, board) {
  const upstream = transportForActiveAccount();
  const accepted = upstream.accepted ?? upstream.json?.accepted ?? null;
  const uploaded = Boolean(upstream.ok);
  const leaderboardMatched = liveLeaderboardMatch(board);
  const entriesCount = Number(board?.entriesCount || 0);

  if (!uploadSummary && leaderboardMatched) {
    return {
      status: "leaderboard",
      label: "已同步榜单",
      detail: "已匹配今日排行榜；本地最新上传明细暂未捕获",
      uploaded: Boolean(upstream.ok),
      leaderboardMatched: true,
      accepted,
      entriesCount,
    };
  }

  if (!uploadSummary) {
    if (Number(entriesCount || 0) > 0 && !leaderboardMatched && board && board.publicDataFresh) {
      return {
        status: "uploaded-not-ranked",
        label: "未进公开榜",
        detail: board.error || ("公开榜仅返回前 " + entriesCount + " 名，暂未返回当前账号"),
        uploaded: Boolean(upstream.ok),
        leaderboardMatched: false,
        accepted,
        entriesCount,
      };
    }
    return {
      status: "waiting",
      label: "等待上报",
      detail: "尚未捕获 OpenToken 上传数据",
      uploaded: false,
      leaderboardMatched: false,
      accepted,
      entriesCount,
    };
  }

  if (board?.stale) {
    return {
      status: "leaderboard-refreshing",
      label: "已上报 · 未进公开榜",
      detail: board.error || "已上报数据；公开榜尚未返回当前账号，不再沿用旧排名",
      uploaded: true,
      leaderboardMatched: false,
      accepted,
      entriesCount,
    };
  }

  if (leaderboardMatched) {
    return {
      status: "leaderboard",
      label: "已同步榜单",
      detail: "已上报并匹配到排行榜",
      uploaded: true,
      leaderboardMatched: true,
      accepted,
      entriesCount,
    };
  }

  if (uploaded) {
    const leaderboardError = board?.error ? String(board.error) : "";
    const detail = leaderboardError
      ? leaderboardError
      : entriesCount === 0
        ? "已同步数据；排行榜刷新暂时失败"
        : `已同步数据；排行榜仅返回前 ${entriesCount} 名，暂未返回当前账号`;
    return {
      status: "uploaded-not-ranked",
      label: "已上报",
      detail,
      uploaded: true,
      leaderboardMatched: false,
      accepted,
      entriesCount,
    };
  }

  return {
    status: "upload-error",
    label: "上报失败",
    detail: upstream.error || upstream.body || "OpenToken 上传未成功",
    uploaded: false,
    leaderboardMatched: false,
    accepted,
    entriesCount,
  };
}

function laterIso(left, right) {
  const leftMs = Date.parse(left || "") || 0;
  const rightMs = Date.parse(right || "") || 0;
  if (rightMs >= leftMs && rightMs) return String(right);
  return String(left || right || "");
}

function buildSyncFacts(input) {
  input = input || {};
  const today = String(input.today || "");
  const localSnapshot = input.localSnapshot;
  const board = input.board || {};
  const leaderboard = input.leaderboard || {};
  const claudeValue = Number(input.claudeValue || 0);
  const officialClaude = input.officialClaude === undefined
    ? officialLedgerHasClaude(today)
    : Boolean(input.officialClaude);
  const sync = input.sync || {};
  const lbSync = sync.leaderboardSync || {};
  const syncing = lbSync.status === "scheduled" || lbSync.status === "running";
  const localTotal = Math.max(0, Number(localSnapshot && localSnapshot.summary && localSnapshot.summary.total || 0));
  const city = leaderboard.city || {};
  const cityName = String(city.name || board.myCity || "");
  const cityRank = city.rank != null ? Number(city.rank) : null;
  let local;
  if (localSnapshot && String(localSnapshot.date || "") === today && (localTotal > 0 || localSnapshot.completeness === "observed" || localSnapshot.completeness === "full")) {
    local = { status: "ok", detail: "本机已观察到今日用量" };
  } else if (syncing) {
    local = { status: "waiting", detail: "正在读取本机用量" };
  } else {
    local = { status: "waiting", detail: "尚未观察到今日本机用量" };
  }

  let upload;
  if (claudeValue > 0 && !officialClaude) {
    const officialRows = input.officialRows === undefined
      ? officialLedgerRowCount(today)
      : Math.max(0, Number(input.officialRows || 0));
    upload = officialRows > 0
      ? { status: "blocked", detail: "官方账本今天有记录但缺 Claude，榜上不会有这段" }
      : { status: "blocked", detail: "官方扫描今天没写成账本，本机 Claude 进不了榜" };
  } else if (syncing) {
    upload = { status: "waiting", detail: "正在等待官方上报结果" };
  } else if (sync.uploaded) {
    upload = { status: "ok", detail: "生财已确认接收" };
  } else if (lbSync.reason === "no-new-rows" || sync.status === "completed") {
    upload = { status: "ok", detail: "官方无新行" };
  } else {
    upload = { status: "waiting", detail: "尚未捕获官方上报" };
  }
  let national;
  if (board.leaderboardMatched || leaderboard.matched) {
    national = { status: "ok", detail: "已在今日公开总榜窗口内" };
  } else if (syncing) {
    national = { status: "waiting", detail: "正在核对公开总榜" };
  } else if (Number(board.entriesCount || 0) > 0) {
    const cutoff = Number(board.cutoffScore || 0);
    const cutoffRank = Number(board.cutoffRank || board.entriesCount || 0);
    national = {
      status: "outside-window",
      detail: cutoff > 0
        ? ("未进公开榜前 " + cutoffRank + "（分界 " + formatCount(cutoff) + "）")
        : ("未进公开榜前 " + cutoffRank),
    };
  } else {
    national = { status: "waiting", detail: "公开总榜尚未返回" };
  }

  let cityFact;
  if (cityRank) {
    cityFact = { status: "ok", detail: (cityName || "城市榜") + " " + (city.rankLabel || ("#" + cityRank)) };
  } else if (syncing) {
    cityFact = { status: "waiting", detail: "正在查询城市榜" };
  } else if (cityName) {
    cityFact = { status: "blocked", detail: city.reason || "今日该城无此账号" };
  } else {
    cityFact = { status: "waiting", detail: "尚未记住城市身份" };
  }

  return { local, upload, national, city: cityFact };
}


async function openTokenPreviewSnapshot(preferredDate = "") {
  const date = preferredDate || localDateString();
  if (
    previewCache.snapshot
    && previewCache.date === date
    && Date.now() - previewCache.at < PREVIEW_CACHE_TTL_MS
  ) {
    return previewCache.snapshot;
  }

  // 此扫描由 refreshUsageInBackground 调度，绝不阻塞 /api/summary；日期目录裁剪 Codex walk。
  const scanHome = prepareDatedCodexHome(date);
  let result;
  try {
    result = await run(OPENTOKEN, ["preview", "--since", date, "--json"], FULL_PREVIEW_TIMEOUT_MS, datedCodexRunOptions(scanHome));
  } finally {
    cleanupDatedCodexHome(scanHome);
  }
  if (!result.ok) {
    const snapshot = {
      ok: false,
      date,
      error: (result.stderr || result.stdout || result.message || "OpenToken preview failed").trim(),
      summary: null,
    };
    previewCache = { at: Date.now(), date, snapshot };
    return snapshot;
  }

  const payload = safeJson(result.stdout);
  if (!validUsagePayload(payload)) {
    const snapshot = { ok: false, date, error: "OpenToken preview returned malformed JSON", summary: null };
    previewCache = { at: Date.now(), date, snapshot };
    return snapshot;
  }
  const rows = rowsFromPayload(payload);
  const summary = summarizeRows(rows, date);
  const persisted = persistLocalUsageRows(rows, { date, source: "preview", replace: true });
  const snapshot = {
    ok: true,
    date,
    error: "",
    summary: persisted?.date === date ? persisted.summary : summary,
  };
  previewCache = { at: Date.now(), date, snapshot };
  return snapshot;
}

function refreshUsageInBackground(date = localDateString()) {
  if (usageRefresh.promise && usageRefresh.date === date) return usageRefresh.promise;
  const refresh = openTokenPreviewSnapshot(date).finally(() => {
    if (usageRefresh.promise === refresh) usageRefresh = { date: "", promise: null };
  });
  usageRefresh = { date, promise: refresh };
  return refresh;
}

function refreshClaudeCodeInBackground(date = localDateString()) {
  if (claudeCodeRefresh.promise && claudeCodeRefresh.date === date) return claudeCodeRefresh.promise;
  const refresh = openTokenClaudeCodeUsage(date).finally(() => {
    if (claudeCodeRefresh.promise === refresh) claudeCodeRefresh = { date: "", promise: null };
  });
  claudeCodeRefresh = { date, promise: refresh };
  return refresh;
}

function claudeCodeCacheTtl(cache) {
  return cache?.status === "ok" ? PREVIEW_CACHE_TTL_MS : QUOTA_ERROR_CACHE_TTL_MS;
}

function retainLastGoodClaudeUsage(fresh, lastGood, staleAt = new Date().toISOString()) {
  if (!lastGood || fresh?.status === "ok") return fresh;
  return {
    ...lastGood,
    at: fresh.at,
    status: "stale",
    staleAt,
    error: fresh.error || "Claude Code 扫描暂不可用",
    detail: "本轮扫描失败，正在显示今天最近一次成功数据",
  };
}

function validUsagePayload(payload) {
  return Array.isArray(payload)
    || Array.isArray(payload?.rows)
    || Array.isArray(payload?.records);
}

// 单工具扫描 claude-code 用量。`opentoken upload` 全量扫描在这台机器上常因 codex
// 海量日志超时（>120s），导致上传 payload 和公开榜单 own.byTool 都不含 claude-code。
// 这里改用秒级的 `preview --tool claude-code`（只解析 claude 日志，不碰 codex），
// 单独取本地真实用量。结果只补进工具构成，不改动主数/榜单分/排名。
async function openTokenClaudeCodeUsage(preferredDate = "") {
  const date = preferredDate || localDateString();
  if (
    claudeCodeCache.date === date
    && Date.now() - claudeCodeCache.at < claudeCodeCacheTtl(claudeCodeCache)
  ) {
    return claudeCodeCache;
  }

  // claude-code 单工具日志小，不会触发 codex 全量扫描的超时问题。
  const result = await run(OPENTOKEN, ["preview", "--tool", "claude-code", "--json"], 10000);
  if (!result.ok) {
    const fresh = {
      at: Date.now(),
      date,
      status: "error",
      rows: [],
      summary: null,
      claudeValue: 0,
      error: (result.stderr || result.stdout || result.message || "Claude Code preview failed").trim(),
    };
    claudeCodeCache = retainLastGoodClaudeUsage(fresh, claudeCodeLastGoodByDate.get(date));
    return claudeCodeCache;
  }
  const payload = safeJson(result.stdout);
  if (!validUsagePayload(payload)) {
    const fresh = {
      at: Date.now(),
      date,
      status: "error",
      rows: [],
      summary: null,
      claudeValue: 0,
      error: "Claude Code preview returned malformed JSON",
    };
    claudeCodeCache = retainLastGoodClaudeUsage(fresh, claudeCodeLastGoodByDate.get(date));
    return claudeCodeCache;
  }
  const rows = rowsFromPayload(payload);
  const summary = summarizeRows(rows, date);
  const claudeValue = Number(summary.byTool["claude-code"] || 0);
  claudeCodeCache = {
    at: Date.now(),
    date,
    status: "ok",
    rows,
    summary,
    claudeValue,
    detail: claudeValue > 0 ? `已读取 ${formatCount(claudeValue)}` : "今天暂无 Claude Code Token",
  };
  claudeCodeLastGoodByDate.set(date, claudeCodeCache);
  persistLocalUsageRows(rows, { date, source: "claude-preview" });
  return claudeCodeCache;
}

// 上传中转补全：本地 preview 扫到的 claude-code 行是权威值（含 claude-opus-5 等
// 增量账本漏掉的模型）。返回 preview 的全量 claude-code 行，调用方丢弃 payload 里
// 旧的 claude-code 行后再注入，避免 scys 端同 (date,model) 行被偏小旧值占位，
// 导致排行榜分因口径缺失而排不进前 200。让真实 claude-code 消耗随 opentoken→scys 上传。
function uploadableClaudeRows(cache, date) {
  if (cache?.status !== "ok" || !date || !Array.isArray(cache.rows) || !cache.rows.length) return [];
  return cache.rows.filter((row) =>
    row && row.tool === "claude-code" && String(row.date || "") === String(date),
  );
}

function augmentClaudeCodeRows(date) {
  // 本地 preview 扫到的 claude-code 行是权威值（含 claude-opus-5 等增量计费漏掉的模型）。
  // 返回 preview 的全量 claude-code 行，调用方丢弃 payload 里旧的 claude-code 行，
  // 避免 scys 端同 (date,model) 行被偏小的旧值占位，导致排行榜分排不进前 200。
  // stale 最近成功值仅用于 GUI 保底；扫描失败时绝不能用旧行覆盖入站的更新 payload。
  return uploadableClaudeRows(claudeCodeCache, date);
}

async function buildSummary() {
  const today = localDateString();
  const uploadSummary = currentUploadSummary(today);
  const localSnapshot = state.localUsage?.date === today ? state.localUsage : null;
  const usageSummary = localSnapshot?.summary || uploadSummary || null;
  const board = currentLeaderboardSnapshot(today);
  const leaderboard = leaderboardProjection(board, {
    accountConnected: Boolean(activeScysAccountKey()),
    boundUserId: String(state.userId || ""),
  });
  const localByTool = normalizeToolMap(usageSummary?.byTool || {});
  const normalizedByTool = normalizeToolMap(usageSummary?.normalizedByTool || {});
  const claudeByTool = claudeCodeCache.date === today ? claudeCodeCache : null;
  if (claudeByTool?.claudeValue > 0) {
    localByTool["claude-code"] = Math.max(
      Number(localByTool["claude-code"] || 0),
      Number(claudeByTool.claudeValue || 0),
    );
  }
  if (!Object.keys(localByTool).length && Number(usageSummary?.total || 0) > 0) {
    localByTool.unknown = Number(usageSummary.total);
  }
  const rawUsage = actualUsageSummary(localByTool, normalizedByTool);
  const scoredByTool = scysLocalByTool(localByTool, leaderboard.matched ? leaderboard.byTool : {});
  const actualUsage = actualUsageSummary(scoredByTool, normalizedByTool);
  for (const tool of actualUsage.tools) {
    const rawValue = Number(localByTool[tool.name] || 0);
    tool.rawValue = rawValue;
    tool.rawValueLabel = formatCount(rawValue);
    if (rawValue > Number(tool.value || 0)) tool.detail = `本机 raw ${formatCount(rawValue)}`;
  }
  const actualTotal = Number(actualUsage.total || 0);
  const rawTotal = Number(rawUsage.total || 0);
  const usageMetric = leaderboard.matched ? "scys" : "raw";
  const usageScopeLabel = usageMetric === "scys" ? "生财口径（本机）" : "实际 Token（本机）";
  const overallStatus = localSnapshot
    ? (localSnapshot.completeness === "full" ? "ok" : "partial")
    : claudeByTool?.status === "ok" || usageSummary
      ? "partial"
      : "waiting";
  const overallUsage = {
    scope: "local",
    status: overallStatus,
    date: today,
    source: String(localSnapshot?.source || (usageSummary ? "legacy-upload-observed" : (claudeByTool ? "claude-preview" : "waiting"))),
    completeness: String(localSnapshot?.completeness || (usageSummary ? "observed" : "waiting")),
    revision: Number(localSnapshot?.revision || 0),
    updatedAt: String(localSnapshot?.updatedAt || state.lastUpload?.capturedAt || ""),
    metric: usageMetric,
    scopeLabel: usageScopeLabel,
    total: actualTotal,
    rawTotal,
    totalLabel: overallStatus === "waiting" ? "--" : formatCount(actualTotal),
    byTool: scoredByTool,
    tools: actualUsage.tools.length ? actualUsage.tools : toolsFromUsageMaps(scoredByTool, normalizedByTool),
  };
  const rank = leaderboard.rank;
  const previous = leaderboard.previous;
  const next = leaderboard.next;
  const gap = leaderboard.gapToPrevious;
  const lead = leaderboard.leadOverNext;
  const leaderboardTotal = leaderboard.score;
  const hasLeaderboardScore = leaderboard.matched;
  const quotas = await quotaFeeds(localByTool, rawTotal);
  const trends = usageTrends(quotas);
  const total = actualTotal;
  const tools = overallUsage.tools;
  const quotaAudit = buildQuotaAudit(localByTool, quotas);
  const sync = buildSyncStatus(uploadSummary, board);
  sync.manualUpload = manualUploadView();
  sync.facts = buildSyncFacts({
    today,
    localSnapshot,
    uploadSummary,
    board,
    leaderboard,
    claudeValue: Number(claudeByTool && claudeByTool.claudeValue || 0),
    officialClaude: officialLedgerHasClaude(today),
    sync,
  });
  const rankFacts = buildRankFacts({
    rank, previous, next, gap, lead, sync, leaderboardTotal, city: leaderboard.city,
    localTotal: actualTotal, localTotalLabel: overallUsage.totalLabel,
  });
  const rankProgressPct = previous?.score
    ? Math.max(4, Math.min(100, Math.round((leaderboardTotal / Number(previous.score || 1)) * 100)))
    : rank === 1
      ? 100
      : 4;
  const glmFeed = quotas.find((feed) => feed?.key === "glm") || zaiQuotaUnavailable("waiting");
  const glm = {
    source: "zai",
    status: glmFeed.status || trends.glm.status,
    revision: Number(quotaCache.at || Date.parse(glmFeed.capturedAt || "") || 0),
    updatedAt: String(glmFeed.lastSuccessfulAt || glmFeed.capturedAt || ""),
    lastSuccessfulAt: String(glmFeed.lastSuccessfulAt || glmFeed.capturedAt || ""),
    lastAttemptAt: String(glmFeed.lastAttemptAt || (quotaCache.at ? new Date(quotaCache.at).toISOString() : "")),
    staleAt: String(glmFeed.staleAt || ""),
    expiredAt: String(glmFeed.expiredAt || ""),
    quota: glmFeed,
    trends: trends.glm,
  };

  return {
    ok: true,
    protocolVersion: API_PROTOCOL_VERSION,
    revision: Math.max(Number(overallUsage.revision || 0), Number(glm.revision || 0), Date.parse(leaderboard.updatedAt || "") || 0),
    waiting: overallStatus === "waiting" && !hasLeaderboardScore,
    source: overallUsage.source,
    sync,
    syncLabel: sync.label,
    leaderboardMatched: sync.leaderboardMatched,
    capturedAt: laterIso(overallUsage.updatedAt, board && board.updatedAt),
    leaderboardUpdatedAt: board?.updatedAt || "",
    date: overallStatus !== "waiting" || hasLeaderboardScore ? today : "",
    total,
    totalLabel: overallUsage.totalLabel,
    actualTotal,
    actualTotalLabel: overallUsage.totalLabel,
    usageScope: "local",
    usageScopeLabel,
    overallUsage,
    localByTool,
    leaderboardTotal,
    leaderboardTotalLabel: leaderboard.scoreLabel || "--",
    leaderboardByTool: leaderboard.byTool,
    leaderboardTools: leaderboard.tools,
    leaderboardCity: leaderboard.city,
    leaderboard,
    rank,
    rankLabel: leaderboard.rankLabel,
    previousName: previous?.name || "",
    previousScore: Number(previous?.score || 0),
    nextName: next?.name || "",
    nextScore: Number(next?.score || 0),
    gapToPrevious: gap,
    gapToPreviousLabel: rank === 1 ? "0" : formatCount(gap),
    leadOverNext: lead,
    leadOverNextLabel: formatCount(lead),
    nextRankGap: gap,
    rankProgressPct,
    rankFacts,
    tools,
    quotaFeeds: quotas,
    usageTrends: trends,
    glm,
    quotaAudit,
    localPreview: {
      ok: localSnapshot?.completeness === "full",
      date: localSnapshot?.date || "",
      error: String(previewCache.snapshot?.error || ""),
      rowCount: Number(localSnapshot?.summary?.rowCount || 0),
      capturedAt: String(localSnapshot?.updatedAt || ""),
    },
    runtime: {
      opentokenBin: OPENTOKEN,
      refreshingUsage: Boolean(usageRefresh.promise && usageRefresh.date === today),
      refreshingClaudeCode: Boolean(claudeCodeRefresh.promise && claudeCodeRefresh.date === today),
      claudeCodeStatus: claudeByTool?.status || "waiting",
      claudeCodeValue: Number(claudeByTool?.claudeValue || 0),
      claudeCodeUpdatedAt: claudeByTool?.at ? new Date(claudeByTool.at).toISOString() : "",
      claudeCodeDetail: claudeByTool?.detail || "正在读取今天的 Claude Code Token",
    },
    upstream: {
      accepted: transportForActiveAccount().accepted ?? null,
      status: transportForActiveAccount().status ?? null,
    },
  };
}

function accountStatus() {
  const proxy = proxyRuntime.upstreamUrl ? proxyRuntime : {
    upstreamUrl: String(state.upstreamUrl || ""),
    localWebhookUrl: state.upstreamUrl ? localWebhookFor(state.upstreamUrl) : "",
    proxied: Boolean(state.upstreamUrl),
  };
  const webhook = proxy.upstreamUrl || "";
  let accountId = "";
  try {
    const match = webhook.match(/\/u\/([^/?#]+)/);
    accountId = match ? match[1] : "";
  } catch {}
  return {
    connected: Boolean(webhook),
    proxied: proxy.proxied,
    accountId: accountId ? `${accountId.slice(0, 8)}...${accountId.slice(-6)}` : "",
    host: webhook ? new URL(webhook).host : "",
    localHost: proxy.localWebhookUrl ? new URL(proxy.localWebhookUrl).host : "",
    configPath: CONFIG_PATH,
  };
}

async function handleUploadProxy(req, res, url) {
  const proxy = ensureProxyConfig();
  const upstreamUrl = proxy.upstreamUrl || `${DEFAULT_UPSTREAM_ORIGIN}${url.pathname}`;
  const accountKey = activeScysAccountKey();
  const redactedPath = redactUploadPath(url.pathname);
  if (!validateScysUpstreamUrl(upstreamUrl)) {
    return json(res, 502, { ok: false, error: "SCYS upstream is not configured safely" });
  }
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
    return json(res, 415, { ok: false, error: "application/json required" });
  }
  let bodyBuffer;
  try {
    bodyBuffer = await readBody(req);
  } catch (error) {
    return json(res, /too large/i.test(String(error.message)) ? 413 : 400, { ok: false, error: error.message });
  }
  const body = bodyBuffer.toString("utf8");
  const parsed = safeJson(body);
  let payload;
  try {
    payload = sanitizeUploadPayload(parsed);
  } catch (error) {
    // 事件类型是协议枚举（hourly/session/client_health…），记录下来便于逐层适配；仍不记任何业务值。
    let eventTypes = "";
    if (Array.isArray(parsed?.events)) {
      const seen = [];
      for (const item of parsed.events) {
        const raw = typeof item?.type === "string" ? item.type : "?";
        const tag = /^[A-Za-z0-9_.:-]{1,40}$/.test(raw) ? raw : "?";
        if (!seen.includes(tag)) seen.push(tag);
        if (seen.length >= 12) break;
      }
      eventTypes = seen.join(",").slice(0, 200);
    }
    logIslandEvent("blocked upload payload", {
      path: redactedPath,
      reason: "schema-rejected",
      shape: payloadShapeSummary(parsed),
      ...(Array.isArray(parsed?.events) && plainObject(parsed.events[0])
        ? {
          event0: payloadShapeSummary(parsed.events[0]),
          ...(plainObject(parsed.events[0].payload)
            ? { event0Payload: payloadShapeSummary(parsed.events[0].payload) }
            : {}),
        }
        : {}),
      ...(eventTypes ? { eventTypes } : {}),
      detail: String(error.message || "").slice(0, 200),
    });
    return json(res, 400, { ok: false, error: String(error.message || "Upload payload rejected") });
  }
  const payloadKind = Array.isArray(payload.rows)
    ? "usage-v1"
    : (Array.isArray(payload.v2_hourly) ? "v2-hourly" : "activity-v2");
  const summary = summarizeRows(rowsFromPayload(payload));
  const hasV2Hours = Array.isArray(payload.v2_hourly) && payload.v2_hourly.length > 0;
  const hasTokenUsage = Boolean(summary.date) && (Array.isArray(payload.rows) || hasV2Hours);

  let forwardPayload = payload;
  let rewritten = false;
  if (Array.isArray(payload.rows) && summary.date) {
    persistLocalUsageRows(payload.rows, { date: summary.date, source: "upload-observed" });
    // 仅使用后台已完成的 Claude Code 当前日快照；上传代理不再等待扫描。
    const ccRows = augmentClaudeCodeRows(summary.date);
    if (ccRows.length) {
      const replacedRows = payload.rows.filter((r) =>
        r && r.tool === "claude-code" && String(r.date || "") === String(summary.date),
      ).length;
      const augmentedRows = [
        ...payload.rows.filter((r) => !(
          r
          && r.tool === "claude-code"
          && String(r.date || "") === String(summary.date)
        )),
        ...ccRows,
      ];
      forwardPayload = sanitizeUploadPayload({
        version: payload.version,
        device: payload.device,
        rows: augmentedRows,
        sessions: payload.sessions,
      });
      rewritten = true;
      logIslandEvent("augmented upload payload with claude-code rows", {
        addedRows: ccRows.length,
        replacedRows,
        date: summary.date,
      });
    }
  } else if (canRewriteV2Payload(payload) && summary.date) {
    persistLocalUsageRows(rowsFromPayload(payload), { date: summary.date, source: "upload-observed" });
    const ccRows = augmentClaudeCodeRows(summary.date);
    if (ccRows.length) {
      const hours = claudeRowsToV2Hourly(ccRows, summary.date);
      forwardPayload = sanitizeUploadPayload({
        ...payload,
        v2_hourly: mergeClaudeIntoV2Hourly(payload.v2_hourly, summary.date, hours),
      });
      rewritten = true;
      persistLocalUsageRows(rowsFromPayload(forwardPayload), { date: summary.date, source: "upload-observed" });
      logIslandEvent("augmented v2 hourly payload with claude-code rows", {
        addedRows: hours.length,
        date: summary.date,
      });
    }
  } else if (Array.isArray(payload.v2_hourly) && payload.sig) {
    if (summary.date) persistLocalUsageRows(rowsFromPayload(payload), { date: summary.date, source: "upload-observed" });
    logIslandEvent("skipped v2 rewrite because payload is signed", {
      date: summary.date || "",
      hourlyCount: payload.v2_hourly.length,
    });
  }

  // usage-v1 和无 sig 的 v2 内层批可补 Claude 后重建；带 sig 的信封必须原字节转发。
  const forwardBody = (Array.isArray(payload.rows) || rewritten) ? JSON.stringify(forwardPayload) : body;
  const sequence = Math.max(0, Number(state.uploadSequence || 0)) + 1;
  state.uploadSequence = sequence;
  const uploadRecord = {
    operationId: crypto.randomUUID(),
    accountKey,
    sequence,
    capturedAt: new Date().toISOString(),
    path: redactedPath,
    payloadHash: crypto.createHash("sha256").update(forwardBody).digest("hex"),
    payloadKind,
    summary,
  };
  if (hasTokenUsage) {
    state.lastUpload = uploadRecord;
    previewCache = { at: 0, date: "", snapshot: null };
  } else {
    state.lastActivityUpload = uploadRecord;
  }
  saveState();
  logIslandEvent("captured upload payload", {
    operationId: uploadRecord.operationId,
    path: redactedPath,
    kind: payloadKind,
    date: summary.date,
    total: summary.total,
    rowCount: summary.rowCount,
  });

  // SCYS 未公布幂等键合同；POST 自动重试可能重复入库，因此一次请求后如实报告结果未知/失败。
  const upstream = await requestText("POST", upstreamUrl, forwardBody, {
    "content-type": "application/json",
    "accept": req.headers.accept || "application/json",
    "user-agent": "opentoken-island/0.1",
  }, 30000);

  const transport = {
    operationId: uploadRecord.operationId,
    accountKey,
    sequence,
    finishedAt: new Date().toISOString(),
    status: upstream.status,
    ok: upstream.ok,
    accepted: upstream.json?.accepted ?? null,
    errorCode: upstream.ok ? "" : (upstream.status ? `http-${upstream.status}` : "network-error"),
  };
  const accountStillActive = accountKey && accountKey === activeScysAccountKey();
  const recordKey = hasTokenUsage ? "lastUpload" : "lastActivityUpload";
  if (accountStillActive && state[recordKey]?.operationId === uploadRecord.operationId) state[recordKey].upstream = transport;
  saveState();
  logIslandEvent("forwarded upload upstream", {
    operationId: uploadRecord.operationId,
    status: upstream.status,
    ok: upstream.ok,
    accepted: upstream.json?.accepted ?? null,
  });

  res.writeHead(upstream.status || 502, {
    "content-type": upstream.headers?.["content-type"] || "application/json; charset=utf-8",
  });
  res.end(upstream.body || JSON.stringify({ status: 1, error: upstream.error || "Upstream upload failed" }));

  if (upstream.ok && hasTokenUsage && accountStillActive) {
    scheduleLeaderboardSync({
      dueAt: Date.now(),
      uploadOperationId: uploadRecord.operationId,
      reason: "usage-ack",
    });
  }
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/health") {
    return json(res, 200, {
      ok: true,
      appId: APP_ID,
      appVersion: APP_VERSION,
      protocolVersion: API_PROTOCOL_VERSION,
      stateSchemaVersion: STATE_SCHEMA_VERSION,
    });
  }

  if (url.pathname === "/api/island-event") {
    return json(res, 200, { ok: true, event: currentIslandEvent() });
  }

  if (url.pathname === "/api/debug/island") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
    const reason = url.searchParams.get("reason") || "manual-debug";
    const event = queueIslandEvent(reason);
    return json(res, 200, {
      ok: true,
      event,
      summary: await buildSummary(),
    });
  }

  if (url.pathname === "/api/summary") {
    return json(res, 200, {
      ...await buildSummary(),
      account: accountStatus(),
      service: serviceCache.status,
    });
  }

  if (url.pathname === "/api/refresh") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
    scheduleLeaderboardSync({
      dueAt: Date.now(),
      uploadOperationId: "user-refresh:" + Date.now(),
      reason: "user-refresh",
    });
    void backgroundTick({ force: true });
    return json(res, 202, { ok: true, async: true, message: "后台刷新已触发" });
  }

  if (url.pathname === "/api/upload") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
    ensureProxyConfig();
    // opentoken upload 即使只扫当天日期目录也可能超过面板同步等待；后台触发、202 立即返回。
    const operation = triggerBackgroundUpload();
    if (operation.blocked) {
      return json(res, 409, { ok: false, async: false, operation, error: operation.detail });
    }
    return json(res, 202, {
      ok: true,
      async: true,
      operation,
      message: operation.joined ? "已加入正在进行的上报任务" : "后台上报已触发，可在面板查看真实结果",
    });
  }

  if (url.pathname === "/api/leaderboard-candidates") {
    if (req.method === "GET") {
      return json(res, 200, { ok: true, connected: Boolean(activeScysAccountKey()), ...leaderboardCandidateView() });
    }
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "GET or POST required" });
    const candidates = await refreshLeaderboardCandidates({ force: true });
    return json(res, candidates.ok ? 200 : (candidates.entries?.length ? 200 : 503), candidates);
  }

  if (url.pathname === "/api/leaderboard-bind") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
    if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers["content-type"] || ""))) {
      return json(res, 415, { ok: false, error: "application/json required" });
    }
    let input;
    try {
      const body = await readBody(req);
      input = safeJson(body.toString("utf8"));
    } catch (error) {
      return json(res, /too large/i.test(String(error.message)) ? 413 : 400, { ok: false, error: "invalid JSON body" });
    }
    if (!plainObject(input) || Object.keys(input).some((key) => key !== "userId")) {
      return json(res, 400, { ok: false, error: "only userId is allowed" });
    }
    const userId = String(input.userId || "");
    if (!userId || userId.length > 200) return json(res, 400, { ok: false, error: "invalid userId" });
    const bound = bindLeaderboardCandidate(userId);
    if (!bound.ok) return json(res, bound.status, { ok: false, error: bound.error });
    return json(res, 200, {
      ok: true,
      leaderboard: leaderboardProjection(bound.board, { accountConnected: true, boundUserId: userId }),
    });
  }

  if (url.pathname === "/api/shutdown") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
    // 仅供本机新版本 GUI 接管（版本不匹配时优雅退出）与卸载流程使用；
    // 受全局 Origin/Sec-Fetch-Site 本地校验保护。
    logIslandEvent("shutdown requested");
    json(res, 200, { ok: true, message: "shutting down" });
    setTimeout(() => {
      server.close();
      process.exit(0);
    }, 200);
    return;
  }

  if (url.pathname === "/api/open-logs") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
    return json(res, 200, await openLogsFile());
  }

  if (url.pathname === "/api/open-leaderboard") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
    return json(res, 200, await openExternalUrl(TOKENRANK_URL));
  }

  if (url.pathname === "/api/service") {
    if (req.method === "GET") {
      return json(res, 200, { ok: true, account: accountStatus(), service: serviceCache.status });
    }
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "GET or POST required" });
    void refreshServiceStatusInBackground();
    return json(res, 202, { ok: true, async: true, account: accountStatus(), service: serviceCache.status });
  }

  return json(res, 404, { ok: false, error: "Not found" });
}

async function serviceStatus() {
  const result = await run(OPENTOKEN, ["service", "status"], 15000);
  const text = (result.stdout || result.stderr || result.message).trim();
  return {
    ok: result.ok,
    text,
    running: result.ok && /running|loaded|已运行|active|Ready|准备|就绪/i.test(text),
  };
}

function refreshServiceStatusInBackground() {
  const startedAt = Date.now();
  return serviceStatus().then((status) => {
    if (startedAt >= serviceCache.at) serviceCache = { at: startedAt, status };
    return status;
  });
}

function localSnapshotNeedsRefresh(today, force = false) {
  if (force || state.localUsage?.date !== today) return true;
  const fullAt = Date.parse(state.localUsage?.fullAt || "");
  return !Number.isFinite(fullAt) || Date.now() - fullAt >= FULL_PREVIEW_REFRESH_INTERVAL_MS;
}

async function backgroundTick({ force = false } = {}) {
  const today = localDateString();
  if (force) {
    previewCache = { at: 0, date: "", snapshot: null };
    quotaCache.at = 0;
    cursorQuotaCache.at = 0;
    grokQuotaCache.at = 0;
    codexQuotaCache.at = 0;
    kimiQuotaCache.at = 0;
    leaderboardAutoRefresh.at = 0;
  }
  const jobs = [];
  maybeHealOfficialDaemon();
  maybeTriggerAutoUpload();
  jobs.push(refreshClaudeCodeInBackground(today).catch(() => null));
  if (FULL_PREVIEW_ENABLED && localSnapshotNeedsRefresh(today, force)) {
    jobs.push(refreshUsageInBackground(today).catch(() => null));
  }
  jobs.push(cachedZaiQuota().catch(() => null));
  jobs.push(cachedCursorQuota().catch(() => null));
  jobs.push(cachedGrokQuota().catch(() => null));
  jobs.push(cachedCodexQuota().catch(() => null));
  jobs.push(cachedKimiQuota().catch(() => null));
  jobs.push(refreshServiceStatusInBackground().catch(() => null));
  const board = currentLeaderboardSnapshot(today);
  const uploadSummary = currentUploadSummary(today);
  const bindingRefresh = Boolean(state.leaderboardNeedsRefresh);
  if (bindingRefresh) {
    scheduleLeaderboardSync({
      dueAt: Date.now(),
      uploadOperationId: "bind:" + String(state.userId || ""),
      reason: "bind",
    });
  }
  if (force || bindingRefresh || leaderboardSyncDue()) {
    jobs.push(runScheduledLeaderboardSync({ force: force || bindingRefresh }).catch(() => null));
  }
  await Promise.allSettled(jobs);
}

function startBackgroundSchedulers() {
  if (backgroundTimer) return;
  armLeaderboardSyncTimer();
  void backgroundTick();
  backgroundTimer = setInterval(() => void backgroundTick(), BACKGROUND_TICK_INTERVAL_MS);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(ROOT, requested));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "content-type": mime[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "allow": "GET,POST,OPTIONS",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const origin = String(req.headers.origin || "");
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (req.method === "POST" && fetchSite === "cross-site") {
    return json(res, 403, { ok: false, error: "cross-site write blocked" });
  }
  if (req.method === "POST" && origin) {
    let allowedOrigin = false;
    try {
      const parsedOrigin = new URL(origin);
      allowedOrigin = ["127.0.0.1", "localhost"].includes(parsedOrigin.hostname)
        && Number(parsedOrigin.port || (parsedOrigin.protocol === "https:" ? 443 : 80)) === PORT;
    } catch {}
    if (!allowedOrigin) return json(res, 403, { ok: false, error: "cross-origin write blocked" });
  }
  if (req.method === "POST" && url.pathname.startsWith("/tokenrank/api/subapp/u/")) {
    return handleUploadProxy(req, res, url);
  }
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  return serveStatic(req, res, url);
});

if (require.main === module) {
  ensureProxyConfig();
  saveState();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`OpenToken Island proxy running at http://127.0.0.1:${PORT}`);
    startBackgroundSchedulers();
  });
}

// 供单元测试直接驱动 buildSummary（require 时不 listen，避免端口冲突）
module.exports = {
  accountKeyForUpstreamUrl,
  bindLeaderboardCandidate,
  buildSummary,
  buildCodexQuotaFeed,
  buildCursorQuotaFeed,
  buildGrokQuotaFeed,
  buildZaiQuotaFeed,
  buildZaiUsageTrend,
  cacheLeaderboardCandidates,
  cursorQuotaUnavailable,
  codexQuotaUnavailable,
  emptyZaiUsageTrend,
  decryptElectronV10Payload,
  cleanupDatedCodexHome,
  codexSessionDateDirs,
  finalizeManualUploadStatus,
  prepareDatedCodexHome,
  uploadTransportAcked,
  grokQuotaUnavailable,
  buildKimiQuotaFeed,
  kimiQuotaUnavailable,
  kimiWindowMeta,
  loadKimiCodingAuth,
  resolveConfiguredSecret,
  isolateAccountState,
  buildSyncFacts,
  officialDaemonDiagnosis,
  officialLedgerRowCount,
  readOfficialLock,
  processAlive,
  canRewriteV2Payload,
  claudeRowsToV2Hourly,
  mergeClaudeIntoV2Hourly,
  officialLedgerHasClaude,
  mergeLocalUsageSnapshot,
  normalizeZaiHistoryTime,
  redactedUploadRecord,
  sanitizeUploadPayload,
  scysLocalByTool,
  selectCodexCliAuth,
  selectGrokCliAuth,
  selectOwnEntry,
  selectZaiQuotaSnapshot,
  validateScysUpstreamUrl,
  liveLeaderboardMatch,
  leaderboardProjection,
  leaderboardSnapshotStale,
  needsLeaderboardAutoRefresh,
  scheduleLeaderboardSync,
  leaderboardSyncDue,
  markLeaderboardSyncResult,
  onManualUploadFinished,
  runScheduledLeaderboardSync,
  applyLeaderboardSyncOutcome,
  leaderboardSyncRetryDelayMs,
  shouldFlushPendingLocalUsage,
  LEADERBOARD_SYNC_MAX_ATTEMPTS,
  buildSyncStatus,
  buildRankFacts,
  retainLeaderboardSnapshot,
  retainLastGoodZaiQuota,
  retainLastGoodClaudeUsage,
  refreshLeaderboard,
  summarizeRows,
  uploadableClaudeRows,
  usageTrends,
  localDateString,
  server,
  setState(next) {
    disarmLeaderboardSyncTimer();
    state = next;
    proxyRuntime = { upstreamUrl: String(next?.upstreamUrl || ""), localWebhookUrl: "", proxied: false };
    leaderboardCandidateCache = { at: 0, accountKey: "", metadata: null, entries: [] };
    leaderboardAutoRefresh = { at: 0, promise: null };
    scysAccountGeneration += 1;
    const fingerprint = String(next?.glmActiveFingerprint || "");
    const snapshot = fingerprint ? next?.glmSnapshots?.[fingerprint] : null;
    quotaCache = snapshot ? { at: Date.now(), fingerprint, zai: snapshot } : { at: 0, fingerprint: "", zai: null };
    zaiRuntime = fingerprint ? { fingerprint, source: "test-state" } : { fingerprint: "", source: "unknown" };
    const cursorFingerprint = String(next?.cursorActiveFingerprint || "");
    const cursorSnapshot = cursorFingerprint ? next?.cursorSnapshots?.[cursorFingerprint] : null;
    cursorQuotaCache = cursorSnapshot
      ? { at: Date.now(), fingerprint: cursorFingerprint, feed: cursorSnapshot }
      : { at: 0, fingerprint: "", feed: null };
    cursorRuntime = cursorFingerprint ? { fingerprint: cursorFingerprint, source: "test-state" } : { fingerprint: "", source: "unknown" };
    cursorLastGoodByAccount.clear();
    if (cursorSnapshot) cursorLastGoodByAccount.set(cursorFingerprint, cursorSnapshot);
    const grokFingerprint = String(next?.grokActiveFingerprint || "");
    const grokSnapshot = grokFingerprint ? next?.grokSnapshots?.[grokFingerprint] : null;
    grokQuotaCache = grokSnapshot
      ? { at: Date.now(), fingerprint: grokFingerprint, feed: grokSnapshot }
      : { at: 0, fingerprint: "", feed: null };
    grokRuntime = grokFingerprint ? { fingerprint: grokFingerprint, source: "test-state" } : { fingerprint: "", source: "unknown" };
    grokLastGoodByAccount.clear();
    if (grokSnapshot) grokLastGoodByAccount.set(grokFingerprint, grokSnapshot);
    const codexFingerprint = String(next?.codexActiveFingerprint || "");
    const codexSnapshot = codexFingerprint ? next?.codexSnapshots?.[codexFingerprint] : null;
    codexQuotaCache = codexSnapshot
      ? { at: Date.now(), fingerprint: codexFingerprint, feed: codexSnapshot }
      : { at: 0, fingerprint: "", feed: null };
    codexRuntime = codexFingerprint ? { fingerprint: codexFingerprint, source: "test-state" } : { fingerprint: "", source: "unknown" };
    codexLastGoodByAccount.clear();
    if (codexSnapshot) codexLastGoodByAccount.set(codexFingerprint, codexSnapshot);
    const kimiFingerprint = String(next?.kimiActiveFingerprint || "");
    const kimiSnapshot = kimiFingerprint ? next?.kimiSnapshots?.[kimiFingerprint] : null;
    kimiQuotaCache = kimiSnapshot
      ? { at: Date.now(), fingerprint: kimiFingerprint, feed: kimiSnapshot }
      : { at: 0, fingerprint: "", feed: null };
    kimiRuntime = kimiFingerprint ? { fingerprint: kimiFingerprint, source: "test-state" } : { fingerprint: "", source: "unknown" };
    kimiLastGoodByAccount.clear();
    if (kimiSnapshot) kimiLastGoodByAccount.set(kimiFingerprint, kimiSnapshot);
    zaiLastGoodByAccount.clear();
    if (snapshot) zaiLastGoodByAccount.set(fingerprint, snapshot);
  },
  getState() { return state; },
};
