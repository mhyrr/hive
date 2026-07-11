// Meeting transcripts. Each speaker turn is one exhaust event
// (transcript_segment); native id is "<file>#<segment index>".

import type { Transcript } from "../tools/types.ts";

export const TRANSCRIPTS: Transcript[] = [
  {
    file: "2025-03-14-all-hands.md",
    title: "Sundial all-hands — March 2025",
    at: "2025-03-14 21:00",
    attendees: ["maya","dev","priya","tom","lena","marcus","ana","jules","sofia","ray","nadia","colin"],
    segments: [
      {
        eid: "ts1-1",
        speaker: "maya",
        text: "Welcome, everyone. Quarter one in one line: forty-one clinics live, up from nineteen in January, and we survived our own mistakes, which is the theme of the next ten minutes.",
      },
      {
        eid: "ts1-2",
        speaker: "ray",
        text: "Pipeline first. Meridian Health is in their security review — fourteen clinics, which would be three times our biggest logo. Beyond that, the AU/NZ funnel is healthy: nine qualified clinics, mostly physio and chiro groups.",
      },
      {
        eid: "ts1-3",
        speaker: "maya",
        text: "Before roadmap, I want to put words to something we keep saying in fragments, because how we behave when a clinic wants to leave is the whole brand.",
      },
      {
        eid: "ts1-4",
        speaker: "maya",
        text: "So here it is as a company principle, and I want it written down: clinics own their data. Every record they ever entered, exportable in open formats, free, including on the way out the door.",
      },
      {
        eid: "ts1-5",
        speaker: "maya",
        text: "If we ever catch ourselves designing lock-in instead of designing reasons to stay, that is the moment we have lost the plot. Retention is earned, not engineered.",
      },
      {
        eid: "ts1-6",
        speaker: "nadia",
        text: "For what it's worth, that's already my favorite save-play: you can take everything and walk any time — so why walk? It disarms people completely.",
        refs: [
          {
            artifact: "prin-clinics-own-their-data",
            kind: "assertion",
            difficulty: "medium",
            span: "you can take everything and walk any time",
          },
        ],
      },
      {
        eid: "ts1-7",
        speaker: "jules",
        text: "Lowlight of the quarter, for anyone who joined the party late: the Friday migration. One innocent index change at four-thirty on a Friday afternoon, and every clinic we have couldn't take a booking for three hours. That's why the no-Friday rule exists.",
        refs: [
          {
            artifact: "story-friday-migration",
            kind: "retelling",
            difficulty: "medium",
            span: "One innocent index change at four-thirty on a Friday afternoon, and every clinic we have couldn't take a booking for three hours.",
          },
          {
            artifact: "dec-no-friday-migrations",
            kind: "assertion",
            difficulty: "easy",
            span: "That's why the no-Friday rule exists.",
          },
        ],
      },
      {
        eid: "ts1-8",
        speaker: "maya",
        text: "And let's make that one official while we're all in the room: no schema migrations on Fridays, full stop, company policy. Dev's postmortem rule is now everyone's rule.",
      },
      {
        eid: "ts1-9",
        speaker: "dev",
        text: "Roadmap: one-point-three ships next week — recurring availability and the reminders overhaul. The BAA and compliance question stays parked per the March call; engineering time goes to the AU/NZ feature asks.",
        refs: [
          {
            artifact: "dec-postpone-baa",
            kind: "citation",
            difficulty: "medium",
            span: "The BAA and compliance question stays parked per the March call",
          },
        ],
      },
      {
        eid: "ts1-10",
        speaker: "sofia",
        text: "Design update: the new booking flow cut taps from nine to four, and the waitlist screens test well with the Kettleworth front desk. Full rollout rides one-point-three.",
      },
      {
        eid: "ts1-11",
        speaker: "colin",
        text: "Quick pricing sanity check from the field: with per-practitioner pricing, a twelve-practitioner group is about three-fifty a month, right? Because that number lands really well against what they pay today.",
        refs: [
          {
            artifact: "dec-pricing-per-practitioner",
            kind: "assertion",
            difficulty: "easy",
            span: "with per-practitioner pricing, a twelve-practitioner group is about three-fifty a month",
          },
        ],
      },
      {
        eid: "ts1-12",
        speaker: "maya",
        text: "Correct, and requote anything older than the February pricing email. That's time — thank you all. Q2 is about not needing an all-hands slide titled 'we survived our own mistakes'.",
      },
    ],
  },
  {
    file: "2025-05-20-leadership-sync.md",
    title: "Leadership sync — Meridian revival",
    at: "2025-05-20 20:00",
    attendees: ["maya", "dev", "jules", "ray"],
    segments: [
      {
        eid: "ts2-1",
        speaker: "maya",
        text: "One agenda item today, because it deserves the whole meeting: Meridian.",
      },
      {
        eid: "ts2-2",
        speaker: "ray",
        text: "Short version: the deal we lost in March over the BAA is back, and this time they came to us. Their current vendor is sunsetting and Whitfield's office asked for a proposal directly.",
        refs: [
          {
            artifact: "epi-meridian-loss",
            kind: "citation",
            difficulty: "easy",
            span: "the deal we lost in March over the BAA",
            self_reference: true,
          },
        ],
      },
      {
        eid: "ts2-3",
        speaker: "jules",
        text: "And the US pipeline behind them looks the same: every clinic group we talk to has compliance on page one. At Meridian specifically, the CFO is the one who signs — the compliance page is the pitch, not the product tour.",
        refs: [
          {
            artifact: "fact-meridian-cfo",
            kind: "assertion",
            difficulty: "medium",
            span: "At Meridian specifically, the CFO is the one who signs",
          },
        ],
      },
      {
        eid: "ts2-4",
        speaker: "dev",
        text: "Engineering reality check: the legal template is fine, the real work is audit logging. Two weeks, maybe three, and it rides the one-point-five release. It's tractable.",
      },
      {
        eid: "ts2-5",
        speaker: "maya",
        text: "What breaks if we say yes? I don't want to reverse a decision under deal pressure and discover the March reasoning was right.",
      },
      {
        eid: "ts2-6",
        speaker: "ray",
        text: "Targeting already moved under us: solo clinics churn and multi-practitioner groups stay, so the funnel is groups now — and groups ask for compliance whether they're in Sydney or St. Louis. The March reasoning aged out.",
        refs: [
          {
            artifact: "fact-churn-solo-clinics",
            kind: "assertion",
            difficulty: "medium",
            span: "solo clinics churn and multi-practitioner groups stay",
          },
        ],
      },
      {
        eid: "ts2-7",
        speaker: "dev",
        text: "One risk to say out loud: everything rides one cluster, so a HIPAA audit's scope is every clinic at once, not just the US ones. It's handleable, but it goes in the compliance narrative.",
        refs: [
          {
            artifact: "dec-tenancy-single-cluster",
            kind: "assertion",
            difficulty: "hard",
            span: "everything rides one cluster, so a HIPAA audit's scope is every clinic at once",
            self_reference: true,
          },
        ],
      },
      {
        eid: "ts2-8",
        speaker: "maya",
        text: "Okay. Ray, look at me — I'm about to make your quarter.",
      },
      {
        eid: "ts2-9",
        speaker: "maya",
        text: "Decision: Sundial signs BAAs. We reverse the March call — the market has now told us twice that compliance is the product for clinic groups. Dev writes the ADR, Ray tells Whitfield's office we'll have paper inside thirty days.",
      },
      {
        eid: "ts2-10",
        speaker: "ray",
        text: "Calling them the minute we hang up. And I'm framing it exactly like the story ends: last time it died on a signature — this time we sign.",
        refs: [
          {
            artifact: "story-meridian-signature",
            kind: "retelling",
            difficulty: "hard",
            span: "last time it died on a signature — this time we sign",
            self_reference: true,
          },
        ],
      },
    ],
  },
];
