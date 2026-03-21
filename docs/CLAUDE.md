# HIVE

Persistent local multi-agent orchestration. Lives at `~/.hive/`. Works across projects.
Agents are transient. The hive persists.

## Read First
`CORE-LOOP-CONSOLIDATION.md` — the watcher-based coordination architecture replacing the old 30s poll.
`PERSISTENT-STEWARD-DESIGN.md` — persistent steward runtime: session lifecycle, state monitor, structured derived state.
`COGNITIVE-RESOURCE-MANAGEMENT.md` — cognitive routing policy: how tasks are routed across model tiers.
`FINAL-PRD.md` — the complete PRD with architecture, memory design, and all conventions.
`SIMPLIFY-COMMAND-SURFACE.md`, `SIMPLIFY-STATE-DECOMPOSITION.md`, `SIMPLIFY-STEWARD-UNIFICATION.md` — current simplification targets.

## Philosophy
- One home (`~/.hive/`), no split brain. Projects are subdirectories.
- SOUL.md is culture. IDENTITY.md is the hive. SELF.md is the user. Personas are mindsets.
- BOARD.md is orchestrator-owned. Agents read it, write to msg/.
- Small models coordinate, big models create.
- `hive say` is the one-shot steward interface. `hive console` is the interactive session.
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
hive say [--runtime] [--model] <message>  # Send a message to the steward
hive watch [count] [--interval] [--once]  # Live operator console
hive console [--runtime] [--model]      # Interactive session with the hive (tracked in run ledger)
hive stop <agent|run>                   # Signal an active supervised run (advisory for console)

# Setup
hive init                               # Bootstrap ~/.hive/
hive project add <project> <path>       # Register a project
hive work [project]                     # Set/show active project
hive status                             # BOARD.md + open msgs
hive feed [count]                       # Recent feed entries
hive ps                                 # Active-run and recent-run inspection

# Gateway — web interface
hive gateway [--port] [--open]         # Start Gateway server (localhost:4200)
hive gateway status                    # Show Gateway state
hive gateway stop                      # Stop Gateway server
hive runtimes                          # List installed runtime adapters

# Operator escape hatches
hive supervise [--max-parallel] [--once|--detach]
hive supervise status|stop|logs
hive launch [--runtime ...] [--dry-run] <agent> [goal]

# Primitives
hive inbox [agent]                      # Agent message queue
hive log <message>                      # Append to LOG.md
hive msg [--type] <from> <to> <body>    # Create message file
hive msg show|resolve|close ...         # Message lifecycle
hive msg nudge <message>                # Human → steward (alias: hive nudge)
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
    say.ts                   # hive say — send a message to the steward
    console.ts               # hive console — interactive LLM session
    init.ts                  # hive init — scaffold ~/.hive/
    project.ts               # hive project add — register project state
    work.ts                  # hive work — set/show active project
    feed.ts                  # hive feed + live watch console
    supervise.ts             # hive supervise — autonomous supervisor loop
    launch.ts                # hive launch — one-shot agent runtime call
    status.ts                # hive status — read BOARD + msg, format for terminal
    log.ts                   # hive log — append timestamped entry
    msg.ts                   # hive msg (show/resolve/close/nudge) — message lifecycle
    prompt.ts                # hive prompt — path-first compact agent prompt
    archive.ts               # hive archive — session → archive/
    sync.ts                  # hive sync — copy PLAN to repo
    ps.ts                    # hive ps — active/recent run inspection
    stop.ts                  # hive stop — signal active runs
    inbox.ts                 # hive inbox — agent message queue
    help.ts                  # hive help — usage text
    gateway.ts               # hive gateway — start/stop/status Gateway server
    runtimes.ts              # hive runtimes — list installed runtime adapters
    memory.ts                # hive memory — project memory management
  gateway/
    server.ts                # Bun.serve() HTTP + WebSocket server
    routes.ts                # REST API handlers → existing command functions
    watcher.ts               # File watcher → WebSocket event broadcast
    static/
      index.html             # Three-pane web UI layout
      style.css              # Dark terminal aesthetic, CSS custom properties
      app.js                 # REST client, WebSocket, DOM rendering
  lib/
    paths.ts                 # ~/.hive/ path resolution + active project
    board.ts                 # BOARD.md signal parsing for orchestration
    digest.ts                # Compact digest generators for prompts
    feed.ts                  # feed.md formatting + append helpers
    frontmatter.ts           # YAML frontmatter parse/write (no deps)
    format.ts                # Terminal formatting (colors, tables)
    log.ts                   # Shared LOG.md append helper
    orchestrator.ts          # Steward prompt assembly + orchestration signals
    runtime.ts               # Runtime adapter registry + launcher dispatch
    time.ts                  # Timestamp helpers
templates/
  SOUL.md                    # Hive soul — shared culture and standards
  IDENTITY.md                # Hive identity — what the hive is
  SELF.md                    # User preferences and context
  AGENTS.md                  # Operational protocols (complement to SOUL)
  skills/
    state-efficient-ops.md   # Skill #1: token/state management patterns
    autonomous-ops.md        # Skill #2: initiative patterns for autonomous operation
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
  interaction.md
  CLAUDE.md
```

## Build Rules
- Zero npm dependencies. Bun built-ins only.
- No class hierarchies. Exported async functions per command.
- YAML frontmatter: split on `---`, parse `key: value` lines. No yaml lib.
- Markdown is the data model. Don't parse it into objects.
- Prompt assembly is path-first with digests. Three layers:
  1. Shared culture (SOUL.md inlined — always loaded)
  2. Identity and doctrine (IDENTITY.md, AGENTS.md, persona, skills — path-referenced)
  3. Context (board/message/run digests — generated fresh per prompt)
  Only SOUL.md, assignment, board digest, project memory, and agent-specific messages are inlined.
  Everything else is a path the agent reads on demand.
- Prompts encode INITIATIVE, not just capability. Agents record decisions,
  conventions, and facts as they work — without being told. The console
  prompt positions the agent as the hive mind, not a tool.
- Tests: `bun test`. End-to-end: create temp ~/.hive-test/, run commands,
  assert file contents.

## Implementation Status
- Phase 1 core primitives: implemented
- Phase 2 orchestrator prompt assembly: implemented
- Phase 3: feed/watch, one-shot `hive launch` — implemented
- Phase 4: run records, `hive ps`, `hive stop`, worker auto-launch, restart recovery, detached supervisor start/status/stop/logs — implemented
- Prompt compaction: path-first assembly with digests, SOUL/AGENTS split, skills infrastructure — implemented
- Front door: `hive run`, `hive say` — implemented
- Skills system: `~/.hive/skills/` with `state-efficient-ops` as skill #1 — implemented
- Interactive console: `hive console` — persistent LLM session with full hive context — implemented
- Phase 4 validation: scope conflict tests, one-run-per-assignment safety, manual launch adoption — implemented
- Autonomous initiative: autonomous-ops skill, initiative-driven prompts, console as hive mind — implemented
- Console run-ledger integration: console tracked as session in run ledger, supervisor ignores for scope/parallel, stop advisory, LLM-powered ask — implemented
- Phase 5 Step 1: runtime adapter registry — claude/codex/gemini adapters, `hive runtimes` — implemented
- Phase 5 Steps 2-4: Gateway HTTP server, WebSocket feed streaming, web UI shell — implemented
- Phase 5 Step 5: console session persistence — file-backed sessions, /api/console/send, /api/console/new, /api/sessions — implemented
- Phase 5 Step 6: full web console — session controls, agent overview dropdown, textarea input, thinking animation, keyboard shortcuts, session list sidebar — implemented
- Phase 5: complete
