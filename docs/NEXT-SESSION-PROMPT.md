# Next Session Prompt

Use this prompt at the start of the next HIVE implementation session.

```md
You are continuing work on HIVE in `/Users/mhyrr/work/hive`.

Read first:
- `docs/NEXT-SESSION-PROMPT.md`
- `docs/FINAL-PRD.md`
- `docs/PHASE-4-AUTO-LAUNCH.md`
- `docs/CLAUDE.md`
- `AGENTS.md`

## What HIVE Is

HIVE is a persistent, local-first multi-agent orchestration system.

Core thesis:
- files are the API
- all durable state lives on disk
- agents are disposable
- the hive persists across projects

Current implementation is Bun + TypeScript, zero npm dependencies, markdown as
the source of truth, and one-file-per-message coordination in `~/.hive/msg/`.

## Where We Are Right Now

Phase 4 is materially working.

Implemented:
- run ledger under `projects/<project>/runs/`
- `hive launch`
- `hive supervise`
- worker auto-launch from assignment messages
- scope-aware parallel dispatch
- `hive ps`
- `hive stop`
- restart recovery for stale `runs/active/`
- durable cancellation intent across supervisor restart
- detached/background supervision control via:
  - `hive supervise --detach`
  - `hive supervise status`
  - `hive supervise stop`
  - per-project detached supervisor state + log files

Observed live behavior:
- `hive nudge ...` works
- `hive supervise --once --max-parallel N` runs real steward passes
- workers can auto-launch when open `assign` messages exist
- the current dogfood project can sit idle cleanly when there is nothing to do
- detached/background supervision has now landed in code and tests

Important reality:
- the system works technically, but the user-facing shape is still too
  operator-heavy
- prompt assembly is still too token-expensive

## The Product Goal

The user does not want to think about supervision internals.

The desired experience is closer to:
- `hive run`
- `hive say "build this"`
- `hive ask "how is it going?"`
- `hive watch`
- `hive stop`

The user should be able to talk to the hive supervisor and let it run the team.

Low-level commands like `supervise`, `launch`, `prompt`, and `ps` should remain
available, but they are implementation detail and operator escape hatches, not
the primary product.

## The New Architecture Direction

The current identity split is not quite right.

Going forward, separate it into:

1. `SOUL.md`
- very small
- identity, values, culture, tone
- loaded every session
- should stay compact

2. `SELF.md`
- user-specific preferences, working relationship, decision heuristics
- loaded every session
- should also stay compact and curated

3. `AGENTS.md`
- operational working patterns that currently live in `SOUL.md`
- how agents read state, communicate, hand off, log, and self-correct
- this is where the durable "how we work" rules belong

The current `SOUL.md` is doing too much. It should be split so identity stays
small and operational doctrine moves into `AGENTS.md`.

## Skills Direction

Add a first-class `skills/` concept to HIVE.

Reason:
- Codex and Claude both support skill-like local instruction bundles
- HIVE should be able to accumulate reusable capabilities for itself and for
  projects

Requirements:
- skills directory should be extendable
- skills must be usable both by the hive itself and by project agents
- skills should be plain files/directories, not a database concept

The first HIVE-native skill should be:

### `state-efficient-ops`

Purpose:
- teach agents to manage HIVE state without wasting tokens

This skill should encode patterns like:
- use `tail` for append-only files like `LOG.md`, `feed.md`, journals
- use `rg`/`grep` to find the exact section or key, not read whole files
- read message headers first, then full bodies only when relevant
- prefer path-first prompts over inlined markdown blobs
- use compact board summaries before expanding into raw files
- only load recent run results, not the entire run history
- treat large markdown files as searchable stores, not prompt cargo

This skill is not optional polish. It is required for HIVE to scale.

## Token Strategy: What Must Change

The current prompt strategy is too expensive.

Right now the system often inlines:
- `SOUL.md`
- `SELF.md`
- `PLAN.md`
- `BOARD.md`
- `LOG.md`
- open messages

That was acceptable for bootstrap and debugging. It is not acceptable as the
steady-state runtime model.

New direction:

1. Path-first prompts
- prompts should mostly provide:
  - identity digest
  - assignment or goal
  - compact state summary
  - absolute file paths
  - instructions on what to read first
- only inline small, high-signal curated content

2. Compact runtime digests
- generate compact runtime forms for:
  - soul
  - self
  - board
  - recent logs
  - recent run results
- do not inject full raw files unless specifically needed

3. Search-before-read discipline
- agents should search for what matters, then load only the relevant slice
- do not spoon-feed the whole hive repeatedly

4. Append-only efficiency
- for logs, feeds, and journals, prefer the tail and recent-window model
- never reload long append-only files in full by default

This is a major next priority. If prompt cost is not reduced, HIVE will become
fragile and expensive before it becomes broadly useful.

## Immediate Build Priorities

Continue Phase 4, but do it in service of the actual product:

### Phase 4 next
1. Detached/background supervision refinements
- add `hive supervise logs`
- improve detached status visibility and quiet/debug modes
- keep the current loop implementation; do not invent a separate daemon

2. Supervisor ergonomics
- quiet/default operator mode
- debug/log mode
- better active run inspection

### Immediately after that
3. Prompt compaction
- split `SOUL.md` / `SELF.md` / `AGENTS.md`
- add compact runtime digests
- reduce inlined markdown drastically

4. User-facing front door
- introduce:
  - `hive run`
  - `hive say`
  - `hive ask`
- these should wrap the existing engine
- `supervise`, `launch`, `prompt`, and `chat` become lower-level surfaces

### Then
5. Skills
- add HIVE-managed `skills/`
- implement the first `state-efficient-ops` skill
- make agents and the hive itself use it

## Constraints

Do not regress these architectural rules:
- files remain the source of truth
- no database as a new source of truth
- no background server requirement
- one writer per file
- markdown remains primary state representation
- zero npm deps unless there is a strong, explicit reason

Do not optimize for framework cleverness.
Optimize for:
- inspectability
- resumability
- low token usage
- simple human interaction

## Current User Preference

The user is explicitly saying:
- stop optimizing around operator complexity
- optimize for “I talk to the hive and it handles the rest”
- reduce token waste aggressively
- keep moving fast, but preserve the architecture’s core discipline

## Recommended Next Task

Implement the next Phase 4 slice as:

1. background/detached supervision control plane
2. then prompt compaction with the `SOUL.md` / `SELF.md` / `AGENTS.md` split
3. then the first user-facing wrapper commands: `hive run`, `hive say`, `hive ask`

When in doubt, choose the path that makes HIVE feel less like a toolbox and
more like a real team.
```
