const path = require("path");

const {
  accountKeyForUpstreamUrl,
  localDateString,
  mergeLocalUsageSnapshot,
  server,
  setState,
} = require(path.resolve(__dirname, "..", "server.js"));

const today = localDateString();
const now = new Date().toISOString();
const unmatched = process.env.GUI_FIXTURE_MODE === "unmatched";
const upstreamUrl = "https://scys.com/tokenrank/api/subapp/u/gui-fixture";
const accountKey = accountKeyForUpstreamUrl(upstreamUrl);

function period(key, label, count, scale) {
  const bars = Array.from({ length: count }, (_, index) => {
    const used = (index % 5 + 1) * scale;
    return {
      label: key === "24h" ? String(index).padStart(2, "0") : `${index + 1}日`,
      used,
      valueLabel: String(used),
      pct: Math.round(((index % 5) + 1) * 20),
    };
  });
  const total = bars.reduce((sum, item) => sum + item.used, 0);
  return {
    key,
    label,
    status: "ok",
    empty: false,
    bucketCount: bars.length,
    bucketUnit: key === "24h" ? "hour" : "day",
    total,
    totalLabel: String(total),
    peakLabel: `${bars[4].label} · ${bars[4].valueLabel}`,
    latestLabel: `${bars[bars.length - 1].label} · ${bars[bars.length - 1].valueLabel}`,
    bars,
  };
}

const periods = [
  period("24h", "24小时", 24, 1000),
  period("7d", "7天", 7, 10000),
  period("30d", "30天", 30, 20000),
];
const trend = {
  key: "glm",
  label: "GLM 消耗趋势",
  source: "Z.ai 用量接口",
  status: "ok",
  history24h: periods[0],
  history7d: periods[1],
  history30d: periods[2],
  periods,
};
const glmFeed = {
  key: "glm",
  label: "GLM / Z.ai",
  status: "ok",
  capturedAt: now,
  value: 42,
  total: 100,
  valueLabel: "42 / 100",
  detail: "额度与趋势已更新",
  levelLabel: "PRO",
  pct: 42,
  items: [
    { key: "glm-5h", label: "5小时额度", status: "ok", pct: 42, remainingLabel: "剩余 58%", resetLabel: "2小时后重置" },
    { key: "glm-mcp", label: "MCP额度", status: "ok", pct: 25, remainingLabel: "剩余 75%", resetLabel: "明日重置" },
  ],
  usageTrend: trend,
};

const localUsage = mergeLocalUsageSnapshot(null, [
  { date: today, tool: "codex", model: "gpt", input: 920000000, output: 80000000, cache_read: 160000000, cache_write: 40000000 },
  { date: today, tool: "claude-code", model: "claude", input: 210000000, output: 30000000, cache_read: 50000000, cache_write: 10000000 },
], { date: today, source: "preview", replace: true, updatedAt: now });

setState({
  schemaVersion: 3,
  upstreamUrl,
  accountKey,
  localUsage,
  glmActiveFingerprint: "fixture",
  glmSnapshots: { fixture: glmFeed },
  leaderboard: unmatched ? {
    updatedAt: now,
    accountKey,
    board: "total",
    range: "today",
    leaderboardMatched: false,
    entriesCount: 200,
    error: "请选择公开榜单账号",
    cities: [{ city: "杭州", count: 123, group: "华东" }],
  } : {
    updatedAt: now,
    accountKey,
    board: "total",
    range: "today",
    leaderboardMatched: true,
    entriesCount: 200,
    own: {
      userId: "fixture-user",
      name: "本机测试账号",
      rank: 17,
      score: 568854063,
      byTool: { codex: 420000000, "claude-code": 100000000, hermes: 30000000, openclaw: 18854063 },
    },
    previous: { name: "上一名", rank: 16, score: 570000000 },
    next: { name: "下一名", rank: 18, score: 560000000 },
    gapToPrevious: 1145938,
    leadOverNext: 8854063,
    myCity: "杭州",
    cityRank: 8,
    cityStats: { total: 17652727818, users: 123 },
    cities: [{ city: "杭州", count: 123, group: "华东" }],
  },
  ...(unmatched ? {} : { userId: "fixture-user" }),
  manualUpload: { id: "fixture", status: "succeeded", startedAt: now, finishedAt: now, detail: "SCYS 已确认接收" },
  lastUpload: {
    operationId: "fixture",
    accountKey,
    sequence: 1,
    capturedAt: now,
    path: "/tokenrank/api/subapp/u/<account>",
    payloadHash: "fixture",
    payloadKind: "usage-v1",
    summary: localUsage.summary,
    upstream: { accountKey, status: 200, ok: true, accepted: 1 },
  },
});

const port = Number(process.env.OPENTOKEN_ISLAND_PORT || 4199);
server.listen(port, "127.0.0.1", () => {
  console.log(`GUI fixture at http://127.0.0.1:${port}/popover.html`);
});
