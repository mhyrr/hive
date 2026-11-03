// Gold artifact set — what a perfect extractor should recover from the
// corpus. Provenance lists authored eids; render.ts resolves them to
// native ids (Slack ts / Message-ID / commit SHA / transcript segment).

import type { GoldArtifact, GoldNonArtifact } from "../tools/types.ts";

export const ARTIFACTS: GoldArtifact[] = [
  // ── Decisions ────────────────────────────────────────────────────
  {
    id: "dec-tenancy-single-cluster",
    type: "decision",
    title: "Single Postgres cluster with row-level tenancy (ADR-003)",
    summary:
      "All clinics live in one Postgres cluster with row-level tenancy keyed on clinic_id, instead of a database per clinic. Chosen for operational simplicity and cheap cross-clinic reporting; accepted risk: one bad query affects everyone.",
    occurred_at: "2025-01-14",
    actors: ["dev", "priya", "tom"],
    provenance: ["sl-0109-1", "sl-0109-2", "sl-0109-3", "gc-adr003", "sl-0114-1"],
    scope: "org",
    attrs: {
      question: "Database per clinic, or one cluster with row-level tenancy?",
      alternatives: ["database per clinic", "schema per clinic", "row-level tenancy"],
      resolution: "row-level tenancy on a single cluster",
      consolidation_trajectory: true, // planted: citations early, broad assertions later
    },
  },
  {
    id: "dec-pnpm",
    type: "decision",
    title: "Standardize on pnpm",
    summary: "pnpm replaces npm across the monorepo for install speed and strictness.",
    occurred_at: "2025-01-21",
    actors: ["lena", "marcus"],
    provenance: ["sl-0121-1", "sl-0121-2", "gc-pnpm"],
    scope: "team:eng",
    attrs: {
      question: "npm or pnpm?",
      resolution: "pnpm",
      zero_reference_case: true, // planted: no Reference Events ever — §6.1 age-from-created_at
    },
  },
  {
    id: "dec-twilio-sms",
    type: "decision",
    title: "Use Twilio for SMS reminders; retire the homegrown gateway (ADR-004)",
    summary: "Appointment-reminder SMS goes through Twilio. The half-built in-house SMPP gateway is deleted.",
    occurred_at: "2025-01-28",
    actors: ["tom", "dev"],
    provenance: ["sl-0128-1", "sl-0128-2", "sl-0128-3", "gc-adr004"],
    scope: "team:eng",
    attrs: { question: "Buy or build SMS delivery?", resolution: "Twilio" },
  },
  {
    id: "dec-no-friday-migrations",
    type: "decision",
    title: "No schema migrations on Fridays",
    summary:
      "After the 2025-02-07 outage, schema migrations may not ship on Fridays. Migrations land Monday–Thursday with a staging soak.",
    occurred_at: "2025-02-10",
    actors: ["dev", "priya", "ana"],
    provenance: ["sl-0210-1", "gc-postmortem-0207"],
    scope: "org",
    attrs: {
      resolution: "no Friday schema migrations",
      consolidation_trajectory: true, // flagship: cited Feb–Mar, asserted Apr–Jun by 6 actors, 3 teams
      becomes: "prin-no-friday-migrations",
    },
  },
  {
    id: "dec-utc-iana-tz",
    type: "decision",
    title: "Store UTC + IANA zone rules; never fixed offsets (ADR-005)",
    summary:
      "All times at rest are UTC; clinic-local rendering uses IANA tz identifiers. Fixed offsets are banned after the Melbourne double-booking incident.",
    occurred_at: "2025-02-13",
    actors: ["priya", "dev"],
    provenance: ["sl-0213-1", "gc-adr005"],
    scope: "team:eng",
    attrs: { resolution: "UTC at rest, IANA identifiers for locality" },
  },
  {
    id: "dec-pricing-per-practitioner",
    type: "decision",
    title: "Per-practitioner seat pricing",
    summary:
      "Pricing is per practitioner seat per month, not per booking. Chosen so bills are predictable for clinics and revenue tracks headcount, not utilization.",
    occurred_at: "2025-02-20",
    actors: ["jules", "ray", "maya"],
    provenance: ["em-price-1", "em-price-2", "em-price-3"],
    scope: "org",
    attrs: {
      question: "Per-booking, per-practitioner, or flat tiers?",
      resolution: "per-practitioner seats",
    },
  },
  {
    id: "dec-postpone-baa",
    type: "decision",
    title: "Postpone HIPAA BAAs; target AU/NZ clinics first",
    summary:
      "US healthcare compliance (BAAs) is postponed past v1. Initial go-to-market targets Australian and New Zealand allied-health clinics.",
    occurred_at: "2025-03-05",
    actors: ["maya", "jules", "ray"],
    provenance: ["sl-0305-1", "sl-0305-2"],
    scope: "org",
    attrs: { resolution: "no BAAs pre-v1; AU/NZ first", superseded_by: "dec-sign-baas" },
  },
  {
    id: "dec-trunk-based",
    type: "decision",
    title: "Trunk-based development; drop release branches (ADR-006)",
    summary: "Everyone commits to main behind feature flags; release branches are retired.",
    occurred_at: "2025-03-12",
    actors: ["dev"], // Marcus implemented but didn't decide — his references are genuine rehearsal
    provenance: ["sl-0312-1", "gc-adr006"],
    scope: "team:eng",
    attrs: {
      resolution: "trunk-based",
      decay_case: true, // planted: two references in March, silence after — archival trajectory
    },
  },
  {
    id: "dec-metabase-reports",
    type: "decision",
    title: "Buy not build: Metabase for customer-facing reports",
    summary: "Clinic-facing reporting embeds Metabase rather than building a chart stack.",
    occurred_at: "2025-04-02",
    actors: ["jules", "dev"],
    provenance: ["sl-0402-1", "sl-0402-2"],
    scope: "org",
    attrs: {
      resolution: "embed Metabase",
      dormancy_case: true, // referenced in early April, dormant until a June 25 citation
    },
  },
  {
    id: "dec-sign-baas",
    type: "decision",
    title: "Sign BAAs — HIPAA is table stakes (ADR-007)",
    summary:
      "Reverses the March call: Sundial will sign Business Associate Agreements. The revived Meridian Health deal made US clinics contingent on it.",
    occurred_at: "2025-05-22",
    actors: ["maya", "ray", "dev"],
    provenance: ["ts2-9", "em-baa-2", "gc-adr007"],
    scope: "org",
    attrs: { resolution: "sign BAAs", supersedes: "dec-postpone-baa" },
  },

  // ── Episodes ─────────────────────────────────────────────────────
  {
    id: "epi-friday-migration-outage",
    type: "episode",
    title: "The Friday migration outage (2025-02-07)",
    summary:
      "A Friday-afternoon migration added an index without CONCURRENTLY, locking the bookings table for every clinic (single-cluster tenancy). Three hours of failed bookings; revert plus weekend cleanup.",
    occurred_at: "2025-02-07",
    actors: ["priya", "ana", "dev"],
    provenance: [
      "gc-mig-0207", "sl-0207-1", "sl-0207-2", "sl-0207-3", "sl-0207-4",
      "sl-0207-5", "sl-0207-6", "gc-revert-0207", "gc-postmortem-0207",
    ],
    scope: "org",
  },
  {
    id: "epi-melbourne-double-booking",
    type: "episode",
    title: "Melbourne double-booking (hardcoded +11:00)",
    summary:
      "A hardcoded +11:00 offset for the Kettleworth Physio pilot in Melbourne produced duplicate slots around midnight boundaries; eleven patients double-booked before the fix.",
    occurred_at: "2025-02-12",
    actors: ["tom", "priya", "nadia"],
    provenance: ["sl-0212-1", "sl-0212-2", "sl-0212-3", "sl-0212-4", "gc-fix-tz"],
    scope: "org",
  },
  {
    id: "epi-meridian-loss",
    type: "episode",
    title: "Lost the Meridian Health deal over a missing BAA",
    summary:
      "Meridian Health (14 clinics, largest prospect to date) walked in March: procurement required a signed BAA and Sundial's policy was no BAAs pre-v1. The deal died on a signature, not the product.",
    occurred_at: "2025-03-25",
    actors: ["ray", "maya", "colin"],
    provenance: ["em-meridian-1", "em-meridian-2", "em-meridian-3", "em-meridian-4"],
    scope: "team:gtm",
  },
  {
    id: "epi-ghost-cron",
    type: "episode",
    title: "The ghost cron (staging cron, prod Twilio creds)",
    summary:
      "A staging reminder cron was configured with production Twilio credentials and texted 43 real patients at 3am with test appointments for 'Dr. Placeholder'.",
    occurred_at: "2025-03-20",
    actors: ["ana", "tom", "dev"],
    provenance: ["sl-0320-1", "sl-0320-2", "sl-0320-3", "sl-0320-4", "sl-0320-5", "gc-fix-cron", "gc-postmortem-0320"],
    scope: "org",
  },
  {
    id: "epi-webinar-surge",
    type: "episode",
    title: "PhysioNetwork webinar signup surge",
    summary:
      "A partner webinar drove ~40× normal signups; the signup queue saturated the booking service and onboarding stalled for two hours until token-bucket rate limiting shipped.",
    occurred_at: "2025-04-08",
    actors: ["ana", "marcus", "jules"],
    provenance: ["sl-0408-1", "sl-0408-2", "sl-0408-3", "sl-0409-1", "gc-ratelimit"],
    scope: "org",
  },

  // ── Stories ──────────────────────────────────────────────────────
  {
    id: "story-friday-migration",
    type: "story",
    title: "The Friday Migration",
    summary:
      "How a one-line index change on a Friday afternoon took every clinic down for three hours, and why Sundial doesn't touch the schema before a weekend.",
    occurred_at: "2025-02-07",
    actors: ["priya", "ana", "dev"], // participants — retellings by others are the gold signal
    provenance: ["ts1-7", "sl-0418-1", "sl-0610-1"],
    scope: "org",
    attrs: { moral: "never ship schema migrations on a Friday", teaches: "prin-no-friday-migrations" },
  },
  {
    id: "story-meridian-signature",
    type: "story",
    title: "The deal that died for a signature",
    summary:
      "Meridian Health loved the product and walked over a BAA Sundial refused to sign — the story GTM tells about why compliance is a sales feature.",
    occurred_at: "2025-03-25",
    actors: ["ray", "maya", "colin"],
    provenance: ["sl-0604-1", "sl-0618-1"],
    scope: "org",
    attrs: { moral: "compliance objections are buying signals, not blockers", teaches: null },
  },

  // ── Principles ───────────────────────────────────────────────────
  {
    id: "prin-no-friday-migrations",
    type: "principle",
    title: "Never ship schema migrations on Fridays",
    summary:
      "Schema changes land Monday–Thursday after a staging soak. Consolidated from the 2025-02-07 outage decision; ratified at the March all-hands.",
    occurred_at: "2025-03-14",
    actors: ["maya", "dev", "priya", "ana"],
    provenance: ["ts1-8", "sl-0210-1"],
    scope: "org",
    attrs: { ratified_by: ["maya"], sources: ["dec-no-friday-migrations"], violation_planted: "gc-mig-0530" },
  },
  {
    id: "prin-clinics-own-their-data",
    type: "principle",
    title: "Clinics own their data",
    summary:
      "Every clinic can export everything it has ever entered, in open formats, at no charge, including on the way out. Lock-in is not a retention strategy.",
    occurred_at: "2025-03-14",
    actors: ["maya"],
    provenance: ["ts1-4", "ts1-5"],
    scope: "org",
    attrs: { ratified_by: ["maya"], sources: [] },
  },

  // ── Procedures ───────────────────────────────────────────────────
  {
    id: "proc-release-checklist",
    type: "procedure",
    title: "Release checklist",
    summary:
      "Canonical release steps: changelog, staging deploy, 24h staging soak, smoke suite, prod deploy Tue–Thu, post-release watch.",
    occurred_at: "2025-02-17",
    actors: ["lena"],
    provenance: ["gc-runbook-release"],
    scope: "team:eng",
    attrs: { owner: "lena", canonical_file: "docs/runbooks/release.md" },
  },
  {
    id: "proc-incident-runbook",
    type: "procedure",
    title: "Incident runbook",
    summary:
      "Sev levels, single incident commander, #incidents as the log of record, customer comms templates, 48h postmortem.",
    occurred_at: "2025-01-30",
    actors: ["ana"],
    provenance: ["gc-runbook-incidents"],
    scope: "team:eng",
    attrs: { owner: "ana", canonical_file: "docs/runbooks/incidents.md" },
  },
  {
    id: "proc-deal-desk",
    type: "procedure",
    title: "Deal desk: discount approval",
    summary:
      "Discounts to 15% are rep discretion; anything above 15% needs written CEO sign-off before it reaches the customer.",
    occurred_at: "2025-03-03",
    actors: ["ray"],
    provenance: ["gc-dealdesk"],
    scope: "team:gtm",
    attrs: { owner: "ray", canonical_file: "docs/policies/deal-desk.md" },
  },

  // ── Facts (semantic-tier descriptive; §5.4/§6.3 as amended) ─────
  {
    id: "fact-churn-solo-clinics",
    type: "fact",
    title: "Churn concentrates in solo-practitioner clinics",
    summary:
      "Q1 churn analysis: 9 of 11 churned accounts were single-practitioner clinics; multi-practitioner clinics rarely leave.",
    occurred_at: "2025-04-15",
    actors: ["nadia"],
    provenance: ["em-churn-1", "sl-0415-1"],
    scope: "team:gtm",
    attrs: { stale_after_days: 180 },
  },
  {
    id: "fact-meridian-cfo",
    type: "fact",
    title: "Meridian's real decision-maker is the CFO",
    summary:
      "At Meridian Health the IT director evaluates but the CFO, Dana Whitfield, decides; procurement follows her lead.",
    occurred_at: "2025-03-24",
    actors: ["ray"],
    provenance: ["em-meridian-3"],
    scope: "team:gtm",
    attrs: { stale_after_days: 365 },
  },
  {
    id: "fact-booking-200rps",
    type: "fact",
    title: "Booking service saturates around 200 rps",
    summary:
      "On the shared cluster the booking service degrades hard above roughly 200 requests/second; the ceiling is connection-pool exhaustion, not CPU.",
    occurred_at: "2025-04-09",
    actors: ["ana"],
    provenance: ["sl-0409-2"],
    scope: "team:eng",
    attrs: { stale_after_days: 120 },
  },
  {
    id: "fact-twilio-sandbox-au",
    type: "fact",
    title: "Twilio sandbox numbers can't text AU mobiles",
    summary:
      "Twilio trial/sandbox numbers cannot deliver SMS to Australian mobile numbers; AU testing needs a paid sender with an AU-registered alphanumeric ID.",
    occurred_at: "2025-02-04",
    actors: ["tom"],
    provenance: ["sl-0204-1", "sl-0204-2"],
    scope: "team:eng",
    attrs: { stale_after_days: 240 },
  },
];

// Discussed-but-never-decided — extraction emitting these is a false positive.
export const NON_ARTIFACTS: GoldNonArtifact[] = [
  {
    id: "non-mobile-app",
    would_be_type: "decision",
    title: "Native mobile app",
    why_not:
      "Debated twice in #product with strong opinions on both sides; explicitly left open ('not deciding this quarter'). No commitment marker exists.",
    evidence: ["sl-0326-1", "sl-0326-2", "sl-0326-3", "sl-0326-4", "sl-0421-1", "sl-0421-2"],
  },
  {
    id: "non-vitest",
    would_be_type: "decision",
    title: "Migrate test runner to Vitest",
    why_not: "Raised once in #eng and explicitly parked. Parking is not a resolution.",
    evidence: ["sl-0422-1", "sl-0422-2"],
  },
];
