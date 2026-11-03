# LOAM Phase 0 benchmark corpus — "Sundial Systems"

A synthetic, frozen org-exhaust corpus with ground truth by construction,
built to the Phase 0 requirements of `docs/loam-spec.md` (§13, as amended
in v0.2.0-draft). This corpus is also the §10.7 appreciation-test frozen
benchmark: one corpus, two standing uses.

**Everything here is fictional.** Sundial Systems is an invented
12-person clinic-scheduling SaaS (domain `sundialhq.test`, a reserved
TLD); every person, customer, and incident is made up. That is the point:
a synthetic corpus has no consent, licensing, or PII problem, and its
gold labels are exact because every reference event was *planted*, not
discovered.

## Why synthetic (find vs. build)

Surveyed alternatives and what they lack:

| Option | What it has | Why it isn't the Phase 0 gold set |
|---|---|---|
| [TheAgentCompany](https://github.com/TheAgentCompany/TheAgentCompany) | Simulated software company: GitLab, RocketChat, ownCloud, Plane, pre-populated with repos/chat/org graph | Built for agent *task* evaluation; no reference-kind or artifact labels; data volume aimed at task realism, not longitudinal memory dynamics |
| [OrgForge](https://github.com/aeriesec/orgforge) ([paper](https://arxiv.org/abs/2603.14997)) | Multi-agent sim emitting Slack/email/git/tickets prose over a deterministic ground-truth event bus | Closest substrate; ground truth targets RAG fact-QA, not LOAM's taxonomy (citation/assertion/retelling/instantiation, six artifact types). Strong candidate for generating a *bigger second corpus* |
| Enron / Avocado / W3C corpora | Real email at scale | Email only; no chat/repo; labeling cost falls on us; Avocado is LDC-licensed |
| Public OSS projects (e.g. Zulip's public chat + repo) | Real, linked chat + git | Real-world consent/etiquette questions for benchmark redistribution; gold labeling is the whole cost; org dynamics of an OSS community differ from a company |

None ship labels in LOAM's taxonomy, so the label pass is the dominant
cost everywhere — and authoring the corpus *around* the labels is
cheaper and yields exact ground truth. The known weakness of a synthetic
corpus (references may be too lexically clean) is mitigated by planting
assertions in three difficulty tiers and adversarial near-misses, and
should eventually be checked against one consented real corpus.

## Layout

```
scenario/     source of truth: the org, timeline, and every event, with
              gold labels inline on the events they occur in
corpus/       frozen render — what an implementation ingests
  slack/      Slack-export-shaped JSON (users, channels, per-day files)
  email/      single mbox with threaded headers
  git/        git fast-import stream + build.sh to rebuild the repo
  transcripts/ meeting transcripts (one exhaust event per speaker turn)
gold/         frozen labels — what the eval harness scores against
  actors.json           identity resolution gold (Slack/email/git per actor)
  artifacts.json        26 artifacts a perfect extractor should recover
  reference_events.jsonl 70 reference events with kind, difficulty,
                        self_reference, divergence, violation, venue
  negatives.json        near-miss events + discussed-but-never-decided
  stats.json            counts (regenerated; do not hand-edit)
tools/
  render.ts    scenario → corpus + gold (deterministic; fails on any
               inconsistency: bad span, wrong self_reference flag, …)
  validate.ts  re-renders and byte-compares against the frozen output
```

Native IDs: Slack `channel:ts`, email `Message-ID`, git commit SHA
(deterministic — fixed author/committer dates), transcript `file#segment`.

## What the gold labels support

- **Per-kind precision AND recall** (spec §4.2): every genuine reference
  is labeled; anything a detector emits that isn't in
  `reference_events.jsonl` (and isn't listed in `negatives.json` as a
  deliberate trap) is a false positive.
- **Recall by difficulty**: assertions are planted in three tiers —
  `easy` (near-verbatim), `medium` (paraphrase), `hard` (entailed use,
  no naming). Asymmetric assertion recall is the load-bearing sensor
  risk (§14.1); this is the dimension that measures it.
- **Extraction yield**: `artifacts.json` vs. what the extractor
  proposes, including two non-artifacts that must NOT be extracted.
- **§6.4 semantics**: `self_reference` marks references by an
  artifact's own authors/participants (weight 0 as amended);
  `venue.audience_size` feeds reach-scaling; one deliberate
  venue-gaming event is planted.
- **Dynamics trajectories** for replay validation — see
  [SCENARIOS.md](./SCENARIOS.md) for the full planted index.

## Using it

```sh
bun run loam/benchmark/tools/validate.ts   # integrity check (CI fixture)
corpus/git/build.sh /tmp/sundial           # materialize the git repo
```

An eval harness should ingest `corpus/`, run the implementation under
test, and score its outputs against `gold/`. The harness itself is the
second Phase 0 deliverable and lives outside this directory.

## Freeze policy

`corpus/` and `gold/` are frozen: benchmark numbers are only comparable
against an identical corpus. Fixes go into `scenario/`, then re-render,
and any change bumps the corpus version below and invalidates prior
numbers. `validate.ts` (run it in CI) catches silent drift.

**Corpus version: sundial-v1** (2026-07-11)

## Known limitations (honest list)

- Written by one author (an LLM) in one pass: stylistic monoculture,
  and reference difficulty calibration is asserted, not measured.
  A human should spot-check a sample of labels before targets are set.
- Small: 165 exhaust events, 70 reference events — enough to rank
  detectors and catch gross asymmetries, not enough for tight
  confidence intervals per kind × difficulty cell.
- Six months of history: too short for default-parameter resurrection
  (dormancy > 3× half-life) — that scenario is parameter-dependent
  (see SCENARIOS.md) and properly belongs to the dynamics simulator.
- No Drive/docs or ticketing source; audience_size for git events is
  null (venue semantics for a repo are unresolved in the spec).
- Org size (12) needs the spec's `small_org` profile for tier
  dynamics above episodic to activate at all.
