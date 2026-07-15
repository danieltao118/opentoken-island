// 防回归测试：直接驱动 buildSummary，验证「实际消耗」主数口径。
//
// 背景：commit e2873fb 引入 useLeaderboardForMain = hasLeaderboardScore && !boardIsBehind。
// 因 raw token(含 cache_read，~15.72亿) 与公开榜单分(~5.61亿) 口径不同源，
// leaderboardBehindUsage 的 score < usageTotal 恒为 true → boardIsBehind 恒 true
// → useLeaderboardForMain 恒 false → actualTotal 永远走 raw 分支，主数钉死且永不更新。
//
// 修复后：useLeaderboardForMain = hasLeaderboardScore，主数始终对齐已匹配的公开榜单分。
// 本测试构造「今日榜单已匹配 + 存在更大 raw 上传快照」的场景，锁定主数 = 榜单分。
const assert = require("assert");
const path = require("path");

const { buildSummary, setState, localDateString } = require(path.resolve(__dirname, "..", "server.js"));

(async () => {
  const today = localDateString();
  const nowIso = new Date().toISOString();

  // 场景：今日榜单已匹配 own(榜单分 5.61亿)，同时存在 raw 15.72亿 的 lastUpload 快照
  setState({
    leaderboard: {
      updatedAt: nowIso,
      leaderboardMatched: true,
      entriesCount: 100,
      own: { score: 560854063, rank: 17, byTool: { codex: 500000000, "claude-code": 60854063 } },
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

  // 核心断言：主数对齐榜单分
  assert.equal(summary.source, "leaderboard", `source 应为 leaderboard，实际=${summary.source}`);
  assert.equal(summary.actualTotal, 560854063, `actualTotal 应对齐榜单分 560854063，实际=${summary.actualTotal}`);
  assert.equal(summary.actualTotal, summary.leaderboardTotal, "actualTotal 应等于 leaderboardTotal");
  assert.notEqual(summary.actualTotal, 1571758301, "actualTotal 不应仍是 raw 15.72亿（e2873fb 死循环回归）");

  console.log(`build summary ok: actualTotal=${summary.actualTotal}（对齐榜单分 ${summary.actualTotalLabel}）`);
})().catch((err) => {
  console.error("build summary test FAILED:", err.message);
  process.exit(1);
});
