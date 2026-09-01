const assert = require("assert");
const path = require("path");

const {
  buildRankFacts,
  buildSyncStatus,
  leaderboardProjection,
  liveLeaderboardMatch,
  leaderboardSnapshotStale,
  setState,
} = require(path.resolve(__dirname, "..", "server.js"));

setState({
  lastUpload: {
    accountKey: "test",
    summary: { date: "2099-01-01", total: 1 },
    upstream: { accountKey: "test", ok: true, accepted: 1 },
  },
  accountKey: "test",
});

const staleBoard = {
  stale: true,
  leaderboardMatched: false,
  entriesCount: 200,
  cutoffRank: 200,
  cutoffScore: 172907569,
  error: "公开榜仅返回前 200 名（第200名 1.73亿），已绑定账号不在窗口内",
  own: { userId: "35859", name: "晓峰", rank: 87, score: 46150945, byTool: { cursor: 1 } },
  previous: { name: "汤生", rank: 86, score: 46375694 },
  gapToPrevious: 224750,
};

assert.equal(liveLeaderboardMatch(staleBoard), false, "retained own + stale must not count as a live match");
assert.equal(liveLeaderboardMatch({ ...staleBoard, stale: false, leaderboardMatched: true }), true);

const projected = leaderboardProjection(staleBoard, { accountConnected: true, boundUserId: "35859" });
assert.equal(projected.matched, false);
assert.equal(projected.rankLabel, "#--");
assert.equal(projected.rankCaption, "未进前200");
assert.equal(projected.scoreLabel, "--");
assert.equal(projected.previous, null);
assert.equal(projected.identity.status, "outside-public-window");
assert.match(projected.identity.detail, /公开榜仅返回前 200 名/);

const sync = buildSyncStatus({ date: "2099-01-01", total: 121209714 }, staleBoard);
assert.equal(sync.leaderboardMatched, false);
assert.equal(sync.status, "leaderboard-refreshing");
assert.match(sync.label, /未进公开榜/);

const facts = buildRankFacts({
  rank: projected.rank,
  previous: projected.previous,
  next: projected.next,
  gap: projected.gapToPrevious,
  lead: projected.leadOverNext,
  sync,
  leaderboardTotal: projected.score,
  city: projected.city,
});
assert.equal(facts.items[0].label, "实际 Token（本机）");
assert.equal(facts.items[0].valueLabel, "--");
assert.match(facts.items[0].detail, /仅这台电脑/);
assert.equal(facts.items[1].valueLabel, "--");
assert.doesNotMatch(facts.items[1].detail, /汤生/);

assert.equal(leaderboardSnapshotStale(null), true);
assert.equal(leaderboardSnapshotStale({}), true);
assert.equal(
  leaderboardSnapshotStale({ updatedAt: new Date(Date.now() - 61_000).toISOString() }, Date.now(), 60_000),
  true,
  "a public board snapshot older than the auto-refresh interval must be refetched",
);
assert.equal(
  leaderboardSnapshotStale({ updatedAt: new Date(Date.now() - 5_000).toISOString() }, Date.now(), 60_000),
  false,
  "a fresh public board snapshot must not be refetched every tick",
);

console.log("leaderboard window honesty ok");
