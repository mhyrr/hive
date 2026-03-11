# HIVE Phase 5: The Gateway

## Why This Phase Comes Next

HIVE can now run autonomously. The supervisor launches the steward, the
steward assigns work, workers execute in parallel, and the whole loop
recovers from crashes. Phase 4 turned HIVE into a team that works without
constant human intervention.

But the human's interface to that team is still a collection of CLI
commands and terminal panes. `hive console` opens an LLM session that dies
when the terminal closes. `hive watch` is a tail on a file. Switching
projects means running `hive work`. Checking on three projects means three
terminals. And the entire system only speaks Claude Code and Codex — two
runtimes out of a growing field.

The human said it plainly: "I'd like to get to a point where I can tell
the hive to setup a codex and a claude and a gemini CLI and have at it."

That sentence contains two things:

1. Multi-runtime support — the hive picks the right tool for each agent
2. A persistent interface — "tell the hive" implies a surface that is
   always there, not a CLI invocation that starts and stops

Phase 5 delivers both. It transforms HIVE from a CLI tool into a
persistent local service with a web interface, and it opens the runtime
layer to any CLI agent that can accept a prompt and return a result.

This is the right time. The autonomous loop is stable. The file-backed
state model is proven. Adding a richer human surface now means the human
can steer a team that actually runs on its own, instead of steering a
team that still needs the human to press launch. And multi-runtime
support means the hive can assign the right model to the right task
instead of being locked to one vendor.

## Goal

Open `localhost:4200` in a browser and have:

- a persistent console session with the hive (conversation survives
  page reloads, browser restarts, and machine reboots)
- a live feed of agent activity streaming in real time
- project switching, supervisor status, and agent overview at a glance
- the ability to say "use Gemini for alpha, Claude for beta, Codex for
  gamma" and have the hive respect that

The CLI remains the primitive layer. The Gateway is a surface over it,
not a replacement.

## Non-Negotiables

- Files remain the source of truth. The Gateway reads and writes the
  same `~/.hive/` files that every other part of HIVE uses.
- No external database. Session history is markdown on disk.
- No mandatory background daemon. The Gateway is opt-in. Everything
  still works without it. `hive console` still works in a terminal.
  `hive supervise` still works standalone.
- Zero npm deps. Bun's built-in HTTP server, WebSocket support, and
  file serving. No Express, no Socket.IO, no React, no bundler.
- Markdown remains the primary state representation.
- The CLI commands remain the canonical operations. The Gateway calls
  them, not the other way around.
- One writer per file still applies. The Gateway does not introduce a
  second writer for any file the supervisor or agents own.

## The Core Decisions

### Decision 1: Runtime Adapters Are A Registry, Not A Switch Statement

Today `runtime.ts` has a `RuntimeName` type that is `"codex" | "claude"`.
Adding Gemini means adding a third case. Adding Ollama means a fourth.
Every new runtime is a code change, a new branch in `buildLaunchSpec`,
and a new normalization path in `normalizeRuntimeName`.

Phase 5 replaces the hardcoded switch with a runtime registry. Each
runtime is a small adapter object that knows:

- its name and aliases
- how to build a one-shot launch command from a prompt
- how to build an interactive session command from a system prompt
- what models it supports (or whether it accepts arbitrary model strings)
- how to detect whether it is installed (`which <command>`)
- how to suppress noisy output lines

The registry is populated from two sources:

1. Built-in adapters for known runtimes (Claude Code, Codex, Gemini CLI,
   Ollama, LM Studio)
2. Custom adapters declared in `~/.hive/config.md`

This is not a plugin system. It is a data-driven dispatch table that
replaces a code-driven switch statement. The adapter interface is
internal to HIVE, not a public API.

### Decision 2: The Gateway Runs Alongside The Supervisor, Not Instead Of It

The supervisor loop is the autonomous layer. The Gateway is the human
interface layer. They are complementary.

The Gateway starts its own HTTP server and optionally starts or adopts a
supervisor for the active project. It does not replace the supervisor.
If the supervisor is already running detached, the Gateway reads its
state from disk and shows it. If no supervisor is running, the Gateway
can start one.

This means:

- `hive gateway` starts the HTTP server and serves the web UI
- The supervisor loop can run inside the Gateway process or as a separate
  detached process — the Gateway does not care which
- Stopping the Gateway does not stop agent runs
- The Gateway can be restarted without losing any state

### Decision 3: The Web UI Is Vanilla HTML/CSS/JS

No React. No Vue. No Svelte. No build step. No bundler.

The web UI is static HTML files served by the Gateway's HTTP server.
Dynamic behavior comes from vanilla JavaScript making REST calls and
listening on a WebSocket. The entire UI fits in a handful of files
that a developer can read, understand, and modify without learning a
framework.

This is consistent with HIVE's zero-dependency principle. The UI is
a thin layer over the same operations the CLI provides.

### Decision 4: Console Sessions Are Persistent And File-Backed

Today `hive console` opens an interactive LLM session that dies when the
process exits. There is no conversation history.

Phase 5 introduces persistent console sessions. Each session is a
directory under `~/.hive/sessions/` containing:

- conversation history as a markdown file
- session metadata (project, runtime, started timestamp)
- the system prompt used to initialize the session

Sessions can be resumed. When the human opens the web console, they pick
up where they left off. When a session grows too long, HIVE can summarize
and archive it, starting a fresh session with the summary as context.

The conversation history is not a chat log — it is a structured markdown
file with turns clearly delimited. This keeps it readable by both humans
and LLMs.

### Decision 5: The Hive Mind Chooses Runtimes

When the steward creates an assignment, it can now specify which runtime
to use. This is not mandatory — the fallback chain still works (plan
agent descriptor, team descriptor, project config, global config). But
the steward gains the ability to say "use Gemini for this research task
because it has a large context window" or "use Codex for this refactor
because it is cheaper."

The runtime registry exposes its capabilities to the steward prompt so
the steward can make informed choices.

## Detailed Design

### Multi-Runtime Adapter Registry

#### Adapter Interface

```typescript
type RuntimeAdapter = {
  name: string;
  aliases: string[];
  command: string;
  detectInstalled: () => Promise<boolean>;
  buildLaunchArgs: (input: {
    model: string | null;
    repoPath: string;
    hiveHome: string;
    prompt: string;
  }) => string[];
  buildInteractiveArgs: (input: {
    model: string | null;
    repoPath: string;
    hiveHome: string;
    systemPrompt: string;
  }) => string[];
  suppressLine: (line: string) => boolean;
};
```

#### Built-In Adapters

**Claude Code:**
```
command: claude
aliases: claude-code
launch: claude --print --permission-mode bypassPermissions --add-dir <hive> [--model <m>] <prompt>
interactive: claude --permission-mode bypassPermissions --add-dir <hive> [--model <m>] --system-prompt <prompt>
```

**Codex:**
```
command: codex
aliases: openai
launch: codex exec --full-auto -C <repo> --add-dir <hive> [--model <m>] <prompt>
interactive: codex --full-auto -C <repo> --add-dir <hive> [--model <m>] <prompt>
```

**Gemini CLI:**
```
command: gemini
aliases: gemini-cli
launch: gemini --non-interactive -C <repo> [--model <m>] <prompt>
interactive: gemini -C <repo> [--model <m>] --system-prompt <prompt>
```

The Gemini CLI adapter follows the same pattern. Exact flags will be
validated against the Gemini CLI's actual interface during implementation.
The adapter is the isolation layer — if Gemini's flags change, only the
adapter changes.

**Custom Runtime (config-driven):**

```markdown
## Runtimes

### aider
command: aider
launch-template: aider --no-git --yes-always {model_flag} --message {prompt}
interactive-template: aider --no-git {model_flag}
model-flag: --model
aliases: aider-chat
```

Custom runtimes declared in `~/.hive/config.md` are parsed into adapter
objects at startup. The template syntax uses `{prompt}`, `{model_flag}`,
`{repo}`, and `{hive}` placeholders.

#### Runtime Discovery

`hive runtimes` lists installed runtimes with their detection status:

```
claude-code   ✓  claude 1.0.16        (aliases: claude)
codex         ✓  codex 0.1.2          (aliases: openai)
gemini-cli    ✗  not found            (aliases: gemini)
aider         ✓  aider 0.82.0         (custom)
```

Discovery runs `which <command>` and optionally `<command> --version`.
This is not a health check — it is a startup inventory.

#### Runtime Selection Cascade

The resolution order does not change. It gains a new source:

1. `--runtime` CLI flag (override)
2. `runtime:` in the assignment message body
3. `via <runtime>` in the plan agent descriptor
4. `via <runtime>` in the team agent descriptor
5. `runtime:` in the project config
6. `runtime:` in `~/.hive/config.md`

The steward can now write `runtime: gemini` in an assignment message,
and the supervisor will honor it. The RuntimeName type becomes a string
validated against the registry instead of a union of literals.

### The Gateway Server

#### HTTP Server

Bun's built-in `Bun.serve()`. No framework.

```typescript
Bun.serve({
  port: 4200,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) return handleApi(req, url);
    if (url.pathname === "/ws") return handleWebSocket(req);
    return serveStatic(url.pathname);
  },
  websocket: { ... },
});
```

Port 4200 by default, configurable via `--port` or `gateway-port:` in
`~/.hive/config.md`.

#### REST API

The API maps directly to existing hive commands. It is not a new
abstraction layer — it is HTTP dispatch to the same functions the CLI
calls.

```
GET  /api/status                → hive status (board + open msgs)
GET  /api/feed?count=20         → hive feed 20
GET  /api/ps                    → hive ps
GET  /api/projects              → list registered projects
GET  /api/project/:id           → project config + state summary
POST /api/project/:id/work      → hive work <id>
GET  /api/inbox/:agent          → hive inbox <agent>
GET  /api/runtimes              → hive runtimes (registry + detection)

POST /api/say                   → hive say <message>
POST /api/nudge                 → hive nudge <message>
POST /api/msg                   → hive msg <from> <to> <body>
POST /api/log                   → hive log <message>

POST /api/run                   → hive run (start supervision)
POST /api/stop/:target          → hive stop <agent|run>
GET  /api/supervise/status      → hive supervise status

POST /api/console/send          → send a message in the active console session
GET  /api/console/history       → current console session conversation history
POST /api/console/new           → start a new console session
GET  /api/sessions              → list all sessions
GET  /api/sessions/:id          → session details and history
```

Every API endpoint returns JSON. Every mutating endpoint returns a
result object with a `status` field and an optional `message` field.
Error responses use standard HTTP status codes with a JSON body.

#### WebSocket Feed

The WebSocket endpoint at `/ws` streams real-time events to connected
clients. Events are:

- **feed**: new feed entry appended (the Gateway watches `feed.md`)
- **run-started**: a new agent run began
- **run-completed**: an agent run finished (with exit code)
- **supervisor-tick**: supervisor pass completed
- **session-message**: new message in the active console session
- **state-changed**: board, plan, or message state changed

The Gateway uses `Bun.file().watch()` or polling on short intervals to
detect file changes and push events over the WebSocket. This is the same
mechanism `hive watch` uses, lifted from terminal tailing to WebSocket
streaming.

Event format:

```json
{
  "type": "feed",
  "ts": "2026-03-10T14:11:05Z",
  "project": "dealsplit",
  "data": {
    "headline": "alpha: Task 001 complete",
    "details": ["4 tests passing", "API contract posted"]
  }
}
```

#### Static File Serving

The Gateway serves the web UI from `src/gateway/static/` (or a
compiled-in asset directory in the binary build). Bun's file serving
handles MIME types, caching headers, and 404s.

```
src/gateway/
  static/
    index.html
    style.css
    app.js
    icons/
```

No build step. No bundler. The browser loads `index.html`, which
includes `style.css` and `app.js` via script and link tags.

### Web UI

#### Layout

The web UI follows the three-pane layout from `interaction.md`, adapted
for the browser:

```
┌──────────────────────────────────────────────────────────┐
│  HIVE  │  dealsplit ▾  │  ● supervisor running  │  3 agents  │
├────────────────────────────┬─────────────────────────────┤
│                            │                             │
│   Console                  │   Feed                      │
│                            │                             │
│   you: how's auth going?   │   [14:52] ✅ alpha: 001     │
│   HIVE: Alpha finished...  │   [14:53] 📋 002 → beta    │
│                            │   [15:10] 💬 alpha → beta   │
│   you: _                   │   [15:45] ✅ beta: 002      │
│                            │                             │
│   [input box]              │   (auto-scrolls)            │
│                            │                             │
└────────────────────────────┴─────────────────────────────┘
```

**Top bar:**
- HIVE logo/wordmark
- Project selector dropdown (switch active project without CLI)
- Supervisor status indicator (running/stopped/error)
- Agent count and summary (active/idle/blocked)
- Runtime inventory (which runtimes are available)

**Left panel — Console:**
- Persistent chat with the hive
- Conversation history loads from disk on page load
- Input box at the bottom, sends via `/api/console/send`
- New messages arrive via WebSocket
- Session controls: new session, session history, archive

**Right panel — Feed:**
- Live feed of events, auto-scrolling
- Loads recent entries on page load via `/api/feed`
- New entries arrive via WebSocket
- Filterable by agent, event type, or time range
- Expandable entries for detail

The console is the primary interface. The feed is glanceable context.
This matches the design in `interaction.md`: "The console is the
steering wheel. The feed is the dashboard."

#### Interaction Model

The web console does not open a raw LLM session in the browser. It
sends the human's message to the Gateway, which manages the LLM
interaction server-side.

Flow:

1. Human types a message in the browser
2. Browser POSTs to `/api/console/send`
3. Gateway appends the human turn to the session history file
4. Gateway assembles a prompt from: system prompt + session history +
   current hive state
5. Gateway launches a one-shot LLM call (using the configured console
   runtime)
6. LLM response streams back to the Gateway
7. Gateway appends the assistant turn to the session history file
8. Gateway pushes the response to the browser via WebSocket
9. Browser renders the new turn

This is explicitly a server-managed session, not a browser-to-LLM
connection. The Gateway owns the conversation state, the prompt
assembly, and the runtime invocation. The browser is a display layer.

The one-shot-per-turn model means the console runtime does not need to
maintain a persistent process. Each turn is a fresh invocation with the
full conversation history in the prompt. This is consistent with HIVE's
stateless-process architecture — crash tolerance comes from disk state,
not from keeping a process alive.

For long conversations, the Gateway should detect when the session
history approaches the context window limit and offer to summarize and
start a fresh session. The summary becomes the opening context for the
new session.

### Session Management

#### Session Directory Structure

```
~/.hive/sessions/
  active.md                          # pointer to current session
  {session-id}/
    meta.md                          # session metadata
    history.md                       # conversation turns
    prompt.md                        # system prompt snapshot
```

#### `sessions/active.md`

```markdown
---
session: 20260310-141105Z
project: dealsplit
runtime: claude
started: 2026-03-10T14:11:05Z
---
```

#### `sessions/{id}/meta.md`

```markdown
---
session: 20260310-141105Z
project: dealsplit
runtime: claude
model: claude-sonnet-4
started: 2026-03-10T14:11:05Z
turns: 14
last-active: 2026-03-10T15:42:00Z
status: active
---
```

#### `sessions/{id}/history.md`

```markdown
# Session 20260310-141105Z

## human (14:11:05)
how's auth going?

## assistant (14:11:12)
Alpha finished the endpoint at 14:52 with Joken for JWT. Beta is
building the login form now, about 70% done based on the files
touched. Gamma is waiting to review. No blockers.

## human (14:15:30)
the token should expire in 1 hour, not 24

## assistant (14:15:38)
Got it. Sending correction to alpha. This will need a code change +
test update. Want me to have alpha fix it now or let beta finish first?
```

Conversation history is markdown with clear turn delimiters. This makes
it readable by humans, parseable by HIVE, and injectable into LLM
prompts without transformation.

#### Session Lifecycle

- **Create:** `POST /api/console/new` or `hive console --new` creates a
  fresh session directory, snapshots the current system prompt, and
  writes the active pointer.
- **Resume:** Opening the web console loads the active session. The
  conversation history is sent to the browser and new turns append to
  the same file.
- **Archive:** When the human is done or the session is too long, HIVE
  archives it to `~/.hive/archive/sessions/` and starts fresh.
- **List:** `GET /api/sessions` returns all sessions with metadata.

### Gateway Process Management

#### Starting The Gateway

```bash
hive gateway [--port 4200] [--open]
```

`hive gateway` starts the HTTP server and prints the URL. With `--open`,
it also opens the URL in the default browser. The Gateway runs in the
foreground by default. It can be backgrounded by the user's shell or
run under a process manager.

The Gateway writes a state file at `~/.hive/gateway.md`:

```markdown
---
status: active
pid: 91234
port: 4200
started: 2026-03-10T14:11:05Z
url: http://localhost:4200
---
```

Other hive commands can read this file to know whether the Gateway is
running and on which port. `hive gateway status` reads and displays it.

#### Stopping The Gateway

`hive gateway stop` reads the pid from `gateway.md` and sends SIGTERM.
The Gateway handles SIGTERM by:

1. Closing the HTTP server (stop accepting new connections)
2. Closing all WebSocket connections
3. Updating `gateway.md` to `status: stopped`
4. Exiting cleanly

Active agent runs are not affected. The supervisor (if running in the
same process) can be configured to continue running independently or
to stop with the Gateway.

### Runtime Capabilities In The Steward Prompt

The steward prompt gains a new section listing available runtimes and
their characteristics:

```markdown
## Available Runtimes
- claude-code: Claude models via Claude Code CLI. Good for code generation,
  analysis, and complex reasoning. Supports: claude-sonnet-4, claude-opus-4.
- codex: OpenAI models via Codex CLI. Good for code generation and refactoring.
  Supports: gpt-5-codex, o3.
- gemini-cli: Google models via Gemini CLI. Large context window. Good for
  research, analysis, and code review. Supports: gemini-2.5-pro.

When assigning work, you may specify `runtime:` in the assignment message
to direct the supervisor to use a specific runtime. If omitted, the
agent's configured default runtime is used.
```

This gives the steward enough information to make runtime decisions
without turning it into a model benchmarking engine. The steward is
still the thinker. It now has one more dimension to think about.

## What The CLI Gains

```bash
hive gateway [--port 4200] [--open]     # Start the Gateway server
hive gateway status                      # Show Gateway state
hive gateway stop                        # Stop the Gateway server
hive runtimes                            # List installed runtimes
```

`hive console` continues to work as a terminal-based interactive session.
The Gateway's web console is an additional surface, not a replacement.

`hive run` and `hive say` continue to work independently of the Gateway.
The Gateway is the browser surface. The CLI is the terminal surface.
Both operate on the same files.

## Architecture

```
                    ┌─────────────┐
                    │   Browser   │
                    │  (Web UI)   │
                    └──────┬──────┘
                           │ HTTP + WebSocket
                           │
                    ┌──────┴──────┐
                    │   Gateway   │
                    │  HTTP Server│
                    │  port 4200  │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴─────┐ ┌───┴───┐ ┌──────┴──────┐
        │  REST API  │ │  WS   │ │   Static    │
        │  handlers  │ │ feed  │ │   files     │
        └─────┬─────┘ └───┬───┘ └─────────────┘
              │            │
              │     ┌──────┴──────┐
              │     │ File Watcher│
              │     │ (feed, msg, │
              │     │  board, ps) │
              │     └──────┬──────┘
              │            │
        ┌─────┴────────────┴─────┐
        │   Existing HIVE Core   │
        │                        │
        │  commands/ + lib/      │
        │  ┌──────────────────┐  │
        │  │ Runtime Registry │  │
        │  │  ┌─────────┐    │  │
        │  │  │ claude  │    │  │
        │  │  │ codex   │    │  │
        │  │  │ gemini  │    │  │
        │  │  │ custom  │    │  │
        │  │  └─────────┘    │  │
        │  └──────────────────┘  │
        └────────────┬───────────┘
                     │
        ┌────────────┴───────────┐
        │    ~/.hive/ (files)    │
        │                        │
        │  SOUL.md  BOARD.md     │
        │  PLAN.md  feed.md      │
        │  msg/     runs/        │
        │  sessions/             │
        │  config.md             │
        └────────────────────────┘
```

Key architectural properties:

- The Gateway does not bypass the command layer. REST handlers call
  the same exported functions that the CLI calls.
- The WebSocket feed is driven by file watching, not by intercepting
  internal function calls. This means it works even when agent runs
  are modifying files independently of the Gateway.
- The runtime registry is a shared module used by both the CLI and
  the Gateway. There is no Gateway-specific runtime path.
- Session state lives in `~/.hive/sessions/`, which is a new top-level
  directory alongside `projects/`, `memory/`, and `archive/`.

## Validation Strategy

### Multi-Runtime Adapters

- Unit tests for each built-in adapter: given a prompt, model, and
  paths, assert the correct command-line arguments are produced
- Detection tests: mock `which` to verify installed/not-installed
  reporting
- Custom adapter parsing tests: given a config block, assert the adapter
  is constructed correctly with the right template substitutions
- Integration test: launch a trivial prompt against each installed
  runtime and verify exit code 0 (gated on runtime availability)

### Gateway Server

- HTTP handler tests: for each REST endpoint, send a request and assert
  the response shape matches the expected JSON schema
- WebSocket tests: connect, append to feed.md manually, assert the
  client receives a feed event
- Static file serving tests: request known paths, assert correct MIME
  types and 200 status
- Port conflict test: start two Gateways, assert the second fails
  cleanly with a port-in-use error

### Console Sessions

- Session creation: POST to `/api/console/new`, assert session directory
  and files are created
- Session resume: create a session with history, POST a new message,
  assert it appends correctly
- Session listing: create multiple sessions, GET `/api/sessions`, assert
  all appear with correct metadata
- History format: create a multi-turn session, read `history.md`, assert
  the markdown structure is parseable

### Web UI

- The web UI is the hardest to test automatically. Validation should
  focus on:
  - Manual smoke testing against a live Gateway
  - Console round-trip: type a message, see it appear, see the response
  - Feed streaming: trigger a feed event, see it appear in the UI
  - Project switching: select a different project, see the state update
- Automated testing of the UI JavaScript is low priority. The logic
  lives in the Gateway, not the browser.

### End-to-End

- Start a Gateway, create a project, send a console message, verify
  the session file exists with the conversation
- Start a Gateway with supervision, verify the web UI shows supervisor
  status and active runs
- Switch projects via the API, verify the console switches context

## Roadmap Consequence

The roadmap should update:

1. Phase 1: Core primitives
2. Phase 2: Orchestrator prompt and state loop
3. Phase 3: Human interaction slice and one-shot runtime launch
4. Phase 4: Autonomous launch and supervision
5. **Phase 5: The Gateway — multi-runtime, persistent console, web UI**
6. Phase 6: Memory intelligence and curation automation
7. Phase 7: Integration, polish, and transport adapters

Phase 5 absorbs what was previously called "Rich Human Modes" and
"Transport Adapters" from Phase 5 in the old roadmap. Notifications
and external transports (Slack, Discord, iMessage) remain deferred to
Phase 7. The Gateway is the local transport — it replaces terminal
panes with browser panes. External transports are a separate concern
that can layer on top of the Gateway's WebSocket protocol.

Memory intelligence (Phase 6) is independent of the Gateway and can
proceed in parallel. The Gateway does not need curation to be useful.
Curation does not need the Gateway to work.

## Implementation Sequence

Build Phase 5 in six narrow steps. Each step produces a testable,
dogfoodable increment.

### Step 1: Multi-Runtime Adapter Registry

Replace the hardcoded `RuntimeName` union and switch statements in
`runtime.ts` with a registry-based dispatch.

- Define the `RuntimeAdapter` interface
- Implement built-in adapters for Claude Code, Codex, and Gemini CLI
- Parse custom adapter declarations from `~/.hive/config.md`
- Implement `hive runtimes` to list installed runtimes
- Update `resolveRuntimeHints` to validate against the registry
- Update `buildLaunchSpec` and `buildInteractiveLaunchSpec` to
  delegate to the adapter
- Update `normalizeRuntimeName` to check the registry instead of a
  hardcoded switch
- All existing tests must continue to pass with no behavior change

**Dogfood point:** `hive launch alpha --runtime gemini` works if
Gemini CLI is installed. `hive runtimes` shows what is available.

### Step 2: Gateway HTTP Server With REST API

Stand up the Gateway server with REST endpoints mapped to existing
hive commands.

- Implement `src/gateway/server.ts` with `Bun.serve()`
- Implement REST handlers that call existing command functions
- Implement `hive gateway`, `hive gateway status`, `hive gateway stop`
- Write `gateway.md` state file for process management
- Handle SIGTERM/SIGINT for clean shutdown
- Implement JSON error responses with appropriate HTTP status codes

**Dogfood point:** `curl localhost:4200/api/status` returns the same
information as `hive status`.

### Step 3: WebSocket Feed Streaming

Add real-time event streaming over WebSocket.

- Implement WebSocket upgrade handling in the Gateway server
- Implement file watchers for `feed.md`, `msg/`, `BOARD.md`, and
  `runs/active/`
- Define the event format and event types
- Push events to all connected WebSocket clients
- Handle client connect/disconnect cleanly
- Implement heartbeat/ping to detect stale connections

**Dogfood point:** Open a WebSocket connection in a browser console,
run `hive say "check in"`, see events arrive.

### Step 4: Web UI Shell

Serve a static web interface from the Gateway.

- Create `src/gateway/static/index.html` with the three-pane layout
- Create `style.css` with the layout, typography, and color scheme
- Create `app.js` with:
  - REST client for loading initial state
  - WebSocket client for real-time updates
  - Feed panel rendering with auto-scroll
  - Project selector with API-driven switching
  - Supervisor status indicator
- Implement static file serving in the Gateway

**Dogfood point:** Open `localhost:4200` in a browser, see the feed
updating in real time, switch projects, see supervisor status.

### Step 5: Console Session Persistence

Add file-backed console sessions that survive across restarts.

- Create `~/.hive/sessions/` directory structure
- Implement session creation, resume, and listing
- Implement conversation history read/write in markdown format
- Implement the server-side console turn flow:
  prompt assembly from session history + hive state, one-shot LLM call,
  response append to history
- Add REST endpoints: `/api/console/send`, `/api/console/history`,
  `/api/console/new`, `/api/sessions`
- Stream the LLM response to the browser via WebSocket as it arrives

**Dogfood point:** `POST /api/console/send` with a message, get a
response, reload the page, see the conversation history.

### Step 6: Full Web Console With Real-Time Agent Visibility

Complete the web UI with the interactive console and agent overview.

- Add the console input/output panel to the web UI
- Add conversation history rendering with turn styling
- Add session controls (new session, switch session, archive)
- Add agent overview in the top bar (active runs, status, runtime)
- Add run details view (click an agent to see its current run state)
- Add keyboard shortcuts (Enter to send, Ctrl+N for new session)
- Polish: loading states, error handling, responsive layout

**Dogfood point:** Open `localhost:4200`, have a conversation with the
hive, see agent runs updating in real time, switch projects, start
supervision — all from the browser.

## What This Does Not Include

- **External transports** (Slack, Discord, iMessage). These layer on top
  of the Gateway's WebSocket protocol and belong in Phase 7.
- **Desktop notifications.** The Gateway can add these later via the
  Notification API in the browser, but they are not required for Phase 5.
- **Authentication.** The Gateway is localhost-only. Auth is not needed
  until the Gateway is exposed on a network, which is not a Phase 5
  concern.
- **Multi-user support.** HIVE is a single-user tool. The Gateway serves
  one human.
- **Mobile UI.** The web UI should be responsive enough to be usable on
  a tablet, but mobile optimization is not a goal.
- **Streaming token output.** The console shows complete turns, not
  streaming tokens. Streaming can be added later if the runtime adapters
  support it, but it is not required for the console to be useful.

## Why This Is Still HIVE

The Gateway does not turn HIVE into a web application.

- The files still hold the state. The Gateway reads and writes the same
  markdown files everything else uses.
- The CLI still works. The Gateway is an additional surface, not the
  only one.
- The supervisor still does the launching. The Gateway shows what is
  happening, it does not replace the control loop.
- Every session can be reconstructed from disk artifacts. Killing the
  Gateway loses nothing.
- The architecture is still local-first, file-native, and
  zero-dependency.

The Gateway is the hive's front door for the human. It does not change
what is behind the door.
