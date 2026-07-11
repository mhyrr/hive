# Planted scenarios index

Every dynamic the spec claims to detect has at least one deliberately
planted trajectory in the corpus. This is the map from spec section to
ground truth.

## Consolidation (§6.5)

- **`dec-no-friday-migrations`** — the flagship trajectory. Decided
  2025-02-10 with citations Feb–Mar (postmortem links, "per the
  postmortem"), then progressively bare assertions Apr–Jun by **six
  non-participant actors across three teams** (tom, jules, lena, nadia,
  colin, marcus — eng/product/gtm), spanning easy ("no Friday
  migrations") to hard ("It's Thursday-or-Monday, man, that rule is
  written in outage blood"). Under the amended §6.5 with recall-corrected
  rates and the `small_org` profile, this SHOULD nominate. Its hard
  assertions are exactly the ones a weak assertion detector misses — if
  detection is asymmetric, this artifact's consolidation ratio deflates,
  which is review item 1 made testable.
- **`dec-tenancy-single-cluster`** — secondary trajectory: citations
  (ADR-003 mentions) plus assertions by ana (hard), marcus (easy),
  jules (medium), and a self-referential assertion by dev.

## Decay and archival (§6.1)

- **`dec-trunk-based`** — referenced exactly twice, both within a week
  of the decision (2025-03-13 commit, 2025-03-18 Slack), then silence
  through June. Replay should show activation collapse.
- **`dec-pnpm`** — **zero** reference events ever. Exercises the
  amended §6.1 rule that age runs from `created_at`.
- **`dec-metabase-reports`** — referenced 2025-04-03, dormant 12 weeks,
  then cited 2025-06-25 ("didn't we already decide Metabase…"). Under
  default parameters (half-life 45d) 83 days of dormancy is NOT a
  §6.8 resurrection (threshold 3 × half-life); under half-life ≤ 27d it
  is. Parameter-sensitive on purpose — a dynamics-simulator test case,
  not a detection test case.

## Supersede chain (§5.4, §9.2)

- **`dec-postpone-baa` → `dec-sign-baas`**: decided 2025-03-05,
  reversed 2025-05-22 (transcript segment ts2-9, ADR-007, email). A
  context pack for a compliance task must include the supersede chain,
  not just the March decision.

## Narrative tier (§6.2, §6.6)

- **`story-friday-migration`** — 3 retellings by non-participants
  (jules in the all-hands transcript, marcus in #general, colin in
  #gtm, increasingly paraphrased). Meets `retelling_min`/`teller_min`
  → SHOULD nominate as a Story.
- **`story-meridian-signature`** — 2 non-participant retellings (nadia,
  lena) + 2 participant retellings (ray, flagged `self_reference`).
  Only non-participant tellings count toward promotion — a detector
  that counts ray's own retellings over-promotes.

## Semantic tier (§6.3)

- **`prin-no-friday-migrations`** — ratified in the all-hands
  (ts1-8). One planted **violation**: commit `gc-mig-0530` (a schema
  migration at 17:12 on Friday 2025-05-30), flagged
  `violation: true`, plus the callout thread that follows. Enactment-gap
  arithmetic: many assertions, one violation.
- **`prin-clinics-own-their-data`** — assertions across git
  (deal-desk policy doc, export commit), Slack, and transcript.
- **Facts** (new type from review item 2): four planted
  (`fact-churn-solo-clinics`, `fact-meridian-cfo`,
  `fact-booking-200rps`, `fact-twilio-sandbox-au`), each with later
  descriptive re-assertions by other actors and `stale_after_days`
  attrs for staleness-dynamics tests.

## Procedural tier (§6.7)

- **`proc-release-checklist`** — clean instantiation (divergence 0.05,
  release 1.4) vs. divergent instantiation (0.4 — tom skips the 24h
  soak for release 1.5) plus the owner's corrective citation.
- **`proc-incident-runbook`** — five instantiations across three
  incidents, divergence 0.05–0.3 (the 0.3 one is an *announced*
  deviation: phone calls instead of the comms template).
- **`proc-deal-desk`** — email instantiations: compliant sign-off
  request (0.1) vs. discount-after-the-fact (0.45, `violation: true`).

## Measurement integrity (§6.4 as amended)

- **Venue gaming**: `sl-0603-1` — dev pastes his own ADR-003 summary
  into #general (13 members, the widest venue). Labeled
  `self_reference: true`; under amended §6.4 it logs but contributes
  weight 0. A scorer can verify an implementation doesn't credit it.
- **17 self-references** overall, spread across kinds — including
  participant retellings and authors citing their own ADRs.
- **Agent actor**: `deploybot` (`is_agent: true`) authors alerts,
  CI noise, and one commit citing the release checklist
  (`gc-release-1-4`) — exhaust authored by an agent, which §6.4's
  weight table doesn't cleanly cover today. Deliberately planted spec
  pressure.

## Detection traps

- **Near-misses** (`gold/negatives.json`): Postgres expertise in a
  hiring context (vs. the tenancy decision), a great Friday demo
  (vs. the Friday rule), Twilio Flex prospect question (vs. the
  Twilio decision).
- **Non-artifacts**: the mobile-app debate (twice discussed,
  explicitly "parking it") and the Vitest proposal ("parking this") —
  commitment-marker traps for decision extraction.
- **Multi-reference events** (amended §5.3): 4 events carry ≥2
  reference events, e.g. `sl-0612-1` cites ADR-003 and ADR-005 in one
  message; `ts1-7` is simultaneously a Story retelling and a Decision
  assertion.

## Entity resolution (§4.2)

- Tom commits under two git identities (`Tom Hale
  <tom@sundialhq.test>` and `tomhale <tom.hale.dev@fastmail.test>`),
  and every actor has distinct Slack/email/git identities —
  `gold/actors.json` is the resolution answer key.

## Small-org reality (review item 3)

Twelve humans, three teams. Under default parameters
(`consolidation_actors = 5` is reachable, but barely;
`consolidation_teams = 2` requires the gtm assertions to be detected),
the flagship consolidation fires **only if** hard assertions are
caught — under the `small_org` profile it fires comfortably. That gap
is itself a benchmark assertion about parameter profiles.
