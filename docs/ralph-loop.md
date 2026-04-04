# The Ralph Loop: Autonomous Coding Agents with Claude Code

A practical guide to running many short, focused coding agent sessions
instead of one long marathon. Named after Felix von Leitner's `ralphy`
script, which pioneered the pattern.

---

## The Core Idea

Long coding agent sessions degrade. The context window fills with stale
reasoning, failed approaches, and accumulated drift. By hour two, the
agent is working against its own history as much as the actual problem.

The Ralph loop inverts this: instead of one session that runs until it
finishes (or gives up), run many short sessions from fresh context. Each
one reads the current state from files and git, does one chunk of work,
commits, and exits. The next session picks up where the last left off —
not from memory, but from disk.

The key insight, from Felix: **"Context is a cache, not state."** If the
agent can't reconstruct its situation from files alone, the architecture
has a single point of failure.

### Why It Works

1. **Fresh context every iteration.** No accumulated confusion, no
   zombie reasoning from three attempts ago.
2. **Crash-tolerant.** If the agent stalls or hallucinates, kill it and
   restart. The committed work survives. The bad reasoning doesn't.
3. **Observable.** Each session produces a discrete commit. You can watch
   progress in `git log`, not just hope the agent is making headway.
4. **Composable.** Run multiple loops in parallel on different tasks,
   each in its own worktree.

### The Original Pattern

Felix's `ralphy` script:
1. Launches a coding agent with a PRD (a markdown checklist)
2. Monitors for stalls, crashes, or false completion claims
3. Kills and restarts with a fresh context when things go wrong
4. Validates completion by checking if all PRD checkboxes are ticked
5. Runs in tmux for persistence with heartbeat monitoring

Everything below translates this into Claude Code's native features.

---

## Step 1: Write a Good PRD

The PRD (Product Requirements Document) is the only thing that persists
across sessions. It's the agent's mission briefing, validation checklist,
and progress tracker in one file. A bad PRD produces bad loops.

### What Makes a Good Agent PRD

**Machine-readable progress tracking.** Use markdown checkboxes. The
agent checks them off as it works. A monitor script can validate
completion by parsing the file.

```markdown
# Auth System PRD

## Context
Phoenix API (Elixir), PostgreSQL, API-only (no sessions).
See `lib/myapp/accounts/` for existing user schema.

## Requirements
- [ ] JWT middleware in `lib/myapp_web/plugs/auth.ex`
- [ ] Login endpoint: POST /api/auth/login → returns JWT
- [ ] Registration endpoint: POST /api/auth/register
- [ ] Token refresh endpoint: POST /api/auth/refresh
- [ ] Rate limiting on auth endpoints (5/min per IP)
- [ ] Tests for all endpoints (happy path + error cases)

## Constraints
- Use Joken for JWT (not Guardian — API-only app, Guardian is overkill)
- Argon2 for password hashing
- Tokens expire in 1 hour, refresh tokens in 7 days
- Follow existing error response format in `lib/myapp_web/fallback_controller.ex`

## Out of Scope
- OAuth/social login
- Email verification (separate ticket)
- Admin endpoints
```

### PRD Principles

**Be specific about files and paths.** "Add auth middleware" is vague.
"JWT middleware in `lib/myapp_web/plugs/auth.ex`" is actionable. The
agent shouldn't have to guess where things go.

**State constraints, not just requirements.** The agent needs to know
what it *can't* do as much as what it should. "Use Joken, not Guardian"
prevents a common wrong turn. "Follow existing error response format in
X" prevents a new pattern from emerging.

**Include context the agent will need.** Point to relevant existing
files. Name the tech stack. If there's a pattern it should follow,
reference where that pattern lives. The agent starts fresh every
iteration — it only knows what the PRD and the codebase tell it.

**Define "done" explicitly.** Each checkbox is a completion criterion.
When all boxes are checked, the work is done. No ambiguity, no judgment
calls about "good enough."

**Scope to what one agent can do.** A PRD that requires understanding
three interconnected systems across 50 files is too big. Break it into
smaller PRDs. Each loop iteration should be able to make meaningful
progress on a single checkbox.

**Declare out-of-scope items.** Agents are eager. Without boundaries,
they'll "improve" adjacent code, add features you didn't ask for, or
refactor things that work fine. The out-of-scope section is a fence.

### PRD Anti-Patterns

| Pattern | Problem |
|---------|---------|
| "Make the auth system work" | No checkboxes, no way to validate completion |
| Checkboxes with no file paths | Agent guesses structure, creates inconsistencies |
| 20+ checkboxes | Too much scope for short sessions — break into multiple PRDs |
| No constraints section | Agent makes its own technology choices (often wrong) |
| Mixing implementation and design | The PRD is for *what*, not *how* — let the agent figure out implementation |

---

## Step 2: Set Up Worktree Isolation

Each Ralph loop should run in an isolated git worktree. This gives you:
- A separate working directory (no file conflicts with your main checkout)
- A dedicated branch (clean commits, easy to review or discard)
- Safe parallel execution (multiple loops on different tasks)

### Manual Worktree Setup

```bash
# Create a worktree for the auth feature
git worktree add .worktrees/auth -b ralph/auth

# Run the agent in that worktree
cd .worktrees/auth
claude -p "$(cat PRD-auth.md)" --allowedTools "Bash,Read,Write,Edit,Glob,Grep"

# When done, review and merge
cd ../..
git checkout main
git merge ralph/auth
git worktree remove .worktrees/auth
```

### Using Claude Code's Built-In Worktrees

Claude Code has native worktree support. Use the `--worktree` flag:

```bash
# Claude creates the worktree, runs in it, and reports back
claude --worktree auth-feature -p "$(cat PRD-auth.md)"
```

Or define an agent with `isolation: worktree` in its frontmatter:

```yaml
---
name: ralph-coder
description: Implementation agent for Ralph loop sessions
tools: Read, Write, Edit, Glob, Grep, Bash
isolation: worktree
maxTurns: 50
---

You are implementing a feature defined by a PRD. Read the PRD first.
Work through unchecked items one at a time. Check off each box as you
complete it. Commit after each meaningful chunk of work.

If you're stuck on an item after two honest attempts, leave a comment
in the PRD explaining what's blocking you, and move to the next item.
```

Put this in `.claude/agents/ralph-coder.md` and invoke it:

```bash
claude --agent ralph-coder "Implement PRD-auth.md"
```

The agent runs in an isolated worktree automatically. When it finishes,
the worktree and branch are available for review.

### Parallel Loops

Run multiple Ralph loops simultaneously, each on a different task:

```bash
# Terminal 1
claude --agent ralph-coder "Implement PRD-auth.md"

# Terminal 2
claude --agent ralph-coder "Implement PRD-notifications.md"

# Terminal 3
claude --agent ralph-coder "Implement PRD-search.md"
```

Each gets its own worktree and branch. No conflicts. Review and merge
independently when each finishes.

---

## Step 3: The Loop Script

The core Ralph loop: run the agent, check if it's done, restart if not.

### Simple Loop (bash)

```bash
#!/bin/bash
# ralph.sh — run a Ralph loop until the PRD is complete
set -euo pipefail

PRD="$1"
AGENT="${2:-ralph-coder}"
MAX_ITERATIONS="${3:-10}"
ITERATION=0

check_completion() {
  # Count unchecked boxes in the PRD
  local unchecked
  unchecked=$(grep -c '^\s*- \[ \]' "$PRD" 2>/dev/null || echo "0")
  [ "$unchecked" -eq 0 ]
}

while ! check_completion; do
  ITERATION=$((ITERATION + 1))
  if [ "$ITERATION" -gt "$MAX_ITERATIONS" ]; then
    echo "Ralph loop: max iterations ($MAX_ITERATIONS) reached. PRD not complete."
    exit 1
  fi

  echo "=== Ralph loop iteration $ITERATION ==="

  # Run the agent with the PRD
  claude --agent "$AGENT" \
    --max-turns 50 \
    -p "Continue working on $(basename "$PRD"). Check off completed items. Commit your work." \
    2>&1 | tee "/tmp/ralph-${ITERATION}.log"

  echo "=== Iteration $ITERATION complete. Checking PRD... ==="
done

echo "Ralph loop: PRD complete after $ITERATION iteration(s)."
```

Usage:

```bash
./ralph.sh PRD-auth.md                    # default agent, 10 max iterations
./ralph.sh PRD-auth.md ralph-coder 20     # custom agent, 20 max iterations
```

### What the Script Does

1. **Reads the PRD** to count unchecked boxes
2. **Launches the agent** with a headless prompt (`-p`)
3. **Captures output** to a log file per iteration
4. **Checks completion** after each run by re-counting unchecked boxes
5. **Repeats or exits** based on PRD state

### Improving the Loop

The basic script above is a starting point. In practice, you'll want:

**Stall detection.** If the agent runs for 10 minutes without a commit,
it's probably stuck. Add a timeout:

```bash
timeout 600 claude --agent "$AGENT" --max-turns 50 \
  -p "Continue working on $(basename "$PRD")..." \
  || echo "Agent timed out on iteration $ITERATION"
```

**Diff validation.** After each iteration, check that the agent actually
changed something:

```bash
if git diff --quiet HEAD~1 2>/dev/null; then
  echo "Warning: iteration $ITERATION produced no changes"
  # Optionally: add context to the next prompt about what's stuck
fi
```

**tmux persistence.** For long-running loops, run inside tmux so you can
detach and reattach:

```bash
tmux new-session -d -s ralph "./ralph.sh PRD-auth.md"
tmux attach -t ralph   # reattach later
```

**Log rotation.** Keep logs per iteration for debugging, but clean up
old ones:

```bash
LOG_DIR="/tmp/ralph-logs/$(date +%Y%m%d)"
mkdir -p "$LOG_DIR"
# ... tee to "$LOG_DIR/iteration-${ITERATION}.log"
```

---

## Step 4: Monitor and Restart

### Reading the Logs

Each iteration logs to a file. The most useful signal is git history:

```bash
# What did the last few iterations produce?
git log --oneline -10

# What changed in the last iteration?
git diff HEAD~1

# Is the agent making progress?
grep -c '^\s*- \[x\]' PRD-auth.md   # checked boxes
grep -c '^\s*- \[ \]' PRD-auth.md   # unchecked boxes
```

### Detecting Problems

**False completion.** The agent claims it's done but boxes are unchecked.
The loop script handles this — it checks the PRD, not the agent's claim.

**Infinite loops.** The agent keeps running but makes no meaningful
progress. The `MAX_ITERATIONS` cap prevents this. Stall detection (no
new commits) catches it earlier.

**Quality degradation.** The agent checks boxes but the code is wrong.
This is the hardest to detect automatically. Options:
- Run tests after each iteration (`bun test`, `mix test`, etc.)
- Use a separate review agent to spot-check

```bash
# Add to the loop after each iteration:
if ! bun test 2>/dev/null; then
  echo "Tests failing after iteration $ITERATION"
  # Option 1: continue and let the next iteration fix it
  # Option 2: break and alert
fi
```

### Using Claude Code's /loop

For simpler monitoring within an interactive session, use `/loop`:

```text
/loop 5m check if PRD-auth.md has unchecked boxes and report progress
```

This creates a session-scoped cron task that fires every 5 minutes.
It's lighter than a full Ralph loop — useful for monitoring, not driving.

### Using /schedule for Persistent Loops

For loops that should survive session exits:

```text
/schedule every 30m check PRD-auth.md progress and continue implementation
```

Desktop schedules persist across sessions (1-minute minimum interval).

---

## With HIVE

If you're running HIVE, the Ralph loop gets extra capabilities:

### Memory Across Iterations

Each iteration can read and write HIVE memory. The SessionStart hook
injects project memory automatically, so every fresh session starts
informed:

```yaml
---
name: ralph-coder
tools: Read, Write, Edit, Glob, Grep, Bash, mcp__hive__read_hive_memory, mcp__hive__write_hive_memory
isolation: worktree
maxTurns: 50
---

Before coding: read HIVE project memory (read_hive_memory) for
conventions and decisions. Follow existing patterns.

If you discover a new convention or make a decision worth recording,
write it to HIVE memory via write_hive_memory.
```

### Ticket Integration

Drive the loop from HIVE tickets instead of a standalone PRD:

```bash
# The planner creates tickets
claude --agent maya-planner "Design the auth system for TK-015"

# The Ralph loop works through them
claude --agent maya-coder "Work on TK-016 (JWT middleware). Read the ticket for requirements."
```

Tickets persist across sessions, carry notes and status, and show up in
the morning briefing. They're PRDs with built-in state management.

### Nightly Cleanup

HIVE's nightly agent reviews git activity across projects. If a Ralph
loop ran during the day, the nightly agent will extract learnings and
update ticket status automatically.

---

## When NOT to Use This Pattern

The Ralph loop is powerful but not universal. Skip it when:

### Exploratory Work

"Figure out why the app is slow" doesn't have checkboxes. Exploratory
work requires following threads, building hypotheses, and backtracking —
all things that benefit from continuous context, not fresh starts. Use
an interactive session instead.

### Security-Critical Code

Cryptography, authentication flows, access control — these need
continuous human review, not autonomous iteration. A Ralph loop might
produce code that passes tests but has subtle security flaws that only
a careful human eye catches. Use the loop for the scaffolding, then
review and harden by hand.

### Infrastructure Changes

Terraform, database migrations, deployment configs — these are
irreversible or hard to reverse. The Ralph loop's "try, commit, restart"
rhythm doesn't work when a bad commit could drop a production table. Do
these interactively with explicit approval at each step.

### Design Decisions

If the work requires making architectural choices that affect the whole
system, don't let an autonomous loop decide. Use a planning session
(or HIVE's council) first, then feed the decisions into a PRD for the
loop to execute.

### Small Tasks

A task that takes 10 minutes in one session doesn't need a loop
framework. The overhead of writing a PRD, setting up a worktree, and
running a script costs more than just doing the thing. The Ralph loop
earns its keep on tasks that take 30+ minutes of agent time.

### Cross-System Coordination

If the work requires changing three services in lockstep, a Ralph loop
per service creates coordination problems. Use a planner agent to
decompose the work and define the integration points first.

---

## Checklist

Before starting a Ralph loop:

- [ ] PRD written with markdown checkboxes
- [ ] Each checkbox is specific (file paths, function names, behavior)
- [ ] Constraints and out-of-scope sections defined
- [ ] Agent definition created (or using an existing one)
- [ ] Test suite exists to validate changes
- [ ] Loop script tested with a single iteration first

During the loop:

- [ ] Monitoring git log for progress
- [ ] Watching for stalled iterations (no commits)
- [ ] Checking test results between iterations

After the loop:

- [ ] All PRD checkboxes completed
- [ ] Tests passing
- [ ] Code reviewed (diff against main)
- [ ] Worktree merged or discarded
- [ ] Learnings recorded (HIVE memory or project notes)

---

## Reference

### CLI Flags for Ralph Loops

| Flag | Purpose |
|------|---------|
| `claude -p "prompt"` | Headless (non-interactive) execution |
| `claude --agent <name>` | Use a specific agent definition |
| `claude --worktree <name>` | Run in an isolated git worktree |
| `claude --max-turns N` | Limit agent turns per session |
| `claude --allowedTools "..."` | Pre-approve specific tools |
| `claude --output-format json` | Get structured output for scripting |

### Agent Definition Fields

```yaml
---
name: ralph-coder           # Agent name
description: ...            # When to use this agent
tools: Read, Write, Edit, Bash, Glob, Grep  # Available tools
isolation: worktree         # Run in isolated worktree
maxTurns: 50                # Turn limit per session
permissionMode: bypassPermissions  # For unattended execution
---
```

Place agent definitions in `.claude/agents/` (project-level) or
`~/.claude/agents/` (global).

### Further Reading

- [HIVE + Claude Code Integration Guide](../GUIDE.md) — how HIVE and
  Claude Code compose
- Felix von Leitner's `ralphy` pattern — the original implementation
  that inspired this approach
