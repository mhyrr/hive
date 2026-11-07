# HIVE v2 — Design

**Status:** Draft 1, for review. Nothing here is built.
**Date:** 2026-11-07
**Origin:** Design conversation between Greg and Claude, prompted by Brian
Armstrong's post on running one lead agent per area, a chief-of-staff agent
over them, and a single prioritized review queue.

## 1. Why a second version

HIVE v1 was built to stretch scarce tokens across models. That constraint is
gone: tokens are widely available on every harness Greg uses. What is scarce
now is **Greg's attention**.

The target, borrowed from Armstrong's description:

- One **lead agent per area of focus**, effectively always on.
- A **chief of staff** over the leads.
- Leads manage their own sub-agents that write code, test it, and review it.
- Everything Greg must decide or review arrives in **one prioritized queue**
  in a local web app, cleared in batches.
- Review items carry **evidence** (screenshots and text) so most can be
  decided without checking out a branch.
- The system **learns Greg's judgment** so recommendations and first drafts
  improve before they reach him. The north-star metric is **fewer corrections
  per change**.
- Every change still goes through human review and security checks. The
  system removes tasks, not judgment.

Most of the pieces exist in v1 in some form: harness wrappers (`hive`,
`hive -x`, `hive -a`, `hive -3`), identity, memory and Pass V, taste
extraction, tickets, the Act executor, and the dashboard. v2 reorganizes them
around the tree and the queue and replaces the parts that did not age well.

## 2. Principles

1. **Trust the model and trust the harness.** v1 got into trouble by being
   too restrictive and deterministic, and by not trusting either the
   harnesses as they evolved or the models as they got smarter. v2 relies on
   both. When something is uncertain, the answer is the supervision tree,
   not more rules.
2. **HIVE owns the things it keeps track of; harnesses do the work.** HIVE
   owns areas, charters, the queue, decisions and their reasons, precedents,
   taste, and the supervision tree. Running agents, spawning sub-agents,
   worktrees, browser driving, screenshots, tool calls and context management
   belong to the harnesses, which compete on them every month. HIVE calls
   them; it does not copy them.
3. **Don't go stale as the harnesses evolve.** Every HIVE workaround for a
   missing harness feature says when to delete it. `hive doctor` checks each
   installed harness against the adapter so changes show up in doctor, not in
   a failed overnight run (§7).
4. **Every agent thinks; the plumbing doesn't.** Each node in the tree
   reasons with the context it holds. A lead knows its area in depth; the
   chief of staff sees across areas. The transport (dashboard server, queue
   store, event delivery) only stores and routes.
5. **Ideas branch; only actions are gated.** Exploration is internal and
   reversible and never needs permission. The safety line applies only at the
   moment of an external action (§8.6).
6. **Greg's decisions are the training data.** Every queue decision is a
   labeled example of his judgment, cleaner than anything mined from
   transcripts (§11).

## 3. What changes from v1

| v1 | v2 |
|---|---|
| Projects, one per repo | Areas, each owned by a lead. Start with one lead per repo (open question Q2) |
| Watches (Observe / Propose / Act), each a separate scheduled check | Leads with durable workspaces, woken by a single trigger hub (§6) |
| No cross-project agent | Chief of staff (§4) |
| Act executor (branch, worktree, `review_ready`) | One run primitive through a harness adapter (§7) |
| `next.json`, inbox, dashboard as a morning report | One queue, cleared in batches; the report becomes a secondary view (§9) |
| Propose: an LLM picks one existing ticket nightly | Proposals as small bets with evidence attached (§10) |
| Taste mined from transcripts | Queue decisions as the primary signal, transcripts secondary (§11) |
| Everything in markdown in git | Markdown in git for knowledge; SQLite for operational state (§12) |
| Token-maximizing routing, cost as a headline number | Routing for quality (cross-model review); budgets kept as backstops only |

### 3.1 Teardown

Watches and campaign are replaced wholesale, not migrated. This covers
roughly 6,400 lines across `watch*`, `act-run`, `decompose*` and `next`.

**Keep, as behavior of the new run primitive:**

- A run works on its own branch off `main` in its own worktree.
- A run never merges, pushes, or closes a ticket on its own.
- Claim with a run ID so two runs cannot take the same work; a superseded run
  cannot overwrite newer state.
- A finished run ends in a reviewable state.

**Remove:**

- The watch spec format (cadence / scope / venue / autonomy frontmatter).
- Fan-out of fleet specs to every project.
- The three named cycles.
- `next.json` and `hive next`.
- Campaign dispatch.
- The decompose loop. Planning inside a session is the harness's job now.
- The deterministic eligibility list (no P0s, no `needs-greg`, etc.) as a
  hard gate. Those facts go into a lead's context; the lead judges.

Teardown order is open (Q6).

## 4. The tree

A **node** is anything in the tree that supervises what is under it. A node
is a role plus saved state, not a running process: between turns it is files
and database rows, and it only thinks when woken.

Every node has an identity (a workspace or run folder), a parent it escalates
to, its children, and a budget used only as a runaway backstop (§8.6).

| Node | Lifetime | Supervises | Context it thinks with |
|---|---|---|---|
| **Greg** (root) | Permanent | Chief of staff | Everything, at his choosing |
| **Chief of staff** | Durable workspace | Leads | All areas: conflicts, duplicated work, shared blockers, portfolio priorities, Greg's taste at that level |
| **Lead** | Durable workspace | Runs | One area in depth: code, plan, recent failures, area precedents |
| **Run** | One job | Nothing in HIVE's tree | Its brief and its workspace |

```
Greg
 └─ chief of staff
     ├─ lead: revrec
     │   ├─ run (Claude, building)
     │   └─ run (Codex, read-only review)
     └─ lead: dobby
         └─ run (Cursor, exploring)
```

- **Harness sub-agents are not nodes.** They sit below the line; the run
  that spawned them answers for them. HIVE's tree stops at the run.
- **Depth is capped there.** Grok Bot does the same: its task children
  cannot spawn their own children.
- **A lead's turn is a resumed session in a harness**, not a HIVE-side agent
  loop. HIVE stores the session ID and the files around it. The same holds
  for the chief of staff. Whether each lead picks its own harness or the
  chief of staff routes is open (Q4).
- **No plugin.** HIVE stays a wrapper over the harnesses rather than a Claude
  Code plugin, because the chief of staff must be able to deploy any of
  Claude Code, Codex, Cursor or Pi.

## 5. Agent workspaces

Each durable agent has its own folder. This is close to Grok Bot's named
agents and to OpenClaw's workspace files, and is a natural extension of
HIVE's identity stack.

```
~/.hive/
  agents/
    cos/
      charter.md      what this agent is for, in plain prose
      checklist.md    what to look at on every wake, editable by Greg
      log.md          what it did and why, appended
      memory/         its own notes
      session.json    current harness, session ID, resume info
    revrec/
      ...
  queue/<item-id>/
    item.md
    evidence/*.png
    evidence/*.txt
  runs/<run-id>/
    brief.md          standalone instructions for the run
    result.md         summary plus artifact paths
    review.diff       for review runs
  taste/
  hive.db             operational state (§12)
```

- **Single writer per file.** Each lead writes only its own folder; the chief
  of staff writes queue ranking; the brain writes taste. Git never sees two
  writers on one file. (Grok Bot: single-writer memory shards.)
- **The charter is prose.** There is no mandate format. A lead understands its
  scope from its charter and judges what fits. When unsure, it uses the
  supervision tree (§8).
- **The checklist** borrows OpenClaw's heartbeat file: a short, Greg-editable
  list of what the agent checks every time it wakes.

## 6. Wakes: one trigger hub

All triggers become a recorded **wake** for a named agent, delivered through
that agent's normal turn. There is no separate automation runtime. (Grok Bot:
schedules, listeners and backend events all feed one trigger hub.)

Wake sources:

- Timers (launchd).
- Git and CI changes in an area's repos.
- A child run finishing, stalling, or reporting.
- Greg answering a queue item.
- A parked item's wake condition coming true.

Each wake records what caused it. On startup, and when the laptop wakes from
sleep, HIVE reconciles definitions and re-delivers wakes that were missed.

**Substrate:** Greg's laptop to start. Leads run while the machine is awake;
the queue waits while it sleeps. Cloud sessions could later be overflow
capacity without changing the model.

## 7. Harness adapter

One adapter per harness, with a small interface:

- `start(brief, workspace, mode, model hint)` returns a run handle.
- An event stream for the run.
- `resume(handle)`.
- A result: status, summary, artifact paths.
- `capabilities()`: what this harness and version supports.
- Rate-limit state, so routing can skip a harness until it resets.

**Modes** are normalized across harnesses (from the `grok-bot-agents`
plugin):

| Mode | Meaning |
|---|---|
| read-only | Can read and run checks; changes fail the run |
| safe | Can edit inside its workspace |
| full-auto | No approval prompts inside its workspace |

Each adapter maps these to the harness's own flags (e.g. Claude `plan` ↔
Codex `-s read-only` ↔ Pi `--tools read,grep,find,ls`). Actual flags must be
checked against each harness's current docs when building, not taken from
this doc.

**Staying current:**

- HIVE asks `capabilities()` instead of hard-coding flags. Today `claude.ts`
  and `act-run.ts` build command lines by hand; that is the code that breaks.
- Every HIVE workaround is labeled with its removal condition, e.g. "delete
  when Codex ships resumable headless sessions."
- `hive doctor` runs a tiny smoke test per installed harness: start, resume,
  structured output, sub-agent definitions honored.

**Cross-model review.** A review run is launched read-only on a different
model from the builder. It fingerprints the workspace before and after and
fails if anything changed, producing `review.diff` and a written verdict.

**Run lifecycle** (from `grok-bot-agents`): each run gets a standalone
brief, runs headless in the background with a timeout, and wakes its lead on
completion. A run that changed nothing cleans up its own worktree. Automatic
restarts are capped.

## 8. Supervision

The core idea: **agents are trusted to understand the scope of their work.
When a node is not sure, the supervision tree takes over** — it decides
itself, consults Jev or a reviewer, or bubbles the decision up to its
parent, all the way to Greg if needed.

### 8.1 The supervision step

When a child reaches a stopping point (finished, blocked, failed, proposing,
asking, or has an idea), its parent runs one supervision step and picks one
option:

| Option | Meaning |
|---|---|
| CONTINUE | Let it carry on |
| REDIRECT | Same child, corrected instructions or scope |
| REROUTE | Retry on a different harness or model |
| VERIFY | Launch an independent read-only reviewer, ideally on a different model |
| DECIDE | Answer the child's question itself |
| EXPLORE | Fork a sibling run on its own branch to chase an idea (§8.5) |
| PARK | Defer until a named wake condition |
| STOP | Kill the work |
| ESCALATE | Send it up, with this node's own read and recommendation attached |

The step is one shared prompt (`~/.hive/supervision.md`). What varies by level
is what goes into it: the node's charter, its context, relevant precedents,
and its overturn history. Tuning means editing text.

The menu is a starting point and is expected to change.

### 8.2 When to escalate

There is no rules engine. A node escalates when it is not sure, judging
things like:

- How hard the outcome is to undo, and how far it reaches.
- Whether there is a precedent for this kind of decision.
- Whether the builder and reviewer disagree.
- Whether it touches a sibling's area (then it belongs to the parent that
  sees both).
- Whether it needs something only Greg has: a credential, a fact, access.
- Whether it is a taste call Greg has shown he wants to make himself.

Escalation goes to the **parent**, not straight to Greg. Each level can
resolve it or pass it on.

### 8.3 What happens on the way up

Each level adds its own read and recommendation. By the time an item reaches
Greg it reads like: "revrec lead recommends A (0.8). Chief of staff agrees,
but notes A collides with dobby's migration next week and suggests doing it
after." Greg decides against a stack of recommendations, not a raw
question.

### 8.4 What happens on the way down

- **Greg's answers become precedents**, recorded with their reasons and
  scope, in markdown.
- **Precedents and overturn history are fed into future supervision steps**
  as context. The next time a similar question comes up lower in the tree,
  that level can decide it. Over time decisions move down the tree. This is
  the "Brian brain" expressed in the structure, not only in prompts.
- **Nothing is enforced in code.** Agents calibrate from what they see. An
  agent that keeps getting overturned sees that and should escalate more.
- **Decisions made without escalating are logged**, and a sample comes to
  Greg as low-priority spot-check items (§9.1). The chief of staff spot-checks
  leads the same way.

### 8.5 Exploration is a branch

A good idea is never a reason to stop.

- A run with an idea reports it and keeps going on its current job.
- Its lead can EXPLORE: fork a sibling run on its own git branch with a small
  budget, while the original work continues. A run may fork itself directly
  if the harness supports it.
- The result comes back as a proposal with evidence (§10).
- Exploring is reversible, so it needs no permission. If an exploration later
  wants to do something external, it meets the safety line at that moment,
  like any other run.

"Branch" means both a git branch for the code and a new branch of the tree
for the work.

### 8.6 The two things that are not judgment calls

1. **The safety line (from `TRUST.md`).** External actions (push, deploy,
   send, post, spend) are asked about. Hard limits (spend money, sign
   contracts, share secrets, delete production data, destructive actions on
   live systems) are never crossed. Anything touching hard limits or security
   goes straight to Greg's queue; middle nodes cannot hold or reword it. The
   line applies at the moment of the action, never to ideas or exploration.
   Approval covers the one exact action requested, not a category.
2. **A runaway backstop.** A time and spend ceiling per run and stall
   detection. An agent stuck in a loop cannot see that it is looping, so this
   is the one place its judgment cannot be relied on. It does not judge the
   work; it catches the case where nothing is thinking any more.

### 8.7 Jev as an optional decision engine

Jev (see `docs/jev-decision-loop.md`) is experimental and separate. Nothing
depends on it. The supervision step is a fixed menu plus a state object,
which is exactly the shape of a Jev choice question, so it can be tried as an
alternative engine and compared against the default prompt.

Why it is interesting here:

- **Cost.** About $0.04 per million input tokens, output free; a full 30k
  state is about a tenth of a cent. Supervision can run at **every stopping
  point**, not only at milestones.
- **Context.** Because it is cheap, it can be given everything: transcript,
  queue context, precedents, overturn history.
- **Confidence.** Jev returns a confidence alongside its choice. Low
  confidence is the natural "not sure" signal that sends a decision up the
  tree. The existing doc notes choice confidence was measured as
  overconfident, so thresholds would start conservative.

**Open item:** `docs/jev-decision-loop.md` records limits of about 32k tokens
for state plus the longest question and 64k total, taken from search
summaries. A long transcript would exceed that. Feeding everything depends on
either higher current limits (to verify against TypeSafe's docs), trimming to
a recent tail plus summary, or splitting context across parallel questions in
one request.

## 9. The queue

The queue is where Greg meets the system. It is an evolution of the local
dashboard (`127.0.0.1:7777`), not a new product.

### 9.1 Queue items

Each item is a folder under `~/.hive/queue/<id>/` with `item.md` and
`evidence/`. Its status and rank live in `hive.db`.

| Kind | Example |
|---|---|
| Review | A branch ready for review, with screenshots, test output and a review verdict |
| Decision | A question the tree could not settle, with stacked recommendations |
| Proposal | A small bet from a lead, with a draft attached (§10) |
| Blocker | A run needs a credential, a fact, or access |
| Spot-check | A sample of a decision made without escalating, for audit |
| FYI | Something worth knowing that needs no action |

Each item carries:

- The originating node and the escalation chain, with each level's
  recommendation and confidence.
- The brain's predicted answer (§11).
- Evidence: **screenshots and text**. No video. Leads capture screenshots
  with the harness's own browser and screenshot tools; HIVE stores them and
  defines what a complete packet looks like, it does not build capture.
- How reversible it is and what waiting costs.
- A small set of one-key actions. Approve, reject and redirect accept a reason.

### 9.2 Chief of staff and the queue

The chief of staff thinks about the queue as a whole:

- Ranks it.
- Merges duplicates across leads.
- Groups related items ("three leads are blocked on the same auth decision").
- Resolves items it can confidently settle itself.
- Holds back low-value items to protect Greg's attention.

Ranking is the chief of staff's judgment, not a fixed formula. It should be
able to say why an item is first.

### 9.3 Dashboard

- **Queue-first view** on `:7777`. One item at a time, evidence large,
  keyboard shortcuts for next, previous, approve, reject, redirect, and "ask
  the lead."
- Batches grouped by the chief of staff.
- The current report (the yard, the briefing) becomes a secondary view.
- Evidence is local files, so the zero-network rule holds.
- **Voice is out of scope.** Greg will layer it on separately.

## 10. Proposals: small bets

v1 Propose picked one existing ticket nightly. v2 proposals:

- **Cover more than tickets:** new work, a refactor, killing a ticket, a
  change to a lead's own charter.
- **Show, don't tell.** A proposal comes with a cheap spike: a draft branch,
  a screenshot, or a short proof. Approving means "keep going," not "start."
- **Arrive scored.** Recommendation, confidence, predicted answer,
  reversibility. The chief of staff merges duplicates and holds back
  low-value ones.
- **Rejections teach.** "No, because X" is the cleanest taste label
  available and feeds both the brain and the lead's charter.

## 11. The brain

- **Primary signal: queue decisions.** Situation, what was proposed, what
  Greg did, and why. Transcript mining (v1 taste extraction) stays as a
  secondary source.
- **Shadow mode first.** The brain predicts Greg's answer to every item
  before he sees it and is scored against what he decides. This is the eval.
- **Precedents** (§8.4) are the structural half of the brain; taste units are
  the stylistic half.

**Metrics** (which to lead with is open, Q7):

- Corrections per change.
- Prediction accuracy in shadow mode.
- Overturn rate per node.
- Escalation rate per level.
- Greg's minutes per day in the queue.

## 12. Storage

Research summary: coding agents have largely moved from vector retrieval to
agentic search (grep, file traversal). Practitioners are settling on files as
the source of truth with a rebuildable SQLite full-text index on top, with
vectors only for semantic recall at large scale. For coordination state,
append-only event logs and per-agent SQLite stores (Grok Bot) are common;
Temporal-style durable execution exists for exactly-once recovery but is
overkill on a laptop.

| Data | Store | Why |
|---|---|---|
| Identity, charters, checklists, memory, taste, precedents, queue item bodies | Markdown in git | Written rarely, reviewed by Greg, must stay readable |
| Wakes, run status, claims, queue status and rank, escalation links, events | One SQLite file (`hive.db`, WAL mode), not in git, via `bun:sqlite` | Frequent, concurrent, atomic, queryable |
| Screenshots and text evidence | Plain files, outside git | Keeps binaries out of the repo |
| Search index | SQLite FTS5, built from the markdown | Rebuildable |
| Vectors | Not now | Add (e.g. `sqlite-vec`) only if an eval shows better recall |

**Rule:** everything in SQLite can either be rebuilt from files, or is
short-lived operational state whose loss costs only work in progress.
Decisions are exported to markdown, so precedents always land in git.

**Positioning change:** "no database" becomes "no database that holds
anything you can't lose."

## 13. Out of scope

- Voice (Greg builds it separately on top).
- Video evidence.
- A Claude Code plugin.
- A mandate or permissions format.
- Jev in the core path.
- Cloud substrate (laptop first).
- Vector search.
- Building sub-agent, worktree, or screenshot machinery that harnesses
  already provide.

## 14. Open questions

- **Q1. Solo or team?** Armstrong's leads coordinate with team members and
  chase reviews. That means outward-facing actions and some model of other
  people.
- **Q2. What is an area?** Start with one lead per repo, or allow areas that
  span repos (or have no repo: LOAM go-to-market, house integrations) from
  the start?
- **Q3. Where is the autonomy line for code?** Today: never push. Is "push
  the branch and open a PR, never merge" acceptable?
- **Q4. Harness choice:** does each lead pick its own harness, or does the
  chief of staff route every run?
- **Q5. Phone access** to the queue: needed? It breaks the current
  localhost-only security model.
- **Q6. Teardown order:** delete watches and campaign first and run with
  nothing scheduled for a while, or build alongside and cut over?
- **Q7. Lead metric** for the brain: which one first?
- **Q8. Jev context limits:** verify current limits before designing the
  "feed everything" path.

## 15. Prior art and sources

- Brian Armstrong's post (lead agents, chief of staff, one queue, "Brian
  brain").
- Grok Bot architecture write-up, reverse-engineered and not official:
  https://gist.github.com/wtfsayo/b80f74f4f64d18ced8c84502a23148fe
- `AgwaB/grok-bot-agents`, a community plugin delegating from Grok Bot to
  Claude Code, Codex, Pi and omp: https://github.com/AgwaB/grok-bot-agents
- OpenClaw (formerly Clawdbot) workspace files (soul, user, memory, heartbeat
  checklist).
- `docs/jev-decision-loop.md`, `docs/watches.md`, `docs/dashboard.md`,
  `templates/TRUST.md`, `PRODUCT.md`.
- Storage and retrieval research:
  - https://towardsdatascience.com/memweave-zero-infra-ai-agent-memory-with-markdown-and-sqlite-no-vector-database-required/
  - https://www.agentic-patterns.com/patterns/agentic-search-over-vector-embeddings/
  - https://arxiv.org/pdf/2608.01507 (agentic search for repository-level code QA)
  - https://arxiv.org/pdf/2602.23193 (ESAA: event sourcing for autonomous agents)
  - https://aissist.io/insights/best-ai-agent-orchestration-frameworks
