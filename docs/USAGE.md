# Using HIVE

A practical guide. No architecture, no design philosophy — just how to
get work done.

## First Time Setup

```bash
# Install (from the repo)
bun build --compile ./bin/hive.ts --outfile hive
sudo mv hive /usr/local/bin/   # or wherever you keep binaries

# Bootstrap
hive init
```

This creates `~/.hive/` with default files. Edit these two first:

- `~/.hive/SOUL.md` — the shared culture every agent carries. This is the
  voice and values of your hive. Make it yours.
- `~/.hive/SELF.md` — who you are. Preferences, standards, context about
  how you work. Agents read this to calibrate.

## Register a Project

```bash
hive project add myapp /path/to/myapp
hive work myapp
```

This creates `~/.hive/projects/myapp/` with config, plan, board, log,
and memory files. Edit the ones that matter:

- `~/.hive/projects/myapp/PLAN.md` — what you're building
- `~/.hive/projects/myapp/config.md` — team composition, runtime defaults

## Two Ways to Work

HIVE has a terminal interface and a browser interface. They operate on the
same files. Use whichever you prefer, or both at once.

### Option A: The Browser (Gateway)

```bash
hive gateway --open
```

Opens `localhost:4200` in your browser. You get:

```
┌──────────────────────────────────────────────────────┐
│  HIVE  │  myapp  │  ● supervisor running  │  3 agents│
├────────────────────────────┬─────────────────────────┤
│                            │                         │
│   Console                  │   Feed                  │
│                            │                         │
│   you: how's auth going?   │   [14:52] alpha: done   │
│   HIVE: Alpha finished...  │   [14:53] 002 → beta    │
│                            │   [15:10] alpha → beta  │
│   [input box]              │   (auto-scrolls)        │
│                            │                         │
└────────────────────────────┴─────────────────────────┘
```

**Left panel** — Console. Type messages to the hive. Conversations are
persistent — they survive page reloads and browser restarts. Your session
history is saved to disk.

**Right panel** — Feed. A live stream of what's happening. Auto-scrolls
as new events arrive via WebSocket.

**Top bar** — Shows active project, supervisor status, and agent count.
Click the agent count to see which agents are running, their personas,
and runtimes.

#### Console Controls

| Action | How |
|--------|-----|
| Send a message | Type and press Enter |
| Multi-line message | Shift+Enter for newline, Enter to send |
| New session | Click "+ New" or press Ctrl+N (Cmd+N on Mac) |
| Browse sessions | Click "Sessions" to see past conversations |
| Switch session | Click any session in the dropdown to load it |

#### Gateway Management

```bash
hive gateway                # Start (foreground, default port 4200)
hive gateway --port 5000    # Custom port
hive gateway --open         # Start and open browser
hive gateway status         # Is it running? What port?
hive gateway stop           # Shut it down
```

The Gateway is optional. Stopping it doesn't stop running agents.

### Option B: The Terminal

```bash
# Three panes — this is the full terminal setup
hive console          # Left: conversational interface
hive watch            # Right: live feed
hive supervise        # Bottom: agents running
```

Or use individual commands:

```bash
hive say "how's auth going?"      # Quick message to the hive
hive ask                          # Status digest
hive ask "what did alpha build?"  # Ask a specific question
hive feed                         # Last 20 feed entries
hive feed 50                      # Last 50
hive status                       # Board + open messages
hive ps                           # Active and recent runs
```

## Starting Work

### The Easy Way

```bash
hive run
```

This starts supervision — the supervisor reads the board, launches agents
as needed, and keeps the loop running. It's idempotent (safe to run
multiple times). Combine with a message:

```bash
hive say "build the auth feature"
```

`hive say` auto-starts supervision if it isn't running, sends your message
as a nudge, and the hive takes it from there.

### More Control

```bash
# Start supervision with options
hive supervise --max-parallel 3        # Limit concurrent agents
hive supervise --detach                # Run in background
hive supervise status                  # Check on detached supervisor
hive supervise stop                    # Stop it

# Launch a specific agent manually
hive launch alpha                      # Launch alpha with default runtime
hive launch beta --runtime codex       # Use a specific runtime
hive launch gamma --runtime gemini     # Mix runtimes per agent

# Stop a specific agent
hive stop alpha
```

## Steering the Hive

Whether you're in the browser console or using `hive say`, you talk to
the hive in natural language:

```
"how's the auth feature going?"
"use Joken instead of Guardian for JWT"
"pause everything, I need to rethink the schema"
"show me what beta built"
"assign the API review to the critic"
"the token should expire in 1 hour, not 24"
```

The hive reads the current state (board, plan, messages, runs) and
responds with awareness of what's happening. It can send messages to
agents, update the plan, and record decisions.

## Runtimes

HIVE supports multiple AI runtimes. Agents can use different ones for
different tasks.

```bash
hive runtimes     # See what's installed
```

Built-in adapters: **claude** (Claude Code), **codex** (OpenAI Codex),
**gemini** (Gemini CLI).

Set a default per-project in `~/.hive/projects/<project>/config.md`:

```markdown
runtime: claude
```

Or override per-agent at launch time:

```bash
hive launch alpha --runtime gemini
hive launch beta --runtime codex
```

The supervisor can also choose runtimes based on the steward's judgment.

## Sessions

Console sessions are persistent and file-backed. They live in
`~/.hive/sessions/`.

**In the browser:** Sessions are managed through the toolbar above the
console. You can create new sessions, browse past ones, and switch
between them.

**In the terminal:**

```bash
hive console                    # Resume the active session
hive console --runtime gemini   # Use a specific runtime
```

Sessions survive everything — page reloads, browser restarts, machine
reboots. The conversation history is markdown on disk.

## Project Memory

HIVE accumulates knowledge as agents work. You can also add to it
directly:

```bash
hive memory                           # Show current project memory
hive memory fact "API uses JWT auth"
hive memory convention "always use Joken, never Guardian"
hive memory decision "chose Postgres over SQLite for concurrency"
hive memory question "should we use GraphQL or REST?"
```

Memory is per-project and is included in agent prompts so they have
context about past decisions.

## Day-to-Day Reference

### Start of day

```bash
hive work myproject     # Switch to the project
hive ask                # Quick status digest
hive gateway --open     # Open the browser interface
# or
hive run                # Start supervision from terminal
```

### While working

```bash
hive say "focus on the payments module today"   # Give direction
hive ps                                          # Check on agents
hive feed                                        # Recent activity
hive stop alpha                                  # Stop an agent
hive launch alpha --runtime codex                # Relaunch with different runtime
```

### End of day

```bash
hive ask "summarize what got done today"
hive archive                                     # Archive the session
```

## Quick Reference Card

```
hive init                     Bootstrap ~/.hive/
hive project add <n> <path>   Register a project
hive work [project]           Switch/show active project

hive run                      Start supervision (idempotent)
hive say <msg>                Send message + auto-start
hive ask [question]           Status digest or LLM-powered answer
hive stop <agent|run>         Stop an agent

hive gateway [--open]         Start browser UI at localhost:4200
hive gateway status           Check if running
hive gateway stop             Shut it down

hive console                  Interactive terminal session
hive watch                    Live feed tail
hive feed [n]                 Recent feed entries
hive status                   Board + open messages
hive ps                       Active/recent runs
hive runtimes                 Installed runtimes

hive launch <agent> [goal]    One-shot agent run
hive supervise [--detach]     Autonomous supervisor loop

hive log <msg>                Append to project log
hive msg <from> <to> <body>   Agent-to-agent message
hive inbox [agent]            Check agent messages
hive memory                   Show/add project memory
hive archive                  Archive session
hive help                     Full usage text
```
