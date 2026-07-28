const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "opentoken-leaderboard-binding-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.APPDATA = path.join(testHome, "AppData", "Roaming");

const {
  accountKeyForUpstreamUrl,
  cacheLeaderboardCandidates,
  getState,
  server,
  setState,
} = require(path.resolve(__dirname, "..", "server.js"));

(async () => {
  const upstreamUrl = "https://scys.com/tokenrank/api/subapp/u/binding-test";
  const accountKey = accountKeyForUpstreamUrl(upstreamUrl);
  setState({ schemaVersion: 3, upstreamUrl, accountKey });
  const entries = [
    { userId: "public-a", name: "账号 A", city: "杭州", rank: 7, score: 700, byTool: { hermes: 400, openclaw: 300 } },
    { userId: "public-b", name: "账号 B", city: "上海", rank: 8, score: 650, byTool: { codex: 650 } },
  ];
  const metadata = { board: "total", range: "today", cities: [{ city: "杭州", count: 10, group: "华东" }] };
  cacheLeaderboardCandidates(entries, metadata, accountKey, Date.now() - 6 * 60 * 1000);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const expired = await fetch(`${base}/api/leaderboard-bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "public-a" }),
    });
    assert.equal(expired.status, 409, "an expired public candidate cache must not bind identity");

    cacheLeaderboardCandidates(entries, metadata, accountKey);
    const bound = await fetch(`${base}/api/leaderboard-bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "public-a" }),
    });
    const body = await bound.json();
    assert.equal(bound.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.leaderboard.matched, true);
    assert.equal(getState().userId, "public-a");
    assert.equal(getState().leaderboard.own.byTool.hermes, 400);
    assert.equal(getState().leaderboardNeedsRefresh, true, "city/network refresh should be deferred to the coordinator");

    const cached = await fetch(`${base}/api/leaderboard-candidates?refresh=1`);
    const cachedBody = await cached.json();
    assert.equal(cached.status, 200);
    assert.equal(cachedBody.selectedUserId, "public-a");
    assert.equal(cachedBody.entries.length, 2, "candidate GET must remain a pure cache read even with refresh=1");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  console.log("leaderboard binding API contract ok");
  fs.rmSync(testHome, { recursive: true, force: true });
})().catch((error) => {
  console.error("leaderboard binding test FAILED:", error.message);
  fs.rmSync(testHome, { recursive: true, force: true });
  process.exit(1);
});
