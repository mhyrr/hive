# ~/.hive/watches/

Everything watch-related lives here. Full reference: `docs/watches.md` in the
HIVE repo.

## Layout

- `*.md` — fleet specs. **Each file IS a standing question**: frontmatter
  declares cadence/scope/autonomy, the body is the prompt core. Act and Propose
  fan out to every registered project at discovery (one evaluation per
  colony, same file). Observe stays cross-project. Drop a new file here and
  it's live at the next hourly tick. (This README is skipped.)
- `~/.hive/projects/<p>/watches/*.md` — watches scoped to one project.
- `state.json` — per-watch tick state: last run, last outcome, last-seen
  delta fingerprints, log-only usage. `lastTick` at the top is the hourly
  tick's liveness stamp.
- `log/<date>/<watch>-<time>.md` — **one file per model invocation**, with
  the exact system prompt, the full assembled digest + standing question
  that was sent, and the raw output (or error). No-delta ticks make no model
  call, so they write nothing here. This is the audit trail: if a watch
  surfaced something, the complete prompt that produced it is in this folder.

## Watch file format

```markdown
---
name: my-question       # defaults to filename
cadence: @morning       # 2h | 45m | 1d | @nightly | @morning | mon,thu
scope: tickets, commits # tickets|commits|transcripts|memory|inbox|runs
model: standard         # fast | standard | judgment (aliases, never raw IDs)
venue: inbox            # inbox | briefing | tickets | act
autonomy: observe       # observe | propose | act
enabled: true
---

The standing question, in plain language.
```

Evidence spans the previous settled tick through the current tick. A 6h
watch normally sees six hours; if launchd wakes late, it sees the full late
interval instead of dropping activity. Errors and quota deferrals do not move
the cursor.

The installed cycles are `act` (6h), `propose` (`@nightly`), and `observe`
(3d). Act creates a local review branch only; it never merges or pushes, and
it requires `watches.max_autonomy: act` in config.

## Control

```
hive watch list | status
hive watch ceiling observe|propose|act
hive watch run --due | run <name>
hive watch on|off <name> | off --all
hive watch set <name> k=v
```

Global kill-switch/ceiling: `watches.max_autonomy: observe|propose|act` in
`~/.hive/config.md` (default propose). Dashboard: `/watches`.
