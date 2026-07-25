const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
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
const TOKENRANK_URL = "https://scys.com/tokenrank/";
const ZAI_CODING_API_BASE = "https://api.z.ai";
const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;
const QUOTA_ERROR_CACHE_TTL_MS = 30 * 1000;
const PREVIEW_CACHE_TTL_MS = 45 * 1000;
// 全量 preview 只在后台刷新；Codex 历史较多时需要分钟级，不应再用 GUI 热路径的 10 秒上限。
const FULL_PREVIEW_TIMEOUT_MS = 10 * 60 * 1000;
const LEADERBOARD_AUTO_REFRESH_INTERVAL_MS = 60 * 1000;
const DNS_FALLBACK_TTL_MS = 10 * 60 * 1000;
const dnsFallbackCache = new Map();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

let state = loadState();
let quotaCache = { at: 0, zai: null };
let previewCache = { at: 0, date: "", snapshot: null };
// claude-code 单工具用量缓存：opentoken upload 全量扫描常超时漏传 claude-code，
// 这里用秒级的 `preview --tool claude-code` 单独补全本地真实用量。缓存同时保留原始
// rows，供上传中转补全 payload 复用（让真实 claude-code 消耗真正上传到 scys 榜单）。
let claudeCodeCache = { at: 0, date: "", rows: [], summary: null, claudeValue: 0 };
let usageRefresh = { date: "", promise: null };
let leaderboardAutoRefresh = { at: 0, promise: null };
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
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
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

function localWebhookFor(upstreamUrl) {
  const upstream = new URL(upstreamUrl);
  return `http://127.0.0.1:${PORT}${upstream.pathname}${upstream.search}`;
}

function upstreamFromLocal(localUrl) {
  const local = new URL(localUrl);
  return `${DEFAULT_UPSTREAM_ORIGIN}${local.pathname}${local.search}`;
}

function ensureProxyConfig() {
  const config = readConfig();
  const current = String(config.webhook_url || "");
  let stateChanged = false;

  if (OPENTOKEN !== "opentoken" && state.opentokenBin !== OPENTOKEN) {
    state.opentokenBin = OPENTOKEN;
    stateChanged = true;
  }

  if (state.upstreamUrl && isAnyLocalWebhook(state.upstreamUrl)) {
    state.upstreamUrl = upstreamFromLocal(state.upstreamUrl);
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
    } else {
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

  if (stateChanged) saveState();
  const upstreamUrl = state.upstreamUrl || "";
  return {
    upstreamUrl,
    localWebhookUrl: upstreamUrl ? localWebhookFor(upstreamUrl) : current,
    proxied: Boolean(current && isLocalWebhook(readConfig().webhook_url || current)),
  };
}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === "number" ? error.code : 0,
        stdout: stdout || "",
        stderr: stderr || "",
        message: error ? error.message : "",
      });
    });
  });
}

// 手动 Upload now：opentoken upload 全量 scan codex 原始日志常 >120s（codex 单日日志即 >45s），
// 同步等待会卡死面板。改为后台触发、立即返回 202，前端靠 summary 轮询看数据更新。
let backgroundUploadRunning = false;
function triggerBackgroundUpload() {
  if (backgroundUploadRunning) return;
  backgroundUploadRunning = true;
  logIslandEvent("manual upload started", { via: "/api/upload" });
  run(OPENTOKEN, ["upload"], 600000)
    .then((result) => {
      if (result.ok) previewCache = { at: 0, date: "", snapshot: null };
      logIslandEvent("manual upload finished", {
        ok: result.ok,
        ...(result.ok ? {} : { error: (result.stderr || result.stdout || result.message || "upload failed").slice(0, 200) }),
      });
    })
    .finally(() => { backgroundUploadRunning = false; });
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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
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

async function requestText(method, targetUrl, body = "", headers = {}, timeout = 30000) {
  const target = new URL(targetUrl);
  const first = await requestTextOnce(method, target, body, headers, timeout);
  if (first.ok || !/ENOTFOUND|EAI_AGAIN/i.test(String(first.error || ""))) return first;

  const fallbackIp = resolveHostViaPowerShell(target.hostname);
  if (!fallbackIp) return first;

  const fallbackUrl = new URL(target.href);
  fallbackUrl.hostname = fallbackIp;
  const fallbackHeaders = { ...headers, host: target.host };
  return requestTextOnce(method, fallbackUrl, body, fallbackHeaders, timeout, {
    servername: target.hostname,
  });
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
  return [];
}

function rawTokens(row) {
  return Number(row.input || 0)
    + Number(row.output || 0)
    + Number(row.cache_read || 0)
    + Number(row.cache_write || 0);
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
  const date = preferredDate && dates.includes(preferredDate)
    ? preferredDate
    : dates[dates.length - 1] || "";
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

function formatResetTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function zaiFailureReason(message = "") {
  const text = String(message || "").toLowerCase();
  if (/(401|403|unauth|forbidden|invalid|expired|expire|\bkey\b|token|认证|授权|失效|无权|非法)/i.test(text)) {
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
    status: reason === "waiting" ? "waiting" : "error",
    valueLabel: state.valueLabel,
    detail: state.detail,
    pct: 4,
    items: items.length ? items : [quotaItemUnavailable(`${key}-main`, label, reason)],
  };
}

function zaiQuotaUnavailable(reason = "waiting") {
  return quotaFeedUnavailable("glm", "GLM / Z.ai", reason, [
    quotaItemUnavailable("glm-5h", "5小时额度", reason),
    quotaItemUnavailable("glm-mcp", "MCP额度", reason),
  ]);
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

function zaiUsageHistory(resp, includeEmpty = false) {
  const data = resp?.json?.data || {};
  const times = Array.isArray(data.x_time) ? data.x_time : [];
  const tokens = Array.isArray(data.tokensUsage) ? data.tokensUsage : [];
  const history = times.map((time, index) => {
    const hasHour = String(time || "").includes(" ");
    const date = hasHour ? String(time).replace(" ", "T").slice(0, 13) : String(time || "").slice(0, 10);
    return { date, used: Number(tokens[index] || 0) };
  });
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

function zaiUsagePeriod(key, label, resp, limit, groupByDay = false, historyOverride = null) {
  const rawHistory = Array.isArray(historyOverride) ? historyOverride : zaiUsageHistory(resp);
  const history = groupByDay ? aggregateUsageByDay(rawHistory) : rawHistory;
  const total = Number(resp?.json?.data?.totalUsage?.totalTokensUsage || 0)
    || history.reduce((sum, item) => sum + Number(item.used || 0), 0);
  const bars = compactUsageBars(history, limit);
  const summary = usageBarSummary(bars);
  return {
    key,
    label,
    status: resp?.ok ? "ok" : "waiting",
    total,
    totalLabel: total > 0 ? formatCount(total) : "--",
    bars,
    ...summary,
  };
}

function buildZaiUsageTrend(resp1d, resp7d, resp30d) {
  const history24h = zaiUsagePeriod("24h", "24h", resp1d, 24, false, recentHourlyUsageHistory(resp1d, 24));
  const history1d = zaiUsagePeriod("1d", "日", resp1d, 12);
  const history7d = zaiUsagePeriod("7d", "7天", resp7d, 7, true);
  const history30d = zaiUsagePeriod("30d", "30天", resp30d, 15, true);
  return {
    key: "glm",
    label: "GLM 消耗趋势",
    source: "Coding Quota Bar",
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

function enabledZaiAccounts() {
  const config = readCodingQuotaConfig();
  const accounts = (config.providers?.zhipu?.accounts || [])
    .filter((account) => {
      const apiKey = String(account?.apiKey || "").trim();
      return account?.enabled && apiKey && !apiKey.startsWith("enc:");
    });
  const envKey = String(process.env.Z_AI_API_KEY || readWindowsUserEnv("Z_AI_API_KEY") || "").trim();
  if (envKey) {
    accounts.push({ enabled: true, apiKey: envKey, label: "env" });
  }
  return accounts;
}

async function fetchZaiQuotaForAccount(account) {
  const headers = {
    authorization: `Bearer ${String(account.apiKey).trim()}`,
    accept: "application/json",
    "user-agent": "opentoken-island/0.1",
  };
  const quotaResp = await requestTextWithRetry(
    "GET",
    `${ZAI_CODING_API_BASE}/api/monitor/usage/quota/limit`,
    "",
    headers,
    30000,
    2
  );

  if (!quotaResp.ok || quotaResp.json?.code !== 200 || !Array.isArray(quotaResp.json?.data?.limits)) {
    const message = quotaResp.json?.msg || quotaResp.error || "quota read failed";
    return zaiQuotaUnavailable(zaiFailureReason(message));
  }

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 86400000);
  const sevenDaysAgo = new Date(now.getTime() - 7 * 86400000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const [usageResp, usage7dResp, usage30dResp] = await Promise.all([
    requestTextWithRetry("GET", zaiUsageUrl(oneDayAgo, now), "", headers, 30000, 2),
    requestTextWithRetry("GET", zaiUsageUrl(sevenDaysAgo, now), "", headers, 30000, 2),
    requestTextWithRetry("GET", zaiUsageUrl(thirtyDaysAgo, now), "", headers, 30000, 2),
  ]);

  const items = zaiQuotaItems(quotaResp.json.data.limits, usageResp);
  const primary = items.find((item) => item.key === "glm-5h") || items[0];
  const levelLabel = quotaResp.json.data.level ? String(quotaResp.json.data.level).toUpperCase() : "";
  const usageTrend = buildZaiUsageTrend(usageResp, usage7dResp, usage30dResp);

  return {
    key: "glm",
    label: account.label ? `GLM / Z.ai · ${account.label}` : "GLM / Z.ai",
    status: "ok",
    value: primary?.value || 0,
    total: primary?.total || 0,
    valueLabel: primary?.valueLabel || "--",
    detail: primary?.detail || "额度已读取",
    levelLabel,
    pct: Math.max(4, ...items.map((item) => Number(item.pct || 0))),
    items,
    usageTrend,
  };
}

async function fetchZaiQuota() {
  const accounts = enabledZaiAccounts();
  if (!accounts.length) {
    return zaiQuotaUnavailable("not-connected");
  }

  let lastError = zaiQuotaUnavailable("read");
  for (const account of accounts) {
    const result = await fetchZaiQuotaForAccount(account);
    if (result.status === "ok") return result;
    lastError = result;
  }
  return lastError;
}

function quotaCacheTtl(feed) {
  return feed?.status === "ok" ? QUOTA_CACHE_TTL_MS : QUOTA_ERROR_CACHE_TTL_MS;
}

async function cachedZaiQuota() {
  if (quotaCache.zai && Date.now() - quotaCache.at < quotaCacheTtl(quotaCache.zai)) {
    return quotaCache.zai;
  }

  try {
    quotaCache = { at: Date.now(), zai: await fetchZaiQuota() };
  } catch {
    quotaCache = {
      at: Date.now(),
      zai: zaiQuotaUnavailable("read"),
    };
  }
  return quotaCache.zai;
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
    await cachedZaiQuota(),
    codexQuotaFromTools(byTool, total),
  ];
}

function usageTrends(feeds = []) {
  const glm = feeds.find((feed) => feed?.key === "glm");
  return {
    glm: glm?.usageTrend || {
      key: "glm",
      label: "GLM 消耗趋势",
      source: "Coding Quota Bar",
      history1d: zaiUsagePeriod("1d", "日", null, 12),
      history7d: zaiUsagePeriod("7d", "7天", null, 7),
      history30d: zaiUsagePeriod("30d", "30天", null, 15),
      periods: [],
    },
  };
}

function buildQuotaAudit(byTool = {}, feeds = []) {
  const glm = feeds.find((feed) => feed?.key === "glm");
  const rows = [{
    key: "glm",
    label: "GLM / Z.ai",
    status: glm?.status === "ok" ? "ok" : "missing",
    detail: glm?.status === "ok"
      ? "已接入 Z.ai 5小时额度、MCP 额度和历史消耗"
      : "未读到可用 Z.ai 额度源",
  }];

  const usageOnly = [
    ["codex", "Codex", "未找到可读 5小时/周额度源，仅显示 OpenToken 消耗"],
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

function rankedTools(byTool = {}, total = 0) {
  return Object.entries(byTool)
    .map(([name, value]) => ({
      name,
      value: Number(value || 0),
      label: toolLabel(name),
      icon: toolIcon(name),
      share: total > 0 ? Number(value || 0) / total : 0,
    }))
    .sort((a, b) => b.value - a.value);
}

function buildRankFacts({ rank, previous, next, gap, lead, sync, leaderboardTotal }) {
  const matched = Boolean(sync?.leaderboardMatched);
  const rankValue = rank ? `#${rank}` : "#--";
  const scoreLabel = leaderboardTotal > 0 ? formatCount(leaderboardTotal) : "--";
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
        key: "leaderboard-score",
        label: "榜单分",
        valueLabel: scoreLabel,
        detail: matched ? "含缓存读取，用于排行榜" : "等待排行榜匹配",
        status: matched ? "ok" : "waiting",
      },
      {
        key: "leaderboard-rank",
        label: "榜单排名",
        valueLabel: rankValue,
        detail: matched ? rankDetail : "等待榜单匹配",
        status: matched ? "ok" : "waiting",
      },
      {
        key: "sync",
        label: "同步状态",
        valueLabel: syncValue,
        detail: syncDetail,
        status: sync?.uploaded || matched ? "ok" : "waiting",
      },
    ],
  };
}

function sameToolBreakdown(entryTools = {}, summaryTools = {}) {
  const entry = normalizeToolMap(entryTools);
  const summary = normalizeToolMap(summaryTools);
  const keys = Object.keys(summary);
  if (!keys.length) return false;
  return keys.every((key) => Number(entry[key] || 0) === Number(summary[key] || 0));
}

function findOwnEntry(entries, summary) {
  if (state.userId) {
    const byUser = entries.find((entry) => String(entry.userId) === String(state.userId));
    if (byUser) return byUser;
  }
  return entries.find((entry) =>
    Number(entry.score || 0) === Number(summary.total || 0)
    && sameToolBreakdown(entry.byTool || {}, summary.byTool || {})
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withCacheBust(targetUrl) {
  const url = new URL(targetUrl);
  url.searchParams.set("_ts", String(Date.now()));
  return url.toString();
}

function leaderboardBehindUsage(board, usageSummary) {
  if (!board?.own || !usageSummary) return false;
  const usageTotal = Number(usageSummary.total || 0);
  const score = Number(board.own.score || 0);
  return usageTotal > 0 && score > 0 && score < usageTotal;
}

function leaderboardOlderThanLastUpload(board) {
  const boardAt = Date.parse(board?.updatedAt || "");
  const uploadAt = Date.parse(state.lastUpload?.capturedAt || "");
  return Number.isFinite(boardAt) && Number.isFinite(uploadAt) && boardAt + 1000 < uploadAt;
}

function shouldRefreshLeaderboardForUpload(uploadSummary, board, today) {
  if (!uploadSummary || uploadSummary.date !== today || Number(uploadSummary.total || 0) <= 0) return false;
  if (!state.lastUpload?.upstream?.ok) return false;
  if (!board?.own || !board?.leaderboardMatched) return true;
  return leaderboardBehindUsage(board, uploadSummary) || leaderboardOlderThanLastUpload(board);
}

async function refreshLeaderboard(summary, previousRank = null, options = {}) {
  const baseEndpoint = "https://scys.com/tokenrank/api/subapp/leaderboard?board=total&range=today&limit=500";
  const outerAttempts = Number(options.outerAttempts || 4);
  const requestAttempts = Number(options.requestAttempts || 2);
  const timeoutMs = Number(options.timeoutMs || 15000);
  let lastResult = null;

  for (let attempt = 0; attempt < outerAttempts; attempt += 1) {
    const endpoint = withCacheBust(baseEndpoint);
    const result = await requestTextWithRetry("GET", endpoint, "", {
      accept: "application/json",
      "cache-control": "no-cache",
      pragma: "no-cache",
    }, timeoutMs, requestAttempts);
    lastResult = result;
    const entries = Array.isArray(result.json?.entries) ? result.json.entries : [];
    const own = findOwnEntry(entries, summary);

    if (own) {
      const index = entries.findIndex((entry) => entry.rank === own.rank || entry.userId === own.userId);
      const previous = own.rank > 1
        ? entries.find((entry) => entry.rank === own.rank - 1) || entries[index - 1] || null
        : null;
      const next = entries.find((entry) => entry.rank === own.rank + 1) || entries[index + 1] || null;
      const gapToPrevious = previous ? Math.max(0, Number(previous.score || 0) - Number(own.score || 0) + 1) : 0;
      const leadOverNext = next ? Math.max(0, Number(own.score || 0) - Number(next.score || 0)) : 0;
      const rankDelta = typeof previousRank === "number" ? previousRank - Number(own.rank || previousRank) : 0;

      state.userId = own.userId;
      state.leaderboard = {
        updatedAt: new Date().toISOString(),
        board: "total",
        range: "today",
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

  state.leaderboard = {
    updatedAt: new Date().toISOString(),
    board: "total",
    range: "today",
    entriesCount: Array.isArray(lastResult?.json?.entries) ? lastResult.json.entries.length : 0,
    leaderboardMatched: false,
    error: lastResult?.error || "Current upload was not found in leaderboard yet",
  };
  saveState();
  return state.leaderboard;
}

async function refreshLeaderboardIfStale(today, { force = false } = {}) {
  const uploadSummary = state.lastUpload?.summary || null;
  const board = isSameLocalDate(state.leaderboard?.updatedAt, today) ? state.leaderboard : null;
  if (!force && !shouldRefreshLeaderboardForUpload(uploadSummary, board, today)) return null;
  if (!force && Date.now() - leaderboardAutoRefresh.at < LEADERBOARD_AUTO_REFRESH_INTERVAL_MS) return null;
  if (leaderboardAutoRefresh.promise) return leaderboardAutoRefresh.promise;

  leaderboardAutoRefresh.at = Date.now();
  const previousRank = state.leaderboard?.own?.rank ? Number(state.leaderboard.own.rank) : null;
  const options = force ? {} : { outerAttempts: 1, requestAttempts: 1, timeoutMs: 8000 };
  leaderboardAutoRefresh.promise = refreshLeaderboard(uploadSummary, previousRank, options)
    .finally(() => {
      leaderboardAutoRefresh.promise = null;
    });
  return leaderboardAutoRefresh.promise;
}

function buildSyncStatus(uploadSummary, board) {
  const upstream = state.lastUpload?.upstream || {};
  const accepted = upstream.json?.accepted ?? null;
  const uploaded = Boolean(upstream.ok);
  const leaderboardMatched = Boolean(board?.own || board?.leaderboardMatched);
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
      label: "等待榜单刷新",
      detail: board.error || "已上报数据；公开榜单仍在重新计算，榜单分和排名保留为上次公开结果",
      uploaded: true,
      leaderboardMatched,
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
    const detail = leaderboardError && entriesCount === 0
      ? `已同步数据；排行榜刷新暂时失败：${leaderboardError}`
      : `已同步数据；排行榜仅返回前 ${entriesCount || 0} 名，暂未返回当前账号`;
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

async function openTokenPreviewSnapshot(preferredDate = "") {
  const date = preferredDate || localDateString();
  if (
    previewCache.snapshot
    && previewCache.date === date
    && Date.now() - previewCache.at < PREVIEW_CACHE_TTL_MS
  ) {
    return previewCache.snapshot;
  }

  // 此扫描由 refreshUsageInBackground 调度，绝不阻塞 /api/summary；允许 Codex 海量日志完成。
  const result = await run(OPENTOKEN, ["preview", "--since", date, "--json"], FULL_PREVIEW_TIMEOUT_MS);
  if (!result.ok) {
    const snapshot = {
      ok: false,
      date,
      error: (result.stderr || result.stdout || result.message || "OpenToken preview failed").trim(),
      summary: null,
      payload: null,
    };
    previewCache = { at: Date.now(), date, snapshot };
    return snapshot;
  }

  const payload = safeJson(result.stdout);
  const rows = rowsFromPayload(payload);
  const summary = summarizeRows(rows, date);
  const snapshot = {
    ok: summary.rowCount > 0,
    date,
    error: summary.rowCount > 0 ? "" : "OpenToken preview returned no rows",
    summary,
    payload,
  };
  previewCache = { at: Date.now(), date, snapshot };
  return snapshot;
}

function refreshUsageInBackground(date = localDateString()) {
  if (usageRefresh.promise && usageRefresh.date === date) return usageRefresh.promise;
  const refresh = Promise.allSettled([
    openTokenPreviewSnapshot(date),
    openTokenClaudeCodeUsage(date),
  ]).finally(() => {
    if (usageRefresh.promise === refresh) usageRefresh = { date: "", promise: null };
  });
  usageRefresh = { date, promise: refresh };
  return refresh;
}

// 单工具扫描 claude-code 用量。`opentoken upload` 全量扫描在这台机器上常因 codex
// 海量日志超时（>120s），导致上传 payload 和公开榜单 own.byTool 都不含 claude-code。
// 这里改用秒级的 `preview --tool claude-code`（只解析 claude 日志，不碰 codex），
// 单独取本地真实用量。结果只补进工具构成，不改动主数/榜单分/排名。
async function openTokenClaudeCodeUsage(preferredDate = "") {
  const date = preferredDate || localDateString();
  if (
    claudeCodeCache.rows
    && claudeCodeCache.date === date
    && Date.now() - claudeCodeCache.at < PREVIEW_CACHE_TTL_MS
  ) {
    return claudeCodeCache;
  }

  // claude-code 单工具日志小，不会触发 codex 全量扫描的超时问题。
  const result = await run(OPENTOKEN, ["preview", "--tool", "claude-code", "--json"], 10000);
  if (!result.ok) {
    claudeCodeCache = { at: Date.now(), date, rows: [], summary: null, claudeValue: 0 };
    return claudeCodeCache;
  }
  const payload = safeJson(result.stdout);
  const rows = rowsFromPayload(payload);
  const summary = summarizeRows(rows, date);
  const claudeValue = Number(summary.byTool["claude-code"] || 0);
  claudeCodeCache = { at: Date.now(), date, rows, summary, claudeValue };
  return claudeCodeCache;
}

// 上传中转补全：本地 preview 扫到的 claude-code 行是权威值（含 claude-opus-5 等
// 增量账本漏掉的模型）。返回 preview 的全量 claude-code 行，调用方丢弃 payload 里
// 旧的 claude-code 行后再注入，避免 scys 端同 (date,model) 行被偏小旧值占位，
// 导致排行榜分因口径缺失而排不进前 200。让真实 claude-code 消耗随 opentoken→scys 上传。
function augmentClaudeCodeRows(date) {
  // 本地 preview 扫到的 claude-code 行是权威值（含 claude-opus-5 等增量计费漏掉的模型）。
  // 返回 preview 的全量 claude-code 行，调用方丢弃 payload 里旧的 claude-code 行，
  // 避免 scys 端同 (date,model) 行被偏小的旧值占位，导致排行榜分排不进前 200。
  if (!date || !Array.isArray(claudeCodeCache.rows) || !claudeCodeCache.rows.length) return [];
  return claudeCodeCache.rows.filter((r) =>
    r && r.tool === "claude-code" && String(r.date || "") === String(date),
  );
}

async function buildSummary() {
  const today = localDateString();
  const rawUploadSummary = state.lastUpload?.summary || null;
  const uploadSummary = rawUploadSummary?.date === today ? rawUploadSummary : null;
  const uploadRowsSummary = uploadSummary
    ? summarizeRows(rowsFromPayload(state.lastUpload?.payload), uploadSummary.date)
    : null;
  const rawBoard = isSameLocalDate(state.leaderboard?.updatedAt, today) ? state.leaderboard : null;
  // /summary 是 GUI 的热路径：绝不能等待全量 Codex 扫描。先返回已知缓存，扫描在
  // 后台并行进行；下一次轮询会拿到新快照，面板不会因单次扫描卡死十几秒。
  if (!rawBoard?.own) refreshUsageInBackground(today);
  const previewSnapshot = previewCache.date === today ? previewCache.snapshot : null;
  const usageSummary = previewSnapshot?.summary?.rowCount
    ? previewSnapshot.summary
    : uploadRowsSummary?.rowCount
      ? uploadRowsSummary
      : uploadSummary;
  const usageSource = previewSnapshot?.summary?.rowCount
    ? "local-preview"
    : uploadRowsSummary?.rowCount
      ? "upload"
      : uploadSummary
        ? "upload"
        : "waiting";
  const boardIsBehind = leaderboardBehindUsage(rawBoard, usageSummary || uploadSummary);
  const board = boardIsBehind
    ? {
        ...rawBoard,
        stale: true,
        error: "已上报数据；公开榜单仍在重新计算，榜单分和排名保留为上次公开结果",
      }
    : rawBoard;
  const own = board?.own || null;
  const previous = board?.previous || null;
  const next = board?.next || null;
  const usageByTool = usageSummary?.byTool || {};
  const normalizedByTool = normalizeToolMap(
    usageSummary?.normalizedByTool || {},
  );
  const byTool = normalizeToolMap(usageByTool);
  const leaderboardByTool = normalizeToolMap(own?.byTool || {});
  const leaderboardTotal = Number(own?.score || 0);
  const hasLeaderboardScore = Boolean(own && leaderboardTotal > 0);
  // 主数始终跟随已匹配的公开榜单分（与 scys 网页同口径）；
  // 不再用 boardIsBehind 闸门——raw 与榜单分口径不同源会让比较恒真、主数钉死在 raw。
  const useLeaderboardForMain = hasLeaderboardScore;
  // 工具明细与“实际消耗”统一使用原始本地 Token；只有本地没有任何行时才回退
  // 榜单的工具构成。榜单分仍独立用于排名，不再覆盖本地明细。
  let displayByTool = Object.keys(byTool).length ? byTool : leaderboardByTool;
  // opentoken upload 在本机常因 codex 海量日志全量扫描超时，导致上传 payload 与公开榜单
  // own.byTool 里的 claude-code 不可靠（缺失或偏小）。这里始终用秒级单工具全量 preview
  // 的 claude-code 值覆盖工具构成（仅展示，不计入主数）。主数/榜单分/排名仍钉死在
  // leaderboard 口径，与既有「等待榜单刷新」逻辑一致。
  const claudeByTool = claudeCodeCache.date === today ? claudeCodeCache : null;
  if (claudeByTool && claudeByTool.claudeValue > 0) {
    displayByTool = { ...displayByTool, "claude-code": claudeByTool.claudeValue };
  }
  const uploadRawTotal = Number(usageSummary?.total || uploadSummary?.total || 0);
  const rank = own ? Number(own.rank) : null;
  const gap = Number(board?.gapToPrevious || 0);
  const lead = Number(board?.leadOverNext || 0);
  const quotas = await quotaFeeds(displayByTool, useLeaderboardForMain ? leaderboardTotal : uploadRawTotal || leaderboardTotal);
  const trends = usageTrends(quotas);
  const actualUsage = actualUsageSummary(displayByTool, normalizedByTool);
  // “实际消耗”必须是原始 Token（与各工具行可加总），排行榜另有自己的归一化计分。
  // 两者都返回给 UI，避免把榜单分误标为实际消耗。
  const actualTotal = Number(actualUsage.total || uploadRawTotal || 0);
  const total = actualTotal || leaderboardTotal;
  const tools = actualUsage.tools.length
    ? actualUsage.tools
    : toolsFromUsageMaps(displayByTool, normalizedByTool);
  const quotaAudit = buildQuotaAudit(displayByTool, quotas);
  const sync = buildSyncStatus(uploadSummary, board);
  const rankFacts = buildRankFacts({ rank, previous, next, gap, lead, sync, leaderboardTotal });
  const rankProgressPct = previous?.score
    ? Math.max(4, Math.min(100, Math.round((leaderboardTotal / Number(previous.score || 1)) * 100)))
    : rank === 1
      ? 100
      : 4;

  return {
    ok: true,
    waiting: !uploadSummary && !usageSummary?.rowCount && !hasLeaderboardScore && !claudeByTool?.claudeValue,
    source: own ? "leaderboard" : (usageSummary?.rowCount ? usageSource : (claudeByTool?.claudeValue ? "claude-preview" : usageSource)),
    sync,
    syncLabel: sync.label,
    leaderboardMatched: sync.leaderboardMatched,
    capturedAt: state.lastUpload?.capturedAt || "",
    leaderboardUpdatedAt: board?.updatedAt || "",
    date: usageSummary?.date || uploadSummary?.date || (claudeByTool?.claudeValue || hasLeaderboardScore ? today : ""),
    total,
    totalLabel: usageSummary || uploadSummary || claudeByTool?.claudeValue || hasLeaderboardScore ? formatCount(total) : "--",
    actualTotal,
    actualTotalLabel: usageSummary || uploadSummary || claudeByTool?.claudeValue || hasLeaderboardScore ? formatCount(actualTotal || total) : "--",
    leaderboardTotal,
    leaderboardTotalLabel: hasLeaderboardScore ? formatCount(leaderboardTotal) : "--",
    leaderboardByTool,
    rank,
    rankLabel: rank ? `#${rank}` : "#--",
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
    quotaAudit,
    localPreview: {
      ok: Boolean(previewSnapshot?.ok),
      date: previewSnapshot?.date || "",
      error: previewSnapshot?.error || "",
      rowCount: Number(previewSnapshot?.summary?.rowCount || 0),
      capturedAt: previewCache.at ? new Date(previewCache.at).toISOString() : "",
    },
    runtime: {
      opentokenBin: OPENTOKEN,
      refreshingUsage: Boolean(usageRefresh.promise && usageRefresh.date === today),
    },
    upstream: {
      accepted: state.lastUpload?.upstream?.json?.accepted ?? null,
      status: state.lastUpload?.upstream?.status ?? null,
    },
  };
}

function accountStatus() {
  const proxy = ensureProxyConfig();
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
  const upstreamUrl = proxy.upstreamUrl || `${DEFAULT_UPSTREAM_ORIGIN}${url.pathname}${url.search}`;
  const redactedPath = redactUploadPath(url.pathname);
  const bodyBuffer = await readBody(req);
  const body = bodyBuffer.toString("utf8");
  const payload = safeJson(body);
  const summary = summarizeRows(rowsFromPayload(payload));
  const hasTokenUsage = Boolean(summary.date) && Number(summary.total || 0) > 0;
  const previousRank = state.leaderboard?.own?.rank ? Number(state.leaderboard.own.rank) : null;

  const uploadRecord = {
    capturedAt: new Date().toISOString(),
    path: redactedPath,
    payload,
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
    path: redactedPath,
    date: summary.date,
    total: summary.total,
    rowCount: summary.rowCount,
  });

  // opentoken upload 的增量账本常漏掉 claude-opus-5 等 claude-code 模型行，
  // 导致上传 payload 与公开榜单 own.byTool 不含真实的 claude-code 消耗。
  // 这里先用秒级 `preview --tool claude-code` 填充本地真实 rows（填充缓存），
  // 再把 payload 里缺失的 claude-code 行补进去，重新序列化后转发给 scys。
  let forwardBody = body;
  if (payload && Array.isArray(payload.rows) && summary.date) {
    await openTokenClaudeCodeUsage(summary.date).catch(() => null);
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
      const augmentedPayload = { ...payload, rows: augmentedRows };
      forwardBody = JSON.stringify(augmentedPayload);
      // 用补全后的 rows 重新汇总，使 state.lastUpload.summary 也含 claude-code。
      const augmentedSummary = summarizeRows(augmentedPayload.rows);
      summary.date = augmentedSummary.date;
      summary.total = augmentedSummary.total;
      summary.rowCount = augmentedSummary.rowCount;
      summary.byTool = augmentedSummary.byTool;
      summary.normalizedByTool = augmentedSummary.normalizedByTool;
      uploadRecord.payload = augmentedPayload;
      uploadRecord.summary = augmentedSummary;
      if (hasTokenUsage) state.lastUpload = uploadRecord;
      saveState();
      logIslandEvent("augmented upload payload with claude-code rows", {
        addedRows: ccRows.length,
        replacedRows,
        date: augmentedSummary.date,
        total: augmentedSummary.total,
        rowCount: augmentedSummary.rowCount,
      });
    }
  }

  const upstream = await requestTextWithRetry("POST", upstreamUrl, forwardBody, {
    "content-type": req.headers["content-type"] || "application/json",
    "accept": req.headers.accept || "application/json",
    "user-agent": req.headers["user-agent"] || "opentoken-island/0.1",
  }, 30000, 4);

  uploadRecord.upstream = {
    status: upstream.status,
    ok: upstream.ok,
    body: upstream.body,
    json: upstream.json,
    error: upstream.error || "",
  };
  saveState();
  logIslandEvent("forwarded upload upstream", {
    status: upstream.status,
    ok: upstream.ok,
    accepted: upstream.json?.accepted ?? null,
  });

  if (upstream.ok && hasTokenUsage) {
    const leaderboard = await refreshLeaderboard(summary, previousRank);
    logIslandEvent("refreshed leaderboard", {
      rank: leaderboard?.own?.rank ?? null,
      gapToPrevious: leaderboard?.gapToPrevious ?? null,
      leadOverNext: leaderboard?.leadOverNext ?? null,
    });
  }

  res.writeHead(upstream.status || 502, {
    "content-type": upstream.headers?.["content-type"] || "application/json; charset=utf-8",
  });
  res.end(upstream.body || JSON.stringify({ status: 1, error: upstream.error || "Upstream upload failed" }));
}

async function handleApi(req, res, url) {
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
    const today = localDateString();
    if (url.searchParams.get("refresh") === "1" && state.lastUpload?.summary) {
      previewCache = { at: 0, date: "", snapshot: null };
      await refreshLeaderboardIfStale(today, { force: true });
    } else {
      await refreshLeaderboardIfStale(today);
    }
    return json(res, 200, {
      ...await buildSummary(),
      account: accountStatus(),
      service: await serviceStatus(),
    });
  }

  if (url.pathname === "/api/upload") {
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "POST required" });
    ensureProxyConfig();
    // opentoken upload 全量 scan codex 日志常 >120s，同步等待会卡死面板。
    // 改后台触发、立即返回 202，前端靠 summary 轮询看数据更新。
    triggerBackgroundUpload();
    return json(res, 202, {
      ok: true,
      async: true,
      message: "后台上报已触发，数据将在刷新后更新",
    });
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
    return json(res, 200, { ok: true, account: accountStatus(), service: await serviceStatus() });
  }

  return json(res, 404, { ok: false, error: "Not found" });
}

async function serviceStatus() {
  const result = await run(OPENTOKEN, ["service", "status"], 15000);
  const text = (result.stdout || result.stderr || result.message).trim();
  return {
    ok: result.ok,
    text,
    running: result.ok && /running|loaded|已运行|active|Ready|准备|就绪|OpenToken/i.test(text),
  };
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
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
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (req.method === "POST" && url.pathname.startsWith("/tokenrank/api/subapp/u/")) {
    return handleUploadProxy(req, res, url);
  }
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  return serveStatic(req, res, url);
});

if (require.main === module) {
  ensureProxyConfig();
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`OpenToken Island proxy running at http://127.0.0.1:${PORT}`);
  });
}

// 供单元测试直接驱动 buildSummary（require 时不 listen，避免端口冲突）
module.exports = {
  buildSummary,
  localDateString,
  setState(next) { state = next; },
  getState() { return state; },
};
