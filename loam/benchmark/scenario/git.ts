// Git history for the sundial repo, rendered to a fast-import stream.
// Commit SHAs are deterministic (fixed author/committer dates), and
// render.ts resolves eids → SHAs via the fast-import marks file.

import type { Commit } from "../tools/types.ts";

export const COMMITS: Commit[] = [
  {
    eid: "gc-init",
    at: "2025-01-06 09:12",
    author: "dev",
    message: "init: repo scaffold, ADR process",
    files: {
      "README.md": `# sundial

Scheduling for clinics. Booking, reminders, rosters.

- \`src/\` services
- \`migrations/\` schema changes
- \`adr/\` architecture decision records
- \`docs/\` runbooks, policies, postmortems
`,
      "package.json": `{
  "name": "sundial",
  "private": true,
  "version": "0.1.0"
}
`,
      "adr/0001-record-decisions.md": `# ADR-001: Record architecture decisions

Status: accepted 2025-01-06

We keep ADRs in \`adr/\`, numbered, immutable once accepted. A superseding
ADR links back to what it replaces.
`,
    },
  },
  {
    eid: "gc-scaffold",
    at: "2025-01-08 15:40",
    author: "priya",
    message: "scaffold booking and scheduling services",
    files: {
      "src/booking/index.ts": `// booking service: slots, holds, confirmations
export const service = "booking";
`,
      "src/scheduling/index.ts": `// scheduling service: rosters, availability rules
export const service = "scheduling";
`,
    },
  },
  {
    eid: "gc-adr003",
    at: "2025-01-14 11:05",
    author: "dev",
    message: "ADR-003: single cluster, row-level tenancy",
    files: {
      "adr/0003-tenancy.md": `# ADR-003: Single Postgres cluster, row-level tenancy

Status: accepted 2025-01-14

## Question
Database per clinic, schema per clinic, or one cluster with row-level
tenancy?

## Decision
One Postgres cluster. Every tenant-owned row carries \`clinic_id\`;
row-level security policies enforce isolation.

## Why
Twelve people cannot operate five hundred databases. Cross-clinic
reporting stays a query instead of an ETL project.

## Accepted risk
A bad query or a table lock affects every clinic at once. Blast radius
is the price of operational simplicity.
`,
    },
  },
  {
    eid: "gc-pnpm",
    at: "2025-01-21 10:22",
    author: "lena",
    message: "build: standardize on pnpm",
    files: {
      "pnpm-workspace.yaml": `packages:
  - "src/*"
`,
      ".npmrc": `engine-strict=true
`,
    },
  },
  {
    eid: "gc-adr004",
    at: "2025-01-28 16:48",
    author: "tom",
    message: "ADR-004: Twilio for reminder SMS; delete SMPP gateway",
    files: {
      "adr/0004-twilio.md": `# ADR-004: Twilio for SMS reminders

Status: accepted 2025-01-28

Reminder SMS goes through Twilio. The half-built in-house SMPP gateway
is deleted; carrier relationships are not our business.
`,
      "src/sms-gateway/index.ts": null,
    },
  },
  {
    eid: "gc-runbook-incidents",
    at: "2025-01-30 13:31",
    author: "ana",
    message: "docs: incident runbook",
    files: {
      "docs/runbooks/incidents.md": `# Incident runbook

1. Declare in #incidents with a sev level.
   - sev1: clinics cannot book. sev2: degraded. sev3: cosmetic.
2. One incident commander (IC). IC speaks in #incidents; everyone else
   replies in thread.
3. Timeline in the channel is the log of record.
4. sev1/sev2: customer comms within 30 minutes (template below).
5. Postmortem within 48h in docs/postmortems/, blameless.

Comms template: "We're investigating an issue affecting <surface>.
Bookings made in this window may need re-confirmation. Next update in
30 minutes."
`,
    },
  },
  {
    eid: "gc-reminders",
    at: "2025-02-03 12:02",
    author: "tom",
    message: "reminders: wire Twilio client per ADR-004",
    files: {
      "src/reminders/twilio.ts": `// Twilio sender. Sandbox creds in staging, prod creds via vault.
export async function sendReminder(to: string, body: string) {
  /* twilio.messages.create(...) */
}
`,
    },
    refs: [
      {
        artifact: "dec-twilio-sms",
        kind: "citation",
        difficulty: "easy",
        span: "per ADR-004",
        self_reference: true, // Tom drove ADR-004
      },
    ],
  },
  {
    eid: "gc-mig-0207",
    at: "2025-02-07 16:26", // Friday afternoon — the one that started it all
    author: "priya",
    message: "migration: index bookings(clinic_id, starts_at)",
    files: {
      "migrations/0007_add_booking_idx.sql": `-- speed up availability lookups
CREATE INDEX idx_bookings_clinic_start ON bookings (clinic_id, starts_at);
`,
    },
  },
  {
    eid: "gc-revert-0207",
    at: "2025-02-07 19:54",
    author: "ana",
    message: "revert: drop idx_bookings_clinic_start migration (locked bookings table)",
    files: {
      "migrations/0008_drop_booking_idx.sql": `-- emergency revert of 0007; rebuild will use CREATE INDEX CONCURRENTLY
DROP INDEX IF EXISTS idx_bookings_clinic_start;
`,
    },
  },
  {
    eid: "gc-postmortem-0207",
    at: "2025-02-10 09:47",
    author: "dev",
    message: "postmortem: 2025-02-07 booking outage",
    files: {
      "docs/postmortems/2025-02-07-friday-migration.md": `# Postmortem: Friday migration outage (2025-02-07)

Blameless. Timeline from #incidents.

At 16:26 on a Friday, migration 0007 created an index on \`bookings\`
without CONCURRENTLY. On our single shared cluster (ADR-003) the
ACCESS EXCLUSIVE lock queued every clinic's booking writes. Three
hours of failed bookings across all tenants; reverted 19:54; weekend
spent reconciling holds.

## Contributing factors
- Index build not CONCURRENTLY.
- Shipped at 16:26 on a Friday with no staging soak and half the team
  offline.
- Single-cluster tenancy concentrates blast radius (accepted in
  ADR-003 — this is what that acceptance costs).

## Action items
- [x] Migrations land Monday–Thursday only, after a staging soak.
- [x] Lint migrations for non-concurrent index builds.
`,
    },
    refs: [
      {
        artifact: "dec-tenancy-single-cluster",
        kind: "citation",
        difficulty: "easy",
        span: "our single shared cluster (ADR-003)",
        self_reference: true, // Dev drove ADR-003
      },
    ],
  },
  {
    eid: "gc-fix-tz",
    at: "2025-02-12 22:15",
    author: "tom-alt", // Tom's personal-laptop identity — entity-resolution gold
    message: "fix: replace hardcoded +11:00 offset with IANA tz lookup",
    files: {
      "src/scheduling/tz.ts": `// Clinic-local time from UTC + IANA zone id. Never fixed offsets:
// offsets lie twice a year and Kettleworth found out the hard way.
export function clinicLocal(utc: Date, zone: string): Date {
  return new Date(utc.toLocaleString("en-US", { timeZone: zone }));
}
`,
    },
  },
  {
    eid: "gc-adr005",
    at: "2025-02-13 10:33",
    author: "priya",
    message: "ADR-005: UTC at rest, IANA zone rules, no fixed offsets",
    files: {
      "adr/0005-utc-iana.md": `# ADR-005: UTC at rest, IANA identifiers for locality

Status: accepted 2025-02-13

All timestamps are stored UTC. Clinic-local rendering derives from an
IANA tz identifier on the clinic record. Fixed offsets are banned in
application code; the Melbourne double-booking incident is why.
`,
    },
  },
  {
    eid: "gc-runbook-release",
    at: "2025-02-17 14:58",
    author: "lena",
    message: "docs: release checklist",
    files: {
      "docs/runbooks/release.md": `# Release checklist

1. Changelog entry with clinic-visible changes called out.
2. Deploy to staging.
3. 24h staging soak (no skipping — the soak is the checklist).
4. Smoke suite green: booking, reminder send, export.
5. Prod deploy Tuesday–Thursday only.
6. Post-release watch: 60 minutes on dashboards, then hand to on-call.
`,
    },
  },
  {
    eid: "gc-dealdesk",
    at: "2025-03-03 11:17",
    author: "dev",
    message: "docs: deal-desk discount policy (authored by Ray)",
    files: {
      "docs/policies/deal-desk.md": `# Deal desk: discount approval

- Up to 15% off list: rep discretion, note it in the CRM.
- Above 15%: written CEO sign-off BEFORE the number reaches the
  customer. Forward the sign-off email into the deal record.
- Never discount the export/offboarding fee. There isn't one, and
  there never will be (clinics own their data).
`,
    },
    refs: [
      {
        artifact: "prin-clinics-own-their-data",
        kind: "assertion",
        difficulty: "medium",
        span: "clinics own their data",
      },
    ],
  },
  {
    eid: "gc-adr006",
    at: "2025-03-12 09:26",
    author: "dev",
    message: "ADR-006: trunk-based development",
    files: {
      "adr/0006-trunk-based.md": `# ADR-006: Trunk-based development

Status: accepted 2025-03-12

Everyone commits to main behind feature flags. Release branches are
retired; a release is a tag plus the checklist.
`,
    },
  },
  {
    eid: "gc-flags",
    at: "2025-03-13 17:09",
    author: "marcus",
    message: "flags: minimal feature-flag store for the trunk-based flow per ADR-006",
    files: {
      "src/flags.ts": `export const flags: Record<string, boolean> = {};
export const isOn = (k: string) => flags[k] === true;
`,
    },
    refs: [
      {
        artifact: "dec-trunk-based",
        kind: "citation",
        difficulty: "easy",
        span: "per ADR-006",
      },
    ],
  },
  {
    eid: "gc-fix-cron",
    at: "2025-03-20 07:44",
    author: "ana",
    message: "fix: staging reminder cron must use sandbox Twilio creds",
    files: {
      "infra/cron/staging.yaml": `reminder-sweep:
  schedule: "0 3 * * *"
  env: staging
  secrets:
    twilio: sandbox   # was: prod. Never again.
`,
    },
  },
  {
    eid: "gc-postmortem-0320",
    at: "2025-03-21 10:12",
    author: "ana",
    message: "postmortem: 2025-03-20 ghost cron",
    files: {
      "docs/postmortems/2025-03-20-ghost-cron.md": `# Postmortem: the ghost cron (2025-03-20)

The staging reminder sweep ran at 03:00 with production Twilio
credentials and texted 43 real patients about appointments with
"Dr. Placeholder". Root cause: staging cron config copied from prod
during the Twilio cutover and never re-pointed at sandbox creds.

Patients were called and apologized to by 09:30. Kettleworth's front
desk was extremely gracious about it.

## Action items
- [x] Staging secrets namespaced; prod creds unreadable from staging.
- [x] Sends from staging watermark the message body.
`,
    },
    refs: [
      {
        artifact: "dec-twilio-sms",
        kind: "assertion",
        difficulty: "hard",
        span: "during the Twilio cutover",
      },
    ],
  },
  {
    eid: "gc-ratelimit",
    at: "2025-04-09 12:41",
    author: "ana",
    message: "signup: token-bucket rate limit after the webinar surge",
    files: {
      "src/signup/ratelimit.ts": `// Token bucket in front of clinic onboarding. The webinar taught us
// the booking service saturates near 200 rps; keep signups under it.
export const bucket = { capacity: 50, refillPerSec: 10 };
`,
    },
    refs: [
      {
        artifact: "epi-webinar-surge",
        kind: "citation",
        difficulty: "medium",
        span: "after the webinar surge",
        self_reference: true, // Ana fought the surge she is citing
      },
      {
        artifact: "fact-booking-200rps",
        kind: "assertion",
        difficulty: "medium",
        span: "the booking service saturates near 200 rps",
        self_reference: true, // Ana is the fact's author — weight 0 under §6.4
      },
    ],
  },
  {
    eid: "gc-release-1-4",
    at: "2025-05-13 15:20",
    author: "deploybot", // agent-authored exhaust referencing a Procedure
    message: "release: 1.4.0 — checklist complete per docs/runbooks/release.md",
    files: {
      "CHANGELOG.md": `# Changelog

## 1.4.0 — 2025-05-13
- Recurring availability rules
- Clinic CSV import
`,
    },
    refs: [
      {
        artifact: "proc-release-checklist",
        kind: "citation",
        difficulty: "easy",
        span: "checklist complete per docs/runbooks/release.md",
      },
    ],
  },
  {
    eid: "gc-adr007",
    at: "2025-05-22 16:03",
    author: "dev",
    message: "ADR-007: sign BAAs (supersedes the March BAA postponement)",
    files: {
      "adr/0007-baa.md": `# ADR-007: Sign Business Associate Agreements

Status: accepted 2025-05-22. Supersedes the 2025-03-05 decision to
postpone BAAs past v1.

US clinics are contingent on a signed BAA — Meridian re-opened on
exactly this condition. Legal review done; audit-logging gaps close in
1.5.
`,
    },
    refs: [
      {
        artifact: "dec-postpone-baa",
        kind: "citation",
        difficulty: "easy",
        span: "supersedes the March BAA postponement",
      },
    ],
  },
  {
    eid: "gc-mig-0530",
    at: "2025-05-30 17:12", // Friday — planted violation of prin-no-friday-migrations
    author: "tom-alt",
    message: "migration: practitioner_specialties table",
    files: {
      "migrations/0019_practitioner_specialties.sql": `CREATE TABLE practitioner_specialties (
  practitioner_id uuid NOT NULL,
  specialty text NOT NULL
);
`,
    },
    refs: [
      {
        artifact: "prin-no-friday-migrations",
        kind: "assertion",
        difficulty: "hard",
        span: "migration: practitioner_specialties table",
        violation: true, // shipped 17:12 on a Friday — enactment-gap evidence
      },
    ],
  },
  {
    eid: "gc-fix-0602",
    at: "2025-06-02 09:36",
    author: "priya",
    message: "fix: backfill specialties index on a Monday, per the no-Friday-migrations rule",
    files: {
      "migrations/0020_specialties_idx.sql": `CREATE INDEX CONCURRENTLY idx_prac_spec ON practitioner_specialties (practitioner_id);
`,
    },
    refs: [
      {
        artifact: "prin-no-friday-migrations",
        kind: "citation",
        difficulty: "easy",
        span: "per the no-Friday-migrations rule",
        self_reference: true, // Priya is among the principle's source actors
      },
    ],
  },
  {
    eid: "gc-tzfix-0605",
    at: "2025-06-05 13:27",
    author: "priya",
    message: "fix: normalize recurring-slot tz handling per ADR-005",
    files: {
      "src/scheduling/recurring.ts": `// Expand recurring rules in UTC, render clinic-local at the edge.
export function expand(ruleUtc: string, zone: string): Date[] {
  return [];
}
`,
    },
    refs: [
      {
        artifact: "dec-utc-iana-tz",
        kind: "citation",
        difficulty: "easy",
        span: "per ADR-005",
        self_reference: true, // Priya authored ADR-005
      },
    ],
  },
  {
    eid: "gc-export",
    at: "2025-06-17 11:49",
    author: "marcus",
    message: "export: full clinic data export to CSV — clinics own their data, including on the way out",
    files: {
      "src/export/csv.ts": `// Everything a clinic ever entered, in open formats, free.
export function exportClinic(clinicId: string): string {
  return "";
}
`,
    },
    refs: [
      {
        artifact: "prin-clinics-own-their-data",
        kind: "assertion",
        difficulty: "easy",
        span: "clinics own their data, including on the way out",
      },
    ],
  },
];
