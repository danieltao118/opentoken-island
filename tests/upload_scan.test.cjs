const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  cleanupDatedCodexHome,
  codexSessionDateDirs,
  finalizeManualUploadStatus,
  prepareDatedCodexHome,
  uploadTransportAcked,
} = require(path.resolve(__dirname, "..", "server.js"));

assert.equal(typeof finalizeManualUploadStatus, "function");
assert.equal(typeof uploadTransportAcked, "function");
assert.equal(typeof prepareDatedCodexHome, "function");
assert.equal(typeof cleanupDatedCodexHome, "function");
assert.equal(typeof codexSessionDateDirs, "function");

assert.deepEqual(
  codexSessionDateDirs("2026-08-19", "2026-08-19"),
  ["2026-08-18", "2026-08-19"],
  "today-only Codex scans must include the previous UTC day for timezone overlap",
);

const timeoutResult = { ok: false, timedOut: true, message: "killed" };
const ackedTransport = { ok: true, finishedAt: "2026-08-19T09:00:00.000Z" };
assert.equal(
  uploadTransportAcked(timeoutResult, ackedTransport, "2026-08-19T08:37:00.000Z"),
  true,
  "a timeout after SCYS accepted the payload still counts as transport ack",
);
const timedOutButAcked = finalizeManualUploadStatus(timeoutResult, true);
assert.equal(timedOutButAcked.status, "succeeded");
assert.match(timedOutButAcked.detail, /SCYS 已确认接收/);

const timedOutNoAck = finalizeManualUploadStatus(timeoutResult, false);
assert.equal(timedOutNoAck.status, "failed");
assert.match(timedOutNoAck.detail, /超时/);

const completed = finalizeManualUploadStatus({ ok: true }, false);
assert.equal(completed.status, "completed");

const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-real-"));
const oldDir = path.join(realHome, "sessions", "2026", "08", "01");
const todayDir = path.join(realHome, "sessions", "2026", "08", "19");
fs.mkdirSync(oldDir, { recursive: true });
fs.mkdirSync(todayDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, "old.jsonl"), "old-history");
fs.writeFileSync(path.join(todayDir, "today.jsonl"), "today-only");
const scanHome = prepareDatedCodexHome("2026-08-19", { realHome });
assert.ok(scanHome);
assert.equal(
  fs.readFileSync(path.join(scanHome, "sessions", "2026", "08", "19", "today.jsonl"), "utf8"),
  "today-only",
);
assert.equal(
  fs.existsSync(path.join(scanHome, "sessions", "2026", "08", "01", "old.jsonl")),
  false,
  "dated Codex home must not expose historical session folders",
);
cleanupDatedCodexHome(scanHome);
assert.equal(
  fs.readFileSync(path.join(todayDir, "today.jsonl"), "utf8"),
  "today-only",
  "cleanup must remove scan junctions without deleting real Codex sessions",
);
fs.rmSync(realHome, { recursive: true, force: true });

console.log("upload scan window ok");
