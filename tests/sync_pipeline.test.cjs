const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "opentoken-sync-pipeline-"));
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.APPDATA = path.join(testHome, "AppData", "Roaming");

const {
  accountKeyForUpstreamUrl,
  buildSyncFacts,
  canRewriteV2Payload,
  claudeRowsToV2Hourly,
  isolateAccountState,
  mergeClaudeIntoV2Hourly,
  officialDaemonDiagnosis,
  officialLedgerHasClaude,
  officialLedgerRowCount,
  processAlive,
  readOfficialLock,
  setState,
} = require(path.resolve(__dirname, "..", "server.js"));

const today = "2026-08-20";
const claudeRows = [{
  date: today,
  tool: "claude-code",
  model: "glm-5.3",
  input: 10,
  output: 2,
  cache_read: 3,
  cache_write: 0,
}];

const hours = claudeRowsToV2Hourly(claudeRows, today);
assert.equal(hours.length, 1);
assert.equal(hours[0].hour_utc, today + "T00");
assert.equal(hours[0].tool, "claude-code");
assert.equal(hours[0].input, 10);

const unsigned = {
  v2_hourly: [{ hour_utc: today + "T01", tool: "codex", model: "gpt", input: 1, output: 0, cache_read: 0, cache_write: 0 }],
  v2_sessions: [],
};
assert.equal(canRewriteV2Payload(unsigned), true);
const merged = mergeClaudeIntoV2Hourly(unsigned.v2_hourly, today, hours);
assert.equal(merged.filter((row) => row.tool === "claude-code").length, 1);
assert.equal(merged.filter((row) => row.tool === "codex").length, 1);
assert.equal(canRewriteV2Payload({ ...unsigned, sig: "abcdef0123456789abcdef" }), false);

const accountAUrl = "https://scys.com/tokenrank/api/subapp/u/pipeline-a";
const accountBUrl = "https://scys.com/tokenrank/api/subapp/u/pipeline-b";
const accountAKey = accountKeyForUpstreamUrl(accountAUrl);
const accountBKey = accountKeyForUpstreamUrl(accountBUrl);
const isolated = isolateAccountState({
  accountKey: accountAKey,
  userId: "u1",
  myCity: "Hefei",
  localUsage: { summary: { total: 1 } },
}, accountAKey, accountBKey);
assert.equal(isolated.state.myCity, undefined);
assert.equal(isolated.state.localUsage.summary.total, 1);

fs.mkdirSync(path.join(testHome, ".opentoken"), { recursive: true });
fs.writeFileSync(path.join(testHome, ".opentoken", "state.json"), JSON.stringify({
  usage: { [today + "|codex|gpt"]: { input: 1 } },
}), "utf8");
assert.equal(officialLedgerHasClaude(today), false);
fs.writeFileSync(path.join(testHome, ".opentoken", "state.json"), JSON.stringify({
  usage: { [today + "|claude-code|glm-5.3"]: { input: 1 } },
}), "utf8");
assert.equal(officialLedgerHasClaude(today), true);
assert.equal(officialLedgerRowCount(today), 1);
assert.equal(officialLedgerRowCount("not-a-date"), 0);

const lockPath = path.join(testHome, ".opentoken", "upload.lock");
assert.equal(processAlive(process.pid), true);
assert.equal(processAlive(0), false);
assert.equal(readOfficialLock().present, false);
fs.writeFileSync(lockPath, String(process.pid), "utf8");
assert.equal(readOfficialLock().stale, false, "a live owner must not look stale");
fs.writeFileSync(lockPath, "4294967", "utf8");
assert.equal(readOfficialLock().stale, true, "a dead owner must be reported stale");
fs.rmSync(lockPath);

assert.equal(officialDaemonDiagnosis({ rows: 3, hasClaude: true }).status, "ok");
assert.equal(officialDaemonDiagnosis({ rows: 3, hasClaude: false }).reason, "ledger-missing-claude");
assert.equal(officialDaemonDiagnosis({ rows: 0, hour: 3 }).reason, "early-day");
assert.equal(officialDaemonDiagnosis({ rows: 0, hour: 14, lockStale: true }).reason, "stale-lock");
assert.equal(officialDaemonDiagnosis({ rows: 0, hour: 14, failures: 12 }).reason, "daemon-failing");
assert.equal(officialDaemonDiagnosis({ rows: 0, hour: 14 }).reason, "ledger-empty");

setState({
  schemaVersion: 3,
  accountKey: accountAKey,
  userId: "bound",
  myCity: "Hefei",
});
const factsBoard = {
  publicDataFresh: true,
  leaderboardMatched: false,
  entriesCount: 200,
  cutoffRank: 200,
  cutoffScore: 77682000,
  error: "公开榜仅返回前 200 名",
  cityRank: null,
  myCity: "",
};
const factsCity = { status: "unavailable", rankLabel: "#--", reason: "今日该城无此账号", name: "Hefei" };
const factsLocal = { date: today, completeness: "observed", summary: { total: 176606, byTool: { "claude-code": 176606 } } };
const factsSync = { status: "waiting", uploaded: false, leaderboardMatched: false, leaderboardSync: { status: "done" } };
const facts = buildSyncFacts({
  today,
  localSnapshot: factsLocal,
  uploadSummary: null,
  board: factsBoard,
  leaderboard: { matched: false, city: factsCity },
  claudeValue: 176606,
  officialClaude: false,
  sync: factsSync,
});
assert.equal(facts.local.status, "ok");
assert.equal(facts.upload.status, "blocked");
assert.match(facts.upload.detail, /缺 Claude/);

const factsNoLedger = buildSyncFacts({
  today,
  localSnapshot: factsLocal,
  board: factsBoard,
  leaderboard: { matched: false, city: factsCity },
  claudeValue: 176606,
  officialClaude: false,
  officialRows: 0,
  sync: factsSync,
});
assert.equal(factsNoLedger.upload.status, "blocked");
assert.match(factsNoLedger.upload.detail, /没写成账本/);
assert.equal(facts.national.status, "outside-window");
assert.equal(facts.city.status, "blocked");

const serverJs = fs.readFileSync(path.resolve(__dirname, "..", "server.js"), "utf8");
assert.doesNotMatch(serverJs, /await flushPendingLocalUsage/, "CLI completed must not forge a usage-v1 POST");
assert.match(serverJs, /function mergeClaudeIntoV2Hourly/);
assert.match(serverJs, /function buildSyncFacts/);
assert.match(serverJs, /function maybeHealOfficialDaemon/);
assert.match(serverJs, /function clearStaleOfficialLock/);
assert.match(
  serverJs,
  /maybeHealOfficialDaemon\(\);\s*\n\s*maybeTriggerAutoUpload\(\);/,
  "the hourly official-daemon check must run inside the background tick"
);
const popoverHtml = fs.readFileSync(path.resolve(__dirname, "..", "popover.html"), "utf8");
assert.match(popoverHtml, /id="syncFacts"/);
assert.match(popoverHtml, /class="sync-lights"/);
assert.match(popoverHtml, /class="sync-light"/);
assert.match(popoverHtml, /data-tip/);
assert.doesNotMatch(popoverHtml, /class="facts sync-facts"/);
assert.match(popoverHtml, /status !== 'scheduled' && status !== 'running'/);

console.log("sync pipeline contract ok");
fs.rmSync(testHome, { recursive: true, force: true });
