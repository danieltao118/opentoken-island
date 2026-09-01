# OpenToken Island data contract

This contract prevents local usage, Z.ai quota data, and SCYS leaderboard data from drifting into one ambiguous number.

## Hard invariants

1. `overallUsage.total` is this computer's usage in the SCYS leaderboard metric: for each local tool, `min(local raw, board.byTool)` when the public board has scored that tool, otherwise local raw (`input+output+cache_read+cache_write`). Hermes/OpenClaw from other computers never enter this total. `overallUsage.rawTotal` keeps the uncapped local raw sum. Only `overallUsage.byTool` may contribute to `total`.
2. `leaderboard.score` and `leaderboard.byTool` are the official multi-computer SCYS rank metric. They must never replace `overallUsage.rawTotal`, and Hermes/OpenClaw from `leaderboard.byTool` must never be added into the local total.
3. `glm.trends` contains only Z.ai model-usage buckets. The fixed periods are 24 hourly buckets, 7 daily buckets, and 30 daily buckets.
4. A valid zero is data (`status=ok`, `total=0`); it is not a read error or a missing value.
5. Hermes, OpenClaw, and other tools returned for the same SCYS account are displayed under `leaderboard.tools`. Their values do not change the local total.
6. `cities[].count` is a participant count. It is not a Token score or a city rank.
7. A personal city rank is displayed only after the same stable user ID is found in a city-specific `?city=` response. City identity may come from SCYS `myCity`/`entry.city`, or from locating that user ID in a public city board. The remembered city name persists across days for the same webhook account and is cleared on account switch; yesterday's city rank is never reused. When the bound account is outside the public window, Island queries only that remembered `?city=`. `cities[].count` is never used as a rank or as the chosen city. Otherwise the UI displays `#--` and the reason.
8. SCYS identity is scoped to a one-way fingerprint of the configured webhook account. Changing accounts clears the old identity, upload acknowledgement, and leaderboard view without clearing device-local raw usage.
9. Cursor quota cards show included/on-demand **USD spend** for the Cursor subscription. They must never be added to, compared with, or used as a fallback for local OpenToken Cursor rows.
10. Grok quota cards show the grok.com / Grok CLI **subscription credit pool**. They must never be mixed with Cursor-hosted `cursor-grok-*` model usage, which bills against the Cursor plan in invariant 9.
11. Codex quota cards show ChatGPT/Codex **rate-limit windows** (5-hour and/or weekly percent remaining). They must never be added to, compared with, or used as a fallback for local OpenToken Codex token rows.
12. Kimi quota cards show the Kimi For Coding subscription's **plan-relative percentages** (rolling 5-hour window and weekly allowance) read from `GET https://api.kimi.com/coding/v1/usages`. The endpoint exposes no absolute token counts, so these percentages must never be added to, compared with, or used as a fallback for local Kimi/Moonshot token rows. The API key is read from the OpenCodex provider config, is never copied into Island state, and is never logged.

## Local projection

Incoming aggregate usage rows are reduced to the allowlisted fields `date`, `tool`, `model`, `input`, `output`, `cache_read`, `cache_write`, and `normalized`. The durable daily accumulator keeps the largest cumulative counters for each `(date, tool, model)` key. A successful full `opentoken preview --since <date> --json` replaces the observed accumulator and records `completeness=full`.

The full preview runs outside `/api/summary`, at most once every six hours unless explicitly refreshed. Claude Code has a bounded single-tool background scan and may update only the local Claude row or the allowlisted outgoing usage row for the same date. The popover hero displays `leaderboard.scoreLabel` as 姒滃崟鍒? the first rank-fact cell displays `overallUsage.total` as 瀹為檯 Token锛堟湰鏈猴級. Those two numbers stay separate.

## Sync stages

- Manual upload creates one durable operation. Repeated clicks join the running operation.
- The proxy records a redacted operation ID, payload hash, aggregate summary, transport status, and accepted count.
- Usage and activity acknowledgements stay attached to their own operation records. An activity heartbeat can never mark a Token usage upload as accepted or failed.
- The SCYS POST is attempted once because SCYS does not publish an idempotency-key contract.
- The upstream response is returned before a leaderboard refresh begins.
- Public leaderboard pulls are scheduled, not polled: a usage ack or a completed CLI upload with no new rows pulls immediately and retries with short backoff until the bound account appears or the retry budget is exhausted; a user refresh pulls once. The same upload operation ID is not pulled again after a match or a settled public-window miss. Island does not forge usage-v1 POSTs. Unsigned v2 hourly batches may merge today's local Claude hours before forward; signed envelopes are forwarded unmodified. Local usage, upload, national rank, and city rank are four independent facts in `sync.facts`; CLI `completed` never means the public board should match.
- The official daemon is checked hourly. A dead-owner `upload.lock` is cleared, a rising failure count is logged, and an empty same-day official ledger after 10:00 local time triggers one dated upload retry. The `sync.facts` upload light distinguishes an unwritten official ledger from a ledger that has rows but no Claude.
- Leaderboard refresh is single-flight and never runs inside the summary response path.
- A new computer binds its public SCYS leaderboard row explicitly in the GUI. Public scores are never used to guess an identity; automatic matching is allowed only when SCYS explicitly returns a stable identity or a previously bound identity is present.

## Privacy boundary

The outbound proxy accepts only the known usage or activity schema. Unknown root or nested fields, non-JSON-number counters, invalid types, oversized bodies, path-like strings, private-key material, and credential-like key/value strings are rejected before the network transport is called. Signed activity `nonce` and `sig` values use a bounded hex/base64url alphabet.

The upstream origin must be exactly `https://scys.com` and match `/tokenrank/api/subapp/u/<account>` with a bounded account segment and no query parameters, fragments, or user info. Browser writes from non-local origins or `Sec-Fetch-Site: cross-site` are rejected. GET summary, candidate, and service routes are cache-only; scans, CLI checks, and network refreshes require a protected POST or the background coordinator. State files do not retain raw upload bodies or upstream response bodies. Explicit leaderboard binding stores only the selected public leaderboard ID and its aggregate public snapshot; it does not send an additional payload to SCYS.

Protocol pseudonyms required by OpenToken/SCYS (`device`, signed activity `session_key`, `nonce`, and `sig`) remain allowlisted but must match bounded protocol strings. Prompts, responses, tool arguments, commands, working directories, file paths, cookies, authorization headers, API keys, and secrets are not allowed.

## Compatibility and failure behavior

- Same-day transient leaderboard misses retain the last known personal row as stale; cross-day personal data is not retained.
- Partial GLM refreshes update successful periods and retain failed periods as stale. Each period keeps its own capture time, stale values expire after 12 hours, and stored snapshots are isolated by a one-way account fingerprint.
- A process restart turns a previously running manual upload into `interrupted`; it never reports a false success.
- The Tauri shell reuses port 4174 only when `/api/health` reports the matching app and protocol version.
- The 31GB Codex session store is an upstream source-log concern. This application does not delete, upload, or treat those logs as its cache.

## Required checks

Run `npm test`, `cargo test`, `cargo fmt --check`, and `npm run tauri:build`. The tests include metric separation, fixed GLM periods, ISO timestamp parsing, valid-zero handling, privacy-schema rejection, URL pinning, local API latency, cross-origin write blocking, health handshake, and GUI contract checks.

