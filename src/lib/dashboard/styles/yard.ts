/**
 * The yard — first viewport of The Apiary Record.
 *
 * Colonies stand on a baseline at differing heights. Height is not
 * decoration: a colony's stack grows with its stores, so the yard reads as
 * magnitude before it reads as text. The brood chamber sits at the bottom
 * where it does in a real hive; supers stack above it.
 *
 * One authored motion moment: the stacks rise from the baseline once, on
 * load, staggered. Everything is visible at rest; motion adds nothing the
 * reader needs and is removed entirely under reduced-motion.
 */
export const YARD_CSS = `
/* ---------- Yard head ---------- */

.yard-head {
  max-width: 1280px;
  margin: 0 auto;
  padding: 28px 36px 0;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 24px;
}
.yard-head h1 {
  font-family: var(--stencil);
  font-size: 40px;
  line-height: 0.9;
  letter-spacing: var(--stencil-tracking);
  text-transform: uppercase;
  margin: 0;
  color: var(--ink);
}
.yard-head .dateline {
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  display: flex;
  gap: 10px;
}

/* ---------- The verdict line: the answer, before any data ---------- */

.yard-call {
  max-width: 1280px;
  margin: 0 auto;
  padding: 18px 36px 0;
}
.yard-call p {
  margin: 0;
  font-size: 27px;
  line-height: 1.25;
  letter-spacing: -0.015em;
  text-wrap: balance;
  max-width: 34ch;
}
.yard-call .count { color: var(--oxide); }
.yard-call .quiet { color: var(--muted); }

/* ---------- The work band: where the week actually went ---------- */

.work {
  max-width: 1280px;
  margin: 0 auto;
  padding: 22px 36px 4px;
}
.work-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 26px;
}
.work-item {
  --paint: var(--hive-0);
  border-top: 3px solid var(--paint);
  padding-top: 10px;
}
.work-item[data-colour="1"] { --paint: var(--hive-1); }
.work-item[data-colour="2"] { --paint: var(--hive-2); }
.work-item[data-colour="3"] { --paint: var(--hive-3); }
.work-item[data-colour="4"] { --paint: var(--hive-4); }

.work-name {
  font-family: var(--stencil);
  font-size: 17px;
  letter-spacing: var(--stencil-tracking);
  text-transform: uppercase;
}
.work-figures {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
  margin-top: 2px;
}
.work-figures .add { color: var(--hive-1); }
.work-figures .cut { color: var(--oxide); }

.work-subjects {
  list-style: none;
  margin: 9px 0 0;
  padding: 0;
}
.work-subjects li {
  font-size: 13.5px;
  line-height: 1.4;
  padding: 3px 0 3px 13px;
  position: relative;
  color: var(--ink-soft);
  border-top: 1px solid var(--faint);
}
.work-subjects li::before {
  content: "";
  position: absolute;
  left: 0;
  top: 11px;
  width: 6px;
  height: 1px;
  background: var(--paint);
}
.work-subjects .more { color: var(--muted); border-top: 0; padding-left: 13px; }

.work-none {
  color: var(--muted);
  font-size: 15px;
  margin: 0;
}

/* ---------- The yard floor ---------- */

.yard {
  max-width: 1280px;
  margin: 0 auto;
  padding: 30px 36px 40px;
}
.yard-label {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  border-top: 1px solid var(--faint);
  padding-top: 10px;
  margin-bottom: 18px;
  display: flex;
  justify-content: space-between;
  gap: 20px;
}
.yard-key { color: var(--faint); }

/* ---------- Bands below the yard ---------- */

.band { margin-top: 46px; }
.band-none { color: var(--muted); margin: 0; }

.prose { max-width: 72ch; }
.prose p { margin: 0 0 12px; line-height: 1.6; }
.prose h1, .prose h2, .prose h3 {
  font-family: var(--stencil);
  letter-spacing: var(--stencil-tracking);
  text-transform: uppercase;
  font-size: 14px;
  margin: 22px 0 8px;
}
.prose ul, .prose ol { margin: 0 0 12px; padding-left: 20px; }
.prose li { margin-bottom: 5px; line-height: 1.5; }
.prose code { background: var(--chalk-deep); padding: 1px 4px; }

/* Watches */
.watch-list { list-style: none; margin: 0; padding: 0; }
.watch-card {
  border-top: 1px solid var(--faint);
  padding: 14px 0 4px;
}
.watch-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  margin-bottom: 8px;
}
.watch-name {
  font-family: var(--stencil);
  font-size: 15px;
  letter-spacing: var(--stencil-tracking);
  text-transform: uppercase;
}
.watch-when {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}

/* Tickets: a shortlist per colony, not the whole board */
.tk-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 28px;
}
.tk-col h3 {
  font-family: var(--stencil);
  font-size: 14px;
  letter-spacing: var(--stencil-tracking);
  text-transform: uppercase;
  font-weight: 400;
  margin: 0 0 8px;
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.tk-count {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  color: var(--muted);
}
.tk-list { list-style: none; margin: 0; padding: 0; }
.tk {
  display: grid;
  grid-template-columns: auto 1fr auto;
  gap: 8px;
  align-items: baseline;
  border-top: 1px solid var(--faint);
  padding: 6px 0;
  font-size: 13px;
}
/* Controls stay out of the way until wanted, but never out of reach:
   focus-within keeps them on the keyboard path. */
.tk-actions {
  grid-column: 1 / -1;
  display: flex;
  gap: 8px;
  max-height: 0;
  overflow: hidden;
  opacity: 0;
  transition: max-height 140ms ease-out, opacity 140ms ease-out;
}
.tk:hover .tk-actions,
.tk:focus-within .tk-actions {
  max-height: 32px;
  opacity: 1;
  margin-top: 4px;
}
@media (prefers-reduced-motion: reduce) {
  .tk-actions { transition: none; }
}
.tk-id {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--muted);
}
.tk-title {
  line-height: 1.35;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.tk-pri {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--muted);
}
/* State reads off the rail, not off a coloured pill. */
.tk--progress { border-top-color: var(--ink); }
.tk--progress .tk-id { color: var(--ink); font-weight: 600; }
.tk--blocked .tk-title { color: var(--muted); }
.tk--blocked .tk-pri { color: var(--oxide); }
.tk-more {
  padding: 7px 0 0;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

/* Stores */
.stores {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 32px;
}
.stores-col h3 {
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  font-weight: 400;
  margin: 0 0 10px;
}
.entry-list { list-style: none; margin: 0; padding: 0; }
.entry-list li {
  border-top: 1px solid var(--faint);
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.entry-meta {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.entry-text { font-size: 13.5px; line-height: 1.45; color: var(--ink-soft); }

/* ---------- Project filter: the colonies are the control ---------- */

.yard.filtering .colony:not(.colony--selected) { opacity: 0.3; }
.colony--selected .colony-name { color: var(--oxide); }
.colony--selected .colony-board { height: 8px; }

/* ---------- Upkeep: quiet by design ---------- */

.upkeep { margin-top: 44px; }
.upkeep-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 28px;
}
.upkeep-list li {
  display: flex;
  gap: 8px;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.upkeep-list .job { color: var(--muted); }
.upkeep-list .when { color: var(--ink-soft); }
.yard-row {
  list-style: none;
  margin: 0;
  padding: 0 0 14px;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  flex-wrap: wrap;
  row-gap: 30px;
  gap: 20px;
  /* The ground the hives stand on. */
  border-bottom: 2px solid var(--ink);
}

/* ---------- A colony ---------- */

.colony {
  --paint: var(--hive-0);
  flex: 0 1 148px;
  max-width: 200px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  background: none;
  border: 0;
  padding: 0;
  text-align: center;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.colony[data-colour="1"] { --paint: var(--hive-1); }
.colony[data-colour="2"] { --paint: var(--hive-2); }
.colony[data-colour="3"] { --paint: var(--hive-3); }
.colony[data-colour="4"] { --paint: var(--hive-4); }

/* A quiet colony is left unpainted. Placed after the slot rules so it wins
   at equal specificity: paint is the attention signal, not decoration. */
.colony.colony--quiet { --paint: var(--wood); }

.colony-name {
  font-family: var(--stencil);
  font-size: 15px;
  letter-spacing: var(--stencil-tracking);
  text-transform: uppercase;
  color: var(--ink);
  margin-bottom: 7px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.colony-stack {
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  transform-origin: bottom center;
  width: 100%;
}

/* A super: one painted box. The brood chamber is the deepest one. */
.super {
  height: 26px;
  background: var(--paint);
  border: 1px solid rgba(22, 21, 15, 0.55);
  border-bottom-width: 0;
  position: relative;
}
.super:last-of-type { border-bottom-width: 1px; }
/* Box joint: the seam between stacked bodies, not a drop shadow. */
.super::after {
  content: "";
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 1px;
  background: rgba(22, 21, 15, 0.28);
}
.super--brood {
  height: 42px;
  background: color-mix(in srgb, var(--paint) 82%, var(--ink));
}
/* Entrance: a real slot at the base, sized to the colony's traffic. */
.super--brood::before {
  content: "";
  position: absolute;
  left: 12%;
  bottom: 5px;
  height: 5px;
  width: calc(6% + var(--traffic, 0) * 62%);
  background: rgba(22, 21, 15, 0.8);
}

/* Landing board */
.colony-board {
  height: 5px;
  background: var(--ink);
  width: calc(100% + 12px);
}

/* ---------- The plate: name, verdict, reason ---------- */

.colony-plate {
  margin-top: 9px;
  border-top: 1px solid var(--faint);
  padding-top: 7px;
  width: 100%;
}
.colony-verdict {
  font-family: var(--stencil);
  font-size: 13px;
  letter-spacing: var(--stencil-tracking);
  text-transform: uppercase;
  color: var(--ink-soft);
}
.colony--needs-you .colony-verdict,
.colony--queenless .colony-verdict { color: var(--oxide); }
.colony--quiet .colony-verdict { color: var(--muted); }
.colony-reason {
  font-size: 12.5px;
  line-height: 1.35;
  color: var(--muted);
  margin-top: 2px;
}

/* Measurements read as measurements. */
.colony-figures {
  margin-top: 6px;
  display: flex;
  justify-content: center;
  gap: 12px;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
}
.colony-figures b { color: var(--ink); font-weight: 600; }

/* ---------- States ---------- */

.colony:hover .colony-name,
.colony:focus-visible .colony-name { color: var(--oxide); }
.colony:hover .super { border-color: var(--ink); }

/* Wood already reads as quiet; dimming on top of it only muddies the seams. */

.yard-empty {
  padding: 34px 0;
  color: var(--muted);
  font-size: 15px;
}

/* ---------- Motion: one moment, on load only ---------- */

@media (prefers-reduced-motion: no-preference) {
  .colony-stack {
    animation: colony-rise 620ms cubic-bezier(0.16, 1, 0.3, 1) backwards;
    animation-delay: calc(var(--i, 0) * 55ms);
  }
  @keyframes colony-rise {
    from { transform: scaleY(0.82); }
    to   { transform: scaleY(1); }
  }
}

@media (max-width: 860px) {
  .yard-head, .yard-call, .yard { padding-left: 20px; padding-right: 20px; }
  .yard-head { flex-direction: column; gap: 6px; }
  .yard-call p { font-size: 22px; }
  .yard-row { gap: 14px; }
  .colony { min-width: 124px; }
}
`;
