const http = require("http");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const PORT = Number(process.env.OPENTOKEN_ISLAND_PORT || 4174);
const ROOT = __dirname;
const HOME = process.env.HOME || os.homedir();
const CONFIG_PATH = path.join(HOME, ".opentoken", "config.json");
const STATE_PATH = path.join(HOME, ".opentoken", "island-state.json");
const EVENT_LOG_PATH = path.join(HOME, ".opentoken", "island-events.log");
const DEFAULT_UPSTREAM_ORIGIN = "https://scys.com";
const APPDATA = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const CODING_QUOTA_CONFIG_PATH = path.join(APPDATA, "coding-quota-bar", "config.json");
const ZAI_CODING_API_BASE = "https://api.z.ai";
const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;

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

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function requestText(method, targetUrl, body = "", headers = {}, timeout = 30000) {
  return new Promise((resolve) => {
    const target = new URL(targetUrl);
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
  let normalized = 0;
  for (const row of dayRows) {
    const tool = normalizeToolName(row.tool || row.provider || row.client || "unknown");
    byTool[tool] = (byTool[tool] || 0) + rawTokens(row);
    normalized += Number(row.normalized || 0);
  }
  const total = Object.values(byTool).reduce((sum, value) => sum + value, 0);
  return { date, total, normalized, byTool, rowCount: dayRows.length };
}

function toolsFromMap(byTool = {}) {
  const entries = Object.entries(byTool).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, value]) => value));
  return entries.slice(0, 6).map(([name, value]) => ({
    name,
    value,
    label: toolLabel(name),
    valueLabel: formatCount(value),
    pct: Math.max(4, Math.round((value / max) * 100)),
  }));
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

function quotaFeedUnavailable(key, label, reason = "waiting") {
  const states = {
    "not-connected": { valueLabel: "未配置", detail: "前往 Coding Quota Bar 绑定 Z.ai" },
    auth: { valueLabel: "API Key 失效", detail: "请在 Coding Quota Bar 更新密钥" },
    read: { valueLabel: "无法读取额度", detail: "Z.ai 接口暂不可用" },
    waiting: { valueLabel: "--", detail: "等待额度上报" },
  };
  const state = states[reason] || states.waiting;
  return {
    key,
    label,
    status: reason === "waiting" ? "waiting" : "error",
    valueLabel: state.valueLabel,
    detail: state.detail,
    pct: 4,
  };
}

function readCodingQuotaConfig() {
  try {
    return JSON.parse(fs.readFileSync(CODING_QUOTA_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function enabledZaiAccounts() {
  const config = readCodingQuotaConfig();
  const accounts = (config.providers?.zhipu?.accounts || [])
    .filter((account) => account?.enabled && String(account.apiKey || "").trim());
  const envKey = String(process.env.Z_AI_API_KEY || "").trim();
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
  const quotaResp = await requestText(
    "GET",
    `${ZAI_CODING_API_BASE}/api/monitor/usage/quota/limit`,
    "",
    headers,
    8000
  );

  if (!quotaResp.ok || quotaResp.json?.code !== 200 || !Array.isArray(quotaResp.json?.data?.limits)) {
    const message = quotaResp.json?.msg || quotaResp.error || "quota read failed";
    return quotaFeedUnavailable("glm", "GLM / Z.ai", zaiFailureReason(message));
  }

  const now = new Date();
  const oneDayAgo = new Date(now.getTime() - 86400000);
  const usageResp = await requestText(
    "GET",
    `${ZAI_CODING_API_BASE}/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatZaiDateTime(oneDayAgo))}&endTime=${encodeURIComponent(formatZaiDateTime(now))}`,
    "",
    headers,
    8000
  );

  const tokenLimit = quotaResp.json.data.limits.find((item) => item.type === "TOKENS_LIMIT")
    || quotaResp.json.data.limits[0];
  const usageRate = clampPercent(tokenLimit?.percentage || 0);
  const modelCalls = Number(usageResp.json?.data?.totalUsage?.totalModelCallCount);
  const currentValue = Number(tokenLimit?.currentValue || 0);
  const used = Number.isFinite(modelCalls) && modelCalls > 0 ? modelCalls : currentValue;
  const totalByRate = usageRate > 0 ? Math.round(used / (usageRate / 100)) : 0;
  const total = Math.max(used, totalByRate, Number(tokenLimit?.usage || 0));
  const remaining = Math.max(0, 100 - Math.round(usageRate));
  const resetAt = tokenLimit?.nextResetTime ? formatResetTime(tokenLimit.nextResetTime) : "";
  const level = quotaResp.json.data.level ? ` · ${String(quotaResp.json.data.level).toUpperCase()}` : "";

  return {
    key: "glm",
    label: account.label ? `GLM / Z.ai · ${account.label}` : "GLM / Z.ai",
    status: "ok",
    value: used,
    total,
    valueLabel: total > 0 ? `${formatCount(used)} / ${formatCount(total)}` : formatCount(used),
    detail: `剩余 ${remaining}%${resetAt ? ` · ${resetAt} 重置` : ""}${level}`,
    pct: Math.max(4, Math.round(usageRate)),
  };
}

async function fetchZaiQuota() {
  const accounts = enabledZaiAccounts();
  if (!accounts.length) {
    return quotaFeedUnavailable("glm", "GLM / Z.ai", "not-connected");
  }

  let lastError = quotaFeedUnavailable("glm", "GLM / Z.ai", "read");
  for (const account of accounts) {
    const result = await fetchZaiQuotaForAccount(account);
    if (result.status === "ok") return result;
    lastError = result;
  }
  return lastError;
}

async function cachedZaiQuota() {
  if (quotaCache.zai && Date.now() - quotaCache.at < QUOTA_CACHE_TTL_MS) {
    return quotaCache.zai;
  }

  try {
    quotaCache = { at: Date.now(), zai: await fetchZaiQuota() };
  } catch {
    quotaCache = {
      at: Date.now(),
      zai: quotaFeedUnavailable("glm", "GLM / Z.ai", "read"),
    };
  }
  return quotaCache.zai;
}

function codexQuotaFromTools(byTool = {}, total = 0) {
  const used = Number(byTool.codex || 0);
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
  };
}

async function quotaFeeds(byTool = {}, total = 0) {
  return [
    await cachedZaiQuota(),
    codexQuotaFromTools(byTool, total),
  ];
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

function buildGame({ total, rank, rankDelta, byTool, previous, next, gap, lead }) {
  const levelSize = 25_000_000;
  const highOutputTarget = 300_000_000;
  const toolRanks = rankedTools(byTool, total);
  const mainTool = toolRanks[0] || { name: "", label: "Main Tool", icon: "terminal", value: 0, share: 0 };
  const runnerUpTool = toolRanks[1] || null;
  const mainLead = runnerUpTool ? Math.max(0, mainTool.value - runnerUpTool.value) : mainTool.value;
  const accepted = Number(state.lastUpload?.upstream?.json?.accepted || 0);
  const level = Math.max(1, Math.floor(total / levelSize) + 1);
  const xp = total > 0 ? total % levelSize : 0;
  const xpPct = Math.max(4, Math.round((xp / levelSize) * 100));
  const scoreDone = total >= highOutputTarget;
  const king = rank === 1;
  const rankQuest = king
    ? {
        icon: "crown",
        title: "王座守护：今日总榜第 1",
        detail: next ? `领先 ${next.name} ${formatCount(lead)}` : "当前无人追近",
        rewardLabel: "+800",
        done: true,
      }
    : {
        icon: "trending-up",
        title: "排名冲刺：超过上一名",
        detail: previous ? `距 ${previous.name} 还差 ${formatCount(gap)}` : "等待榜单排名",
        rewardLabel: "+800",
        done: false,
      };

  return {
    level,
    levelTitle: `Builder Lv. ${level}`,
    xp,
    xpMax: levelSize,
    xpPct,
    xpLabel: `${formatCount(xp)} / ${formatCount(levelSize)} XP`,
    codexShare: total > 0 ? Number(byTool.codex || 0) / total : 0,
    codexShareLabel: formatPercent(total > 0 ? Number(byTool.codex || 0) / total : 0),
    mainTool: {
      name: mainTool.name,
      label: mainTool.label,
      value: mainTool.value,
      valueLabel: formatCount(mainTool.value),
      share: mainTool.share,
      shareLabel: formatPercent(mainTool.share),
      leadLabel: formatCount(mainLead),
    },
    quests: [
      rankQuest,
      {
        icon: "target",
        title: "每日任务：冲到 3 亿",
        detail: `${formatCount(total)} / ${formatCount(highOutputTarget)}`,
        rewardLabel: "+620",
        done: scoreDone,
      },
      {
        icon: mainTool.icon,
        title: `主力工具：${mainTool.label} Main`,
        detail: runnerUpTool
          ? `领先 ${runnerUpTool.label} ${formatCount(mainLead)}`
          : `${formatPercent(mainTool.share)} share`,
        rewardLabel: "+240",
        done: mainTool.value > 0,
      },
    ],
    badges: [
      {
        icon: "crown",
        title: "King Mode",
        detail: king ? "今日总榜 #1" : rank ? `当前 #${rank}` : "等待排名",
        unlocked: king,
        featured: king,
      },
      {
        icon: "flame",
        title: "High Output",
        detail: `${formatCount(total)} / ${formatCount(highOutputTarget)}`,
        unlocked: scoreDone,
        featured: scoreDone && !king,
      },
      {
        icon: mainTool.icon,
        title: `${mainTool.label} Main`,
        detail: `${formatPercent(mainTool.share)} share`,
        unlocked: mainTool.value > 0,
        featured: false,
      },
      {
        icon: "trending-up",
        title: "Rank Climber",
        detail: rankDelta > 0 ? `上升 ${rankDelta} 名` : king ? "守住第 1" : "等待突破",
        unlocked: rankDelta > 0 || king,
        featured: false,
      },
    ],
    sync: {
      accepted,
      done: accepted > 0,
    },
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
    const result = await requestText("GET", endpoint, "", { accept: "application/json" });
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
    error: lastResult?.error || "Current upload was not found in leaderboard yet",
  };
  saveState();
  return state.leaderboard;
}

async function buildSummary() {
  const uploadSummary = state.lastUpload?.summary || null;
  const board = state.leaderboard || null;
  const own = board?.own || null;
  const previous = board?.previous || null;
  const next = board?.next || null;
  const byTool = normalizeToolMap(own?.byTool || uploadSummary?.byTool || {});
  const total = Number(own?.score || uploadSummary?.total || 0);
  const rank = own ? Number(own.rank) : null;
  const gap = Number(board?.gapToPrevious || 0);
  const lead = Number(board?.leadOverNext || 0);
  const tools = toolsFromMap(byTool);
  const quotas = await quotaFeeds(byTool, total);
  const game = buildGame({
    total,
    rank,
    rankDelta: Number(board?.rankDelta || 0),
    byTool,
    previous,
    next,
    gap,
    lead,
  });

  return {
    ok: true,
    waiting: !uploadSummary,
    source: own ? "leaderboard" : uploadSummary ? "upload" : "waiting",
    capturedAt: state.lastUpload?.capturedAt || "",
    leaderboardUpdatedAt: board?.updatedAt || "",
    date: uploadSummary?.date || "",
    total,
    totalLabel: uploadSummary ? formatCount(total) : "--",
    rank,
    rankLabel: rank ? `#${rank}` : "#--",
    rankDelta: Number(board?.rankDelta || 0),
    previousName: previous?.name || "",
    previousScore: Number(previous?.score || 0),
    nextName: next?.name || "",
    nextScore: Number(next?.score || 0),
    gapToPrevious: gap,
    gapToPreviousLabel: rank === 1 ? "0" : formatCount(gap),
    leadOverNext: lead,
    leadOverNextLabel: formatCount(lead),
    nextRankGap: gap,
    xp: game.xp,
    xpMax: game.xpMax,
    game,
    quests: game.quests,
    badges: game.badges,
    tools,
    quotaFeeds: quotas,
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

  const upstream = await requestText("POST", upstreamUrl, body, {
    "content-type": req.headers["content-type"] || "application/json",
    "accept": req.headers.accept || "application/json",
    "user-agent": req.headers["user-agent"] || "opentoken-island/0.1",
  });

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

  if (url.pathname === "/api/service") {
    return json(res, 200, { ok: true, account: accountStatus(), service: await serviceStatus() });
  }

  return json(res, 404, { ok: false, error: "Not found" });
}

async function serviceStatus() {
  const result = await run(OPENTOKEN, ["service", "status"], 15000);
  return {
    ok: result.ok,
    text: (result.stdout || result.stderr || result.message).trim(),
    running: /running|loaded|已运行|active/i.test(result.stdout + result.stderr),
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
