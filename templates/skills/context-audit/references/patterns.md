# Dated-Pattern Groups

Scan every policy and voice file against these groups. Each finding must name
its row here — a pattern match plus a target-model reason is what separates a
finding from an opinion.

## Group 1 — Pressure language

Older, less steerable models needed forcefulness; current models are highly
responsive to the system prompt, so the same text over-applies. This cuts both
ways: inflated emphasis causes over-triggering and rigid behavior, while
leftover hedges ("try to", "if possible") are now read literally as permission
to under-deliver.

| Before (older models) | After (current models) |
| --- | --- |
| `CRITICAL: You MUST use this when...` | `Use this when...` |
| Several `IMPORTANT: NEVER...` per file | State the one or two real constraints plainly, with the reason |
| `Be thorough. Do not stop early.` | Delete — current models are proactive by default |
| `Try to include X if possible` (when X is required) | `Include X.` |
| `Don't be too verbose` / trait claims (`you tend to over-X`) | State the desired behavior positively |

When several instructions are each marked critical, the markers stop carrying
information — and the prompt's register becomes the output's register: an
anxious prompt produces a cautious, hedging model. Emphasis is not banned; it
is a tested, scoped fix for one demonstrably underweighted instruction, not a
first-draft register.

Signals: caps density of `MUST|NEVER|ALWAYS|CRITICAL|IMPORTANT`; emphasis with
no adjacent "because"; `try to|if possible|ideally` on actual requirements.

## Group 2 — Scaffolds replaced by model training or API features

Swap these for the feature, don't reword them.

| Scaffold | Replacement |
| --- | --- |
| "Think step by step", scratchpad/thinking-tag instructions | Native thinking; control depth via effort configuration, not prose |
| "Plan before acting" | Delete — current models plan unprompted; these cause over-planning |
| "Lead with the answer", "match length to the question", "skip filler openers" | Trained defaults on current Claude — delete the restatement, keep any genuinely house-specific style bar |
| "Show your reasoning" in output requirements | Read thinking via the API; on some models instructing reasoning reproduction triggers refusals |
| Progress-narration cadences ("summarize every N calls"), numeric caps ("at most N words") | Delete and re-baseline; qualitative guidance over numbers tuned against an older model's verbosity |
| JSON-forcing prose ("output ONLY valid JSON") | Structured outputs at the API layer |

## Group 3 — Over-specification

| Pattern | Why it's cruft now | Fix |
| --- | --- | --- |
| Step-by-step choreography for judgment tasks | Prompts written for prior models are often too prescriptive for current ones and *reduce* output quality — the model's own plan usually beats a hand-written script | State outcomes, constraints, and how to verify; numbered steps only where order truly matters |
| Prohibition lists ("don't X, never Y, avoid Z") | Describing success beats enumerating failure; a prohibition against a failure the model wasn't going to make can *anchor it toward* that failure | See the provenance test below |
| Example over-indexing: one gold output, stale few-shot blocks | Examples are the strongest signal in a prompt — the model matches their length and tone, freezing an older model's behavior into the new one | Several varied examples labeled illustrative, or none; keep only format-pinning examples |
| Bullet walls for behavioral guidance | Bullets flatten priority and sever rules from reasons; prompt format bleeds into output format | Structure for reference data; prose for behavior, carrying the "because" |
| Padding: generic virtues, repetition-as-reinforcement, kitchen-sink edge cases | Everything is treated as actionable signal; duplicated rules make the model reconcile wordings; bulk inflates thinking spend | Say it once, in the right place; cover hard judgment calls, not easy parts |
| Strategy coaching ("it's usually best to...") | The author's heuristic is wrong somewhere and the model's plan is usually better | If removing it wouldn't change what is legal or how success is measured, delete it |

### The provenance test for prohibitions

Audit a run of "never / don't / must not" lines by asking, per line: **does it
carry a stated reason or encode a real business/policy constraint?** — not
"would it hurt to say this?" (that question keeps everything).

- **Keep**: prohibitions encoding observable constraints — destructive-command
  rules, data/compliance boundaries, promises the business must not make —
  ideally with the reason beside them ("never amend after a failed pre-commit
  hook — the commit didn't happen").
- **Cut or rewrite**: prohibitions describing an undesirable *output style*
  with no provenance — banned-phrase lists, tic lists written against an older
  model's habits. Restate the desired style positively in one line, or attach
  the real reason if there is one.

A surrounding cluster of legitimate prohibitions does not launder the
no-provenance ones mixed into it. Classify each line separately.

## Group 4 — Fossils

| Pattern | Fix |
| --- | --- |
| Model-version workarounds, "known issue with [model]" notes, date-conditional guidance | Trace each to the model it patched; retired model → remove and re-test |
| Migration-relative phrasing ("X now works differently", "no longer") | Write as if current rules are the only rules that ever existed |
| Patch accretion: many narrow conditionals, each traceable to one incident | Generalize the principle; test removals, not just additions. One session's stumble encoded as a permanent rule makes the next session step around a pothole that isn't there |
| Unenforced rules nothing checks and nobody misses | Enforce in code (hooks, allowlists, validators) what can be; delete the rest |
| History narratives: past tense, incident IDs, pinned model names | State the current rule; drop the archaeology |

Signals: retired model names; `now|no longer|instead of` on behavioral rules;
past tense in instruction files; rules whose reason nobody remembers.

## Voice files — a constraint on all groups

For voice-class prose (soul/persona/character files), the pattern scan applies
to *propositions only*: cut lines whose content restates trained defaults, keep
lines carrying the author's actual values and taste. Never convert surviving
voice prose to telegraphic or bullet form — the register is the mechanism, and
a fidelity check on propositions cannot measure register transfer. If a voice
file feels bloated after the propositional cut, that's a rewrite for the
author, not an audit action.
