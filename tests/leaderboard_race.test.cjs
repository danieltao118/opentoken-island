const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "opentoken-leaderboard-race-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.APPDATA = path.join(testHome, "AppData", "Roaming");

const {
  accountKeyForUpstreamUrl,
  getState,
  refreshLeaderboard,
  setState,
} = require(path.resolve(__dirname, "..", "server.js"));

function accountState(account, userId) {
  const upstreamUrl = `https://scys.com/tokenrank/api/subapp/u/${account}`;
  return {
    schemaVersion: 3,
    upstreamUrl,
    accountKey: accountKeyForUpstreamUrl(upstreamUrl),
    userId,
  };
}

function globalResponse(userId) {
  return {
    ok: true,
    status: 200,
    json: {
      board: "total",
      range: "today",
      myCity: "杭州",
      entries: [{ userId, name: "旧账号", city: "杭州", rank: 5, score: 500, byTool: { codex: 500 } }],
      cities: [{ city: "杭州", count: 10, group: "华东" }],
    },
  };
}

(async () => {
  const first = accountState("race-account-a", "old-user");
  setState(first);
  const cityMismatchRequest = async (_method, targetUrl) => {
    const url = new URL(targetUrl);
    if (!url.searchParams.has("city")) return globalResponse("old-user");
    return {
      ok: true,
      status: 200,
      json: {
        city: "杭州",
        cityStats: { total: 1000, users: 10 },
        entries: [{ userId: "different-user", name: "他人", rank: 1, score: 900 }],
      },
    };
  };
  await refreshLeaderboard(null, null, {
    outerAttempts: 1,
    requestAttempts: 1,
    timeoutMs: 100,
    request: cityMismatchRequest,
  });
  assert.equal(getState().leaderboard.own.userId, "old-user");
  assert.equal(getState().leaderboard.cityRank, null, "city rank must require the same stable userId");

  setState(first);
  let releaseCity;
  let markCityStarted;
  const cityStarted = new Promise((resolve) => { markCityStarted = resolve; });
  const cityGate = new Promise((resolve) => { releaseCity = resolve; });
  const delayedRequest = async (_method, targetUrl) => {
    const url = new URL(targetUrl);
    if (!url.searchParams.has("city")) return globalResponse("old-user");
    markCityStarted();
    await cityGate;
    return { ok: true, status: 200, json: { entries: [{ userId: "old-user", rank: 2, score: 500 }] } };
  };
  const pending = refreshLeaderboard(null, null, {
    outerAttempts: 1,
    requestAttempts: 1,
    timeoutMs: 100,
    request: delayedRequest,
  });
  await cityStarted;
  const second = accountState("race-account-b", "new-user");
  setState({
    ...second,
    leaderboard: {
      updatedAt: new Date().toISOString(),
      accountKey: second.accountKey,
      leaderboardMatched: true,
      own: { userId: "new-user", name: "新账号", rank: 9, score: 200, byTool: { hermes: 200 } },
    },
  });
  releaseCity();
  await pending;
  assert.equal(getState().userId, "new-user", "an old city response must not overwrite a switched account");
  assert.equal(getState().leaderboard.own.userId, "new-user");

  console.log("leaderboard account-generation race contract ok");
  fs.rmSync(testHome, { recursive: true, force: true });
})().catch((error) => {
  console.error("leaderboard race test FAILED:", error.message);
  fs.rmSync(testHome, { recursive: true, force: true });
  process.exit(1);
});
