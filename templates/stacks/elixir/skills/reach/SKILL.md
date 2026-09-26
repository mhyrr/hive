---
name: reach
description: "Reach — program dependence graph for BEAM code. Impact analysis before you change a function, taint tracing from input to sink, architecture policy checks, OTP/process maps. Use when asked what depends on what, before editing a widely-called function, or before a release. Elixir/Erlang only — do not use the JS/TS frontend."
effort: medium
user-invocable: false
---

# Reach

Reach builds a program dependence graph — control flow, call graph, data flow,
effects, OTP relationships — and answers questions the compiler cannot:

- What calls this function, and how far does a change ripple?
- Can `conn.params` reach `Repo`, `System.cmd`, or a file write?
- Did this change cross a layer boundary?
- Which modules are coupled, effect-heavy, or hot?
- Which processes, callbacks, and handlers talk to each other?

Findings are **advisory** by default. They are review leads, not verdicts.

## Install

Reach is a per-project dev dependency. There is no global install — the mix
tasks read `elixirc_paths` from the project you run them in.

```elixir
{:reach, "~> 2.8", only: [:dev, :test], runtime: false}
```

Optional deps, each unlocking output:

```elixir
{:jason, "~> 1.0"},       # --format json
{:boxart, "~> 0.3.3"},    # terminal graphs
{:makeup, "~> 1.0"},      # syntax highlighting in the HTML report
{:makeup_elixir, "~> 1.0"}
```

Then `mix deps.get`. Requires Elixir 1.18+ / OTP 27+.

## The six commands

| Command | Purpose |
|---|---|
| `mix reach` | Interactive HTML report |
| `mix reach.map` | Project map: modules, coupling, hotspots, effects, depth, data flow |
| `mix reach.inspect TARGET` | One target: deps, impact, context, why-paths, candidates |
| `mix reach.trace` | Data flow, taint, slicing |
| `mix reach.check` | CI/release gates: architecture, changed code, dead code, smells |
| `mix reach.otp` | Behaviours, state machines, supervision, concurrency |

`TARGET` is either `MyApp.Accounts.create_user/1` or `lib/my_app/accounts.ex:42`.

## How to use it as an agent

**Start narrow.** `mix reach.map` prints the whole project and buries the answer.
Ask about the thing you are touching:

```bash
mix reach.inspect MyApp.Accounts.create_user/1 --impact     # who breaks if I change this
mix reach.inspect MyApp.Accounts.create_user/1 --why MyApp.Repo   # how does it reach the DB
mix reach.trace --from conn.params --to System.cmd          # can user input reach a shell
mix reach.check --changed --base main                       # what this branch put at risk
```

**Budget the wall clock.** Every command rebuilds the graph from source — no
cache between runs. On a 285-file project that is 80–100 s per invocation.
Pick the one question that matters; do not loop.

**Use `--format json` when the output feeds code.** Canonical commands emit a
stable envelope: `{"command":"reach.inspect","tool":"reach.inspect", ...}`.

**Report findings as leads.** A smell is a place to look, not a bug. Read the
code before you repeat the claim.

## Policy checks

`.reach.exs` at the project root declares architecture policy:

```elixir
[
  layers: [
    web: "MyAppWeb.*",
    domain: "MyApp.*",
    data: ["MyApp.Repo", "MyApp.Schemas.*"]
  ],
  deps: [forbidden: [{:domain, :web}, {:data, :web}]],
  source: [forbidden_modules: ["MyApp.Legacy.*"]],
  calls: [forbidden: [{"MyApp.Domain.*", ["IO.puts"]}]]
]
```

Then `mix reach.check --arch`. Add `--strict` to make findings fail the build.

**Baselines are scope-locked.** `--write-baseline .reach-baseline.json` records
`MIX_ENV`, source roots, and file count. Running under a different env or path
set aborts:

```
** (Mix) Baseline .reach-baseline.json was created for a different analysis
   scope. Expected MIX_ENV=test; ... current scope is MIX_ENV=dev; ...
```

Pick one env for baselines (usually `MIX_ENV=test`) and keep every CI and local
invocation on it, or regenerate.

## Library API

For snippets and one-off analysis without the CLI:

```elixir
graph = Reach.string_to_graph!(source)
Reach.backward_slice(graph, node_id)
Reach.taint_analysis(graph, sources: [function: :params], sinks: [module: System, function: :cmd])
Reach.Project.from_sources(paths)      # explicit file list
Reach.Project.from_glob("lib/**/*.ex")
```

## Elixir and Erlang only

Reach's optional JS/TS frontend (`:quickbeam`) is not usable: a file it can't
convert raises an exception Reach doesn't rescue, aborting the whole run, and
because it strips `import`/`export`, cross-file calls resolve by bare name —
the call graph is name-collision noise. For TypeScript, use the language's own
tooling. (Checked against reach 2.8.2 / quickbeam 0.11.0.)

## Reference

Full docs: https://hexdocs.pm/reach — source: https://github.com/elixir-vibe/reach
