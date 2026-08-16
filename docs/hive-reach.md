# HIVE Reach

How HIVE's value — identity, MCP tools, project scope — lands in each
supported interactive runtime. The harness is the carrier; the cargo is
HIVE.

This is the closing artifact for the HIVE-reach epic (TK-065). For the
deep dive on identity injection itself, see
`docs/identity-injection.md`.

## The Three Questions

For any runtime HIVE supports, the test is:

1. **Identity** — does the canonical prefix (soul stack + project memory
   + stack hint + taste) load when you launch this runtime?
2. **MCP tools** — do the `hive_*` tools (memory, tickets, council,
   status) reach this runtime, or is there a workable substitute?
3. **Project scope** — does the active project resolve from `$PWD` the
   same way it does in Claude Code?

True parity isn't the goal. Reach is.

## Reach Matrix

| | Claude Code (`hive`) | Pi (`hive -3`) | Codex (`hive -x`) |
| --- | --- | --- | --- |
| **Identity** | ✓ SessionStart + PostCompact hook (`~/.claude/hooks/load-identity.sh`) | ✓ Generated `pi -e` extension per launch | ✓ `~/.codex/AGENTS.md`, refreshed pre-launch and by Codex SessionStart hook |
| **MCP tools** | ✓ Native (`hive` MCP server) | ~ Via `pi-mcp-adapter` (install once, register in `~/.pi/agent/mcp.json`); names appear prefixed (`hive_hive_status` etc.) | ✓ Native via `[mcp_servers.hive]` in `~/.codex/config.toml` |
| **Project scope** | ✓ Resolved from `$PWD` against registered project paths | ✓ Same | ✓ Same — `hive -x` re-resolves before each launch so AGENTS.md reflects current cwd |
| **Council (`convene_council`)** | ✓ via MCP | ✓ via adapter | ✓ via MCP |
| **Doctor coverage** | ✓ `Identity`, `Hooks`, `MCP` groups | ✓ Pi group (warnings; Pi is optional) | ✓ Codex group (warnings; AGENTS freshness vs. `hive identity emit`) |
| **Nightly transcript ingestion** | ✓ `~/.claude/projects/*/sessions` | n/a — Pi sessions not currently extracted | ✓ `~/.codex/sessions/YYYY/MM/DD` |

Cells marked `~` are partial: functional but with friction worth
naming. Cells marked `n/a` are intentional non-goals (see below).

## What `hive init` wires

| Artifact | Claude Code | Pi | Codex |
| --- | --- | --- | --- |
| Identity hook / file | `~/.claude/hooks/load-identity.sh` + `~/.claude/settings.json` | (generated per-launch) | `~/.codex/AGENTS.md` + `~/.hive/codex-load-identity.sh` + `~/.codex/hooks.json` |
| MCP registration | (built-in to Claude Code) | `~/.pi/agent/mcp.json` | `[mcp_servers.hive]` in `~/.codex/config.toml` |

All entries are best-effort and idempotent: missing runtimes are
skipped silently, existing entries are preserved. `hive doctor`
verifies each.

## Documented Non-Goals

These are intentional. They are not on a roadmap.

- **Watch Act stays Claude-Code-only.** Act leans on worktrees + Claude
  Code's branch-executor session shape. Re-implementing it for Pi or Codex
  would duplicate the executor without adding interactive reach.
- **Pi nightly transcript ingestion is not on the roadmap.** Pi
  sessions don't write a stable per-session transcript file the way
  Claude Code and Codex do. If they start to, this becomes trivial.
- **Skills don't transfer between harnesses.** Claude Code skills,
  Codex's skill-equivalent, and Pi's extension surface are different
  loading mechanisms. HIVE doesn't try to abstract them; the stack
  hint in identity is the shared substitute and points each runtime
  at the right loading mechanism.

## Open Question (Pi)

The Pi opt-in lane stays opt-in (`hive -3` / `--pi` /
`HIVE_HARNESS=pi`) while the Anthropic ToS / subscription-OAuth
question remains open. Technical reach is shipped — Pi launches with
HIVE identity, MCP registers, doctor covers wiring. Default routing
flips when (and if) the policy clears.

## Related

- `docs/identity-injection.md` — emit order, cache stability, drift
  detection, "Maya feels cold" runbook
- `docs/memory-architecture.md` — what project memory is and how it's
  resolved
- TK-065 — the epic this doc closes
