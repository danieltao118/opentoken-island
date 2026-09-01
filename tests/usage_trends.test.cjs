const assert = require("assert");
const path = require("path");

const {
  buildZaiQuotaFeed,
  buildZaiUsageTrend,
  decryptElectronV10Payload,
  emptyZaiUsageTrend,
  normalizeZaiHistoryTime,
  retainLeaderboardSnapshot,
  retainLastGoodClaudeUsage,
  retainLastGoodZaiQuota,
  selectZaiQuotaSnapshot,
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
assert.equal(trend.history24h.bars.length, 24, "24h must always expose 24 hourly buckets");
assert.equal(trend.history7d.bars.length, 7, "7d must always expose seven daily buckets");
assert.equal(trend.history30d.bars.length, 30, "30d must expose thirty daily buckets without two-day compaction");

const isoHourly = usageResponse([
  [`${localDay(0)}T08:00:00`, 200],
]);
assert.equal(
  buildZaiUsageTrend(isoHourly, month).history24h.total,
  200,
  "ISO-T timestamps must remain hourly instead of being truncated to a date",
);

function expectedLocalHour(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}`;
}
assert.equal(
  normalizeZaiHistoryTime("2026-07-28T08:00:00Z"),
  expectedLocalHour("2026-07-28T08:00:00Z"),
  "timezone-aware points must be converted instead of silently dropping the offset",
);
assert.equal(
  normalizeZaiHistoryTime("2026-07-28T08:00:00+08:00"),
  expectedLocalHour("2026-07-28T08:00:00+08:00"),
);
assert.equal(normalizeZaiHistoryTime("2026-13-99T25:00:00"), "", "invalid calendar timestamps must be rejected");

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

const quotaIndependent = buildZaiQuotaFeed(
  { label: "test-account" },
  { ok: false, error: "quota endpoint unavailable" },
  hourly,
  month,
);
assert.equal(quotaIndependent.status, "partial", "quota failure must not hide valid GLM trends");
assert.equal(quotaIndependent.usageTrend.history24h.status, "ok");
assert.equal(quotaIndependent.usageTrend.history30d.status, "ok");

const quotaAuthPartial = buildZaiQuotaFeed(
  { label: "test-account" },
  { ok: false, status: 401, json: { msg: "401 unauthorized" } },
  { ok: false, error: "temporary usage timeout" },
  month,
);
assert.equal(quotaAuthPartial.quotaReason, "auth");
assert.equal(quotaAuthPartial.trendReason, "read");

const authBusinessCode = buildZaiQuotaFeed(
  { label: "env" },
  { ok: true, status: 200, json: { code: 1000, msg: "Authentication Failed" } },
  { ok: true, status: 200, json: { code: 1000, msg: "Authentication Failed" } },
  { ok: true, status: 200, json: { code: 1000, msg: "Authentication Failed" } },
);
assert.equal(
  authBusinessCode.quotaReason,
  "auth",
  "HTTP 200 + Authentication Failed must be treated as an invalid Z.ai key",
);

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
assert.equal(validZero.history24h.bars.length, 24, "valid zero usage still needs chart buckets");
assert.equal(validZero.history30d.bars.length, 30, "valid zero 30d usage must not render as missing data");

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
  capturedAt: new Date().toISOString(),
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

const neverSuccessful24h = retainLastGoodZaiQuota(
  { key: "glm", status: "error", detail: "all endpoints failed", usageTrend: emptyZaiUsageTrend("read") },
  {
    key: "glm",
    status: "partial",
    capturedAt: new Date().toISOString(),
    usageTrend: partial,
  },
);
assert.equal(neverSuccessful24h.usageTrend.history24h.status, "error", "a never-successful period must not be mislabeled stale");
assert.equal(neverSuccessful24h.usageTrend.history7d.status, "stale", "a previously successful period may use bounded stale fallback");

const expiredAt = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
const expiredTrend = {
  ...trend,
  history24h: { ...trend.history24h, capturedAt: expiredAt },
  history1d: { ...trend.history1d, capturedAt: expiredAt },
  history7d: { ...trend.history7d, capturedAt: expiredAt },
  history30d: { ...trend.history30d, capturedAt: expiredAt },
  periods: trend.periods.map((period) => ({ ...period, capturedAt: expiredAt })),
};
const expired = retainLastGoodZaiQuota(
  { key: "glm", status: "error", detail: "temporary failure", usageTrend: emptyZaiUsageTrend("read") },
  { ...lastGood, capturedAt: expiredAt, usageTrend: expiredTrend },
);
assert.equal(expired.status, "expired", "GLM fallback must stop after twelve hours");
assert.ok(expired.usageTrend.periods.every((period) => period.status === "expired"));
assert.equal(expired.expiredAt, expiredAt, "expired UI metadata must point to the last successful snapshot");

const mixedFreshness = retainLastGoodZaiQuota(
  { key: "glm", status: "partial", detail: "24h failed", usageTrend: partial },
  { ...lastGood, usageTrend: expiredTrend },
);
assert.equal(mixedFreshness.usageTrend.history24h.status, "expired", "fresh 7d data must not renew an expired 24h window");
assert.equal(mixedFreshness.usageTrend.history7d.status, "ok");

const quotaAuthRetained = retainLastGoodZaiQuota(quotaAuthPartial, lastGood);
assert.equal(quotaAuthRetained.usageTrend.history24h.status, "stale", "quota-only auth failure must not suppress a valid 24h fallback");
assert.equal(quotaAuthRetained.usageTrend.history7d.status, "ok");

const lastGoodWithQuotaBars = {
  ...lastGood,
  items: [{
    key: "glm-5h",
    label: "5小时额度",
    status: "ok",
    remainingLabel: "剩余 80%",
    pct: 20,
  }],
};
const quotaReadFail = {
  key: "glm",
  status: "error",
  reason: "read",
  quotaReason: "read",
  detail: "Z.ai 接口暂不可用",
  items: [{
    key: "glm-5h",
    label: "5小时额度",
    status: "error",
    remainingLabel: "--",
    pct: 4,
  }],
  usageTrend: emptyZaiUsageTrend("read"),
};
const retainedQuotaBars = retainLastGoodZaiQuota(quotaReadFail, lastGoodWithQuotaBars);
assert.equal(
  retainedQuotaBars.items.find((item) => item.key === "glm-5h")?.remainingLabel,
  "剩余 80%",
  "transient quota-limit failures must keep the last successful 5-hour bar",
);

assert.equal(typeof decryptElectronV10Payload, "function", "must export decryptElectronV10Payload");
{
  const crypto = require("crypto");
  const key = Buffer.alloc(32, 7);
  const iv = Buffer.alloc(12, 3);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("plain-z.ai-key", "utf8"), cipher.final()]);
  const payload = Buffer.concat([Buffer.from("v10"), iv, ciphertext, cipher.getAuthTag()]);
  assert.equal(decryptElectronV10Payload(key, payload), "plain-z.ai-key");
  assert.equal(decryptElectronV10Payload(key, Buffer.from("enc:nope")), "");
}

const accountA = { ...lastGood, label: "account-a" };
const accountB = { ...lastGood, label: "account-b" };
assert.equal(
  selectZaiQuotaSnapshot("fingerprint-a", { fingerprint: "fingerprint-b", zai: accountB }, { "fingerprint-a": accountA }).label,
  "account-a",
  "GLM hot-path reads must stay within the current account fingerprint",
);
assert.equal(selectZaiQuotaSnapshot("not-connected", {}, {}).reason, "not-connected");
const expiredCache = selectZaiQuotaSnapshot(
  "fingerprint-a",
  { fingerprint: "fingerprint-a", zai: { ...lastGood, capturedAt: expiredAt, usageTrend: expiredTrend } },
  {},
);
assert.equal(expiredCache.status, "expired", "a matching in-memory cache must still obey the twelve-hour hard limit");
assert.ok(expiredCache.usageTrend.periods.every((period) => period.status === "expired"));

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
