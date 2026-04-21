# Campaign Dispatch — Design

**Status:** Draft
**Date:** 2026-04-20
**Author:** Maya (with Greg)

## Summary

Add a long-horizon, self-directing dispatch mode to HIVE: a **campaign** is an orchestrated sequence of dispatch iterations against a single high-level goal. An external orchestrator (deterministic TypeScript loop + stateless LLM judgment calls) decomposes the goal, dispatches scoped iterations into a shared worktree, scores progress after each iteration, and decides the next move — continue, replan, pause, expand scope, or terminate. Designed for overnight work: set a compelling goal at night, wake up to compelling progress.

Single-shot `hive dispatch` stays untouched as the atomic primitive. Campaign composes it.

## Motivation

The campaign is two things at once, sharing one control loop:

1. **A long-horizon orchestrator** that runs multi-phase work overnight, adapts when emergent scope is discovered, and surfaces compelling progress in the morning.
2. **An obstacle traversal mechanism** that, when the executor hits a block, classifies it and reaches for an explicit toolkit (memory search, research subagent, council, revert, ask-human, etc.) instead of exiting `partial`.

Neither is primary. Both are the point. The shared OODA loop — Observe (what did the last iteration produce?), Orient (how does it track against the frozen goal, and am I blocked?), Decide (what's the next move, what tool applies, does this warrant a second opinion?), Act (dispatch the next iteration with the chosen shape) — is the machinery that serves both.

Current `hive dispatch` is a 30-minute fire-and-forget: scoped task, fresh worktree, `claude --print`, commit, exit. It ships three failure modes the campaign is designed to fix:

- **Horizon too short.** 30-minute boxes can't hold multi-phase work. Large goals get chopped into tickets manually, with Greg as the glue. The overnight promise doesn't scale past a single ticket.
- **Premature quit at recoverable blocks.** Dispatches exit `partial` or `failed` on obstacles where a second pass with memory search, web research, a council read, or a rewritten task would clear the block. The single-shot shape has no retry-with-reorientation and no toolkit to reach for.
- **Emergent scope lost.** When vision opens up mid-run — "while implementing X, I noticed Y would unlock Z" — the system has no way to capture, score, or selectively pursue the discovery. Either the executor pursues it unchecked (drift risk) or it's lost.

The design insight is that all three want the same loop. A campaign that only runs longer but can't traverse blocks is still brittle. A campaign that traverses blocks but can't hold emergent scope misses half the value overnight. The OODA loop, with an unblocking toolkit on one axis and goal/scope/emergent machinery on another, fixes all three as a single piece of infrastructure.

## Non-Goals

- **Not a replacement for `hive dispatch`.** Dispatch stays the single-iteration primitive. Campaign sits alongside.
- **Not a multi-project orchestrator.** A campaign targets one project. Cross-project work is out of scope.
- **Not Claude Code "Auto mode".** Auto mode is a permission mode (server-side classifier gating tool calls), not a control loop. Orthogonal to this design; can be adopted separately inside an iteration if desired.
- **Not human-in-the-loop by default.** Blocking checkpoints defeat the overnight promise. Notifications fire on exception; review is async in the morning.
- **Not a fully autonomous goal generator.** Greg writes the prime directive. The orchestrator decomposes and adapts within that scope. It does not invent campaigns on its own.

## Design

### Architecture

A campaign is driven by two distinct concerns, kept separate:

- **Orchestrator** — a long-lived TypeScript process (`hive campaign start` spawns it, detaches). Owns mechanical truth: budget enforcement, tripwire detection, iteration dispatch, extension grants, inbox writes, notifications, campaign state on disk. No LLM in the loop for these decisions — all deterministic.
- **Judgment calls** — per-iteration, stateless `claude --print` invocations with curated prompts. One call per iteration for orient/score. Council convened on-demand when the judge asks or a tripwire fires. No persistent LLM context across iterations; each call sees curated state only.

The **executor** (inner dispatch iteration) is a third concern, also a stateless `claude --print` — the existing dispatch primitive, extended to accept a pre-existing campaign worktree rather than always creating a fresh one.

Three independent contexts: orchestrator (deterministic), judge (stateless LLM, judgment only), executor (stateless LLM, doing only). The executor's context never pollutes the judge's. That separation is load-bearing — it's the structural counter-pressure against "same agent that did the work rationalizes the work."

### Iteration lifecycle

One iteration runs like this:

1. **Orchestrator decides next action.** Reads campaign state, runs the orient/score LLM call with curated prompt. Gets back a decision from the set: `continue | replan | expand-scope | pause-for-human | abort | done`.
2. **Terminal decisions short-circuit:** `done` → status `done`, merge-to-main notification fired. `abort` → status `aborted`, notification fired with reason. `pause-for-human` → status `paused`, notification fired; campaign resumes only when Greg writes to `directive.md` and issues `hive campaign resume`. `expand-scope` → convene council; if approved, scope fence updated and orchestrator continues; if denied, opportunity moves to `emergent.md` and orchestrator proceeds with prior plan.
3. **If `continue` or `replan`:** orchestrator writes the iteration's task to `iterations/ITER-NNN/task.md` and spawns the executor via dispatch primitive.
4. **Executor runs.** Fresh Claude Code session in the campaign worktree. Does the work. Must emit `iterations/ITER-NNN/checkpoint.md` before exiting (structured, schema below). May commit to the campaign branch.
5. **Executor terminates** on: natural boundary (plan step complete, test run green/red, commit made, dead-end reached, clarifying question surfaced) OR soft cap hit.
6. **Orchestrator reads checkpoint, updates state.** Appends scorecard row, updates inbox, checks tripwires and budget. Loops.

**How `done` is decided:** the judge's rubric includes an explicit `prime_satisfied: yes|no|partial` field alongside `progress_vs_prime`. `done` is only returned when `prime_satisfied: yes` AND scope fence is intact AND all plan items are checked AND no emergent items are flagged for mandatory inclusion. Anything less returns `continue`, `replan`, or escalates.

### Caps and extensions

Each iteration gets a **soft cap** — the lower of a token budget or wall-clock budget (e.g., 50K tokens or 25 minutes, whichever first). At soft cap, the orchestrator signals the executor via a sentinel file the executor polls; executor finishes current tool call, writes checkpoint, exits cleanly.

**Hard cap** is 1.5× soft cap. If the executor hasn't checkpointed by hard cap, orchestrator kills the process and writes a synthetic checkpoint marking it as uncheckpointed (which heavily penalizes the next iteration's scorecard for that work).

Checkpoints can **request an extension** via a field: `needs_more_time: "running integration suite, ~8min remaining"`. The orchestrator, on reading the checkpoint, can grant a targeted extension on the *next* iteration for that specific task. Legitimate long-running work gets oxygen; runaway loops don't.

Campaign-level budget is a separate ceiling (e.g., "burn no more than 2M tokens or 8 wall-clock hours on this campaign"). Orchestrator enforces, terminates cleanly when exceeded.

### Unblocking: the OODA point

The judge's first-class job, every iteration, is to ask: "is the executor blocked, and if so, what do I have in the toolkit to clear it?" This is the thing the campaign exists to do. Everything else (scoring progress, tracking drift, managing scope) is in service of making this mechanism trustworthy.

**Block classes** the judge discriminates:

- **Technical** — test failure, build error, missing dependency, unknown API surface
- **Information** — goal ambiguity, missing context in the spec, unclear requirement
- **External** — network flake, third-party service down, credential or auth issue
- **Environmental** — merge conflict, branch drift, dirty worktree, wrong state
- **Decision** — multiple valid paths with no obvious winner
- **Scope** — block requires crossing the scope fence to proceed
- **Resource** — token or time cap hit mid-operation

**Unblocking toolkit** — the levers the orchestrator can reach for:

| Tool | Applies to | Mechanism |
|------|-----------|-----------|
| `research-memory` | information, technical | Deterministic search of HIVE memory for prior instances. No LLM call. |
| `research-web` | information, technical | Dispatch a narrow-scoped research subagent with WebSearch/WebFetch. Returns a written answer. |
| `research-code` | information, technical | Dispatch a subagent to read wider code context than the executor saw. Returns a written summary. |
| `convene-council` | decision, scope | Multi-model read on the block. Reuses existing `convene_council` infrastructure. |
| `try-different-approach` | technical, decision | Rewrite the blocking task with different framing, dispatch fresh iteration. |
| `decompose-finer` | technical, information | Break the blocking step into smaller steps, dispatch the first. |
| `revert-and-retry` | environmental, technical | Back up to last good commit on the campaign branch, try a different path. |
| `skip-and-continue` | information, scope | If block is on an optional sub-goal, note in `emergent.md` and move on. |
| `ask-human` | information, scope, decision | Surface to Greg via `pause-for-human` with a specific question in the inbox. |
| `retry-later` | external | For flakes, loop back after a wait. Orchestrator schedules the retry. |

**Resolution workflow:**

1. Judge reads checkpoint, detects a block (explicit from executor's self-report, or inferred from signals — two iterations with no progress delta, dropped confidence, repeated failure signature).
2. Judge classifies the block and picks the cheapest applicable tool from the toolkit that hasn't been tried on this specific block.
3. Orchestrator applies the tool. Deterministic tools (`research-memory`, `revert-and-retry`, `retry-later`) execute in TypeScript, no LLM. LLM tools (`research-*` subagents, `try-different-approach`, `decompose-finer`) become the next iteration's shape. Council and human tools branch into their own paths.
4. Next iteration runs. Its checkpoint tells the judge whether the block cleared.
5. If block persists, judge escalates: next-tier tool, or `ask-human` if the ladder is exhausted for this block.

**Escalation ladder** when a tool doesn't clear the block:

1. **First tier (cheap):** memory search, replan, try-different-approach on existing context.
2. **Second tier (bounded LLM):** research subagent (web or code), decompose-finer, council.
3. **Third tier (structural):** revert-and-retry to a known-good state, skip-and-continue if the sub-goal is truly optional.
4. **Terminal:** ask-human. Campaign pauses with a specific question.

The escalation is tracked per-block in `iterations/ITER-NNN/block.json` so the judge sees which tools have already been tried and can't loop on the same lever.

### Scoring: scorecard + judge + council

Every iteration, the orchestrator runs one stateless LLM call (the **judge**) with a curated prompt. The judge returns a structured scorecard row appended to `scorecard.jsonl`:

```json
{
  "iter": 7,
  "timestamp": "2026-04-21T23:14:00Z",
  "progress_vs_prime": 0.6,
  "drift": 0.1,
  "fence_integrity": "intact",
  "confidence": 4,
  "recommendation": "continue",
  "second_opinion": "no",
  "block": null,
  "one_fact_that_could_be_wrong": "executor claims tests pass, but I only see a timestamp delta — haven't verified suite name matches",
  "evidence_cited": "commit abc1234 adds FooService; plan step 3 checked; no new test failures",
  "next_task": "proceed to plan step 4: wire FooService into the controller"
}
```

When a block is detected, the `block` field carries the classification and chosen tool:

```json
{
  "block": {
    "detected": true,
    "class": "information",
    "description": "plan step 4 requires knowing whether feature X uses the old or new auth middleware; spec ambiguous",
    "tier_attempted": 1,
    "tools_tried": [],
    "tool_chosen": "research-memory",
    "tool_params": {"query": "feature X auth middleware"}
  }
}
```

The schema is deliberately adversarial:
- `confidence: 1-5` self-rating, explicit
- `one_fact_that_could_be_wrong` forces the judge to name uncertainty
- `evidence_cited` grounds the progress number in specific artifacts
- `second_opinion: yes|no` is the judge's own call on whether a council is warranted

Trend data across the JSONL catches rationalization: three iterations with monotonically dropping confidence and no progress delta → the rubric should push `second_opinion: yes`. Same for flat progress with rising token burn.

**Council** is convened by the orchestrator when any of these fire:
- `second_opinion: yes` from the judge
- Judge recommends `expand-scope`, `abort`, or modifying the scope fence
- User-declared tripwire triggered (e.g., `--council-on auth,migrations,deploys`)
- Loop guard: N consecutive iterations with same `recommendation` and no commit delta

Council input is the same curated state as the judge, plus the judge's own scorecard row. Output gets synthesized into `iterations/ITER-NNN/council.md` and the synthesized position informs the orchestrator's next move.

### Goal structure

A goal is not flat text once it runs overnight. It has parts with different mutability rules:

- **Prime directive** (frozen). The original goal Greg wrote at dispatch time. Never modified without human approval. Scorecard alignment is measured against this.
- **Current plan** (mutable). The orchestrator's current decomposition. Can be rewritten freely between iterations; the rewrite itself becomes scorecard evidence.
- **Scope fence** (human-gated). Explicit list of what the campaign will *not* do. Modifications require council + human approval. Scope fence is the main defense against "confident wrong work" — drift shows up as proposed fence changes.
- **Emergent log** (append-only notebook). Discoveries the executor or judge flagged as potentially valuable but outside current plan. Never auto-acted. Promotion from emergent → plan requires a judge decision, and if promotion expands scope fence, requires council.

### Human-in-the-loop

Fully autonomous by default. Two channels for Greg:

- **Pull (async):** `inbox.md` is a running narrative. Every iteration appends a short entry — what was done, what was noticed, score, next move. Greg reads in the morning or drops in mid-run to check.
- **Push (notify-on-exception):** System-level notifications fire on: council convened, scope fence change proposed, tripwire triggered, budget ≥ 75% consumed, campaign terminated (done/abort/budget). Everything else stays silent.

Greg can inject directives mid-run by writing to `directive.md`. The orchestrator checks this file at the start of each iteration; content is appended to the next judge's prompt as a user note. No blocking needed — it's just additional curated input on the next orient call.

### Runtime

Orchestrator: long-lived TypeScript process spawned by `hive campaign start`, detaches, writes `pid` to campaign dir. Handles iteration dispatch, budget accounting, tripwire detection, inbox/notification.

Judgment: each per-iteration LLM call is a fresh `claude --print` with a curated prompt. The prompt has a **stable prefix** (identity + scorecard schema + judge rubric) for cache reuse, followed by **fresh fields** (prime, plan, scope fence, last N scorecard rows, current checkpoint, emergent log entries, budget state, any `directive.md` content). No context accumulates across iterations.

Executor: each iteration spawns the existing dispatch primitive (extended to accept `--worktree-path <existing>` rather than always creating a new one). Runs under the maya-executor agent as today. Exits after writing checkpoint.

### Campaign state on disk

```
~/.hive/campaigns/CAMP-001/
  prime.md                  # frozen: original goal, scope fence, tripwires, budget
  plan.md                   # mutable: current decomposition
  scope-fence.md            # explicit "will not" list
  emergent.md               # queued discoveries
  scorecard.jsonl           # append-only, one row per iteration
  inbox.md                  # running narrative for the human
  directive.md              # optional: mid-run human injection
  budget.json               # consumed vs granted (tokens, wallclock)
  status                    # running | paused | done | aborted | budget-exhausted
  pid                       # orchestrator PID
  workspace/                # shared worktree, campaign branch
  iterations/
    ITER-001/
      task.md               # what orchestrator asked executor to do
      checkpoint.md         # executor's structured self-report
      scorecard-row.json    # the judge's output for this iteration
      council.md            # optional: if convened
      judge-prompt.md       # what the judge saw (for debugging)
    ITER-002/ ...
```

### Command surface

**CLI (terminal):**

- `hive campaign start "<goal>"` — kick off a campaign. Flags: `--project`, `--scope-fence <file>`, `--council-on <tripwires>`, `--budget-tokens <n>`, `--budget-wall <duration>`, `--iteration-cap-tokens <n>`, `--iteration-cap-wall <duration>`.
- `hive campaign status <id>` — snapshot: current iteration, scorecard summary, budget state, last inbox entries.
- `hive campaign tail <id>` — stream the inbox.
- `hive campaign direct <id> "<directive>"` — append to `directive.md` for mid-run steering.
- `hive campaign stop <id>` — clean termination. Orchestrator writes final checkpoint, kills in-flight executor if any, updates status.
- `hive campaign resume <id>` — continue a paused campaign after a `pause-for-human` decision.
- `hive campaign list` — all campaigns and their status.

`hive dispatch` unchanged. Extended only to accept `--worktree-path` internally when called from an orchestrator.

**MCP tools (callable from inside any Claude Code session, including heartbeat):**

- `start_campaign` — mirrors `hive campaign start` args (goal, project, scope fence, tripwires, budgets). Returns campaign ID, inbox path, status file path.
- `campaign_status` — mirrors `hive campaign status`. Returns structured JSON (not text) for programmatic consumption.
- `campaign_tail` — returns the last N inbox entries.
- `direct_campaign` — appends to `directive.md`.
- `stop_campaign` — clean termination.
- `list_campaigns` — all campaigns across projects.
- `start_dispatch` — retroactively added. Mirrors `hive dispatch` args. Closes the gap where sessions currently shell out to the CLI, which has repeatedly hit shell-escaping bugs (e.g., TK-039: `${...}` in goal text triggering `set -u` under `bypassPermissions`).

MCP tools pass structured JSON, so goal text with `$`, backticks, quotes, and shell metacharacters travels safely — the historical failure class disappears for any caller that uses the MCP surface instead of Bash-invoking the CLI.

## Open Questions / Risks

- **The atom question.** Using a full `claude --print` dispatch as the per-iteration atom carries cold-start overhead (identity reload, filesystem re-read, session initialization). If iterations are short (5-15 min of actual work), that overhead may dominate. V1 ships this shape; we'll feel it out in production. V2 possibilities: long-lived executor with checkpoint signals, session-resume between iterations, or a lighter-weight executor mode.
- **Judge reliability.** The scorecard rubric is adversarial by design, but a judge that drifts toward sycophancy across a campaign is a known failure mode for single-LLM judges. Mitigation: trend-based council triggers, explicit uncertainty fields. Evidence of mitigation effectiveness will only come from real campaigns.
- **Scope fence enforcement.** "Human-gated" currently means "notification fires; orchestrator pauses." If Greg is asleep, a proposed fence change pauses the campaign until he wakes. This is probably correct but loses overnight momentum on fence-adjacent discoveries. Alternative: pre-declared "auto-approve if council unanimous" mode. Out of scope for V1.
- **Merge strategy.** V1: campaign commits accumulate on a campaign branch. Final merge to main happens on clean termination (human-gated). Mid-campaign rollback of a single iteration is not supported — the orchestrator operates append-only on commits. If an iteration was bad, the next iteration's task can be "revert commit X and redo." Imperfect but simple.
- **Budget granularity.** Token budgets are hard to enforce precisely mid-request (Claude Code doesn't expose mid-stream cutoffs). The soft cap is checked between tool calls. A single long tool call could blow past the soft cap by some amount before the check fires. Hard cap backstops this.
- **Observability during council.** Council calls are synchronous from the orchestrator's perspective. An iteration that triggers council adds minutes of wall-clock. Budget accounting needs to include council costs explicitly.

## V1 Scope

Ship the minimum that validates both thesis pillars — the orchestrator holds multi-iteration work against a frozen prime, AND clears real blocks via the toolkit:

- Orchestrator process (deterministic loop)
- Stateless judge calls with curated prompts
- Block detection + classification in judge rubric
- Unblocking toolkit — V1 ships: `research-memory`, `research-web`, `research-code`, `convene-council`, `try-different-approach`, `revert-and-retry`, `skip-and-continue`, `ask-human`. Defer `decompose-finer` and `retry-later` to V2 unless they fall out cheap.
- Escalation ladder with per-block tracking
- Campaign state on disk, exactly as specified
- CLI surface: `start`, `status`, `tail`, `stop`, `resume`, `list`, `direct`
- MCP tools: `start_campaign`, `campaign_status`, `campaign_tail`, `direct_campaign`, `stop_campaign`, `list_campaigns`, and retroactively `start_dispatch`
- Dispatch primitive extension: accept existing worktree path
- Inbox writes and macOS notifications via `osascript` (same as current dispatch)
- Two acceptance tests: (1) a multi-iteration campaign that holds prime directive across at least 3 phases, adapts plan between iterations, and completes cleanly; (2) a campaign that deliberately encounters at least one block, clears it via the toolkit, and completes.

## V2+ Possibilities

- Long-lived executor atom (address the atom concern)
- Unblocking toolkit expansion: `decompose-finer`, `retry-later` with scheduled wakes, custom per-project tools registered in config
- Auto-approve modes for low-risk scope-fence changes
- Mid-campaign iteration rollback
- Multi-project campaigns (cross-repo work)
- Richer tripwire DSL (regex on diffs, file-path globs, cost thresholds)
- Dashboard integration: live campaign view in the HIVE dashboard
- Pause-and-resume across machines (campaign state is already on disk; orchestrator process isn't)
- Block pattern library — recurring block signatures that map to known-good resolutions, written to memory over time
