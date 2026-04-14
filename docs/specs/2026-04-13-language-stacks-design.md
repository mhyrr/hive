# Language Stacks — Design

**Status:** Approved
**Date:** 2026-04-13
**Author:** Maya (with Greg)

## Summary

Add a language/stack dimension to HIVE that's orthogonal to projects. A stack bundles domain-specific knowledge (rules, patterns, idioms) for a technology stack. When a project uses that stack, HIVE exposes the stack's skills to Claude Code so Maya can invoke them on demand.

First stack: `elixir` (covering Elixir + Phoenix + LiveView + Ecto + Oban). Content lifted from [oliver-kriska/claude-elixir-phoenix](https://github.com/oliver-kriska/claude-elixir-phoenix) (MIT licensed).

## Motivation

Stack-specific knowledge (Iron Laws, framework patterns, anti-patterns) is currently either absent from HIVE or mixed into project memory where it doesn't belong. Project memory is for things specific to *this* project; stack knowledge applies to every project using that stack.

The elixir-phoenix plugin has high-quality reference content — 22 Iron Laws, detailed pattern guides for LiveView/Ecto/Oban/OTP. We want the knowledge without the agent ecosystem, the workflow orchestrator, or the hooks (all of which overlap with or conflict with HIVE's own infrastructure).

## Non-Goals

- **Not a plugin marketplace** — this is personal infrastructure. No publishing, no versioning, no distribution story.
- **Not multi-stack per project** — single stack per project in v1. Extend later if real need appears.
- **Not replacing project memory** — stacks are orthogonal. Project memory still captures project-specific facts.
- **Not importing the agent ecosystem** — we don't want workflow-orchestrator, context-supervisor, specialist agents, or hooks from the source plugin.
- **Not importing `mix format` auto-hook** — formatting happens at commit time, not per-edit.

## Design

### Core concept

A **stack** is a named bundle of topic skills. Stacks are opinionated — `elixir` implicitly includes Phoenix/LiveView/Ecto/Oban because that's the stack Greg uses every time. No composability; one name covers the whole bundle.

### Directory structure

**Source of truth** (human-edited):
```
~/.hive/stacks/elixir/
  README.md                          # Overview, attribution, what's covered
  skills/
    elixir-idioms/
      SKILL.md                       # Summary: Iron Laws, patterns, pitfalls
      references/
        pattern-matching.md
        otp.md
        ...
    ecto-patterns/
      SKILL.md
      references/
        changesets.md
        queries.md
        migrations.md
        transactions.md
    liveview-patterns/
      SKILL.md
      references/
        async-streams.md
        forms-uploads.md
        components.md
        pubsub-navigation.md
    oban/
      SKILL.md
      references/...
    phoenix-contexts/
      SKILL.md
      references/...
    security/
      SKILL.md
      references/...
    testing/
      SKILL.md
      references/...
```

**Generated plugin** (not edited by hand — output of `hive stack sync`):
```
~/.claude/plugins/hive-elixir/
  plugin.json                        # Plugin manifest
  skills/
    elixir-idioms/SKILL.md + references/
    ecto-patterns/SKILL.md + references/
    ...
```

### Skill anatomy

Each topic skill follows the format used by the source plugin:

```markdown
---
name: elixir-idioms
description: "OTP/BEAM patterns and Elixir idioms — GenServer, Supervisor, Task, Registry, pattern matching, with chains, pipes. Use when designing processes or debugging BEAM issues."
---

# Elixir Idioms

## Iron Laws — Never Violate These
[numbered hard rules]

## Core Principles
[short list]

## Quick Decision Trees
[control flow, error handling, OTP choices]

## Quick Patterns
[code examples]

## Common Pitfalls
[wrong/right table]

## References
[pointers to references/*.md for deep dives]
```

The SKILL.md is ~4KB. Detailed guides live in `references/` and are read on demand via the Read tool.

### Session-start behavior

When a HIVE session starts in a project directory:

1. **Identity stack** loads (SOUL/IDENTITY/SELF/AGENTS/TRUST) — unchanged.
2. **Project memory** loads from `~/.hive/memory/projects/<name>/_index.md` — unchanged.
3. **Stack detection** (new):
   - Read `~/.hive/projects/<name>/stack` if it exists. Single-line file containing the stack name, or `none` to disable.
   - Else: auto-detect from project root files. Lookup table maps `mix.exs` → `elixir`, `package.json` → `typescript`, etc.
   - If no stack detected, skip steps 4 and 5.
4. **Stack hint injection** (new): One line added to session context — "Project stack: elixir. Prefer `elixir:*` skills when they apply." No heavy content loaded.
5. **Claude Code skill discovery** (unchanged, but now picks up `hive-elixir` plugin): Claude Code lists available skills with their one-line descriptions. Maya sees `elixir:ecto-patterns`, `elixir:liveview-patterns`, etc. in her available skills.

### On-demand loading

When Maya needs stack knowledge:

1. She invokes a skill via the Skill tool: `Skill({ skill: "elixir:ecto-patterns" })`.
2. Claude Code loads the full SKILL.md into context.
3. SKILL.md's References section points to `references/*.md` files.
4. Maya reads those files via the Read tool when she needs the deep guide.

**Token cost at session start:** <1KB (just skill descriptions + stack hint). Full SKILL.md content only materializes when invoked.

### Project binding

**Auto-detection table** (initial):

| File at project root | Stack |
|----------------------|-------|
| `mix.exs`            | `elixir` |
| `package.json`       | `typescript` (future) |
| `Cargo.toml`         | `rust` (future) |
| `pyproject.toml`     | `python` (future) |

**Override file:** `~/.hive/projects/<name>/stack` — single line containing the stack name. Empty or missing = auto-detect. Contents `none` = explicitly disable stack loading.

**No stack detected = no failure.** HIVE silently skips stack loading. Projects without a matching stack work as they do today.

### CLI surface

Minimal. Stack discovery and loading run automatically; the CLI is only for managing stack sources.

```
hive stack init <name>     # Scaffold ~/.hive/stacks/<name>/ with empty skills/
hive stack sync <name>     # Read source, generate ~/.claude/plugins/hive-<name>/
hive stack list            # List available stacks (source + synced status)
```

No `install`, `publish`, `upgrade` — this is personal infrastructure. Sync is the only operation that matters.

### Plugin generation

`hive stack sync elixir` does the following:

1. Read `~/.hive/stacks/elixir/skills/*/SKILL.md` and their `references/` directories.
2. Write `~/.claude/plugins/hive-elixir/plugin.json`:
   ```json
   {
     "name": "hive-elixir",
     "version": "1.0.0",
     "description": "Elixir/Phoenix stack knowledge (generated by HIVE)"
   }
   ```
3. Copy each `skills/<topic>/` directory (SKILL.md + references/) into the plugin's `skills/` dir.
4. Claude Code picks up the plugin on next session start.

Sync is idempotent. Re-running it replaces the generated plugin contents.

### Extraction plan

Initial content comes from [oliver-kriska/claude-elixir-phoenix](https://github.com/oliver-kriska/claude-elixir-phoenix) (MIT).

Steps:
1. Clone the source repo to a scratch directory (not committed to HIVE).
2. Copy these 7 topic skills from `plugins/elixir-phoenix/skills/` into `~/.hive/stacks/elixir/skills/`:
   - `elixir-idioms`
   - `ecto-patterns`
   - `liveview-patterns`
   - `oban`
   - `phoenix-contexts`
   - `security`
   - `testing`
3. Skip: `deploy` (project-specific), `tidewave-integration` (requires Tidewave MCP we don't use), and all workflow skills (`plan`, `work`, `review`, `audit`, etc. — HIVE already covers those).
4. Light editing pass on each SKILL.md:
   - Remove references to `/phx:*` workflow commands we're not importing.
   - Normalize reference paths. The source uses `${CLAUDE_SKILL_DIR}/references/<file>` — verify this env var works when the plugin is loaded from `~/.claude/plugins/hive-elixir/`, or rewrite to relative paths.
5. Write `~/.hive/stacks/elixir/README.md` with:
   - What the stack covers.
   - Attribution: "Lifted from oliver-kriska/claude-elixir-phoenix under MIT license."
   - How to update: edit `skills/<topic>/SKILL.md`, then `hive stack sync elixir`.
6. Implement `hive stack init`, `hive stack sync`, `hive stack list` in `src/cli.ts` + supporting module.
7. Run `hive stack sync elixir`, verify plugin appears in `~/.claude/plugins/hive-elixir/`.
8. Start a Claude Code session in an Elixir project, verify `elixir:ecto-patterns` etc. appear in the Skill tool's available list.

## Risks & Open Questions

**Plugin format compatibility.** Claude Code's plugin structure — what `plugin.json` requires, how skills are discovered inside plugins — needs verification during implementation. The source repo's structure is a working reference, but we're generating rather than hand-authoring. If Claude Code's plugin schema has required fields we don't know about, sync logic needs to produce them.

**Reference path resolution.** The source uses `${CLAUDE_SKILL_DIR}/references/<file>.md`. If this env var isn't set for plugin-installed skills, references won't resolve. Mitigation: test during step 7 of extraction; fall back to relative paths if needed.

**Skill naming collisions.** `elixir:testing` is generic. If another stack later also has a `testing` skill, both coexist fine (different namespaces: `elixir:testing` vs `typescript:testing`). No conflict.

**Discovery without invocation.** Maya might not realize a stack skill applies in a given moment. Mitigation: the stack hint at session start names the preferred namespace, and Claude Code's skill descriptions are visible in the tool list. Over time, session reflection can capture "when in elixir project and touching LiveView, invoke `elixir:liveview-patterns` first" as a convention.

**License compliance.** MIT license permits relifting with attribution. Attribution goes in the stack README. The generated plugin also includes it in `plugin.json`'s description.

## Future Extensions (Not in v1)

- Additional stacks (`typescript`, `python`, `rust`) — same structure, different content.
- Stack-specific slash commands (e.g. `/elixir:assigns-audit` if a real repeated need appears).
- Multi-stack projects.
- Stack versioning / upgrade flow.
- Sharing stacks across users (publish to a marketplace).

None of these are needed for v1. Add when concrete pain appears.

## Success Criteria

- `hive stack sync elixir` produces a working Claude Code plugin at `~/.claude/plugins/hive-elixir/`.
- Starting a session in an Elixir project (auto-detected via `mix.exs`) shows `elixir:*` skills in the Skill tool's available list.
- Invoking `elixir:ecto-patterns` loads the SKILL.md content into Maya's context.
- Session-start token overhead for stack loading is <1KB.
- Editing `~/.hive/stacks/elixir/skills/ecto-patterns/SKILL.md` and re-running sync updates the plugin.
