const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "opentoken-leaderboard-sync-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.APPDATA = path.join(testHome, "AppData", "Roaming");

const {
  accountKeyForUpstreamUrl,
  applyLeaderboardSyncOutcome,
  getState,
  leaderboardSyncDue,
  leaderboardSyncRetryDelayMs,
  markLeaderboardSyncResult,
  onManualUploadFinished,
  scheduleLeaderboardSync,
  setState,
  shouldFlushPendingLocalUsage,
  LEADERBOARD_SYNC_MAX_ATTEMPTS,
} = require(path.resolve(__dirname, "..", "server.js"));

const now = Date.parse("2026-08-20T00:20:00.000Z");
const accountKey = accountKeyForUpstreamUrl("https://scys.com/tokenrank/api/subapp/u/sync-account");

function resetState(extra = {}) {
  setState({
    schemaVersion: 3,
    accountKey,
    upstreamUrl: "https://scys.com/tokenrank/api/subapp/u/sync-account",
    ...extra,
  });
}

resetState();
const usageAck = onManualUploadFinished({
  status: "succeeded",
  transportAcked: true,
  operationId: "usage-op-1",
  now,
});
assert.equal(usageAck.status, "scheduled");
assert.equal(usageAck.reason, "usage-ack");
assert.equal(usageAck.uploadOperationId, "usage-op-1");
assert.equal(leaderboardSyncDue(now), true, "usage ack must pull the public board immediately");
assert.equal(leaderboardSyncDue(now - 1), false, "usage ack must not be due before it is scheduled");
assert.ok(leaderboardSyncRetryDelayMs(1) > 0);
assert.ok(leaderboardSyncRetryDelayMs(1) < 20_000);

const unmatchedFresh = { publicDataFresh: true, leaderboardMatched: false, stale: false };
const retry = applyLeaderboardSyncOutcome(unmatchedFresh, usageAck, now);
assert.equal(retry.action, "retry");
assert.equal(retry.attempt, 1);
assert.ok(retry.dueAt > now);
assert.ok(retry.dueAt - now < 20_000);
assert.equal(applyLeaderboardSyncOutcome(unmatchedFresh, { ...usageAck, attempt: LEADERBOARD_SYNC_MAX_ATTEMPTS - 1 }, now).action, "done");
assert.equal(applyLeaderboardSyncOutcome({ publicDataFresh: true, leaderboardMatched: true, stale: false, own: { userId: "u1", rank: 1, score: 1 } }, usageAck, now).action, "done");

markLeaderboardSyncResult(true);
assert.equal(getState().leaderboardSync.status, "done");
assert.equal(getState().leaderboardSync.syncedForUploadId, "usage-op-1");
assert.equal(leaderboardSyncDue(now + 60_000), false, "the same upload id must not pull again after it settles");

resetState();
const noRows = onManualUploadFinished({
  status: "completed",
  transportAcked: false,
  operationId: "completed-op-1",
  now,
});
assert.equal(noRows.reason, "no-new-rows");
assert.equal(leaderboardSyncDue(now), true, "a completed upload with no new rows must be due immediately");

assert.equal(applyLeaderboardSyncOutcome(unmatchedFresh, noRows, now).action, "retry");

resetState();
const userRefresh = scheduleLeaderboardSync({
  dueAt: now,
  uploadOperationId: "user-refresh:1",
  reason: "user-refresh",
  now,
});
assert.equal(applyLeaderboardSyncOutcome(unmatchedFresh, userRefresh, now).action, "done");
assert.equal(applyLeaderboardSyncOutcome({ publicDataFresh: false }, userRefresh, now).action, "failed");

assert.equal(shouldFlushPendingLocalUsage("2026-08-20", {
  date: "2026-08-20",
  summary: { date: "2026-08-20", total: 176606 },
  rows: [{ date: "2026-08-20", tool: "claude-code", model: "glm", input: 1 }],
}, {
  summary: { date: "2026-08-19", total: 459045438 },
  upstream: { ok: true },
}), false, "usage-v1 flush is retired because SCYS rejects that dialect");
assert.equal(shouldFlushPendingLocalUsage("2026-08-20", {
  date: "2026-08-20",
  summary: { date: "2026-08-20", total: 176606 },
  rows: [{ date: "2026-08-20", tool: "claude-code", model: "glm", input: 1 }],
}, {
  summary: { date: "2026-08-20", total: 176606 },
  upstream: { ok: true },
}), false);
assert.equal(shouldFlushPendingLocalUsage("2026-08-20", {
  date: "2026-08-20",
  summary: { date: "2026-08-20", total: 200000 },
  rows: [{ date: "2026-08-20", tool: "claude-code", model: "glm", input: 2 }],
}, {
  summary: { date: "2026-08-20", total: 176606 },
  upstream: { ok: true },
}), false);


resetState();
const failed = onManualUploadFinished({
  status: "failed",
  transportAcked: false,
  operationId: "failed-op-1",
  now,
});
assert.equal(failed?.status === "scheduled", false, "a failed upload must not schedule a board pull");
assert.equal(leaderboardSyncDue(now), false);

resetState();
scheduleLeaderboardSync({
  dueAt: now - 1000,
  uploadOperationId: "restart-op",
  reason: "usage-ack",
  now: now - 1000,
});
setState({ ...getState() });
assert.equal(leaderboardSyncDue(now), true, "a persisted dueAt in the past must still pull after restart");

resetState();
const scheduled = scheduleLeaderboardSync({
  dueAt: now,
  uploadOperationId: "timer-op",
  reason: "usage-ack",
  now,
});
assert.equal(scheduled.status, "scheduled");
assert.match(String(scheduled.dueAt), /T/);

console.log("leaderboard sync state machine ok");
fs.rmSync(testHome, { recursive: true, force: true });
