# Jev Decision Loop — design brainstorm

Status: **exploration / spitball**. Nothing here is built.
Revision 2 (2026-09-28): Jev is **the** decision engine. Revision 1 treated
it as a signal source under a HIVE rule layer, which had the relationship
backwards.

## The idea in one picture

```
            ┌──────────────── HIVE ────────────────┐
 session ──▶│ assemble STATE (facts only)           │
 ticket  ──▶│   goal, plan, transcript tail,        │
 git     ──▶│   repo/test facts, context %, history │
 memory  ──▶│                                       │
            └───────────────┬───────────────────────┘
                            ▼
            ┌──────────────── JEV ─────────────────┐
            │ question: next_action (choice)        │
            │ options:  REPROMPT, IMPLEMENT, FIX,   │
            │           REVIEW, SHIP, … , UNSURE    │
            └───────────────┬───────────────────────┘
                            ▼
      { choice: "REVIEW", confidence: .93,
        probabilities: { REVIEW:.81, FIX:.07, SHIP:.05, … } }
                            ▼
            ┌──────────────── HIVE ────────────────┐
            │ dispatch[choice](): carry on the work │
            └───────────────────────────────────────┘
```

HIVE gathers context and executes. Jev decides. Jev's output is a
probability distribution over a fixed menu of next moves, and nothing
more.

This matches TypeSafe's own guidance: *"Keep facts in state and judgments
in questions."* All of HIVE's accumulated context is the facts, and "what
next?" is the judgment. It is also how Pydantic AI's `TypeSafeModel`
already uses Jev inside an agent loop: each step is one route choice over
the available tools and outputs.

## What Jev gives us

The research used search summaries only, because docs fetches were
blocked. **Verify these points against docs.typesafe.ai before building.**

- **Access:** through OpenRouter with a normal OpenRouter API key (the
  obvious path), or TypeSafe's own waitlisted API.
- `POST /v1/systemone` takes a `state` and a dict of typed `questions`.
- **Choice question:** `instructions` (string or object) plus an option map
  `{ KEY: "description / rubric" }`, with up to 255 options. **Option
  descriptions are the main tuning knob.** There's no few-shot or
  fine-tuning, so the definitions are where HIVE's taste lives.
- **State:** a string, object, or array. TypeSafe recommends an object with
  descriptive keys, referenced by name (in backticks) from the
  instructions.
- **Answer:** `choice`, `confidence` (a separate axis: "should I act on
  this?"), and the full `probabilities` map. There is no rationale.
- Limits: 32k tokens for state plus the longest question (the one that
  bites) and 64k total.
- Speed and cost: ~70–500 ms, ~$0.04 per 1M input tokens, output free.
  One decision on a full 30k state costs about a tenth of a cent.
- **Multiple questions** in one request share one forward pass, so they
  are nearly free, but they are **independent**: one can't condition on
  another's answer. Dependent decisions need a second call.
- **It never abstains on its own.** Without an "other/unsure" option it
  forces a pick. Always include one.
- **Known quirk:** Pydantic AI found Jev tends to re-pick a route whose
  result is already in the history. Our state design has to account for
  this (see Decision history below).

## The decision call

### Question

```jsonc
{
  "next_action": {
    "type": "choice",
    "instructions": "An autonomous coding agent working on `goal` has just reached a stopping point. Given `plan`, `session_tail`, `repo`, `metrics` and `decision_history`, choose what the agent should do next.",
    "options": {
      "CONTINUE":   "The current plan step is partly done and the agent was interrupted or stopped early; keep going on the same step.",
      "DESIGN":     "There is no concrete plan yet, OR the approach has failed repeatedly, OR the agent voiced doubt about the architecture. Stop coding and produce/redo a plan.",
      "IMPLEMENT":  "A plan exists and has unchecked steps; the next step is clear and not started.",
      "VERIFY":     "Code changed since tests/lint/typecheck last ran, or the agent claimed success without showing passing output.",
      "FIX":        "The most recent checks failed or an error is unresolved.",
      "REVIEW":     "Checks pass on the latest change and the diff has not been reviewed yet.",
      "SIMPLIFY":   "A review happened and flagged duplication, dead code, or over-engineering that hasn't been addressed.",
      "SHIP":       "Checks pass, review is done and addressed, and the plan is complete; commit, push, open PR.",
      "REPROMPT":   "Context is heavily used (see `metrics.context_used_pct`) and the work is at a clean checkpoint; hand off and start a fresh session.",
      "NEXT_TICKET":"The ticket in `goal` is shipped or closed; move on to other work.",
      "ASK_HUMAN":  "Progress requires a decision, credential, or information only the human has, or the agent is going in circles.",
      "DONE":       "Everything requested is finished and nothing further is warranted.",
      "UNSURE":     "The state does not clearly support any option above."
    }
  }
}
```

The menu is a first draft and will evolve; the option text *is* the
design. Tuning is done by editing descriptions, which is a HIVE-level
artifact (`~/.hive/decider/options.md`). That lets taste and memory shape
it over time.

### State

A single object that fits the 32k budget. Facts only, no judgments:

```jsonc
{
  "goal":            "TK-142: add rate limiting to auth endpoints\n<ticket body>",
  "plan":            "- [x] middleware\n- [x] tests\n- [ ] docs",   // plan.md, if any
  "session_tail":    [ /* last N assistant msgs + tool results, newest last, truncated */ ],
  "repo": {
    "branch": "hive/act/…", "dirty": true, "diff_stat": "4 files, +120 −8",
    "commits_since_start": 3,
    "last_check": { "cmd": "bun test", "exit": 0, "ran_after_last_edit": true, "tail": "…" }
  },
  "metrics": { "context_used_pct": 62, "turns": 41, "elapsed_min": 38 },
  "decision_history": [ { "action": "IMPLEMENT", "at_turn": 12 }, { "action": "VERIFY", "at_turn": 30 } ],
  "project_conventions": "<short excerpt from HIVE project memory>"
}
```

- Deterministic values such as `context_used_pct` (from transcript
  `usage`), test exit codes, and diff stats go **into the state as
  facts**. Jev weighs them; HIVE doesn't pre-decide from them.
- **Decision history** is in the state so Jev can see "we already reviewed
  once." It also counters the re-pick quirk: the option descriptions are
  phrased as preconditions ("…and the diff has not been reviewed yet"), so
  a completed action no longer matches.
- The transcript tail is where most of the budget goes. Newest messages
  win, and tool output gets truncated harder than assistant prose.

### Reading the answer

The distribution is the decision; HIVE only decides whether to trust it:

- `confidence` ≥ threshold and top-2 margin ≥ threshold → **dispatch the
  choice.**
- Otherwise, or if the choice is `UNSURE` → treat it as `ASK_HUMAN`. The
  notification includes the top-3 probabilities: "Jev is torn:
  REVIEW 0.48 / FIX 0.41."

The thresholds start conservative, because choice confidence was measured
as overconfident, and get tuned from logs.

## What HIVE does with each choice

Each executor is a small function. "Inject" means HIVE feeds the next
instruction into the running session; "restart" means a fresh session.

| Choice | HIVE carries on by… |
|---|---|
| CONTINUE | Inject "continue the current step" |
| DESIGN | Inject a planning prompt: write/replace `plan.md`, no code yet |
| IMPLEMENT | Inject "implement the next unchecked plan step" |
| VERIFY | Inject "run the project's checks and show the output" |
| FIX | Inject the failing output with "find and fix the root cause" |
| REVIEW | Inject `/code-review`, or run a reviewer/council pass and inject its findings |
| SIMPLIFY | Inject `/simplify` |
| SHIP | Commit, push, and open a PR, gated by HIVE autonomy (`propose` → inbox item instead) |
| REPROMPT | Inject "write a handoff to `…/handoff.md`", then **restart** with identity + goal + plan + handoff |
| NEXT_TICKET | Close the ticket, make a **second Jev call** to pick the ticket (below), then **restart** on it |
| ASK_HUMAN / UNSURE | Stop and notify with the distribution and the state snapshot |
| DONE | Stop |

After every executor finishes, the session reaches its next stop, and
the loop repeats.

### Follow-up calls (because questions are independent)

- **NEXT_TICKET → which ticket.** This is a second call.
  - State: what was just finished, plus the eligible tickets, filtered by
    `checkNextAvailability` (id, title, first lines of the body).
  - Question: `choice` over the ticket IDs (up to 255), with the ticket
    summaries as option descriptions.
  - The result goes to `next.json`, where the existing
    recommended/started disposition applies.
- Any other "which one" pick after an action works the same way. For
  example: which reviewer to use, or whether to send a REVIEW to council.

## Where the call happens (your two kinds)

1. **"I don't know what to do"**: an MCP tool, `decide_next`. The agent
   calls it itself. HIVE builds the state from that session's transcript,
   runs the Jev call, and returns the choice plus the executor's
   instruction text.
2. **"I'm about to stop"**: every stop triggers a decision.
   - **`hive loop` (build first).** It runs the harness headless, one
     episode at a time: `claude -p`, `codex exec`, `pi -p`,
     `cursor-agent -p`. At each episode end it calls Jev, then either
     resumes with the injected instruction or restarts fresh (REPROMPT,
     NEXT_TICKET). This works for every harness, is the only way to
     actually clear context, and generalizes the Watch Act executor
     (`act-run.ts`), whose shell-heuristic grading Jev replaces.
   - **In-session Stop hook (interactive mode).** A Claude Code `Stop` hook
     returns `{"decision":"block","reason":"<executor instruction>"}` so
     the session keeps going. Codex's `Stop` hook and a Pi extension
     handler work the same way. Actions that need a restart end the
     session and hand off to `hive loop`. This is opt-in, only for
     sessions HIVE launched.

## Guardrails (around the loop, not around Jev's judgment)

- **Budgets:** max decisions, max wall-clock, and max spend per loop.
  Hitting one means stop and notify.
- **Autonomy ceiling:** reuse `watches.max_autonomy`. SHIP and
  starting the next ticket need `act`.
- **Hard authorization:** Jev picks the action, but irreversible side
  effects (push, PR, ticket close) still go through HIVE's existing gates.
  TypeSafe's own guidance is that authorization rules apply whatever the
  probability says.
- **Fail closed:** if Jev is unreachable, the key is missing, or the
  response is malformed, the session stops normally and you're notified.
  No silent fallback to another model (the Auth ethos in CLAUDE.md).
- **Audit:** `~/.hive/sessions/<id>/decisions.jsonl` records the state
  hash, the full distribution, confidence, the action taken, and the
  outcome.

## Rollout

1. **Shadow.** The Stop hook calls Jev on your normal interactive
   sessions and logs "Jev would pick REVIEW (0.81)" without acting. The
   dashboard lets you mark each one right or wrong, or give the right
   answer.
2. **Tune.** Where Jev is wrong, rewrite option descriptions and state
   shape. There are no weights to train; the menu *is* the model's
   configuration. A nightly pass could suggest description edits from
   the disagreements.
3. **Propose.** Decisions surface as one-click suggestions.
4. **Act.** `hive loop` runs detached within budgets.

## Prior art: Jev in coding harnesses (Sep 2026)

These came from search summaries. The authors' numbers are unverified.

| Pattern | Examples | Decision | Takeaway for HIVE |
|---|---|---|---|
| Stop-time "really done?" gate | jev-belay, jev-claude, cc-jev-teacher | 4 yes/no (noul) questions on the transcript since the last prompt; block with a reason if the "done" is unverified | Most mature pattern. jev-belay reports AUROC 0.976. It pre-filters with regex, so only 17.7% of stops reach Jev, and it lets the stop through on any error. |
| Ralph loop plus a Jev judge | ralph-jev, ralph-jev-gauntlet | On a "done" claim, pass/fail on workspace evidence; a fail feeds the reason into the next fresh iteration | Closest to `hive loop`, but pass/fail only |
| Next-step choice | jev-mcp `jev_next_step` | `continue / retry / change_approach / ask_user / done` | Closest to our menu. Keeps `done` only if a second completion question is confidently yes; turns `retry` into `change_approach` after N tries |
| Per-step choice with fan-out | agent-browser loop | Action choice **plus speculative follow-up choices in the same call** | Removes our second call (see below) |
| Tool-call risk gate | jev-guard, jev-auto-approve, OpenRouter cookbook | `deny / ask / allow` (+ `user_requested`, `from_untrusted`) | The most common use of all. Handle obvious cases in code instead of calling Jev on every tool call |
| Model / subagent routing | jev-router (×3), jev-claude-code, jev-agent-hooks | Haiku / Sonnet / Opus per turn or subagent | Shadow mode by default (weiping). **Near-duplicate labels split probability** |
| Compaction | fast-jev-compaction | Keep or drop each tool result | Criticized publicly: judging items one at a time makes agents forget and loop, and it breaks caching. A handoff-based REPROMPT is the safer route |
| PR / CI / issue triage | jevtriage, CI-failure classes, issue bots | `ready/needs_review/risky`; `real_failure/flaky_test/infrastructure/base_branch/process_check` | Ready-made menus for later sub-decisions |

Nobody found so far uses Jev as a **full lifecycle next-action engine**.
The existing tools are single gates or a 5-label step choice.

### Design changes from this research

1. **Speculative fan-out in one call.** Send `next_action` together with
   the follow-up choices that depend on it: `next_ticket` over eligible
   tickets, `review_kind` (self / subagent / council), `ci_failure_class`.
   The questions are independent, so each follow-up is phrased with its
   premise: "*If* the agent moves to another ticket, which one?". HIVE
   uses only the follow-up that matches the winning action. This is
   one call, not two.
2. **Double confirmation for terminal moves, still decided by Jev.**
   `DONE` / `SHIP` / `NEXT_TICKET` also require a confidently-true
   `verified_complete` noul in the same call. This is the jev-belay and
   `jev_next_step` pattern: Jev still makes the call, it just has to
   agree with itself.
3. **Tighten the menu.** Near-duplicate options split probability, so
   the current draft needs trimming. Candidate merges:
   - CONTINUE + IMPLEMENT
   - ASK_HUMAN + UNSURE
   - REVIEW → SIMPLIFY handled as a review follow-up
   - DONE vs NEXT_TICKET decided by whether ready tickets exist

   Aim for ~8 sharply distinct options.
4. **Expect lots of escalation at first.** In a 149-row comparison with
   Haiku, Jev triggered escalation on 34.7% of rows against 2.7% for
   Haiku. Shadow mode is how to tune the thresholds.
5. **One hook for two harnesses.** Codex Stop and PostToolUse hooks take
   the same input and output shapes as Claude Code's, so the Stop hook
   can serve both.
6. **Cheapest first milestone:** a jev-belay-style "verified done?" Stop
   gate in HIVE. It's small, proven, and exercises the whole path
   (transcript → state → Jev → block with a reason) before building the
   full menu.

## Module sketch

| New | Role |
|---|---|
| `src/lib/jev.ts` | HTTP driver (fetch, like `callOllama`); OpenRouter by default (`OPENROUTER_API_KEY`), optional direct TypeSafe (`TYPESAFE_API_KEY`) |
| `src/lib/decide-state.ts` | Builds the state object from `transcript.ts`, git, ticket, plan, and memory |
| `src/lib/decider.ts` | Loads the option menu, calls Jev, applies the confidence gate, logs |
| `src/lib/decide-actions.ts` | The dispatch table: one executor per choice |
| `src/commands/loop.ts` | `hive loop [--ticket TK-N] [-x\|-3\|-a]` |
| `src/commands/decide.ts` | `hive decide --hook claude-stop` (and shadow mode) |
| `mcp-server.ts` | `decide_next` tool |

## Open questions

- **Access: settled. Go through OpenRouter.** Direct TypeSafe access is
  waitlisted, but Jev is available on OpenRouter with an ordinary
  OpenRouter key (OpenRouter's cookbook even has a Jev auto-approve
  recipe). The driver targets OpenRouter first; direct
  `api.typesafe.ai` is an optional second endpoint behind the same
  interface. Still to confirm: whether OpenRouter passes the native
  typed `state`/`questions` request and `probabilities` response through
  unchanged, or wraps Jev in its chat-completions shape.
- **Menu granularity.** Is it one flat menu, or a menu that changes with
  phase (e.g. no SHIP offered while the plan is unfinished)? A flat menu
  is simpler and lets Jev see everything. Phase-filtered is safer, but
  that puts HIVE judgment back into the loop.
- **Should REVIEW be its own sub-decision** (self-review vs. subagent vs.
  council)? That would be a second choice call when REVIEW wins.
- **Should the session-level loop be a Watch?** A "session watch" whose
  venue is a Jev decision and whose trigger is a stop event would fold
  this into existing concepts.
