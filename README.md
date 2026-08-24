# <img src="img/logo.svg" alt="" width="32" height="32"> Hive

HIVE wraps the subscription coding CLI you already run — Claude Code by default, Codex
(`hive -x`), Pi (`hive -3`), or Cursor CLI (`hive -a`) on opt-in — and gives the
agent a memory, a ticket queue, and a nightly reflection loop. Identity is
the substrate that carries all three across sessions and harnesses.

The AI agent ecosystem has claws, hippos, and filing cabinets. They want to own your stack with databases and local embedding servers. HIVE takes the best ideas from all of them
and re-implements them in a lightweight shell around subscription CLIs. No
databases. No vector stores. No dependencies worth mentioning.
Everything is markdown files in `~/.hive/`, tracked by git,
readable by humans.

The coding harness handles the conversation, tools, and file I/O. HIVE adds
what it doesn't remember on its own, most valuable first:

- **Wraps your CLI** — `hive` launches Claude Code (or Codex with `-x`, Pi
  with `-3`, Cursor with `-a`) already carrying identity, project memory,
  and MCP reach.
- **Project memory** — three layers (log, knowledge, index) with BM25
  search and decay, so knowledge compounds instead of resetting.
- **Tickets** — per-project bugs, features, tasks, epics, and chores as
  markdown the agent can plan against.
- **Reflection & taste** — a nightly pass distills your sessions into
  verified canon and an optional taste layer. Tell the agent once, it
  sticks.
- **Identity (the substrate)** — SOUL / IDENTITY / SELF carry who the agent
  is across every session, so memory and reflection have something to
  attach to.

Smaller surfaces sit underneath: a multi-model council, standing-question
watches, a morning dashboard, language-stack skills, and the local MCP server
that ties it together. Details below.

## What It Does

Sections run most valuable first — the top group is why HIVE exists.

**Wraps your CLI.**

- `hive` launches the coding CLI you already run with HIVE identity,
  project memory, and MCP reach already wired in. Claude Code is the
  default; `hive -x` launches Codex, `hive -3` launches Pi, and `hive -a`
  launches Cursor CLI. Each harness receives the same canonical identity —
  a SessionStart hook for Claude Code, `~/.codex/AGENTS.md` for Codex, a
  generated `-e` extension for Pi, and the initial positional prompt for
  Cursor. See [Interactive
  Harnesses](#interactive-harnesses) for the full routing matrix.
- The harness still owns the conversation, tools, and file I/O. HIVE adds
  only what it doesn't remember on its own.

**Project memory.**

- Facts, conventions, decisions, and open questions accumulate in `~/.hive/memory/projects/<name>/`. Agents read and write this through MCP tools. Knowledge compounds over time instead of starting fresh every session.
- New projects skip the cold start: `hive project bootstrap [--infer]` scans a registered repo and seeds candidate facts (stack, build/test/CI, conventions, architecture summary). The nightly verifier admits what's canon-worthy. See `docs/memory-architecture.md` for the candidate-writer paths.
- Inspired by [Hippo](https://github.com/kitfunso/hippo-memory): memory
decay and retrieval strengthening — entries you actually use get
stronger, everything else fades. Biological memory dynamics without
the SQLite.
- Inspired by [ClawMem](https://github.com/yoloshii/ClawMem): BM25 ranked
search as the base retrieval layer. No embeddings needed at this scale.
- Inspired by [claude-mem](https://github.com/thedotmack/claude-mem):
progressive disclosure — lightweight index at session start, details
on demand.

**Tickets.**

- Per-project tickets stored as markdown files with YAML frontmatter at `~/.hive/projects/<name>/tickets/`. Bugs, features, tasks, epics, and chores with priorities, tags, dependencies, and timestamped notes. 
- Tickets live under `~/.hive/`, not in the repo — they're a personal working surface for one developer's human+agent loop, not a team coordination layer. Each dev on a project opts into HIVE independently; team-wide work still belongs in GitHub Issues, Linear, or whatever your team already uses.
- Inspired by [Beads](https://steve-yegge.medium.com/introducing-beads-a-coding-agent-memory-system-637d7d92514a): per-project ticket tracking with dependencies, priorities, and agent-readable markdown — work graphs the AI can plan against.

**Reflection & taste.**

- The reason memory compounds without you curating it. A launchd job runs at 2am and walks a five-pass pipeline over the last 24 hours: condition (rank Claude Code + Codex session exchanges by signal × novelty), Sonnet extracts per-project candidates, Sonnet extracts cross-project reflections, Opus verifies and writes the morning briefing, then a mechanical pass lands accepted decisions to canon. Cost is typically $1–3/night; every run is auditable in `~/.hive/memory/runs/{DATE}/`.
- Corrections and preferences you give in any session — "don't mock the database," "use Joken not Guardian," "stop summarizing at the end of every response" — flow as candidates to the night, get verified, and apply in every future session. Tell the agent once, it sticks forever.
- Taste is a durable, human-gated layer, not just facts. The nightly pass also extracts **taste units** — judgments about how to do a kind of work well — and files them by work type (IDEAS, DESIGN, IMPLEMENTATION, TEST_EVAL, COMMUNICATION, PROCESS). A recurrence gate moves a unit from `holding` to `pending`; you approve the ones worth keeping into `active`. Agents pull the active set mid-session with `search_taste`, and the `/taste` dashboard page is the readable library.
- The most durable principles get promoted to `~/.hive/taste/principles.md` — the apex layer that loads last and loudest in every session, the agent's accumulated judgment across all work.

**Identity — the substrate.**

- SOUL.md, IDENTITY.md, and SELF.md in `~/.hive/` define who the agent is, what it values, and how it works with you. This is the infrastructure the rest sits on — it scopes memory and reflection to a project and carries them across sessions. Claude Code loads it through the user-level SessionStart hook; Codex through `~/.codex/AGENTS.md`, refreshed by `hive -x` and its own SessionStart hook; Pi through a generated extension; Cursor through the initial positional prompt.
- Inspired by [OpenClaw](https://openclaw.ai/).

### Also included

Smaller surfaces — reach for them when a project needs them.

- **Multi-model council.** Send one question to Claude, GPT, Gemini, and local models in parallel; the current agent chairs and synthesizes agreement and disagreement. Standard or adversarial-dialectic modes. `hive council "<question>"`. Inspired by [Perplexity](https://perplexity.ai/).
- **Watches.** Markdown standing questions run on declared cadences against bounded local evidence. Observe connects threads, Propose writes into the nightly briefing, and Act may start one deterministically eligible ticket on an isolated review branch. No change means no model call. `hive watch status`; see [docs/watches.md](docs/watches.md).
- **The dashboard.** One page that opens with a verdict per project instead of a log — see [The Dashboard](#the-dashboard) below. A static `~/.hive/dashboard/index.html` or an interactive server at `127.0.0.1:7777`. `hive dashboard`. See [docs/dashboard.md](docs/dashboard.md).
- **Language stacks.** Domain-knowledge bundles — Iron Laws, patterns, idioms — packaged as Claude Code skills and auto-detected per project (`mix.exs` → elixir, `package.json` → typescript). The verified Cursor CLI also reads `~/.claude/skills/`, but that compatibility does not guarantee every skill is portable. Ships **elixir** and **typescript**; `hive stack init <name>` scaffolds your own. Elixir content from [oliver-kriska/claude-elixir-phoenix](https://github.com/oliver-kriska/claude-elixir-phoenix), TypeScript from [Jeffallan/claude-skills](https://github.com/Jeffallan/claude-skills) (both MIT).
- **Local MCP server.** The consistency layer that exposes memory, tickets, and council to every harness — markdown underneath, no database.

## The Dashboard

Every night HIVE inspects the projects it tracks. The dashboard is the
inspection report, and it opens with the answer: which projects want you
today, and why.

<img src="img/dashboard.png" alt="The HIVE dashboard: the wordmark, then in large type '9 of 14 colonies need you today', then a yard of painted hive boxes standing at different heights on a shared baseline — each labelled with a verdict (NEEDS YOU, QUEENLESS, ACTIVE, WAITING, QUIET), a one-line reason, and its ticket and memory counts" width="900">

The whole first screen is that answer and nothing else. Each project is a
colony: it stands as tall as its accumulated memory, its entrance at the
base is as wide as its ticket traffic, and the plate underneath carries
the verdict the night reached with the reason it reached it. Painted means
look at me; unpainted pine means fine. Height and width are data, not
decoration, so the yard reads as magnitude before it reads as text.

Below the yard: what actually landed (commit subjects as people wrote
them), the morning briefing set in columns, whatever the watches said
overnight, a five-per-project ticket shortlist, the memory store, and 30
days of past briefings. Click any colony to narrow the whole page to that
project. `/tickets`, `/taste` and `/watches` are their own pages.

The design system it was built against is recorded in
[DESIGN.md](DESIGN.md).

## Quick Start

```bash
git clone <repo-url> ~/work/hive
cd ~/work/hive
./install.sh
```

This builds the binaries, creates `~/.hive/` with identity templates,
installs agents and scripts, registers the MCP server, and sets up
launchd jobs. It will prompt for your name to personalize templates
(or pass `--name="Your Name"`).

The installer registers four launchd jobs:

| Job | Schedule | What it does |
| --- | --- | --- |
| `com.hive.nightly` | 2:00am daily | Runs the V1 memory pipeline: condition → Sonnet extract → Opus verify → apply → rebuild dashboard. Lands the morning briefing. |
| `com.hive.sync` | 2:30am daily | Commits and pushes `~/.hive/` to git |
| `com.hive.dashboard` | KeepAlive | Serves the local interactive dashboard on `127.0.0.1:7777` |
| `com.hive.watches` | Hourly | Evaluates due standing questions; delta-gated watches make no model call when nothing changed |

All jobs log to `~/.hive/logs/`. Manage with `launchctl`:
```bash
launchctl list | grep hive         # see running jobs
launchctl unload ~/Library/LaunchAgents/com.hive.watches.plist  # stop one
```

Then register a project and start working:

```bash
hive project add myapp ~/work/myapp
cd ~/work/myapp
hive
```

`hive` launches Claude Code with HIVE identity. `hive -3` launches Pi,
`hive -x` launches Codex, and `hive -a` launches Cursor CLI instead. Direct `claude` sessions still receive
HIVE identity through the Claude Code SessionStart hook after `hive init`.

## Interactive Harnesses

Harness flags apply only when `hive` is launching an agent session. Local
commands such as `hive doctor`, `hive ticket list`, and `hive memory` run
inside HIVE itself.

| Invocation | Runtime | Identity path |
| --- | --- | --- |
| `hive` / `hive "<prompt>"` | Claude Code | Per-invocation `--append-system-prompt` plus `~/.claude` SessionStart hook |
| `hive -3 "<prompt>"` / `hive --pi "<prompt>"` | Pi CLI | Runtime-generated `-e` identity extension; Pi owns provider/model selection |
| `hive -x "<prompt>"` / `hive --codex "<prompt>"` | Codex CLI | `~/.codex/AGENTS.md`, refreshed before launch and by `~/.hive/codex-load-identity.sh` |
| `hive -a "<prompt>"` / `hive --cursor "<prompt>"` | Cursor CLI | Canonical identity prepended to the positional initial prompt; bare interactive consumes a synthetic first turn |
| `HIVE_HARNESS=pi hive "<prompt>"` | Pi CLI | Same as `-3`; override with `--claude` or `--claude-code` |
| `HIVE_HARNESS=codex hive "<prompt>"` | Codex CLI | Same as `-x`; override with `--claude` or `--claude-code` |
| `HIVE_HARNESS=cursor hive "<prompt>"` | Cursor CLI | Same as `-a`; override with `--claude` or `--claude-code` |

`-3` / Pi is an opt-in research lane while the subscription-OAuth policy
question remains open. Claude Code stays the default.

### Claude Code modes

When `hive` launches Claude Code, a flag controls how the HIVE identity
relates to Claude Code's own default system prompt:

| Flag | Default prompt | Hooks / skills / MCP | Auth | Claude arg |
| --- | --- | --- | --- | --- |
| _(none)_ — `append` | kept | kept | subscription OAuth | `--append-system-prompt` |
| `--owned` | **replaced** by HIVE identity | kept | subscription OAuth | `--system-prompt` |
| `--bare` | **replaced** by HIVE identity | dropped | requires `ANTHROPIC_API_KEY` | `--bare --system-prompt` |

Default `append` sits the HIVE identity after Anthropic's base prompt.
`--owned` makes the HIVE identity the entire system prompt while keeping
hooks, skills, MCP, and OAuth. `--bare` goes further — it skips hook,
plugin, and `CLAUDE.md` auto-discovery entirely and never reads OAuth or
keychain (Claude Code's design), so it requires `ANTHROPIC_API_KEY` and
wires HIVE MCP explicitly via `--mcp-config`. Set the mode with the flag or
`HIVE_CLAUDE_MODE=owned|bare`.

After init, customize these files:

| File | What to put there |
| --- | --- |
| `~/.hive/SELF.md` | Who you are: role, stack preferences, communication style, working patterns |
| `~/.hive/IDENTITY.md` | Who the AI is: personality, name, how it thinks |
| `~/.hive/SOUL.md` | Shared values and craft standards |
| `~/.hive/config.md` | Model pool and runtime defaults for council/steward lanes |

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

After `hive init`, identity injection is automatic for every project.
The user-level SessionStart hook (`~/.claude/hooks/load-identity.sh`,
wired in `~/.claude/settings.json`) loads the soul stack, the project's
memory index (if registered), stack hint, and optional taste layer at every
session start. Pi gets the same prefix through a generated launch extension;
Codex gets it through `~/.codex/AGENTS.md`, refreshed before every `hive -x`
launch and by the Codex SessionStart hook when Codex is installed and
`hive init` has wired it. Cursor gets it in the positional initial prompt;
a bare `hive -a` consumes a synthetic startup turn. No per-project
`CLAUDE.md` block required.

Register the project so its memory and tickets work:

```bash
hive project add yourproject ~/work/yourproject
```

That's it. The hook matches `$PWD` against registered project paths
and loads the right memory automatically. Keep `CLAUDE.md` in the
project repo for project-specific guidelines only (framework conventions,
domain constraints) — identity loads independently.

## MCP Tools

Available to supported harnesses when the HIVE MCP server is registered:

| Tool | Purpose |
| --- | --- |
| `convene_council` | Send a question to multiple models in parallel. Supports `persona: "analyst"` for structured analytical framing. |
| `read_hive_memory` | Read project intelligence: facts, conventions, decisions, open questions. |
| `write_hive_memory` | Record a new fact, convention, decision, or question. Validated on write. |
| `reflect_session` | Batch-write session learnings at end of session. |
| `search_memory` | Search across all memory layers by keyword or tag. |
| `search_taste` | Retrieve the active (human-approved) taste for a work type (IDEAS, DESIGN, IMPLEMENTATION, TEST_EVAL, COMMUNICATION, PROCESS). Merges project + general stores; holding/pending never leak in. |
| `create_ticket` | Create a ticket with type, priority (P0-P3), tags, and dependencies. |
| `list_tickets` | List and filter tickets by status, type, or tags. |
| `show_ticket` | Show full ticket details. Supports partial ID matching. |
| `update_ticket` | Update ticket status, priority, tags, or other fields. |
| `add_ticket_note` | Add a timestamped note with optional actor attribution. |
| `add_project` | Register a project with HIVE (creates config, memory, tickets, and watches directories). |
| `hive_status` | Dashboard showing identity, projects, tickets, scheduled jobs, and agents. |

## CLI Commands

| Command | Purpose |
| --- | --- |
| `hive init` | Create `~/.hive/` scaffold, register MCP server |
| `hive doctor` | Validate installation health (`--verbose` for details) |
| `hive project add <name> <path>` | Register project, create memory |
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
| `hive watch list` | List discovered standing questions and their settings |
| `hive watch status` | Show watch state, outcomes, and logged usage |
| `hive watch run <name>` | Force one named watch; `--due` is the scheduled tick entry point |
| `hive watch ceiling observe\|propose\|act` | Set the global autonomy ceiling |
| `hive watch on\|off <name>` | Enable or disable a watch |
| `hive identity emit` | Print the canonical identity prefix used by hooks and harness launchers |
| `hive context` | Audit session-start context size against budgets (alias: `hive prompts`) |
| `hive context --json` | Same audit as JSON, for tracking size over time |
| `hive inbox` | Show the current project's findings inbox (`hive inbox clear` clears it) |
| `hive dashboard` | Open the dashboard (server if running, else static build) |
| `hive dashboard build` | Regenerate the static dashboard at `~/.hive/dashboard/index.html` |
| `hive dashboard serve [--port N] [--open]` | Start the interactive server on `127.0.0.1:7777` |
| `hive dashboard open` | Open the existing static dashboard in browser |
| `hive dashboard path` | Print the dashboard file path |
| `hive tickets` | Open tickets for the project you're standing in (`--all`, `--status`, `--type`, `--tags`) |
| `hive ticket create <title>` | Create a ticket (`--type`, `--priority`, `--tags`, `--depends`) |
| `hive ticket list` | List tickets (`--status`, `--type`, `--tags`) |
| `hive ticket show <id>` | Show ticket details (partial IDs work: `1` matches `TK-001`) |
| `hive ticket start <id>` | Set ticket to `in_progress` |
| `hive ticket close <id>` | Close ticket |
| `hive ticket reopen <id>` | Reopen a closed ticket |
| `hive ticket note <id> <text>` | Add a timestamped note |
| `hive ticket ready` | Show unblocked open tickets |
| `hive ticket blocked` | Show dependency-blocked tickets |
| `hive stack list` | List installed and canned stacks |
| `hive stack install <name>` | Install a canned stack template to `~/.hive/stacks/` |
| `hive stack sync <name>` | Copy stack skills into `~/.claude/skills/<name>-*` |
| `hive stack init <name>` | Scaffold an empty stack source tree |
| `hive stack bind <project> <stack>` | Bind project to a stack (name, `auto`, or `none`) |
| `hive -3 "<prompt>"` | Launch Pi CLI with HIVE identity; Pi chooses provider/model |
| `hive -x "<prompt>"` | Launch Codex CLI with HIVE identity |
| `hive -a "<prompt>"` | Launch Cursor CLI with HIVE identity prepended to the initial prompt |
| `hive --claude "<prompt>"` | Force Claude Code when another `HIVE_HARNESS` runtime is set |
| `hive --owned "<prompt>"` | Launch Claude Code with HIVE identity as the whole system prompt (keeps hooks/skills/MCP/OAuth) |
| `hive --bare "<prompt>"` | Launch Claude Code in `--bare` mode (no hooks/skills/CLAUDE.md; requires `ANTHROPIC_API_KEY`) |

## How Identity Works

Identity lives in `~/.hive/` and is emitted by one program:
`hive identity emit`. Claude Code, Pi, Codex, and Cursor consume that same
canonical prefix through different integration points.

Claude Code loads the prefix through the user-level SessionStart hook at
`~/.claude/hooks/load-identity.sh`, wired into `~/.claude/settings.json`.
The `hive` wrapper also passes the identity inline with
`--append-system-prompt` when it launches Claude Code directly.

Pi gets a generated identity extension at launch time via `pi -e <tempfile>`;
all remaining args pass through unchanged so Pi owns provider/model choice.
`hive init` also registers HIVE MCP in `~/.pi/agent/mcp.json` for
`pi-mcp-adapter` when Pi is installed. Fresh Pi setup is documented in
`docs/identity-injection.md`.

Codex loads the prefix from `~/.codex/AGENTS.md`. `hive init` writes that
file, registers HIVE MCP in `~/.codex/config.toml`, and wires a Codex
SessionStart hook at `~/.hive/codex-load-identity.sh` to refresh
`AGENTS.md` from `hive identity emit`. The `hive -x` launcher also refreshes
AGENTS before spawning Codex, which keeps project-sensitive memory and stack
context current even if the last direct Codex session was in another project.

Cursor receives the prefix in its positional initial prompt. `hive init`
merges HIVE MCP into `~/.cursor/mcp.json`, but Cursor also requires approval
per project. The `hive -a` launcher runs `cursor-agent mcp enable hive` from
the current project as a best-effort self-heal. A bare interactive launch uses
a synthetic first turn to deliver identity, then waits for the user's request.
HIVE does not use Cursor plugins for identity; a 2026-08-19 canary exited 0
without exposing its marker to the model.

Every session picks up the same stack in deliberate emit order (later
sections carry more weight in system-prompt interpretation):

1. **Soul stack** — `SOUL.md`, `IDENTITY.md`, `SELF.md`, `AGENTS.md`, `TRUST.md`
2. **Project memory** — the matched project's `_index.md` (or full
   `knowledge.md` fallback), resolved by matching `$PWD` against registered
   project paths
3. **Stack hint** — per-project skill-trigger line (e.g., "Project stack:
   elixir. The elixir-* skills carry this project's domain canon for Phoenix
   contexts, Ecto, LiveView, OTP, or security patterns — load the matching
   skill when the work calls for it.")
4. **Taste layer** — `~/.hive/taste/principles.md` when present; this is
   the last and loudest layer

Reflection discipline and first-turn MCP pre-fetch live in `AGENTS.md`, not
in a separate generated block. `OVERRIDES.md` was retired from the canonical
stack; `hive doctor` warns if a live copy is still sitting around.

That stack costs the same tokens in every session, so `hive context` measures
it against the budgets set at the 2026-07 slim-down — soul stack, persona,
project memory index, stack hint, taste layer, plus each registered project's
`CLAUDE.md`:

<img src="img/hive-context.png" alt="hive context output: a block grid showing the identity injection at 30.1KB of a 40KB window, with per-layer and per-project budget bars" width="820">

It exits 1 when anything is over budget, so it can gate CI or a pre-push hook.
`--json` emits the same report for tracking size over time. See
`docs/identity-injection.md` for what each budget is calibrated against.

### Tuned for Current Harnesses

Claude Code 2.1.x introduced deferred tool schemas and stronger base-prompt
pressure toward terse responses. HIVE answers that in `AGENTS.md`: MCP tools
are named as first reach, first-turn schema pre-fetch is explicit, and voice
is treated as part of the task rather than decoration. SOUL.md and
IDENTITY.md templates lead with positive voice examples.

Pi uses an ephemeral extension because its runtime lets HIVE prepend the
system prompt directly while still letting Pi choose the model. Codex has a
different loading surface: persistent `AGENTS.md`, MCP servers in
`config.toml`, and hooks in `hooks.json`. HIVE uses those native files
instead of per-invocation prompt injection, which preserves Codex's prefix
cache across sessions. Cursor has no verified system-prompt surface, so HIVE
uses its positional initial prompt. The verified Cursor version reads
`~/.claude/skills/`; this is compatibility behavior, not a guarantee that
every Claude Code skill is portable. `hive doctor` checks Claude Code, Pi,
Codex, and Cursor wiring; optional-harness checks are warnings.

Watch Act uses Claude Code for isolated branch execution. `-3`, `-x`, and
`-a` are interactive harness routes; they do not change the watch executor.
The nightly pipeline ingests Claude Code and Codex transcripts. It does not
ingest Pi or Cursor transcripts.

See `docs/hive-reach.md` for the runtime reach matrix (identity, MCP
tools, project scope per harness) and `docs/identity-injection.md` for
the identity architecture deep dive — emit order, cache stability
guarantees, the "Maya feels cold" debug runbook, and how to add a new
file to the stack.

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

## Automation: Watches

Watches replace the old periodic agent loop with explicit standing questions.
The file declares cadence, evidence scope, model tier, output venue, and an
autonomy level bounded by a global ceiling. Act can start one eligible ticket
in a local worktree, but never merges or pushes; human review remains the
landing step. See [docs/watches.md](docs/watches.md).

## File Layout

```
~/.hive/
├── SOUL.md              # shared values
├── IDENTITY.md          # AI identity
├── SELF.md              # user preferences
├── AGENTS.md            # operational doctrine
├── TRUST.md             # action classification and boundaries
├── config.md            # model pool
├── codex-load-identity.sh # Codex SessionStart identity refresher
├── taste/
│   └── principles.md    # optional last/loudest taste layer
├── memory/
│   ├── projects/        # per-project intelligence
│   │   └── <name>/
│   │       ├── knowledge.md  # compiled facts, conventions, decisions
│   │       ├── _index.md     # auto-generated summary loaded at session start
│   │       ├── _meta.json    # search metadata (decay, recall counts)
│   │       ├── candidates.md # mid-session writes pending nightly admission
│   │       └── log/          # daily session log entries
│   └── runs/            # nightly pipeline artifacts
├── briefings/           # morning briefings
├── runs/                # private Watch Act execution records
│   └── RUN-001/
│       ├── goal.md, status, plan.md, output.log, pid
├── projects/
│   └── <name>/
│       ├── config.md    # project path
│       ├── inbox.md     # watch and nightly findings
│       ├── watches/     # project-scoped standing questions
│       └── tickets/
│           └── TK-001.md
├── scripts/             # launchd entry points
└── logs/                # nightly, watches, dashboard, sync logs
```

## Requirements

- [Bun](https://bun.sh/) 1.3+
- macOS (launchd required for scheduled jobs)

For multi-model council:
- Claude CLI subscription OAuth (macOS keychain) or `ANTHROPIC_API_KEY`
- Codex CLI subscription OAuth or `OPENAI_API_KEY` for GPT models
- Gemini CLI OAuth for Google models
- `ollama` running locally for local models

## Development

```bash
bun build src/cli.ts --compile --outfile hive-bin
bun build src/mcp-server.ts --compile --outfile hive-mcp
bun test
```

## Design Values

**Memory over infrastructure.** The interesting part of AI coordination is
what the agent remembers and how it sharpens over time — not the plumbing
underneath. Keep the plumbing thin.

**Files over databases.** `cat ~/.hive/SOUL.md` tells you who your AI
is. No dashboard required.

**Ride the platform.** Claude Code does orchestration. Don't rebuild it.
Add what it doesn't ship with.
