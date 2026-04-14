# Elixir Stack

Opinionated bundle of skills for Elixir / Phoenix / LiveView / Ecto / Oban work.
Covers Iron Laws, framework patterns, and common pitfalls.

## Skills

- `elixir-idioms` — OTP/BEAM, pattern matching, with/pipes, error handling, anti-patterns
- `ecto-patterns` — schemas, changesets, queries, migrations, transactions
- `liveview-patterns` — async/streams, forms/uploads, components, pubsub, channels
- `oban` — workers, queues, testing patterns, Oban Pro basics
- `phoenix-contexts` — context design, scopes/auth, plugs, routing, JSON APIs
- `security` — auth, authorization, input validation, rate limiting, headers
- `testing` — ExUnit, factory patterns, LiveView testing, Mox

Each skill's `SKILL.md` is the quick reference; `references/*.md` hold deep dives,
loaded on demand.

## How stack sync works

Source lives here (`~/.hive/stacks/elixir/`). Running `hive stack sync elixir`
copies the skill directories into `~/.claude/skills/elixir-<topic>/` where Claude
Code picks them up as user-level skills. Each skill is renamed so `ecto-patterns`
appears as `elixir-ecto-patterns` — flat but disambiguated.

Sync is idempotent. Re-running replaces any existing `~/.claude/skills/elixir-*`
entries that this stack owns.

## Updating

Edit `skills/<topic>/SKILL.md` (or files under `references/`), then:

    hive stack sync elixir

Changes take effect on the next Claude Code session.

## Attribution

Content lifted from [oliver-kriska/claude-elixir-phoenix](https://github.com/oliver-kriska/claude-elixir-phoenix)
under the MIT License. See `LICENSE` for the full text.

Skills imported: `elixir-idioms`, `ecto-patterns`, `liveview-patterns`, `oban`,
`phoenix-contexts`, `security`, `testing`. Workflow skills (`plan`, `work`,
`review`, etc.) and agent ecosystem from the source repo are intentionally
excluded — HIVE provides those.
