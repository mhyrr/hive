# Watches

Watches are standing questions evaluated against activity since their previous
settled tick (TK-138). The three installed cycles use the same names as their
autonomy levels: Observe, Propose, and Act.

## The primitive

A watch is a Markdown file. Its body is the standing question; frontmatter
declares when it runs, what evidence it reads, where its result goes, and what
it may do.

- `~/.hive/watches/*.md` — cross-project watches
- `~/.hive/projects/<project>/watches/*.md` — project-scoped watches

```markdown
---
name: propose
cadence: @nightly       # 2h | 45m | 1d | @nightly | @morning | mon,thu
scope: runs, tickets    # tickets | commits | transcripts | memory | inbox | runs
model: judgment         # fast | standard | judgment
venue: briefing         # inbox | briefing | tickets | act
autonomy: propose       # observe | propose | act
enabled: true
---

The standing question, in plain language.
```

Drop a file into a watches directory and it is live at the next eligible
tick. A malformed file produces a warning without stopping the fleet.
`README.md` is skipped.

## The three cycles

### Act — every 6 hours

Act asks whether one eligible ticket is a clear, valuable follow-on to recent
work. Deterministic code first excludes closed or in-progress tickets, P0s,
epics, bodyless tickets, `needs-greg`, unresolved dependencies, projects with
no valid repository/main ref, and tickets owned by another run. The judgment
model may select at most one shortlisted ticket.

A selected ticket is revalidated under an Act lock, claimed with the run
ID, and opened in an explicit feature branch based on `main`. The executor
plans, builds, verifies, and commits there. It never merges, pushes, closes the
ticket, or removes the worktree. A successful run ends as `review_ready`; the
ticket stays `in_progress` for human review. Preparation or execution failure
can release only the claim owned by that run.

Act is enabled in its file but requires the explicit global ceiling
`watches.max_autonomy: act`. The default ceiling is `propose`.

### Propose — nightly

Propose runs inside the nightly orchestrator after that night's evidence has
landed. It asks for the smartest, most radically innovative, accretive,
useful, and compelling additions suggested by the work. It may return one,
several, or none; there is no quota. Each proposal cites its signal, explains
what it compounds and what it costs, and names the first concrete step.

Its artifact is `runs/{DATE}/propose.md`, rendered beside the morning
briefing when non-empty.

### Observe — every 3 days

Observe reads recent transcripts and memory across active projects. It asks
what Greg may not see and which threads connect across sessions or projects.
It may surface one, several, or no connections. It stays abstract: it
interprets and opens questions without turning them into proposed work.

Its output goes to `~/.hive/inbox.md`.

## Tick-correlated evidence

Evidence spans the previous settled tick through the current tick. A 6-hour
watch normally sees six hours. If launchd wakes two hours late, the next Act
cycle sees eight hours; it does not silently lose the gap. On a first run,
the interval is one cadence period (24 hours for calendar cadences).

`surfaced`, `quiet`, and `no-delta` settle the cursor. Errors, quota
deferrals, and call-cap deferrals do not, so the same interval is retried.
The standing question may use `{{interval}}`; the runner replaces it with
the actual elapsed duration.

One hourly launchd job (`com.hive.watches`) runs `hive watch run --due` for
interval and calendar watches. `@nightly` watches are invoked by the nightly
orchestrator after its other tracks complete. `hive watch run <name>` is an
operator-forced run and bypasses due-ness and the delta gate.

## Delta gate and digest

Before any model call, deterministic local checks decide whether something in
scope changed. Tickets, memory, and inbox use content fingerprints. Commits,
transcripts, and nightly runs use monotonic watermarks. With no delta, the
cycle spends no tokens.

The digest then assembles only evidence inside the tick interval. Cross-project
watches rank projects by commits + 2×sessions + tickets moved, expanding the
five warmest. Act considers warm projects only. Source tags are qualified and
citable:

- `[T:project/TK-001]` — ticket activity
- `[A:project/TK-001]` — Act-eligible ticket
- `[C:project/abc123]` — commit
- `[S:project/session.jsonl]` — transcript
- `[M:project/knowledge]`, `[I:project]`, `[R:date/briefing]` — other sources

The digest is the model's entire evidence base. Every material conclusion
must cite a tag. Output with no valid tag is dropped. `NO_SIGNAL` is a normal,
logged answer and writes nothing to a venue.

Only one watch cycle may run at a time. The lease prevents hourly, nightly,
and manual invocations from overwriting one another's state.

## Autonomy

- `observe` interprets evidence and connects threads. It may not recommend
  actions or change state.
- `propose` recommends every item that clears the bar, without a quota. It
  may not execute or change state.
- `act` may start only a deterministically eligible ticket on an
  isolated review branch.

The global ceiling is `watches.max_autonomy: observe|propose|act` in
`~/.hive/config.md`; missing or invalid values default to `propose`. A watch
above the ceiling runs at the lower level and cannot execute work.

## Model calls and quota

Watch files use tier aliases resolved by `src/lib/watch-model.ts`:

| Alias | Default | Override |
| --- | --- | --- |
| `fast` | `claude-haiku-4-5` | `HIVE_WATCH_MODEL_FAST` |
| `standard` | `claude-sonnet-5` | `HIVE_WATCH_MODEL_STANDARD` |
| `judgment` | `claude-opus-4-8` | `HIVE_WATCH_MODEL_JUDGMENT` |

`HIVE_WATCH_MODEL_<NAME>` overrides one named watch. Each evaluation makes at
most one model call. `HIVE_WATCH_MAX_CALLS_PER_TICK` defaults to four and is a
backstop, not a token budget. Rate-limit errors settle nothing and are retried
on the next tick without an immediate retry storm.

## Files and control surface

- `~/.hive/watches/state.json` — cursors, outcomes, fingerprints, and logged
  usage
- `~/.hive/watches/log/<date>/<watch>-<time>.md` — exact system prompt,
  digest/question, output or error for every model call
- `~/.hive/runs/RUN-*/run.json` — structured Act run ownership, branch,
  workspace, base SHA, source watch, and review completion mode

Historical `bets` and `muse` files are retired to `.legacy` by `hive init`;
their state cursors move to `propose` and `observe`, and their invocation logs
remain visible through read-only aliases. The old Act venue name `dispatch`
is rewritten to `act`; the parser also accepts it until that migration runs.

```text
hive watch list
hive watch status
hive watch ceiling observe|propose|act
hive watch run --due
hive watch run <name>
hive watch on|off <name>
hive watch off --all
hive watch set <name> k=v ...
```

The dashboard exposes `/watches` for fleet state and latest outputs, plus
`/watches/<name>` for the live system prompt and exact invocation history.
The main page renders the latest non-empty Propose artifact after the briefing.
