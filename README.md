# Hive

Identity, memory, council, and autonomous agency for Claude Code.

> **Not a third-party harness.** HIVE wraps Claude Code — every
> operation invokes the `claude` CLI directly. It benefits from Claude
> Code's prompt caching, session management, and tool framework. Unlike
> third-party harnesses (OpenClaw, etc.), HIVE is unaffected by
> Anthropic's April 2026 policy limiting subscription use for external
> agent runtimes. Your Claude subscription covers HIVE fully.

Claude Code handles orchestration with subagents, tools, loops,
file I/O. Hive provides what Claude Code doesn't have:

- **persistent identity** that carries across sessions
- **accumulated project intelligence** (three-layer memory: log, knowledge, index)
- **a multi-model council** with standard and adversarial dialectic modes
- **per-project ticket tracking** for managing active work
- **a heartbeat system** — a persistent agent that wakes up every 30 minutes, checks project state, and autonomously dispatches work within defined trust boundaries
- **autonomous dispatch** — fire-and-forget goal execution with timeout, kill, and status tracking

## What Hive Does

**Persistent identity.** SOUL.md, IDENTITY.md, and SELF.md live in
`~/.hive/` and define who your AI is, what it values, and how it works
with you. Every Claude Code session picks this up through a CLAUDE.md
reference. The identity persists across projects and sessions.

**Project memory.** Facts, conventions, decisions, and open questions
accumulate in `~/.hive/memory/projects/<name>.md`. Claude Code reads
and writes this through MCP tools. Knowledge compounds over time
instead of starting fresh every session.

**Multi-model council.** Send the same question to Claude, GPT, Gemini,
and local models simultaneously. Each model gives an independent
position. Claude Code acts as chair and synthesizes agreement and
disagreement. Use for architecture decisions, tradeoff analysis, or any
question where multiple perspectives matter.

**Ticket tracking.** Per-project tickets stored as markdown files with
YAML frontmatter at `~/.hive/projects/<name>/tickets/`. Create bugs,
features, tasks, epics, and chores with priorities, tags, dependencies,
and timestamped notes. Exposed as both CLI commands and MCP tools so
the AI agent can track its own work.

**Heartbeat.** A persistent Claude session per project, resumed every
30 minutes via launchd. The heartbeat agent reads standing orders
(`HEARTBEAT.md`), checks git status, tickets, memory, and dispatch
runs — then acts. It can autonomously dispatch standalone tasks (docs,
chores), close completed tickets, consolidate memory, and surface
recommendations. Trust boundaries are defined per project. Interactive
via `hive heartbeat chat` — same session, same context.

**Autonomous dispatch.** `hive dispatch "<goal>"` spawns a background
Claude session with the maya-executor agent in a git worktree. The
executor plans, builds, tests, and merges. Configurable timeout
(default 30m), `hive kill` to stop, `hive ps` for status with failure
details. The heartbeat can trigger dispatches autonomously for
authorized work.

## Quick Start

```bash
# Install
bun install

# Initialize — creates ~/.hive/ with identity templates,
# registers the MCP server in ~/.claude/.mcp.json,
# and asks for your name to personalize templates
bun run src/cli.ts init

# Register a project — creates memory file, wires CLAUDE.md
bun run src/cli.ts project add myapp ~/work/myapp

# Start Claude Code — it picks up identity and MCP tools automatically
cd ~/work/myapp
claude
```

After init, you'll have these files to customize:

| File | What to put there |
| --- | --- |
| `~/.hive/SELF.md` | Who you are — role, stack preferences, communication style, working patterns |
| `~/.hive/IDENTITY.md` | Who the AI is — personality, name, how it thinks |
| `~/.hive/SOUL.md` | Shared values and craft standards |
| `~/.hive/config.md` | Model pool for multi-model council |

`SELF.md` is the most important one. The more the AI knows about how
you work, the less you have to repeat yourself.

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
- ~/.hive/SOUL.md — your values and craft standards
- ~/.hive/IDENTITY.md — who you are
- ~/.hive/SELF.md — who you're working with
- ~/.hive/TRUST.md — action classification and approval rules
- ~/.hive/AGENTS.md — operational doctrine

Read your project memory:
- ~/.hive/memory/projects/YOURPROJECT.md — accumulated facts, conventions, decisions

You have HIVE MCP tools:
- `convene_council` — Multi-model analysis. Sends a question to multiple AI models in parallel. You act as chair — synthesize agreement and disagreement.
- `read_hive_memory` — Read accumulated project intelligence.
- `write_hive_memory` — Record new facts, conventions, or decisions.
- `create_ticket` — Create a ticket (bug, feature, task, epic, chore) with priority, tags, and dependencies.
- `list_tickets` — List and filter project tickets by status, type, or tags.
- `show_ticket` — Show full ticket details including notes.
- `update_ticket` — Update ticket status, priority, tags, or other fields.
- `add_ticket_note` — Add a timestamped note to a ticket.
```

Then register the project so memory and tickets work:

```bash
bun run src/cli.ts project add yourproject ~/work/yourproject
```

Or skip the manual CLAUDE.md edit — `project add` does it for you.

## MCP Tools

These are available to Claude Code when the HIVE MCP server is running:

| Tool | Purpose |
| --- | --- |
| `convene_council` | Send a question to multiple models in parallel. Supports `persona: "analyst"` for structured analytical framing. Returns independent positions for you to synthesize. |
| `read_hive_memory` | Read accumulated project intelligence — facts, conventions, decisions, open questions. |
| `write_hive_memory` | Record a new fact, convention, decision, or question. Input is validated against corruption. |
| `reflect_session` | Batch-write session learnings. Use at end of a substantive session to record multiple facts, conventions, decisions, or questions in one call. |
| `create_ticket` | Create a ticket with type, priority (P0–P3), tags, dependencies, and optional body. |
| `list_tickets` | List and filter tickets by status, type, or tags. |
| `show_ticket` | Show full ticket details including timestamped notes. Supports partial ID matching. |
| `update_ticket` | Update ticket status, priority, tags, dependencies, or other fields. |
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
| `hive ticket show <id>` | Show ticket details (partial IDs work: `1` → `TK-001`) |
| `hive ticket start <id>` | Set ticket to `in_progress` |
| `hive ticket close <id>` | Close ticket (records `closed` timestamp) |
| `hive ticket reopen <id>` | Reopen a closed ticket |
| `hive ticket note <id> <text>` | Add a timestamped note |
| `hive ticket ready` | Show unblocked open tickets |
| `hive ticket blocked` | Show dependency-blocked tickets |

## How Identity Works

Identity lives in `~/.hive/` and is injected automatically via a
**SessionStart hook**. When Claude Code starts a session, the hook
(`.claude/hooks/load-identity.sh`) runs and injects:

1. The full identity stack: SOUL.md, IDENTITY.md, SELF.md, AGENTS.md, TRUST.md
2. The current project's memory (resolved by matching `$PWD` against registered project paths)
3. A session reflection protocol prompting the agent to record learnings before ending

Projects also reference the identity in their CLAUDE.md so the agent
knows about the MCP tools:

```md
# HIVE

Read and internalize these files at the start of every session:
- ~/.hive/SOUL.md — your values and craft standards
- ~/.hive/IDENTITY.md — who you are
- ~/.hive/SELF.md — who you're working with
- ~/.hive/TRUST.md — action classification and approval rules
- ~/.hive/AGENTS.md — operational doctrine

Read your project memory:
- ~/.hive/memory/projects/myapp.md — accumulated facts, conventions, decisions

You have HIVE MCP tools:
- `convene_council` — Multi-model analysis.
- `read_hive_memory` — Read accumulated project intelligence.
- `write_hive_memory` — Record new facts, conventions, or decisions.
- `create_ticket` — Create a ticket with priority, tags, and dependencies.
- `list_tickets` — List and filter project tickets.
- `show_ticket` — Show full ticket details including notes.
- `update_ticket` — Update ticket status, priority, or other fields.
- `add_ticket_note` — Add a timestamped note to a ticket.
```

No compression, no duplication. Claude Code reads the files directly.
Single source of truth.

## Memory Validation

Every memory write is validated before it lands:

- **Input validation** — rejects empty entries, section header injection,
  over-length content, and collapses multi-line entries
- **Structural validation** — verifies all four sections exist in correct
  order with no duplicates before writing
- **Write queue** — serializes concurrent MCP tool calls to prevent
  lost-update bugs

`~/.hive/` is a git repo, so all memory changes are tracked in history.

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
│   │       ├── _index.md     # auto-generated summary (loaded at session start)
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
coordination is not the plumbing — it's who the AI is, what it
remembers, and who else it can ask.

**Files over databases.** `cat ~/.hive/SOUL.md` tells you who your AI
is. No dashboard required.

**Ride the platform.** Claude Code does orchestration. Don't fight it.
Add what it's missing.
