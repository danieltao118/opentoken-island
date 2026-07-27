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

const { buildSummary, setState, localDateString } = require(path.resolve(__dirname, "..", "server.js"));

(async () => {
  const today = localDateString();
  const nowIso = new Date().toISOString();

  // 场景：今日榜单已匹配 own(榜单分 5.61亿)，同时存在 raw 15.72亿 的 lastUpload 快照。
  setState({
    leaderboard: {
      updatedAt: nowIso,
      leaderboardMatched: true,
      entriesCount: 100,
      own: {
        score: 568854063,
        rank: 17,
        byTool: { codex: 500000000, "claude-code": 60854063, hermes: 3000000, openclaw: 5000000 },
      },
    },
    lastUpload: {
      capturedAt: nowIso,
      summary: {
        date: today,
        total: 1571758301,
        rowCount: 2,
        byTool: { codex: 1390654119, "claude-code": 181104182 },
        normalizedByTool: { codex: 50000000, "claude-code": 19668317 },
      },
      payload: {},
      upstream: { ok: true, status: 200, json: { accepted: 1 } },
    },
  });

  const summary = await Promise.race([
    buildSummary(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("buildSummary 超时（quotaFeeds 网络可能不通）")), 25000),
    ),
  ]);

  // 核心断言：实际消耗与榜单分分开，工具项可加总为实际消耗。
  assert.equal(summary.source, "leaderboard", `source 应为 leaderboard，实际=${summary.source}`);
  assert.equal(summary.actualTotal, 1579758301, `actualTotal 应为本机原始值加榜单独有工具且不重复，实际=${summary.actualTotal}`);
  assert.equal(summary.leaderboardTotal, 568854063, "leaderboardTotal 应保留榜单分");
  assert.notEqual(summary.actualTotal, summary.leaderboardTotal, "实际消耗不得被榜单分覆盖");
  assert.equal(summary.usageScope, "multi-device", "榜单匹配后应标记为多端已知汇总");
  assert.equal(summary.tools.find((tool) => tool.name === "hermes")?.value, 3000000, "本机 GUI 应显示其他电脑的 Hermes");
  assert.equal(summary.tools.find((tool) => tool.name === "openclaw")?.value, 5000000, "本机 GUI 应显示其他电脑的 OpenClaw");
  assert.equal(
    summary.tools.reduce((sum, tool) => sum + Number(tool.value || 0), 0),
    summary.actualTotal,
    "工具行之和必须等于多端实际总量",
  );

  console.log(`build summary ok: raw=${summary.actualTotal}，leaderboard=${summary.leaderboardTotal}`);
})().catch((err) => {
  console.error("build summary test FAILED:", err.message);
  process.exit(1);
});
