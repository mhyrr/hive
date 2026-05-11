# Platform Audit — Recurring Monthly Review

## What This Is

A monthly audit of how HIVE integrates with its interactive harnesses (Claude Code and Codex). The audit captures the current state of platform attachments, surfaces drift from the baseline, and identifies new platform capabilities worth leveraging or risks worth mitigating.

**Prime directive:** [CAMP-006 specification](../../campaigns/CAMP-006/prime-directive.md) (if available) or the campaign goal text that initiated this audit.

## Files

| File | Purpose |
|------|---------|
| `baseline.md` | The canonical attachment map. Sections A-B cover HIVE's internal wiring to each harness (line-cited). Sections C-D cover external platform state (versions, changelogs, signals). Updated in place each month. |
| `matrix.md` | At-a-glance compatibility matrix. Rows = HIVE features, columns = harnesses. Status: working / degraded / gap / n/a. |
| `YYYY-MM-DD-snapshot.md` | Dated snapshot from each monthly run. Diffs against `baseline.md` to surface drift. |
| `README.md` | This file. How to run the audit and what to look for. |

## How to Run the Monthly Audit

### Option A: Campaign (recommended)

```bash
hive campaign run "Run the monthly platform audit per docs/platform-audit/README.md"
```

The campaign orchestrator will fan out research, update baseline.md, rebuild the matrix, file tickets for new findings, and produce a dated snapshot.

### Option B: Interactive session

Start a HIVE session and walk through the checklist manually:

```bash
hive
```

Then ask Maya to run the platform audit checklist below.

### Option C: Scheduled (first Monday of each month)

Use the `/schedule` skill in a Claude Code session to set up a recurring run:

```
/schedule "Run monthly platform audit per docs/platform-audit/README.md" --cron "0 9 * * 1" --week-of-month 1
```

This is a one-time setup step. Greg wires this in the morning — the audit does not install its own schedule.

## Monthly Checklist

### 1. Version check

```bash
claude --version
codex --version 2>/dev/null
codex features list 2>/dev/null
```

Compare against versions in `baseline.md` header. If either has changed, the audit has new ground to cover.

### 2. Internal attachment map (Sections A-B)

Re-verify line citations in Sections A and B against current source. Key files to check:

- `src/lib/identity-hook-template.ts` — hook template
- `src/commands/init.ts` — installation logic
- `src/commands/doctor.ts` — doctor checks
- `src/lib/harness.ts` — launch mode routing
- `src/lib/codex-wire.ts` — Codex wiring
- `src/mcp-server.ts` — MCP tool registrations
- `src/lib/identity.ts` — identity assembly
- `src/commands/dispatch.ts` — dispatch wiring
- `src/commands/heartbeat.ts` — heartbeat wiring
- `src/lib/orchestrator.ts` — campaign orchestrator

If line numbers have shifted due to code changes, update the citations.

### 3. External platform state (Sections C-D)

Research current versions and changelogs for both platforms:

- **Claude Code:** Check [GitHub releases](https://github.com/anthropics/claude-code/releases), [official changelog](https://code.claude.com/docs/en/whats-new), and Anthropic announcements.
- **Codex:** Check [GitHub releases](https://github.com/openai/codex/releases), [official changelog](https://developers.openai.com/codex/changelog), and OpenAI announcements.

For each platform, note: new features, deprecations, behavior changes, and signals about future direction.

### 4. Update baseline.md

Incorporate findings from steps 2-3. Update Sections A-D with new citations, version numbers, and platform state.

### 5. Rebuild matrix.md

Review each row of the compatibility matrix against new findings. Update status cells and notes. Add new rows for newly discovered attachment surfaces or platform capabilities.

### 6. Produce dated snapshot

```bash
cp docs/platform-audit/baseline.md docs/platform-audit/$(date +%Y-%m-%d)-snapshot.md
```

### 7. Diff against previous baseline

```bash
diff docs/platform-audit/YYYY-MM-DD-snapshot.md docs/platform-audit/baseline.md
```

Or for a more readable diff:

```bash
git diff HEAD -- docs/platform-audit/baseline.md
```

**What to look for in the diff:**
- Version bumps (new platform releases since last audit)
- New deprecation warnings (features HIVE depends on being sunset)
- Line citation shifts (code moved but wiring unchanged — cosmetic)
- New features added to "not leveraged" tables (worth evaluating)
- Status changes in the matrix (working → degraded, gap → working, etc.)

### 8. File tickets

For each actionable finding, file a ticket via HIVE MCP:

- **Risk** — Platform shift that could break a HIVE feature. Include mitigation sketch. Tag: `platform-audit`, `risk`.
- **Gap** — Platform capability HIVE doesn't leverage but probably should. Tag: `platform-audit`, `gap`.
- **Opportunity** — New platform feature worth exploring (lower urgency). Tag: `platform-audit`, `opportunity`.

Each ticket body must cite the section of `baseline.md` it came from.

### 9. Write memory candidates

Queue durable platform facts via `write_hive_memory`. Skip facts already in code or git history — capture platform behavior, the why, and how to apply.

### 10. Commit

```bash
git add docs/platform-audit/
git commit -m "docs(platform-audit): monthly audit $(date +%Y-%m-%d)"
```

## Viewing Past Audit Tickets

```bash
hive ticket list --tags platform-audit
```

## History

| Date | Auditor | Baseline Versions | Key Findings |
|------|---------|-------------------|--------------|
| 2026-05-11 | Maya (CAMP-006) | CC 2.1.138, Codex 0.128.0 | alwaysLoad gap (TK-106), codex_hooks deprecation (TK-107), plugin packaging opportunity (TK-108), model pin bump planning (TK-105, P3). Iter 3 corrected model retirement claim — Opus 4.6 is Active until Feb 2027, not retiring June 15. |
