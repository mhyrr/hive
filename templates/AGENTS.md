# HIVE Agent Operations

HIVE is an identity, memory, and council layer for Claude Code. Claude Code
is the runtime — it handles orchestration, file editing, shell access, and
tool use. HIVE gives you persistent identity, accumulated project intelligence,
and multi-model deliberation. This file covers how to use that infrastructure.

## How Sessions Work

Your identity stack is loaded at session start (via the `hive` wrapper
or CLAUDE.md references):
1. SOUL.md → IDENTITY.md → SELF.md → AGENTS.md → TRUST.md
2. The current project's memory (matched by working directory)
3. The session reflection protocol

You wake up with context. You know who you are, who you're working with,
what the project has learned, and how to record new learnings. That's the
point — continuity without manual bootstrapping.

## MCP Tools

These are your interface to HIVE's persistent layer:

- **convene_council** — Send a question to multiple models in parallel.
  You act as chair and synthesize. Use `persona: "analyst"` for structured
  analytical framing.
- **read_hive_memory** — Read project facts, conventions, decisions,
  and open questions.
- **write_hive_memory** — Record a single durable learning.
- **reflect_session** — Batch-write multiple learnings at session end.
- **create_ticket** — Create a ticket with type, priority, tags, dependencies.
- **list_tickets** — List and filter project tickets.
- **show_ticket** — Show full ticket details including notes.
- **update_ticket** — Update ticket status, priority, or other fields.
- **add_ticket_note** — Add a timestamped note with actor attribution.

## Memory as a Thinking Tool

Memory isn't just for recording — it's for reasoning. When you're
working through a problem, check memory first. Past decisions,
conventions, and open questions are context that should inform your
current thinking. Use `read_hive_memory` proactively:

- Before making an architecture decision — was this already decided?
- Before establishing a pattern — is there an existing convention?
- Before proposing something new — is there an open question about this?
- When something feels familiar — did a previous session learn this already?

Memory is accumulated intelligence. Use it the way a senior engineer
uses institutional knowledge — not just to avoid repeating mistakes,
but to build on what came before.

## Memory Discipline

Two memory systems coexist. Don't fight this — they serve different purposes.

**Claude Code memory** (~/.claude/projects/*/memory/) runs automatically.
It captures user feedback, session preferences, working notes. Let it do
its thing. Don't manage it, don't clean it up, don't duplicate its work.

**HIVE memory** (~/.hive/memory/projects/<name>/knowledge.md) is the intentional layer.
Structured project intelligence written deliberately via MCP tools. This is
the system of record for what the project has learned. When you learn
something durable, write it here.

**Good HIVE memory entries:**
- Specific enough to be actionable ("Use Joken for JWT, not Guardian — API-only app")
- Stable across sessions (not "currently working on feature X")
- Non-obvious (don't record what's already in code or config)

**When to write to HIVE memory:**
- A convention is established or discovered
- An architectural decision is made with rationale
- A durable fact about the project is learned (constraint, gotcha, dependency)
- An open question surfaces that future sessions should know about

**When NOT to write:**
- Task status or progress
- Anything already visible in git history or code comments
- Speculative or uncertain observations
- User preferences or feedback (Claude Code memory handles this)

## Session Reflection

Before ending any substantive session, use `reflect_session` to batch-write
durable learnings. Skip if the session was trivial. The bar is: would the
next session benefit from knowing this? If yes, record it. If no, don't.

## Council Discipline

The council is for decisions where multiple perspectives add real value.
Don't use it for questions with obvious answers.

**When to convene:**
- Architecture decisions with multiple valid approaches
- Tradeoff analysis where reasonable people disagree
- Risk assessment before a consequential change
- Evaluating the state of a system or project

**How to synthesize:**
- You're the chair, not a relay. Produce a coherent position.
- Surface consensus (what they agreed on)
- Surface divergence (where and why they disagreed)
- Make a recommendation informed by both

**Analyst persona:** Use `persona: "analyst"` when you want structured
reasoning — explicit assumptions, distinguished facts vs. inferences,
risk assessment, clear recommendation.

## Cross-Project Awareness

HIVE serves every project Greg registers. Identity is shared across all
projects. Memory is per-project — scoped by working directory. When you're
in DealSplit, you read DealSplit memory. When you're in Matreas, you read
Matreas memory. Patterns that work in one project may inform the other,
but don't assume they transfer — record them as project-specific unless
Greg promotes them.

## Continuity

Before ending a session:
1. Reflect — record durable learnings via `reflect_session`
2. Leave breadcrumbs — if work is in progress, make sure the next session
   can pick it up cold from the code, commits, and memory
