# HIVE Runtime Integration Guide

How the pieces fit together: what HIVE provides, what Claude Code provides
as the default harness, what Pi and Codex provide as opt-in harnesses, and
how they compose into a persistent AI development partner.

---

## 1. Architecture Overview

HIVE is an identity, memory, and council layer for CLI coding agents.
Claude Code is the default runtime. Pi and Codex are available for
interactive sessions through `hive -3` and `hive -x`. HIVE provides what
the harnesses do not remember on their own:

```
┌─────────────────────────────────────────────────┐
│              CLI Coding Harnesses                │
│  Claude Code (default) · Pi (-3) · Codex (-x)    │
│  Tools · File I/O · Hooks · MCP Integration      │
├─────────────────────────────────────────────────┤
│                     HIVE                         │
│  Identity Stack · Project Memory · Multi-Model   │
│  Council · Ticket Tracking · Trust Boundaries    │
└─────────────────────────────────────────────────┘
│                                                   │
│              ~/.hive/ (Markdown files)            │
└───────────────────────────────────────────────────┘
```

The boundary is clean: the harness is the engine, HIVE is the soul.
The harness does not know who it is between sessions. HIVE makes it
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

These are emitted by `hive identity emit`, the single canonical identity
builder. Claude Code consumes that prefix through the user-level
SessionStart hook and, when launched through `hive`, a temp
`--append-system-prompt-file`. Pi consumes it through a generated launch
extension. Codex consumes it through `~/.codex/AGENTS.md`, refreshed by a
Codex SessionStart hook.

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

## 3. What The Harness Handles

These are runtime features that HIVE deliberately does not replicate.
Claude Code has the richest surface today, so it remains the default:

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

Pi and Codex are intentionally narrower in HIVE today: they are interactive
harnesses. Pi is selected with `hive -3` / `hive --pi`; HIVE injects identity
with a generated `-e` extension and lets Pi choose provider/model. Codex is
selected with `hive -x` / `hive --codex`, backed by Codex's native
`AGENTS.md`, `config.toml`, and `hooks.json` files. Dispatch and heartbeat
still run through Claude Code by default.

---

## 4. How They Compose

### The `hive` CLI Wrapper

The core integration point. When you run `hive` with no HIVE command, it
launches an agent harness with identity attached:

1. Loads the identity stack: SOUL.md, IDENTITY.md, SELF.md, AGENTS.md, TRUST.md
2. Resolves the current project by matching `$PWD` against registered project paths
3. Loads the matched project's memory index (`_index.md`)
4. Adds the stack hint and optional taste layer

Current routing:

| Invocation | Runtime | Notes |
| ---------- | ------- | ----- |
| `hive` / `hive "<prompt>"` | Claude Code | Default. Arguments pass through to `claude` with identity prepended. |
| `hive -3 "<prompt>"` / `hive --pi "<prompt>"` | Pi CLI | Optional interactive path. Uses a generated identity extension; Pi owns provider/model selection. |
| `hive -x "<prompt>"` / `hive --codex "<prompt>"` | Codex CLI | Optional interactive path. Uses `~/.codex/AGENTS.md` and HIVE MCP registration. |
| `HIVE_HARNESS=pi hive "<prompt>"` | Pi CLI | Env-var default; `--claude` or `--claude-code` overrides it. |
| `HIVE_HARNESS=codex hive "<prompt>"` | Codex CLI | Env-var default; `--claude` or `--claude-code` overrides it. |

`-3` / Pi is an opt-in research lane while the subscription-OAuth policy
question remains open. Claude Code stays the default.

Known HIVE commands (`hive doctor`, `hive memory`, `hive ticket`, etc.)
run inside HIVE itself. Harness flags are for agent sessions, not local
management commands.

### Custom Agents

HIVE installs custom agent definitions to `~/.claude/agents/`. Agent
names are derived from your IDENTITY.md name:

| Agent | Role | Key Tools |
|-------|------|-----------|
| `maya-planner` | Architecture and planning | `read_hive_memory`, `convene_council`, `create_ticket` |
| `maya-reviewer` | Code review against project conventions | `read_hive_memory` |

Each agent receives the identity stack and project memory from the same
canonical identity path as interactive sessions. The planner reads memory
and tickets before architecting. The reviewer checks work against
accumulated standards.

Implementation has no bespoke agent — dispatches ride Claude Code's
native subagents. The dispatch prompt carries the HIVE briefing:
`show_ticket` for the spec, `read_hive_memory` and `search_taste`
before coding, `write_hive_memory` for discovered conventions. The
doctrine lives in AGENTS.md under Model Economy.

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
- `~/.claude/agents/` with HIVE agent definitions (maya-planner, maya-reviewer)
- Launchd jobs for heartbeat, nightly extraction, dashboard, and state sync
- MCP server registration in `~/.claude.json`
- Pi MCP registration in `~/.pi/agent/mcp.json` when Pi is installed
- Codex MCP + identity wiring in `~/.codex/` when Codex is installed
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
hive project add myapp ~/work/myapp
```

This:
- Creates `~/.hive/projects/myapp/config.md` with the project path
- Creates `~/.hive/memory/projects/myapp/knowledge.md` with empty memory sections
- Creates `~/.hive/projects/myapp/HEARTBEAT.md` with default standing orders

No per-project CLAUDE.md block is required for HIVE identity. Keep
project CLAUDE.md files for project-specific rules only.

### Step 4: Start Working

```bash
cd ~/work/myapp
hive
```

Claude Code starts with HIVE identity loaded. To run the same project
through Pi or Codex instead:

```bash
hive -3
hive -x
```

The agent knows who it is, reads project memory, and has access to HIVE
MCP tools in either supported harness.

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

# In a session, dispatch parallel implementation subagents.
# Each dispatch names its ticket and carries the HIVE briefing.
"Dispatch two worktree-isolated subagents: TK-005 (JWT middleware)
and TK-006 (user registration). Each reads its ticket via show_ticket
and conventions via read_hive_memory before coding."
```

Each coder gets its own git worktree (request `isolation: worktree`
on the dispatch). They can't step on each other's files. They all
read the same HIVE memory for conventions. When they finish, their
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
coder dispatch → starts TK-012, adds notes with findings, closes when done
coder dispatch → starts TK-013 (was blocked on TK-012, now unblocked)

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
HIVE rides Claude Code as the default runtime and adds the layers it is
missing. The bet is that Claude Code's orchestration improves faster than
we could maintain our own, so HIVE focuses on what the harness structurally
cannot provide — persistent identity, accumulated intelligence, and
multi-model deliberation. Pi and Codex are second interactive lanes, not
second orchestration stacks.

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
├── codex-load-identity.sh # Codex SessionStart identity refresher
├── taste/
│   └── principles.md    # Optional final identity layer
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
| List open tickets | `hive tickets` |
| Show unblocked work | `hive ticket ready` |
| Start a ticket | `hive ticket start TK-005` |
| Close a ticket | `hive ticket close TK-005` |
| Start default session | `hive` |
| Start Pi session | `hive -3` |
| Start Codex session | `hive -x` |
| Run planner agent | `claude --agent maya-planner "Design X"` |
| Dispatch a coder | In session: "Implement TK-005 in a worktree-isolated subagent" |
| Run reviewer agent | `claude --agent maya-reviewer "Review recent changes"` |
