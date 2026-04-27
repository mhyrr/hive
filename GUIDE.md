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

These are loaded at session start via the `hive` CLI wrapper, which
assembles the stack and passes it to Claude Code via
`--append-system-prompt-file`. Projects also reference the identity
files in their CLAUDE.md for sessions started directly via `claude`.

### Project Memory

Per-project intelligence accumulates in `~/.hive/memory/projects/<name>/knowledge.md`
with four sections:

- **Durable Facts** — architecture, constraints, gotchas
- **Conventions** — coding patterns, tool preferences, naming
- **Decisions** — choices made with rationale and dates
- **Open Questions** — unresolved issues for future sessions

Memory is written via MCP tools (`write_hive_memory`, `reflect_session`)
and read at session start (via the identity assembly) and on-demand via
`read_hive_memory`. Retrieval uses BM25 ranked search with decay —
entries you use get stronger, unused entries fade in ranking. Every write
is validated against corruption and serialized to prevent lost-update bugs.

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

### The `hive` CLI Wrapper

The core integration point. The `hive` command wraps Claude Code with
identity injection. When you run `hive` (with or without arguments),
it assembles the full identity stack into a temp file and launches
Claude Code with `--append-system-prompt-file`:

1. Loads the identity stack: SOUL.md, IDENTITY.md, SELF.md, AGENTS.md, TRUST.md
2. Resolves the current project by matching `$PWD` against registered project paths
3. Loads the matched project's memory index (`_index.md`)
4. Appends the session reflection protocol

Any arguments you pass to `hive` are forwarded to Claude Code. So
`hive --agent maya-coder "implement TK-005"` becomes a Claude Code
session with identity prepended.

For sessions started directly via `claude` (not through the `hive`
wrapper), projects include a HIVE block in their CLAUDE.md that
tells the agent to read the identity files and use MCP tools.

### Custom Agents

HIVE installs custom agent definitions to `~/.claude/agents/`. Agent
names are derived from your IDENTITY.md name:

| Agent | Role | Key Tools |
|-------|------|-----------|
| `maya-planner` | Architecture and planning | `read_hive_memory`, `convene_council`, `create_ticket` |
| `maya-coder` | Implementation in isolated worktrees | `read_hive_memory`, `write_hive_memory` |
| `maya-reviewer` | Code review against project conventions | `read_hive_memory` |

Each agent reads the identity stack and project memory via CLAUDE.md
references. The planner reads memory and tickets before architecting.
The coder reads conventions before writing code. The reviewer checks
work against accumulated standards.

Nightly memory extraction is no longer agent-driven — it runs as a
deterministic five-pass pipeline (see `hive memory nightly` and the
"Scheduled Tasks" table below).

### Scheduled Tasks Use HIVE Tools

Cron jobs installed by `hive init` drive recurring automation:

| Schedule | Script | What It Does |
|----------|--------|-------------|
| 2:00 AM | `nightly.sh` | Runs `hive memory nightly` — five-pass pipeline (condition → Sonnet extract per project → Sonnet reflections → Opus verify + brief → apply to canon → rebuild dashboard). Lands the morning briefing at `~/.hive/briefings/{DATE}.md`. |
| 2:30 AM | `hive-sync.sh` | Commits and pushes `~/.hive/` changes to git remote |

The nightly pipeline is deterministic plumbing plus three LLM calls
(two Sonnet, one Opus). All run-state lives at
`~/.hive/memory/runs/{DATE}/` for restartability and audit. Cost
typically $1–3/night, recorded in `usage.json` for the dashboard.

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
- macOS (launchd required for heartbeat and scheduled jobs)

For multi-model council (optional):
- Claude CLI subscription OAuth or `ANTHROPIC_API_KEY`
- Codex CLI subscription OAuth or `OPENAI_API_KEY` for GPT models
- Gemini CLI OAuth for Google models
- `ollama` running locally for local models

### Step 1: Initialize HIVE

```bash
cd ~/work/hive   # or wherever you cloned this repo
./install.sh
```

This builds the binaries and creates:
- `~/.hive/` with identity templates (SOUL.md, IDENTITY.md, SELF.md, AGENTS.md, TRUST.md)
- `~/.hive/config.md` with model pool configuration
- `~/.hive/scripts/` with nightly, heartbeat, and sync scripts
- `~/.claude/agents/` with HIVE agent definitions (maya-planner, maya-coder, maya-reviewer)
- Launchd jobs for heartbeat, nightly extraction, dashboard, and state sync
- MCP server registration in `~/.claude.json`
- `hive` and `hive-mcp` binaries symlinked to `~/.local/bin/`

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
- Creates `~/.hive/memory/projects/myapp/knowledge.md` with empty memory sections
- Creates `~/.hive/projects/myapp/HEARTBEAT.md` with default standing orders

Then add the HIVE reference block to your project's CLAUDE.md manually
(see the README template).

### Step 4: Start Working

```bash
cd ~/work/myapp
claude
```

Claude Code starts with HIVE identity loaded (either via the `hive`
wrapper or via CLAUDE.md references). The agent knows who it is, reads
project memory, and has access to HIVE MCP tools.

---

## 6. Workflow Patterns

### Nightly Memory Extraction (V1 pipeline)

The `nightly.sh` script runs `hive memory nightly` at 2 AM. The morning
briefing falls out as one of its artifacts; there is no separate 7am job.

```bash
hive memory nightly        # default LIVE; HIVE_NIGHTLY_DRY_RUN=1 to suppress canon writes
```

Five passes against the last 24 hours of activity:

1. **Pass A — condition.** Rank session exchanges (token count × novelty
   against canon, plus always-include markers). Survey git, tickets,
   heartbeat. Skip-if-trivial early exit emits a stub briefing.
2. **Pass B — Sonnet, per project.** Extract candidates (decisions,
   conventions, durable facts, open questions) with provenance.
3. **Pass C — Sonnet, cross-project.** Extract reflections about Greg,
   Maya, and the system itself.
4. **Pass V — Opus.** One call decides accept/supersede/merge/reject per
   candidate, surfaces gaps Sonnet missed, reads taste principles, and
   writes the morning briefing.
5. **Pass F — apply.** Mechanical: land accepted entries to canon,
   supersede by hash, merge tags, drop rejected. Drain mid-session
   `candidates.md`. Truncate inbox. Rebuild dashboard. Copy briefing.

All run-state lives at `~/.hive/memory/runs/{DATE}/`: `condition.json`,
`candidates.B.{name}.json`, `candidates.C.json`, `decisions.json`,
`gaps.md`, `taste.md`, `briefing.md`, `verifier-output.json`,
`usage.json`. Cost typically $1–3/night.

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

1. Reads HIVE memory for context (automatic via identity assembly)
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

Tickets persist across sessions. The morning briefing (produced by the
nightly verify pass) ranks open tickets across projects under "What
needs your attention."

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
├── scripts/
│   ├── nightly.sh       # 2am — runs `hive memory nightly` pipeline
│   ├── heartbeat.sh     # 30-min ticks — per-project heartbeat
│   └── hive-sync.sh     # 2:30am — git commit + push
├── memory/
│   ├── projects/
│   │   └── <name>/
│   │       ├── knowledge.md     # Compiled facts, conventions, decisions
│   │       ├── _index.md        # Auto-generated summary
│   │       ├── _meta.json       # Search metadata (decay, recall counts)
│   │       ├── candidates.md    # Mid-session writes pending nightly admission
│   │       └── log/             # Daily session log entries
│   └── runs/
│       └── {DATE}/              # Nightly pipeline artifacts (see GUIDE §6)
├── projects/
│   └── <name>/
│       ├── config.md    # Project path registration
│       ├── HEARTBEAT.md # Standing orders + authorized actions
│       ├── heartbeat.json # Heartbeat config + counters
│       ├── inbox.md     # Heartbeat findings
│       └── tickets/
│           └── TK-001.md  # Individual ticket files
├── logs/                # Script execution logs
└── briefings/           # Morning briefing output (landed by Pass F)

~/.claude.json               # MCP server registration (includes HIVE)
~/.claude/
├── agents/
│   ├── maya-planner.md  # Architecture and planning agent
│   ├── maya-coder.md    # Implementation agent (worktree-isolated)
│   └── maya-reviewer.md # Code review agent
```

---

## Quick Reference

| Task | Command |
|------|---------|
| Initialize HIVE | `./install.sh` |
| Register a project | `hive project add <name> <path>` |
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
