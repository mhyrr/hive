---
name: HIVE Dashboard — The Apiary Record
description: A local, single-file inspection record where every project is a colony that ends the morning in a verdict.
colors:
  chalk: "#e6e4dd"
  chalk-deep: "#dad7cc"
  ink: "#16150f"
  ink-soft: "#3d3a30"
  muted: "#6e6a5c"
  faint: "#c3bfb1"
  oxide: "#b8532c"
  wood: "#c6ab7e"
  hive-0: "#17529e"
  hive-1: "#57ad8b"
  hive-2: "#6a3f86"
  hive-3: "#79a7c9"
  hive-4: "#7d8b2e"
typography:
  display:
    fontFamily: "Haettenschweiler, Arial Narrow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "40px"
    fontWeight: 400
    lineHeight: 0.9
    letterSpacing: "0.06em"
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "27px"
    fontWeight: 400
    lineHeight: 1.25
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Haettenschweiler, Arial Narrow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0.06em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
    fontFeature: "tnum 1"
  body-small:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "SF Mono, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "10.5px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "0.06em"
    fontFeature: "tnum 1"
rounded:
  none: "0"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "8px"
  rule: "10px"
  md: "18px"
  lg: "28px"
  column-gap: "32px"
  gutter: "36px"
  band: "46px"
components:
  colony-super:
    backgroundColor: "{colors.hive-0}"
    rounded: "{rounded.none}"
    height: "26px"
  colony-super-brood:
    backgroundColor: "{colors.hive-0}"
    rounded: "{rounded.none}"
    height: "42px"
  colony-quiet:
    backgroundColor: "{colors.wood}"
    rounded: "{rounded.none}"
  colony-board:
    backgroundColor: "{colors.ink}"
    height: "5px"
  colony-verdict:
    textColor: "{colors.ink-soft}"
    typography: "{typography.title}"
  colony-verdict-escalated:
    textColor: "{colors.oxide}"
    typography: "{typography.title}"
  ticket-row:
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.none}"
    padding: "6px 0"
  ticket-row-progress:
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "6px 0"
  action-button:
    backgroundColor: "transparent"
    textColor: "{colors.hive-0}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0 6px 0 0"
  action-button-hover:
    textColor: "{colors.oxide}"
  pill:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "0"
  pill-active:
    textColor: "{colors.ink}"
    typography: "{typography.label}"
  snackbar:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.chalk}"
    typography: "{typography.label}"
    rounded: "{rounded.none}"
    padding: "8px 18px"
  snackbar-error:
    backgroundColor: "{colors.oxide}"
    textColor: "{colors.chalk}"
---

# Design System: HIVE Dashboard — The Apiary Record

## Overview

**Creative North Star: "The Apiary Record"**

A beekeeper walking the yard does not read a log. They look down the row, see which hives are painted, see which stand tall, and end each hive with a verdict spoken aloud. This dashboard is that walk. The ground is weathered chalk, not cream paper. The colour on the page comes from painted hive bodies standing on a baseline, and a colony's silhouette is its data: height is memory, entrance width is ticket traffic. Nothing on this surface is coloured or sized because it looked better that way.

The density is that of a working record rather than a product page. Rules are hairlines, corners are square, nothing floats, and there is no card with a shadow anywhere. Text carries the argument: a stencilled name, a verdict in caps, one clause of reason, then tabular figures. Type does the work that chrome usually does, which is why the type ramp is wide (a 40px stencil wordmark down to a 10px mono label) while the surface palette is nearly monochrome.

Three anti-references are binding and were chosen against explicitly. **No hexagon** appears anywhere — the world is a yard of boxes, not a bee mascot. **Honey-amber is not the accent**; the only warm tone in the system is unpainted pine, and it means the opposite of "look here". And this replaces a **serif broadsheet** dashboard: the incumbent's double-rule masthead, 68px display weight, and equal-weight section stack are what the thesis refuses, not a style to preserve.

Two things are open, not settled. The display face `--stencil` currently resolves to a condensed *system* stack (`"Haettenschweiler", "Arial Narrow"`) carrying an explicit do-not-ship comment in `base.ts`; the stencil voice wants a real embedded face and the frontmatter records the placeholder, not an endorsement. And the Impeccable finish review has not run, so no verdict table exists for this surface yet.

**Key Characteristics:**
- Weathered chalk ground; all colour is on objects, none on the page.
- Paint means "look at me"; unpainted pine means "fine".
- Oxide red is escalation only, never decoration.
- Geometry is data: colony height encodes stores, entrance width encodes traffic.
- Flat and square: zero radius, zero shadows, hairline rules only.
- One authored motion moment on the whole page.

## Colors

A near-monochrome mineral ground carrying five saturated painted-object slots, one reserved alarm, and one deliberately unsaturated "nothing to do here" tone.

### Primary
- **Oxide Red** (`--oxide`): Escalation. The count in the verdict sentence, a `needs-you` or `queenless` verdict on a colony plate, the priority mark on a blocked ticket, deletions in the work band, the error snackbar, the hovered/selected colony name. It appears nowhere else and never as a surface, border, or decoration.

### Secondary — the painted hive bodies
Five slots, assigned by a stable hash of the project id so a colony keeps its colour across days and across reorderings. Values alternate dark / mid / dark / mid / dark so any two neighbours separate by lightness as well as hue; the first attempt used five mid-tones and read as mud.

- **Cobalt** (`--hive-0`): Slot 0. Also carries interactive affordances inherited through the `--amber` migration alias (action labels, pill underlines, focus ring on legacy routes).
- **Verdigris** (`--hive-1`): Slot 1. Also the additive figure (`+lines`) in the work band.
- **Violet** (`--hive-2`): Slot 2.
- **Slate Blue** (`--hive-3`): Slot 3.
- **Olive** (`--hive-4`): Slot 4.

### Tertiary
- **Unpainted Pine** (`--wood`): A quiet colony's body. Not a fifth-and-a-half slot: it *overrides* whatever painted slot the colony would have had, and it is the only tone that means "this one is fine".

### Neutral
- **Weathered Chalk** (`--chalk`): The ground. Page background, and the knockout colour on ink surfaces (selection, snackbar text, scrollbar thumb border).
- **Deep Chalk** (`--chalk-deep`): The only tonal step available for inline surfaces — code spans in prose and briefing bodies. There is no card background.
- **Ink** (`--ink`): Body text, the yard baseline (2px), section rules, super outlines at hover, landing boards, focus outline.
- **Soft Ink** (`--ink-soft`): Secondary reading text — ticket titles, briefing list items, entry text, work subjects.
- **Muted** (`--muted`): Mono labels, datelines, counts, reasons, footer, and any deliberately quiet verdict.
- **Faint** (`--faint`): Hairline dividers between rows, underline colour on links at rest, the yard key, scrollbar thumb.

### Named Rules
**The Oxide Reserve Rule.** Oxide red is escalation and nothing else. If a proposed use of oxide could be replaced by ink or muted without losing an alarm, it is decoration and must be replaced. Test: cover every oxide pixel on a screen — everything you hid should be something you had to act on today.

**The Unpainted Pine Rule.** Paint is the attention signal. A colony below the paint threshold loses its slot colour and stands in bare wood; it is never additionally dimmed, greyed, or shrunk. Wood already reads as quiet, and stacking a second quiet-signal on it only muddies the seams.

**The Stable Slot Rule.** A project's painted colour is derived from its id, not from its position. Sorting the yard, filtering it, or adding a colony never reassigns anyone's paint.

## Typography

**Display Font:** `--stencil` — currently `"Haettenschweiler", "Arial Narrow", var(--ui)`. **Placeholder, tracked on TK-142.** The voice wants a real embedded condensed/stencil face; the system stack is a stand-in and is documented here as the shipped state, not as a settled choice.
**Body Font:** the platform UI sans (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto`).
**Label/Mono Font:** `"SF Mono", Menlo, Consolas, "Liberation Mono"`.

**Character:** Stencilled caps for anything with a name or a verdict; a plain, unshowy sans for everything you actually read; mono for anything you count. The whole system runs tabular figures (`font-feature-settings: "tnum" 1`) at the root so numbers stack in columns without being in a table.

### Hierarchy
- **Display** (stencil, 40px, line-height 0.9, +0.06em, uppercase): the wordmark in the yard head, once per page.
- **Headline** (body sans, 27px, line-height 1.25, −0.015em, `text-wrap: balance`, max 34ch): the verdict sentence — the one line that answers the morning before any data. Drops to 22px below 860px.
- **Lede** (body sans, 20px, line-height 1.45, max 62ch): the briefing's first paragraph, the single sentence the night decided mattered.
- **Title** (stencil, +0.06em, uppercase, weight 400): every named object, sized by rank — 17px work-band project, 15px colony name and watch name, 14px band and ticket-column headings, 13px colony verdict.
- **Body** (body sans, 15px / 1.55): default reading text. Prose blocks cap at 72ch, briefing blocks at 74ch.
- **Body Small** (13.5px / 1.45, soft ink): ticket titles, briefing list items, memory entries, work subjects. 12.5px / 1.35 muted for a colony's reason clause.
- **Label** (mono, 10–11px, +0.04em to +0.08em, uppercase, muted): datelines, figures, counts, yard key, upkeep, footer, and all action buttons (lowercase in that one case).

### Named Rules
**The Stencil-For-Names Rule.** The stencil face is for names, verdicts, and section headings only. It never sets a sentence, never sets body copy, and is always uppercase with its `--stencil-tracking` applied.

**The Tabular Figures Rule.** Every number on the surface is tabular (`tnum`), and any number the reader might compare down a column is mono. Figures read as measurements, not as prose.

**The Answer-First Rule.** The largest non-display type on the page is the verdict sentence, not a heading. Scale follows how load-bearing the sentence is, not where it sits in the document tree.

## Layout

A single centred column, `max-width: 1280px` with 36px gutters (`page-wide` routes go to 1680px; gutters drop to 20px below 860px). Vertical rhythm is coarse and consistent: bands are separated by 46px, the yard sits in 30px/40px padding, section content sits 18px below its label, and rows inside a section run on 6–10px padding with a 1px faint rule between them. There is no card and no panel; a section is a label, a hairline, and its rows.

**The yard** is a flex row, bottom-aligned (`align-items: flex-end`), wrapping with a 30px row gap, closed by a 2px ink border-bottom — the ground the hives stand on. Colonies are `flex: 0 1 148px` up to 200px, dropping to a 124px minimum below 860px.

Repeating multi-column regions use `repeat(auto-fit, minmax(260–280px, 1fr))` grids with 26–32px gaps: the work band, the ticket shortlist columns, and the stores columns.

**The briefing is the exception, and deliberately so.** The briefing body and its colony blocks flow through CSS **column boxes** (`columns: 3 300px; column-gap: 32px`), not a grid. A grid holes out when colony blocks are unequal heights — the shortest block leaves dead space the height of the longest, and a fourth colony starts a row alone. Column boxes balance, and ranked order survives because a column run reads top-to-bottom before moving right. Colony blocks and list items carry `break-inside: avoid`: a colony split across two columns reads as two colonies.

### Named Rules
**The Column-Box Rule.** When blocks are self-contained and of unequal height, set them in column boxes and mark them `break-inside: avoid`. Reach for a grid only when the cells are genuinely a matrix.

**The One-Column-When-Filtered Rule.** Filtered to a single project, every column run collapses to `columns: 1` at a 74ch cap. One survivor rattling around three tracks is not a layout.

**The Data-Project Rule.** The project filter is a pure `[data-project]` sweep. Anything project-scoped must carry `data-project="<id>"` or it will silently survive every filter. Colonies carry the attribute too but are exempt from hiding: they are the control, and hiding them removes the way back out.

## Elevation & Depth

**This system has no shadows.** Nothing is lifted, nothing floats, no surface has a blur behind it. Depth is carried by three physical devices instead:

- **The baseline** — a 2px ink border under the yard row, which the hives stand *on*. It is the only heavy line on the page.
- **The box joint** — a 1px `rgba(22,21,15,0.28)` seam at the bottom of each super, plus a `rgba(22,21,15,0.55)` outline around the body. This is how stacked boxes separate: a woodworking seam, not a drop shadow.
- **Tonal shift** — the brood chamber is `color-mix(in srgb, var(--paint) 82%, var(--ink))`, darker than the supers above it because it is the deepest box in a real hive.

The only offset-position element on the surface is the fixed snackbar, and it is a solid ink slab with no shadow.

### Named Rules
**The No-Shadow Rule.** There are no `box-shadow` values in this system. If an element needs to separate from its neighbour, give it a hairline, a tonal step, or space.

## Shapes

Radius is zero everywhere — hive bodies, buttons, the snackbar, code spans, and even the scrollbar thumb are square. The form language is rectangles standing on a line: a colony is a column of 26px boxes with one 42px brood chamber at the base and a 5px ink landing board projecting 6px past each side.

Borders are the primary structural device and come in exactly three weights: **hairline** (1px `--faint`) between rows, **rule** (1px `--ink`) under section heads, and **ground** (2px `--ink`) under the yard. Rules sit on the *top* of a row rather than the bottom throughout, so a list reads as a stack of entries hung from a line.

The one non-rectangular mark in the system is the **entrance**: a dark slot at the base of the brood chamber, 5px tall, offset 12% from the left, whose width is `calc(6% + var(--traffic) * 62%)`.

## Components

### Colony (signature component)
The whole surface hangs off this one object. A colony is a `<button>` — the yard is the filter control — composed of stencilled name, a stack of painted supers, an ink landing board, and a plate carrying verdict, reason, and figures.

- **Shape:** square boxes, 26px per super, 42px brood chamber, 1px dark outline, 1px box-joint seam.
- **Encoding:** `supers = 1 + round(stores × 4)`, where `stores` is the project's memory-entry count normalised against the yard's strongest colony — one shared scale, never per-card. Entrance width is the project's open+in-progress ticket count over the yard peak.
- **Paint:** slot colour by stable hash of project id; `colony--quiet` overrides it to unpainted pine.
- **Plate:** verdict in stencil caps (soft ink; oxide for `needs-you` and `queenless`; muted for `quiet`), one clause of reason at 12.5px muted, then `tickets N · memory N` in mono with ink-bold numerals.
- **States:** hover/focus turns the name oxide and the super outlines full ink. Selected turns the name oxide and doubles the landing board to 8px. Unselected colonies drop to `opacity: 0.3` while filtering.
- **Verdict vocabulary (closed, five values, first-match-wins):** `needs-you`, `queenless`, `active`, `waiting`, `quiet`. Paint is `score >= 3` on a weighted rubric; failed and review-ready runs bypass the score entirely.

### Ticket Row
A three-column grid (`auto 1fr auto`: id, title, priority) on a faint top rule, 13px, title clamped to two lines.

- **State reads off the rail, never off a coloured pill.** In-progress darkens the top rule to ink and bolds the id; blocked mutes the title and turns the priority mark oxide.
- **Controls:** revealed on `:hover` and `:focus-within` by moving from `height: 0; overflow: hidden` to `height: auto`. Clipped rather than `display: none` so the buttons stay in the tab order — a clipped button can still take focus, and taking focus is what opens the row. Deliberately not transitioned.

### Action Button
Typographic, not a box: mono 10.5px lowercase in bracket form (`[ start ]`), transparent, no border, cobalt at rest, oxide on hover and when pressed, muted when disabled.

### Pills (project filter)
Bare text buttons in a wrapping row; active state is weight 700 plus a 2px cobalt underline. A filter banner (`FILTERING → project · clear`) appears between rules when a filter is live.

### Work Band Item
A project's landed commits: a 3px top border in the project's paint, stencilled name, mono figures (verdigris for additions, oxide for deletions), then subject lines each hung from a hairline with a 6×1px paint tick at the left.

### Snackbar
Fixed, bottom-centred, solid ink slab with chalk mono caps; oxide when it reports an error. Fades on opacity only.

### Motion
**The One Moment Rule.** The page has exactly one authored motion: the colony stacks rise from the baseline once on load — `scaleY(0.82) → 1` over 620ms on `cubic-bezier(0.16, 1, 0.3, 1)`, staggered 55ms per colony from `--i`, with `transform-origin: bottom center`. It lives entirely inside `@media (prefers-reduced-motion: no-preference)`, so under reduced-motion it is not slowed or shortened — it does not exist. Everything is fully legible at rest; the animation adds nothing the reader needs. Small state transitions (snackbar opacity 0.2s, nav underline 120ms) are the only other movement, and no layout property is ever animated.

## Do's and Don'ts

### Do:
- **Do** reserve oxide red (`--oxide`) for escalation. If it is not something the reader must act on, it is not oxide.
- **Do** leave a quiet colony unpainted (`--wood`) and otherwise untouched. Paint carries "look at me"; wood carries "fine".
- **Do** make geometry mean something. Colony height is memory stores on the yard's shared scale; entrance width is ticket traffic. If a new dimension varies, it must encode data.
- **Do** set unequal self-contained blocks in CSS column boxes with `break-inside: avoid`, not a grid.
- **Do** put `data-project="<id>"` on every project-scoped element; the filter is a pure attribute sweep.
- **Do** stencil names, verdicts, and headings in caps with `--stencil-tracking`, and set every figure tabular.
- **Do** show state on the rail, the weight, and the label — an in-progress ticket darkens its rule; a blocked one turns its priority oxide.
- **Do** keep hidden-until-hover controls in the tab order by clipping with `height: 0; overflow: hidden`, never `display: none`.

### Don't:
- **Don't** draw a hexagon. Not as an icon, a bullet, a background, or a container. The world is a yard of boxes.
- **Don't** introduce honey-amber as an accent. The only warm tone in the system is unpainted pine, and it means "nothing to do".
- **Don't** revive the serif broadsheet: no double-rule masthead, no oversized bold display header, no equal-weight stack of same-sized sections.
- **Don't** add a `box-shadow`. Separate with a hairline, a tonal step, or space.
- **Don't** round a corner. Radius is 0 across the system.
- **Don't** put state in a coloured pill or badge.
- **Don't** add a second motion moment, and never animate a layout property.
- **Don't** use glyph or emoji icons. Every mark on this surface is either type, a rule, or a painted box.
