---
name: elixir-idioms
description: "OTP/BEAM patterns and Elixir idioms — GenServer, Supervisor, Task, Registry, pattern matching, with chains, pipes. Use when designing processes or debugging BEAM issues."
effort: medium
user-invocable: false
---

# Elixir Idioms

Reference for writing idiomatic Elixir code with BEAM-aware patterns.

## Rules

1. **No process without a runtime reason** — Processes model concurrency, state, isolation—NOT code structure
2. **Messages are copied** — Keep messages small (except binaries >64 bytes)
3. **Guards use `and`/`or`/`not`** — Never use short-circuit operators in guards (guards require boolean operands)
4. **Changesets for external data** — Use `cast/4` for user input, `change/2` for internal
5. **Rescue only for external code** — Never use rescue for control flow
6. **No dynamic atom creation** — `String.to_atom(user_input)` causes memory leak (atoms aren't GC'd)
7. **@external_resource for compile-time files** — Modules reading files at compile time must declare `@external_resource`
8. **Supervise all long-lived processes** — Never bare `GenServer.start_link`/`Agent.start_link` in production. Use supervision trees
9. **Wrap external services, not frameworks** — an HTTP API, payment provider, or mailer gets a project-owned module behind a behaviour so it can be swapped and mocked (the testing skill's rules 3-4). Ecto, Phoenix and Oban are used directly
10. **No `IO.inspect` in committed code** — `dbg/2` while debugging, stripped before commit; `Logger` for anything that should persist

## Language Traps and Conventions

These fail to compile, silently do nothing, or break a convention the tooling assumes. Full examples in `references/language-traps.md`.

1. **Lists have no access syntax** — `mylist[i]` is invalid. Use `Enum.at/2`, pattern matching, or `List`
2. **Never rebind inside `if`/`case`/`cond`** — the block returns a value; bind *that*. `if x do socket = assign(...) end` throws the assign away
3. **NO `else if` / `elsif`** — Elixir has `if/else` only. Use `cond` or `case` for multiple conditions
4. **One module per file** — nested modules cause cyclic deps and compile errors
5. **Structs have no access behaviour** — `changeset[:field]` and `user[:email]` are invalid on structs. Use `user.email` or the struct's API (`Ecto.Changeset.get_field/2`)
6. **Predicates end in `?`, never start with `is_`** — `is_` is reserved for guards
7. **Date/time is in the stdlib** — `Date`, `Time`, `DateTime`, `Calendar`. Add no dependency for it (only exception: `date_time_parser` for parsing)

## Core Principles

1. **Pattern match over conditionals** — Function heads first, then `case`, then `cond`
2. **Tagged tuples for expected failures** — `{:ok, _}`/`{:error, _}` for expected errors, raise for bugs
3. **Pipe operator for data transformation** — Start with data, never pipe single calls
4. **Let it crash** — Handle expected errors, crash on unexpected ones

## Quick Decision Trees

### Control Flow

```
Need patterns? → case (or function heads)
Multiple operations? → with
Boolean conditions? → cond (multiple) or if (single)
```

### Error Handling

```
Expected failure? → {:ok, _}/{:error, _} tuples
Unexpected/bug? → raise exception (let supervisor handle)
External library? → rescue (only here!)
```

### OTP

```
Need state?
├─ No → Plain functions
├─ Simple get/update → Agent or ETS
├─ Complex messages/timeouts → GenServer
└─ One-off async → Task
```

## Quick Patterns

```elixir
# Pattern match in function head
def process(%{status: :active} = user), do: activate(user)
def process(%{status: :inactive} = user), do: deactivate(user)

# with for happy path
with {:ok, user} <- get_user(id),
     {:ok, order} <- create_order(user) do
  {:ok, order}
end

# Task with a timeout, supervised and unlinked
task = Task.Supervisor.async_nolink(MyApp.TaskSupervisor, fn -> work() end)
Task.yield(task, 5000) || Task.shutdown(task)
```

## Common Pitfalls

| Wrong | Right |
|-------|-------|
| `length(list) == 0` | `list == []` or `Enum.empty?(list)` |
| `acc ++ [item]` inside a loop/reduce | `[item \| acc]` in the loop, `Enum.reverse/1` once at the end |
| `String.to_atom(input)` | `String.to_existing_atom(input)` |
| `spawn(fn -> log(conn) end)` | `ip = conn.ip; spawn(fn -> log(ip) end)` |
| `unless condition` | `if !condition` (unless deprecated in 1.18) |
| `mylist[0]` | `Enum.at(mylist, 0)` |
| `changeset[:field]` | `Ecto.Changeset.get_field(changeset, :field)` |
| `def is_active?(u)` | `def active?(u)` (`is_` is for guards) |

## References

For detailed patterns, see:

- `references/language-traps.md` - Invalid-looking-valid syntax (list access, rebinding, Access on structs, `else if`)
- `references/pattern-matching.md` - Pattern matching, guards, binary matching
- `references/otp-patterns.md` - GenServer, Supervisor, Task, Registry
- `references/error-handling.md` - Tagged tuples, rescue, with
- `references/with-and-pipes.md` - When to use `with` and `|>` (idiomatic patterns)
- `references/troubleshooting.md` - Production BEAM debugging (memory, performance, crashes)
- `references/anti-patterns.md` - Common mistakes and fixes
- `references/mix-tasks.md` - Mix task naming, option parsing, shell output
- `references/elixir-118-features.md` - Duration module (1.17+), dbg improvements
