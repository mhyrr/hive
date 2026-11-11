# HIVE v2 — Design

**Status:** Draft 4, for review. Nothing here is built.
**Date:** 2026-11-07

## 1. What v2 is

v1 was built to stretch scarce tokens and ended up too restrictive and too
deterministic. Tokens are no longer scarce; Greg's attention is. v2 is a
solo-developer tool on Greg's laptop that turns HIVE into a small supervision
tree of agents, with everything that needs Greg in one queue.

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
     ├─ dobby                     (charter: the dobby project)
     │   └─ ...
     └─ release-notes             (started by the chief of staff directly, on Pi)
```

- **The chief of staff is Maya**, the agent at the top. (This brings back the
  Maya name from v1, whose Maya agents were retired.) She thinks across everything:
  conflicts, duplicated work, shared blockers, priorities. It can start agents
  under itself directly, not only through project agents.
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
~/.hive/
  agents/<name>/          maya, revrec, rate-limiter, ...
    charter.md            what this agent is for, in prose, plus the skills
                          it carries (Greg-editable)
    checklist.md          what to look at each time it wakes (Greg-editable)
    log.md                what it did and why, appended
    memory/               its own notes
    session.json          harness, session ID, parent, worktree, how to resume
  queue/<item-id>/
    item.md               the ask, the chain of recommendations, status
    evidence/             *.png, *.txt
  precedents/             Greg's answers, one file each
  skills/<name>/SKILL.md  the skill library every agent draws from
```

- Each agent writes only its own folder; queue items are written by whoever
  creates them and answered by Greg.
- The charter is the scope. There is no mandate or permission format; the
  agent reads its charter and judges what fits.
- If an agent's session is gone, a new session starts from its workspace.

### Skills: what makes a role

Agents are all the same kind of thing. What makes Maya different from the
revrec agent is **her charter (what she is for) and her skills (how she does
it)**. Skills are prose playbooks in the harness-native `SKILL.md` format, so
they fit "trust the model": they explain how to do something well, they do not
gate anything.

Skills come in layers, and an agent carries the layers that fit its role:

| Layer | Who carries it | Examples |
|---|---|---|
| **Shared core** | Every agent | How the tree works and how to talk in it (`message`, `agent_start`, `queue_add`, `precedents_search`); when to decide vs. escalate and how to add your read on the way up; keeping `log.md` and `memory/` current so a fresh session can pick up; capturing screenshots and text as evidence |
| **Maya** | The chief of staff | Reading the whole tree (who is alive, what each agent is doing); ranking, merging and grouping the queue; spotting collisions between projects; choosing which harness to deploy for a job; supervising children that have gone quiet |
| **Project** | Each project agent | The project's stack pack (the existing `templates/stacks/*/skills`, e.g. elixir, typescript); the ticket workflow; starting builder and reviewer children; proposals as small bets |
| **Task** | Child agents | Whatever the job needs; the parent picks them when it calls `agent_start` |

- **Delivery uses the harness.** For Claude Code, the agent's skills are
  linked where its session loads skills. For harnesses that read the same
  `SKILL.md` format, the same. For anything else, the skill text is injected
  with the starting context (D2). The exact per-session mechanism needs
  checking per harness when building.
- **Overlap is fine.** Maya and a project agent both carry the shared core;
  a project agent and its children may share the stack pack.
- **Skills are where learning lands.** When precedents keep repeating the
  same lesson, an agent can propose a skill edit through the queue, like a
  charter change. Greg can edit any skill directly.

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

**Greg can drive any agent directly.** The tree says who supervises whom,
not who Greg can talk to. `hive` in a project directory (or `hive revrec`)
attaches Greg's interactive session to that project's agent, with its
workspace, memory and children intact.

- While Greg is driving, he is that agent's supervisor: its questions come to
  him in the session instead of going up to the chief of staff, and his
  instructions count like queue answers (the important ones can become
  precedents).
- The agent notes in its log that Greg is driving, so the chief of staff
  knows and does not start conflicting work there. The chief of staff can
  still flag a collision ("you're changing auth in revrec; dobby depends on
  it").
- When Greg leaves, supervision returns to the chief of staff, which picks up
  from the agent's log.

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
dobby's migration, do it after") rather than a raw question.

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

One queue, an evolution of the dashboard at `127.0.0.1:7777`. Items are
folders under `~/.hive/queue/`.

- **Kinds:** review (a branch ready to look at), decision (a question the tree
  could not settle), proposal, blocker (needs a credential, fact or access),
  FYI.
- **Each item has:** which agent raised it, each level's recommendation on the
  way up, evidence (screenshots and text, captured with the harness's own
  tools), and one-key actions: approve, reject, redirect, each with an
  optional reason.
- **The chief of staff** ranks the queue, merges duplicates, groups related
  items, and settles what it can. It should be able to say why an item is
  first.
- **Dashboard:** queue first, one item at a time, evidence large, keyboard
  driven. Today's report becomes a secondary view. No network, no voice.

When Greg answers, the answer goes to the agent that raised the item as a
message and, with his reason, into `precedents/`.

## 9. Proposals: small bets

v1 Propose picked one ticket a night. In v2 any agent can propose anything:
new work, a refactor, killing a ticket, changing its own charter. A proposal
comes with a cheap spike already done (a draft branch, a screenshot, a short
proof), so approving means "keep going." A rejection with a reason is a
precedent like any other.

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
  HIVE (e.g. `hive maya`), or message her from whatever Claude Code session
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
- **D5. One project agent per registered HIVE project.** The list comes from
  the project registry, not from this doc. For Greg today that is matreas,
  revrec, arete, writing, investing and hive, all with repositories.
- **D6. Messages go through one HIVE MCP tool, `message(to, text)`**,
  addressed by agent name. Messages for the chief of staff are addressed to
  Maya.

## 16. Sources

Brian Armstrong's post (leads, chief of staff, one queue); Grok Bot
architecture write-up (https://gist.github.com/wtfsayo/b80f74f4f64d18ced8c84502a23148fe);
`AgwaB/grok-bot-agents`; OpenClaw workspace files; `docs/jev-decision-loop.md`,
`docs/dashboard.md`, `templates/TRUST.md`, `PRODUCT.md`.
