const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "opentoken-leaderboard-city-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.APPDATA = path.join(testHome, "AppData", "Roaming");

const {
  accountKeyForUpstreamUrl,
  getState,
  leaderboardProjection,
  refreshLeaderboard,
  setState,
} = require(path.resolve(__dirname, "..", "server.js"));

function accountState(userId) {
  const upstreamUrl = "https://scys.com/tokenrank/api/subapp/u/city-discovery-account";
  return {
    schemaVersion: 3,
    upstreamUrl,
    accountKey: accountKeyForUpstreamUrl(upstreamUrl),
    userId,
  };
}

function totalBoard(userId) {
  return {
    ok: true,
    status: 200,
    json: {
      board: "total",
      range: "today",
      entries: [{
        userId,
        name: "bound-user",
        rank: 15,
        score: 1377000000,
        byTool: { codex: 1143000000 },
      }],
      cities: [
        { city: "Hangzhou", count: 230, group: "East" },
        { city: "Hefei", count: 19, group: "East" },
      ],
    },
  };
}

function cityBoard(city, entries, stats) {
  return {
    ok: true,
    status: 200,
    json: {
      board: "total",
      range: "today",
      city,
      cityStats: stats,
      entries,
    },
  };
}

function trackRequest(userId, queriedCities) {
  return async (_method, targetUrl) => {
    const url = new URL(targetUrl);
    const city = url.searchParams.get("city") || "";
    if (!city) return totalBoard(userId);
    queriedCities.push(city);
    if (city === "Hangzhou") {
      return cityBoard("Hangzhou", [{ userId: "other-user", name: "other", rank: 1, score: 9 }], { total: 99, users: 230 });
    }
    if (city === "Hefei") {
      return cityBoard("Hefei", [{ userId, name: "bound-user", rank: 1, score: 1377000000 }], { total: 4475126741, users: 19 });
    }
    return cityBoard(city, [], { total: 0, users: 0 });
  };
}

(async () => {
  const userId = "city-own-user";
  setState(accountState(userId));
  const firstCities = [];
  await refreshLeaderboard(null, null, {
    outerAttempts: 1,
    requestAttempts: 1,
    timeoutMs: 100,
    request: trackRequest(userId, firstCities),
  });
  const board = getState().leaderboard;
  assert.equal(board.myCity, "Hefei", "city identity must come from the city board that contains the bound userId");
  assert.equal(board.cityRank, 1);
  assert.equal(board.cityStats.users, 19);
  assert.ok(firstCities.includes("Hangzhou"), "public city directory names may be queried");
  assert.ok(firstCities.includes("Hefei"));
  assert.notEqual(board.cityRank, 230, "cities[].count must never be shown as a personal city rank");

  const projected = leaderboardProjection(board, { accountConnected: true, boundUserId: userId });
  assert.equal(projected.city.name, "Hefei");
  assert.equal(projected.city.rank, 1);
  assert.equal(projected.city.rankLabel, "#1");
  assert.equal(projected.city.status, "ok");
  assert.equal(projected.cityDirectory[0].members, 230);
  setState({ ...getState() });
  const secondCities = [];
  await refreshLeaderboard(null, null, {
    outerAttempts: 1,
    requestAttempts: 1,
    timeoutMs: 100,
    request: trackRequest(userId, secondCities),
  });
  assert.deepEqual(secondCities, ["Hefei"], "a cached city identity must skip scanning the rest of the directory");
  assert.equal(getState().leaderboard.cityRank, 1);

  setState({ ...accountState(userId), myCity: "Hefei" });
  const outsideCities = [];
  const outsideRequest = async (_method, targetUrl) => {
    const url = new URL(targetUrl);
    const city = url.searchParams.get("city") || "";
    if (!city) {
      return {
        ok: true,
        status: 200,
        json: {
          board: "total",
          range: "today",
          entries: [{ userId: "other-user", name: "other", rank: 1, score: 90000000 }],
          cities: [{ city: "Hangzhou", count: 10, group: "East" }, { city: "Hefei", count: 19, group: "East" }],
        },
      };
    }
    outsideCities.push(city);
    if (city === "Hefei") {
      return cityBoard("Hefei", [{ userId, name: "bound-user", rank: 1, score: 176606, byTool: { "claude-code": 176606 } }], { total: 176606, users: 19 });
    }
    return cityBoard(city, [], { total: 0, users: 0 });
  };
  await refreshLeaderboard(null, null, {
    outerAttempts: 1,
    requestAttempts: 1,
    timeoutMs: 100,
    request: outsideRequest,
  });
  const outsideBoard = getState().leaderboard;
  assert.equal(outsideBoard.leaderboardMatched, false);
  assert.equal(outsideBoard.myCity, "Hefei");
  assert.equal(outsideBoard.cityRank, 1);
  assert.equal(outsideBoard.cityOwn.score, 176606);
  assert.deepEqual(outsideCities, ["Hefei"]);
  const outsideView = leaderboardProjection(outsideBoard, { accountConnected: true, boundUserId: userId });
  assert.equal(outsideView.matched, false);
  assert.equal(outsideView.rankLabel, "#--");
  assert.equal(outsideView.score, 176606);
  assert.equal(outsideView.city.rank, 1);

  const recoveredId = "recover-city-user";
  setState({ ...accountState(recoveredId) });
  const recoveredCities = [];
  await refreshLeaderboard(null, null, {
    outerAttempts: 1,
    requestAttempts: 1,
    timeoutMs: 100,
    request: async (_method, targetUrl) => {
      const url = new URL(targetUrl);
      const city = url.searchParams.get("city") || "";
      if (!city) {
        return {
          ok: true,
          status: 200,
          json: {
            board: "total",
            range: "today",
            entries: [{ userId: "other-user", name: "other", rank: 200, score: 90000000 }],
            cities: [{ city: "Hangzhou", count: 10, group: "East" }, { city: "Hefei", count: 19, group: "East" }],
          },
        };
      }
      recoveredCities.push(city);
      if (city === "Hefei") {
        return cityBoard("Hefei", [{ userId: recoveredId, name: "bound-user", rank: 3, score: 23223000 }], { total: 23223000, users: 19 });
      }
      return cityBoard(city, [], { total: 0, users: 0 });
    },
  });
  assert.equal(getState().myCity, "Hefei", "outside the public window, recover city identity once from the directory");
  assert.equal(getState().leaderboard.cityRank, 3);
  assert.equal(getState().leaderboard.cityOwn.score, 23223000);
  assert.ok(recoveredCities.includes("Hangzhou"));
  assert.ok(recoveredCities.includes("Hefei"));

  const recoveredAgain = [];
  await refreshLeaderboard(null, null, {
    outerAttempts: 1,
    requestAttempts: 1,
    timeoutMs: 100,
    request: async (_method, targetUrl) => {
      const url = new URL(targetUrl);
      const city = url.searchParams.get("city") || "";
      if (!city) {
        return {
          ok: true,
          status: 200,
          json: {
            board: "total",
            range: "today",
            entries: [{ userId: "other-user", name: "other", rank: 200, score: 90000000 }],
            cities: [{ city: "Hangzhou", count: 10, group: "East" }, { city: "Hefei", count: 19, group: "East" }],
          },
        };
      }
      recoveredAgain.push(city);
      if (city === "Hefei") {
        return cityBoard("Hefei", [{ userId: recoveredId, name: "bound-user", rank: 3, score: 23223000 }], { total: 23223000, users: 19 });
      }
      return cityBoard(city, [], { total: 0, users: 0 });
    },
  });
  assert.deepEqual(recoveredAgain, ["Hefei"], "remembered city must not rescan the directory");

  console.log("leaderboard city discovery contract ok");
  fs.rmSync(testHome, { recursive: true, force: true });
})().catch((error) => {
  console.error("leaderboard city test FAILED:", error.message);
  fs.rmSync(testHome, { recursive: true, force: true });
  process.exit(1);
});
