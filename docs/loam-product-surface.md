# LOAM Product Surface

**Status:** Design companion to `loam-spec.md` v0.2.0-draft. Informative,
not normative — where this document and the spec disagree, the spec wins.
Where the spec is silent (copy, layout, cadence), this document is the
current answer.

The spec defines the engine. This defines the cockpit: what people see,
when the system speaks, who pulls which threads, and how the CEO's day
with LOAM differs from an engineer's.

---

## 0. Product stance

Five commitments that every surface decision below derives from:

1. **The work is the input.** Nobody files, tags, or "adds to the
   knowledge base." Exhaust flows in from tools people already use;
   capture UX is not a surface that exists. The only writes humans ever
   perform are governance verbs — and those are batched.
2. **Memory comes to you.** The default consumption is push-at-the-right
   -moment (context packs, nudges, briefs), not search. Search exists for
   the moments of doubt; it is not the front door.
3. **Give ≫ ask.** A person should receive useful memory dozens of times
   for every time the system asks them for anything. Hard budget: at most
   **five asks per person per week**, delivered as one batch, and zero is
   the common case. If the queues demand more, the queues wait.
4. **Every answer is one hop from evidence.** Any claim any surface makes
   carries its artifact chip, and every artifact page carries its
   provenance rail. No dead-end assertions anywhere in the product.
5. **Symmetric by construction.** Everyone gets the same read surface —
   same search, same artifact pages, same reports (§11.1). Rank changes
   which *verbs* render on a page and which *queues* route to you, never
   what you can see. There is no admin-only analytics view to build,
   because building it is prohibited (§11.3).

Traffic expectation, by surface: **agents via MCP ≫ ambient chat
surfacings ≫ web UI**. The web UI is where memory is *read deeply and
governed*, not where it is fed or routinely consumed.

---

## 1. The ambient loop — where LOAM meets the working day

### 1.1 Most days: nothing

Exhaust flows; extraction and dynamics run; nobody notices. This is the
correct experience for most people most days and we should resist every
temptation to make the system more present than this. LOAM earns
attention only at *moments*, listed in §5.

### 1.2 The artifact permalink — the atomic social object

Every artifact has a short stable URL (`loam/d/tenancy-single-cluster`)
that unfurls in Slack/email as a compact card:

> **Decision — Single Postgres cluster, row-level tenancy** (ADR-003)
> settled Jan 2025 · active · cited 41× by 9 people · scope: org
> *"All clinics live in one cluster… accepted risk: blast radius."*

Pasting a link **is** a citation — a lexically perfect Reference Event.
This is the product's quiet flywheel: the easiest way to win an argument
is to paste the decision, and pasting the decision reinforces it (§6.4)
while feeding the detector its easiest possible signal. Unfurl cards are
therefore a first-class investment, not chrome.

### 1.3 When LOAM speaks in chat (the complete list)

The Slack/Teams app posts in exactly three situations, all thread-scoped,
all dismissible, all rate-limited (once per thread, ever):

1. **The relitigation nudge.** Reference-event detection notices a live
   thread re-arguing a settled Decision:
   > This discussion overlaps **Per-practitioner seat pricing** (settled
   > Feb 2025, cited 23× since). Relitigate deliberately if you like —
   > here's the original reasoning and the two alternatives already
   > rejected. [artifact card]
   Tone rule: LOAM informs; it never says "stop." A team that reads the
   decision and reopens it anyway is *using the system correctly* (the
   `reopen` verb, tracked by §10.5).
2. **The supersede warning.** Someone cites an artifact that has been
   superseded or deprecated:
   > Heads up — **Postpone HIPAA BAAs** was superseded by **Sign BAAs —
   > HIPAA is table stakes** (May 2025). [current artifact card]
3. **The answer to a direct ask.** `/loam <question>` (or @loam in a
   thread) runs retrieval and replies in-thread with an answer composed
   *only* of artifact excerpts with chips — same engine as MCP
   `search_memory`, same visibility as everything else.

That's the whole list. No daily digests in channels, no "LOAM captured 3
new items!" announcements, no gamification. Ambient means ambient.

### 1.4 The Memory Inbox — the one ask surface

All governance flow (§8.5's four queues) reaches humans through a single
personal inbox, web + a weekly Slack DM, only when non-empty. Items are
**role-routed**, never broadcast:

| Queue item | Routed to |
|---|---|
| Candidate escalations (verifier punts) | scope editors |
| Principle nominations, with consolidation evidence | scope ratifiers |
| Challenges (enactment gap trips) | ratifiers + challenge author |
| Divergence flags | that Procedure's owner |
| Endangered lore | the story's known tellers + scope editors |
| Actor-merge ambiguities | the affected person (their own identity only) |

Every item is a two-minute decision presented with its evidence inline
and its verbs as buttons. The inbox is designed like a PR review queue,
not like email: open it Monday, clear it in five minutes, done. The §8.3
queue SLA is what keeps this honest — if items age, the *operator* gets
paged, not the users nagged harder.

---

## 2. The web UI — five screens

The entire UI is five screens. Resist additions.

### 2.1 The artifact page (the core object)

Everything in the product links here. One layout for all six types, with
a type-specific header block.

```
┌──────────────────────────────────────────────────────────────────────┐
│ DECISION · active · org scope            [Challenge] [Edit] [History] │
│ Single Postgres cluster, row-level tenancy (ADR-003)                  │
│ settled 14 Jan 2025 · half-life 310d · ▂▃▅▇▅▃▅▆ activation            │
│──────────────────────────────────────────────────────────────────────│
│ QUESTION  DB per clinic, schema per clinic, or row-level tenancy?     │
│ RESOLVED  Row-level tenancy on one cluster.                           │
│ REJECTED  · database per clinic  · schema per clinic                  │
│ RISK ACCEPTED  One bad query affects every clinic (see: The Friday    │
│ Migration →)                                                          │
│──────────────────────────────────────────────────────────────────────│
│ BODY (current revision, markdown)                                     │
│──────────────────────────────────────────────────────────────────────│
│ LIFE  41 references · 9 people · 3 teams        [reference timeline]  │
│   ● citation — Priya, commit a4c8ac6, Jun 5   "per ADR-005…"          │
│   ● assertion — Ana, #incidents, Feb 7        "one bad lock hits…"    │
│   ● … (chronological, each row links its exhaust event)               │
│ PROVENANCE  #eng thread 9 Jan · ADR commit · announcement 14 Jan      │
│ CHAIN  supersedes: — · superseded by: — · teaches: — · sources: —     │
└──────────────────────────────────────────────────────────────────────┘
```

Product notes:

- **The "LIFE" section is the differentiator.** No wiki shows you *whether
  an idea is alive*. The reference timeline — who invoked this, where,
  how (citation vs. bare assertion), trending up or down — is the thing
  LOAM can render that nothing else can. Lead with it visually.
- Verbs render by authority (§8.1): everyone sees [Challenge] on a
  Principle; only ratifiers see [Amend]/[Retire]; only the owner sees
  [Revise] on a Procedure. Same page, different buttons.
- Provenance rows deep-link to the exhaust event *in its source* (the
  Slack message, the commit) when the viewer has source-side access, and
  render the stored span inline when they don't. This is invariant-1
  compliant: exhaust is reachable *through* artifacts, and only there.
- Archived artifacts render in sepia with a "resurrect" affordance —
  archival must feel reversible, because it is.

### 2.2 The Constitution

One page per scope: the pinned Principles (always small, §9.2) plus each
one's **enactment health** — asserted rate vs. violation rate, trend
arrow, open challenges. This is the page a team reads quarterly and the
page every context pack's tier-1 content mirrors. A Principle whose gap
trend is deteriorating renders with its warning visible to *everyone* —
a constitution that's quietly being ignored should look like one.

### 2.3 The Memory Inbox

As in §1.4. One screen, newest evidence first, verbs as buttons,
keyboard-driven. The empty state says "Nothing needs you," and means it.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Your memory inbox — 3 items this week                                 │
│──────────────────────────────────────────────────────────────────────│
│ ① NOMINATION → you are a ratifier (org scope)                        │
│   "Never ship schema migrations on Fridays" — consolidation evidence:  │
│   asserted by 6 people across 3 teams over 90d; citation→assertion    │
│   ratio 0.78. Story linked: The Friday Migration.                     │
│   [Ratify] [Decline] [Read evidence]                                  │
│ ② DIVERGENCE FLAG → you own "Release checklist"                      │
│   3 of last 5 instantiations skipped the staging soak (mean div 0.31) │
│   Top variant: deploy-before-soak under demo deadlines.               │
│   [Revise procedure] [Dismiss w/ rationale] [See instantiations]      │
│ ③ ENDANGERED LORE → you're a known teller                            │
│   "The ghost cron" — no retelling in 12 months; 1 of 2 tellers left.  │
│   [Tell it once in #general] [Canonize written telling] [Let it die]  │
└──────────────────────────────────────────────────────────────────────┘
```

Note the endangered-lore verbs: the product treats "let it die" as a
legitimate, first-class choice. Forgetting is specified behavior (§1.2).

### 2.4 Search — "ask the org"

A single box that answers questions, not a filter grid. Results are
composed answers built from artifact excerpts, each with its chip;
below them, the matching artifacts ranked by `relevance × activation`
(§4.3). Toggles: scope, type, `include_archived` (off by default,
labeled "include forgotten").

What it is **not**: there is no mode where search runs over raw exhaust
(§11.1 as amended). You cannot grep your colleagues. The drill path is
always search → artifact → provenance → those specific exhaust events.

### 2.5 Instruments

A report gallery, monthly cadence, rendered as readable documents with
charts (§4.7) — not a live dashboard wall. Decision survival (with the
org's **decision half-life** as the headline stat), drift vs. the
Constitution, fragility (aggregate view: *"7 high-activation artifacts
have a single rehearser"* — naming requires the org policy switch, §11.3,
and the switch's state is printed on the report), lore census, tier flux
with its pathology signatures spelled out in words ("your pinned set grew
40% this quarter — that pattern usually means sclerosis, not wisdom").

---

## 3. MCP — the agent's day

Agents are the heaviest users and the reason the economics work. The
integration contract (§9), translated to a session lifecycle:

| Moment | Call | What the agent experiences |
|---|---|---|
| Session start (harness hook) | `list_principles(scope)` + `get_context_pack(task)` | Wakes up already knowing the constitution, the settled decisions touching its task (with supersede chains), the matching procedure, and up to two cautionary stories. |
| Mid-task doubt | `search_memory`, `get_artifact` | Pulls threads exactly like a human in the UI; reads at 0.15 weight (§6.4) so agent traffic can't manufacture importance. |
| About to act against canon | (client-side check on pack contents) | The pack includes rejected alternatives and superseded chains precisely so the agent *doesn't* re-propose Dynamo or re-postpone the BAAs. |
| Witnesses a decision being made | `propose_artifact` | Files a candidate with the thread as provenance. Never lands in canon directly (§8.2). |
| Work ships (harness hook, mandatory per amended §9.3) | `record_outcome(artifact_ids, exhaust_ref)` | Closes the loop: the shipped commit/PR becomes full-weight organic evidence for the artifacts that guided it. |

Behavioral contract for agent authors (goes in the client README):

- **Cite IDs in your output.** When memory shaped an action, say so in
  the commit/PR/message body ("per ADR-003") — that text is what the
  reference detector reads later. Agents that cite make the whole org's
  memory sensor sharper.
- **Don't relitigate; surface.** If the task seems to require
  contradicting an active Decision, don't argue with it and don't obey
  it silently — flag the conflict to the human with both artifacts.
- **Propose sparingly.** One good candidate with clean provenance beats
  five speculative ones; the verifier's overturn rate is tracked and
  trust priors (§8.1) make sloppy proposers expensive.

The session-start experience is the product's second flywheel: the more
an org's agents run through LOAM, the more `record_outcome` evidence
accrues, the better the packs get, the more the humans see agents that
"already know how we do things here."

---

## 4. Role walkthroughs — a week with LOAM

Using the Sundial Systems cast (see `loam/benchmark/`) as the persona
set.

### 4.1 Priya — IC engineer

**Daily:** nothing. She works in git and Slack; her exhaust is her
contribution and she never thinks about it.
**Ambient touches:** her agent sessions start pre-briefed (she notices
the agent stopped suggesting things the org rejected months ago). When
she pastes `loam/d/utc-iana-tz` into a code review instead of
re-explaining timezone policy, that's her "using" LOAM.
**Pull moments:** twice a month she hits a "why is this like this?"
moment, does `/loam why do we store UTC only?`, reads the decision, and
— the part a wiki can't do — clicks through provenance to the actual
Melbourne double-booking thread when she doubts the stated reason.
**Asks of her:** near zero. Once a quarter the inbox asks her something
she's uniquely placed to answer (an actor-merge confirmation, an episode
that names her and reads wrong).

### 4.2 Ana — SRE, owner of two Procedures

Everything Priya gets, plus **ownership routing**: when the release
checklist's instantiations start skipping the soak, the divergence flag
comes to *her* with the variant clusters attached (§6.7). Her choice —
revise the canonical rev (maybe the soak really should be 12h) or defend
it — is a two-minute inbox decision that replaces the slow rot every
runbook suffers. Procedure ownership is the most "product-manager-like"
recurring duty in the system and the inbox is built around making it
weightless.

### 4.3 Jules — PM

Jules is the highest-frequency *deliberate* user below the CEO. He
drafts specs with packs in context (his agent pulls Decisions touching
the feature's entities), pastes artifact links into product debates as
his standard move, and files `propose` from Slack (message action:
**"Capture as decision candidate"** — the one lightweight capture
affordance we allow, because it creates a *candidate* with the thread as
provenance, not canon). When a debate ends without commitment, he does
nothing — and extraction correctly extracts nothing (that's the
`non-mobile-app` trap in the benchmark).

### 4.4 Ray and Nadia — GTM

The Fact type (§5.4) is mostly theirs: "Meridian's decision-maker is the
CFO," "churn concentrates in solo clinics." Facts reach them back
through packs when an agent drafts a proposal and through `/loam` before
calls ("what do we know about Meridian?"). Staleness is the visible
dynamic: a Fact past its re-verify date renders with a "possibly stale —
last verified Mar 2025" badge everywhere it appears, which is exactly
the right epistemic posture for sales intel. The deal-desk Procedure
reaches Colin as a checklist his email client's agent can instantiate.

### 4.5 The new hire — day one

Onboarding is the killer demo. Day one, they get a generated brief, per
scope: the Constitution (with each Principle's *story* attached — §5.4
`teaches` links exist for exactly this), the ten most-alive Decisions in
their team's scope with resolutions and rejected alternatives, the
Procedures they'll instantiate in week one, and the lore ("The Friday
Migration," told properly). Two months of ambient context in forty
minutes of reading — and every claim clickable down to the receipts.
This brief is just a rendered context pack; it costs nothing to build
and it's the moment LOAM converts skeptics.

### 4.6 The departing teller — offboarding

When someone gives notice, LOAM has one question for them, generated
from the lore census: *"You're the last active teller of these 2
stories. Twenty minutes?"* Canonize the telling before the teller walks
out. This is the endangered-lore queue given a deadline, and it is the
single highest-leverage capture moment in the entire product.

### 4.7 Maya — the CEO

The CEO's surface differs in **verbs, cadence, and instruments** — not
in visibility.

**Same as everyone:** search, artifact pages, reports. She sees nothing
about individuals that Priya can't see (§11.1, §11.3). Her utterances
carry no measurement multiplier (§6.4) — if she wants an idea to live,
she has to say it somewhere with reach and have *other people* repeat
it, which is the honest mechanism.

**Different verbs:** she's a ratifier at org scope. Nominations and
challenges route to her inbox. Ratification is deliberately rare and
deliberate — the product frames it as constitutional amendment, evidence
attached, not as a like button.

**Different cadence — her actual usage pattern:**

- *Weekly (5 min):* inbox. Usually empty. Occasionally a nomination —
  the consolidation detector telling her "the org already believes this;
  make it law or push back *now* while it's fresh."
- *Monthly (30 min):* the instrument reports. Drift is her page: "here's
  the gap between the constitution and what the exhaust shows the org
  actually doing, and its derivative." Decision half-life trend. Tier
  flux pathologies in plain words.
- *Quarterly / before big moments:* fragility before a reorg ("which
  living knowledge has a bus factor of one?" — aggregate by default);
  lore census before the all-hands (which stories are carrying the
  culture, which are dying); the supersede chains when revisiting an old
  strategic call ("what did we believe, when, and what changed it").

**What the product refuses her:** a per-person view of who cites whom,
who "contributes knowledge," who asserted what. Not hidden behind an
admin toggle — absent (§11.4). The pitch to leadership is explicit about
this: the instrument stays honest *because* it can't be turned on the
org chart, and statements consolidate only when the org actually repeats
them. LOAM tells the CEO the truth precisely because it can't be used to
grade people.

### 4.8 The agent fleet

See §3. One product note belongs here: agents appear in the UI as actors
with an `is_agent` badge, their reference traffic is visible on artifact
timelines (dimmed, weighted per §6.4), and any org can filter timelines
to humans-only in one click. Trust is preserved by never letting agent
activity masquerade as human rehearsal.

---

## 5. Moments — when people pull threads

| Moment | Surface | Path |
|---|---|---|
| "Why is it like this?" | `/loam` or search | question → artifact → provenance → original thread |
| About to decide something | agent pack / relitigation nudge | prior decision + rejected alternatives arrive before the debate re-runs |
| Citing policy in an argument | artifact permalink | paste the card; the citation reinforces the artifact |
| Disagreeing with canon | [Challenge] on the artifact page | evidence attached → challenge queue → ratifiers must re-justify (§7.2) |
| Following a runbook | `get_procedure` / artifact page | canonical rev; the instantiation is detected, divergence measured |
| Joining | onboarding brief | rendered pack: constitution → live decisions → procedures → lore |
| Leaving | offboarding lore capture | endangered stories → canonize tellings |
| Something feels forgotten | search with "include forgotten" | archived artifact → [Resurrect] |
| Running the org | instruments | monthly reports; drift, half-life, fragility, lore |

---

## 6. What we refuse to build

Straight from the invariants (§11), stated as product commitments so
nobody "helpfully" adds them later:

- No per-individual analytics, leaderboards, contribution scores, or
  expertise profiles. Not as a paid tier, not as an admin view.
- No free-text search over raw exhaust. The exhaust log is reachable
  only through provenance links or by its own author.
- No capture chores: no tagging, no "was this helpful?", no mandatory
  templates, no documentation nag bots.
- No engagement mechanics. LOAM speaking less is a feature; the metric
  we optimize is *asks avoided per answer delivered*, not DAU.
- No write path into source systems, ever (§1.2). LOAM quotes your
  Slack; it never posts as you, edits a doc, or files a ticket.

---

## 7. Adoption arc — what each spec phase feels like

| Spec phase (§13) | What users actually get |
|---|---|
| Phase 0 | Nothing visible. (Benchmark + harness + simulator.) |
| Phase 1 | **The memoir moment**: connectors backfill, replay runs, and the org receives its inaugural report (§12.5) — "here is what you've decided, what's still alive, what's fragile, what's lore." Artifact pages + search ship here. This report is the sales demo and the emotional hook; a two-year-old org meeting its own memory is the moment of conviction. |
| Phase 2 | **Agents wake up briefed.** MCP + packs + session-start client. The daily felt value begins here, and `record_outcome` starts compounding. |
| Phase 3 | **Governance goes live**: inbox, Constitution page, nominations, challenges, procedure ownership. The org starts *steering* its memory. |
| Phase 4 | **The instruments arrive**: decision half-life, drift, fragility, lore census as monthly rituals for leadership. |

The order matters product-wise as much as engineering-wise: value lands
(1–2) before duties appear (3), and measurement (4) arrives only once
there's a year of honest reference data to measure.
