const assert = require("assert");
const path = require("path");

const {
  buildZaiUsageTrend,
  emptyZaiUsageTrend,
  mergeKnownToolUsage,
  retainLeaderboardSnapshot,
  retainLastGoodClaudeUsage,
  retainLastGoodZaiQuota,
  summarizeRows,
  uploadableClaudeRows,
  usageTrends,
} = require(path.resolve(__dirname, "..", "server.js"));

function usageResponse(points, total = null) {
  const x_time = points.map(([time]) => time);
  const tokensUsage = points.map(([, used]) => used);
  const sum = tokensUsage.reduce((value, used) => value + used, 0);
  return {
    ok: true,
    json: {
      code: 200,
      data: {
        x_time,
        tokensUsage,
        totalUsage: { totalTokensUsage: total == null ? sum : total },
      },
    },
  };
}

function localDay(offset) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const hourly = usageResponse([
  [`${localDay(-1)} 12:00:00`, 100],
  [`${localDay(0)} 08:00:00`, 200],
]);
const month = usageResponse(Array.from({ length: 10 }, (_, index) => [
  localDay(index - 9),
  (index + 1) * 1000,
]));

const trend = buildZaiUsageTrend(hourly, month);
assert.deepEqual(trend.periods.map((period) => period.key), ["24h", "7d", "30d"]);
assert.equal(trend.status, "ok");
assert.equal(trend.history24h.status, "ok");
assert.equal(trend.history7d.status, "ok");
assert.equal(trend.history30d.status, "ok");
assert.ok(trend.history7d.bars.length > 0, "7d should be derived from the valid 30d response");
assert.ok(
  trend.history7d.total < trend.history30d.total,
  "derived 7d total must not reuse the 30d aggregate total",
);
assert.equal(trend.history7d.total, 49000, "7d must include today and the six preceding local dates");

const monthWithDuplicates = usageResponse([
  [localDay(-7), 9999],
  [localDay(-6), 100],
  [localDay(-6), 200],
  [localDay(0), 300],
], 999999);
assert.equal(
  buildZaiUsageTrend(hourly, monthWithDuplicates).history7d.total,
  600,
  "7d must aggregate same-day points and ignore both older rows and the 30d response total",
);

const partial = buildZaiUsageTrend({ ok: false, error: "temporary" }, month);
assert.equal(partial.status, "partial");
assert.equal(partial.history24h.status, "error");
assert.equal(partial.history7d.status, "ok");
assert.equal(partial.history30d.status, "ok");

const invalidBusinessCode = buildZaiUsageTrend(
  { ok: true, json: { code: 500, data: { x_time: [], tokensUsage: [] } } },
  month,
);
assert.equal(invalidBusinessCode.history24h.status, "error", "HTTP success cannot hide a failed business code");

const mismatchedArrays = buildZaiUsageTrend(hourly, {
  ok: true,
  json: { code: 200, data: { x_time: [localDay(0)], tokensUsage: [] } },
});
assert.equal(mismatchedArrays.history30d.status, "error", "malformed point arrays must not be labeled ok");

const validZero = buildZaiUsageTrend(usageResponse([]), usageResponse([]));
assert.equal(validZero.status, "ok", "valid empty responses represent zero usage, not an API error");
assert.equal(validZero.history24h.totalLabel, "0");
assert.equal(validZero.history7d.totalLabel, "0");

const empty = emptyZaiUsageTrend("waiting");
assert.deepEqual(empty.periods.map((period) => period.key), ["24h", "7d", "30d"]);
assert.ok(empty.periods.every((period) => period.status === "waiting"));
assert.deepEqual(
  usageTrends([]).glm.periods.map((period) => period.key),
  ["24h", "7d", "30d"],
  "fallback schema must never hide the 24h tab",
);

const lastGood = {
  key: "glm",
  status: "ok",
  detail: "fresh quota",
  usageTrend: trend,
};
const stale = retainLastGoodZaiQuota(
  { key: "glm", status: "partial", detail: "temporary failure" },
  lastGood,
  "2026-07-27T00:00:00.000Z",
);
assert.equal(stale.status, "stale");
assert.equal(stale.usageTrend.periods[0].bars.length, trend.periods[0].bars.length);
assert.equal(stale.staleAt, "2026-07-27T00:00:00.000Z");
assert.match(stale.detail, /最近成功数据/);
assert.equal(retainLastGoodZaiQuota(lastGood, null), lastGood);
const authFailure = { key: "glm", status: "error", reason: "auth", detail: "key expired" };
assert.equal(
  retainLastGoodZaiQuota(authFailure, lastGood),
  authFailure,
  "authentication failures must not present old quota as current",
);

const claudeFresh = {
  at: 200,
  date: localDay(0),
  status: "error",
  rows: [],
  claudeValue: 0,
  error: "preview timeout",
};
const claudeLastGood = {
  at: 100,
  date: localDay(0),
  status: "ok",
  rows: [{ tool: "claude-code" }],
  claudeValue: 123456,
};
const claudeStale = retainLastGoodClaudeUsage(
  claudeFresh,
  claudeLastGood,
  "2026-07-27T00:00:00.000Z",
);
assert.equal(claudeStale.status, "stale");
assert.equal(claudeStale.claudeValue, 123456, "transient scans must not overwrite Claude usage with zero");
assert.equal(claudeStale.at, 200, "failed checks should use a short retry window from the latest attempt");
assert.equal(retainLastGoodClaudeUsage(claudeFresh, null), claudeFresh);

const previousDayOnly = summarizeRows([{
  date: localDay(-1),
  tool: "claude-code",
  input: 100,
  output: 20,
  cache_read: 1000,
}], localDay(0));
assert.equal(previousDayOnly.date, localDay(0));
assert.equal(previousDayOnly.rowCount, 0, "a strict daily summary must not borrow yesterday's rows");
assert.equal(previousDayOnly.total, 0, "cross-day fallback would make today's GUI total inaccurate");

const uploadRows = [{ date: localDay(0), tool: "claude-code", input: 900 }];
assert.deepEqual(
  uploadableClaudeRows({ status: "stale", rows: uploadRows }, localDay(0)),
  [],
  "stale GUI fallback rows must never replace a newer upload payload",
);
assert.deepEqual(
  uploadableClaudeRows({ status: "ok", rows: uploadRows }, localDay(0)),
  uploadRows,
  "only a successful current scan may supply authoritative upload rows",
);

const multiDevice = mergeKnownToolUsage(
  { codex: 1000, "claude-code": 500 },
  { codex: 900, "claude-code": 800, hermes: 300, openclaw: 200 },
);
assert.deepEqual(multiDevice.byTool, {
  codex: 1000,
  "claude-code": 800,
  hermes: 300,
  openclaw: 200,
});
assert.equal(multiDevice.sourceByTool.codex, "local", "a lagging leaderboard must not lower local usage");
assert.equal(multiDevice.sourceByTool["claude-code"], "leaderboard", "the larger multi-device value should win without addition");
assert.equal(multiDevice.sourceByTool.hermes, "leaderboard", "leaderboard-only agents must remain visible locally");
assert.equal(
  Object.values(multiDevice.byTool).reduce((sum, value) => sum + value, 0),
  2300,
  "same-tool values must use max rather than being double-counted",
);

const priorBoard = {
  updatedAt: new Date().toISOString(),
  leaderboardMatched: true,
  entriesCount: 500,
  own: { userId: "same-account", byTool: { hermes: 300, openclaw: 200 } },
};
const retainedBoard = retainLeaderboardSnapshot({
  updatedAt: new Date().toISOString(),
  leaderboardMatched: false,
  entriesCount: 100,
  error: "not returned",
}, priorBoard, localDay(0));
assert.equal(retainedBoard.stale, true);
assert.deepEqual(retainedBoard.own.byTool, priorBoard.own.byTool, "a transient leaderboard miss must not erase remote agents");
assert.equal(
  retainLeaderboardSnapshot({ leaderboardMatched: false }, { ...priorBoard, updatedAt: `${localDay(-1)}T12:00:00` }, localDay(0)).own,
  undefined,
  "previous-day leaderboard tools must not leak into today",
);

console.log("usage trend behavior ok");
