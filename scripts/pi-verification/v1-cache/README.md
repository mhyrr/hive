# V1 — Cache architecture end-to-end

From `docs/specs/2026-04-22-hive-on-pi-design.md` §6.1.

## Hypothesis

Two back-to-back SDK sessions with an identical system prompt share
Anthropic's prompt cache. Pi's default `cache_control` on the system
prompt is sufficient for cross-session caching within the same process.

## Method

1. Build a ~5KB static system prompt (comfortably exceeds Anthropic's
   1024-token cache minimum).
2. Create session 1 via `createAgentSession()` with subscription OAuth
   from `~/.pi/agent/auth.json`, thinking off, no tools, no compaction.
3. Prompt with a trivial user message; wait for completion; capture
   assistant message usage.
4. Create session 2 with the **same** loader/system prompt, same model.
5. Prompt with a different trivial user message; capture usage.
6. Inspect outgoing payloads via `before_provider_request` — confirm
   `cache_control` markers present on system blocks.

## Pass criterion

Run 2's assistant `usage.cacheRead` (or `cache_read_input_tokens`) > 0.

Run 1 is expected to show `cacheWrite > 0` (cache creation).

## Run

Prereq: `pi /login` completed (auth.json > 50 bytes).

```bash
cd scripts/pi-verification/v1-cache
bun install
bun run run
```

Results write to `runs/v1-<timestamp>.json`.

## Interpretation

- **Pass (run 2 cacheRead > 0):** Pi's default caching works with
  subscription OAuth. SEG 1/2/3 architecture has a clean foundation;
  only question left is whether we can add more breakpoints via
  `before_provider_request`.
- **Fail (run 2 cacheRead = 0) AND run 1 cacheWrite > 0:** Cache is
  being written but not read. Likely a provider/model-level issue or a
  transient in the second call's payload.
- **Fail AND run 1 cacheWrite = 0:** `cache_control` isn't being
  injected at all, or subscription OAuth route strips it. Dig into
  `capturedPayload.system[].cache_control`.

## Results

**2026-04-23 — PASSED.** Model: `claude-sonnet-4-6`.

| | Run 1 | Run 2 |
|---|---|---|
| input tokens (uncached) | 3 | 3 |
| `cacheWrite` | 4925 | 12 |
| `cacheRead` | 0 | **4913** |
| cost | $0.0186 | $0.0016 |

Run 2 cache hit rate: 4913 / 4925 = **99.7%**. Cost drop: 91%.

### Findings

1. Pi's default `cache_control: { type: "ephemeral" }` on the system
   prompt works cross-session (same process, back-to-back) with
   subscription OAuth. No extension required for the baseline.
2. SEG 1/2/3 explicit breakpoints in the design spec are a refinement,
   not a prerequisite. The foundation is clean.
3. Subscription OAuth does not strip or downgrade cache_control — the
   full Anthropic cache API is available via Claude Pro/Max.

### Gotcha — per-block token minimum differs by model

First run with `claude-haiku-4-5` failed (both `cacheWrite` and
`cacheRead` were 0). Cause: Haiku requires **≥2048 tokens per cache
block**; our block was ~2100, right at the threshold and evidently
not reliably accepted. Sonnet's 1024 min cleared trivially.

When sizing SEG 1/2/3 boundaries for production, either:
- Gate on Sonnet-or-higher as the minimum cache-eligible model, or
- Ensure each segment exceeds 2048 tokens per block to be safe on Haiku.

### Not yet tested (follow-ups)

- Multiple cache breakpoints at SEG 1/2/3 boundaries (requires
  `before_provider_request` to mutate payload).
- Cross-process caching (two separate Bun processes) — closer model of
  the heartbeat case.
- Cache hit after subprocess restart (simulates `hive dispatch`).
