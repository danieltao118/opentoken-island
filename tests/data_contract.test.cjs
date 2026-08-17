const assert = require("assert");
const path = require("path");

const {
  accountKeyForUpstreamUrl,
  isolateAccountState,
  leaderboardProjection,
  mergeLocalUsageSnapshot,
  redactedUploadRecord,
  sanitizeUploadPayload,
  selectOwnEntry,
  validateScysUpstreamUrl,
} = require(path.resolve(__dirname, "..", "server.js"));

const date = "2026-07-28";
const base = mergeLocalUsageSnapshot(null, [
  { date, tool: "codex", model: "gpt-5", input: 100, output: 20, cache_read: 300, cache_write: 10, normalized: 40 },
], { date, source: "upload-observed" });
const updated = mergeLocalUsageSnapshot(base, [
  { date, tool: "codex", model: "gpt-5", input: 120, output: 30, cache_read: 350, cache_write: 10, normalized: 50 },
  { date, tool: "claude-code", model: "claude", input: 50, output: 5, cache_read: 0, cache_write: 0, normalized: 20 },
], { date, source: "upload-observed" });

assert.equal(updated.summary.total, 565, "incremental snapshots must keep the largest cumulative counters per tool/model");
assert.equal(updated.summary.byTool.codex, 510);
assert.equal(updated.summary.byTool["claude-code"], 55);
assert.equal(updated.completeness, "observed");
assert.ok(updated.revision > base.revision, "local snapshot revision must increase monotonically");

const replaced = mergeLocalUsageSnapshot(updated, [
  { date, tool: "codex", model: "gpt-5", input: 10, output: 1, cache_read: 0, cache_write: 0, normalized: 2 },
], { date, source: "preview", replace: true });
assert.equal(replaced.summary.total, 11, "an authoritative preview must replace the observed accumulator");
assert.equal(replaced.completeness, "full");

const board = leaderboardProjection({
  updatedAt: "2026-07-28T01:00:00.000Z",
  own: { score: 600, rank: 9, byTool: { codex: 300, hermes: 200, openclaw: 100 } },
  myCity: "杭州",
  myRank: 9,
  cityStats: { total: 10000, users: 12 },
  cities: [{ city: "杭州", count: 12, group: "华东" }],
});
assert.equal(board.score, 600);
assert.equal(board.tools.find((tool) => tool.name === "hermes").score, 200);
assert.equal(board.city.rank, null, "global myRank must never be mislabeled as a city rank");
assert.equal(board.city.status, "partial");
assert.equal(board.cityDirectory[0].members, 12);
const cityBoard = leaderboardProjection({
  ...board,
  own: { score: 600, rank: 9, byTool: { codex: 300 } },
  myCity: "杭州",
  cityRank: 3,
  cityStats: { total: 10000, users: 12 },
  cities: [{ city: "杭州", count: 12, group: "华东" }],
});
assert.equal(cityBoard.city.rank, 3);
assert.equal(leaderboardProjection({}).city.status, "unavailable");
assert.equal(
  leaderboardProjection({}, { accountConnected: true }).identity.status,
  "binding-required",
  "a new install must explicitly expose the first-bind state",
);

const accountAUrl = "https://scys.com/tokenrank/api/subapp/u/account-a";
const accountBUrl = "https://scys.com/tokenrank/api/subapp/u/account-b";
const accountAKey = accountKeyForUpstreamUrl(accountAUrl);
const accountBKey = accountKeyForUpstreamUrl(accountBUrl);
assert.ok(accountAKey && accountBKey && accountAKey !== accountBKey);
const isolated = isolateAccountState({
  accountKey: accountAKey,
  userId: "old-user",
  leaderboard: { own: { userId: "old-user" } },
  lastUpload: { summary: { total: 100 } },
  uploadTransport: { ok: true },
  localUsage: { summary: { total: 200 } },
}, accountAKey, accountBKey);
assert.equal(isolated.changed, true);
assert.equal(isolated.state.accountKey, accountBKey);
assert.equal(isolated.state.userId, undefined, "SCYS identity must be cleared when the webhook account changes");
assert.equal(isolated.state.leaderboard, undefined);
assert.equal(isolated.state.lastUpload, undefined);
assert.equal(isolated.state.uploadTransport, undefined);
assert.equal(isolated.state.localUsage.summary.total, 200, "local raw usage is device-local and must survive SCYS account switches");
const disconnected = isolateAccountState({ accountKey: accountAKey, userId: "old-user", leaderboard: { own: {} } }, accountAKey, "");
assert.equal(disconnected.changed, true);
assert.equal(disconnected.state.userId, undefined, "disconnecting a webhook must clear its SCYS identity");
const firstConnected = isolateAccountState({ userId: "orphan-user", leaderboard: { own: {} } }, "", accountBKey);
assert.equal(firstConnected.changed, true);
assert.equal(firstConnected.state.userId, undefined, "first connection must not inherit an unscoped legacy identity");

const persistedAck = redactedUploadRecord({
  operationId: "usage-operation",
  sequence: 3,
  upstream: {
    operationId: "usage-operation",
    sequence: 3,
    finishedAt: "2026-07-28T08:00:00.000Z",
    status: 200,
    ok: true,
    accepted: 4,
  },
});
assert.equal(persistedAck.upstream.operationId, "usage-operation");
assert.equal(persistedAck.upstream.finishedAt, "2026-07-28T08:00:00.000Z", "manual upload completion needs the durable ack time");

const identityEntries = [
  { userId: "old-user", score: 100, byTool: { codex: 100 } },
  { userId: "claimed-user", score: 200, byTool: { codex: 200 } },
];
assert.equal(
  selectOwnEntry(identityEntries, { claimedUserId: "claimed-user", storedUserId: "old-user" }).userId,
  "claimed-user",
  "an identity explicitly returned by SCYS must override a stale stored identity",
);
assert.equal(
  selectOwnEntry(identityEntries, {
    uploadSummary: { normalized: 200, normalizedByTool: { codex: 200 } },
    transportOk: true,
  }),
  null,
  "public score/tool metrics must never be used to guess a leaderboard identity",
);

const safeUsage = sanitizeUploadPayload({
  version: 1,
  device: "0123456789abcdef",
  rows: [{ date, tool: "codex", model: "gpt-5", input: 1, output: 2, cache_read: 3, cache_write: 4, normalized: 5 }],
  sessions: [{ date, tool: "codex", sessions: 1, messages: 2, user_messages: 1, active_seconds: 10, duration_seconds: 12 }],
});
assert.deepEqual(Object.keys(safeUsage), ["version", "device", "rows", "sessions"]);
assert.deepEqual(Object.keys(safeUsage.rows[0]), ["date", "tool", "model", "input", "output", "cache_read", "cache_write", "normalized"]);

for (const payload of [
  { version: 1, device: "abc", rows: [], sessions: [], prompt: "secret" },
  { version: 1, device: "abc", rows: [{ date, tool: "codex", model: "gpt", input: 1, response: "secret" }], sessions: [] },
  { version: 1, device: "abc", rows: [{ date, tool: "codex", model: "C:\\private\\key.txt", input: 1 }], sessions: [] },
  { schema: "opentoken.activity.v2", version: 2, device: "abc", seq: 1, sent_at: "2026-07-28T00:00:00Z", tz: "Asia/Shanghai", nonce: "abc", events: [{ type: "session", tool: "codex", session_key: "abc", started_at: "2026-07-28T00:00:00Z", ended_at: "2026-07-28T00:01:00Z", messages: 1, user_messages: 1, active_seconds: 60, command: "secret" }], sig: "abc" },
  { version: 1, device: "abc", rows: [{ date, tool: "codex", model: "gpt", input: "123" }], sessions: [] },
  { version: 1, device: "abc", rows: [{ date, tool: "codex", model: "gpt", input: false }], sessions: [] },
  { version: 1, device: "abc", rows: [{ date, tool: "codex", model: "gpt", input: null }], sessions: [] },
  { schema: "opentoken.activity.v2", version: 2, device: "abc", seq: 1, sent_at: "2026-07-28T00:00:00Z", tz: "Asia/Shanghai", nonce: "unsafe\r\nheader", events: [], sig: "abcdef0123456789" },
  { schema: "opentoken.activity.v2", version: 2, device: "abc", seq: 1, sent_at: "2026-07-28T00:00:00Z", tz: "Asia/Shanghai", nonce: "abcdef0123456789", events: [], sig: "C:\\Users\\private\\secret.txt" },
]) {
  assert.throws(() => sanitizeUploadPayload(payload), /upload payload rejected/i);
}

const safeActivity = sanitizeUploadPayload({
  schema: "opentoken.activity.v2",
  version: 2,
  device: "0123456789abcdef",
  seq: 1,
  sent_at: "2026-07-28T01:02:03.000Z",
  tz: "Asia/Shanghai",
  nonce: "abcdef0123456789",
  events: [{ type: "usage_hourly", tool: "codex", model: "gpt-5", hour_utc: "2026-07-28T01:00:00Z", input: 1, output: 2, cache_read: 3, cache_write: 4 }],
  sig: "abcdef0123456789",
});
assert.equal(safeActivity.events[0].type, "usage_hourly");

// 0.3.5 CLI 实测信封：schema 为数字、version 为字符串（取证日志 2026-08-16）。
const numericSchemaActivity = sanitizeUploadPayload({
  schema: 2,
  version: "2",
  device: "0123456789abcdef",
  seq: 198,
  sent_at: "2026-08-16T01:02:03.000Z",
  tz: "Asia/Shanghai",
  nonce: "abcdef0123456789",
  events: [{ type: "client_health", captured_at: "2026-08-16T01:02:03Z", payload: { scan_ms: 42000, ledger: { usage: 256, hourly: 1957, v2_sessions: 3313 }, unhoured: 0 } }],
  sig: "abcdef0123456789abcdef0123456789",
});
assert.equal(numericSchemaActivity.schema, 2);
assert.equal(numericSchemaActivity.version, "2");

// 0.3.5 CLI 实测事件类型名：hourly / session（started/ended Unix 秒 + date 字段）。
const hourlyAliasActivity = sanitizeUploadPayload({
  schema: 2,
  version: "2",
  device: "0123456789abcdef",
  seq: 199,
  sent_at: "2026-08-17T03:00:00.000Z",
  tz: "",
  nonce: "abcdef0123456789",
  events: [
    { type: "hourly", hour_utc: "2026-08-17T02", tool: "codex", model: "gpt-5.6-sol", input: 10, output: 20, cache_read: 30, cache_write: 40 },
    { type: "session", date, tool: "codex", session_key: "0123456789abcdef0123456789abcdef01234567", started: 1781791963, ended: 1781792000, messages: 5, user_messages: 2, active_seconds: 120 },
  ],
  sig: "abcdef0123456789abcdef0123456789",
});
assert.equal(hourlyAliasActivity.events[0].type, "hourly");
assert.equal(hourlyAliasActivity.events[0].hour_utc, "2026-08-17T02");
assert.equal(hourlyAliasActivity.events[1].started, 1781791963);

// client_health.unhoured 实测是数组（空=无未入桶会话，2026-08-17 取证）；带 sig 只校验、原样透传。
const looseHealthActivity = sanitizeUploadPayload({
  schema: 2,
  version: "2",
  device: "0123456789abcdef",
  seq: 200,
  sent_at: "2026-08-17T04:00:00.000Z",
  tz: "",
  nonce: "abcdef0123456789",
  events: [{ type: "client_health", captured_at: "2026-08-17T03:44:00Z", payload: { scan_ms: 280000, ledger: { usage: 260, hourly: 2000, v2_sessions: 3400 }, unhoured: [] } }],
  sig: "abcdef0123456789abcdef0123456789",
});
assert.deepEqual(looseHealthActivity.events[0].payload.unhoured, []);
// 字符串与数字形态也放行（透传不转换）。
const looseHealthString = sanitizeUploadPayload({
  schema: 2, version: "2", device: "0123456789abcdef", seq: 201,
  sent_at: "2026-08-17T04:00:00.000Z", tz: "", nonce: "abcdef0123456789",
  events: [{ type: "client_health", captured_at: "2026-08-17T03:44:00Z", payload: { scan_ms: 1, ledger: { usage: 1, hourly: 1, v2_sessions: 1 }, unhoured: "3" } }],
  sig: "abcdef0123456789abcdef0123456789",
});
assert.equal(looseHealthString.events[0].payload.unhoured, "3");
// 夹带敏感内容的数组元素仍必须拒绝。
assert.throws(() => sanitizeUploadPayload({
  schema: 2, version: "2", device: "0123456789abcdef", seq: 202,
  sent_at: "2026-08-17T04:00:00.000Z", tz: "", nonce: "abcdef0123456789",
  events: [{ type: "client_health", captured_at: "2026-08-17T03:44:00Z", payload: { scan_ms: 1, ledger: { usage: 1, hourly: 1, v2_sessions: 1 }, unhoured: [{ secret: "prompt=x" }] } }],
  sig: "abcdef0123456789abcdef0123456789",
}), /upload payload rejected/i);

// v2 批数据（0.3.5 CLI 实际线格式）：v2_hourly + v2_sessions + 可选信封字段。
const safeV2 = sanitizeUploadPayload({
  schema: "opentoken.activity.v2",
  version: 2,
  device: "0123456789abcdef",
  seq: 199,
  sent_at: "2026-08-16T01:02:03.000Z",
  tz: "Asia/Shanghai",
  nonce: "abcdef0123456789",
  v2_hourly: [{ hour_utc: "2026-08-16T01", tool: "codex", model: "gpt-5.6-sol", input: 1, output: 2, cache_read: 3, cache_write: 4 }],
  v2_sessions: [{ date, tool: "codex", session_key: "0123456789abcdef0123456789abcdef01234567", started: 1781791963, ended: 1781792000, messages: 12, user_messages: 3, active_seconds: 300 }],
  sig: "abcdef0123456789abcdef0123456789",
});
assert.deepEqual(Object.keys(safeV2), ["v2_hourly", "v2_sessions", "schema", "version", "device", "seq", "sent_at", "tz", "nonce", "sig"]);
assert.deepEqual(Object.keys(safeV2.v2_hourly[0]), ["hour_utc", "tool", "model", "input", "output", "cache_read", "cache_write"]);
assert.deepEqual(Object.keys(safeV2.v2_sessions[0]), ["date", "tool", "session_key", "started", "ended", "messages", "user_messages", "active_seconds"]);
for (const payload of [
  { v2_hourly: [], v2_sessions: [], prompt: "secret" },
  { v2_hourly: [{ hour_utc: "2026-08-16T01", tool: "codex", model: "gpt", input: 1, response: "secret" }], v2_sessions: [] },
  { v2_hourly: [{ hour_utc: "2026-08-16T01", tool: "codex", model: "C:\\private\\key.txt", input: 1 }], v2_sessions: [] },
  { v2_hourly: [], v2_sessions: [{ date, tool: "codex", session_key: "0123456789abcdef0123456789abcdef01234567", started: 1, ended: 2, messages: 1, user_messages: 1, active_seconds: 1, command: "secret" }] },
  { v2_hourly: [], v2_sessions: [{ date, tool: "codex", session_key: "unsafe\r\nkey1234567890", started: 1, ended: 2, messages: 1, user_messages: 1, active_seconds: 1 }] },
  { v2_hourly: [{ hour_utc: "2026-08-16T01", tool: "codex", model: "gpt", input: "123" }], v2_sessions: [] },
  { v2_hourly: [{ hour_utc: "2026-08-16 01", tool: "codex", model: "gpt", input: 1 }], v2_sessions: [] },
]) {
  assert.throws(() => sanitizeUploadPayload(payload), /upload payload rejected/i);
}

assert.equal(validateScysUpstreamUrl("https://scys.com/tokenrank/api/subapp/u/account"), true);
for (const target of [
  "http://scys.com/tokenrank/api/subapp/u/account",
  "https://evil.example/tokenrank/api/subapp/u/account",
  "https://scys.com/tokenrank/api/subapp/u/account?copy=1",
  "https://user:pass@scys.com/tokenrank/api/subapp/u/account",
  "https://scys.com:444/tokenrank/api/subapp/u/account",
  "https://scys.com/tokenrank/api/subapp/u/account%2Fother",
  "https://scys.com/tokenrank/api/subapp/u/account.with-dot",
]) {
  assert.equal(validateScysUpstreamUrl(target), false, `unsafe upstream must be blocked: ${target}`);
}

console.log("data contract and privacy boundary ok");
