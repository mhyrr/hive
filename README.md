# Hive

Identity, memory, and multi-model council for Claude Code.

Hive is not an orchestration engine. Claude Code already handles that —
subagents, tools, loops, file I/O. Hive provides what Claude Code
doesn't have: **persistent identity** that carries across sessions,
**accumulated project intelligence** that survives forever, and a
**multi-model council** that gives you multiple perspectives on any
question.

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

## Quick Start

### 1. Install

```bash
bun install
```

### 2. Initialize

```bash
bun run src/cli.ts init
```

This creates `~/.hive/` with identity templates and registers the HIVE
MCP server in `~/.claude/.mcp.json`.

### 3. Edit your identity

- `~/.hive/SOUL.md` — shared values and craft standards
- `~/.hive/IDENTITY.md` — who the AI is
- `~/.hive/SELF.md` — who you are and how you work

### 4. Register a project

```bash
bun run src/cli.ts project add myapp ~/work/myapp
```

This creates a memory file and adds a HIVE reference block to your
project's CLAUDE.md. The block tells Claude Code to read the identity
files and describes the available MCP tools.

### 5. Configure models

Edit `~/.hive/config.md`:

```md
## Model Pool
- opus: claude, claude-opus-4-6, frontier deep work
- sonnet: claude, claude-sonnet-4-6, general workhorse
- haiku: claude, claude-haiku-4-5-20251001, fast triage
- gpt54: codex, gpt-5.4, OpenAI frontier
- qwen: ollama, qwen3:4b, local fast triage
```

### 6. Use

Start Claude Code in your project. It reads the CLAUDE.md, loads the
identity from `~/.hive/`, and has access to the MCP tools.

```bash
cd ~/work/myapp
claude
```

## MCP Tools

These are available to Claude Code when the HIVE MCP server is running:

| Tool | Purpose |
| --- | --- |
| `convene_council` | Send a question to multiple models in parallel. Returns independent positions for you to synthesize. |
| `read_hive_memory` | Read accumulated project intelligence — facts, conventions, decisions, open questions. |
| `write_hive_memory` | Record a new fact, convention, decision, or question. |

## CLI Commands

| Command | Purpose |
| --- | --- |
| `hive init` | Create `~/.hive/` scaffold, register MCP server |
| `hive project add <name> <path>` | Register project, create memory, wire CLAUDE.md |
| `hive council "<question>"` | Multi-model council from terminal |
| `hive memory` | View project memory |
| `hive memory fact <text>` | Add a durable fact |
| `hive memory convention <text>` | Add a convention |
| `hive memory decision <text>` | Add a decision |
| `hive memory question <text>` | Add an open question |

## How Identity Works

Identity lives in `~/.hive/`. Projects reference it in their CLAUDE.md:

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
```

No compression, no duplication. Claude Code reads the files directly.
Single source of truth.

## File Layout

```
~/.hive/
├── SOUL.md              # shared values
├── IDENTITY.md          # AI identity
├── SELF.md              # user preferences
├── AGENTS.md            # operational doctrine
├── TRUST.md             # action classification
├── config.md            # model pool
├── memory/
│   └── projects/        # per-project intelligence
└── projects/
    └── <name>/
        └── config.md    # project path
```

## Requirements

- [Bun](https://bun.sh/) 1.3+
- macOS or Linux

For multi-model council:
- `ANTHROPIC_API_KEY` or Claude CLI OAuth for Claude models
- `OPENAI_API_KEY` for GPT models
- `ollama` running locally for local models

## Development

```bash
bun build src/cli.ts --target bun --outfile hive
bun build src/mcp-server.ts --target bun --outfile hive-mcp
```

## Design Values

**Identity over infrastructure.** The interesting part of AI
coordination is not the plumbing — it's who the AI is, what it
remembers, and who else it can ask.

**Files over databases.** `cat ~/.hive/SOUL.md` tells you who your AI
is. No dashboard required.

**Ride the platform.** Claude Code does orchestration. Don't fight it.
Add what it's missing.
