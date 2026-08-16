# HIVE Dashboard

The nightly pass is an inspection, and the dashboard is its report. It
opens with a verdict per project rather than a log — which projects want
you today, and why — and everything below that is the evidence. Designed
to be read over coffee, not navigated.

The design system it is built against is recorded in
[DESIGN.md](../DESIGN.md).

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
  `127.0.0.1:7777`. Adds action buttons (start, close, and annotate
  tickets) backed by allowlisted handlers that shell out to the
  `hive` CLI via argv. Same renderer underneath, plus per-section
  fragment endpoints for optimistic swap on action.

Both surfaces consume the same `DashboardData` produced by pure
collectors. Tests assert on the data, not on HTML.

## What's On It

Eight bands, in the order a morning actually wants them.

- **The yard.** Every project as a colony on one baseline. Height is
  accumulated memory on a shared scale, the entrance at the base is as
  wide as ticket traffic, and the plate underneath carries the verdict —
  `NEEDS YOU`, `QUEENLESS`, `ACTIVE`, `WAITING`, `QUIET`. Painted means
  look at me; unpainted pine means fine. Attention is a rubric over real
  signals (failed Act branches, non-empty project inboxes, stale work,
  unconfigured paths), not a single threshold. Clicking a colony filters the
  whole page to it.
- **Work.** What actually landed in the last two days, as the commit
  subjects people wrote — the only windowed record of work HIVE holds.
- **Briefing.** The narrative written by the nightly Opus verifier, set
  in columns: a lede, a block per project, then what needs your attention
  and the verifier's flags.
- **Watches.** What each standing watch last said, inline. The full
  fleet and its prompts live at `/watches`.
- **Tickets.** A five-per-project shortlist of what would be picked up
  next, with start / note / close inline. The whole board is at
  `/tickets`.
- **Stores.** Everything HIVE knows in one place — lately admitted
  entries, still-open questions, and promotion candidates that have
  accumulated enough recall strength to be worth broadening.
- **Archive.** 30 days of past briefings; click a date to open it.
- **Upkeep.** Deliberately quiet at the bottom: log activity for the
  `nightly`, `watches` and `sync` launchd jobs, last
  night's pipeline cost, and the taste queue when something is waiting.

Cut on purpose: generic execution history and the inbox band. Watch Act
surfaces only failed or review-ready branches in the yard's attention signal;
full private execution records stay off the dashboard.

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
