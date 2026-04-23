# Pi migration verification

Experiments that gate the HIVE-on-Pi migration. Each maps to a
verification in `docs/specs/2026-04-22-hive-on-pi-design.md` §6.

## Prerequisites

- `pi` CLI installed (confirmed at `0.58.1` when these were authored).
- `pi /login` completed so `~/.pi/agent/auth.json` contains
  subscription OAuth tokens. `wc -c < ~/.pi/agent/auth.json` should
  return >50 bytes (empty file is `{}` = 2 bytes).
- Repo worktree on branch `pi`.

## Experiments

| ID | Title | Status | Gate type |
|---|---|---|---|
| V1 | Cache architecture end-to-end | **PASSED 2026-04-23** | Architectural |
| V4 | Subscription OAuth under load | Scaffolded | **Hard stop** if fails |

Other verifications in §6 (V2 RPC streaming, V3 heterogeneous subagents,
V5–V10) are scaffolded as they come up — V1 and V4 are the only gates
that could invalidate the architecture, so they go first.

## How results get recorded

Each experiment writes machine-readable results to `<exp>/runs/*.json`
and a human summary to `<exp>/README.md` under "Results". The README is
what we reference from the spec.
