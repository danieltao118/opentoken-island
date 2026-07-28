// 防回归测试：直接驱动 buildSummary，验证「实际消耗」与「榜单分」分开返回。
//
// 背景：commit e2873fb 引入 useLeaderboardForMain = hasLeaderboardScore && !boardIsBehind。
// 因 raw token(含 cache_read，~15.72亿) 与公开榜单分(~5.61亿) 口径不同源，
// leaderboardBehindUsage 的 score < usageTotal 恒为 true → boardIsBehind 恒 true
// → useLeaderboardForMain 恒 false → actualTotal 永远走 raw 分支，主数钉死且永不更新。
//
// 修复后：实际消耗始终是原始 Token；榜单分和排名使用排行榜口径，不能混用。
const assert = require("assert");
const path = require("path");

const { accountKeyForUpstreamUrl, buildSummary, getState, setState, localDateString } = require(path.resolve(__dirname, "..", "server.js"));

(async () => {
  const today = localDateString();
  const nowIso = new Date().toISOString();
  const upstreamUrl = "https://scys.com/tokenrank/api/subapp/u/build-summary-test";
  const accountKey = accountKeyForUpstreamUrl(upstreamUrl);

  // 场景：今日榜单已匹配 own(榜单分 5.68亿)，同时存在本机 raw 15.72亿 快照。
  setState({
    upstreamUrl,
    accountKey,
    localUsage: {
      schemaVersion: 1,
      date: today,
      source: "preview",
      completeness: "full",
      updatedAt: nowIso,
      rows: [
        { date: today, tool: "codex", model: "gpt", input: 1390654119 },
        { date: today, tool: "claude-code", model: "claude", input: 181104182 },
      ],
      summary: {
        date: today,
        total: 1571758301,
        rowCount: 2,
        byTool: { codex: 1390654119, "claude-code": 181104182 },
        normalizedByTool: { codex: 50000000, "claude-code": 19668317 },
      },
    },
    leaderboard: {
      updatedAt: nowIso,
      accountKey,
      leaderboardMatched: true,
      entriesCount: 100,
      own: {
        score: 568854063,
        rank: 17,
        byTool: { codex: 500000000, "claude-code": 60854063, hermes: 3000000, openclaw: 5000000 },
      },
      myCity: "杭州",
      myRank: 8,
      cityRank: 8,
      city: "杭州",
      cityStats: { total: 17652727818, users: 123 },
      cities: [{ city: "杭州", count: 123, group: "华东" }],
    },
    lastUpload: {
      capturedAt: nowIso,
      operationId: "usage-test",
      accountKey,
      summary: {
        date: today,
        total: 1571758301,
        rowCount: 2,
        byTool: { codex: 1390654119, "claude-code": 181104182 },
        normalizedByTool: { codex: 50000000, "claude-code": 19668317 },
      },
      payload: {},
      upstream: { operationId: "usage-test", accountKey, ok: true, status: 200, accepted: 1 },
    },
  });

  const summary = await Promise.race([
    buildSummary(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("buildSummary 超时（quotaFeeds 网络可能不通）")), 25000),
    ),
  ]);

  // 核心断言：本机 actual/raw 与 SCYS 榜单分是两个独立领域。
  assert.equal(summary.source, "preview", `顶层 source 应跟随本机统计，实际=${summary.source}`);
  assert.equal(summary.actualTotal, 1571758301, `actualTotal 只能是本机原始值，实际=${summary.actualTotal}`);
  assert.equal(summary.leaderboardTotal, 568854063, "leaderboardTotal 应保留榜单分");
  assert.notEqual(summary.actualTotal, summary.leaderboardTotal, "实际消耗不得被榜单分覆盖");
  assert.equal(summary.usageScope, "local", "本机 actual 口径必须固定为 local");
  assert.equal(summary.overallUsage.scope, "local");
  assert.equal(summary.overallUsage.total, 1571758301);
  assert.equal(summary.tools.some((tool) => tool.name === "hermes"), false, "榜单 Hermes 不得混入本机工具");
  assert.equal(summary.tools.some((tool) => tool.name === "openclaw"), false, "榜单 OpenClaw 不得混入本机工具");
  assert.equal(summary.leaderboard.tools.find((tool) => tool.name === "hermes")?.score, 3000000, "榜单区应显示其他电脑的 Hermes");
  assert.equal(summary.leaderboard.tools.find((tool) => tool.name === "openclaw")?.score, 5000000, "榜单区应显示其他电脑的 OpenClaw");
  assert.equal(
    summary.tools.reduce((sum, tool) => sum + Number(tool.value || 0), 0),
    summary.actualTotal,
    "本机工具行之和必须等于本机实际总量",
  );
  assert.equal(summary.leaderboard.score, 568854063);
  assert.equal(summary.leaderboard.rank, 17);
  assert.equal(summary.leaderboard.city.name, "杭州");
  assert.equal(summary.leaderboard.city.rank, 8);
  assert.equal(summary.leaderboard.city.totalScore, 17652727818);
  assert.equal(summary.leaderboard.city.users, 123);
  assert.equal(summary.leaderboard.cityDirectory[0].members, 123, "cities.count 只能表示参与人数");
  assert.deepEqual(summary.glm.trends.periods.map((period) => period.key), ["24h", "7d", "30d"]);

  const firstState = getState();
  setState({
    ...firstState,
    leaderboard: null,
    lastUpload: {
      ...firstState.lastUpload,
      upstream: { operationId: firstState.lastUpload.operationId, ok: false, status: 502 },
    },
    lastActivityUpload: {
      operationId: "activity-only",
      payloadKind: "activity-v2",
      upstream: { operationId: "activity-only", ok: true, status: 200 },
    },
  });
  const activityOnly = await buildSummary();
  assert.equal(activityOnly.sync.uploaded, false, "an activity heartbeat ack must never masquerade as a usage upload ack");

  console.log(`build summary domains ok: local=${summary.actualTotal}，leaderboard=${summary.leaderboardTotal}`);
})().catch((err) => {
  console.error("build summary test FAILED:", err.message);
  process.exit(1);
});
