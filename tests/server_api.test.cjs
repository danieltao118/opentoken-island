const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early with ${child.exitCode}`);
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server health timeout");
}

(async () => {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "opentoken-island-test-"));
  const serverPath = path.resolve(__dirname, "..", "server.js");
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"),
      OPENTOKEN_ISLAND_PORT: String(port),
      OPENTOKEN_ISLAND_APP_VERSION: "test-version",
      OPENTOKEN_BIN: path.join(home, "missing-opentoken"),
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await waitForHealth(base, child);
    assert.equal(health.appId, "opentoken-island");
    assert.equal(health.appVersion, "test-version");
    assert.equal(health.protocolVersion, 3);
    assert.equal(health.stateSchemaVersion, 3);
    const healthResponse = await fetch(`${base}/api/health`);
    assert.ok(Number(healthResponse.headers.get("content-length")) > 0, "health must use Content-Length for the native handshake");
    assert.equal(healthResponse.headers.get("transfer-encoding"), null, "health must not use chunked framing");

    const startedAt = Date.now();
    const summaryResponse = await fetch(`${base}/api/summary`);
    const elapsed = Date.now() - startedAt;
    const summary = await summaryResponse.json();
    assert.equal(summaryResponse.status, 200);
    assert.equal(summary.ok, true);
    assert.ok(elapsed < 2000, `summary must be local-only and fast, took ${elapsed}ms`);
    assert.equal(summaryResponse.headers.get("access-control-allow-origin"), null);

    const blocked = await fetch(`${base}/api/upload`, {
      method: "POST",
      headers: { origin: "https://evil.example" },
    });
    assert.equal(blocked.status, 403, "cross-origin pages must not trigger a local upload");

    const candidates = await fetch(`${base}/api/leaderboard-candidates`);
    assert.equal(candidates.status, 200, "candidate GET must be a local cache read even without a configured SCYS account");
    const candidateBody = await candidates.json();
    assert.equal(candidateBody.ok, true);
    assert.equal(candidateBody.connected, false);
    assert.deepEqual(candidateBody.entries, []);

    const serviceStartedAt = Date.now();
    const service = await fetch(`${base}/api/service`);
    assert.equal(service.status, 200);
    assert.ok(Date.now() - serviceStartedAt < 1000, "service GET must return the cached state without running the CLI");

    const badBind = await fetch(`${base}/api/leaderboard-bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "public-user", prompt: "must-not-be-accepted" }),
    });
    assert.equal(badBind.status, 400, "identity binding must accept only the public userId field");

    const blockedBind = await fetch(`${base}/api/leaderboard-bind`, {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ userId: "public-user" }),
    });
    assert.equal(blockedBind.status, 403, "cross-origin pages must not change the leaderboard binding");

    const fetchMetadataBlocked = await fetch(`${base}/api/refresh`, {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    assert.equal(fetchMetadataBlocked.status, 403, "Sec-Fetch-Site must block cross-site background work even without Origin");
    console.log(`server API contract ok: summary=${elapsed}ms`);
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error("server API test FAILED:", error.message);
  process.exit(1);
});
