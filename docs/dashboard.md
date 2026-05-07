# HIVE Dashboard

The Morning Edition dashboard pulls everything HIVE knows into one
glanceable surface — health, tickets, runs, memory, the morning briefing,
and last night's pipeline cost. Designed to be read over coffee, not
navigated.

## Two Surfaces, One Renderer

```
┌─────────────────────────────────────────────────────────────────┐
│  src/lib/dashboard/collect.ts   pure data collectors            │
│              │                                                  │
│              ▼                                                  │
│  src/lib/dashboard/render.ts    HTML serializer                 │
│              │                                                  │
│      ┌───────┴────────┐                                         │
│      ▼                ▼                                         │
│  static index.html   serve.ts (Bun.serve, 127.0.0.1:7777)       │
└─────────────────────────────────────────────────────────────────┘
```

- **Static** — `~/.hive/dashboard/index.html` rebuilt by the nightly job
  at 2am and on demand via `hive dashboard build`. Read-only, fast, opens
  with any file:// browser. The morning glance.
- **Interactive** — `hive dashboard serve` runs Bun.serve bound to
  `127.0.0.1:7777`. Adds action buttons (close ticket, dispatch, promote
  memory, ack inbox) backed by allowlisted handlers that shell out to the
  `hive` CLI via argv. Same renderer underneath, plus per-section
  fragment endpoints for optimistic swap on action.

Both surfaces consume the same `DashboardData` produced by pure
collectors. Tests assert on the data, not on HTML.

## What's On It

- **Per-project cards.** Heartbeat status, last tick, last result,
  ticket counts (open / in-progress / closed by priority), inbox
  freshness.
- **Ticket buckets.** Ready, in-progress, blocked. Sorted by priority
  then age. Click-through on the interactive server.
- **Recent runs.** Dispatch runs with status, duration, goal snippet,
  ticket linkage. Failed runs get prominence so you don't miss them.
- **Recent memory.** Newest facts, conventions, decisions, open
  questions across all projects, with strength scores from the BM25 +
  decay model.
- **Promotion candidates.** Memory entries that have accumulated enough
  recall strength to be worth promoting from project-local to broadly
  applicable.
- **Open questions.** Cross-project rollup of unresolved questions —
  the things HIVE knows it doesn't know.
- **Morning briefing.** The narrative summary written by the nightly
  Opus verifier — what landed, what shifted, what's worth attention.
- **Pipeline cost.** Last night's V1 nightly cost broken out by pass
  (B, C, V) with input/output tokens and USD per project. Typically
  $1–3.
- **System health.** Tail line and mtime for `heartbeat`, `nightly`,
  `morning`, and `sync` launchd jobs.

## Archive

Each morning build also writes a frozen snapshot at
`~/.hive/dashboard/archive/YYYY-MM-DD.html`. The interactive server
serves those at `/archive/:date` with action buttons suppressed
(frozen days are read-only). Lets you scroll back through what
yesterday's HIVE looked like.

## Commands

| Command | Effect |
| ------- | ------ |
| `hive dashboard` | Open in browser. If the server is up on 7777, opens that; else builds the static page and opens it. |
| `hive dashboard build` | Regenerate `~/.hive/dashboard/index.html` and write today's archive snapshot. |
| `hive dashboard serve [--port N] [--open]` | Start the interactive server. Default port `7777`, override via `HIVE_DASHBOARD_PORT`. `--open` opens the browser after starting. |
| `hive dashboard open` | Open the existing static page without rebuilding. |
| `hive dashboard path` | Print the dashboard file path. |

The nightly job runs `hive dashboard build` automatically after the
memory pipeline lands, so the morning page reflects the previous
night's verification.

## Design Notes

- **Localhost-only.** The interactive server binds `127.0.0.1`. POST
  endpoints check `Origin`. No external exposure, no auth layer needed.
- **Inline everything.** CSS, JS, fonts — all inline. No CDN, no
  network requests. Works offline.
- **Broadsheet aesthetic.** Cream background (`#f7f3ea`), deep
  charcoal ink, amber accents, serif body. Tabular figures for ledger
  tables. No icons, no shadows, no border-radius above 2px. The look
  is deliberate; the goal is to feel like a Saturday paper.
- **No framework.** Vanilla DOM, hand-rolled fragments. The whole
  surface is small enough that a framework would cost more than it
  buys.

## Source

- `src/commands/dashboard.ts` — CLI entry point
- `src/lib/dashboard/collect.ts` — pure data collectors (the testable layer)
- `src/lib/dashboard/render.ts` — HTML renderer
- `src/lib/dashboard/serve.ts` — Bun.serve interactive server
- `src/lib/dashboard/actions.ts` — allowlisted action handlers
- `src/lib/dashboard/archive.ts` — archive snapshot helpers
- `src/lib/dashboard/styles.ts` / `script.ts` — inlined CSS / JS
- `src/__tests__/dashboard-*.test.ts` — collector + renderer + server tests
