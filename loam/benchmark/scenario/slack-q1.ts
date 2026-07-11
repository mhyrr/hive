// Slack exhaust, January–March 2025.

import type { SlackMsg } from "../tools/types.ts";

export const SLACK_Q1: SlackMsg[] = [
  // ── January ──────────────────────────────────────────────────────
  { eid: "sl-0106-1", channel: "general", at: "2025-01-06 09:02", user: "maya",
    text: "Happy new year, Sundial. 2025 goal on one line: 100 clinics live and none of them regret it. Kickoff doc in Drive, roast it by Friday." },
  { eid: "sl-0106-2", channel: "general", at: "2025-01-06 09:15", user: "ray",
    text: "19 clinics on the board as of this morning. Let's go." },
  { eid: "sl-0107-1", channel: "eng", at: "2025-01-07 10:20", user: "dev",
    text: "Eng kickoff at 11. Big rocks this quarter: tenancy model, reminders, and not paging Ana at 3am." },
  { eid: "sl-0107-2", channel: "eng", at: "2025-01-07 10:22", user: "ana",
    text: "co-signing that third rock" },

  // D1 debate → decision (provenance)
  { eid: "sl-0109-1", channel: "eng", at: "2025-01-09 14:05", user: "dev",
    text: "Tenancy decision time, for real this week: database per clinic, schema per clinic, or one cluster with row-level tenancy. Thread your takes, ADR Friday-ish." },
  { eid: "sl-0109-2", channel: "eng", at: "2025-01-09 14:31", user: "priya", thread: "sl-0109-1",
    text: "Row-level, strongly. Twelve of us cannot babysit 500 databases, and cross-clinic reporting stays a SQL query instead of an ETL pipeline. RLS policies are mature." },
  { eid: "sl-0109-3", channel: "eng", at: "2025-01-09 15:02", user: "tom", thread: "sl-0109-1",
    text: "I'll take row-level too, but let's be honest in the ADR about the cost: one bad query, one bad lock, and every clinic feels it at once. We're choosing blast radius for operability." },
  { eid: "sl-0114-1", channel: "eng", at: "2025-01-14 11:20", user: "dev",
    text: "ADR-003 is merged: single Postgres cluster, row-level tenancy on clinic_id. Tom's blast-radius caveat is written in as an accepted risk. Speak now or forever hold your migrations." },

  // negative: hiring chat that lexically brushes D1
  { eid: "sl-0116-1", channel: "general", at: "2025-01-16 13:44", user: "dev",
    text: "Interviewed a strong backend candidate this morning — really deep on Postgres internals. No headcount till Q3 but keeping the file warm.",
    negative: { artifact: "dec-tenancy-single-cluster", note: "Mentions Postgres expertise in a hiring context; no reference to the tenancy decision." } },

  // D10 (pnpm) — the zero-reference decision
  { eid: "sl-0121-1", channel: "eng", at: "2025-01-21 09:58", user: "lena",
    text: "npm install took 4m40s on CI just now. I'm switching the repo to pnpm today unless someone objects before EOD." },
  { eid: "sl-0121-2", channel: "eng", at: "2025-01-21 10:03", user: "marcus", thread: "sl-0121-1",
    text: "+1, no objection. workspace file too please" },

  { eid: "sl-0123-1", channel: "gtm", at: "2025-01-23 11:12", user: "nadia",
    text: "Kettleworth Physio (Melbourne) is live as our first AU clinic — pilot terms, weekly check-ins with their front desk. They're lovely and extremely direct, which is perfect." },
  { eid: "sl-0123-2", channel: "gtm", at: "2025-01-23 11:19", user: "ray", thread: "sl-0123-1",
    text: "AU allied health might be our wedge. Watch this space." },

  // D3 (Twilio) — provenance
  { eid: "sl-0128-1", channel: "eng", at: "2025-01-28 15:26", user: "tom",
    text: "SMS status: the homegrown SMPP gateway is three weeks from *maybe* working, and reminders are the most-requested feature we have. Twilio integration is an afternoon. I know which one I want to own at 2am." },
  { eid: "sl-0128-2", channel: "eng", at: "2025-01-28 15:34", user: "dev", thread: "sl-0128-1",
    text: "Kill the gateway. Carrier plumbing is not our business — buy Twilio, delete the SMPP code so nobody resurrects it, write it up." },
  { eid: "sl-0128-3", channel: "eng", at: "2025-01-28 15:41", user: "tom", thread: "sl-0128-1",
    text: "Done and done. ADR-004 incoming, gateway deletion in the same PR. o7" },
  { eid: "sl-0130-1", channel: "eng", at: "2025-01-30 13:40", user: "ana",
    text: "Incident runbook is in the repo (docs/runbooks/incidents.md): sev levels, one IC, comms templates, 48h blameless postmortem. Read it before you need it." },

  // ── February ─────────────────────────────────────────────────────
  // F4 provenance
  { eid: "sl-0204-1", channel: "eng", at: "2025-02-04 16:12", user: "tom",
    text: "TIL the hard way: Twilio sandbox numbers cannot send SMS to Australian mobiles. At all. That's why every staging reminder for Kettleworth has been silently vanishing." },
  { eid: "sl-0204-2", channel: "eng", at: "2025-02-04 16:18", user: "tom", thread: "sl-0204-1",
    text: "For AU you need a paid sender with a registered alphanumeric ID. Filing under things-the-docs-bury. Staging now logs instead of sends for AU numbers." },
  { eid: "sl-0206-1", channel: "eng", at: "2025-02-06 10:05", user: "marcus",
    text: "FYI frontend folks: reminder sends are all Twilio now per ADR-004, so the delivery-status webhooks changed shape. Types updated in src/reminders.",
    refs: [ { artifact: "dec-twilio-sms", kind: "citation", difficulty: "easy", span: "per ADR-004" } ] },

  // INC-1: the Friday migration outage (E1 provenance)
  { eid: "sl-0207-1", channel: "incidents", at: "2025-02-07 16:41", user: "deploybot",
    text: ":rotating_light: ALERT booking-service error rate 43% (threshold 2%). p99 latency 30s+. All tenants affected." },
  { eid: "sl-0207-2", channel: "incidents", at: "2025-02-07 16:44", user: "priya", thread: "sl-0207-1",
    text: "Declaring sev1 per the incident runbook. Ana, can you IC? I think this is my migration — timing lines up with 0007 going out.",
    refs: [ { artifact: "proc-incident-runbook", kind: "instantiation", difficulty: "easy",
      span: "Declaring sev1 per the incident runbook", divergence: 0.1 } ] },
  { eid: "sl-0207-3", channel: "incidents", at: "2025-02-07 16:52", user: "ana", thread: "sl-0207-1",
    text: "IC here. Confirmed: index build from migration 0007 is holding an ACCESS EXCLUSIVE lock on bookings. Every clinic's writes are queued behind it. Options: wait it out (est 2h+) or kill and revert." },
  { eid: "sl-0207-4", channel: "incidents", at: "2025-02-07 17:10", user: "dev", thread: "sl-0207-1",
    text: "Customer comms going out now using the runbook template — 'investigating an issue affecting bookings, next update in 30 minutes.' Nadia is calling Kettleworth directly since it's mid-morning there.",
    refs: [ { artifact: "proc-incident-runbook", kind: "instantiation", difficulty: "medium",
      span: "comms going out now using the runbook template", divergence: 0.15 } ] },
  { eid: "sl-0207-5", channel: "incidents", at: "2025-02-07 19:58", user: "ana", thread: "sl-0207-1",
    text: "Reverted via 0008, locks cleared, error rate back under 1%. Standing reminder from tonight: one bad lock hits every clinic we have — that's the deal we signed up for with a single cluster.",
    refs: [ { artifact: "dec-tenancy-single-cluster", kind: "assertion", difficulty: "hard",
      span: "one bad lock hits every clinic we have — that's the deal we signed up for with a single cluster" } ] },
  { eid: "sl-0207-6", channel: "incidents", at: "2025-02-07 20:15", user: "priya", thread: "sl-0207-1",
    text: "It was mine and it was avoidable: no CONCURRENTLY, no staging soak, shipped at 4:30 on a Friday. Postmortem Monday. I'm buying the retro donuts for a month." },
  { eid: "sl-0208-1", channel: "general", at: "2025-02-08 10:02", user: "maya",
    text: "Rough Friday. Also: watching this team run an incident was genuinely reassuring — calm, fast, honest. Clinics were told the truth before they noticed. That part we keep." },

  // D2 decided (provenance) + E1 postmortem citation
  { eid: "sl-0210-1", channel: "eng", at: "2025-02-10 10:12", user: "dev",
    text: "Decision from the postmortem, effective now: no schema migrations on Fridays. Migrations land Monday–Thursday, after a staging soak, with CONCURRENTLY for index builds. Doc: docs/postmortems/2025-02-07-friday-migration.md" },
  { eid: "sl-0211-1", channel: "eng", at: "2025-02-11 09:30", user: "jules",
    text: "The Friday outage postmortem is genuinely worth ten minutes even for non-eng — it's a masterclass in owning a mistake.",
    refs: [ { artifact: "epi-friday-migration-outage", kind: "citation", difficulty: "medium",
      span: "The Friday outage postmortem" } ] },

  // INC-2: Melbourne double-booking (E2 provenance)
  { eid: "sl-0212-1", channel: "incidents", at: "2025-02-12 21:05", user: "nadia",
    text: "Kettleworth front desk on the phone: they've got double-booked slots around midnight boundaries — eleven patients affected this week. Two people in one 8am slot is a very bad morning at a physio clinic." },
  { eid: "sl-0212-2", channel: "incidents", at: "2025-02-12 21:11", user: "tom", thread: "sl-0212-1",
    text: "sev2, I'll IC per the runbook. Repro'ing against their clinic config now.",
    refs: [ { artifact: "proc-incident-runbook", kind: "instantiation", difficulty: "easy",
      span: "I'll IC per the runbook", divergence: 0.1 } ] },
  { eid: "sl-0212-3", channel: "incidents", at: "2025-02-12 22:31", user: "tom", thread: "sl-0212-1",
    text: "Found it and I hate it: the pilot code has Melbourne hardcoded as +11:00. Melbourne is not always +11:00. Slot expansion runs in 'local' time that's wrong half the year, so midnight-adjacent slots duplicate." },
  { eid: "sl-0212-4", channel: "incidents", at: "2025-02-12 22:40", user: "priya", thread: "sl-0212-1",
    text: "Fixing tonight with a proper IANA tz lookup on the clinic record. And I'm writing the ADR so no one ever types a UTC offset into this codebase again." },
  { eid: "sl-0213-1", channel: "eng", at: "2025-02-13 10:41", user: "priya",
    text: "ADR-005 is up: all timestamps UTC at rest, clinic-local rendering via IANA zone ids, fixed offsets banned in application code. Kettleworth's eleven double-booked patients are the why." },

  { eid: "sl-0214-1", channel: "general", at: "2025-02-14 12:20", user: "sofia",
    text: "New booking flow prototypes are in Figma — nine taps down to four. Kettleworth's front desk tests it Tuesday. Roasts welcome until then." },
  { eid: "sl-0217-1", channel: "eng", at: "2025-02-17 15:10", user: "lena",
    text: "Release checklist is now a real doc (docs/runbooks/release.md): changelog, staging deploy, 24h soak, smoke suite, prod Tue–Thu only, then an hour on dashboards. The soak is the point — plan for it." },
  // D1 assertion (easy)
  { eid: "sl-0219-1", channel: "eng", at: "2025-02-19 11:33", user: "marcus",
    text: "PSA for anyone writing test fixtures: we're single-cluster multi-tenant, so every fixture row needs a clinic_id or RLS will eat your test and tell you nothing.",
    refs: [ { artifact: "dec-tenancy-single-cluster", kind: "assertion", difficulty: "easy",
      span: "we're single-cluster multi-tenant" } ] },
  // negative: innocuous Friday
  { eid: "sl-0221-1", channel: "general", at: "2025-02-21 17:50", user: "colin",
    text: "Friday demo to Coastal Allied went great — front desk lead literally applauded the waitlist screen. Good weekend, everyone.",
    negative: { artifact: "dec-no-friday-migrations", note: "'Friday' in a sales context; no relation to the migration rule." } },
  { eid: "sl-0225-1", channel: "gtm", at: "2025-02-25 09:41", user: "ray",
    text: "Pricing email is out (thread with Maya/Jules) — per-practitioner seats, $29, flat as they grow. Requoting the open pipeline this week. It quotes itself in one sentence, which is the best feature pricing can have." },
  { eid: "sl-0226-1", channel: "eng", at: "2025-02-26 14:02", user: "deploybot",
    text: "CI: main green after 3 red runs (flaky reminder test quarantined as SUN-212)." },

  // ── March ────────────────────────────────────────────────────────
  { eid: "sl-0303-1", channel: "gtm", at: "2025-03-03 11:30", user: "ray",
    text: "Deal desk policy is now written down in the repo (docs/policies/deal-desk.md): 15% is your discretion, above that you get Maya's written sign-off BEFORE the customer hears a number. No exceptions, including for me." },
  // D5 decided (provenance)
  { eid: "sl-0305-1", channel: "product", at: "2025-03-05 16:20", user: "maya",
    text: "Calling the compliance question: we hold on HIPAA BAAs until after v1 and point the pipeline at AU/NZ allied health, where the pull already is. US clinic groups will still be there when we're ready. Revisit only if the US pull becomes undeniable." },
  { eid: "sl-0305-2", channel: "product", at: "2025-03-05 16:29", user: "jules", thread: "sl-0305-1",
    text: "Agreed — writing it into the Q2 roadmap and the sales one-pager. Eng time freed up goes to recurring availability." },
  { eid: "sl-0307-1", channel: "general", at: "2025-03-07 12:15", user: "nadia",
    text: "Milestone: 30 clinics live. Number 30 is a three-practitioner chiro group in Auckland who found us from the Kettleworth case study." },

  // D6 decided + its only two references (decay case)
  { eid: "sl-0312-1", channel: "eng", at: "2025-03-12 09:45", user: "dev",
    text: "ADR-006 accepted: trunk-based development starting Monday. Release branches are retired — everyone commits to main behind flags, releases become a tag plus the checklist." },
  { eid: "sl-0318-1", channel: "eng", at: "2025-03-18 17:25", user: "marcus",
    text: "One week of trunk-based per ADR-006: zero merge hell, one flag mishap (mine), net enormous win. Believer.",
    refs: [ { artifact: "dec-trunk-based", kind: "citation", difficulty: "easy", span: "per ADR-006" } ] },

  // E5: the ghost cron (provenance)
  { eid: "sl-0320-1", channel: "incidents", at: "2025-03-20 08:02", user: "nadia",
    text: "Kettleworth's front desk called — multiple patients got SMS at 3am about an appointment with 'Dr. Placeholder'?? Patients are confused, one is annoyed, front desk is (mercifully) laughing." },
  { eid: "sl-0320-2", channel: "incidents", at: "2025-03-20 08:06", user: "ana", thread: "sl-0320-1",
    text: "sev2, IC me, runbook's open. If 'Dr. Placeholder' is texting real patients, staging has escaped containment.",
    refs: [ { artifact: "proc-incident-runbook", kind: "instantiation", difficulty: "medium",
      span: "IC me, runbook's open", divergence: 0.05, self_reference: true } ] },
  { eid: "sl-0320-3", channel: "incidents", at: "2025-03-20 08:24", user: "tom", thread: "sl-0320-1",
    text: "Found it: the staging reminder sweep cron is configured with PROD Twilio creds — copied from the prod config during the Twilio cutover and never re-pointed at sandbox. 43 real patients got test reminders." },
  { eid: "sl-0320-4", channel: "incidents", at: "2025-03-20 08:31", user: "ana", thread: "sl-0320-1",
    text: "Cron disabled, creds fix going out now, staging secrets getting namespaced today so this class of mistake stops compiling. Postmortem tomorrow." },
  { eid: "sl-0320-5", channel: "incidents", at: "2025-03-20 09:15", user: "dev", thread: "sl-0320-1",
    text: "I'm personally calling all 43 patients this morning to apologize — deviating from the comms template on purpose; a 3am ghost text deserves a human voice, not another message.",
    refs: [ { artifact: "proc-incident-runbook", kind: "instantiation", difficulty: "hard",
      span: "deviating from the comms template on purpose", divergence: 0.3 } ] },
  { eid: "sl-0321-1", channel: "incidents", at: "2025-03-21 10:30", user: "ana",
    text: "Ghost cron postmortem is up. Related gotcha for the fix verification: sandbox numbers can't text AU mobiles anyway, so don't expect the staging watermark test to reach Kettleworth — check the logs instead.",
    refs: [ { artifact: "fact-twilio-sandbox-au", kind: "assertion", difficulty: "medium",
      span: "sandbox numbers can't text AU mobiles anyway" } ] },

  // E5 echo in #general (episode citation by a non-participant)
  { eid: "sl-0328-1", channel: "general", at: "2025-03-28 13:37", user: "sofia",
    text: "Petition to make 'Dr. Placeholder' the name of the office plant. Too soon?",
    refs: [ { artifact: "epi-ghost-cron", kind: "citation", difficulty: "hard",
      span: "'Dr. Placeholder'" } ] },

  // Mobile app debate — planted NON-decision
  { eid: "sl-0326-1", channel: "product", at: "2025-03-26 14:10", user: "jules",
    text: "Quarterly ritual: should we build a native mobile app? Practitioners keep asking for schedule-on-phone. The mobile web experience is fine-ish but 'fine-ish' loses demos." },
  { eid: "sl-0326-2", channel: "product", at: "2025-03-26 14:22", user: "sofia", thread: "sl-0326-1",
    text: "Design take: a thin native app that's just today's schedule + notifications would be 80% of the ask. But it's still two app stores of ongoing pain." },
  { eid: "sl-0326-3", channel: "product", at: "2025-03-26 14:37", user: "dev", thread: "sl-0326-1",
    text: "Eng take: not this year. Two platforms, review queues, release lag — all to reimplement a schedule screen we already ship. Make mobile web excellent first." },
  { eid: "sl-0326-4", channel: "product", at: "2025-03-26 15:01", user: "jules", thread: "sl-0326-1",
    text: "Parking it: we are explicitly NOT deciding this quarter. Revisit with Q2 usage data on mobile web sessions." },

  { eid: "sl-0331-1", channel: "general", at: "2025-03-31 16:44", user: "maya",
    text: "Q1 closes with 34 clinics, one lost deal that stung, two incidents we owned honestly, and a team I'd take into any market. Q2: onwards." },
];
