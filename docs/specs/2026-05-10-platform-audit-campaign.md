# Platform Audit — HIVE × Claude Code × Codex

**Date:** 2026-05-10
**Author:** Maya (with Greg)
**Status:** Campaign prime directive

## Prime Directive

Produce a baseline platform audit of HIVE's integration with its two interactive harnesses (Claude Code and Codex), then leave behind the scaffolding for a recurring monthly audit that re-runs this analysis, surfaces drift, and identifies new platform capabilities worth leveraging or extending.

We've reached rough feature parity running HIVE on Claude Code and HIVE on Codex. This audit captures the current state so we can monitor for drift, catch breaking changes early, and seize new platform capabilities as they ship.

## Deliverables

All paths relative to repo root (`/Users/mhyrr/work/hive`).

### 1. Internal attachment maps — `docs/platform-audit/baseline.md`

**Section A: HIVE → Claude Code.** Every surface where HIVE attaches to Claude Code. Cite source as `path:line`.
- SessionStart and PostCompact hook wiring (`~/.claude/hooks/load-identity.sh`, `~/.claude/settings.json`)
- MCP server registration (`hive` MCP, schemas, deferred-tool handling)
- Identity files installed (`~/.claude/CLAUDE.md` posture, project-level CLAUDE.md)
- Launch modes: append (default), `--owned`, `--bare` — what each does, where the logic lives
- OAuth path + `unset ANTHROPIC_API_KEY` policy for spawned runs
- Model pins (dispatch, heartbeat, campaign judge/executor)
- Skills/agents wiring (which agent templates ship, where they live)
- ToolSearch deferral behavior, how the SessionStart hook pre-fetches schemas
- `hive doctor` checks that touch Claude Code state

**Section B: HIVE → Codex.** Same surfaces for Codex. Cite source.
- `~/.codex/AGENTS.md` sync from `assembleIdentity()` (`src/lib/codex-wire.ts`)
- `[mcp_servers.hive]` registration in `~/.codex/config.toml`
- SessionStart hook (`~/.hive/codex-load-identity.sh`) and hooks.json wiring
- `codex_hooks` feature flag dependency
- `hive -x` launch path (`src/lib/harness.ts`, routing through Codex)
- Identity refresh / byte-equivalence check in `hive doctor`
- What `hive init` installs for a fresh Codex setup

### 2. External platform snapshots — `docs/platform-audit/baseline.md`

**Section C: Claude Code current state.** Use web research; cite sources.
- Current released version (anchor everything against it)
- Recent changelog highlights (last ~3 months): new flags, deprecations, behavior changes
- Notable features: `--bare`, `--brief`, `SendUserMessage`, ToolSearch deferral, plugin/skill system, MCP plugin changes, hooks evolution, Skill tool semantics
- Anything Anthropic has signaled is coming (deprecations, API changes)
- Stack-implication summary: of the above, what does HIVE already leverage / not leverage / risk breakage on?

**Section D: Codex current state.** Same shape for Codex. Cite sources.
- Current released version
- Recent changelog (last ~3 months)
- `codex features list` snapshot at audit time
- Hooks evolution, MCP changes, AGENTS.md semantics, session model
- Anything OpenAI has signaled
- Stack-implication summary

### 3. Compatibility matrix — `docs/platform-audit/matrix.md`

A table: rows are HIVE features (identity injection, MCP tools, dispatch, heartbeat, campaign, doctor, council, memory pipeline, etc.); columns are harnesses (Claude Code, Codex). Each cell: status (`working` / `degraded` / `gap` / `n/a`) plus a one-line note. The matrix is the at-a-glance "are we OK?" surface.

### 4. Tickets — created via HIVE MCP

Filed under the `hive` project, tagged `platform-audit`, each linked to a specific finding in the doc. Categories:
- **Gap** — platform capability HIVE doesn't leverage but probably should
- **Risk** — platform shift that could break a HIVE feature; include a mitigation sketch
- **Opportunity** — new platform feature worth exploring (lower urgency than gap)

Each ticket body must cite the section of `baseline.md` it came from.

### 5. Memory candidates — via `write_hive_memory`

Durable, non-obvious platform facts worth keeping across sessions. Examples of the shape:
- "Claude Code 2.1.x defers MCP tool schemas behind ToolSearch — sessions must pre-fetch via the SessionStart hook to make HIVE MCP tools first-touch usable."
- "Codex 0.128+ AGENTS.md is the supported identity injection path; `hive -x` no longer needs `-c instructions=`."

Skip facts already in code or git history; capture the platform behavior, the why, and how to apply.

### 6. Recurring-audit scaffolding — `docs/platform-audit/README.md`

The README documents:
- What this audit does and why (link to this spec)
- How to re-run it monthly (`hive campaign run "<prime-directive-file>"` — and where to find the next-month directive variant)
- Where each run's output lands (dated snapshots: `docs/platform-audit/YYYY-MM-DD-snapshot.md`)
- How to diff a fresh snapshot against `baseline.md` (commands; what to look for; how to file follow-up tickets)
- Suggested cron via the `/schedule` skill (first Monday of each month) — leave this as a one-shot setup instruction Greg runs in the morning, not a thing the campaign wires itself

Do not modify `~/.hive/scripts/` or install a cron — the recurrence wiring is Greg's morning step.

## Scope Fence

**In scope:**
- Claude Code (current released version) — how HIVE attaches today
- Codex (current released version) — how HIVE attaches today
- Public release notes, changelogs, official docs for both
- Source code under `src/lib/harness.ts`, `src/lib/codex-wire.ts`, `src/commands/init.ts`, `src/commands/doctor.ts`, `src/lib/identity.ts`, and related

**Out of scope:**
- Pi harness audit. Pi exists in the codebase but the Anthropic ToS question is open and Greg is researching separately. Note Pi's existence in `baseline.md` as a one-paragraph sidebar, do not audit it.
- Modifying HIVE features themselves. The audit produces tickets; tickets get worked separately.
- Cross-project HIVE deployments (briefs, resonance, etc.). Focus on this repo and what it ships.
- Implementing or running the recurring schedule. Document the setup; Greg wires it in the morning.

## Success Criteria

A fresh reader picking up cold tomorrow morning should be able to:
1. Read `docs/platform-audit/baseline.md` and understand exactly how HIVE attaches to Claude Code and Codex today, with line-cited proof
2. Read `docs/platform-audit/matrix.md` and answer "are we OK?" at a glance
3. Open the filed tickets (filter `tag:platform-audit`) and find at least one actionable gap, one risk, and one opportunity ticket
4. Read `docs/platform-audit/README.md` and run the recurring audit monthly without further briefing
5. Read recent memory entries and pick up new platform facts the audit surfaced

## Judge Guidance

This is a research + documentation campaign. Iterations should fan out across the four research workstreams (Internal-CC, Internal-Codex, External-CC, External-Codex) before converging on synthesis (matrix, tickets, README).

**Suggested iteration shape:**
- **Iter 1-2:** Internal mapping (read HIVE source, cite line numbers). Cheap, deterministic, parallel-safe.
- **Iter 3-4:** External research (web fetches for changelogs, official docs). Use research-web tool for narrow, citation-producing queries.
- **Iter 5-6:** Compose `baseline.md` integrating internal + external findings.
- **Iter 7:** Build the compatibility matrix.
- **Iter 8:** File tickets and write memory candidates.
- **Iter 9:** Write the README; finalize all docs; commit.

**Block traversal:**
- If a web source is unreliable or rate-limited, fall back to local docs and note the gap explicitly in `baseline.md`
- If a platform changelog is sparse, supplement with the project's GitHub release notes or commit history
- If the matrix is hard to fit on one page, split into per-harness sub-matrices but keep the at-a-glance summary at the top

**Council triggers:**
- If the recurring-audit shape is genuinely ambiguous (e.g., one-doc-rewritten-each-month vs dated-snapshots-with-diff), convene a council. Default is dated snapshots per the user's confirmed answer; only escalate if a real tradeoff emerges during execution.

## Definition of Done

- `docs/platform-audit/baseline.md` exists, committed, sections A-D complete with citations
- `docs/platform-audit/matrix.md` exists, committed
- `docs/platform-audit/README.md` exists, committed
- At least 3 tickets filed under `tag:platform-audit` covering gap / risk / opportunity
- At least 3 new memory candidates written via `write_hive_memory`
- All work committed to the campaign branch (campaign orchestrator manages merge separately)
- `prime_satisfied: yes` on the final judge call

## Non-Goals (Explicit)

- Not a refactor of harness wiring (audit only)
- Not a Pi audit (Pi is out of scope per scope fence)
- Not a recurrence wiring (document, don't install)
- Not a feature inventory of all of HIVE (only features that touch the harness boundary)
