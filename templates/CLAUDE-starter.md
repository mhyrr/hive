# CLAUDE.md Starter — Fable-era doctrine

The starting prompt for any repo's CLAUDE.md, plus the checklist for porting
existing ones. Written 2026-07-24, after TK-133/134/135/136 and Anthropic's
own 80% cut of Claude Code's system prompt for Fable 5.

The one-line version: **a CLAUDE.md is a fact sheet, not an operations
manual.** Facts the model can't derive; constraints it must not cross;
trigger conditions for tools it might under-reach for. Everything else is
a constraint it will obey even when wrong for the task.

## Why smaller

- Anthropic cut Claude Code's system prompt ~80% (roughly 800 → 164 tokens)
  for Fable 5. Thariq Shihipar: "this new class of models want a smaller
  system prompt," and examples "tend to constrain it because it's actually
  more imaginative than the examples we give it." Steering moved from hard
  rules to context.
- The official guidance is blunt: "Skills developed for prior models are
  often too prescriptive for Claude Fable 5 and can degrade output quality."
  Prompts written to compensate for weaker models — step lists, tool
  nudging, always-do-X-before-Y — now read as constraints, not help.
- Our own version of the lesson: TK-133 cut the session-start memory index
  from ~270KB to ≤8KB per project because every session-start line pays
  rent from a fixed attention budget. A CLAUDE.md draws from the same
  budget. Target: about a page. If it's over ~8KB, something in it is
  restating the repo.

## Five rules

1. **Facts, not procedures.** Keep what the model can't derive: commands
   with non-obvious flags, gotchas with their mechanism, the architecture
   map, policy with its rationale. Cut what it already knows how to do:
   step lists, workflow scripts, output-format examples.

2. **Trigger conditions, not mandated procedures** (TK-134, shipped).
   "The typescript skills carry this project's React and type canon — load
   the matching one when the work touches those" is information; keep it.
   "Not loading the skill first is the anti-pattern" is a rite; cut it.
   This split is the wording *both* model families want — Opus 4.8
   under-reaches without named triggers, Fable over-obeys procedure — so
   there is never a model-conditional branch.

3. **Boundaries and intent, not rule lists.** State what the work is for
   and where the hard lines are (destructive ops, external actions, the
   money path). Fable's instruction-following is strong enough that one
   brief instruction replaces the enumeration of cases. Give the reason,
   not only the request — the why lets it connect the task to context
   instead of inferring intent.

4. **Never ask for reasoning in the reply.** "Show your thinking,"
   "explain your reasoning before answering," reflection rituals — on
   Fable these can trigger the `reasoning_extraction` refusal category and
   silently fall back to Opus 4.8 (TK-136). Audit skills and prompts for
   this shape when porting.

5. **Re-check every timeout the repo owns.** High-effort Fable turns
   legitimately run many minutes; caps tuned for Opus-era latency
   false-kill real work (TK-135: per-call 6m→15m, pipeline 25m→60m,
   watchdog 30m→60m). Long-running agents should also be told to keep a
   written partial answer — a killed run must leave evidence, never
   nothing.

## Porting checklist

Run each line of an existing CLAUDE.md through: *(a)* would the model get
this wrong without it? *(b)* is it a fact/constraint or a rite? *(c)* is it
stated once? Fails any → cut or rewrite.

**Cut on sight**
- IMPORTANT/NEVER/ALWAYS shouting and repetition (keep the one or two real
  iron laws, stated once, plainly)
- Step-by-step procedure for anything the model does well by default
- Output examples and response templates
- Tool nudging ("always use X for Y")
- Anything the repo, README, or git history already records
- Show-your-thinking / reflection instructions (rule 4)
- Verbosity, tone, and hedging rules written for weaker models

**Keep**
- Commands: build, test, run, deploy — with the flags that aren't
  discoverable ("use `--compile`, not `--target bun`, because…")
- Gotchas *with mechanism* ("rm-then-cp — overwriting in place trips the
  macOS cdhash cache and SIGKILLs the next run")
- Architecture map: entry points, crown-jewel modules, sizes. A map, not
  a tour.
- Policy with rationale ("OAuth is the default; if it fails, surface the
  failure — don't silently fall back to the API key")
- Hard limits: git discipline, destructive-op and external-action
  boundaries

**Rewrite**
- Procedure → trigger condition ("Before X always do Y" → "Y covers Z;
  reach for it when the work touches Z")
- Enumerated cases → one principle (one brevity line replaces the list of
  banned verbose behaviors)
- Rule → intent + boundary ("never touch prod data" stays; the ten rules
  approximating it go)

## The skeleton

```markdown
# <Project>

<One paragraph: what this is, who it's for, the current focus.>

## Commands

- Run: `...`
- Test: `...`
- Build / deploy: `...`   <!-- only flags that aren't discoverable -->

## Architecture

<5–10 lines: entry points, the modules where the real logic lives, how
data flows. Enough to orient; the code carries the rest.>

## Gotchas

- <Trap + mechanism. Only ones that actually bit someone.>

## Policy

- <Hard constraints with the why: auth, money paths, migrations, git.>
- <External actions that need asking first.>
```

Notice what's absent: persona, tone, workflow scripts, tool etiquette.
In HIVE-registered repos all identity and working doctrine arrives via the
SessionStart hook (SOUL/IDENTITY/AGENTS) — a per-repo CLAUDE.md that
restates any of it is double-billing the context budget. In non-HIVE
repos the same separation holds: user-level preferences belong in user
memory, project facts in CLAUDE.md.

## Sources

- [Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5) — the official migration guidance (refactor prescriptive prompts, `reasoning_extraction`, timeouts, effort)
- [Anthropic cut 80% of Claude Code's system prompt](https://the-decoder.com/anthropic-says-it-cut-80-percent-of-claude-codes-system-prompt-because-fable-5-models-want-a-smaller-system-prompt/) — Thariq Shihipar on why
- HIVE receipts: TK-133 (index budget), TK-134 (trigger/procedure split), TK-135 (timeout audit), TK-136 (reasoning-echo refusals)
