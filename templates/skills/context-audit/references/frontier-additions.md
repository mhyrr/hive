# Frontier Additions — auditing is fit in both directions

Matching context to a newer model sometimes means *adding* guidance for that
model's failure modes. After the deletion pass, check the surviving files
against this list; a gap here is an `add` finding with the same standing as a
removal. Adapt wording to the house voice — these are the behaviors to cover,
not text to paste.

**Grounded progress claims.** Frontier models on long runs benefit from an
explicit grounding rule: audit each progress claim against a tool result from
this session; report only work you can point to evidence for; say "unverified"
when it is. In testing this nearly eliminated fabricated status reports. If
the files already carry a verification-before-completion rule, that satisfies
this — don't duplicate it.

**Boundaries on unrequested-but-adjacent actions.** Capable models sometimes
take the helpful-adjacent step nobody asked for (composing the email, creating
backup branches, refactoring around a bug fix). State the boundary positively:
when the user is describing a problem or thinking aloud, the deliverable is
the assessment — report and stop; don't add features or abstractions beyond
what the task requires.

**Act-don't-overplan nudge.** On ambiguous tasks, high-capability models can
over-gather and re-litigate. One line suffices: when you have enough
information to act, act; if weighing a choice, give a recommendation, not a
survey.

**A memory surface.** Frontier models perform notably better with somewhere to
write learnings for future sessions — tell them where, tell them to consult
it, give a format, and say what *not* to save (anything the repo or history
already records). A system that already has a memory layer satisfies this;
check that the files actually point to it.

**Communication-style section.** Current models are very responsive to
explicit communication-style guidance — invest in one good section rather than
fighting output style downstream, and rather than enumerating banned behaviors.
Qualitative ("lead with the outcome; be selective, not compressed") over
numeric caps.

**Intent with requests.** Models perform better knowing the why behind a
request — they connect the task to relevant context instead of inferring
intent. Where the files describe how the user delegates work, encourage
passing the reason along with the ask.

**Delegation posture.** Suppressing sub-agent use was a prior-model guardrail;
current models delegate reliably. If the files discourage delegation, that's a
fossil; guidance should instead say *when* delegation is desirable and to keep
working while sub-agents run.

## Ordering note

Run the deletion pass first, then this pass. Several additions above have
deletion-pass twins (a verbose old verification section vs. a grounding rule;
a banned-phrase list vs. a communication-style section) — the finding is often
"rewrite", replacing the dated form with the current one, not two separate
findings.
