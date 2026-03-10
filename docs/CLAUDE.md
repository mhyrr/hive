# HIVE

Persistent local multi-agent orchestration. Lives at `~/.hive/`. Works across projects.
Agents are transient. The hive persists.

## Read First
`FINAL-PRD.md` — the complete PRD with architecture, memory design, and all conventions.

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
hive init                        # Bootstrap ~/.hive/
hive project add <project> <path># Register a project
hive work [project]              # Set/show active project
hive orchestrate [--mode interactive|loop] [--interval <seconds>] [goal]
                                # Steward/orchestrator prompt assembly
hive status                      # BOARD.md + open msgs
hive log <message>               # Append to LOG.md
hive msg <from> <to> <body>      # Create message file
hive nudge <message>             # Human → orchestrator
hive prompt <agent-id>           # Full prompt assembly
hive chat                        # Meta-interface (Phase 3)
hive curate                      # Memory curation (Phase 4)
hive archive                     # Archive session + curate
hive sync                        # PLAN.md → repo .hive/
hive help                        # Usage
```

## Structure
```
bin/hive.ts                  # Entry point (command router)
src/
  commands/
    init.ts                  # hive init — scaffold ~/.hive/
    project.ts               # hive project add — register project state
    work.ts                  # hive work — set/show active project
    orchestrate.ts           # hive orchestrate — steward kickoff/resume prompt
    status.ts                # hive status — read BOARD + msg, format for terminal
    log.ts                   # hive log — append timestamped entry
    msg.ts                   # hive msg + nudge — create message files
    prompt.ts                # hive prompt — assemble soul+self+persona+context
    archive.ts               # hive archive — session → archive/
    sync.ts                  # hive sync — copy PLAN to repo
  lib/
    paths.ts                 # ~/.hive/ path resolution + active project
    board.ts                 # BOARD.md signal parsing for orchestration
    frontmatter.ts           # YAML frontmatter parse/write (no deps)
    format.ts                # Terminal formatting (colors, tables)
    log.ts                   # Shared LOG.md append helper
    orchestrator.ts          # Steward prompt assembly + orchestration signals
    time.ts                  # Timestamp helpers
templates/
  SOUL.md                    # Default soul scaffold
  SELF.md                    # Template for user preferences
  config.md                  # Global config template
  project-config.md          # Per-project config template
  PLAN.md                    # Plan template
  BOARD.md                   # Board template
  LOG.md                     # Log template
  personas/                  # Default persona scaffolds
    architect.md
    craftsman.md
    critic.md
    scout.md
    steward.md
docs/
  FINAL-PRD.md
  CLAUDE.md
```

## Build Rules
- Zero npm dependencies. Bun built-ins only.
- No class hierarchies. Exported async functions per command.
- YAML frontmatter: split on `---`, parse `key: value` lines. No yaml lib.
- Markdown is the data model. Don't parse it into objects.
- `hive prompt` is the most critical command. It assembles the full agent
  identity: SOUL.md + SELF.md + persona + project config + PLAN.md + BOARD.md.
  This prompt IS the agent. Get it right.
- Tests: `bun test`. End-to-end: create temp ~/.hive-test/, run commands,
  assert file contents.

## Phase 1 Scope (Build This Now)
Commands: init, project add, work, status, log, msg, nudge, prompt, archive, sync, help.
Templates: SOUL.md, SELF.md, all 5 personas, project scaffolding.
Skip for now: chat, curate (Phase 3-4). The orchestrator runs as a Claude
Code session with the steward persona prompt, not as hive-managed process.
