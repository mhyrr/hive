# Tickets Page — Design

**Status:** Approved
**Date:** 2026-05-09
**Author:** Maya (with Greg)
**Tracks:** dashboard, tickets

## Summary

Add a dedicated `/tickets` page to the HIVE dashboard. Replaces the home-page tickets summary as the deep view. Layout: per-epic mini-kanbans (Ready / In Progress / Blocked) plus a top-of-page Standalone block for tickets with no parent epic. Server-rendered fresh on every load; no polling.

Ships a writer fix for the underlying linkage gap: child tickets gain a `parent_epic` field, and the epic body's `## Children` section gets real `TK-NNN` IDs substituted in place of placeholder refs (`C1, C2, …`).

## Motivation

The current dashboard surfaces tickets as a flat 3-column section on the home page. It works for "what's open right now," but loses everything about how tickets relate. After TK-036 lands the goal-decomposition primitive, epics with 5–10 child tickets are the new common shape — and a flat list discards that structure. The one-line ask: "more than a list, across projects, how they relate."

## Non-Goals

- Filtering by project / priority / tags (V2)
- Free-text search (V2)
- Drag-to-reorder, drag-to-change-status (V2)
- Click-through ticket detail panel (V2 — link is placeholder anchor in V1)
- Closed-ticket archive view (V2 — closed tickets are hidden entirely in V1)
- Real-time auto-refresh / SSE / websocket polling (V1 = fresh on load)

## Design

### Route

- `GET /tickets` — full page, server-rendered, fresh on every load.
- `GET /fragment/tickets-page` — section fragment used by the existing action handlers (`POST /action/ticket/...`) so the page refreshes after a ticket is created / started / closed without a full reload.
- The home page's existing tickets summary section stays as the at-a-glance widget. The new page is the deep view.

### Writer fix (pre-requisite)

Two small changes to `src/lib/decompose-write.ts`, gated by the same writeProposal entry point:

1. **`parent_epic` on each child.** When the writer creates an epic, every subsequent child ticket gets `parent_epic: TK-NNN` in its frontmatter. The dashboard groups by this field.
2. **Epic body fix-up.** After all children are created, the writer reads the epic ticket back, replaces its body's `- C1 —` / `- C2 —` placeholders with the real `TK-NNN — Child title` lines, and rewrites the file. Single-shot fix-up at end of `writeProposal`.

Plus a one-shot CLI: `hive ticket relink-epics`. Scans existing `type: epic` tickets, identifies probable children by creation-time-proximity (±2 minutes) and shared tags, and back-fills `parent_epic` where missing. For TK-073's 7 children (created today before the writer fix), this is the path to retroactive linkage. The migration is best-effort and idempotent.

### Data layer

New collector in `src/lib/dashboard/collect.ts`:

```ts
type TicketsPageData = {
  generatedAt: string;
  epics: Array<{
    epic: TicketCitation;
    buckets: TicketBuckets;          // children grouped by Ready/InProgress/Blocked
    childCount: number;
    lastActivity: string;             // ISO ts of most recent child update
  }>;
  standalone: TicketBuckets;          // tickets with no parent_epic
  totalActive: number;
  projectCount: number;
};
```

- Walks every project's tickets; an epic that has at least one open child gets included.
- Closed epics with all-closed children are dropped entirely (V1 has no archive surface).
- Sort epics by `lastActivity` desc.
- Within each bucket: priority asc, then ticket ID asc.

### Render

Page structure top-to-bottom:

1. Page header — `TICKETS` masthead, generated timestamp, "N active across M projects" kicker.
2. Standalone block — single mini-kanban (Ready / In Progress / Blocked). Only renders if non-empty.
3. Per-epic blocks — one mini-kanban per epic, header carries epic ID + title + project chip + priority + tags + age.
4. (No closed section in V1.)

Card content (one per ticket):
- `TK-074` (anchor link, target placeholder until V2 detail page)
- Title (single-line truncated)
- `[project]` chip
- `P0/P1/P2/P3` priority badge
- `↳ TK-074` blocked-by note — only rendered on cards in the Blocked column
- Tags suppressed on cards (epic header carries them)

Empty kanban columns render as `—` so the layout doesn't shift.

### Nav

Add `TICKETS` to the existing dashboard navbar. Active state when path is `/tickets`. The other nav items (`BRIEFING`, `PROJECTS`, `INBOX`, `REFLECTIONS`, `DISPATCH`, `ARCHIVE`) are unchanged.

### Styles

Newspaper-broadsheet aesthetic preserved (cream bg, deep charcoal ink, amber accents, Iowan Old Style serif). New classes added to `src/lib/dashboard/styles.ts`:

- `.tickets-page` — page container
- `.epic-board` — wrapper around one epic's kanban (header + 3-col grid)
- `.epic-board-head` — epic header row (id, title, chips)
- `.kanban` — 3-column grid
- `.kanban-col` — single column (Ready / In Progress / Blocked)
- `.kanban-col-head` — column label + count
- `.ticket-card` — card body
- `.ticket-card .blocked-by` — `↳ TK-X` annotation
- `.standalone-board` — variant of `.epic-board` for the top block

No new fonts, no new colors. Hairlines and small caps follow the existing dashboard palette.

### Files touched

- `src/lib/dashboard/collect.ts` — add `collectTicketsPage` + new types
- `src/lib/dashboard/render.ts` — add `renderTicketsPage` and helpers
- `src/lib/dashboard/styles.ts` — new CSS classes (above)
- `src/lib/dashboard/serve.ts` — add `/tickets` route + register fragment
- `src/lib/dashboard/fragments.ts` — register `tickets-page` fragment
- `src/lib/decompose-write.ts` — `parent_epic` field on children, epic body fix-up
- `src/lib/ticket.ts` — add `parent_epic?: string` to `Ticket`, parse/serialize
- `src/commands/ticket.ts` — `relink-epics` subcommand
- New test: `src/__tests__/dashboard-tickets-page.test.ts`

### Build sequence

1. `parent_epic` field through ticket layer (type, parse, serialize, tests still green)
2. Writer fix: set `parent_epic` on children + body fix-up
3. `relink-epics` migration command + back-fill TK-073's children manually
4. Data collector + tests
5. Renderer + styles
6. Server route + fragment
7. Nav link + smoke check in browser

Each commit green on its own.

### Open calls (made by Maya, push back if wrong)

- **Standalone block at top, not bottom.** Standalone work is "drift" — tickets not folded into a campaign. Top placement keeps the prompt to either close, dispatch, or epic-fold visible.
- **Closed tickets hidden entirely in V1.** Real-time + more-than-a-list both want signal; closed tickets are noise. Archive surface is V2.
- **Sort epics by `lastActivity` desc, not priority.** Activity tracks where the work is; priority alone surfaces stalled P1s ahead of active P2s, which inverts what the page is for.
