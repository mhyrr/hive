# Elixir / Phoenix root file starter

Copy the body below to your repo's `AGENTS.md` (Codex reads only that name)
with `CLAUDE.md` a symlink or a one-line `@AGENTS.md` import. Fill in the
angle brackets, delete what doesn't apply, keep it under 8 KB and 200 lines.
`CLAUDE-starter.md` has the six rules and the porting procedure.

The `elixir-*` skills carry this stack's canon — OTP, Ecto, LiveView, Oban,
contexts, security, testing — and load on demand. Never copy that canon here;
a root file that restates a skill pays for it in every session.

---

# <App>

<One paragraph: what this is, who it's for, the current focus.> One Phoenix
application: Elixir <x.y>, Phoenix <x.y>, LiveView <x.y>, PostgreSQL.

| Read this | For |
|---|---|
| `README.md`, `PRODUCT.md` | What it is, who it's for, what it promises |
| `docs/design/<doc>.md` | The architecture and its numbered decisions |
| `DESIGN.md` | The surface. Binding; it overrides generic UI guidance |

## The line the codebase is built around

- **Contexts are the API.** Web and LiveView call contexts; contexts call
  Ecto. A `Repo` call outside a context is the boundary being lost.
- **<The one rule this app cannot break.>** <What breaks without it.>

## Where things live

```text
lib/<app>/                  contexts: the public API of each domain
lib/<app>/<context>.ex      <what this context owns>
lib/<app>/repo.ex           the only Repo
lib/<app>_web/router.ex     pipelines and scopes
lib/<app>_web/live/         <the surfaces>
lib/<app>_web/components/   shared function components
priv/repo/migrations/       schema history, append-only
```

## Commands

```sh
mix precommit          # compile --warnings-as-errors, deps, format, test — run before calling anything done
mix test --failed      # reruns only the previous run's failures
mix test test/path.exs:42   # a single test by line
mix ecto.reset         # drop, create, migrate, seed
```

## Conventions

- Migrations are append-only once merged; a mistake gets a new migration.
- `Mix.env()` never changes runtime behaviour — it is a config value, and a
  release has no `:dev`.
- Moduledocs say why, and name the alternative that was rejected.
- A broad `rescue` states why it is broad, at the rescue.
- Incidents and gotchas go to HIVE memory, not this file.

---

Skill content derived from
[oliver-kriska/claude-elixir-phoenix](https://github.com/oliver-kriska/claude-elixir-phoenix)
(MIT). Full license text in `LICENSE`.
