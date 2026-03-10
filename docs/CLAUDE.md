# HIVE

Persistent local multi-agent orchestration. Lives at `~/.hive/`. Works across projects.
Agents are transient. The hive persists.

## Read First
`NEXT-SESSION-PROMPT.md` — the current continuity brief and next-session prompt.
`FINAL-PRD.md` — the complete PRD with architecture, memory design, and all conventions.
`PHASE-4-AUTO-LAUNCH.md` — the next-phase design for supervisor-driven auto-launch and parallel workers.

## Philosophy
- One home (`~/.hive/`), no split brain. Projects are subdirectories.
- SOUL.md is culture. SELF.md is the user. Personas are mindsets.
- BOARD.md is orchestrator-owned. Agents read it, write to msg/.
- Small models coordinate, big models create.
- `hive chat` is the meta-interface: talk to the hive about itself.
- All state on disk, all processes stateless. Kill anything, restart, resume.
- Memory is tiered: curated knowledge → accumulated learnings → raw journal.

## Stack
- **Bun + TypeScript.** Runs .ts directly. Zero npm deps. Compiles to binary.
- `bun build --compile ./bin/hive.ts --outfile hive`
- All data: Markdown with optional YAML frontmatter
- No servers, no databases, no build step beyond Bun itself

## CLI
```
# Front door — talk to the hive like a team
hive run [--interval] [--max-parallel]  # Start supervision (idempotent)
hive say <message>                      # Nudge + auto-start supervision
hive ask [question]                     # Synthesized status snapshot (no LLM)
hive watch [count]                      # Live tail of feed.md
hive stop <agent|run>                   # Signal an active supervised run

# Setup
hive init                               # Bootstrap ~/.hive/
hive project add <project> <path>       # Register a project
hive work [project]                     # Set/show active project
hive status                             # BOARD.md + open msgs
hive feed [count]                       # Recent feed entries
hive ps                                 # Active-run and recent-run inspection

# Operator escape hatches
hive supervise [--max-parallel] [--once|--detach]
hive supervise status|stop|logs
hive orchestrate [--mode interactive|loop] [--interval <seconds>] [goal]
hive chat [--runtime ...] [--dry-run] <msg>
hive launch [--runtime ...] [--dry-run] <agent> [goal]

# Primitives
hive inbox [agent]                      # Agent message queue
hive log <message>                      # Append to LOG.md
hive msg [--type] <from> <to> <body>    # Create message file
hive msg show|resolve|close ...         # Message lifecycle
hive nudge <message>                    # Human → orchestrator
hive prompt <agent-id>                  # Full prompt assembly
hive archive                            # Archive session
hive sync                               # PLAN.md → repo .hive/
hive help                               # Usage
```

## Structure
```
bin/hive.ts                  # Entry point (command router)
src/
  commands/
    run.ts                   # hive run — idempotent supervision start
    say.ts                   # hive say — nudge + auto-start supervision
    ask.ts                   # hive ask — synthesized status (no LLM)
    init.ts                  # hive init — scaffold ~/.hive/
    project.ts               # hive project add — register project state
    work.ts                  # hive work — set/show active project
    orchestrate.ts           # hive orchestrate — steward kickoff/resume prompt
    chat.ts                  # hive chat — one-shot human interface runtime call
    feed.ts                  # hive feed/watch — human event stream
    supervise.ts             # hive supervise — autonomous supervisor loop
    launch.ts                # hive launch — one-shot agent runtime call
    status.ts                # hive status — read BOARD + msg, format for terminal
    log.ts                   # hive log — append timestamped entry
    msg.ts                   # hive msg + nudge — create message files
    prompt.ts                # hive prompt — path-first compact agent prompt
    archive.ts               # hive archive — session → archive/
    sync.ts                  # hive sync — copy PLAN to repo
    ps.ts                    # hive ps — active/recent run inspection
    stop.ts                  # hive stop — signal active runs
    inbox.ts                 # hive inbox — agent message queue
    help.ts                  # hive help — usage text
  lib/
    paths.ts                 # ~/.hive/ path resolution + active project
    board.ts                 # BOARD.md signal parsing for orchestration
    digest.ts                # Compact digest generators for prompts
    feed.ts                  # feed.md formatting + append helpers
    frontmatter.ts           # YAML frontmatter parse/write (no deps)
    format.ts                # Terminal formatting (colors, tables)
    log.ts                   # Shared LOG.md append helper
    orchestrator.ts          # Steward prompt assembly + orchestration signals
    runtime.ts               # Runtime/model resolution + launcher adapters
    time.ts                  # Timestamp helpers
templates/
  SOUL.md                    # Hive soul — identity and culture
  SELF.md                    # User preferences and context
  AGENTS.md                  # Operational protocols (complement to SOUL)
  skills/
    state-efficient-ops.md   # Skill #1: token/state management patterns
  feed.md                    # Default human event feed scaffold
  config.md                  # Global config template
  project-config.md          # Per-project config template
  PLAN.md                    # Plan template
  BOARD.md                   # Board template
  LOG.md                     # Log template
  personas/                  # Default persona scaffolds
    architect.md, craftsman.md, critic.md, scout.md, steward.md
docs/
  FINAL-PRD.md
  PHASE-4-AUTO-LAUNCH.md
  CLAUDE.md
```

## Build Rules
- Zero npm dependencies. Bun built-ins only.
- No class hierarchies. Exported async functions per command.
- YAML frontmatter: split on `---`, parse `key: value` lines. No yaml lib.
- Markdown is the data model. Don't parse it into objects.
- Prompt assembly is path-first with digests. Three layers:
  1. Identity (SOUL.md inlined — always loaded)
  2. Doctrine (AGENTS.md, persona, skills — path-referenced)
  3. Context (board/message/run digests — generated fresh per prompt)
  Only SOUL.md, assignment, board digest, and agent-specific messages are inlined.
  Everything else is a path the agent reads on demand.
- Tests: `bun test`. End-to-end: create temp ~/.hive-test/, run commands,
  assert file contents.

## Implementation Status
- Phase 1 core primitives: implemented
- Phase 2 orchestrator prompt assembly: implemented
- Phase 3: feed/watch, `hive chat`, one-shot `hive launch` — implemented
- Phase 4: run records, `hive ps`, `hive stop`, worker auto-launch, restart recovery, detached supervisor start/status/stop/logs — implemented
- Prompt compaction: path-first assembly with digests, SOUL/AGENTS split, skills infrastructure — implemented
- Front door: `hive run`, `hive say`, `hive ask` — implemented
- Skills system: `~/.hive/skills/` with `state-efficient-ops` as skill #1 — implemented
- Next: deeper supervision ergonomics, richer human modes, transport adapters, curate, memory intelligence
