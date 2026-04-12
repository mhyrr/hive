# Hive

The AI agent ecosystem has claws, hippos, and filing cabinets. Most
of them want to own your stack — databases, embedding servers, hook
frameworks, the works. HIVE takes the best ideas from all of them
and re-implements in a lightweight shell around Claude Code. No
databases. No vector stores. No dependencies worth mentioning.
Everything is markdown files in `~/.hive/`, tracked by git,
readable by humans.

**From [Hippo](https://github.com/kitfunso/hippo-memory):** memory
decay and retrieval strengthening — entries you actually use get
stronger, everything else fades. Biological memory dynamics without
the SQLite.

**From [ClawMem](https://github.com/yoloshii/ClawMem):** BM25 ranked
search as the base retrieval layer. No embeddings needed at this scale.

**From [claude-mem](https://github.com/thedotmack/claude-mem):**
progressive disclosure — lightweight index at session start, details
on demand.

**From [OpenClaw](https://openclaw.ai/):** persistent identity
(SOUL/IDENTITY/SELF stack), heartbeat agent with periodic autonomy,
and trust boundaries that define what the AI can do without asking.

**From [Beads](https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a):**
per-project ticket tracking with dependencies, priorities, and
agent-readable markdown — work graphs the AI can plan against.

**From [Perplexity](https://perplexity.ai/):** multi-model council —
the same question to multiple models in parallel, synthesized into
one answer. Perplexity does this for search; HIVE does it for
architecture decisions and tradeoff analysis.

**Original to HIVE:** the synthesis layer that ties all of this
together without a database.

Claude Code handles orchestration, subagents, tools, and file I/O.
HIVE adds what it doesn't ship with:

- **Persistent identity** that carries across sessions
- **Three-layer project memory** (log, knowledge, index) with BM25 search and decay
- **Multi-model council** with standard and adversarial dialectic modes
- **Per-project ticket tracking** in markdown
- **Heartbeat**: a persistent agent that wakes every 30 minutes, checks project state, and dispatches work within defined trust boundaries
- **Autonomous dispatch**: background goal execution with timeout, kill, and status tracking

> Runs on Claude Code directly. Your Claude subscription covers it.

## What Hive Does

**Persistent identity.** SOUL.md, IDENTITY.md, and SELF.md live in
`~/.hive/` and define who your AI is, what it values, and how it works
with you. Every Claude Code session picks this up through a CLAUDE.md
reference. Identity persists across projects and sessions.

**Project memory.** Facts, conventions, decisions, and open questions
accumulate in `~/.hive/memory/projects/<name>/`. Claude Code reads
and writes this through MCP tools. Knowledge compounds over time
instead of starting fresh every session.

**Multi-model council.** Send the same question to Claude, GPT, Gemini,
and local models simultaneously. Each model gives an independent
position. Claude Code acts as chair and synthesizes agreement and
disagreement. Useful for architecture decisions, tradeoff analysis, and
anything where multiple perspectives help.

**Ticket tracking.** Per-project tickets stored as markdown files with
YAML frontmatter at `~/.hive/projects/<name>/tickets/`. Bugs,
features, tasks, epics, and chores with priorities, tags, dependencies,
and timestamped notes. Exposed as both CLI commands and MCP tools so
the agent can track its own work. Tickets live under `~/.hive/`, not in
the repo — they're a personal working surface for one developer's
human+agent loop, not a team coordination layer. Each dev on a project
opts into HIVE independently; team-wide work still belongs in GitHub
Issues, Linear, or whatever your team already uses.

**Heartbeat.** A persistent Claude session per project, resumed every
30 minutes via launchd. The heartbeat agent reads standing orders
(`HEARTBEAT.md`), checks git status, tickets, memory, and dispatch
runs, then acts on what it finds. It can autonomously dispatch standalone
tasks (docs, chores), close completed tickets, consolidate memory, and
surface recommendations. Trust boundaries are defined per project in
the standing orders file. Also available interactively via
`hive heartbeat chat`, which resumes the same persistent session.

**Autonomous dispatch.** `hive dispatch "<goal>"` spawns a background
Claude session with the maya-executor agent in a git worktree. The
executor plans, builds, tests, and merges. Configurable timeout
(default 30m). `hive kill` to stop, `hive ps` for status with failure
details. The heartbeat can trigger dispatches on its own for
authorized work categories.

## Quick Start

```bash
# Install
bun install

# Initialize: creates ~/.hive/ with identity templates,
# registers the MCP server in ~/.claude/.mcp.json,
# and asks for your name to personalize templates
bun run src/cli.ts init

# Register a project: creates memory file, wires CLAUDE.md
bun run src/cli.ts project add myapp ~/work/myapp

# Start Claude Code (picks up identity and MCP tools automatically)
cd ~/work/myapp
claude
```

After init, customize these files:

| File | What to put there |
| --- | --- |
| `~/.hive/SELF.md` | Who you are: role, stack preferences, communication style, working patterns |
| `~/.hive/IDENTITY.md` | Who the AI is: personality, name, how it thinks |
| `~/.hive/SOUL.md` | Shared values and craft standards |
| `~/.hive/config.md` | Model pool for multi-model council |

`SELF.md` is the most important one. The more the AI knows about how
you work, the less you repeat yourself.

### Configure models (optional)

Edit `~/.hive/config.md` to set up the council:

```md
## Model Pool
- opus: claude, claude-opus-4-6, frontier deep work
- sonnet: claude, claude-sonnet-4-6, general workhorse
- haiku: claude, claude-haiku-4-5-20251001, fast triage
- gpt54: codex, gpt-5.4, OpenAI frontier
- qwen: ollama, qwen3:4b, local fast triage
```

## Add Hive to an Existing Project

If you've already run `hive init` and just want to wire up a new project,
add this to your project's `CLAUDE.md`:

```md
# HIVE

Read and internalize these files at the start of every session:
- ~/.hive/SOUL.md
- ~/.hive/IDENTITY.md
- ~/.hive/SELF.md
- ~/.hive/TRUST.md
- ~/.hive/AGENTS.md

Read your project memory:
- ~/.hive/memory/projects/YOURPROJECT.md

You have HIVE MCP tools:
- `convene_council` — multi-model analysis
- `read_hive_memory` — read accumulated project intelligence
- `write_hive_memory` — record new facts, conventions, or decisions
- `create_ticket` — create a ticket with priority, tags, and dependencies
- `list_tickets` — list and filter project tickets
- `show_ticket` — show full ticket details including notes
- `update_ticket` — update ticket status, priority, or other fields
- `add_ticket_note` — add a timestamped note
```

Then register the project so memory and tickets work:

```bash
bun run src/cli.ts project add yourproject ~/work/yourproject
```

Or skip the manual CLAUDE.md edit; `project add` does it for you.

## MCP Tools

Available to Claude Code when the HIVE MCP server is running:

| Tool | Purpose |
| --- | --- |
| `convene_council` | Send a question to multiple models in parallel. Supports `persona: "analyst"` for structured analytical framing. |
| `read_hive_memory` | Read project intelligence: facts, conventions, decisions, open questions. |
| `write_hive_memory` | Record a new fact, convention, decision, or question. Validated on write. |
| `reflect_session` | Batch-write session learnings at end of session. |
| `search_memory` | Search across all memory layers by keyword or tag. |
| `manage_heartbeat` | Enable, disable, or check heartbeat status for a project. |
| `create_ticket` | Create a ticket with type, priority (P0-P3), tags, and dependencies. |
| `list_tickets` | List and filter tickets by status, type, or tags. |
| `show_ticket` | Show full ticket details. Supports partial ID matching. |
| `update_ticket` | Update ticket status, priority, tags, or other fields. |
| `add_ticket_note` | Add a timestamped note with optional actor attribution. |

## CLI Commands

| Command | Purpose |
| --- | --- |
| `hive init` | Create `~/.hive/` scaffold, register MCP server |
| `hive project add <name> <path>` | Register project, create memory, wire CLAUDE.md |
| `hive council "<question>"` | Multi-model council from terminal |
| `hive council --persona analyst "<question>"` | Council with analytical framing |
| `hive council --format json "<question>"` | Machine-readable council output |
| `hive memory` | View project memory |
| `hive memory fact <text>` | Add a durable fact |
| `hive memory convention <text>` | Add a convention |
| `hive memory decision <text>` | Add a decision |
| `hive memory question <text>` | Add an open question |
| `hive memory reflect` | Batch-write learnings from stdin (JSON) |
| `hive memory extract-sessions` | Condense last 24h session transcripts for nightly |
| `hive dispatch "<goal>"` | Dispatch autonomous goal execution (`--ticket`, `--plan`, `--timeout`) |
| `hive ps` | Show active and recent dispatch runs with failure details |
| `hive kill <run-id>` | Kill a running dispatch |
| `hive heartbeat start` | Enable heartbeat for current project (`--interval <min>`) |
| `hive heartbeat stop` | Disable heartbeat for current project |
| `hive heartbeat status` | Show heartbeat state for all projects |
| `hive heartbeat tick` | Run one heartbeat tick manually |
| `hive heartbeat chat` | Interactive session with the heartbeat agent |
| `hive heartbeat reset` | Reset heartbeat session (fresh on next tick) |
| `hive ticket create <title>` | Create a ticket (`--type`, `--priority`, `--tags`, `--depends`) |
| `hive ticket list` | List tickets (`--status`, `--type`, `--tags`) |
| `hive ticket show <id>` | Show ticket details (partial IDs work: `1` matches `TK-001`) |
| `hive ticket start <id>` | Set ticket to `in_progress` |
| `hive ticket close <id>` | Close ticket |
| `hive ticket reopen <id>` | Reopen a closed ticket |
| `hive ticket note <id> <text>` | Add a timestamped note |
| `hive ticket dispatch <id>` | Tag ticket for heartbeat auto-dispatch |
| `hive ticket ready` | Show unblocked open tickets |
| `hive ticket blocked` | Show dependency-blocked tickets |

## How Identity Works

Identity lives in `~/.hive/` and is injected via a **SessionStart hook**.
When Claude Code starts a session, the hook runs and injects:

1. The full identity stack: SOUL.md, IDENTITY.md, SELF.md, AGENTS.md, TRUST.md
2. The current project's memory index (resolved by matching `$PWD` against registered project paths)
3. Recent self-reflections from `~/.hive/reflections/` (last 3 days)
4. A session reflection protocol prompting the agent to record learnings before ending

Projects also reference the identity in their CLAUDE.md so the agent
knows about the MCP tools. See the template above.

## Memory

Three layers, from raw to refined:

- **Log** (`memory/projects/<name>/log/`): Daily session entries. Append-only. Written by `reflect_session`.
- **Knowledge** (`memory/projects/<name>/knowledge.md`): Compiled facts, conventions, decisions, open questions. Written by `write_hive_memory`. Supports tags and superseding.
- **Index** (`memory/projects/<name>/_index.md`): Auto-generated summary loaded at session start. Rebuilt when knowledge changes.

Every write is validated: rejects empty entries, section header injection,
over-length content. Structural validation ensures all sections exist in
correct order. A write queue serializes concurrent MCP calls to prevent
lost updates.

`~/.hive/` is a git repo, so all memory changes are tracked in history.

## Automation: Auto-dispatch

Tickets tagged `auto-dispatch` are picked up by the heartbeat agent for
autonomous execution. The workflow:

1. **Tag a ticket:** `hive ticket dispatch TK-005` adds the `auto-dispatch` tag
2. **Heartbeat picks it up:** The context brief highlights auto-dispatch tickets with dependency status
3. **Dependency gating:** If a ticket has unresolved `depends`, the heartbeat skips it and notes why
4. **Dispatch:** The heartbeat runs `hive dispatch "<goal>" --ticket <id>` for ready tickets

This is controlled by the standing orders in each project's `HEARTBEAT.md`.
Only tickets that are open, tagged `auto-dispatch`, and have all dependencies
resolved will be dispatched. The heartbeat logs every dispatch to `inbox.md`.

Use `auto-dispatch` for work that's well-specified and safe for autonomous
execution: documentation tasks, chores, standalone features with clear specs.
Don't tag anything that needs human judgment on approach.

## File Layout

```
~/.hive/
├── SOUL.md              # shared values
├── IDENTITY.md          # AI identity
├── SELF.md              # user preferences
├── AGENTS.md            # operational doctrine
├── TRUST.md             # action classification + heartbeat authority
├── config.md            # model pool
├── memory/
│   ├── projects/        # per-project intelligence
│   │   └── <name>/
│   │       ├── knowledge.md  # compiled facts, conventions, decisions
│   │       ├── _index.md     # auto-generated summary
│   │       └── log/          # daily session log entries
│   └── daily/           # condensed session transcripts
├── reflections/         # nightly self-reflection proposals
├── briefings/           # morning briefings
├── runs/                # dispatch run state
│   └── RUN-001/
│       ├── goal.md, status, plan.md, output.log, pid
├── projects/
│   └── <name>/
│       ├── config.md    # project path
│       ├── HEARTBEAT.md # standing orders + authorized actions
│       ├── heartbeat.json # session state
│       ├── inbox.md     # heartbeat findings
│       └── tickets/
│           └── TK-001.md
├── scripts/             # launchd entry points
└── logs/                # nightly, morning, heartbeat logs
```

## Requirements

- [Bun](https://bun.sh/) 1.3+
- macOS or Linux

For multi-model council:
- Claude CLI subscription OAuth (macOS keychain) or `ANTHROPIC_API_KEY`
- Codex CLI subscription OAuth or `OPENAI_API_KEY` for GPT models
- Gemini CLI OAuth for Google models
- `ollama` running locally for local models

## Development

```bash
bun build src/cli.ts --target bun --outfile hive
bun build src/mcp-server.ts --target bun --outfile hive-mcp
bun test
```

## Design Values

**Identity over infrastructure.** The interesting part of AI
coordination is who the AI is, what it remembers, and who else it
can consult.

**Files over databases.** `cat ~/.hive/SOUL.md` tells you who your AI
is. No dashboard required.

**Ride the platform.** Claude Code does orchestration. Don't rebuild it.
Add what it doesn't ship with.
