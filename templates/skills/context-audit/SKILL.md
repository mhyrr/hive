---
name: context-audit
description: Audit session-start context — identity/soul/agents files, CLAUDE.md, persona and taste files, MCP tool descriptions — against current frontier-model prompting expectations, and propose concrete edits. Use this whenever the user wants to review, slim, clean up, modernize, or question their system-prompt injection or tool descriptions ("are we overdoing it?", "is this prompt outdated?", "audit our context", "review AGENTS.md", "should our tool descriptions be shorter?"), or after a model upgrade when prompts written for the previous model may misfit the new one. Also use before compressing or minifying prompt files — deletion of dated instructions comes before compression.
user_invocable: true
---

# Context Audit

Review the files that reach a model at session start and propose changes so the
model gets the *right* package — not merely a smaller one. The output is an
audit report plus a proposed diff. Propose; never apply edits unless the user
explicitly asked for them to be applied.

## The frame

Frontier models follow instructions closely and literally. Text written for
older models — emphasis added because an old model under-triggered, scripts
added because it planned poorly, prohibitions against failures it no longer
makes — is not just wasted tokens: **specific dated instructions actively
degrade behavior**, while merely verbose text is comparatively harmless. So the
question is never "how do we make this shorter?" It is "does every token earn
its place?" Those diverge exactly where a naive shortening pass does damage:
too-short prompts produce generic output because the model fills gaps with safe
defaults. Deletion targets dated *instructions*; context survives.

The one-line classifier for any sentence: **could the model already know
this?**

- Keep what only the author knows: audience, product, environment facts, the
  quality bar, tool contracts, hard judgment calls, and the *reasons* behind
  constraints. Context is never cruft.
- Candidates for removal: restatements of trained defaults ("be thorough",
  "lead with the answer"), behavior the model does unprompted (planning,
  proactivity), and workarounds for failures the target model no longer has.

A second cut sharpens the first: is the line a **constraint on behavior**
(deletion candidate — test it) or **context the model can't get elsewhere**
(usually keep)?

## Workflow

### 1. Establish scope and target model

Non-interactive by default: state assumptions at the top of the report rather
than pausing to ask. Scope is what the user named; otherwise the full
session-start surface — everything that reaches the model as text before the
first user turn. In a HIVE installation that means the soul stack
(`~/.hive/SOUL.md`, `IDENTITY.md`, `SELF.md`, `AGENTS.md`, `TRUST.md`), the
persona register (`~/.hive/personas/`), the taste layer
(`~/.hive/taste/principles.md`), the project's `CLAUDE.md`, and the MCP tool
descriptions (in HIVE's repo: `src/mcp-server.ts`). Run `hive context` if
available to get measured sizes per layer. The target model is the one the
sessions actually run on — resolve it from the request, then the harness
config, then the newest model the repo's docs point at.

### 2. Classify each file by content class

Different classes get different treatment. Misclassifying is how audits do
harm, so do this before scanning for patterns:

| Class | Examples | Treatment |
| --- | --- | --- |
| **Voice** | SOUL-style values prose, persona registers, character notes | The register of the text *is* its function — a telegraphic rewrite preserves the claim and destroys the demonstration. Audit propositions (cut lines restating trained defaults), preserve the register of what stays. Never bullet-compress voice prose. |
| **Policy** | Operating rules, git constraints, tool-use policy, mode discipline | Full pattern scan (reference file below). Keep reasoned constraints with their reasons; delete choreography and trained defaults. |
| **Facts** | User profile, stack preferences, environment notes, memory indexes | Keep — the model can't know these. Fix staleness, not style. Machine-generated sections are the generator's problem, not this audit's; note them and move on. |
| **Tool descriptions** | MCP tool `description` fields, parameter descriptions | The rubric inverts here: precision and contract accuracy, **not brevity** — under-description is the common failure. See `references/tool-descriptions.md`. |

### 3. Establish provenance

Where git history exists, blame the emphatic and prohibitive lines. The
question for each: **which failure, on which model, did this prevent — and does
that failure still reproduce on the target model?** A line added as a
mitigation for a retired model is a presumptive removal; a line nobody can
justify is suspect by default. Idiom-dating without history ("think step by
step", scratchpad tags, ROLE→RULES→EXAMPLES boilerplate) is a flag-only
signal — low confidence unless paired with a documented target-model reason.

### 4. Scan for the patterns

Read `references/patterns.md` and work through its groups against every policy
and voice file. Read `references/tool-descriptions.md` for the tool surface.
Read `references/frontier-additions.md` last — auditing is fit in both
directions, and several findings will be *additions* the target model rewards.

### 5. Report, then diff

Produce both, always:

**The report** — one entry per finding:

| Field | Content |
| --- | --- |
| Location | `file:line` |
| Evidence | The exact text, quoted |
| Pattern | Which group/row it matches |
| Why | One sentence tying it to the target model's documented behavior |
| Confidence | High (documented / errors on target) · Medium (widely-observed) · Low (idiom-dating — flag, don't edit) |
| Action | remove · rewrite (give the replacement) · move (say where) · add (give the text) · flag |

Order by confidence, highest first. Summarize at the top: assumptions (scope,
target model), counts per group, and the two or three highest-impact findings
in prose. A finding you cannot tie to a named pattern with a target-model
reason is not a finding — flag it at low confidence or drop it. **An audit
that finds nothing should change nothing**: a clean file is a valid outcome,
and an empty diff beats a manufactured one.

**The diff** — high- and medium-confidence findings only, one finding per hunk
so the user can take hunks selectively. Rewrites beat bare deletions when the
instruction has a live purpose: re-express it minimally rather than keeping
the verbose original or dropping the concern. Grep the wider system for exact
prompt strings before deleting — tests, hooks, and log parsers sometimes match
on them.

### 6. Verify contested cuts

Removal is a hypothesis. For each contested change, run a small behavioral
probe before and after on a scratch copy — a prompt that exercises the
instruction's purpose — rather than asking the model whether it needs the
instruction (self-report is not measurement). One change at a time where
stakes are high. If a cut regresses, re-add the instruction in minimal form
and re-probe. Re-run this audit at every model upgrade: a line that is
load-bearing on one generation is cruft on the next.

## The keep list

These stay even when a pattern-grep matches. An audit that only says "delete"
hurts the users who follow it most diligently.

1. Context — audience, environment, quality bar, reasons — is never cruft.
2. Never justify a deletion by character count alone.
3. Fragile operations keep exact scripts: destructive commands, auth flows,
   compliance steps. Prompting effort scales with distance from what the model
   does naturally.
4. Tool contract detail stays, and often grows.
5. Prohibitions against failures that still reproduce on the target model
   stay — ideally with the reason beside them.
6. Trigger/routing text (skill descriptions, frontmatter) may carry calibrated
   urgency; skills under-trigger, so judge trigger text by function, not tone.
7. Format-pinning examples on genuinely format-sensitive outputs stay.
8. Working redundancy is a refactoring preference, not cruft — consolidate
   only when the duplicates disagree.
9. A one-line role statement is fine; flag identity text only when it
   substitutes for real context.
10. One deliberate end-of-file recap of the few key constraints is a known
    good pattern; the anti-pattern is scattered duplication.
