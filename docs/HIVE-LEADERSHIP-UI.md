# HIVE Leadership UI: The Informed Commander Design

A design document. March 2026.

---

## The Insight

Our research doc identifies HIVE's operational model as fundamentally better
than the conversational model: "You're not chatting with an AI — you're steering
a team." This is true. But it understates a real competitive problem.

OpenClaw users *feel* like they're managing a capable team member. The
conversational interface creates intimacy. The autonomous action (heartbeat,
initiative while sleeping) creates the sense of a reliable colleague. When
someone wakes up and their OpenClaw agent has handled overnight tasks, triaged
their inbox, and left a morning summary — that *feels* like having a great
chief of staff.

HIVE's operational model is better architecture. But architecture doesn't win
users. **The feeling of being well-led and well-informed wins users.**

The deeper problem is the universal complaint of technical leadership: **they
don't know what they need to know.** Every engineering manager, VP, CTO has
said some version of: "I found out about the problem too late." "Nobody told
me that was at risk." "I had to ask five times to get a straight answer about
where we actually stand."

HIVE should solve this. Not by being conversational — by being the best chief
of staff a tech leader has ever had. One that:

- Tells you what matters before you ask
- Makes problems impossible to miss
- Gives you the right level of detail at the right time
- Makes your interventions feel immediate and effective
- Builds a sense of closeness through anticipation, not chat

The goal: **a leader who uses HIVE should be the best-informed technical leader
they've ever been.**

---

## Design Principles

### 1. Push Over Pull

The current system is mostly pull-based. You run `hive status`, you run
`hive watch`, you check the board. This is the wrong default for a leadership
tool.

The right default is push: the system tells you what you need to know, when
you need to know it. You pull for detail, not for awareness.

### 2. Signal, Not Data

The feed currently shows events: "task assigned," "task completed," "agent
started." These are data points. What leadership needs is signal: "alpha is
struggling — it's retried the auth module three times." "The API layer is done
but beta made assumptions that conflict with alpha's schema." "Everything is
on track, nothing needs you."

Transform data into judgment. That's what the steward is for.

### 3. Problems Are Louder Than Progress

Progress is the default expectation. It should be visible but quiet. Problems
should be impossible to miss. The longer a problem persists, the louder it
gets. An escalation that's been waiting 10 minutes should look different from
one that's been waiting 2 hours.

### 4. The Close Touch Is Anticipation

Intimacy in a leadership relationship isn't conversation — it's anticipation.
A great chief of staff doesn't chat with you. They know what you need before
you ask. They put the right document in front of you at the right time. They
tell you "you probably want to know about this" before you find out the hard
way.

HIVE should learn what the leader cares about and surface it proactively.

### 5. Intervention Feels Immediate

When the leader says something, they need to feel heard. Not "message queued."
Not "the steward will pick this up next cycle." The system should acknowledge,
show what changed, and confirm the new direction. The feedback loop should feel
tight even when the underlying execution is asynchronous.

---

## Design Area A: The Briefing System

### The Problem

The leader sits down to work. What happened? Where do things stand? What
needs them? Currently they run `hive status`, read the board, check the feed.
That's three commands and a wall of text. They're doing the synthesis in their
head.

### The Design

Introduce **structured briefings** — steward-generated intelligence reports
that synthesize state into leadership-grade information.

#### A1. Shift Briefing (When You Arrive)

Triggered: first interaction after >2 hours of inactivity, or `hive briefing`.

The steward reads the full state (board, feed since last interaction, messages,
recent runs, memory) and generates a structured briefing:

```
━━━ BRIEFING ━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Since you left (6h 23m ago):

  ✓ Completed: Auth module (alpha), API schema (beta)
  ▸ In progress: Payment integration (alpha, 2h 14m)
  ⚠ Needs you: Database migration strategy — alpha and beta
    disagree on approach. Details below.

  Momentum: steady. 4 tasks completed, 1 blocked.
  No errors. Token spend: $2.14.

  ┄┄┄ DECISION NEEDED ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
  Alpha wants to use Ecto multi-tenancy (schema-based).
  Beta assumed shared-table with tenant_id column.
  Both approaches work. Alpha's is cleaner isolation,
  Beta's is simpler queries. Your call.
  → Reply here or `hive say "use schema-based"`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Key properties:
- **Delta-focused**: what changed since you were last here
- **Judgment, not data**: "momentum: steady" not a list of timestamps
- **Decisions surfaced first**: the thing that needs you is prominent
- **Action path clear**: tells you exactly how to respond
- **Cost visible**: you know what you're spending

#### A2. Periodic Pulse (During Active Sessions)

Triggered: every 15-30 minutes during active supervision, configurable.

A one-line ambient health signal in the feed:

```
◆ 14:30 — Pulse: all agents active, no blockers, 2 tasks in flight.
◆ 15:00 — Pulse: alpha blocked 12m on test failure. beta nominal.
◆ 15:30 — Pulse: alpha still blocked (42m). Escalation pending.
```

Properties:
- **Glanceable**: one line, fits in peripheral vision
- **Anomaly-forward**: "all nominal" is boring by design. Problems stand out.
- **Aging**: blocked duration increases, creating visual urgency

#### A3. Interrupt Briefing (Something Needs You Now)

Triggered: when something reaches urgency threshold (configurable).

Delivered via: terminal notification, gateway toast, and/or system notification.

Thresholds:
- Escalation pending > 15 minutes (configurable)
- Agent blocked > 30 minutes with no progress
- Agent-to-agent conflict detected (contradictory decisions)
- Critical failure (agent crash, all tests failing, build broken)
- Budget threshold exceeded

```
┄┄┄ ATTENTION ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
Alpha has been blocked for 47 minutes on payment
gateway integration. Three approaches tried, all
failing on webhook signature verification.

This is a judgment call — not a debugging problem.
The gateway docs may be wrong, or we may need to
contact their support. Alpha can't resolve this alone.

→ `hive say "try X"` or `hive console` for details
┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
```

Properties:
- **Diagnostic, not just status**: tells you *why* it needs you
- **Classifies the problem**: "judgment call, not debugging" helps the leader
  know what kind of intervention is needed
- **Doesn't cry wolf**: only fires for genuine leadership-level problems

#### A4. Wrap-Up Summary (When You're Done)

Triggered: `hive wrap` or auto-detected via extended inactivity after an
active session.

```
━━━ SESSION SUMMARY ━━━━━━━━━━━━━━━━━━━

  Session: 3h 42m active
  Completed: 6 tasks (auth, API, schema, tests, docs, deploy config)
  Remaining: 3 tasks on board
  Decisions made: 2 (schema-based tenancy, JWT over sessions)
  Blockers resolved: 1 (payment gateway — used sandbox mode)
  New blockers: 0

  Overnight plan:
  Alpha will continue payment integration tests.
  Beta will start on the admin dashboard scaffolding.
  Expected completion: 2 more tasks by morning.

  Spending this session: $4.82 (within budget)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Properties:
- **Closure**: you know what happened on your watch
- **Forward-looking**: you know what to expect when you return
- **Budget accountability**: session-level cost tracking

### Implementation Notes — Briefings

The steward already has access to all required state (board, feed, messages,
runs, memory). Briefings are a new output format from the steward, not new
infrastructure.

New components:
- **Presence detection**: track last human interaction timestamp in
  `~/.hive/state/last-interaction`. Updated on every `say`, `ask`, `console`,
  `nudge`, gateway interaction.
- **Briefing generator**: a steward mode that outputs structured briefing
  format instead of orchestration actions. Triggered by the supervisor when
  presence gap > threshold.
- **Pulse emitter**: lightweight steward assessment (can use small model)
  that appends pulse lines to the feed on interval.
- **Interrupt dispatcher**: a check in the supervisor loop that evaluates
  urgency conditions and fires interrupt briefings.

CLI additions:
- `hive briefing` — force a shift briefing now
- `hive wrap` — force a wrap-up summary now
- Pulse interval configurable in project config.md or global config.md

Gateway additions:
- Briefing rendered as a prominent card in the console panel on reconnect
- Interrupt briefings rendered as toast notifications with persistence
- Pulse visible as a subtle status line in the feed panel header

---

## Design Area B: The Attention Queue

### The Problem

Right now, things that need the leader's attention are scattered: escalation
messages in `~/.hive/msg/`, approval requests in `~/.hive/approvals/pending/`,
blockers noted in BOARD.md, questions in the feed. The leader has to synthesize
what needs them from multiple sources.

### The Design

Introduce a unified **attention queue** — a priority-ranked list of items
that need the leader's eyes, derived from all sources.

#### B1. Attention Queue Data Model

The attention queue is a derived view, not new state. The steward (or a
lightweight assessment) scans existing state and produces a ranked list:

```
~/.hive/state/attention.md
---
generated: 2026-03-13T14:30:00Z
---

## Attention Queue

### 🔴 Urgent (needs you now)
1. **Decision: Database migration strategy** — alpha and beta disagree.
   Waiting 47m. [escalation-003]
   → `hive say "use schema-based"` or `hive console`

### 🟡 Review (needs you soon)
2. **Approval: Deploy to staging** — beta requests deploy approval.
   Waiting 12m. [approval-007]
   → `hive approval approve 007`
3. **Question: Should admin dashboard use LiveView or React?**
   Alpha asking, not blocking but wants direction. Waiting 8m. [msg-042]
   → `hive say "use LiveView"`

### 🟢 Awareness (FYI, no action needed)
4. **Alpha's auth module is passing all tests** — ready for your review
   when convenient.
5. **Token spend is at 73% of daily budget** — on track.
```

Properties:
- **Priority-ranked**: urgent items first, awareness items last
- **Aging visible**: "waiting 47m" creates urgency gradient
- **Action paths inline**: every item tells you how to respond
- **Source-linked**: reference IDs let you dig deeper if needed

#### B2. Attention in the Terminal

`hive ask` (no args) should lead with the attention queue when items exist:

```
$ hive ask

  ⚠ 1 decision waiting (47m) · 1 approval waiting (12m)

  Payment integration: alpha active (2h 14m)
  Admin dashboard: beta active (34m)
  2 agents active · no errors · $2.14 today
```

The attention count is the first line. Status follows. The leader sees
what needs them *before* they see general status.

#### B3. Attention in the Gateway

The gateway topbar should show an attention indicator:

```
┌─────────────────────────────────────────────────────┐
│ ◆ HIVE   myproject   ● supervisor active   ⚠ 2     │
└─────────────────────────────────────────────────────┘
```

The `⚠ 2` is a badge showing attention items count. Clicking it opens an
attention panel (replaces or overlays the feed panel) showing the full
ranked queue with inline action buttons.

Color coding:
- Red badge: urgent items exist (decisions, long-stuck blockers)
- Amber badge: review items exist (approvals, questions)
- No badge: nothing needs you (the good state)

---

## Design Area C: The Health Surface

### The Problem

The leader can see task status (done/in-progress/blocked) but not *health*.
"Alpha is working on payment integration" doesn't tell you if alpha is
cruising or drowning. Current status is binary: active or blocked. Reality
is a spectrum.

### The Design

Introduce **agent health signals** — derived indicators that surface the
quality of progress, not just its existence.

#### C1. Momentum Indicators

Each agent gets a momentum signal derived from its recent behavior:

- **Cruising** (green): making steady progress, commits/completions happening
  at expected pace, no retries.
- **Working** (neutral): active, some complexity, occasional retries but
  resolving them. Normal work.
- **Struggling** (amber): multiple retries on same task, test failures not
  resolving, approach changes. Still making forward progress but slowly.
- **Stuck** (red): no meaningful progress in >20 minutes, same errors
  recurring, or explicit block.

These are derived from run output analysis — the steward (or a lightweight
analyzer) reads recent run tails and classifies.

#### C2. Health in the Board

BOARD.md gets an optional health annotation per agent:

```markdown
## Agents
### alpha (architect) ● cruising
- current: payment-integration [003]
- progress: webhook handler implemented, testing signature verification
- momentum: 3 tasks completed today, current task on pace

### beta (craftsman) ▲ struggling
- current: admin-dashboard [005]
- progress: LiveView scaffolding, but hit CSS framework conflict
- momentum: 2 retries on styling approach, 25m on current attempt
```

The steward updates these during orchestration cycles.

#### C3. Health in the Gateway

The agent dropdown in the topbar shows health at a glance:

```
┌──────────────────────────────┐
│ alpha   architect   ● 2h 14m │  ← green dot = cruising
│ beta    craftsman   ▲ 34m    │  ← amber triangle = struggling
└──────────────────────────────┘
```

And the feed panel header shows aggregate:

```
  Health: 1 cruising · 1 struggling · 0 stuck
```

#### C4. Health Triggers Attention

When an agent's health degrades, it flows into the attention system:

- **Struggling > 30 min**: awareness item ("alpha has been struggling with X")
- **Stuck > 15 min**: review item (suggest intervention)
- **Stuck > 30 min**: urgent item (likely needs the leader)

The thresholds are configurable. The point is that **the leader doesn't need
to notice the problem — the system notices it for them.**

---

## Design Area D: Intervention Feedback Loop

### The Problem

When the leader says `hive say "use schema-based tenancy"`, the current
response is basically "message queued." They don't know if the message was
received, understood, or acted on until they check status later. This feels
disconnected. It breaks the sense of being in charge.

### The Design

Make interventions feel immediate and confirmed.

#### D1. Acknowledge-Act-Confirm Pattern

Every leader intervention should produce three responses:

1. **Acknowledge** (immediate, <1s): "Got it. Directing alpha to use
   schema-based tenancy."
2. **Act** (fast, <30s): the steward processes the directive, updates the
   board, sends messages to relevant agents.
3. **Confirm** (async, when done): "Alpha has received the direction and
   is switching approach. Board updated."

Currently only step 1 exists (and barely — it's just "message sent").
Steps 2 and 3 are the "close touch" that makes the leader feel in control.

#### D2. Implementation

The `hive say` flow becomes:

```
1. Human sends: hive say "use schema-based tenancy"
2. Immediately: acknowledge printed to terminal
3. Steward runs (or is signaled to run immediately, not waiting for next
   cycle): reads directive, determines affected agents, updates board,
   sends messages
4. Feed entry: "Direction received: schema-based tenancy. Alpha redirected.
   Board updated."
5. If the leader is watching (hive watch / gateway): they see the feed
   entry appear in real-time
```

The key change: **the steward should run immediately on receiving a `say`
message**, not wait for the next supervision cycle. The leader's words
should trigger instant orchestration.

#### D3. Directive Tracking

Directives from the leader should be tracked and their effects visible:

```
~/.hive/state/directives.md

## Active Directives
- [2026-03-13 14:30] "Use schema-based tenancy"
  Status: received by alpha, approach change in progress
  Affected: task 003 (payment-integration)

## Completed Directives
- [2026-03-13 12:15] "Focus on auth before API"
  Status: completed. Auth finished, API work resumed.
  Duration: 2h 15m from directive to completion
```

This gives the leader a record of their decisions and their effects —
"I said this, and here's what happened." That's the feedback loop that
builds trust and the feeling of control.

---

## Design Area E: The Anticipation Engine

### The Problem

Great leadership support isn't just reactive. It's anticipatory. A great
chief of staff doesn't wait for you to ask — they put the right information
in front of you before you need it.

### The Design

Build anticipation into the steward's behavior through pattern learning and
proactive surfacing.

#### E1. Learned Attention Patterns

Track what the leader asks about and when:

- "They always check on the auth module first thing in the morning"
- "They care about test coverage whenever a new module is added"
- "They ask about budget at the end of every session"
- "They always want to know about blockers before progress"

Store in `~/.hive/SELF.md` (user preferences):

```markdown
## Leadership Patterns
- First check: auth-related tasks (high interest)
- Recurring concern: test coverage on new modules
- Session-end: always wants budget summary
- Briefing preference: blockers before progress
```

The steward uses these to customize briefings and prioritize feed entries.

#### E2. Proactive Surfacing

The steward should generate unprompted observations when it detects something
the leader would want to know based on learned patterns:

```
Feed entry (proactive):
◆ 14:45 — Note: Alpha just added the payment module without tests.
  Based on your usual preference, you may want to flag this.
  → `hive say "add tests before continuing"`
```

This isn't an escalation (the agent didn't ask for help) and isn't a blocker
(nothing is stuck). It's the steward **anticipating the leader's concern**
based on learned patterns.

#### E3. Context Priming

When the leader opens the console or starts a session, the steward should
prime context based on what it expects they'll want:

- Pre-load relevant diffs for tasks that completed while they were away
- Have answers ready for likely questions ("how's auth going?" — the steward
  should have synthesized this before being asked)
- Surface related decisions from memory ("last time we hit this pattern,
  you chose X")

This is the "chief of staff had the folder ready before the meeting"
experience.

---

## Design Area F: Gateway UI Evolution

### The Problem

The current gateway is a console + feed two-panel layout. It's functional
but it doesn't embody the leadership experience. It's a terminal in a
browser, not a command center.

### The Design

Evolve the gateway from "web terminal" to "leadership dashboard" while
keeping the terminal aesthetic and operational feel.

#### F1. Four-Pane Layout

```
┌─────────────────────────────────────────────────────────────┐
│ ◆ HIVE   myproject   ● active   ▸2 agents   ⚠ 1   $4.82   │
├──────────────┬──────────────────────────────┬───────────────┤
│              │                              │               │
│  ATTENTION   │        CONSOLE               │    FEED       │
│  QUEUE       │                              │               │
│              │   (existing console,         │  (existing    │
│  - Decision  │    but with briefings        │   feed, but   │
│    needed    │    rendered inline)           │   with pulse  │
│    (47m) 🔴  │                              │   + health)   │
│              │                              │               │
│  - Approval  │                              │               │
│    waiting   │                              │               │
│    (12m) 🟡  │                              │               │
│              │                              │               │
│  - Auth      │                              │               │
│    ready for │                              │               │
│    review 🟢 │                              │               │
│              │                              │               │
│──────────────│                              │───────────────│
│              │                              │               │
│  HEALTH      │                              │  PROCESS      │
│              │                              │  LOGS         │
│  alpha ●     │                              │               │
│  beta  ▲     │                              │  (existing    │
│              │                              │   process     │
│  Budget: 73% │                              │   logs)       │
│  ████████░░  │                              │               │
│              │                              │               │
└──────────────┴──────────────────────────────┴───────────────┘
```

The left pane is new: a persistent **situation panel** showing attention
queue + agent health + resource status. The console and feed remain but
gain briefing and pulse capabilities.

Properties:
- **Left pane is the leadership surface**: everything the leader needs at a
  glance, without typing anything
- **Center pane is interaction**: when you need to steer, you type here
- **Right pane is activity**: ambient awareness of what's happening

The left pane is collapsible. On narrow screens or when the leader wants
to focus on the console, it folds away. The attention badge in the topbar
persists as a reminder.

#### F2. Topbar Enhancements

The topbar becomes a richer status bar:

```
◆ HIVE   myproject   ● 2 active   ⚠ 1   ◆ cruising   $4.82 today
```

Elements:
- **Project**: current project
- **Supervisor**: status + agent count
- **Attention badge**: count of items needing the leader (red/amber/none)
- **Aggregate health**: single-word team health (cruising/working/struggling)
- **Budget**: today's spend (color-coded against daily budget)

Each element is clickable for detail.

#### F3. Briefing Cards

When a briefing is generated (shift/interrupt/wrap), it renders as a
prominent card in the console panel, above the conversation:

```
┌─ BRIEFING ──────────────────────────────────────────┐
│                                                      │
│  Since you left (6h 23m ago):                       │
│                                                      │
│  ✓ Auth module complete (alpha)                     │
│  ✓ API schema complete (beta)                       │
│  ▸ Payment integration in progress (alpha, 2h 14m)  │
│  ⚠ Decision needed: migration strategy              │
│                                                      │
│  [Dismiss]                [Show Details]             │
│                                                      │
└──────────────────────────────────────────────────────┘
```

The briefing card persists until dismissed. It doesn't scroll away with
the console history.

#### F4. Toast Notifications

Interrupt briefings and urgent attention items appear as toast notifications
in the gateway — visible even if the tab isn't focused (via browser
Notification API with user permission).

```
┌──────────────────────────────────────────┐
│ ⚠ HIVE: Alpha stuck 47m on payment      │
│ gateway. Needs your direction.           │
│                        [View] [Dismiss]  │
└──────────────────────────────────────────┘
```

#### F5. Inline Action Buttons

Attention queue items in the gateway should have inline action affordances
where possible:

- Decision items: quick-reply buttons for common responses
- Approval items: Approve / Reject buttons
- Review items: "Show diff" / "Show output" expandable sections

The leader shouldn't need to switch to the console or terminal to handle
simple decisions. Click, done, back to overview.

---

## Design Area G: Autonomous Feel

### The Problem

OpenClaw's "heartbeat" feature gives users the feeling that their agent is
alive and working even when they're not present. HIVE's supervision loop
does this already, but it doesn't *feel* like it because the system doesn't
communicate its autonomous activity in a way that creates the "my team is
working while I sleep" experience.

### The Design

Make HIVE's autonomous operation visible and emotionally resonant.

#### G1. Session Continuity Narratives

When the leader returns after a period of autonomous operation, the briefing
should tell a *story*, not just list events:

Bad:
```
Completed: task-001, task-002, task-003. Blocked: task-004.
```

Good:
```
While you were away (6h 23m):

Alpha finished the auth module, then moved to payment integration.
It hit a snag with webhook signatures around 3am but worked through
it by switching to the sandbox API. Currently running integration tests.

Beta completed the API schema and started on the admin dashboard.
It's making good progress — LiveView scaffolding is done, now working
on the data tables.

One thing needs you: alpha and beta made different assumptions about
the database migration strategy. Details below.
```

The narrative form creates the feeling of "my team worked through the night
and here's the report." It's the same information, but it *feels* different.

#### G2. Overnight/Away Summary in Feed

The feed should accumulate a special "away summary" entry when the leader
has been gone for >2 hours:

```
◆ AWAY SUMMARY (03:00 - 09:15)
  Alpha: auth ✓ → payment integration (in progress)
  Beta: API schema ✓ → admin dashboard (in progress)
  6 tasks completed · 1 decision pending · $3.41 spent
```

This appears as the first entry the leader sees when they return to the
feed.

#### G3. Initiative Log

When agents or the steward take autonomous initiative (recording a
convention, making a technical decision within their authority, adjusting
approach), these should be logged distinctly in the feed:

```
◆ 03:42 — Initiative: Alpha recorded convention "all API endpoints
  return {:ok, data} | {:error, reason} tuples" in project memory.
◆ 04:15 — Initiative: Steward reassigned task-005 from beta to alpha
  (beta blocked, alpha idle).
◆ 05:30 — Initiative: Beta chose Tailwind over custom CSS for admin
  dashboard (within craftsman authority, per trust policy).
```

These entries are lower priority than problems but higher than routine
progress. They give the leader visibility into the *judgment* the team
exercised autonomously — which is what builds trust over time.

---

## Design Area H: Challenge and Risk Surface

### The Problem

The #1 complaint of tech leadership is not knowing about problems until
they're crises. HIVE should make emerging problems visible early, when
intervention is cheap.

### The Design

#### H1. Risk Radar

The steward maintains a running risk assessment, updated each orchestration
cycle:

```
~/.hive/state/risks.md

## Active Risks
- **Payment gateway integration** [medium → high]
  Alpha has tried 3 approaches. Webhook signature verification is
  failing consistently. Risk: external dependency may have a bug.
  Mitigation: contact support, or use polling instead of webhooks.
  Trending: ↑ (was medium 2h ago, now high)

- **Admin dashboard scope** [low]
  Beta is building more than the original spec calls for. Currently
  adding drag-and-drop reordering which wasn't requested. Risk:
  scope creep consuming time.
  Mitigation: nudge to stick to spec.

## Resolved Risks
- **Auth module approach** [was medium, resolved]
  Alpha initially picked a heavy framework (Guardian). Redirected to
  lightweight JWT (Joken) per your preference. Resolved in 15m.
```

Properties:
- **Trending indicators**: risks can escalate over time, visible in the UI
- **Steward judgment**: the steward classifies and suggests mitigations
- **Historical record**: resolved risks build institutional memory about
  what kinds of problems arise in your projects

#### H2. Conflict Detection

When two agents make contradictory assumptions or produce incompatible
output, the steward should detect and surface this:

```
⚠ CONFLICT DETECTED
Alpha's payment module expects `users.tenant_id` column.
Beta's migration creates `tenants` table with schema-based isolation.
These approaches are incompatible. One must change.
```

This is different from an escalation (neither agent asked for help) and
different from a blocker (neither agent is stuck yet). It's a **looming
problem** that the leader can resolve cheaply now or expensively later.

#### H3. Quality Signals

Surface test results, build status, and code quality signals in the
health surface:

```
Quality:
  Tests: 47 passing, 2 failing (payment module)
  Build: clean
  Warnings: 3 new deprecation warnings in auth module
```

The leader doesn't need to see every test result. They need to know if
quality is trending in the right direction.

---

## Sequencing

### Phase 1: Foundation (Implement First)

These changes are highest value and lowest complexity:

1. **Presence tracking** — last-interaction timestamp (trivial)
2. **Attention queue** — derived view from existing state (moderate)
3. **Attention badge in topbar** — gateway UI change (easy)
4. **`hive briefing`** — steward output format (moderate)
5. **Immediate steward trigger on `say`** — supervisor change (moderate)
6. **Acknowledge-act-confirm** — `say` response enhancement (moderate)

### Phase 2: Health and Awareness

7. **Momentum indicators** — run output analysis (moderate)
8. **Pulse emitter** — periodic feed entries (easy)
9. **Health in gateway** — UI updates to agent dropdown and topbar (easy)
10. **Narrative briefings** — steward prompt engineering (moderate)
11. **Initiative logging** — feed entry classification (easy)

### Phase 3: Anticipation and Risk

12. **Risk radar** — steward assessment mode (moderate)
13. **Conflict detection** — cross-agent analysis (complex)
14. **Learned attention patterns** — SELF.md updates (moderate)
15. **Proactive surfacing** — steward anticipation mode (complex)
16. **Interrupt briefings** with notification API (moderate)

### Phase 4: Gateway Evolution

17. **Four-pane layout** — gateway UI redesign (complex)
18. **Briefing cards** — gateway rendering (moderate)
19. **Toast notifications** — browser notification integration (moderate)
20. **Inline action buttons** — gateway interaction (complex)
21. **Directive tracking** — state management + UI (moderate)

---

## What This Changes About HIVE's Identity

This design shifts HIVE from "multi-agent orchestration tool" to "technical
leadership amplifier." The orchestration is still the engine, but the surface
is purpose-built for the leadership experience.

The thesis becomes: **HIVE doesn't just run your agents. It makes you a
better-informed, faster-reacting, more effective technical leader than you
could be without it.**

The competitive comparison changes too. It's not "HIVE vs OpenClaw on agent
orchestration." It's "HIVE gives you the leadership experience that no
conversational agent can." You don't talk to HIVE. HIVE tells you what you
need to know, when you need to know it, and makes your decisions take effect
immediately.

That's not a chatbot. That's a chief of staff.
