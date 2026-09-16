# Root instruction file starter

The starting prompt for a repo's root instruction file, and the procedure for
porting an existing one. Rewritten 2026-09-16 to the six rules (TK-153).

**A root instruction file is a fact sheet, not an operations manual.** Facts
the model can't derive, constraints it must not cross, trigger conditions for
tools it under-reaches for. The rest is a constraint it will obey even when
wrong for the task.

Name it `AGENTS.md` (Codex reads only that name) and make `CLAUDE.md` a
symlink (`ln -sf AGENTS.md CLAUDE.md`) or a one-line `@AGENTS.md` import.
Two separate files drift; `hive doctor` warns when it finds a pair.

## The six rules

1. **Under 8 KB and under 200 lines.** Codex loads `~/.codex/AGENTS.md`, the
   repo file, and every nested one under one `project_doc_max_bytes` ceiling,
   then truncates the overflow mid-file with no notice. HIVE's identity
   already spends ~23 KB of it.
2. **A line stays only if the model would get something wrong without it.**
   Restatements of README, PRODUCT, DESIGN or a design doc become one row of
   a pointer table; commands keep only flags that aren't discoverable; the
   map is entry points and where the logic lives, not a tour.
3. **Framework and language guidance lives in skills, never here.** The
   generated `usage-rules` block, style canon, any "how to write X in this
   stack" belongs in `~/.claude/skills/<stack>-*`: lazily loaded, shared
   across repos, one place to fix.
4. **Incidents and gotchas go to HIVE memory.** A rule may stay as one
   sentence; the story, the numbers, and the commit hash go to
   `write_hive_memory`. Where a note could become a guard (test, lint,
   hook), file a ticket for the guard.
5. **Nested files only for facts an agent editing elsewhere never needs**, a
   few KB each, not one per context by default. Codex ignores
   `.claude/rules/`, so a nested `AGENTS.md` is the portable mechanism, and
   it spends the same ceiling.
6. **No counts in prose.** "670 tests" is how a file starts lying. `hive
   doctor` warns when a root file is over budget.

No study says length alone changes accuracy; the case is cost, the Codex
ceiling, and stale facts: Dobby's file carried wrong ones when measured.
Anthropic cut Claude Code's system prompt ~80% for Fable 5 (Sources).
Every line pays rent from a fixed attention budget.

## The skeleton

````markdown
# <Project>

<One paragraph: what this is, who it's for, the stack on one line.>

| Read this | For |
|---|---|
| `README.md`, `PRODUCT.md` | What it is, who it's for, what it promises |
| `docs/design/<doc>.md` | The architecture and its numbered decisions |
| `DESIGN.md` | The surface. Binding; it overrides generic guidance |

## The line the codebase is built around

- **<Iron law.>** <The mechanism in a sentence: what breaks without it.>

## Where things live

```text
<entry point>     <what it owns>
<module>/         <the logic that actually lives here>
```

## Commands

```sh
<cmd>   # only the flags that aren't discoverable, with the why
```

## Conventions

- <Constraint with its reason: commits, changelog, docs, git discipline.>
- Incidents and gotchas go to HIVE memory, not this file.
````

Testing gets a section when the tiering is non-obvious: a replay tier and a
billable eval tier gated on an env var, say. No Gotchas heading: rule 4 puts
those in memory.

Absent: persona, tone, workflow scripts, tool etiquette, step lists, output
templates, and show-your-thinking rituals. On Fable those can trigger the
`reasoning_extraction` refusal and silently fall back to Opus 4.8 (TK-136);
audit skills and prompts for that shape too. In HIVE repos identity and
working doctrine arrive via the SessionStart hook, so restating any of it
double-bills the budget.

## The three questions

Run each line through: *(a)* would the model get this wrong without it?
*(b)* is it a fact/constraint or a rite? *(c)* is it stated once? Failing
any, it is cut, moved by rules 2–4, or rewritten.

**Cut** — IMPORTANT/NEVER/ALWAYS shouting and repetition; step lists, output
templates, and tool nudging for what the model does well by default; anything
the README or git history records; verbosity and tone rules written for
weaker models.

**Keep** — commands with non-discoverable flags ("`--compile`, not
`--target bun`, because…"); iron laws with their mechanism; the map; policy
with its rationale ("OAuth is the default; if it fails, surface the failure").

**Rewrite** — procedure into trigger condition: "Before X always do Y"
becomes "Y covers Z; reach for it when the work touches Z". Both model
families want that wording (Opus 4.8 under-reaches without named triggers,
Fable over-obeys procedure), so there is no model-conditional branch
(TK-134). Enumerated cases become intent plus boundary: "never touch prod
data" stays, the ten rules approximating it go, the reason stays.

## Porting an existing file

1. **Measure.** `wc -c -l AGENTS.md CLAUDE.md`, plus `find . -name AGENTS.md
   -o -name CLAUDE.md` for the nested ones. `hive doctor` reports the budget
   per project and the Codex arithmetic: `root 7.2 KB / 143 lines, codex
   22.1+7.2 KB of 64.0 KB`. Keep the before bytes for the commit message.
2. **Name it.** `git mv CLAUDE.md AGENTS.md` if needed, then `CLAUDE.md`
   pointing at it (above).
3. **Classify every line** by the three questions: cut, move, keep, rewrite.
4. **Move the framework guidance** into the matching `<stack>-*` skill. A
   `<!-- usage-rules-start -->` marker means the whole generated block goes;
   doctor warns while it is there.
5. **Move the incidents** with `write_hive_memory`, one per incident, and
   `create_ticket` for each one that should become a guard.
6. **Rewrite** to the skeleton. Never soften an iron law (money paths,
   tenancy, auth), but state each once, with its mechanism.
7. **Re-measure** with `hive doctor`: under 8 KB and 200 lines, no
   usage-rules marker, no drifting pair, nested files under 4 KB, Codex
   arithmetic green.
8. **Commit** with the before and after bytes in the message.

Re-check the repo's timeouts too: Opus-era caps false-kill high-effort Fable
turns, which run many minutes (TK-135: per-call 6m→15m, pipeline 25m→60m,
watchdog 30m→60m).

## Worked example: Dobby

`AGENTS.md`: 34,401 B / 665 lines → 7,381 B / 143 lines; `CLAUDE.md` a
symlink to it. What left: the generated Phoenix `usage-rules` block and its
restatements, now in the `elixir-*` skills. What stayed: one paragraph, then
the pointers.

```markdown
| Read this | For |
|---|---|
| `README.md`, `PRODUCT.md` | What Dobby is, who it is for, what it promises |
| `docs/design/dobby-design-jido.md` | The architecture and its numbered decisions. `@moduledoc`s cite it (`design §4.2`). A record, not a spec: read the code for what is true and this for why |
| `DESIGN.md` | The surface. Binding, and it overrides any generic UI guidance |
```

Iron laws, stated once each, with the mechanism rather than volume:

> - **The model never touches Home Assistant.** A tool calls a device agent,
>   the agent returns a `Dobby.Directive.HACall`, the runtime performs it. A
>   path from the language layer to the network breaks the product.
> - **The model never does arithmetic.** LLMs extract, code computes.
> - **Ambiguity is a refusal to act, not a licence to act broadly.**

Testing kept a section because the tiering cannot be read off the suite:
`--include eval` without `DOBBY_EVAL` points every provider at a dead
loopback address, and with it lifts that guard over the whole replay suite,
the billable accident the guard exists to prevent.

## Sources

- [Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5) — migration guidance
- [Anthropic cut 80% of Claude Code's system prompt](https://the-decoder.com/anthropic-says-it-cut-80-percent-of-claude-codes-system-prompt-because-fable-5-models-want-a-smaller-system-prompt/) — Thariq Shihipar on why
- HIVE receipts: TK-133 (index budget), TK-134 (trigger/procedure split), TK-135 (timeouts), TK-136 (reasoning-echo refusals), TK-153 (the six rules and the doctor checks)
