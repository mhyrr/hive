# HIVE v2 — Design

**Status:** Draft 5, for review. Nothing here is built.
**Date:** 2026-11-07 (revised 2026-11-11)

## 1. What v2 is

v1 was built to stretch scarce tokens and ended up too restrictive and too
deterministic. Tokens are no longer scarce; Greg's attention is. v2 is a
solo-developer tool on Greg's laptop that turns HIVE into a small supervision
tree of agents, with everything that needs Greg in one queue.

The approach: start loose, lean on Claude Code and the model, see what
breaks, and add structure only then.

## 2. Principles

1. **Trust the model and the harness.** When something is uncertain, the
   answer is the supervision tree, not a rule.
2. **Claude Code does the work; HIVE keeps track.** HIVE owns the tree, the
   agent workspaces, the queue, precedents, and the shared project context
   (memory, tickets). Sessions, sub-agents, worktrees, browsers, screenshots,
   hooks and skills belong to Claude Code. HIVE calls them; it does not copy
   them.
3. **Every agent thinks.** Plumbing only stores and routes.
4. **Ideas branch.** A good idea never stops work; it becomes a sibling agent
   on its own branch.

## 3. The tree

There is one concept: an **agent**. Every agent is a long-lived Claude Code
session, started through the `claude` CLI, with its own workspace, a charter,
and a parent. That holds whether Greg starts it or HIVE does. Agents differ
only in their charter and skills. The tree is simply who started whom.

```
Greg
 └─ Maya, chief of staff          (charter: look across everything)
     ├─ revrec                    (charter: the revrec project)
     │   ├─ rate-limiter          (charter: build TK-142, own worktree)
     │   └─ reviewer              (charter: review rate-limiter's branch)
     ├─ matreas                   (charter: the matreas project)
     │   └─ ...
     └─ release-notes             (started by Maya directly)
```

- **The chief of staff is Maya**, the agent at the top. (This brings back the
  Maya name from v1, whose Maya agents were retired.) She thinks across
  everything: conflicts, duplicated work, shared blockers, priorities. She can
  start agents under herself directly, not only through project agents.
- **Project agents.** The agents directly under Maya are one per registered
  HIVE project. They start with that project's context (project memory,
  tickets, conventions), so a project agent is effectively the project, given
  a session.
- **Any agent can start child agents** for a piece of work. A child is not
  short-lived by default: it stays as long as it is useful, can be messaged
  later ("also fix the docs"), and can start its own children.
- **An agent ends** when its parent decides it is done, or when it reports it
  is finished and the parent agrees.
- **Every agent sees the shared HIVE context.** Through HIVE's MCP server,
  every agent can read and update project memory, tickets, identity,
  precedents and the queue, whatever its level.
- **Claude sub-agents** sit inside an agent's session and are invisible to
  HIVE. The agent that used them answers for them.
- Agents are real Claude Code sessions (background sessions, visible in agent
  view), not `claude -p` calls. Print mode is only for nightly and launchd
  jobs.

| | Claude sub-agent | HIVE agent |
|---|---|---|
| Lives in | Its parent's session | Its own Claude Code session |
| Lifetime | Usually one task | As long as useful; can be messaged later |
| Memory | The parent's context | Its own workspace, plus shared HIVE memory and tickets |
| Managed by | Claude Code | Its parent agent, through HIVE |

## 4. Agent workspaces

```
~/.hive/
  agents/<name>/          maya, revrec, rate-limiter, ...
    charter.md            what this agent is for, in prose, plus the skills
                          it carries (Greg-editable)
    checklist.md          what to look at each time it wakes (Greg-editable)
    log.md                what it did and why, appended
    memory/               its own notes
    session.json          session ID, parent, repo/worktree, how to resume
    .claude/skills/       links to the skills this agent carries (§4.1)
  queue/<item-id>/
    item.md               the ask, the chain of recommendations, status
    evidence/             *.png, *.txt
  precedents/             Greg's answers, one file each
  skills/<name>/SKILL.md  the skill library every agent draws from
```

- Each agent writes only its own folder; queue items are written by whoever
  creates them and answered by Greg. Project memory and tickets are shared
  and go through HIVE's existing MCP tools.
- The charter is the scope. There is no mandate or permission format; the
  agent reads its charter and judges what fits.
- If an agent's session is gone, a new session starts from its workspace.

### 4.1 Skills: what makes a role

Agents are all the same kind of thing. What makes Maya different from the
revrec agent is **her charter (what she is for) and her skills (how she does
it)**. Skills are prose playbooks in Claude Code's `SKILL.md` format, so they
fit "trust the model": they explain how to do something well, they do not gate
anything.

| Layer | Who carries it | Examples |
|---|---|---|
| **Shared core** | Every agent | How the tree works and how to talk in it (`message`, `agent_start`, `queue_add`, `precedents_search`); using project memory and tickets; when to decide vs. escalate and how to add your read on the way up; keeping `log.md` and `memory/` current so a fresh session can pick up; capturing screenshots and text as evidence |
| **Maya** | The chief of staff | Reading the whole tree (who is alive, what each agent is doing); ranking, merging and grouping the queue; spotting collisions between projects; supervising children that have gone quiet |
| **Project** | Each project agent | The project's stack skills; the ticket workflow; starting builder and reviewer children; proposals as small bets |
| **Task** | Child agents | Whatever the job needs; the parent picks them when it calls `agent_start` |

- **The charter is a skill too.** It is loaded in full at startup, along
  with the shared core and the role layer, so the agent definition's own
  prompt can stay empty (§5.1).
- **Project stack skills live in the repo** (`.claude/skills/`), written there
  by `hive stack`, so any session in that repo has them.
- **Keep the core lean.** Every skill's description is always in context and
  preloaded skills load in full. Long material goes in supporting files the
  skill points to.
- **Overlap is fine.** Maya and a project agent both carry the shared core; a
  project agent and its children share the repo's stack skills.
- **Skills are where learning lands.** When precedents keep repeating the
  same lesson, an agent can propose a skill edit through the queue, like a
  charter change. Greg can edit any skill directly; Claude Code picks up
  edits live.

## 5. How agents run and talk

### 5.1 Launching an agent

HIVE turns an agent's workspace into a Claude Code agent and starts it as a
background session:

1. **Generate an agent definition** `hive-<name>` (in `~/.claude/agents/`):
   - an **empty prompt**, so Claude Code keeps its normal system prompt
     (a non-empty agent prompt replaces it);
   - `skills:` the charter skill, the shared core, and the role layer, which
     Claude Code loads in full at startup;
   - HIVE's MCP server.
2. **Launch** in the agent's repo or worktree:
   `claude --agent hive-<name> --bg --name <name> --add-dir ~/.hive/agents/<name>`.
   `--add-dir` makes the agent's own `.claude/skills/` available to that
   session only. An optional per-agent `--settings` file can set
   `skillOverrides` to quiet global skills the agent does not need.
3. **Record** the session ID in `session.json`.

The same launch happens whether Greg runs `hive revrec`, Maya calls
`agent_start`, or a timer wakes an agent with no live session.

Supporting commands come from Claude Code: `claude attach <name>` to drive a
session, `claude agents --json` for status, `claude logs <name>` for recent
output.

### 5.2 Talking

Agents use HIVE's MCP server. The minimum tool set, on top of the existing
memory and ticket tools:

- `agent_start(charter, repo?, skills?)` — start a child agent. If it will
  edit code, it gets its own worktree and branch; an agent that only thinks
  or reviews does not need one.
- `message(to, text)` — send a message to an agent by name. A child uses it
  to tell its parent it finished, is stuck, has a question, or has an idea.
  Greg (or any session he has open) uses it to reach Maya: `to: "maya"`.
- `queue_add(item)` — put something in front of Greg, with evidence.
- `precedents_search(query)` — see how Greg decided similar things.

Delivery uses Claude Code's cross-session messaging where available;
otherwise HIVE resumes the target with the message as the next prompt
(`claude --resume <id> --bg "<message>"`).

**Waking.** An agent wakes when it gets a message: a child reports, its
parent or Greg sends something, Greg answers a queue item, or a launchd timer
nudges it to walk its checklist. That is all for now.

### 5.3 Greg can drive any agent directly

The tree says who supervises whom, not who Greg can talk to. `hive` in a
project directory (or `hive revrec`) attaches Greg to that project's agent
(`claude attach`), or launches it per §5.1 if it has no live session.

- While Greg is driving, he is that agent's supervisor: its questions come to
  him in the session instead of going up to Maya, and his instructions count
  like queue answers (the important ones can become precedents).
- The agent notes in its log that Greg is driving, so Maya knows and does not
  start conflicting work there. Maya can still flag a collision ("you're
  changing auth in revrec; matreas depends on it").
- When Greg leaves, supervision returns to Maya, who picks up from the
  agent's log.

## 6. Supervision

Agents are trusted to understand their scope. When a child reports, its
parent thinks about it and does whatever makes sense: let it continue,
redirect it, answer its question, retry with another model, have another
agent verify the work, start an exploration, stop it, or escalate. There is
no fixed menu and no rules engine.

**When unsure, go up.** An agent that is not sure decides, gets a second
opinion from another agent, or escalates to its parent. Each level adds its
own read and recommendation before passing it on, so Greg sees a stack
("revrec recommends A; Maya agrees but A collides with matreas's migration,
do it after") rather than a raw question.

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
- Inside that, rely on Claude Code's own safety (auto-mode classifiers,
  sandbox, permissions). HIVE adds no extra machinery.

## 8. The queue

One queue, an evolution of the dashboard at `127.0.0.1:7777`. Items are
folders under `~/.hive/queue/`.

- **Kinds:** review (a branch ready to look at), decision (a question the tree
  could not settle), proposal, blocker (needs a credential, fact or access),
  FYI.
- **Each item has:** which agent raised it, each level's recommendation on the
  way up, evidence (screenshots and text, captured with Claude Code's own
  tools), and one-key actions: approve, reject, redirect, each with an
  optional reason.
- **Maya** ranks the queue, merges duplicates, groups related items, and
  settles what she can. She should be able to say why an item is first.
- **Dashboard:** queue first, one item at a time, evidence large, keyboard
  driven. Today's report becomes a secondary view. No network, no voice.

When Greg answers, the answer goes to the agent that raised the item as a
message and, with his reason, into `precedents/`.

## 9. Proposals: small bets

v1 Propose picked one ticket a night. In v2 any agent can propose anything:
new work, a refactor, killing a ticket, changing its own charter or skills. A
proposal comes with a cheap spike already done (a draft branch, a screenshot,
a short proof), so approving means "keep going." A rejection with a reason is
a precedent like any other.

## 10. Storage

Markdown in git under `~/.hive/`, as today. Evidence files sit outside git.
Queue status lives in `item.md` frontmatter; session info in
`session.json`. The minimum version needs no database. Add one when file
contention or queue queries actually hurt.

## 11. What goes away

Watches (Observe / Propose / Act), the watch spec format, campaign dispatch,
the decompose loop, `next.json` / `hive next`, and the deterministic
eligibility gates are deleted, not migrated. Kept as agent behavior: own
branch and worktree for code changes, never merge, end in a reviewable state.
The nightly memory pipeline, identity, taste, tickets and council stay;
project memory and tickets become shared context for every agent.

## 12. Known compatibility risk

Claude plans to make `--bare` the default for `-p`. `--bare` is API-key
only and skips OAuth. HIVE's nightly and launchd jobs use `claude -p` with
subscription OAuth, so they would break. `hive doctor` checks what `-p`
does on the installed version, and HIVE opts out of bare mode if a flag
allows it (unverified). If OAuth fails, the job fails visibly; no API-key
fallback (per `CLAUDE.md`).

## 13. Jev (optional, separate)

Jev (`docs/jev-decision-loop.md`) is cheap enough to run at every stopping
point as a second opinion on "what should the parent do now." Its context is
32k (per OpenRouter), so it gets the facts and the recent tail, not the whole
transcript. Nothing in the core depends on it.

## 14. Verify before building

1. `--agent` with a `skills:` list loads those skills in full for the main
   session, not only for sub-agents.
2. An agent definition with an empty prompt keeps Claude Code's default
   system prompt.
3. Background sessions run on the subscription: start one with
   `ANTHROPIC_API_KEY` unset and confirm it works.
4. `--add-dir` skills stay scoped to that one session.
5. Cross-session messaging is available locally, or fall back to
   `--resume ... --bg`.

## 15. Deferred — revisit when it breaks

- Other harnesses (Codex, Cursor, Pi) as agent hosts. They read the same
  `SKILL.md` format, so skills will carry over when they are added.
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
- Agents whose charter spans several projects or has no repo.

## 16. Decisions

- **D1 (2026-11-08). Maya is a background Claude Code session on the
  subscription.** Not `claude -p`, not API credits. Greg resumes her with
  `hive maya`, or messages her from any open Claude Code session with
  `message(to: "maya", ...)`.
- **D2 (revised 2026-11-11). Claude Code only, for now.** Every agent is a
  Claude Code session started through the CLI, whether Greg starts it or HIVE
  does. Other harnesses are deferred. (Earlier version: non-Claude harnesses
  spawned like a sub-agent through `hive -x/-a/-3`.)
- **D3 (2026-11-08). Recovery is a fresh session from the workspace.** Greg
  will clear Maya's context like any other session, so every agent keeps what
  matters in its workspace (`log.md`, `memory/`) rather than in its context.
- **D4 (2026-11-08). Delete watches and campaign first**, then build v2.
- **D5 (2026-11-08). One project agent per registered HIVE project.** The
  list comes from the project registry. For Greg today: matreas, revrec,
  arete, writing, investing and hive, all with repositories.
- **D6 (2026-11-08). Messages go through one HIVE MCP tool,
  `message(to, text)`**, addressed by agent name; the chief of staff is Maya.
- **D7 (2026-11-11). Skills define roles** (§4.1), delivered through Claude
  Code's agent definitions and per-agent skill folders.
- **D8 (2026-11-11). Every agent has HIVE's shared context**: project memory,
  tickets, identity, precedents and the queue, through the MCP server.

## 17. Sources

- Brian Armstrong's post (leads, chief of staff, one queue).
- Claude Code docs: [skills](https://code.claude.com/docs/en/skills.md),
  [sub-agents](https://code.claude.com/docs/en/sub-agents.md),
  [agent view](https://code.claude.com/docs/en/agent-view.md),
  [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging.md),
  [headless](https://code.claude.com/docs/en/headless.md).
- Grok Bot architecture write-up:
  https://gist.github.com/wtfsayo/b80f74f4f64d18ced8c84502a23148fe;
  `AgwaB/grok-bot-agents`; OpenClaw workspace files.
- `docs/jev-decision-loop.md`, `docs/dashboard.md`, `templates/TRUST.md`,
  `PRODUCT.md`.
