// Slack exhaust, April–June 2025.

import type { SlackMsg } from "../tools/types.ts";

export const SLACK_Q2: SlackMsg[] = [
  // ── April ────────────────────────────────────────────────────────
  // D8 decided (provenance) + immediate citation, then dormancy
  { eid: "sl-0402-1", channel: "product", at: "2025-04-02 15:05", user: "jules",
    text: "Reports decision from today's call: we embed Metabase for clinic-facing reporting instead of building a chart stack. Dev sized the embed at about a week; building charts ourselves was a quarter, minimum." },
  { eid: "sl-0402-2", channel: "product", at: "2025-04-02 15:12", user: "dev", thread: "sl-0402-1",
    text: "+1. Buy not build — our in-house charting ambitions go to the graveyard with the SMPP gateway, where they'll be very happy together." },
  { eid: "sl-0403-1", channel: "eng", at: "2025-04-03 10:14", user: "lena",
    text: "Spiking the Metabase embed this week per yesterday's reports decision. Filters and clinic-scoping look straightforward under RLS.",
    refs: [ { artifact: "dec-metabase-reports", kind: "citation", difficulty: "easy",
      span: "per yesterday's reports decision" } ] },

  // E4: webinar surge (provenance)
  { eid: "sl-0408-1", channel: "incidents", at: "2025-04-08 19:12", user: "deploybot",
    text: ":warning: signup queue depth 1,840 (threshold 100). booking-service p99 9.4s. onboarding jobs stalled." },
  { eid: "sl-0408-2", channel: "incidents", at: "2025-04-08 19:16", user: "marcus", thread: "sl-0408-1",
    text: "It's the PhysioNetwork webinar — they demoed us live to ~2,000 clinics and dropped the signup link at the end. Signups running about 40x normal." },
  { eid: "sl-0408-3", channel: "incidents", at: "2025-04-08 19:19", user: "ana", thread: "sl-0408-1",
    text: "sev2, IC me, runbook open. Good news: it's a queue, not a crash. Bad news: signups are hammering the same pool bookings use.",
    refs: [ { artifact: "proc-incident-runbook", kind: "instantiation", difficulty: "easy",
      span: "IC me, runbook open", divergence: 0.05, self_reference: true } ] },
  { eid: "sl-0409-1", channel: "incidents", at: "2025-04-09 13:02", user: "ana", thread: "sl-0408-1",
    text: "Resolved: token-bucket rate limit on onboarding shipped, queue drained overnight, zero clinics lost. PhysioNetwork wants to do it again in the fall — next time we'll know they're coming." },
  // F3 provenance
  { eid: "sl-0409-2", channel: "eng", at: "2025-04-09 15:47", user: "ana",
    text: "Load-test results from last night's fun: the booking service falls over around 200 rps on the shared cluster — and it's connection-pool exhaustion, not CPU. Wrote it on the wall; plan capacity accordingly." },

  { eid: "sl-0410-1", channel: "general", at: "2025-04-10 09:20", user: "jules",
    text: "Silver lining tally from the webinar: 61 new clinic signups stuck, all onboarded by this morning. Hi, new clinics. :wave:" },

  // F1 provenance echo in slack
  { eid: "sl-0415-1", channel: "gtm", at: "2025-04-15 13:35", user: "nadia",
    text: "Q1 churn readout is in your inboxes. Headline: 9 of our 11 churns were solo-practitioner clinics. Multi-practitioner groups basically don't leave. Full numbers in the email." },
  { eid: "sl-0416-1", channel: "gtm", at: "2025-04-16 10:08", user: "ray", thread: "sl-0415-1",
    text: "Acting on it immediately: qualification bar is now 2+ practitioners. Solo clinics go self-serve or not at all." },

  // D2 assertion — tom (easy)
  { eid: "sl-0417-1", channel: "eng", at: "2025-04-17 11:26", user: "tom",
    text: "Reviewing the availability PR today; the migration half waits for Monday obviously — no Friday migrations — but the read-path half can ship whenever.",
    refs: [ { artifact: "dec-no-friday-migrations", kind: "assertion", difficulty: "easy",
      span: "no Friday migrations" } ] },

  // S1 retelling — marcus (#general, non-participant)
  { eid: "sl-0418-1", channel: "general", at: "2025-04-18 16:55", user: "marcus",
    text: "Explaining our deploy rules to a friend and realized the origin story deserves retelling: once upon a February, one innocent one-line index migration went out at 4:30pm on a Friday and every clinic we had was down for three hours. Priya still twitches when anyone types CREATE INDEX without CONCURRENTLY.",
    refs: [ { artifact: "story-friday-migration", kind: "retelling", difficulty: "medium",
      span: "one innocent one-line index migration went out at 4:30pm on a Friday and every clinic we had was down for three hours" } ] },

  // Mobile debate, round two — still a non-decision
  { eid: "sl-0421-1", channel: "product", at: "2025-04-21 14:12", user: "marcus",
    text: "Mobile app question again? Q2 data's in: mobile web is 31% of practitioner sessions and climbing." },
  { eid: "sl-0421-2", channel: "product", at: "2025-04-21 14:30", user: "jules", thread: "sl-0421-1",
    text: "Noted and still parked — 31% says make mobile web better, not fork the roadmap. We'll look again with Q3 numbers." },

  // Vitest — planted non-decision
  { eid: "sl-0422-1", channel: "eng", at: "2025-04-22 12:03", user: "marcus",
    text: "Pitch: migrate the test runner to Vitest. It's 3x faster on my machine and the mocks are saner." },
  { eid: "sl-0422-2", channel: "eng", at: "2025-04-22 12:15", user: "dev", thread: "sl-0422-1",
    text: "Tempting, but parking this until after 1.5 — a test-runner migration mid-release-crunch is how we end up starring in our own postmortem. Bring it back in June." },

  // D2 assertion — jules (medium, #product)
  { eid: "sl-0424-1", channel: "product", at: "2025-04-24 15:38", user: "jules",
    text: "Timeline note for the 1.4 plan: the waitlist data model lands early in the week — we don't touch the schema on Fridays, so if it slips past Thursday it slips to Monday and the feature slips a week.",
    refs: [ { artifact: "dec-no-friday-migrations", kind: "assertion", difficulty: "medium",
      span: "we don't touch the schema on Fridays" } ] },

  // D1 assertion — jules (medium)
  { eid: "sl-0430-1", channel: "product", at: "2025-04-30 11:22", user: "jules",
    text: "Fun fact for the PhysioNetwork case study: cross-clinic benchmarks are essentially free for us because every clinic lives in the same cluster — competitors quote a data-warehouse project for what we do with one query.",
    refs: [ { artifact: "dec-tenancy-single-cluster", kind: "assertion", difficulty: "medium",
      span: "every clinic lives in the same cluster" } ] },

  // ── May ──────────────────────────────────────────────────────────
  // D7 assertion — marcus (easy)
  { eid: "sl-0501-1", channel: "eng", at: "2025-05-01 10:31", user: "marcus",
    text: "Reminder for the export work: everything is UTC at rest, clinic-local is derived at render time via the clinic's IANA zone. Do not store local times, do not store offsets.",
    refs: [ { artifact: "dec-utc-iana-tz", kind: "assertion", difficulty: "easy",
      span: "everything is UTC at rest" } ] },

  // negative: Twilio brand mention, unrelated to the decision
  { eid: "sl-0505-1", channel: "gtm", at: "2025-05-05 09:47", user: "colin",
    text: "Prospect question I couldn't answer: do we integrate with Twilio Flex for their call-center? Anyone know what Flex even is?",
    negative: { artifact: "dec-twilio-sms", note: "Mentions Twilio (Flex, a different product) in a prospect question; not a reference to the SMS decision." } },

  // D2 assertion — lena (medium)
  { eid: "sl-0508-1", channel: "eng", at: "2025-05-08 14:19", user: "lena",
    text: "1.4 cut is Thursday. Anything with a schema change that isn't merged by Wednesday night waits for Monday — you know the rule, plan backwards from it.",
    refs: [ { artifact: "dec-no-friday-migrations", kind: "assertion", difficulty: "medium",
      span: "Anything with a schema change that isn't merged by Wednesday night waits for Monday" } ] },

  // Release 1.4 — clean checklist instantiation (marcus, non-owner)
  { eid: "sl-0512-1", channel: "eng", at: "2025-05-12 16:40", user: "marcus",
    text: "1.4 release thread: running the release checklist — changelog done, staging deployed 15:00, soak clock started, smoke suite green this morning. Prod goes tomorrow (Tuesday) per the checklist.",
    refs: [ { artifact: "proc-release-checklist", kind: "instantiation", difficulty: "easy",
      span: "running the release checklist", divergence: 0.05 } ] },
  { eid: "sl-0513-1", channel: "eng", at: "2025-05-13 15:25", user: "deploybot", thread: "sl-0512-1",
    text: "release 1.4.0 deployed to prod. dashboards nominal. changelog: recurring availability rules, clinic CSV import." },

  // D7 assertion — nadia (hard, #gtm support script)
  { eid: "sl-0515-1", channel: "gtm", at: "2025-05-15 11:52", user: "nadia",
    text: "Support-script addition after two confused tickets: appointment times in CSV exports are stored times, which are UTC — the clinic-local column is computed for display. If a clinic says 'the export times are wrong', they're reading the UTC column.",
    refs: [ { artifact: "dec-utc-iana-tz", kind: "assertion", difficulty: "hard",
      span: "appointment times in CSV exports are stored times, which are UTC" } ] },

  // F2 citation — colin
  { eid: "sl-0521-1", channel: "gtm", at: "2025-05-21 09:18", user: "colin",
    text: "Prepping the Meridian proposal — re-reading Ray's intel from March: Whitfield (CFO) is the actual decision-maker and she reads the compliance page first. Leading with the BAA commitment, product tour second.",
    refs: [ { artifact: "fact-meridian-cfo", kind: "citation", difficulty: "easy",
      span: "Ray's intel from March: Whitfield (CFO) is the actual decision-maker" } ] },

  // D2 assertion — nadia (medium, #gtm)
  { eid: "sl-0522-1", channel: "gtm", at: "2025-05-22 14:33", user: "nadia",
    text: "For onboarding scheduling: remember eng has a Friday freeze on database changes, so clinic go-lives that need custom fields should target Tuesday–Thursday.",
    refs: [ { artifact: "dec-no-friday-migrations", kind: "assertion", difficulty: "medium",
      span: "eng has a Friday freeze on database changes" } ] },

  // D9 announced org-wide (jules citing — non-participant)
  { eid: "sl-0523-1", channel: "product", at: "2025-05-23 10:05", user: "jules",
    text: "Roadmap update: now that we've decided to sign BAAs (ADR-007), audit logging jumps the queue and rides 1.5. Recurring-availability polish slides two weeks. Meridian is worth it.",
    refs: [ { artifact: "dec-sign-baas", kind: "citation", difficulty: "easy",
      span: "we've decided to sign BAAs (ADR-007)" } ] },

  // Release 1.5 — divergent instantiation (tom skips the soak)
  { eid: "sl-0526-1", channel: "eng", at: "2025-05-26 11:20", user: "tom",
    text: "1.5 release thread: checklist mostly done — changelog ✓, staging ✓, smoke green. I'm skipping the 24h soak so the audit-logging beta is live before Thursday's Meridian walkthrough. Deploying at 2.",
    refs: [ { artifact: "proc-release-checklist", kind: "instantiation", difficulty: "medium",
      span: "I'm skipping the 24h soak", divergence: 0.4 } ] },
  { eid: "sl-0526-2", channel: "eng", at: "2025-05-26 11:34", user: "lena", thread: "sl-0526-1",
    text: "On the record: the soak is not the optional part, the soak is the *point* of the checklist. I won't block a Meridian-critical deploy, but if 1.5 pages someone tonight, the postmortem writes itself.",
    refs: [ { artifact: "proc-release-checklist", kind: "citation", difficulty: "medium",
      span: "the soak is the *point* of the checklist", self_reference: true } ] },

  // Friday violation callout (Tom's gc-mig-0530) — marcus assertion (hard)
  { eid: "sl-0530-1", channel: "eng", at: "2025-05-30 17:26", user: "ana",
    text: "Tom. It is 5pm. On a Friday. And migration 0019 just landed on main." },
  { eid: "sl-0530-2", channel: "eng", at: "2025-05-30 17:31", user: "marcus", thread: "sl-0530-1",
    text: "It's Thursday-or-Monday, man, that rule is written in outage blood. Revert the deploy job and let the table land Monday with Priya's index.",
    refs: [ { artifact: "dec-no-friday-migrations", kind: "assertion", difficulty: "hard",
      span: "It's Thursday-or-Monday, man, that rule is written in outage blood" } ] },
  { eid: "sl-0530-3", channel: "eng", at: "2025-05-30 17:40", user: "tom", thread: "sl-0530-1",
    text: "…yeah, fair. Deploy job cancelled, table ships Monday. In my defense it's a CREATE TABLE, not an index — but the rule is the rule because we argued exactly this at 7pm on Feb 7." },

  // ── June ─────────────────────────────────────────────────────────
  // Venue-gaming plant: author re-broadcasts his own decision to the widest channel
  { eid: "sl-0603-1", channel: "general", at: "2025-06-03 09:41", user: "dev",
    text: "Context for everyone as we scale past 50 clinics — per ADR-003 all clinics share one Postgres cluster with row-level tenancy on clinic_id. It's why cross-clinic features are cheap and why we're paranoid about locks. Full ADR in the repo: adr/0003-tenancy.md",
    refs: [ { artifact: "dec-tenancy-single-cluster", kind: "citation", difficulty: "easy",
      span: "per ADR-003 all clinics share one Postgres cluster with row-level tenancy",
      self_reference: true } ] },

  // S2 retelling — nadia (non-participant)
  { eid: "sl-0604-1", channel: "gtm", at: "2025-06-04 15:12", user: "nadia",
    text: "Adding the Meridian story to the CS onboarding doc: best demo feedback we'd ever had, fourteen clinics ready to go, and the deal died because we wouldn't sign one piece of paper. Moral for anyone talking to clinic groups: compliance objections are buying signals.",
    refs: [ { artifact: "story-meridian-signature", kind: "retelling", difficulty: "medium",
      span: "best demo feedback we'd ever had, fourteen clinics ready to go, and the deal died because we wouldn't sign one piece of paper" } ] },

  // D2 assertion — colin (hard, #gtm)
  { eid: "sl-0605-1", channel: "gtm", at: "2025-06-05 10:26", user: "colin",
    text: "Horizon Physio wants a Friday go-live to match their quiet day. Told them eng won't ship database changes going into a weekend, so we're booking the cutover for Tuesday. They actually liked that answer.",
    refs: [ { artifact: "dec-no-friday-migrations", kind: "assertion", difficulty: "hard",
      span: "eng won't ship database changes going into a weekend" } ] },

  // S1 retelling — colin (non-participant, secondhand)
  { eid: "sl-0610-1", channel: "gtm", at: "2025-06-10 14:47", user: "colin",
    text: "Used the origin story on Horizon and it landed: one line of SQL on a Friday afternoon once took every clinic offline for three hours, and the weekend went to cleanup — that's why go-lives are midweek. Prospects trust scar tissue more than uptime stats.",
    refs: [ { artifact: "story-friday-migration", kind: "retelling", difficulty: "hard",
      span: "one line of SQL on a Friday afternoon once took every clinic offline for three hours, and the weekend went to cleanup" } ] },

  // Multi-reference single event: two citations in one message
  { eid: "sl-0612-1", channel: "eng", at: "2025-06-12 11:08", user: "marcus",
    text: "Availability-refactor design doc is up. It leans on two settled decisions rather than relitigating them: row-level tenancy per ADR-003, and all times UTC per ADR-005. Review by Thursday please.",
    refs: [
      { artifact: "dec-tenancy-single-cluster", kind: "citation", difficulty: "easy",
        span: "row-level tenancy per ADR-003" },
      { artifact: "dec-utc-iana-tz", kind: "citation", difficulty: "easy",
        span: "all times UTC per ADR-005" },
    ] },

  // F3 assertion — marcus (medium)
  { eid: "sl-0613-1", channel: "eng", at: "2025-06-13 16:02", user: "marcus", thread: "sl-0612-1",
    text: "Capacity note for the same doc: we're capped around 200 rps on bookings before the pool starves, so the refactor keeps availability reads off the primary.",
    refs: [ { artifact: "fact-booking-200rps", kind: "assertion", difficulty: "medium",
      span: "we're capped around 200 rps on bookings before the pool starves" } ] },

  // S2 retelling — lena (non-participant) + D9 citation in one event
  { eid: "sl-0618-1", channel: "general", at: "2025-06-18 12:50", user: "lena",
    text: "Learned over lunch that we once lost a fourteen-clinic deal because we wouldn't sign a single form — which finally explains the ADR-007 all-hands energy. Building the audit log with considerably more reverence now.",
    refs: [
      { artifact: "story-meridian-signature", kind: "retelling", difficulty: "medium",
        span: "we once lost a fourteen-clinic deal because we wouldn't sign a single form" },
      { artifact: "dec-sign-baas", kind: "citation", difficulty: "medium",
        span: "the ADR-007 all-hands energy" },
    ] },

  // F1 assertion — colin
  { eid: "sl-0620-1", channel: "gtm", at: "2025-06-20 09:33", user: "colin",
    text: "Turned away another solo practitioner today — felt weird, was right. Solo clinics churn fastest and cost the most to keep; groups of two-plus or self-serve, that's the play.",
    refs: [ { artifact: "fact-churn-solo-clinics", kind: "assertion", difficulty: "easy",
      span: "Solo clinics churn fastest" } ] },

  // D8 dormancy-breaking citation (12 weeks of silence, then this)
  { eid: "sl-0625-1", channel: "eng", at: "2025-06-25 13:21", user: "marcus",
    text: "Before anyone spikes a chart library for the ops dashboard — didn't we already decide Metabase for reports back in April? The embed exists; let's point it inward instead of building charts twice.",
    refs: [ { artifact: "dec-metabase-reports", kind: "citation", difficulty: "medium",
      span: "didn't we already decide Metabase for reports back in April?" } ] },

  { eid: "sl-0627-1", channel: "general", at: "2025-06-27 17:05", user: "ray",
    text: "It's signed. Meridian Health — fourteen clinics — BAA executed this morning, kickoff in July. Biggest logo in company history, and it only took losing them once to learn how to win them." },
  { eid: "sl-0630-1", channel: "general", at: "2025-06-30 16:58", user: "maya",
    text: "H1 close: 57 clinics, Meridian signed, zero sev1s since February. The lessons are compounding faster than the revenue, which is exactly the right order. See you in H2." },
];
