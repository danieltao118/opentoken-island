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
const OPENTOKEN = process.env.OPENTOKEN_BIN || state.opentokenBin || findOpenTokenBinary() || "opentoken";

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function findOpenTokenBinary() {
  const candidates = [
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

  if (!state.opentokenBin && OPENTOKEN !== "opentoken") {
    state.opentokenBin = OPENTOKEN;
    stateChanged = true;
  }

  if (current) {
    if (isLocalWebhook(current)) {
      if (!state.upstreamUrl) {
        state.upstreamUrl = upstreamFromLocal(current);
        stateChanged = true;
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
  return entries.slice(0, 6).map(({ name, value, rawValue, normalizedValue }) => ({
    name,
    value,
    rawValue,
    normalizedValue,
    label: toolLabel(name),
    valueLabel: formatCount(value),
    rawValueLabel: formatCount(rawValue),
    normalizedLabel: normalizedValue > 0 ? formatCount(normalizedValue) : "",
    detail: normalizedValue > 0 && rawValue > 0 && rawValue !== normalizedValue
      ? `折算 ${formatCount(normalizedValue)}`
      : "",
    pct: Math.max(4, Math.round((value / max) * 100)),
  }));
}

function toolsFromMap(byTool = {}) {
  return toolsFromUsageMaps(byTool, {});
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

function zaiUsageHistory(resp) {
  const data = resp?.json?.data || {};
  const times = Array.isArray(data.x_time) ? data.x_time : [];
  const tokens = Array.isArray(data.tokensUsage) ? data.tokensUsage : [];
  return times.map((time, index) => {
    const hasHour = String(time || "").includes(" ");
    const date = hasHour ? String(time).replace(" ", "T").slice(0, 13) : String(time || "").slice(0, 10);
    return { date, used: Number(tokens[index] || 0) };
  }).filter((item) => item.used > 0);
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
    pct: Math.max(6, Math.round((item.used / max) * 100)),
  }));
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

function zaiUsagePeriod(key, label, resp, limit, groupByDay = false) {
  const rawHistory = zaiUsageHistory(resp);
  const history = groupByDay ? aggregateUsageByDay(rawHistory) : rawHistory;
  const total = Number(resp?.json?.data?.totalUsage?.totalTokensUsage || 0)
    || history.reduce((sum, item) => sum + Number(item.used || 0), 0);
  return {
    key,
    label,
    status: resp?.ok ? "ok" : "waiting",
    total,
    totalLabel: total > 0 ? formatCount(total) : "--",
    bars: compactUsageBars(history, limit),
  };
}

function buildZaiUsageTrend(resp1d, resp7d, resp30d) {
  const history1d = zaiUsagePeriod("1d", "日", resp1d, 12);
  const history7d = zaiUsagePeriod("7d", "7天", resp7d, 7, true);
  const history30d = zaiUsagePeriod("30d", "30天", resp30d, 15, true);
  return {
    key: "glm",
    label: "GLM 消耗趋势",
    source: "Coding Quota Bar",
    history1d,
    history7d,
    history30d,
    periods: [history1d, history7d, history30d],
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

function buildRankFacts({ rank, previous, next, gap, lead, sync }) {
  const accepted = Number(state.lastUpload?.upstream?.json?.accepted || 0);
  const matched = Boolean(sync?.leaderboardMatched);
  const rankValue = rank ? `#${rank}` : "#--";
  const gapLabel = rank === 1 ? formatCount(lead) : rank ? formatCount(gap) : "--";
  const gapDetail = rank === 1
    ? (next?.name ? `领先 ${next.name}` : "榜单暂无下一名")
    : (previous?.name ? `距 ${previous.name}` : "等待榜单匹配");

  return {
    source: matched ? "leaderboard" : "upload",
    items: [
      {
        key: "rank",
        label: "当前排名",
        valueLabel: rankValue,
        detail: matched ? "来自今日排行榜" : "等待排行榜匹配",
        status: matched ? "ok" : "waiting",
      },
      {
        key: rank === 1 ? "lead" : "gap",
        label: rank === 1 ? "领先下一名" : "距上一名",
        valueLabel: gapLabel,
        detail: gapDetail,
        status: matched ? "ok" : "waiting",
      },
      {
        key: "accepted",
        label: "上报接收",
        valueLabel: accepted ? `${accepted} 条` : "--",
        detail: sync?.label || "等待上传",
        status: accepted ? "ok" : "waiting",
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

async function refreshLeaderboard(summary, previousRank = null) {
  const endpoint = "https://scys.com/tokenrank/api/subapp/leaderboard?board=total&range=today&limit=500";
  let lastResult = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await requestTextWithRetry("GET", endpoint, "", { accept: "application/json" }, 15000, 2);
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

    if (attempt < 3) await sleep(900);
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

function buildSyncStatus(uploadSummary, board) {
  const upstream = state.lastUpload?.upstream || {};
  const accepted = upstream.json?.accepted ?? null;
  const uploaded = Boolean(upstream.ok);
  const leaderboardMatched = Boolean(board?.own || board?.leaderboardMatched);
  const entriesCount = Number(board?.entriesCount || 0);

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

  if (leaderboardMatched) {
    return {
      status: "leaderboard",
      label: "已同步榜单",
      detail: `已上报${accepted !== null ? ` ${accepted} 条` : ""}，并匹配到排行榜`,
      uploaded: true,
      leaderboardMatched: true,
      accepted,
      entriesCount,
    };
  }

  if (uploaded) {
    const leaderboardError = board?.error ? String(board.error) : "";
    const detail = leaderboardError && entriesCount === 0
      ? `已同步${accepted !== null ? ` ${accepted} 条记录` : "数据"}；排行榜刷新暂时失败：${leaderboardError}`
      : `已同步${accepted !== null ? ` ${accepted} 条记录` : "数据"}；排行榜仅返回前 ${entriesCount || 0} 名，暂未返回当前账号`;
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

async function buildSummary() {
  const uploadSummary = state.lastUpload?.summary || null;
  const uploadRowsSummary = uploadSummary
    ? summarizeRows(rowsFromPayload(state.lastUpload?.payload), uploadSummary.date)
    : null;
  const board = state.leaderboard || null;
  const own = board?.own || null;
  const previous = board?.previous || null;
  const next = board?.next || null;
  const uploadByTool = uploadRowsSummary?.rowCount
    ? uploadRowsSummary.byTool
    : uploadSummary?.byTool || {};
  const normalizedByTool = normalizeToolMap(
    uploadRowsSummary?.rowCount
      ? uploadRowsSummary.normalizedByTool
      : uploadSummary?.normalizedByTool || {},
  );
  const byTool = normalizeToolMap(own?.byTool || uploadByTool);
  const total = Number(own?.score || uploadSummary?.total || 0);
  const rank = own ? Number(own.rank) : null;
  const gap = Number(board?.gapToPrevious || 0);
  const lead = Number(board?.leadOverNext || 0);
  const tools = toolsFromUsageMaps(byTool, normalizedByTool);
  const quotas = await quotaFeeds(byTool, total);
  const trends = usageTrends(quotas);
  const quotaAudit = buildQuotaAudit(byTool, quotas);
  const sync = buildSyncStatus(uploadSummary, board);
  const rankFacts = buildRankFacts({ rank, previous, next, gap, lead, sync });
  const rankProgressPct = previous?.score
    ? Math.max(4, Math.min(100, Math.round((total / Number(previous.score || 1)) * 100)))
    : rank === 1
      ? 100
      : 4;

  return {
    ok: true,
    waiting: !uploadSummary,
    source: own ? "leaderboard" : uploadSummary ? "upload" : "waiting",
    sync,
    syncLabel: sync.label,
    leaderboardMatched: sync.leaderboardMatched,
    capturedAt: state.lastUpload?.capturedAt || "",
    leaderboardUpdatedAt: board?.updatedAt || "",
    date: uploadSummary?.date || "",
    total,
    totalLabel: uploadSummary ? formatCount(total) : "--",
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
  const previousRank = state.leaderboard?.own?.rank ? Number(state.leaderboard.own.rank) : null;

  state.lastUpload = {
    capturedAt: new Date().toISOString(),
    path: redactedPath,
    payload,
    summary,
  };
  saveState();
  logIslandEvent("captured upload payload", {
    path: redactedPath,
    date: summary.date,
    total: summary.total,
    rowCount: summary.rowCount,
  });

  const upstream = await requestTextWithRetry("POST", upstreamUrl, body, {
    "content-type": req.headers["content-type"] || "application/json",
    "accept": req.headers.accept || "application/json",
    "user-agent": req.headers["user-agent"] || "opentoken-island/0.1",
  }, 30000, 4);

  state.lastUpload.upstream = {
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

  if (upstream.ok && summary.total > 0) {
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
    if (url.searchParams.get("refresh") === "1" && state.lastUpload?.summary) {
      await refreshLeaderboard(state.lastUpload.summary, state.leaderboard?.own?.rank || null);
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
    const result = await run(OPENTOKEN, ["upload"], 120000);
    return json(res, result.ok ? 200 : 500, {
      ok: result.ok,
      output: (result.stdout || result.stderr || result.message).trim(),
      summary: await buildSummary(),
      account: accountStatus(),
      service: await serviceStatus(),
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

ensureProxyConfig();
server.listen(PORT, "127.0.0.1", () => {
  console.log(`OpenToken Island proxy running at http://127.0.0.1:${PORT}`);
});
