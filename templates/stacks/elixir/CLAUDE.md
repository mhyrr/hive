# Elixir / Phoenix Stack

This project uses the `elixir` HIVE stack. Seven specialist skills are
available via Maya's Skill tool — reach for them by topic rather than
reading reference files by hand.

## When to reach for which skill

- **`elixir-idioms`** — OTP/BEAM, GenServer/Supervisor/Task/Registry,
  pattern matching, `with` chains, pipe idioms. Default skill when
  designing processes or debugging BEAM behavior.
- **`elixir-ecto-patterns`** — schemas, changesets, queries, migrations,
  `Ecto.Multi`, preloads, transactions. Invoke when touching `Repo.*`,
  `Ecto.Query`, or anything under `priv/repo/migrations/`.
- **`elixir-liveview-patterns`** — `assign_async`, streams, LiveComponents,
  forms, uploads, PubSub, channels, JS interop. Invoke on `*_live.ex`,
  `*_component.ex`, `*_channel.ex`.
- **`elixir-oban`** — workers, queues, cron, retries, unique jobs,
  idempotency, Oban Pro (Workflow/Batch/Chunk/Smart). Invoke on worker
  files or queue config.
- **`elixir-phoenix-contexts`** — context design, scopes (1.8+), routers,
  plugs, JSON APIs. Invoke when designing boundaries or editing contexts.
- **`elixir-security`** — auth flows, OAuth, sessions, CSRF, XSS, SQL
  injection, input validation, secrets. Invoke on auth/session/password
  files or RBAC changes.
- **`elixir-testing`** — ExUnit, Mox, factories, LiveView test helpers.
  Invoke on `*_test.exs`, `test/support/`, or when fixing test failures.

Each SKILL.md is the quick reference; deep dives live in
`references/*.md` and load on demand.

## Cross-cutting Iron Laws

These appear across multiple skills. They're non-negotiable.

1. **Let it crash.** Supervisors restart; defensive `try/rescue` hides
   bugs. Exceptions are for exceptional conditions; return tagged tuples
   (`{:ok, _}` / `{:error, _}`) for expected failures.
2. **Pattern match, don't branch.** Destructure in function heads or
   `case`; avoid nested `if`. `with` chains compose `{:ok, _}`/`{:error, _}`
   flows without staircases.
3. **Pin values in queries.** `u.name == ^user_input` is safe; string
   interpolation into queries is SQL injection.
4. **Changesets for external data, `change/2` for trusted data.** `cast/4`
   whitelists user/API input. Internal writes skip casting.
5. **Never use `:float` for money.** `:decimal` or integer cents.
6. **Preload collections, not individuals.** Preloading inside a loop
   is N+1. Do it once at the query level.
7. **Constraints beat validations for race conditions.** Validations give
   fast feedback; DB constraints provide actual safety.
8. **No IO.inspect in committed code.** Use `dbg/2` for debugging and
   strip before commit. Logger for persistent observability.

## Design philosophy

- **Processes, not objects.** State lives in processes; message passing
  replaces method calls.
- **Contexts are the API.** Web/LiveView layers call contexts; contexts
  call Ecto. Don't let `Repo` calls escape the context boundary.
- **OTP by default.** GenServer for stateful workers, Supervisor for
  restart strategy, Task for fire-and-forget concurrency, Registry for
  process discovery. Reach for a library only after OTP stops fitting.
- **Explicit is better than magical.** Prefer clear function signatures
  and explicit data over macro-heavy DSLs.

## Attribution

Skill content derived from
[oliver-kriska/claude-elixir-phoenix](https://github.com/oliver-kriska/claude-elixir-phoenix)
(MIT). Full license text in `LICENSE`. Workflow skills and the agent
ecosystem from that source plugin are intentionally not imported —
HIVE provides those.
