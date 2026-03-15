# HIVE Overnight Launch Design

## The Goal

You should be able to say:

```
hive dream "build a CLI tool that watches a git repo and posts a Slack digest on push"
```

Go to sleep. Wake up to a working repo, tests, a README, and a plan for next steps.

This document describes what's missing between the current HIVE architecture
and that capability, and how to close the gap.

---

## What We Already Have

Phase 4 and Phase 5 are complete. The pieces that matter:

- **Supervisor loop** (`hive supervise`): detached, file-backed, crash-safe,
  parallel workers, one-run-per-assignment safety
- **Board + message model**: steward assigns, supervisor launches, workers report
- **Persistent steward**: live Pi-backed session with delta awareness
- **Multi-runtime support**: claude, codex, gemini adapters all wired
- **Gateway**: web UI, WebSocket feed, REST API
- **Scope conflict detection**: workers don't stomp on each other

The coordination skeleton is real. The overnight loop already runs. What is
missing is not infrastructure — it is the entry point, the routing, and the
synthesis.

---

## The Three Gaps

### 1. Intent → Plan (missing entirely)

Right now, a human writes PLAN.md and BOARD.md by hand. There is no automated
path from "here is a vague idea" to "here is a structured, executable plan with
assigned agents and scopes."

The overnight launch collapses if this doesn't exist. You cannot delegate a
task that hasn't been decomposed.

### 2. Model Routing (partial)

Agents have configured runtimes, but all tasks on a given agent go to the same
model. There's no task-type aware routing: "use Opus for architecture, Sonnet
for implementation, Haiku for verification."

The current model is: one agent → one runtime → one model for everything.
The needed model is: task characteristics → model selection → agent assignment.

### 3. Synthesis (missing)

Workers produce file changes. No agent currently reads those changes across
multiple tasks and produces a coherent output: a unified README, a release
checklist, a "here's what was built and what to do next" summary.

Without synthesis, an overnight run produces a pile of commits. That's
different from a product.

---

## The Design

### Entry Point: `hive dream`

A new front-door command that takes an unstructured goal and hands it to a
dedicated **planner** agent.

```bash
hive dream "build a CLI tool that watches a git repo and posts a Slack digest on push"
hive dream --from file.md    # read goal from file
hive dream --interactive     # iteratively refine before launching
```

`hive dream` does three things:

1. Bootstraps a new project directory (or uses the active one)
2. Runs a one-shot planner pass to produce PLAN.md + initial BOARD.md entries
3. Emits a `nudge` to the orchestrator and starts supervision

The planner produces structured output, not prose. It must emit valid BOARD.md
task rows and assignment messages with `launch: auto`. If it produces
ambiguous output, dream should surface that before launching.

**Planner persona**: not a generalist. Opinionated decomposer. Its job is to
identify 4–8 parallelizable work units, assign them to typed agents, and
specify scope. It should also identify the synthesis deliverable upfront:
what does "done" look like?

### Typed Agents + Model Routing

The current model has fixed agents with fixed runtimes. For overnight work,
we need two changes:

**1. Task type tags**

Each board task gets a type: `arch`, `impl`, `test`, `review`, `doc`, `ops`.
The planner assigns these. The supervisor uses them to select the right agent
configuration.

**2. Capability profiles in project-config**

```md
## Agent Profiles
- architect | runtime: claude | model: claude-opus-4-6 | types: arch,review
- alpha     | runtime: claude | model: claude-sonnet-4-6 | types: impl,doc
- beta      | runtime: codex  | model: gpt-5-codex | types: impl,test
- gamma     | runtime: claude | model: claude-sonnet-4-6 | types: test,review
```

When the planner assigns a task, it picks from the profile list by type.
When two tasks have the same type, they go to different agents if non-conflicting.

This doesn't require redesigning the supervisor loop. Profiles are config.
The assignment message already carries `agent:` — the planner populates it
based on profiles.

### Synthesis Pass

After all board tasks are done, a **synthesizer** agent runs:

1. Reads all completed task result.md files
2. Reads the current repo state (changed files, git log)
3. Produces the synthesis deliverable defined at plan time

Synthesis deliverables are explicit:
- `readme`: update README with what was built
- `handoff`: a human-facing summary of what was done and what's left
- `release-prep`: CHANGELOG, release notes, version bump
- `brief`: a short paragraph suitable for a Slack/email update

The synthesizer is triggered by the supervisor when:
- all board tasks are done
- the synthesis task is still open

It is just another agent with a specific role. Not a special code path.

### Stale Goal Detection

Overnight runs fail silently if an agent gets stuck. Currently: the board
says active, but the process is hanging or looping.

Add to the supervisor: **task timeout with escalation**.

If a task has been active for more than `N` minutes (configurable, default 30):
- mark it stale
- emit a feed event
- trigger steward reassessment with the stale context

The steward decides: retry, reassign, or escalate to human inbox.

This is a small addition to the supervisor loop. The supervisor already reads
run state; it just needs to check timestamps.

---

## The Full Overnight Loop

```
hive dream "idea"
    │
    ▼
Planner pass
    │ produces PLAN.md, BOARD.md, assignment messages (launch: auto)
    ▼
hive supervise (detached)
    │
    ├── orchestrator reassessment pass
    │       reads board, reads messages, assigns workers
    │
    ├── workers run in parallel (scope-safe)
    │       impl tasks, test tasks, doc tasks
    │       each exits and leaves result.md
    │
    ├── orchestrator reassessment (after workers exit)
    │       reviews results, closes assignments, identifies gaps
    │       may spawn follow-up tasks
    │
    └── synthesizer pass (when board is clean)
            reads all result.md files
            reads repo state
            writes synthesis deliverable
            emits feed event: "overnight run complete"
```

You wake up, run `hive ask` or open the gateway, and see the summary.

---

## What's Actually Hard

**Planner output quality.** If the planner produces bad task decomposition or
ambiguous scope assignments, the overnight run produces garbage confidently.
The planner needs tight output constraints and validation before launching.

Recommended: `hive dream --dry-run` shows the proposed plan without launching.
You review, iterate, then `hive dream --go`.

**Non-deterministic agents.** Workers may produce conflicting changes even
with scope separation. The synthesizer needs to detect and surface conflicts,
not paper over them.

**The goal of "launch overnight"** implicitly requires external actions:
create a repo, push code, buy a domain, call an API. Those all require the
trust ladder (already designed in HIVE-TRUST-LADDER.md). Overnight launch
without trust gates is a bad idea. The loop should know which actions require
human approval and pause, not proceed blindly.

---

## Implementation Order

1. **Planner agent + `hive dream` entry point**
   - New persona: `planner.md`
   - New command: `src/commands/dream.ts`
   - Validates output format before launching
   - `--dry-run` mode first

2. **Capability profiles in project-config**
   - Add `## Agent Profiles` section to template
   - Planner reads profiles to assign agents
   - Supervisor reads profiles to select model/runtime per launch

3. **Task timeout + stale detection in supervisor**
   - Small addition to supervisor tick
   - Steward reassessment gets stale task context

4. **Synthesizer persona + synthesis task**
   - New persona: `synthesizer.md`
   - Standard board task, supervisor triggers it when board is otherwise clean
   - Supports 4 deliverable types initially

5. **`hive dream --interactive`**
   - Iterative refinement before commit
   - Lower priority but important for trust

---

## What This Is Not

This is not a framework. There is no new runtime, no plugin system, no
agent-to-agent API.

Every piece of this runs through the existing file-backed coordination model:
- planner writes PLAN.md and BOARD.md
- supervisor reads those and launches workers
- synthesizer reads result.md files and writes a deliverable
- everything is inspectable on disk at any point

The overnight loop is the existing loop, with better entry points and
better terminal behavior.

---

## Relation To openclaw / Devin-style Systems

The difference between hive and agent-to-agent frameworks:

- **Them**: agents coordinate by calling each other, sharing context via
  memory stores or API, often ephemeral
- **HIVE**: agents coordinate through shared files on disk, with a supervisor
  that doesn't think — it just reads files and launches processes

The HIVE model is slower to bootstrap but more resilient: you can kill the
process at any time, restart, and pick up where you left off. The files
survive. The reasoning doesn't have to.

The overnight launch goal doesn't require abandoning that. It just requires
making the entry point and the terminal conditions as clear as the middle.
