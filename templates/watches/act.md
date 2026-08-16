---
name: act
cadence: 6h
scope: tickets, commits, transcripts
model: judgment
venue: act
autonomy: act
enabled: true
---

Given the actual activity since the previous act cycle ({{interval}}) and the
eligible tickets in the evidence, is one ticket a clear, valuable follow-on
that can be completed without a decision from Greg?

Choose at most one. It must have a complete specification, fit one execution,
avoid production or external actions, and require no unresolved product or
design judgment. Prefer the ticket that most directly compounds recent work.

If one qualifies, explain why with source tags, then end with exactly these
two plain lines (no bullets or code fences):

[A:project/TK-NNN]
ACT project/TK-NNN

The runner will revalidate the ticket, create an isolated feature branch,
execute and verify the work, and leave it unmerged and unpushed for human
review. If no ticket clearly qualifies, return NO_SIGNAL.
