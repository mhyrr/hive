# CLAUDE.md Starter — Fable-era doctrine

The starting prompt for any repo's CLAUDE.md, plus the porting test for
existing ones. Written 2026-07-24, after TK-133/134/135/136.

**A CLAUDE.md is a fact sheet, not an operations manual.** Facts the model
can't derive; constraints it must not cross; trigger conditions for tools
it might under-reach for. Everything else is a constraint it will obey
even when wrong for the task.

Why smaller: Anthropic cut Claude Code's own system prompt ~80% for Fable 5
("this new class of models want a smaller system prompt" — Sources), and
TK-133 cut our session-start index 270KB→≤8KB for the same reason: every
line pays rent from a fixed attention budget. Target about a page; over
~8KB, something in it is restating the repo.

## The porting test

Run each line through: *(a)* would the model get this wrong without it?
*(b)* is it a fact/constraint or a rite? *(c)* is it stated once? Fails
any → cut or rewrite.

**Cut on sight**
- IMPORTANT/NEVER/ALWAYS shouting and repetition — keep the one or two
  real iron laws, stated once, plainly
- step lists, output templates, and tool nudging ("always use X for Y")
  for anything the model does well by default
- anything the repo, README, or git history already records
- show-your-thinking / reflection rituals — on Fable these can trigger
  the `reasoning_extraction` refusal category and silently fall back to
  Opus 4.8 (TK-136); audit skills and prompts for this shape too
- verbosity, tone, and hedging rules written for weaker models

**Keep**
- commands with non-discoverable flags ("use `--compile`, not
  `--target bun`, because…")
- gotchas with mechanism ("rm-then-cp — overwriting in place trips the
  macOS cdhash cache and SIGKILLs the next run")
- architecture map: entry points, crown-jewel modules, sizes — a map,
  not a tour
- policy with rationale ("OAuth is the default; if it fails, surface the
  failure — don't silently fall back")
- hard limits: git discipline, destructive-op and external-action
  boundaries

**Rewrite**
- procedure → trigger condition: "Before X always do Y" becomes "Y covers
  Z; reach for it when the work touches Z". This wording is what both
  model families want — Opus 4.8 under-reaches without named triggers,
  Fable over-obeys procedure — so there is never a model-conditional
  branch (TK-134).
- enumerated cases → intent + boundary: "never touch prod data" stays;
  the ten rules approximating it go. Give the reason, not just the rule —
  the why lets the model connect task to context.

While porting, also re-check every timeout the repo owns: high-effort
Fable turns legitimately run many minutes, and Opus-era caps false-kill
real work (TK-135: per-call 6m→15m, pipeline 25m→60m, watchdog 30m→60m).
Long-running agents should keep a written partial answer — a killed run
must leave evidence, never nothing.

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

What's absent: persona, tone, workflow scripts, tool etiquette. In
HIVE-registered repos, identity and working doctrine arrive via the
SessionStart hook (SOUL/IDENTITY/AGENTS) — a CLAUDE.md restating any of
it double-bills the context budget. Non-HIVE repos, same separation:
user preferences in user memory, project facts in CLAUDE.md.

## Sources

- [Prompting Claude Fable 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5) — official migration guidance
- [Anthropic cut 80% of Claude Code's system prompt](https://the-decoder.com/anthropic-says-it-cut-80-percent-of-claude-codes-system-prompt-because-fable-5-models-want-a-smaller-system-prompt/) — Thariq Shihipar on why
- HIVE receipts: TK-133 (index budget), TK-134 (trigger/procedure split), TK-135 (timeout audit), TK-136 (reasoning-echo refusals)
