# HIVE + Claude Code Integration Guide

How the pieces fit together — what HIVE provides, what Claude Code provides
natively, and how they compose into a persistent AI development partner.

---

## 1. Architecture Overview

HIVE is an identity, memory, and council layer that sits on top of Claude
Code's runtime. Claude Code handles orchestration — subagents, tools, loops,
file I/O, hooks, worktrees. HIVE provides what Claude Code doesn't have
natively:

```
┌─────────────────────────────────────────────────┐
│                  Claude Code                     │
│  Orchestration · Subagents · Hooks · Worktrees   │
│  Loops · Schedules · Dispatch · MCP Integration  │
├─────────────────────────────────────────────────┤
│                     HIVE                         │
│  Identity Stack · Project Memory · Multi-Model   │
│  Council · Ticket Tracking · Trust Boundaries    │
└─────────────────────────────────────────────────┘
│                                                   │
│              ~/.hive/ (Markdown files)            │
└───────────────────────────────────────────────────┘
```

The boundary is clean: Claude Code is the engine, HIVE is the soul.
Claude Code doesn't know who it is between sessions. HIVE makes it
remember.

---

## 2. What HIVE Handles

### Identity Stack

Five files in `~/.hive/` define who the AI is and how it operates:

| File | Purpose |
|------|---------|
| `SOUL.md` | Shared values, craft standards, communication style |
| `IDENTITY.md` | The AI's self-concept — name, personality, working style |
| `SELF.md` | Who the human is — preferences, context, communication style |
| `AGENTS.md` | Operational doctrine — how sessions work, memory discipline, council protocol |
| `TRUST.md` | Action classification — what the AI may do freely vs. what needs approval |

These are loaded at session start via a **SessionStart hook** (see
[How They Compose](#4-how-they-compose)). Every Claude Code session —
interactive, subagent, scheduled — picks up identity automatically.

### Project Memory

Per-project intelligence accumulates in `~/.hive/memory/projects/<name>.md`
with four sections:

- **Durable Facts** — architecture, constraints, gotchas
- **Conventions** — coding patterns, tool preferences, naming
- **Decisions** — choices made with rationale and dates
- **Open Questions** — unresolved issues for future sessions

Memory is written via MCP tools (`write_hive_memory`, `reflect_session`)
and read both by the SessionStart hook and on-demand via `read_hive_memory`.
Every write is validated against corruption and serialized to prevent
lost-update bugs.

### Multi-Model Council

Send the same question to Claude, GPT, Gemini, and local models in
parallel. Each model returns an independent position. The calling agent
acts as chair and synthesizes agreement and disagreement.

Models are configured in `~/.hive/config.md`:

```md
## Model Pool
- opus: claude, claude-opus-4-6, frontier deep work
- sonnet: claude, claude-sonnet-4-6, general workhorse
- gpt54: codex, gpt-5.4, OpenAI frontier
- gemini: gemini-cli, gemini-2.5-pro, Google frontier
```

Auth piggybacks on existing CLI subscriptions — Claude CLI OAuth,
Codex CLI OAuth, Gemini CLI OAuth — so no separate API keys are
required if you already use these tools.

### Ticket Tracking

Per-project tickets stored as markdown files with YAML frontmatter at
`~/.hive/projects/<name>/tickets/`. Supports bugs, features, tasks,
epics, and chores with priorities (P0–P3), tags, dependencies, and
timestamped notes.

Exposed as both CLI commands and MCP tools so the AI agent can track
its own work — create tickets during planning, update status during
execution, add notes with findings.

---

## 3. What Claude Code Handles

These are native Claude Code features that HIVE deliberately does not
replicate:

| Feature | What It Does |
|---------|-------------|
| **Subagents** | Custom agent definitions in `.claude/agents/` with isolated tool sets, model overrides, and worktree isolation |
| **Hooks** | 22 lifecycle events (SessionStart, PreToolUse, PostToolUse, etc.) for injecting behavior at specific points |
| **Worktrees** | Git-based parallel isolation — agents work on separate copies of the repo without stepping on each other |
| **MCP Integration** | Model Context Protocol servers extend Claude Code's tool surface. HIVE runs as an MCP server. |
| **Loops** | `/loop` — session-scoped polling with cron-backed execution (3-day expiry) |
| **Schedules** | `/schedule` — persistent cloud tasks (1hr minimum) or desktop tasks (1min minimum) |
| **Dispatch** | Send sessions to cloud for background execution |
| **Agent Teams** | Experimental multi-session coordination |
| **Permission System** | Built-in approval gates for external actions |

HIVE's v3 strategy is explicit: **ride the platform**. Claude Code's
orchestration gets better every release. Building a parallel orchestration
layer wastes effort and creates version skew. HIVE adds what Claude Code
structurally can't provide — persistent identity across sessions, accumulated
project intelligence, and multi-vendor model deliberation.

---

## 4. How They Compose

### The SessionStart Hook

The core integration point. When Claude Code starts any session, a hook
script runs and injects HIVE's identity stack into the context:

```bash
# templates/hooks/load-identity.sh
#!/bin/bash
HIVE_DIR="$HOME/.hive"

# 1. Load identity stack
for file in SOUL.md IDENTITY.md SELF.md AGENTS.md TRUST.md; do
  [ -f "$HIVE_DIR/$file" ] && cat "$HIVE_DIR/$file"
done

# 2. Resolve project by matching $PWD against registered paths
# 3. Load matched project's memory
# 4. Append session reflection protocol
```

This hook is registered in Claude Code's `settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "type": "command",
      "command": "bash ~/.hive/hooks/load-identity.sh"
    }]
  }
}
```

The result: every session — interactive, subagent, scheduled, dispatched —
wakes up knowing who it is, who it's working with, what the project has
learned, and how to record new learnings.

### Subagents Inherit Identity

HIVE installs custom agent definitions to `~/.claude/agents/`:

| Agent | Role | Key Tools |
|-------|------|-----------|
| `maya-planner` | Architecture and planning | `read_hive_memory`, `convene_council`, `create_ticket` |
| `maya-coder` | Implementation in isolated worktrees | `read_hive_memory`, `write_hive_memory` |
| `maya-reviewer` | Code review against project conventions | `read_hive_memory` |
| `maya-nightly` | Nightly maintenance and knowledge extraction | `reflect_session`, `list_tickets` |

Each agent gets the SessionStart hook injection automatically. The planner
reads memory and tickets before architecting. The coder reads conventions
before writing code. The reviewer checks work against accumulated standards.

### Scheduled Tasks Use HIVE Tools

Cron jobs installed by `hive init` drive recurring automation:

| Schedule | Script | What It Does |
|----------|--------|-------------|
| 2:00 AM | `nightly.sh` | Runs `maya-nightly` — reviews git activity across all projects, extracts durable learnings to HIVE memory, updates tickets |
| 2:30 AM | `hive-sync.sh` | Commits and pushes `~/.hive/` changes to git remote |
| 7:00 AM | `morning.sh` | Runs `maya-morning` — scans projects for priorities, open tickets, uncommitted work, writes daily briefing |

The nightly agent has `permissionMode: bypassPermissions` because it runs
unattended. It uses `reflect_session` to batch-write learnings and
`list_tickets` to check project state.

### Hooks Enforce Trust Boundaries

HIVE's `TRUST.md` classifies actions into tiers:

- **internal-safe** — read files, edit code, run tests, create branches
- **code-safe** — apply changes, update tests, restructure files, record memory
- **external-gated** — push, open PRs, deploy, send messages (requires approval)
- **forbidden** — spend money, delete production data, share secrets

Claude Code's permission system enforces the gates. When the AI attempts
an external-gated action, Claude Code surfaces it for human approval.
HIVE's trust document trains the AI to self-classify — most agents won't
even attempt forbidden actions because the identity stack tells them not to.

---

## 5. Setup Guide

### Prerequisites

- [Bun](https://bun.sh/) 1.3+
- [Claude Code](https://claude.ai/claude-code) installed
- macOS or Linux

For multi-model council (optional):
- Claude CLI subscription OAuth or `ANTHROPIC_API_KEY`
- Codex CLI subscription OAuth or `OPENAI_API_KEY` for GPT models
- Gemini CLI OAuth for Google models
- `ollama` running locally for local models

### Step 1: Initialize HIVE

```bash
cd ~/work/hive   # or wherever you cloned this repo
bun install
bun run src/cli.ts init
```

This creates:
- `~/.hive/` with identity templates (SOUL.md, IDENTITY.md, SELF.md, AGENTS.md, TRUST.md)
- `~/.hive/config.md` with model pool configuration
- `~/.hive/scripts/` with nightly, morning, and sync scripts
- `~/.claude/agents/` with HIVE agent definitions (maya-planner, maya-coder, maya-reviewer, maya-nightly)
- Cron jobs for nightly extraction and state sync
- MCP server registration in `~/.claude/.mcp.json`

### Step 2: Customize Your Identity

Edit these files (most important first):

1. **`~/.hive/SELF.md`** — Tell the AI who you are. Stack preferences,
   communication style, working patterns. The more it knows, the less
   you repeat yourself.

2. **`~/.hive/IDENTITY.md`** — Shape who the AI is. Name, personality,
   how it thinks. This is where "generic assistant" becomes "your
   specific collaborator."

3. **`~/.hive/SOUL.md`** — Shared values and craft standards. What
   "good" means in your work.

4. **`~/.hive/config.md`** — Configure the model pool for council
   deliberations. Comment out models you don't have access to.

### Step 3: Register a Project

```bash
bun run src/cli.ts project add myapp ~/work/myapp
```

This:
- Creates `~/.hive/projects/myapp/config.md` with the project path
- Creates `~/.hive/memory/projects/myapp.md` with empty memory sections
- Appends a HIVE reference block to `~/work/myapp/CLAUDE.md`

### Step 4: Start Working

```bash
cd ~/work/myapp
claude
```

Claude Code starts, the SessionStart hook fires, HIVE identity loads.
The agent knows who it is, reads project memory, and has access to
HIVE MCP tools. You're in business.

### Step 5: Install the SessionStart Hook

If `hive init` didn't configure the hook automatically, add it to your
Claude Code settings. Create or edit `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{
      "type": "command",
      "command": "bash ~/.hive/hooks/load-identity.sh"
    }]
  }
}
```

Or add it at the project level in `.claude/settings.json` within
the project directory.

---

## 6. Workflow Patterns

### Morning Briefing

The `morning.sh` script runs the `maya-morning` agent at 7 AM:

```bash
claude --agent maya-morning --print --max-turns 30 \
  "Generate morning briefing for $(date +%Y-%m-%d)."
```

It scans all registered projects for: recent commits, open tickets,
uncommitted work, pending decisions. Writes a briefing to
`~/.hive/briefings/`. Greg reads it with coffee.

### Nightly Knowledge Extraction

The `nightly.sh` script runs `maya-nightly` at 2 AM:

```bash
claude --agent maya-nightly --print --max-turns 40 \
  "Run nightly extraction for $(date +%Y-%m-%d)."
```

Reviews the day's git activity across all projects. Extracts durable
learnings to HIVE memory via `reflect_session`. Updates ticket status
where appropriate. Runs unattended with `permissionMode: bypassPermissions`.

Thirty minutes later, `hive-sync.sh` commits and pushes `~/.hive/` so
the knowledge survives.

### Parallel Coding Agents

Use Claude Code's worktree isolation with HIVE's memory:

```
# The planner reads memory + tickets, creates a plan
claude --agent maya-planner "Design the authentication system"

# Multiple coders work in parallel, each in isolated worktrees
# Each reads HIVE conventions before coding
claude --agent maya-coder "Implement JWT middleware (TK-005)"
claude --agent maya-coder "Implement user registration (TK-006)"
```

Each coder agent gets its own git worktree (via `isolation: worktree`
in the agent definition). They can't step on each other's files. They
all read the same HIVE memory for conventions. When they finish, their
worktrees are returned for review and merge.

### Council for Architecture Decisions

When you hit a fork in the road:

```bash
# From the CLI
hive council "Should we use JWTs or session cookies for auth in this Phoenix API?"

# Or via MCP tool in a Claude Code session
# The agent calls convene_council automatically when AGENTS.md tells it to
```

Three models respond independently. The calling agent (or you) synthesizes.
Use `persona: "analyst"` for structured analytical framing with explicit
assumptions, distinguished facts vs. inferences, and risk assessment.

### Ralph Loops (Many Short Sessions)

Inspired by OpenClaw's pattern: many short, focused coding sessions
beat one long marathon. Each session:

1. Reads HIVE memory for context (automatic via SessionStart hook)
2. Does one focused piece of work
3. Records learnings via `write_hive_memory` or `reflect_session`
4. Commits and exits

The next session picks up where the last left off because memory persists.
No context window bloat. No drift. Each session starts fresh but informed.

### Ticket-Driven Development

The AI manages its own work queue:

```
# Planning session creates tickets
maya-planner → creates TK-012, TK-013, TK-014 with dependencies

# Execution sessions work through them
maya-coder → starts TK-012, adds notes with findings, closes when done
maya-coder → starts TK-013 (was blocked on TK-012, now unblocked)

# Review what's left
hive ticket ready    # shows unblocked open tickets
hive ticket blocked  # shows dependency-blocked tickets
```

Tickets persist across sessions. The morning briefing includes ticket
status. The nightly extraction can update tickets based on git activity.

---

## 7. Comparison with OpenClaw

OpenClaw (247K GitHub stars) is an open-source AI agent framework with
a hub-and-spoke architecture: Gateway (control plane) + Pi (agent runtime).
We studied it carefully during HIVE v3 design. Here's what we chose to
build, what we chose not to, and why.

### What OpenClaw builds that HIVE doesn't

| OpenClaw Feature | Why HIVE Skips It |
|-----------------|-------------------|
| Always-on daemon with heartbeat | Claude Code's loops and schedules handle this. An always-on daemon is infrastructure to maintain. |
| 30+ messaging channel adapters | Out of scope. HIVE is a development tool, not a chatbot framework. |
| Process orchestration (Pi runtime) | Claude Code is the runtime. Building a parallel one creates version skew. |
| Built-in automated synthesis | The chair should be the LLM in context, not a separate pipeline. Synthesis without context loses nuance. |

### What HIVE builds that OpenClaw doesn't

| HIVE Feature | Why It Matters |
|-------------|----------------|
| Identity stack (SOUL/IDENTITY/SELF) | OpenClaw has system prompts. HIVE has layered identity that separates culture, self-concept, and user context. The layers compose and evolve independently. |
| Trust classification (TRUST.md) | Explicit, human-readable action boundaries. Not buried in code — the AI reads and internalizes them. |
| Multi-vendor council | OpenClaw is primarily single-model. HIVE sends the same question to Claude, GPT, Gemini simultaneously for independent positions. |
| Ticket tracking with dependencies | Lightweight project management the AI can read and write. Work persists across sessions without external tools. |

### Shared philosophy, different implementation

Both systems agree on core principles:
- **Files over databases** — state on disk, processes stateless
- **Memory compounds** — knowledge should survive sessions
- **Many short sessions** — Ralph loops / focused sessions beat marathons

The divergence is strategic: OpenClaw builds a standalone agent framework.
HIVE rides Claude Code as the runtime and adds the layers it's missing.
The bet is that Claude Code's orchestration improves faster than we could
maintain our own, so we should focus our energy on what it structurally
can't provide — persistent identity, accumulated intelligence, and
multi-model deliberation.

---

## File Layout Reference

```
~/.hive/
├── SOUL.md              # Shared values and craft standards
├── IDENTITY.md          # AI identity — name, personality, style
├── SELF.md              # Human context — preferences, patterns
├── AGENTS.md            # Operational doctrine
├── TRUST.md             # Action classification and boundaries
├── config.md            # Model pool, provider auth, defaults
├── hooks/
│   └── load-identity.sh # SessionStart hook — injects identity
├── scripts/
│   ├── morning.sh       # 7am briefing via maya-morning agent
│   ├── nightly.sh       # 2am extraction via maya-nightly agent
│   └── hive-sync.sh     # 2:30am git commit + push
├── memory/
│   └── projects/
│       └── <name>.md    # Per-project accumulated intelligence
├── projects/
│   └── <name>/
│       ├── config.md    # Project path registration
│       └── tickets/
│           └── TK-001.md  # Individual ticket files
├── logs/                # Script execution logs
└── briefings/           # Morning briefing output

~/.claude/
├── .mcp.json            # MCP server registration (includes HIVE)
├── agents/
│   ├── maya-planner.md  # Architecture and planning agent
│   ├── maya-coder.md    # Implementation agent (worktree-isolated)
│   ├── maya-reviewer.md # Code review agent
│   └── maya-nightly.md  # Nightly maintenance agent
└── settings.json        # Hooks configuration (SessionStart)
```

---

## Quick Reference

| Task | Command |
|------|---------|
| Initialize HIVE | `bun run src/cli.ts init` |
| Register a project | `bun run src/cli.ts project add <name> <path>` |
| View project memory | `hive memory` |
| Add a fact | `hive memory fact "Uses Joken for JWT"` |
| Convene council | `hive council "Should we use X or Y?"` |
| Create a ticket | `hive ticket create "Add auth middleware" --type feature --priority 1` |
| List open tickets | `hive ticket list --status open` |
| Show unblocked work | `hive ticket ready` |
| Start a ticket | `hive ticket start TK-005` |
| Close a ticket | `hive ticket close TK-005` |
| Run planner agent | `claude --agent maya-planner "Design X"` |
| Run coder agent | `claude --agent maya-coder "Implement TK-005"` |
| Run reviewer agent | `claude --agent maya-reviewer "Review recent changes"` |
