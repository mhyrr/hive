# Watches

Standing questions evaluated against fresh deltas (TK-138). The heartbeat's
successor, built on the opposite premise: instead of "check project health"
every N minutes, a watch wakes with a **specific question**, a **scoped
delta** (what changed since it last looked), and a **defined artifact**. The
ambient-agent feel comes from specific questions meeting fresh evidence —
and from the activity ranker pointing attention at the projects you've
actually been touching.

## The primitive

A watch is a markdown file. The body is the standing question, passed
verbatim as the prompt core. Frontmatter declares everything else.

Locations:

- `~/.hive/watches/*.md` — cross-project (all registered projects in scope)
- `~/.hive/projects/<p>/watches/*.md` — scoped to one project

```markdown
---
name: bets              # defaults to the filename sans .md
cadence: @nightly       # 2h | 45m | 1d | @nightly | @morning | mon,thu
scope: runs, tickets    # tickets | commits | transcripts | memory | inbox | runs
window: 7d              # delta/digest lookback (default 24h)
model: judgment         # fast | standard | judgment — tier alias, never a raw model ID
venue: briefing         # inbox | briefing   (tickets/dispatch reserved for the harvester slice)
autonomy: propose       # observe | propose | act (act reserved for the harvester slice)
enabled: true
---

The standing question, in plain language. It becomes the prompt.
```

Writing your own watch is the front door, not an internal detail: drop a
file in `~/.hive/watches/`, and it is live at the next tick. No code.

A malformed file degrades to a parse warning (visible in `hive watch list`
and on the dashboard page); it never kills the tick. A `README.md` in a
watches dir is documentation, never parsed as a watch.

## Where everything lives

`~/.hive/watches/` is the whole subsystem, self-described by its README:

- `*.md` — the cross-project watches themselves (project-scoped ones under
  `projects/<p>/watches/`)
- `state.json` — per-watch tick state + the hourly `lastTick` liveness stamp
- `log/<date>/<watch>-<time>.md` — **one file per model invocation**: the
  exact system prompt, the full assembled digest + standing question sent,
  and the raw output or error, with outcome and delta reasons in the
  frontmatter. No-delta ticks make no call and log nothing. If a watch
  surfaced something, the complete prompt that produced it is on disk.

## Scheduling

One launchd job, `com.hive.watches`, ticks hourly and runs `hive watch run
--due`. Due-ness by cadence:

- **Intervals** (`2h`, `45m`, `1d`) — due when that much time has passed
  since the watch was last *evaluated* (a quiet evaluation counts).
- **`@morning` / weekday lists** (`mon,thu`) — due once per day, on the
  first tick at or after 06:00 local. Output is ready before the workday
  without competing with interactive-hours quota.
- **`@nightly`** — never due on the tick. The nightly orchestrator invokes
  these itself (the W pass, after the fact and taste tracks, before the
  dashboard rebuild) so they can read that night's `runs/{DATE}/` artifacts.

`hive watch run <name>` force-runs a watch, bypassing due-ness *and* the
delta gate — the operator asked, so the model looks.

## The delta gate

Deterministic pre-check before any model call — cheap local signals only
(no network, no LLM). If nothing in scope changed since the watch last
looked, the tick costs zero tokens and writes a state line only.

Two detector styles, chosen to avoid phantom deltas from sliding windows:

- **Content-hash kinds** — `tickets`, `memory`, `inbox`. Fingerprint the
  full current state; only a real edit changes it.
- **Watermark kinds** — `commits`, `transcripts`, `runs`. A monotonic
  high-water mark (newest commit time, newest session mtime, newest run-dir
  mtime). Items aging *out* of the window can only lower the current mark,
  and lower never triggers.

First evaluation over non-empty scope counts as new (establish baseline and
look); an entirely empty scope never triggers.

## Digest assembly

The gate gathers fingerprints; the digest gathers content — and only for
watches the gate passed. The digest is the model's **entire** evidence base:
code gathers, the model judges, it never fetches. Per watch tick, everything
except at most one model call is deterministic.

Cross-project digests are **activity-ranked**: projects score by commits +
2×sessions + tickets moved within the window. The top five warm projects get
full sections; cold repos are named in one line and not expanded. This is
the "look where the work has been happening" behavior, computed from local
signals.

Sections carry citable anchors — ticket IDs, commit SHAs, session labels,
artifact paths — and every cap is announced in the digest text (no silent
truncation).

## Quiet discipline and provenance

- Every watch prompt states that silence is a valid answer. The model
  replies exactly `NO_SIGNAL` when nothing clears the bar; that outcome is
  logged, never written to a venue.
- **No citation, no output**: a reply that cites no anchor from the digest
  is dropped (outcome `quiet`, with a note), not surfaced. Attention is the
  scarce currency; value is measured in signal surfaced, not ticks executed.

## Autonomy

`observe` writes a memo; `propose` surfaces candidate items, each with the
cited signal and a first concrete step; `act` may dispatch — **reserved for
the harvester slice**, which is gated on dispatch reliability (TK-125,
TK-130).

Two clamps apply, and the lower always wins:

1. **Global ceiling** — `watches.max_autonomy: observe|propose|act` in
   `~/.hive/config.md`. Missing → `propose`. Set `observe` and the whole
   fleet is read-only; one knob.
2. **Slice-1 hard cap** — the runner tops out at `propose` regardless of
   ceiling until act-capable machinery exists.

## Model tiers and budget

Watch files carry tier aliases; resolution lives in one module
(`src/lib/watch-model.ts`):

| Alias      | Default            | Override env                |
| ---------- | ------------------ | --------------------------- |
| `fast`     | `claude-haiku-4-5` | `HIVE_WATCH_MODEL_FAST`     |
| `standard` | `claude-sonnet-5`  | `HIVE_WATCH_MODEL_STANDARD` |
| `judgment` | `claude-opus-4-8`  | `HIVE_WATCH_MODEL_JUDGMENT` |

`HIVE_WATCH_MODEL_<NAME>` pins one watch (name uppercased, non-alphanumerics
→ `_`), taking precedence over the tier env.

Budget posture (TK-138 note): budgets are **count caps**, because token
accounting from spawned runs is unreliable (TK-120/TK-128). One call per
watch per tick is structural; `HIVE_WATCH_MAX_CALLS_PER_TICK` (default 4) is
a backstop — deferred watches report `deferred:cap` and re-fire next tick.
Tokens are logged to `~/.hive/watches/state.json` for the status/dashboard
views, never enforced.

Every call goes through `completeClaudeTextBounded`: `claude --print` with
`--tools ""`, `--strict-mcp-config`, the identity-hook guard, and a
15-minute deadline. Watches run in **series** — concurrent `claude --print`
subprocesses contend on OAuth/Keychain in detached launchd contexts.

Quota behavior: a rate-limit error records `deferred:quota` and skips the
tick without retrying — never hammer the shared subscription pool while
Greg is working. State is only settled on `surfaced`/`quiet`/`no-delta`, so
a deferred or errored watch keeps its old fingerprints and the same delta
re-fires it next tick.

## Control surface

```
hive watch list                  # discovered watches + settings + parse warnings
hive watch status                # + last tick, outcome, 7d logged spend, ceiling
hive watch run --due             # the launchd tick entrypoint
hive watch run <name>            # force-run (bypasses due-ness + delta gate)
hive watch on|off <name>         # enable / disable
hive watch off --all             # hard stop
hive watch set <name> k=v ...    # rewrite frontmatter, validated
```

The dashboard serves `/watches`: the fleet table (own vs effective autonomy,
last outcome, 7d logged spend), recent briefing-venue artifacts, parse
warnings, and a tick-liveness line backed by the `lastTick` stamp the hourly
tick writes even when nothing is due. Dispatch-run monitoring is explicitly
out of scope there (TK-030).

## Shipped watches

Installed by `hive init` from `templates/watches/` (idempotent — your edits
are never overwritten).

### bets — nightly bets (`@nightly`, judgment, propose → `runs/{DATE}/bets.md`)

*Given the actual activity of the last week, what non-obvious, contrarian,
or accretive bets should we be thinking about?* Scope `runs, tickets` over
7d: the digest is assembled from existing nightly artifacts (briefing,
taste-decisions) plus ticket movement — no new extraction calls. At most 3
bets, each with cited signal, cost/displacement, and a first step; zero is a
valid output, and the slop filter rejects any bet that could have been
written without reading the week. The latest bets also render as a **Bets
section on the main dashboard page**, right after the briefing (no section
on quiet nights). Filing is manual: read, say "file #2", Maya files.

### muse — cross-project muse (`mon,thu`, judgment, observe → `~/.hive/inbox.md`)

*What has Greg been thinking about, and what ideas, pointers, and
connections keep the juices flowing?* Scope `transcripts, memory` over 4d,
activity-ranked across projects, collapsed to one judgment call.
Deliberately 2×/week — daily muse output becomes wallpaper. **No web access
in slice 1**: a web-enabled muse is a dispatch-grade run, gated on the same
dispatch-reliability work (TK-125/TK-130) as the harvester; pointers must
already exist in the digest, and the prompt forbids invented links.

### Work harvester — designed, not shipped

The `act`-autonomy watch that dispatches unambiguous, Greg-decision-free
tickets. Fully specified in TK-138; deliberately absent from slice 1 (no
template file ships, even disabled) until dispatch reliability lands. Its
venues (`tickets`, `dispatch`) and the `act` level are reserved in the
schema.

## Slice-1 limits, named

- One model call per watch per tick — the ticket's "≤2 calls" muse option is
  collapsed to one judgment call.
- Venues `tickets` and `dispatch` return an error outcome if used.
- `act` is unreachable (hard cap at `propose`).
- No web access anywhere in the fleet.
