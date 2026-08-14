---
version: 1
slug: "src-lib-dashboard-render-ts"
primary_target: "src/lib/dashboard/render.ts"
related_targets: ["src/lib/dashboard/collect.ts","src/lib/dashboard/styles/index.ts","src/lib/dashboard/serve.ts"]
---

## Scope

The HIVE dashboard, both delivery modes off one renderer: the static
`~/.hive/dashboard/index.html` rebuilt nightly, and the interactive
`Bun.serve` on 127.0.0.1:7777. Archive snapshots inherit this surface with
actions suppressed.

## Visitor mode

Operate. Expression may never obscure task, state, or a familiar affordance.
The ambition lands in composition, density, type, and colour strategy — not
in hero theatrics.

## Audience and job

One reader, fluent in HIVE's vocabulary, at the start of the day. The job is
not "review everything that happened." It is: **decide where attention goes
today.** A secondary visit mid-day asks one question — did the dispatch land.

## Direction

**The Apiary Record** — a beekeeper's per-colony inspection card. Seed key
`2570ec1e`, assigned index 6, resolved attended.

Projects are colonies. The nightly pass is the inspection. The output of an
inspection is not a log, it is a **verdict per colony**, drawn from a small
closed vocabulary, and that verdict is what the reader came for.

The palette comes from painted hive bodies — flat saturated cobalt,
verdigris, oxide red on weathered chalk — because bees orient by colour and
beekeepers paint for identification across a yard. Each project owns a colour
that carries a whole region. Oxide red is reserved for escalation and is
never decorative.

**Anti-reference, binding:** no hexagon anywhere; honey-amber is not the
accent. The literal reading of the brand is the failure mode, and the
incumbent broadsheet — cream ground, serif display, hairline rules — is the
look this replaces, not a fallback to drift toward.

**Raises carried in from the worlds it beat** (each is a build obligation,
not a note):

- Keyboard addressing — every colony and section reachable by typed address,
  no mouse required.
- Magnitude as field — strength, load, and cost render with real extent,
  never a bare numeral in a cell.
- Fixed scale across time — archive days, decay curves, and per-pass cost
  hold one scale so days compare by eye; nothing auto-fits per card.
- Linked deployment — opening a colony is one orchestrated act across the
  yard, not a card that grows and shoves its neighbours.
- Directional meaning — motion happens only when state changed, and its
  direction says which way.

## Memorable moment

The yard at first viewport: every colony in its own painted colour, each
carrying tonight's verdict in the beekeeper's shorthand. The reader knows
which projects need them before reading a single number.

## Information architecture

Reorganised around the inspection, replacing the flat section stack:

1. **The yard** — every colony, its colour, its verdict. First viewport.
   Verdicts, not counts.
2. **Inspection record** — what the night shift observed per colony, in ruled
   columns. Absorbs the morning briefing and the run outcomes; the briefing
   no longer leads the page.
3. **Stores** — memory. Accumulated canon, strength as extent, promotion
   candidates as frames ready to move up.
4. **Brood** — work in progress. Ticket distribution read as brood pattern;
   the ready/in-progress/blocked buckets dissolve into their colony.
5. **Treatment log** — dispatch runs and outcomes, dated.
6. **Upkeep** — pipeline cost per pass and launchd health, demoted to a quiet
   band. Rarely actionable, never leading.
7. **The yard book** — archive of past inspections.

## Constraints

Zero network requests: CSS, JS, and fonts inline, must render from `file://`
offline. Any face the direction needs is base64-embedded or it is a system
stack. Interactive actions remain allowlisted shell-outs to the `hive` CLI —
the surface cannot offer an action the CLI does not expose.

## Unresolved

- Verdict vocabulary: the closed set and the exact condition that triggers
  each. Drafted as leave alone / needs feeding / queenless / swarm risk /
  treat; the mapping to real signals needs confirming against `collect.ts`.
- Whether verdicts are computed in `collect.ts` (testable, preferred) or
  derived in the renderer.
- Typeface selection under the embed constraint.
