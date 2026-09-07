const assert = require("assert");
const path = require("path");

const server = require(path.resolve(__dirname, "..", "server.js"));
const {
  buildCodexQuotaFeed,
  buildCursorQuotaFeed,
  buildGrokQuotaFeed,
  buildKimiQuotaFeed,
  kimiQuotaUnavailable,
  kimiWindowMeta,
  loadKimiCodingAuth,
  resolveConfiguredSecret,
  codexQuotaUnavailable,
  cursorQuotaUnavailable,
  grokQuotaUnavailable,
  selectCodexCliAuth,
  selectGrokCliAuth,
} = server;

assert.equal(typeof buildCodexQuotaFeed, "function", "must export buildCodexQuotaFeed");
assert.equal(typeof selectCodexCliAuth, "function", "must export selectCodexCliAuth");
assert.equal(typeof codexQuotaUnavailable, "function", "must export codexQuotaUnavailable");

assert.equal(typeof buildCursorQuotaFeed, "function", "must export buildCursorQuotaFeed");
assert.equal(typeof buildGrokQuotaFeed, "function", "must export buildGrokQuotaFeed");
assert.equal(typeof selectGrokCliAuth, "function", "must export selectGrokCliAuth");
assert.equal(typeof cursorQuotaUnavailable, "function", "must export cursorQuotaUnavailable");
assert.equal(typeof grokQuotaUnavailable, "function", "must export grokQuotaUnavailable");
assert.equal(typeof buildKimiQuotaFeed, "function", "must export buildKimiQuotaFeed");
assert.equal(typeof kimiQuotaUnavailable, "function", "must export kimiQuotaUnavailable");
assert.equal(typeof loadKimiCodingAuth, "function", "must export loadKimiCodingAuth");

const cursorUsage = {
  billingCycleStart: "1768399334000",
  billingCycleEnd: "1771077734000",
  planUsage: {
    totalSpend: 23222,
    includedSpend: 23222,
    bonusSpend: 0,
    remaining: 16778,
    limit: 40000,
    totalPercentUsed: 58.055,
  },
  spendLimitUsage: {
    totalSpend: 0,
    individualLimit: 10000,
    individualUsed: 0,
    individualRemaining: 10000,
    limitType: "user",
  },
};

const cursorFeed = buildCursorQuotaFeed(cursorUsage, { planInfo: { planName: "Ultra" } });
assert.equal(cursorFeed.key, "cursor");
assert.equal(cursorFeed.status, "ok");
assert.equal(cursorFeed.levelLabel, "ULTRA");
assert.match(cursorFeed.valueLabel, /\$232\.22/);
assert.match(cursorFeed.valueLabel, /\$400\.00/);
assert.doesNotMatch(cursorFeed.valueLabel, /亿|万/, "Cursor spend is USD, not OpenToken 亿/万");
assert.equal(cursorFeed.items.length, 2);

const included = cursorFeed.items.find((item) => item.key === "cursor-included");
assert.ok(included, "Cursor card must expose the included plan spend row");
assert.equal(included.label, "套餐额度");
assert.equal(included.remainingLabel, "剩余 42%");
assert.equal(included.pct, 58);
assert.match(included.valueLabel, /\$232\.22 \/ \$400\.00/);
assert.match(included.resetLabel, /重置/);
assert.doesNotMatch(included.detail, /Token|token|亿|万/);

const onDemand = cursorFeed.items.find((item) => item.key === "cursor-ondemand");
assert.ok(onDemand, "Cursor card must expose the on-demand row when a spend cap exists");
assert.equal(onDemand.label, "按量超额");
assert.equal(onDemand.remainingLabel, "剩余 100%");
assert.match(onDemand.valueLabel, /\$0\.00 \/ \$100\.00/);

const ultraUsage = {
  billingCycleEnd: "1789568597000",
  planUsage: {
    totalSpend: 32361,
    includedSpend: 32361,
    remaining: 7639,
    limit: 40000,
    autoPercentUsed: 8.490499999999999,
    apiPercentUsed: 30.759999999999998,
    totalPercentUsed: 12.9444,
  },
  spendLimitUsage: { limitType: "user" },
};
const ultraFeed = buildCursorQuotaFeed(ultraUsage, { planInfo: { planName: "Ultra" } });
assert.equal(ultraFeed.levelLabel, "ULTRA");
const cursorModels = ultraFeed.items.find((item) => item.key === "cursor-models");
const otherModels = ultraFeed.items.find((item) => item.key === "cursor-api");
assert.ok(cursorModels, "Ultra must expose the Cursor Models pool");
assert.ok(otherModels, "Ultra must expose the Other Models pool");
assert.equal(cursorModels.label, "Cursor 模型");
assert.equal(otherModels.label, "其他模型");
assert.equal(cursorModels.usedLabel, "已用 8%");
assert.equal(cursorModels.remainingLabel, "剩余 92%");
assert.equal(cursorModels.pct, 8);
assert.match(cursorModels.detail, /Grok|Composer/);
// apiPercentUsed 与 Cursor 仪表盘口径相反（仪表盘已用 = 100 - apiPercentUsed，2026-09-01 实测）。
assert.equal(otherModels.usedLabel, "已用 69%");
assert.equal(otherModels.remainingLabel, "剩余 31%");
assert.equal(otherModels.pct, 69);
assert.match(otherModels.detail, /\$400/);
assert.doesNotMatch(ultraFeed.detail, /\$323|\$321/);
assert.match(ultraFeed.detail, /重置/);
assert.doesNotMatch(cursorModels.valueLabel || "", /\$321|\$323/);
assert.doesNotMatch(otherModels.valueLabel || "", /\$323\.61 \/ \$400\.00/, "Other Models bar is apiPercentUsed, not includedSpend/limit");
assert.equal(
  Boolean(ultraFeed.items.find((item) => item.key === "cursor-included")),
  false,
  "dashboard-aligned Ultra cards must not collapse both pools into one dollar bar",
);

const noPlan = buildCursorQuotaFeed({ enabled: true });
assert.equal(noPlan.key, "cursor");
assert.equal(noPlan.status, "error");
assert.equal(noPlan.reason, "read");

const missingCursor = cursorQuotaUnavailable("not-connected");
assert.equal(missingCursor.key, "cursor");
assert.match(missingCursor.detail, /Cursor/);
assert.doesNotMatch(missingCursor.detail, /Coding Quota Bar|Z\.ai|智谱/);
const authCursor = cursorQuotaUnavailable("auth");
assert.match(authCursor.detail, /登录/);

const grokCredits = {
  config: {
    creditUsagePercent: 63.2,
    currentPeriod: { end: "2026-08-25T00:00:00.000Z" },
    billingPeriodEnd: "2026-09-01T00:00:00.000Z",
    monthlyLimit: { val: 99900 },
    used: { val: 63137 },
    onDemandCap: { val: 5000 },
    onDemandUsed: { val: 250 },
  },
};
const grokFeed = buildGrokQuotaFeed(grokCredits, { subscription_tier_display: "SuperGrok" });
assert.equal(grokFeed.key, "grok");
assert.equal(grokFeed.status, "ok");
assert.equal(grokFeed.levelLabel, "SUPERGROK");
const period = grokFeed.items.find((item) => item.key === "grok-period");
assert.ok(period, "Grok card must expose the billing-period credit row");
assert.equal(period.label, "周期额度");
assert.equal(period.remainingLabel, "剩余 37%");
assert.equal(period.pct, 63);
assert.match(period.resetLabel, /08-25/);
assert.doesNotMatch(period.detail, /Cursor|OpenToken|亿|万/);
assert.equal(grokFeed.items.length, 1, "Grok card should show only the SuperGrok period bar");
assert.equal(
  grokFeed.items.some((item) => item.key === "grok-extra" || item.label === "额外积分"),
  false,
  "Grok has no extra-credits row",
);

const acpFeed = buildGrokQuotaFeed({
  billingCycle: { billingPeriodEnd: "2026-09-01T00:00:00.000Z" },
  monthlyLimit: { val: 1000 },
  usage: { totalUsed: { val: 250 }, onDemandUsed: { val: 0 } },
  onDemandCap: { val: 0 },
});
const acpPeriod = acpFeed.items.find((item) => item.key === "grok-period");
assert.equal(acpPeriod.remainingLabel, "剩余 75%");
assert.equal(acpPeriod.pct, 25);

const grokMissing = grokQuotaUnavailable("not-connected");
assert.equal(grokMissing.key, "grok");
assert.match(grokMissing.detail, /grok login|Grok CLI/i);
assert.doesNotMatch(grokMissing.detail, /Coding Quota Bar|Z\.ai/);

const now = Date.parse("2026-08-18T00:00:00.000Z");
const selected = selectGrokCliAuth({
  "https://accounts.x.ai/sign-in": {
    key: "legacy-token",
    refresh_token: "legacy-refresh",
    expires_at: "2026-08-20T00:00:00.000Z",
    email: "hidden@example.com",
    user_id: "legacy-user",
  },
  "https://auth.x.ai::openid": {
    key: "oidc-token",
    refresh_token: "oidc-refresh",
    expires_at: "2026-08-24T00:00:00.000Z",
    auth_mode: "oidc",
    email: "hidden@example.com",
    user_id: "user-42",
    team_id: "team-1",
  },
}, now);
assert.equal(selected.bearer, "oidc-token");
assert.equal(selected.expired, false);
assert.ok(selected.fingerprint);
assert.equal(selected.email, undefined);
assert.equal(selected.refresh_token, undefined);

const expired = selectGrokCliAuth({
  "https://auth.x.ai::openid": {
    key: "old-token",
    expires_at: "2026-08-01T00:00:00.000Z",
    user_id: "user-42",
  },
}, now);
assert.equal(expired.expired, true);
assert.equal(selectGrokCliAuth(null), null);
assert.equal(selectGrokCliAuth({}), null);

const weeklyOnly = buildCodexQuotaFeed({
  plan_type: "pro",
  rate_limit: {
    primary_window: {
      used_percent: 83,
      limit_window_seconds: 604800,
      reset_at: 1787196888,
    },
    secondary_window: null,
  },
  credits: { has_credits: false, balance: 0 },
  email: "hidden@example.com",
});
assert.equal(weeklyOnly.key, "codex");
assert.equal(weeklyOnly.status, "ok");
assert.equal(weeklyOnly.levelLabel, "PRO");
assert.equal(weeklyOnly.items.length, 1, "when Codex only returns the weekly window, do not invent a 5-hour row");
const weekly = weeklyOnly.items.find((item) => item.key === "codex-weekly");
assert.ok(weekly);
assert.equal(weekly.label, "周额度");
assert.equal(weekly.remainingLabel, "剩余 17%");
assert.equal(weekly.pct, 83);
assert.match(weekly.resetLabel, /重置/);
assert.doesNotMatch(weekly.detail, /亿|万|OpenToken/);
assert.doesNotMatch(JSON.stringify(weeklyOnly), /hidden@example.com/);

const bothWindows = buildCodexQuotaFeed({
  plan_type: "plus",
  rate_limit: {
    primary_window: { used_percent: 15, reset_at: 1735401600, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 5, reset_at: 1735920000, limit_window_seconds: 604800 },
  },
});
assert.equal(bothWindows.items.length, 2);
assert.equal(bothWindows.items.find((item) => item.key === "codex-5h")?.label, "5小时额度");
assert.equal(bothWindows.items.find((item) => item.key === "codex-5h")?.remainingLabel, "剩余 85%");
assert.equal(bothWindows.items.find((item) => item.key === "codex-weekly")?.remainingLabel, "剩余 95%");

const missingCodex = codexQuotaUnavailable("not-connected");
assert.equal(missingCodex.key, "codex");
assert.match(missingCodex.detail, /codex auth login|Codex CLI/i);
assert.doesNotMatch(missingCodex.detail, /Coding Quota Bar|Z\.ai/);

const selectedCodex = selectCodexCliAuth({
  tokens: {
    access_token: "codex-access",
    account_id: "acct-1",
    refresh_token: "codex-refresh",
    id_token: "codex-id",
  },
  last_refresh: "2026-08-18T00:00:00.000Z",
});
assert.equal(selectedCodex.bearer, "codex-access");
assert.equal(selectedCodex.accountId, "acct-1");
assert.ok(selectedCodex.fingerprint);
assert.equal(selectedCodex.refresh_token, undefined);
assert.equal(selectCodexCliAuth(null), null);
assert.equal(selectCodexCliAuth({ tokens: {} }), null);

// Kimi 编程套餐：只有套餐占比，没有绝对 token 数。
assert.equal(kimiWindowMeta({ duration: 300, timeUnit: "TIME_UNIT_MINUTE" }).key, "kimi-5h");
assert.equal(kimiWindowMeta({ duration: 5, timeUnit: "TIME_UNIT_HOUR" }).key, "kimi-5h");
assert.equal(kimiWindowMeta({ duration: 7, timeUnit: "TIME_UNIT_DAY" }).key, "kimi-weekly");

const kimiFeed = buildKimiQuotaFeed({
  user: { membership: { level: "LEVEL_INTERMEDIATE" } },
  usage: { limit: "100", remaining: "40", resetTime: "2026-08-27T04:08:48Z" },
  limits: [{
    window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
    detail: { limit: "100", remaining: "75", resetTime: "2026-08-21T05:08:48Z" },
  }],
  parallel: { limit: "20" },
});
assert.equal(kimiFeed.key, "kimi");
assert.equal(kimiFeed.status, "ok");
assert.equal(kimiFeed.levelLabel, "INTERMEDIATE");
assert.equal(kimiFeed.items.find((item) => item.key === "kimi-5h")?.remainingLabel, "剩余 75%");
assert.equal(kimiFeed.items.find((item) => item.key === "kimi-weekly")?.remainingLabel, "剩余 40%");
assert.equal(kimiFeed.items.find((item) => item.key === "kimi-5h")?.total, 100);
assert.match(kimiFeed.detail, /并行 20/);

// 全新的 5 小时窗口只回 window、不回配额，这时不能凭空造一条 0%。
const kimiFresh = buildKimiQuotaFeed({
  usage: { limit: "100", remaining: "100", resetTime: "2026-08-27T04:08:48Z" },
  limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" } }],
});
assert.equal(kimiFresh.items.length, 1);
assert.equal(kimiFresh.items[0].key, "kimi-weekly");
assert.equal(kimiFresh.items[0].remainingLabel, "剩余 100%");

assert.equal(buildKimiQuotaFeed({}).status, "error");
assert.equal(buildKimiQuotaFeed({}).reason, "read");
const kimiMissing = kimiQuotaUnavailable("not-connected");
assert.equal(kimiMissing.key, "kimi");
assert.equal(kimiMissing.items.length, 2);
assert.match(kimiMissing.detail, /OpenCodex/);

const kimiSource = require("fs").readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
assert.ok(
  kimiSource.includes("https://api.kimi.com/coding/v1/usages"),
  "Kimi quota must come from the official coding usages endpoint"
);
assert.ok(
  !/logIslandEvent\([^)]*apiKey/.test(kimiSource),
  "the Kimi key must never reach the event log"
);

assert.ok(
  kimiSource.includes("zai quota refresh failed"),
  "GLM quota failures must be logged like the other providers"
);

// OpenCodex 会把密钥换成 ${ENV_VAR} 占位符；原样发出去只会拿到 401。
process.env.ISLAND_TEST_KIMI_SECRET = "resolved-secret";
assert.equal(resolveConfiguredSecret("sk-plain"), "sk-plain");
assert.equal(resolveConfiguredSecret("  sk-padded  "), "sk-padded");
assert.equal(resolveConfiguredSecret("${ISLAND_TEST_KIMI_SECRET}"), "resolved-secret");
assert.equal(resolveConfiguredSecret(undefined), "");
assert.ok(
  kimiSource.includes('apiKey.startsWith("${")'),
  "an unresolved placeholder must count as not-configured, never as a bearer token"
);

console.log("quota providers ok");
