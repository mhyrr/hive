# V4 — Subscription OAuth under dispatch-shaped load

From `docs/specs/2026-04-22-hive-on-pi-design.md` §6.1.

**Hard stop gate.** If this fails, subscription billing is not viable
for the migration and the architecture needs revisiting.

## Hypothesis

Subscription OAuth tokens in `~/.pi/agent/auth.json` survive 10
sequential single-turn Pi invocations spread over ~2 hours. Token
refresh, if needed, happens silently. No fallback to API-key billing.

## Method

`run.sh` runs `pi --print` 10 times (default), 12 min apart. Each:

- Single prompt `Reply with only: ok`
- Ephemeral session (`--no-session`)
- No tools, extensions, or skills
- Haiku-default model via `--provider anthropic`

Captures per-iteration:
- Exit status (ok/fail)
- Duration
- `auth.json` size (should stay populated)
- Output head (to eyeball for auth errors)

Writes structured results to `runs/v4-<ts>.json` and full log to
`runs/v4-<ts>.log`.

## Pass criterion

- `passed == 10, failed == 0`
- `auth.json` stays >50 bytes throughout
- No iteration output mentions "API key", "401", or subscription
  fallback warnings

## Run

```bash
# Smoke test — single iteration, no delay
V4_ITERATIONS=1 V4_INTERVAL=0 bash run.sh

# Full 2h durability test
bash run.sh

# Run in background (2h)
nohup bash run.sh > /dev/null 2>&1 &
```

## Results

_Recorded here after clean runs._
