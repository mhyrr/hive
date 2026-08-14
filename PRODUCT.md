# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

**Dashboard (existing, settled by the codebase):** Bun + TypeScript. HTML is
serialized by hand in `src/lib/dashboard/render.ts`; CSS lives as TypeScript
template-literal modules under `src/lib/dashboard/styles/`; client behavior is
vanilla DOM in `script.ts`. No framework, no bundler for the page, no CDN. CSS,
JS, and fonts are inlined into a single document.

**Marketing/landing page:** undecided. No scaffold exists. The stack is a user
decision to be asked at build time, not inferred here.

## Users

**Primary — Greg, the person who built HIVE and runs it on his own projects.**
Confirmed 2026-08-14: the dashboard is designed for him, not for installers.
The scene is morning, coffee, before the first session of the day — or a mid-day
check on whether an overnight dispatch landed. The job: find out what HIVE
learned, ran, or flagged while he wasn't watching, and decide what to touch
first. He is fully fluent in HIVE's vocabulary and does not need it explained.

**Secondary, and only on a future public surface — someone deciding whether to
run `install.sh`.** A CLI-agent user (Claude Code, Codex, or Pi) evaluating
whether HIVE is worth wiring into their setup. They have not read the README,
do not know the terminology, and owe the project nothing.

The split is binding and asymmetric: the dashboard may assume fluency; a
marketing surface must earn every term it uses.

## Product Purpose

HIVE gives a CLI coding agent the three things it does not keep on its own —
an identity that survives session boundaries, project memory that compounds,
and a queue of work it can plan against. It wraps the subscription CLI the user
already runs rather than replacing it: the harness owns the conversation, tools,
and file I/O; HIVE owns what the harness forgets.

Success for the product: knowledge compounds instead of resetting every session.

Success for the dashboard: one page, read start to finish, and Greg knows the
state of every project — no CLI commands, no directory spelunking, no second
click required to answer "what happened, and what needs me."

## Positioning

Everything is markdown in `~/.hive/`, tracked by git, readable by a human with
no tooling. No database, no vector store, no embedding server, no daemon holding
state. Neighboring agent-memory products own the stack with SQLite and local
embeddings and cannot truthfully make that claim.

The second half of the position: HIVE wraps a subscription CLI the user already
pays for instead of competing with it. The boundary is clean — harness as
engine, HIVE as the layer that remembers.

## Operating Context

**Rituals.** Four launchd jobs installed by `install.sh`: `heartbeat`,
`nightly`, `morning`, `sync`. The nightly pipeline runs at 2am (Pass
A → B → C → V → F → P) and rebuilds the dashboard when it lands, so the morning
page reflects the previous night's verification. Heartbeat is currently disabled
for this project (Greg, 2026-06-11).

**Two delivery modes, one renderer.** A static `~/.hive/dashboard/index.html`
rebuilt nightly and openable over `file://`, and an interactive `Bun.serve` bound
to `127.0.0.1:7777` that adds action buttons (close ticket, dispatch, promote
memory, ack inbox) backed by allowlisted handlers shelling out to the `hive` CLI.
Pure collectors in `collect.ts` produce the data both consume.

**Archive.** Every morning build freezes a snapshot at
`~/.hive/dashboard/archive/YYYY-MM-DD.html`, served read-only at `/archive/:date`
with actions suppressed.

**Reading environment.** Desktop browser, localhost or `file://`, offline-capable,
no auth layer — the 127.0.0.1 bind plus `Origin` checks on POST are the entire
security model.

**Content is dense and heterogeneous by design.** Per-project cards (heartbeat
status, last tick, ticket counts, inbox freshness), ticket buckets (ready /
in-progress / blocked), dispatch runs with failures given prominence, recent
memory entries with BM25+decay strength scores, promotion candidates, a
cross-project open-questions rollup, the narrative morning briefing, last night's
pipeline cost broken out by pass in USD, launchd health lines, and watches.

**Product vocabulary — terminology, not decoration.** Identity stack
(SOUL / IDENTITY / SELF / AGENTS / TRUST); facts, conventions, decisions,
questions; candidates; Pass V; taste units; tickets; dispatch; campaign; watch
(observe / propose / act); council; briefing; inbox.

## Capabilities and Constraints

- Bun + TypeScript, ~80 source files, ~22,900 lines. Two entry points: `src/cli.ts`
  and `src/mcp-server.ts`.
- **Zero network requests is a hard constraint** for the dashboard. CSS, JS, and
  fonts are inlined; the page must render fully offline from `file://`. This rules
  out CDN webfonts, remote images, and any analytics.
- The interactive server's actions are an allowlist of shell-outs to the `hive`
  CLI via argv. The UI cannot offer an action the CLI does not already expose.
- Not distributed as a package: `package.json` is `private: true`, there is no
  `LICENSE` file, and installation is git clone plus `./install.sh` from
  `git@github.com:mhyrr/hive.git`.
- Data volume is real but bounded — one user, a handful of registered projects.
  No pagination or virtualization pressure; density is a design choice, not a
  performance workaround.
- **Undecided:** whether a public landing page ships, where it would be hosted,
  and what it would be built with.

## Brand Commitments

**Committed (confirmed 2026-08-14):**

- The name HIVE.
- The bee-and-honey identity, including the agent persona Maya (🐝🍯).
- The mark at `img/logo.svg`.
- The agent's voice, specified in `SOUL.md` and `IDENTITY.md`: dry, exact,
  compressed; lead with the insight; describe rather than grade; opinionated with
  receipts; no sentence whose payload is its shape.

**Explicitly not committed:** the visual world. The incumbent broadsheet
treatment — cream ground, charcoal ink, amber accent, serif body, tabular
figures, no icons, no shadows, corner radius at 2px or under, "Morning Edition"
masthead — is evidence of intent, not a constraint. A redesign may replace it
with cause. Greg named the name and mark as the binding half and left the look
open.

## Evidence on Hand

Real and in-repo:

- `README.md`, `GUIDE.md`, and `docs/` (dashboard, memory-architecture, watches,
  ralph-loop, taste research, platform audit).
- Screenshots of the shipped dashboard: `dash-top.png`, `dash-2.png`,
  `dash-3.png`, `dash-4.png`, `dash-full.png`, plus `img/briefing-headline-fix.png`
  and `img/hive*.png`.
- The mark: `img/logo.svg`.
- Live data to design against: `~/.hive/` (projects, memory, tickets, runs,
  dashboard archive).
- Prior art credited by name in the README: Hippo (memory decay and retrieval
  strengthening), ClawMem (BM25 retrieval), claude-mem.

Absent — must not be fabricated: users other than Greg, testimonials, install or
star counts, benchmarks, pricing, a license, uptime figures, or any claim that
HIVE runs in production for anyone else.

## Product Principles

1. **Markdown on disk is the product.** Anything that needs a database, a hosted
   service, or a running daemon to hold state belongs to a different product.
2. **The harness is the engine; HIVE is what it forgets.** Don't rebuild what
   Claude Code, Codex, or Pi already do.
3. **Glanceable beats navigable.** The dashboard answers "what happened and what
   needs me" in one read. Depth is progressive disclosure on the same page, never
   a second destination.
4. **Density is the requirement, not a failure state.** The reader wants a ledger,
   and whitespace that costs him a scroll costs him the glance.
5. **Nothing shown is a claim; everything shown is a reading of state.** Where a
   number is nominal rather than real, the surface says which.
6. **One user's fluency is not a stranger's.** The dashboard may assume the
   vocabulary. A public surface must earn every term before it uses it.

## Accessibility & Inclusion

No product-specific standard has been established, and none was claimed.

What the shipped code already does and should be treated as the floor:
`aria-pressed` on toggles, `aria-live` regions for optimistic updates and the
snackbar, `role="button"` with `tabindex` on keyboard-operable ticket and board
cards, and real `:focus-visible` styling.

Not established, and open: a contrast target, `prefers-reduced-motion` handling,
`prefers-color-scheme` support (no dark mode exists anywhere in the dashboard
styles), and any screen-reader testing.
