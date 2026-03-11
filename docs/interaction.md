# HIVE: Human-Hive Interaction Design

## The Gap

We designed agent-to-agent communication (msg/) and agent-to-orchestrator
communication (msg/ → BOARD.md). But the human-to-hive channel is
impoverished: CLI commands and file reading. The human is the most
important participant and has the worst interface.

OpenClaw solves this by being a messaging app. You text your agent on
WhatsApp. It texts you back. Proactive updates arrive as messages.
Direction is a reply. It's the most natural interface possible.

We can't (and shouldn't) build a full messaging gateway. But we can
steal the *interaction pattern* without the infrastructure.

---

## What the Human Needs

### 1. Ambient Awareness (Hive → Human, proactive)
"Task 001 done. Alpha moving to 002."
"Beta is blocked — needs API contract from Alpha."
"All tasks complete. Ready for your review."
"Been running 2 hours. Here's a summary of progress."

The human shouldn't have to poll. The hive should surface what matters.

### 2. Conversational Direction (Human → Hive, natural language)
"How's auth going?"
"That approach is wrong, use Joken instead of Guardian."
"Pause everything, I need to rethink the schema."
"Show me what Beta built."

Not CLI commands. Not nudge-with-specific-syntax. Just talking.

### 3. Observation (Human watches, non-intrusive)
A live view of what's happening. Like tailing a log, but structured
and readable. The human glances at it periodically, like a manager
walking by the team's desks.

---

## The Solution: Three Channels

### Channel 1: The Feed (`~/.hive/feed.md`)

An append-only, human-readable stream of significant events. The
orchestrator writes to it whenever something noteworthy happens.
Not every file write — just the events a human would care about.

```markdown
# HIVE Feed

[14:00] 🚀 Session started: MyApp auth feature
        3 tasks, 2 agents active

[14:15] 💡 alpha: Chose Joken over Guardian for JWT
        Reason: lighter weight, API-only app doesn't need Plug integration

[14:52] ✅ alpha: Task 001 complete (auth endpoint)
        4 tests passing. API contract posted.

[14:53] 📋 Assigned task 002 to beta (login form)
        Dependency met: API contract available

[15:08] ❓ beta → alpha: "Token expiry format?"
        ⏳ Waiting for answer...

[15:10] 💬 alpha → beta: "ISO 8601 string"
        beta unblocked, continuing

[15:45] ✅ beta: Task 002 complete (login form)
        Manual test confirms end-to-end auth flow

[15:46] 📋 Assigned task 003 to gamma (code review)

[16:10] ✅ gamma: Review complete
        Approved with 2 suggestions (non-blocking)

[16:12] 🏁 All tasks complete
        Summary: Auth endpoint + login form + review passed
        Ready for merge. Run `hive status` for details.
```

**How the human uses it:**
```bash
# Live tail — leave this in a terminal pane
hive watch

# Quick check — last 10 entries
hive feed

# Full history
cat ~/.hive/feed.md
```

`hive watch` is just `tail -f ~/.hive/feed.md` with optional formatting.
The feed is a file. Any tool that can tail a file works.

**What gets written to the feed:**
- Session start/end
- Task assignments and completions
- Decisions (with brief rationale)
- Blockers and unblocks
- Questions between agents (summarized)
- Human nudges acknowledged
- Periodic summaries (every 30-60 min during long runs)
- Errors and escalations

**What does NOT go in the feed:**
- Every file write or tool call
- Routine status polling
- Internal orchestrator assessment cycles
- Verbose code output

The feed is the hive's "Slack channel to the human." High signal.
Skimmable. Glanceable.

### Channel 2: The Console (`hive console`)

A persistent, conversational session with the hive. This replaces
both `hive nudge` and `hive chat` with a single natural-language
interface.

```bash
$ hive console

HIVE [myapp] ▸ Session active. 2/3 tasks complete.

you: how's auth going?
HIVE: Alpha finished the endpoint at 14:52 with Joken for JWT.
      Beta is building the login form now, about 70% done based
      on the files touched. Gamma is waiting to review. No blockers.

you: the token should expire in 1 hour, not 24
HIVE: Got it. Sending correction to alpha. This will need a code
      change + test update. Want me to have alpha fix it now or
      let beta finish first?

you: let beta finish, then alpha fixes
HIVE: Noted. I'll assign the fix to alpha after beta completes.
      Updated PLAN with the new requirement.

you: actually, for sideproject, I want to use a data-modeler persona
HIVE: I don't have a data-modeler persona yet. Want me to create
      one? I'd base it on someone who thinks in schemas,
      relationships, and query patterns before writing code.

you: yes, do that
HIVE: Created ~/.hive/personas/data-modeler.md. Updated SideProject
      default team to include data-modeler. Want to review it?

you: looks good. back to myapp — show me what beta built
HIVE: Beta has created:
      - src/web/components/LoginForm.tsx (new)
      - src/web/hooks/useAuth.ts (new)
      - Modified src/web/App.tsx (added auth route)
      Using native fetch, no axios. Token stored in React state
      (not localStorage — security decision from SOUL.md).
```

**Implementation:** `hive console` opens an LLM session with a system
prompt that gives it:
- Read access to all ~/.hive/ files
- Write access to msg/ (to send messages to agents)
- Write access to PLAN.md, BOARD.md (to record changes)
- Write access to personas/, config files (for meta operations)
- Read access to the project repo (to answer "show me what X built")
- The feed as context (to answer "what happened?")

The console is the **unified human interface**. It handles:
- Status queries ("how's it going?")
- Direction ("use Joken instead")
- Meta-configuration ("add a persona")
- Priority changes ("pause auth, switch to payments")
- Observation ("show me what beta built")
- Memory queries ("what did we decide about JWT last week?")

**The console replaces:**
- `hive nudge` (just type the nudge in console)
- `hive chat` (console IS the chat)
- `hive status` (ask "what's the status?")
- Most direct file reading (ask "what's on the board?")

**The console does NOT replace:**
- `hive init` (project registration is a setup operation)
- `hive prompt` (generating agent prompts is a build operation)
- `hive archive` (explicit session management)
- `hive watch` / `hive feed` (passive observation in another pane)

### Channel 3: Notifications (Hive → Human, urgent)

For time-sensitive items the human should see immediately, not when
they next glance at the feed. The orchestrator writes these as
special escalation messages.

**Phase 1 (simple):** Escalations appear in the feed with a 🚨 prefix
and also get written to `~/.hive/msg/NNN-orch→human.md`. The console
surfaces them immediately if active.

**Phase 2 (richer):** Desktop notifications via:
- macOS: `osascript -e 'display notification "..." with title "HIVE"'`
- Linux: `notify-send "HIVE" "..."`
- Or a simple webhook to Slack/Discord/iMessage

**Phase 3 (OpenClaw-style):** Full channel integration. The hive posts
to a Slack channel, Discord thread, or sends a text. The human replies.
This is the OpenClaw endgame, but it's Phase 3, not Phase 1.

Notification triggers:
- Agent is blocked and needs a human decision (escalation)
- All tasks complete (session done)
- An agent has been stuck for >20 minutes
- A critical error occurred
- The human hasn't responded to an escalation in >10 minutes

---

## Revised CLI

```bash
# Setup
hive init <project> <path>       # Register a project
hive work [project]              # Set/show active project

# The two primary human interfaces
hive console                     # Conversational session with the hive
hive watch                       # Live tail of the feed

# Quick operations (also available via console)
hive feed [n]                    # Show last n feed entries (default 10)
hive status                      # Pretty-print BOARD.md
hive log <message>               # Append to LOG.md

# Agent operations
hive prompt <agent-id>           # Generate full agent prompt

# Session management
hive archive                     # Archive session + curate memory
hive sync                        # Copy PLAN.md to repo

# Plumbing (used by agents, rarely by humans)
hive msg <from> <to> <body>      # Create message file
```

Note what disappeared: `hive nudge` and `hive chat` are subsumed by
`hive console`. Most status queries go through console too. The CLI
gets simpler as the conversational interface gets richer.

---

## The Human's Typical Setup

Three terminal panes:

```
┌─────────────────────┬─────────────────────┐
│                     │                     │
│   hive console      │   hive watch        │
│                     │                     │
│   (conversational   │   (passive feed     │
│    direction +      │    of events,       │
│    queries)         │    glanceable)      │
│                     │                     │
├─────────────────────┴─────────────────────┤
│                                           │
│   (agents run here, or in background)     │
│                                           │
└───────────────────────────────────────────┘
```

- **Left pane:** `hive console` — the human talks to the hive here
- **Right pane:** `hive watch` — the human glances at progress here
- **Bottom pane:** Where agents actually run (or they run in background)

The console is the steering wheel. The feed is the dashboard.
The agents are the engine.

---

## The Feed vs the Console vs LOG.md

These overlap — clarifying the boundaries:

**feed.md** — For the human. High-signal summary of events. Written by
the orchestrator. Emoji-prefixed for scannability. Not the full record.

**LOG.md** — For the agents and for posterity. Detailed session record.
Written by all agents. The source of truth for what happened.

**console** — For real-time interaction. The human talks, the hive
responds. Ephemeral — the conversation itself isn't persisted (though
actions taken via console are recorded in LOG.md and feed.md).

Think of it as: LOG.md is the court transcript. feed.md is the news
ticker. The console is the phone call.