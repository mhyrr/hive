# HIVE v2 — Design

**Status:** Draft 2, for review. Nothing here is built.
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
4. **Ideas branch.** A good idea never stops work; it becomes a sibling run on
   its own branch.

## 3. The tree

```
Greg
 └─ chief of staff
     ├─ lead: revrec
     │   ├─ run (Claude, building)
     │   └─ run (Codex, reviewing)
     ├─ lead: dobby
     │   └─ run (Cursor, exploring)
     └─ run (Pi, started by the chief of staff directly)
```

| Agent | Lives as | Thinks about |
|---|---|---|
| **Chief of staff** | A long-lived harness session plus a workspace | Everything across areas: conflicts, duplicated work, shared blockers, priorities |
| **Lead** (one per area) | A long-lived harness session plus a workspace | One area in depth |
| **Run** | A harness session on its own worktree and branch | One job |

- The chief of staff can start runs itself, not only through leads.
- A harness's own sub-agents are below the tree. The run that spawned them
  answers for them.
- Leads and runs are real harness sessions (for Claude: background sessions,
  visible in agent view), not `claude -p` calls. Print mode is only for
  nightly and launchd jobs.
- Any harness can host any agent. Claude Code is the default.

## 4. Agent workspaces

```
~/.hive/
  agents/<name>/          cos, revrec, dobby, ...
    charter.md            what this agent is for, in prose (Greg-editable)
    checklist.md          what to look at each time it wakes (Greg-editable)
    log.md                what it did and why, appended
    memory/               its own notes
    session.json          harness, session ID, how to resume
  runs/<run-id>/
    brief.md              standalone instructions
    result.md             what happened, branch, evidence paths
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
CLI, Pi) that can: start a session with a brief in a worktree, send a message
into a running or resumable session, and read back its status. It discovers
what the installed harness supports (help output, version) instead of
hard-coding flags. Each workaround for a missing harness feature notes when to
delete it. `hive doctor` smoke-tests each installed harness (start, message,
resume).

**Talking.** Agents use HIVE's MCP server, which every harness already loads.
The minimum tool set:

- `run_start(harness, brief, repo)` — start a run on a new worktree and branch.
- `report(to_parent, text)` — a child tells its parent it finished, is
  stuck, has a question, or has an idea.
- `queue_add(item)` — put something in front of Greg, with evidence.
- `precedents_search(query)` — see how Greg decided similar things.

Delivery uses the harness's own mechanism where one exists (Claude
cross-session messaging, channels); otherwise HIVE resumes the target session
with the message as the next prompt.

**Waking.** An agent wakes when it gets a message: a child reports, Greg
answers a queue item, or a launchd timer nudges it to walk its checklist.
That is all for now.

## 6. Supervision

Agents are trusted to understand their scope. When a child reports, its
parent thinks about it and does whatever makes sense: let it continue,
redirect it, answer its question, retry on another harness or model, have
another agent or model verify the work, fork an exploration, stop it, or
escalate. There is no fixed menu and no rules engine.

**When unsure, go up.** An agent that is not sure decides, gets a second
opinion from another agent or model, or escalates to its parent. Each level
adds its own read and recommendation before passing it on, so Greg sees a
stack ("revrec lead recommends A; chief of staff agrees but A collides with
dobby's migration, do it after") rather than a raw question.

**Precedents.** Greg's answers are saved to `precedents/` with his reason.
Agents search them before escalating. Over time, decisions move down the
tree because agents can see how Greg decided last time.

**Exploration is a branch.** A run with an idea reports it and keeps going.
Its parent can fork a sibling run on its own branch to chase it. The result
comes back as a proposal.

## 7. Safety

- `TRUST.md` as-is: internal actions, act freely; external actions (push,
  deploy, send, post, spend), ask Greg through the queue; hard limits, never.
- Every run works on its own worktree and branch. Runs never merge.
- Inside that, rely on the harness's own safety (Claude's auto-mode
  classifiers, each harness's sandbox and approvals). HIVE adds no extra
  machinery.

## 8. The queue

One queue, an evolution of the dashboard at `127.0.0.1:7777`. Items are
folders under `~/.hive/queue/`.

- **Kinds:** review (a branch ready to look at), decision (a question the tree
  could not settle), proposal, blocker (needs a credential, fact or access),
  FYI.
- **Each item has:** who raised it, each level's recommendation on the way
  up, evidence (screenshots and text, captured with the harness's own tools),
  and one-key actions: approve, reject, redirect, each with an optional
  reason.
- **The chief of staff** ranks the queue, merges duplicates, groups related
  items, and settles what it can. It should be able to say why an item is
  first.
- **Dashboard:** queue first, one item at a time, evidence large, keyboard
  driven. Today's report becomes a secondary view. No network, no voice.

When Greg answers, the answer goes to the item's owner as a message and,
with his reason, into `precedents/`.

## 9. Proposals: small bets

v1 Propose picked one ticket a night. In v2 any lead (or the chief of staff)
can propose anything: new work, a refactor, killing a ticket, changing its own
charter. A proposal comes with a cheap spike already done (a draft branch, a
screenshot, a short proof), so approving means "keep going." A rejection with
a reason is a precedent like any other.

## 10. Storage

Markdown in git under `~/.hive/`, as today. Evidence files sit outside git.
Queue status lives in `item.md` frontmatter; session info in
`session.json`. The minimum version needs no database. Add one when file
contention or queue queries actually hurt.

## 11. What goes away

Watches (Observe / Propose / Act), the watch spec format, campaign dispatch,
the decompose loop, `next.json` / `hive next`, and the deterministic
eligibility gates are deleted, not migrated. Kept as run behavior: own
branch and worktree, never merge, end in a reviewable state. The nightly
memory pipeline, identity, taste and council stay.

## 12. Known compatibility risk

Claude plans to make `--bare` the default for `-p`. `--bare` is API-key
only and skips OAuth. HIVE's nightly and launchd jobs use `claude -p` with
subscription OAuth, so they would break. `hive doctor` checks what `-p`
does on the installed version, and the adapter opts out of bare mode if a
flag allows it. If OAuth fails, the job fails visibly; no API-key fallback
(per `CLAUDE.md`).

## 13. Jev (optional, separate)

Jev (`docs/jev-decision-loop.md`) is cheap enough to run at every stopping
point as a second opinion on "what should the parent do now." Its context is
32k (per OpenRouter), so it gets the facts and the recent tail, not the whole
transcript. Nothing in the core depends on it.

## 14. Deferred — revisit when it breaks

- Runaway / stall detection for a looping run.
- Time or spend budgets per run.
- Capacity limits or run slots, and rate-limit-aware routing.
- Missed wakes while the laptop sleeps; wakes from git or CI events.
- Cloud sessions as overflow.
- Phone access to the queue (breaks the localhost-only model).
- A database (SQLite) for queue state or an event log.
- Claims or leases so two runs don't take the same work.
- Precedent supersession or decay.
- Spot-checking decisions made without escalation.
- Shadow-mode prediction of Greg's answers and metrics (corrections per change).
- Normalized read-only / safe / full-auto modes across harnesses.
- Areas that span repos or have no repo.

## 15. Open questions

- **Q1. Where does the chief of staff live?** Is it Greg's interactive `hive`
  session, or a separate background session he talks to through the queue
  and messages?
- **Q2. Messaging into non-Claude sessions.** Can Codex, Cursor CLI and Pi
  each run a session in the background and accept a new message into it
  (via resume), or do some need a different shape? Check each before
  building their adapters.
- **Q3. Session lifetime on the laptop.** What happens to long-lived
  background sessions across sleep, restart, and context limits? Is "start
  a fresh session from the workspace" good enough as the recovery?
- **Q4. Teardown order.** Delete watches and campaign first, or build
  alongside and cut over?
- **Q5. First areas.** Which areas get leads on day one? (Default: one lead
  per active repo.)

## 16. Sources

Brian Armstrong's post (leads, chief of staff, one queue); Grok Bot
architecture write-up (https://gist.github.com/wtfsayo/b80f74f4f64d18ced8c84502a23148fe);
`AgwaB/grok-bot-agents`; OpenClaw workspace files; `docs/jev-decision-loop.md`,
`docs/dashboard.md`, `templates/TRUST.md`, `PRODUCT.md`.
