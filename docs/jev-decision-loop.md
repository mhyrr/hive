# Jev Decision Loop — design brainstorm

Status: **exploration / spitball**. Nothing here is built. Written 2026-09-28.

## The gap

Every harness HIVE wraps (Claude Code, Codex, Pi, Cursor) has the same
loop: model → tools → model → … → *stop*. "Stop" is where the human
re-enters and makes the decision the agent can't: *now what?* Review it?
Ship it? It went sideways, redesign? Context is bloated, start fresh? Pick
the next ticket?

HIVE already has pieces of an autonomous outer loop:

- `docs/ralph-loop.md`: many short, fresh-context sessions ("context is a
  cache, not state").
- Watch Act (`watch-run.ts` → `act-run.ts`): picks a ticket, runs a detached
  `claude` in a worktree, then grades the exit with shell heuristics
  (commits + `plan.md` checkboxes → `review_ready|blocked|partial|failed`).
- `next.json` + `checkNextAvailability`: deterministic ticket eligibility.

What's missing is a **cheap, fast, typed decision at every stop point**.
That is exactly the shape of Jev.

## What Jev is (as far as we know)

The research below comes from search summaries only. Direct fetches were
blocked, so **verify these figures against docs.typesafe.ai before building.**

- TypeSafe AI's "System One" model. Launched Sep 15 2026 in waitlisted
  early access. Endpoint: `POST https://api.typesafe.ai/v1/systemone`,
  model `jev-latest`.
- Input: a `state` (text/JSON) plus a dict of named, typed `questions`:
  - `choice`: pick one of ≤255 options you define.
  - `noul`: a probability that a statement is true.
  - `score`: a rubric scale.
- Output: answers, probabilities, and confidence. **No rationale, no text
  generation.**
- 64k tokens total (state + all questions); 32k for state + the longest
  question. Irrelevant state hurts accuracy.
- ~70–500 ms per call; ~$0.04 per 1M input tokens, output free. A 30k-token
  decision costs about a tenth of a cent, so it's cheap enough to call on
  every turn.
- Known weaknesses:
  - One hard question scores worse than Haiku.
  - **Decomposing it into several narrow questions and combining them with
    fitted weights beats it by a lot.**
  - Choice answers are overconfident.
  - It reads text literally.
  - It is weak against prompt injection.

## Core design principle: Jev is a sensor, HIVE is the policy

Don't ask Jev one giant question ("what should we do next?") and obey it.
Instead:

1. **Deterministic signals first.** HIVE computes what is simply a fact:
   - context-window fill (from transcript `usage`);
   - iterations and cost so far;
   - git dirty/clean, commits since start, diff size;
   - last test/lint exit code;
   - PRD checkbox count;
   - ticket state.

   Never ask a model for something you can measure.
2. **Jev answers narrow semantic questions**, mostly `noul`, about the
   transcript tail. Examples:
   - "Did the agent claim the task is complete?"
   - "Is there evidence tests were run after the last code change?"
   - "Is the agent repeating a failed approach?"
   - "Did the agent express uncertainty about the design?"
   - "Is the agent blocked on information only a human has?"
   - "Did the work drift outside the ticket's scope?"
3. **Jev also casts one `choice` vote** over the action set. That vote is
   a feature, not a command.
4. **A small HIVE policy** (a decision table first, fitted weights later)
   combines 1–3 into an action. The policy enforces legal transitions and
   budgets, and escalates when confidence is low.

This follows the decomposition finding. It makes decisions explainable,
even though Jev gives no rationale: the log shows which signals fired. It
also keeps the provider swappable. A `Decider` interface can have a Jev
backend and a Haiku-with-JSON backend for users without Jev access.

## The action vocabulary

A lifecycle state machine, not a flat list. Jev's `choice` options are
**filtered to the legal transitions from the current phase**, which Jev
supports because options are defined per call.

| Action | Meaning | What HIVE does |
|---|---|---|
| `CONTINUE` | Not done; the plan is still valid | Inject "continue; next unchecked item is X" |
| `DESIGN` | No plan yet, or the approach is failing | Inject a planning prompt; write `plan.md` before code |
| `IMPLEMENT` | Design is settled | Inject "implement plan step N" |
| `VERIFY` | Claimed done without evidence | Inject "run tests/lint/typecheck and show output" |
| `FIX` | Checks are red | Inject the failure output plus "fix root cause" |
| `REVIEW` | Green, not yet reviewed | Run `/code-review` or a reviewer subagent, or a council call |
| `SIMPLIFY` | Review found cruft or the diff is bloated | Inject `/simplify` |
| `SHIP` | Green and reviewed | Commit, push, open PR (gated by autonomy) |
| `REPROMPT` | Context heavy at a natural checkpoint | Handoff → fresh session (see below) |
| `NEXT_TICKET` | Ticket done and shipped | Close ticket; pick the next one (see below) |
| `ASK_HUMAN` | Ambiguous, risky, low confidence, or stuck | Stop and surface why (inbox/notification) |
| `DONE` | Nothing left to do | Stop normally |

Legal-transition sketch:

```
DESIGN → IMPLEMENT → VERIFY ⇄ FIX → REVIEW → (SIMPLIFY → VERIFY)* → SHIP → NEXT_TICKET
   ↑___________ DESIGN (thrashing detected) ____________|
Any phase → REPROMPT | ASK_HUMAN | CONTINUE
```

Deterministic overrides take precedence over Jev's vote:

- Tests red → never `SHIP`.
- Budget exhausted → `ASK_HUMAN`.
- The same action 3× with no diff change → `DESIGN` or `ASK_HUMAN`.

## Two ways in (your "two kinds")

### Kind 1 — agent-initiated: "I don't know what to do"

A new MCP tool, `decide_next`, in `src/mcp-server.ts`. The agent calls it
when it is uncertain. HIVE builds the state from the session transcript
plus ticket plus git, asks Jev, applies the policy, and returns the action
plus the instruction text. It is cheap enough that the tool description can
say "call this whenever you're about to ask the user what to do next."

### Kind 2 — stop-triggered: "don't stop, decide"

Two mechanisms, because each harness exposes a different surface.

**A. In-session hook (keeps the conversation alive).**

- **Claude Code:** a `Stop` hook, installed by `hive init` next to the
  existing SessionStart/PostCompact wiring (`init.ts:196`).
  - The hook reads `transcript_path` from stdin and runs
    `hive decide --hook claude-stop`.
  - To keep going, it returns `{"decision":"block","reason":"<instruction>"}`.
    Claude treats the reason as its next instruction.
  - Guarded by `stop_hook_active` and a per-session budget file in
    `~/.hive/sessions/<id>/decisions.jsonl`.
- **Codex:** `hooks.json` already supports `Stop` (`codex-wire.ts:7`); add it
  in `installCodexIdentityHook`.
- **Pi:** add a turn-end/stop handler to the generated extension
  (`cli.ts:147`).
- **Cursor:** no hook surface, so the only option is B.
- Only active when HIVE launched the session (`HIVE_IDENTITY_IN_PROMPT` is
  already the tell), and only when the loop is opted in (`hive --loop`).
  Otherwise the hook exits 0 and nothing changes.

**B. Driver loop, `hive loop` (harness-agnostic; can clear context).**

This turns `ralph-loop.md` from a guide into a command. HIVE runs the
harness headless, one episode at a time:

- `claude -p --output-format stream-json`
- `codex exec`
- `pi -p`
- `cursor-agent -p`

Between episodes it calls the decider and then either:

- **resumes** the same session with the injected instruction
  (`claude --resume <id> -p "<instr>"`);
- starts a **fresh** session with a handoff prompt (`REPROMPT`);
- **switches ticket** (`NEXT_TICKET`); or
- **stops** (`ASK_HUMAN` / `DONE`).

This is the only way to do a true "clear and continue," and it works the
same across all four harnesses. The Watch Act executor (`act-run.ts`) is
essentially one episode of this already. `hive loop` generalizes it and
replaces the post-exit shell grading with the decider.

Recommendation: build **B first**. It covers every harness, supports
REPROMPT, and runs detached (the "human out" goal). Add A for Claude
afterwards, as the interactive "keep going while I watch" mode.

## REPROMPT: the context-reset move

- **Trigger:**
  - context fill > ~50% (deterministic, from transcript `usage`) **AND**
  - Jev `noul("agent is at a natural checkpoint: no half-finished edit,
    no pending tool result")` > threshold.

  Measure, then let Jev pick the *moment*.
- **Who writes the handoff:** the agent itself, because it has the context
  and Jev can't generate text. HIVE injects: "Write a handoff to
  `~/.hive/sessions/<id>/handoff.md`: goal, what's done (with commit
  SHAs), what's next, dead ends to avoid, open questions. Then stop."
- **Relaunch:** HIVE starts a fresh episode with identity, the ticket, the
  handoff, and `plan.md`. The PRD and git carry the state; the handoff
  carries the *judgment* ("don't try X again").
- Bonus: handoffs are high-signal input for the nightly memory pipeline
  (dead ends → reflections).

## NEXT_TICKET: Jev as reranker

1. The candidate set comes from `checkNextAvailability` / `getReadyTickets`.
   This deterministic filter stays; Jev never sees ineligible tickets.
2. Jev ranks the survivors. There are two options:
   - a single `choice` over ticket IDs (≤255), with state = "what we just
     did" + ticket titles/bodies; or
   - a per-ticket `noul("this ticket is a natural continuation of the
     work just completed")` alongside `score(priority/unblock value)`, used
     as a rerank.

   The per-ticket form is more robust and parallelizes in one call.
3. The result is written to `next.json` with `sourceWatch: "decider"`, and
   the existing disposition model applies: `recommended` under `propose`
   autonomy, `started` under `act`.
4. Watch Act's model call for selection could switch to this too. It's
   ~1000× cheaper, so the hourly watch could become per-event.

## State building: fit 32k tokens, keep it relevant

"As much context as possible" is the wrong target, because Jev degrades
with irrelevant state. The builder (`decide-state.ts`, reusing
`transcript.ts` parsers + `sessions.ts` redaction) assembles:

- the ticket title and body, plus `plan.md` with checkbox state;
- deterministic facts as a compact JSON block;
- the last N assistant messages and tool results, newest first, truncated
  to the budget;
- `git diff --stat` and the last test output tail;
- the decision history for this session (last 5 actions), for anti-loop
  context.

## Safety rails

- **Budgets:** max decisions, max wall-clock, max cost per loop; each
  ends in `ASK_HUMAN`.
- **Autonomy ceiling:** reuse `watches.max_autonomy`. `SHIP` and
  `NEXT_TICKET`-start need `act`; under `propose` they become inbox
  items.
- **Confidence floor:** Jev's choice answers are overconfident, so the
  threshold should be high and the decision should require agreement
  between the vote and the policy. Disagreement → `ASK_HUMAN`.
- **Injection:** the state contains tool output (web pages, file contents).
  The action set is closed, and no action is destructive on its own; SHIP
  goes through existing gates. The worst case is a wasted iteration.
- **Fail closed to a human:** if Jev is down, a decision times out, or the
  key is missing, the stop simply happens. No silent fallback to another
  provider (same ethos as the Auth section of CLAUDE.md). Haiku as a
  backend is an explicit config choice, not an automatic fallback.
- **Audit:** every decision goes to `decisions.jsonl` with state hash,
  signals, Jev answers, policy verdict, and action. This compensates for
  Jev having no rationale.

## Rollout: shadow → propose → act

1. **Shadow.** The Stop hook calls the decider and logs, but always allows
   the stop. The dashboard shows "Jev would have said: REVIEW (0.91)". You
   thumbs-up/down it; that is the labelled dataset.
2. **Fit.** Once there are a few hundred labels, fit per-signal weights
   (a logistic regression over the `noul` features). This is the
   decomposition trick that took the reported phishing benchmark from 63%
   to 95%. It could run in the nightly pipeline.
3. **Propose.** Decisions become suggestions in the inbox or on the
   dashboard.
4. **Act.** `hive loop` executes them within budgets.

## Rough module map

| New | Role |
|---|---|
| `src/lib/jev.ts` | HTTP driver (fetch, like `callOllama`); `TYPESAFE_API_KEY` |
| `src/lib/decider.ts` | `Decider` interface; Jev + Claude-JSON backends; question battery; policy table |
| `src/lib/decide-state.ts` | State builder from transcript / git / ticket / plan |
| `src/commands/decide.ts` | `hive decide [--hook claude-stop\|codex-stop] [--session <id>]` |
| `src/commands/loop.ts` | `hive loop [--ticket TK-N] [-x\|-3\|-a]` episode driver |
| `mcp-server.ts` | `decide_next` tool |
| `init.ts` / `codex-wire.ts` / Pi extension | Stop-hook wiring (opt-in) |

## Open questions

- **Access:** is there a TypeSafe early-access key? If not, prototype the
  whole loop on the Haiku backend. The policy and signals are the real IP;
  Jev is a cost/latency upgrade.
- Should `REVIEW` route to a council (multi-model) review when the diff is
  large? That's cheap to decide, expensive to run.
- One decider per loop, or should the Watch system own it (a "session
  watch" with scope `transcripts` firing on stop events rather than a
  cadence)? This would fold the design into existing concepts nicely.
- The action vocabulary above is a first guess. Shadow-mode logs will show
  which labels you actually reach for.
