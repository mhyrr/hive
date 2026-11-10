# HIVE v2 — Design

**Status:** Draft 4, for review. Nothing here is built.
**Date:** 2026-11-07

## 1. What v2 is

v1 was built to stretch scarce tokens and ended up too restrictive and too
deterministic. Tokens are no longer scarce; Greg's attention is. v2 is a
solo-developer tool on Greg's laptop that turns HIVE into a small supervision
tree of agents, with everything that needs Greg in one queue.

The purpose: Greg gets an idea across, and agents run the whole loop from
there: think, research, design, implement, test. Greg manages, nudges and sets
direction instead of writing a design doc and iterating by hand each time.

The approach: start loose, lean on the harnesses and the models, see what
breaks, and add structure only then.

## 2. Principles

1. **Trust the model and the harness.** When something is uncertain, the
   answer is the supervision tree, not a rule.
2. **Harnesses do the work; HIVE keeps track.** HIVE owns the tree, the agent
   workspaces, the queue, and precedents. Sessions, sub-agents, worktrees,
   browsers, screenshots, hooks and skills belong to the harnesses. HIVE calls
   them; it does not copy them.
3. **Every agent thinks.** Plumbing only stores and routes.
4. **Ideas branch.** A good idea never stops work; it becomes a sibling agent
   on its own branch.

## 3. The tree

There is one concept: an **agent**. Every agent is a long-lived harness
session with its own workspace, a charter, and a parent. Agents differ only in
what their charter says they are for. The tree is simply who started whom.

```
Greg
 └─ Maya, chief of staff          (charter: look across everything)
     ├─ revrec                    (charter: the revrec project)
     │   ├─ rate-limiter          (charter: build TK-142, own worktree)
     │   └─ reviewer              (charter: review rate-limiter's branch, on Codex)
     ├─ matreas                   (charter: the matreas project)
     │   └─ ...
     └─ release-notes             (started by the chief of staff directly, on Pi)
```

- **The chief of staff is Maya**, the agent at the top. (This brings back the
  Maya name from v1, whose Maya agents were retired.) She thinks across everything:
  conflicts, duplicated work, shared blockers, priorities. She can start
  agents under herself directly, not only through project agents.
- **Project agents.** The agents directly under the chief of staff are
  usually one per HIVE project. They start with that project's context
  (project memory, tickets, conventions), so a project agent is effectively
  the project, given a session.
- **Any agent can start child agents** for a piece of work. A child is not
  short-lived by default: it stays as long as it is useful, can be messaged
  later ("also fix the docs"), and can start its own children.
- **An agent ends** when its parent decides it is done, or when it reports it
  is finished and the parent agrees.
- **Harness sub-agents** (e.g. Claude's) sit inside an agent's session and are
  invisible to HIVE. The agent that used them answers for them.
- Agents are real harness sessions (for Claude: background sessions, visible
  in agent view), not `claude -p` calls. Print mode is only for nightly and
  launchd jobs.
- Any harness can host any agent. Claude Code is the default.

| | Claude sub-agent | HIVE agent |
|---|---|---|
| Lives in | Its parent's session | Its own session, in any harness |
| Lifetime | Usually one task | As long as useful; can be messaged later |
| Memory | The parent's context | Its own workspace |
| Managed by | The harness | Its parent agent, through HIVE |

## 4. Agent workspaces

```
~/.hv/
  agents/<name>/          maya, revrec, rate-limiter, ...
    charter.md            what this agent is for, in prose (Greg-editable)
    checklist.md          what to look at each time it wakes (Greg-editable)
    log.md                what it did and why, appended
    reports/              one file per finished piece of work
    memory/               its own notes
    session.json          harness, session ID, parent, worktree, how to resume
  queue/<item-id>/
    item.md               the ask, the chain of recommendations, status
    evidence/             *.png, *.txt
  precedents/             Greg's answers, one file each
```

- Each agent writes only its own folder; queue items are written by whoever
  creates them and answered by Greg.
- The charter is the scope. There is no mandate or permission format; the
  agent reads its charter and judges what fits.
- If an agent's session is gone, a new session starts from its workspace.

## 5. How agents run and talk

**Harness adapter.** One thin adapter per harness (Claude Code, Codex, Cursor
CLI, Pi) that can: start a session with a charter (in a worktree if needed),
send a message into a running or resumable session, and read back its status.
It discovers what the installed harness supports (help output, version)
instead of hard-coding flags. Each workaround for a missing harness feature
notes when to delete it. `hive doctor` smoke-tests each installed harness
(start, message, resume).

**Talking.** Agents use HIVE's MCP server, which every harness already loads.
The minimum tool set:

- `agent_start(harness, charter, repo?)` — start a child agent. If it will
  edit code, it gets its own worktree and branch; an agent that only thinks
  or reviews does not need one.
- `message(to, text)` — send a message to an agent by name. A child uses it
  to tell its parent it finished, is stuck, has a question, or has an idea.
  Greg (or any session he has open) uses it to reach Maya: `to: "maya"`.
- `queue_add(item)` — put something in front of Greg, with evidence.
- `precedents_search(query)` — see how Greg decided similar things.

Delivery uses the harness's own mechanism where one exists (Claude
cross-session messaging, channels); otherwise HIVE resumes the target session
with the message as the next prompt.

**Waking.** An agent wakes when it gets a message: a child reports, its
parent or Greg sends something, Greg answers a queue item, or a launchd timer
nudges it to walk its checklist. That is all for now.

**Greg talks to Maya from anywhere.** Greg's sessions are ordinary sessions
outside the tree. From any of them he reaches Maya with `message(to: "maya",
...)`, or opens her directly with `hv maya`. Maya reaches the project agents
with `message`. There is no attach mode and no hand-off of supervision.

## 6. Supervision

Agents are trusted to understand their scope. When a child reports, its
parent thinks about it and does whatever makes sense: let it continue,
redirect it, answer its question, retry on another harness or model, have
another agent verify the work, start an exploration, stop it, or escalate.
There is no fixed menu and no rules engine.

**When unsure, go up.** An agent that is not sure decides, gets a second
opinion from another agent or model, or escalates to its parent. Each level
adds its own read and recommendation before passing it on, so Greg sees a
stack ("revrec recommends A; chief of staff agrees but A collides with
matreas's migration, do it after") rather than a raw question.

**Precedents.** Greg's answers are saved to `precedents/` with his reason.
Agents search them before escalating. Over time, decisions move down the
tree because agents can see how Greg decided last time.

**Exploration is a branch.** An agent with an idea reports it and keeps
going. Its parent can start a sibling agent on its own branch to chase it.
The result comes back as a proposal.

## 7. Safety

- `TRUST.md` as-is: internal actions, act freely; external actions (push,
  deploy, send, post, spend), ask Greg through the queue; hard limits, never.
- Every agent that edits code works on its own worktree and branch. Agents
  never merge.
- Inside that, rely on the harness's own safety (Claude's auto-mode
  classifiers, each harness's sandbox and approvals). HIVE adds no extra
  machinery.

## 8. The queue

One queue, an evolution of the dashboard, on its own port while v1 runs.
Items are folders under `~/.hv/queue/`.

- **Kinds:** review (a branch ready to look at), decision (a question the tree
  could not settle), proposal, blocker (needs a credential, fact or access).
- **Each item has:** which agent raised it, each level's recommendation on the
  way up, evidence (screenshots and text, captured with the harness's own
  tools), and one-key actions: approve, reject, redirect, each with an
  optional reason.
- **The chief of staff** ranks the queue, merges duplicates, groups related
  items, and settles what it can. It should be able to say why an item is
  first.

When Greg answers, the answer goes to the agent that raised the item as a
message and, with his reason, into `precedents/`.

### The dashboard

The `hv` home page is where Greg sees what is going on when he is not
messaging. This is a first version, to iterate on. From the top:

1. **Waiting on you.** The queue, ranked by Maya, with why the first item is
   first. Opening an item shows one item at a time, evidence large, keyboard
   driven.
2. **Now.** One line per agent in tree order, from `session.json` and the last
   log line. It refreshes every few seconds. An agent that exited or stopped
   responding is painted here.
3. **Reports.** Finished work, newest first. An agent writes a file to its
   `reports/` folder when it finishes a piece of work, and the dashboard shows
   that report as written.
4. **The existing bands,** read from `~/.hive`: yard, briefing, commits,
   tickets.

It reuses the current collectors, renderer, action handlers and `DESIGN.md`.
No network, no voice.

## 9. Proposals: small bets

v1 Propose picked one ticket a night. In v2 any agent can propose anything:
new work, a refactor, killing a ticket, changing its own charter. A proposal
comes with a cheap spike already done (a draft branch, a screenshot, a short
proof), so approving means "keep going." A rejection with a reason is a
precedent like any other.

## 10. Storage

Markdown files under `~/.hv/`.
Queue status lives in `item.md` frontmatter; session info in
`session.json`. The minimum version needs no database. Add one when file
contention or queue queries actually hurt.

## 11. What goes away

Watches (Observe / Propose / Act), the watch spec format, campaign dispatch,
the decompose loop, `next.json` / `hive next`, and the deterministic
eligibility gates are deleted, not migrated. Kept as agent behavior: own
branch and worktree for code changes, never merge, end in a reviewable state.
The nightly memory pipeline, identity, taste and council stay; project memory
becomes the starting context for each project agent.

## 12. Known compatibility risk

Claude plans to make `--bare` the default for `-p`. `--bare` is API-key
only and skips OAuth. HIVE's nightly and launchd jobs use `claude -p` with
subscription OAuth, so they would break. `hive doctor` checks what `-p`
does on the installed version, and the adapter opts out of bare mode if a
flag allows it (unverified). If OAuth fails, the job fails visibly; no
API-key fallback (per `CLAUDE.md`).

## 13. Jev (optional, separate)

Jev (`docs/jev-decision-loop.md`) is cheap enough to run at every stopping
point as a second opinion on "what should the parent do now." Its context is
32k (per OpenRouter), so it gets the facts and the recent tail, not the whole
transcript. Nothing in the core depends on it.

## 14. Deferred — revisit when it breaks

- Noticing a child agent that loops or goes silent (lightest fix: a line in
  each parent's checklist).
- Time or spend budgets per agent.
- Capacity limits and rate-limit-aware routing.
- Missed wakes while the laptop sleeps; wakes from git or CI events.
- Cloud sessions as overflow.
- Phone access to the queue (breaks the localhost-only model).
- A database (SQLite) for queue state or an event log.
- Claims so two agents don't take the same work.
- A fixed layout for evidence and results.
- Precedent supersession or decay.
- Spot-checking decisions made without escalation.
- Shadow-mode prediction of Greg's answers and metrics (corrections per change).
- Normalized read-only / safe / full-auto modes across harnesses.
- Agents whose charter spans several projects or has no repo.

## 15. Decisions (2026-11-08)

- **D1. Maya (the chief of staff) is a background Claude Code session on the
  subscription.** Not `claude -p`, not API credits. Greg can resume her from
  HIVE (e.g. `hv maya`), or message her from whatever Claude Code session
  he has open with the HIVE MCP tool `message(to: "maya", ...)`. To verify
  when building: background sessions authenticate with the subscription like
  any interactive session.
- **D2. Non-Claude harnesses are spawned like a sub-agent.** An agent hosted
  on Codex, Cursor or Pi is started by running its HIVE wrapper (`hive -x`,
  `hive -a`, `hive -3`) with the starting context and prompt injected, the
  same way a sub-agent is handed "here's your context and task, go." The
  agent's workspace is what lasts; each invocation is one turn. A follow-up
  message resumes the session where the harness supports it, or starts a
  new invocation from the workspace where it does not. This is the whole
  adapter for those harnesses.
- **D3. Recovery is a fresh session from the workspace.** Greg will clear
  Maya's context like any other session, so every agent keeps
  what matters in its workspace (`log.md`, `memory/`) rather than in its
  context.
- **D4. Delete watches and campaign first**, then build v2.
- **D5. Project agents come from an explicit list.** v2 starts with six:
  matreas, revrec, arete, writing, investing and hive. The registry has 19
  projects; the others get an agent only when Greg adds them.
- **D6. Messages go through one HIVE MCP tool, `message(to, text)`**,
  addressed by agent name. Messages for the chief of staff are addressed to
  Maya.

- **D7. Supervision works like an Erlang supervision tree.** A parent
  supervises the children it started and learns when one exits or hangs. A
  child that dies without reporting is a signal to its parent, not silence.
  This is part of the minimum build and replaces the first item in §14.
- **D8. Incoming messages ride the harness.** What happens when a message
  reaches a busy session (queue, interrupt) is whatever that harness does.
  HIVE adds no delivery semantics of its own.
- **D9. There is no driving mode.** Greg's sessions stay outside the tree
  and talk to Maya. Children stay under the agent that started them. See §5.
- **D10. v2 is built on the long-running branch `hive-v2` and runs beside
  v1.** It installs as `hv` and `hv-mcp`. The installed `hive` binary, its
  launchd jobs and the dashboard stay on v1 until cutover. The branch lives
  in its own worktree at `~/work/hive-v2`, and `~/work/hive` stays on `main`:
  Claude Code and Codex start the `hive` MCP server from
  `~/work/hive/src/mcp-server.ts`, and `~/.local/bin/hive-mcp` links to the
  tracked `hive-mcp` binary in that checkout.
- **D11. v2 uses `~/.hive` the way v1 does; everything new lives in `~/.hv`.**
  Identity, memory, tickets, taste and the MCP tools are shared and live.
  Anything new, different or extra (`agents/`, `queue/`, `precedents/`, v2
  config) goes in `~/.hv`. v2 must not change how v1 reads or writes
  `~/.hive`.
- **D12. Subscription-only auth moves to the v2 spawn path.** Watch Act's
  executor is deleted with watches, and it was the code that unset
  `ANTHROPIC_API_KEY`. Every detached v2 start must do the same.

## 16. Build order

Binary name: `hv`. Shared state: `~/.hive`. New state: `~/.hv` (D11).

1. **Delete watches and the Act executor.** (D4)
2. **Run side by side.** Install `hv`, with its own dashboard port. Add a
   `~/.hv` path for v2-only state. `hv init` must not touch v1's hooks, MCP
   entry, templates or launchd jobs. Build artifacts use `hv` names, never
   `hive-bin` or `hive-mcp`.
3. **Spike the Claude adapter.** Start a background session with a charter,
   send it a message, resume it, confirm subscription auth (D1, D12), and
   find out how a parent can detect that a session exited. Every later slice
   depends on these answers.
4. **Agent workspaces and tools.** `agents/<name>/`, `agent_start`,
   `message`. These tools ship in `hv-mcp`, a server holding only the new
   tools and registered beside `hive`.
5. **Read-only Now view.** The dashboard's Now section, so agents are visible
   while they are tested.
6. **Supervision.** Exit and hang detection reaches the parent; restart from
   the workspace (D3, D7).
7. **Maya and the six project agents.** `hv maya`, and `message` from any
   session (D5, D9).
8. **Queue and precedents.** `queue_add`, `precedents_search`, the dashboard's
   Waiting and Reports sections.
9. **Other harnesses.** Codex, Cursor, Pi (D2).
10. **Cutover.** Stop the `com.hive.watches` job. Delete what v1 still needs
   while both run: the `act_run` ticket fields, `hive next`, the dashboard's
   Propose and Act-work surfaces, and the decompose loop. Decide whether `hv`
   keeps its name.

### Spike results (2026-11-09, Claude Code 2.1.319)

Tested with real background sessions.

| Question | Result |
|---|---|
| Start | `claude --bg -n <name> "<prompt>"` works and returns at once |
| Auth | Subscription (D1 holds): `claude auth status` reports `claude.ai`, no API key in the environment |
| Identity | Loads through the SessionStart hook, but only as a preview: the 18 KB output is saved to a file the agent has to read |
| Inherited guard | A session started from a `hive` session inherits `HIVE_IDENTITY_IN_PROMPT=1`, so the hook skips and identity is missing |
| Message a live session | `SendMessage` to the session name delivers; the session read it and replied |
| `--resume` on a live session | Starts a copy. Never use it for delivery |
| Resume a dead session | `claude --bg --resume <id>` wakes the same session with its history |
| Status | `claude agents --json` lists active sessions with `pid` and `status` |
| Killed session | Leaves the active list within 8 seconds. `--all` shows it with no `pid` and the same `state: done` as a clean finish |

What this means for the build:

- `hv` injects identity with `--append-system-prompt` and sets
  `HIVE_IDENTITY_IN_PROMPT`, as `hive` does. Whether that flag combines with
  `--bg` is untested, as is `-w` with `--bg`.
- A session that left the active list without writing a report died. The
  harness cannot tell a crash from a clean exit, so the report file does.
- `SendMessage` with `notify_when_idle` is a candidate for the monitor. The
  idle notice is verified: it arrived with the session's last reply, a few
  minutes late. A killed session sends no notice: the subscription just
  expires after 12 hours with no signal. Death detection therefore polls
  `claude agents --json` and checks for the report file. Cross-session
  messages are held for approval when the two sessions run in different
  permission modes.

## 17. Sources

Brian Armstrong's post (leads, chief of staff, one queue); Grok Bot
architecture write-up (https://gist.github.com/wtfsayo/b80f74f4f64d18ced8c84502a23148fe);
`AgwaB/grok-bot-agents`; OpenClaw workspace files; `docs/jev-decision-loop.md`,
`docs/dashboard.md`, `templates/TRUST.md`, `PRODUCT.md`.
