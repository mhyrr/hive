// Email exhaust, rendered to a single mbox file. Threading via
// In-Reply-To/References on the rendered Message-IDs (<eid@domain>).

import type { Email } from "../tools/types.ts";

export const EMAILS: Email[] = [
  // ── Pricing thread (Feb) — provenance for dec-pricing-per-practitioner ──
  {
    eid: "em-price-1",
    at: "2025-02-18 10:04",
    from: "jules",
    to: ["ray", "maya", "colin"],
    subject: "Pricing: we need to pick a model this week",
    body: `Team,

Three candidates on the table, we've circled long enough:

1. Per booking ($0.40/booking) — scales with usage, but clinics hate
   variable bills and it punishes our busiest, happiest customers.
2. Per practitioner seat ($29/practitioner/mo) — predictable, tracks
   clinic size, easy to quote on a call.
3. Flat tiers — simplest, but a 2-practitioner and a 9-practitioner
   clinic in the same tier is money on the floor.

My recommendation is per practitioner. Ray, does that survive contact
with actual sales calls?

Jules`,
  },
  {
    eid: "em-price-2",
    at: "2025-02-19 08:47",
    from: "ray",
    to: ["jules", "maya", "colin"],
    subject: "Re: Pricing: we need to pick a model this week",
    inReplyTo: "em-price-1",
    body: `Per practitioner survives, and it's the only one that does.

Clinic managers budget headcount, not utilization. When I quote per
booking they immediately ask "so a good month costs me more?" and the
call goes sideways. Seats they understand in one sentence.

One ask: keep the seat price flat as they grow. Growth penalties are
churn fuel.

Ray`,
  },
  {
    eid: "em-price-3",
    at: "2025-02-20 17:31",
    from: "maya",
    to: ["jules", "ray", "colin"],
    subject: "Re: Pricing: we need to pick a model this week",
    inReplyTo: "em-price-2",
    body: `Decided: per-practitioner seat pricing, $29/practitioner/month,
flat as they grow. Jules writes it into the site copy this week; Ray,
requote the open pipeline on the new model.

This is settled unless the market tells us otherwise — no relitigating
it per deal.

Maya`,
  },

  // ── Meridian thread (Mar) — epi-meridian-loss, fact-meridian-cfo ──
  {
    eid: "em-meridian-1",
    at: "2025-03-18 09:15",
    from: "ray",
    to: ["maya", "colin"],
    subject: "Meridian Health — security review stage",
    body: `Meridian Health is real: 14 clinics across two states, would be
our biggest logo by 3x. Demo went great, IT director (Sam Okada) is
pushing us into their security review.

Heads up: their procurement checklist has a BAA line item. Flagging
early because I know where we landed on that.

Ray`,
  },
  {
    eid: "em-meridian-2",
    at: "2025-03-19 11:02",
    from: "maya",
    to: ["ray", "colin"],
    subject: "Re: Meridian Health — security review stage",
    inReplyTo: "em-meridian-1",
    body: `Great pipeline news, awkward timing. We decided on March 5 to hold
BAAs until after v1 — the compliance lift is real engineering time and
the AU/NZ pipeline doesn't need it.

See if Meridian will accept a contractual commitment to a BAA within
12 months instead. If it's a hard gate, it's a hard gate.

Maya`,
    refs: [
      {
        artifact: "dec-postpone-baa",
        kind: "citation",
        difficulty: "easy",
        span: "We decided on March 5 to hold BAAs until after v1",
        self_reference: true, // Maya made the call she is citing
      },
    ],
  },
  {
    eid: "em-meridian-3",
    at: "2025-03-24 15:38",
    from: "ray",
    to: ["maya", "colin"],
    subject: "Re: Meridian Health — security review stage",
    inReplyTo: "em-meridian-2",
    body: `Update, and intel worth keeping: Okada evaluates, but he doesn't
decide. The real decision-maker at Meridian is the CFO, Dana Whitfield
— procurement moves when she moves, and she reads the compliance page
before the product page. I got 20 minutes with her Friday.

Pitched the 12-month BAA commitment. She was polite about it, which is
CFO for no.

Ray`,
  },
  {
    eid: "em-meridian-4",
    at: "2025-03-25 16:55",
    from: "ray",
    to: ["maya", "colin"],
    subject: "Meridian: lost",
    inReplyTo: "em-meridian-3",
    body: `Whitfield passed this morning. Verbatim: "Come back when you can
sign the BAA." Fourteen clinics, best demo feedback we've ever had,
and it died on a signature.

Logging it and moving on, but I want this one remembered when we
re-prioritize compliance.

Ray`,
  },
  {
    eid: "em-meridian-5",
    at: "2025-03-25 17:40",
    from: "colin",
    to: ["ray", "maya"],
    subject: "Re: Meridian: lost",
    inReplyTo: "em-meridian-4",
    body: `Brutal. For the record: the product won and our own no-BAA policy
lost the deal. That's a choice we made, not a competitor beating us.

Colin`,
    refs: [
      {
        artifact: "dec-postpone-baa",
        kind: "assertion",
        difficulty: "hard",
        span: "our own no-BAA policy lost the deal",
      },
    ],
  },

  // ── Churn review (Apr) — fact-churn-solo-clinics ──
  {
    eid: "em-churn-1",
    at: "2025-04-15 13:20",
    from: "nadia",
    to: ["ray", "colin", "maya", "jules"],
    subject: "Q1 churn review — where it actually concentrates",
    body: `Q1 churn readout attached-in-body:

11 churned accounts. 9 of the 11 were solo-practitioner clinics.
Multi-practitioner clinics essentially do not leave — one churn, and
that was an acquisition. Since we bill per practitioner seat, solo
clinics are simultaneously our cheapest accounts and our fastest
churn: least revenue, most support tickets, first out the door.

Implication for targeting: qualify for 2+ practitioners. Solo clinics
should be self-serve or nothing.

Nadia`,
    refs: [
      {
        artifact: "dec-pricing-per-practitioner",
        kind: "assertion",
        difficulty: "medium",
        span: "we bill per practitioner seat",
      },
    ],
  },

  // ── BAA reversal thread (May) — dec-sign-baas provenance ──
  {
    eid: "em-baa-1",
    at: "2025-05-20 18:05",
    from: "ray",
    to: ["maya", "dev"],
    subject: "Meridian is back — same gate",
    body: `Following up from the leadership sync: Whitfield's office reached
out to *us*. Their current vendor is sunsetting and we're the shortlist.
Same gate as March — no signed BAA, no deal. You'll remember how that
ended last time: fourteen clinics gone over a signature.

If we're ever reversing the BAA call, this is the moment.

Ray`,
    refs: [
      {
        artifact: "story-meridian-signature",
        kind: "retelling",
        difficulty: "medium",
        span: "fourteen clinics gone over a signature",
        self_reference: true, // Ray lived it — participant retellings carry no story signal
      },
    ],
  },
  {
    eid: "em-baa-2",
    at: "2025-05-22 09:12",
    from: "maya",
    to: ["ray", "dev", "jules"],
    subject: "Re: Meridian is back — same gate",
    inReplyTo: "em-baa-1",
    body: `Decision: we sign BAAs. This supersedes the March 5 call to hold
off until after v1 — the US market keeps telling us compliance IS the
product for clinic groups, and I'd rather hear it twice than three
times.

Dev: legal template is approved, please write this up as an ADR and
scope the audit-logging gaps. Ray: tell Whitfield's office we'll have
paper ready within 30 days.

Maya`,
    refs: [
      {
        artifact: "dec-postpone-baa",
        kind: "citation",
        difficulty: "easy",
        span: "This supersedes the March 5 call to hold off until after v1",
        self_reference: true,
      },
    ],
  },
  {
    eid: "em-baa-3",
    at: "2025-05-22 10:44",
    from: "dev",
    to: ["maya", "ray", "jules"],
    subject: "Re: Meridian is back — same gate",
    inReplyTo: "em-baa-2",
    body: `On it — ADR-007 going up today. Audit-logging gaps are about two
weeks of work; they'll ride the 1.5 release.

Dev`,
  },

  // ── Deal desk instantiations (Apr, May) — proc-deal-desk ──
  {
    eid: "em-dealdesk-1",
    at: "2025-04-28 14:26",
    from: "colin",
    to: ["maya"],
    cc: ["ray"],
    subject: "Sign-off request: Coastal Allied at 18%",
    body: `Per the deal desk policy, requesting written sign-off before I
send numbers: Coastal Allied Health, 6 practitioners, asking 18% off
list to sign a 2-year term. Above my 15% discretion line, so it's
yours to approve.

Colin`,
    refs: [
      {
        artifact: "proc-deal-desk",
        kind: "instantiation",
        difficulty: "easy",
        span: "Per the deal desk policy, requesting written sign-off before I\nsend numbers",
        divergence: 0.1,
      },
    ],
  },
  {
    eid: "em-dealdesk-2",
    at: "2025-04-28 15:03",
    from: "maya",
    to: ["colin"],
    cc: ["ray"],
    subject: "Re: Sign-off request: Coastal Allied at 18%",
    inReplyTo: "em-dealdesk-1",
    body: `Approved — 18% against a 2-year term is a good trade. Forward this
into the deal record.

Maya`,
  },
  {
    eid: "em-dealdesk-3",
    at: "2025-05-27 17:49",
    from: "colin",
    to: ["ray"],
    subject: "Brightleaf closed — 20% to get it done by EOM",
    body: `Good news first: Brightleaf Chiro signed, 4 practitioners, 2-year
term. To get it over the line by end of month I went to 20% on the
call. Papering it now — flagging the discount so the CRM matches.

Colin`,
    refs: [
      {
        artifact: "proc-deal-desk",
        kind: "instantiation",
        difficulty: "medium",
        span: "I went to 20% on the call",
        divergence: 0.45,
        violation: true, // >15% with no prior CEO sign-off — procedure divergence gold
      },
    ],
  },
  {
    eid: "em-dealdesk-4",
    at: "2025-05-28 08:31",
    from: "ray",
    to: ["colin"],
    cc: ["maya"],
    subject: "Re: Brightleaf closed — 20% to get it done by EOM",
    inReplyTo: "em-dealdesk-3",
    body: `Congrats on the close — and we need to keep the order of
operations straight: above 15% means written CEO sign-off BEFORE the
number reaches the customer, not after the handshake. That's the whole
policy. Maya, retro sign-off attached for the record; Colin, next one
comes to us first.

Ray`,
    refs: [
      {
        artifact: "proc-deal-desk",
        kind: "citation",
        difficulty: "easy",
        span: "above 15% means written CEO sign-off BEFORE the\nnumber reaches the customer",
        self_reference: true, // Ray owns/authored the procedure
      },
    ],
  },
];
