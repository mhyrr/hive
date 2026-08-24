# Tool Descriptions — the rubric inverts

The rubric for tool descriptions is **precision and contract accuracy, not
brevity**. This is where a "trim it" instinct most often points the wrong way:
detailed descriptions are the most important factor in tool performance, and
the most common failure is *under*-description. What changed on current models
is *which content* belongs there — contract and mechanics in, behavioral
steering and worked examples out.

The target shape is a man page: what the tool does, when to use it (and when
not to), what each parameter means, caveats, and what it does **not** return.
A contract/behavior mismatch — the description promising something the tool
doesn't do — sends the model down paths no prompt text can fix; verify
descriptions against the tool's actual implementation as part of the audit.

## Findings table

| Pattern | Direction | Fix |
| --- | --- | --- |
| Vague one-liners; parameters without descriptions; no when-not-to-use | **Under-described — add** | 3–4+ sentences minimum; parameter semantics, limits, failure modes, what the result omits |
| `CRITICAL: You MUST use this tool when...`, `Use BEFORE...`, caps-steering | Over-steered — dial back | Plain `Use when...` — triggering boosters written against under-triggering models now cause over-triggering |
| Worked examples, fake dialogue, embedded numbered workflows in the description | Misplaced — move | Examples constrain exploration and cost tokens on every request; move teaching material to a skill; make parameters expressive (well-named enums carry intent) |
| Cross-tool scolding (`ALWAYS use X, NEVER Y for this`) and behavior-smuggling ("after showing results, always recommend...") | Misplaced — move or delete | A description is a contract about functionality, not a channel for conversational instructions; put a preference for tool X in X's own description, not scattered across its rivals |
| Tool names enumerated in system-prompt prose, shadowing the real tool list | Duplicated — delete or relocate | The system prompt shouldn't name tools; then enabling/disabling one never leaves a dangling reference. Genuinely cross-tool *policy* (cost gates, approval requirements, write-vs-read posture) may stay in the system prompt — per-tool triggering rules move into the tools' own descriptions |
| Near-duplicate overlapping tools; 30+ always-loaded schemas | Structural | Fewer, clearly bounded tools with explicit boundaries stated in both descriptions; past a few dozen tools, use deferred loading / tool search |

## The trigger-text exception

Text whose job is *routing* — a skill's frontmatter description, a trigger
block — may legitimately carry calibrated urgency, because skills currently
under-trigger; ideally it's tuned against a trigger eval rather than vibes.
Text whose job is *behavior* should explain rather than shout. These look
identical to a grep — classify by function before flagging.

## Parameter descriptions count too

Audit `describe()` strings and JSON-schema `description` fields with the same
contract rubric: units, defaults, valid ranges, what happens when omitted.
"Project name" is under-described if the real contract is "Project name.
Defaults to the project matching the current directory." — the default *is*
the contract.
