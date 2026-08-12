import { buildContextReport, CONTEXT_BUDGETS, type ComponentRow, type ContextReport, type SizeStatus } from "../lib/context-report";
import { UsageError } from "../lib/errors";

const USAGE = `Usage: hive context [--json] [--no-color]

Audit the context HIVE loads at session start — the identity injection
(soul stack, persona, project memory index, stack hint, taste layer) plus
each registered project's CLAUDE.md — against the size budgets set at the
2026-07 slim-down. Also available as: hive prompts.

  --json        Emit the full report as JSON (for tracking size over time)
  --no-color    Plain output, no ANSI or block grid (also honors NO_COLOR)

Exits 1 if anything is over budget, so it can gate CI or a pre-push hook.`;

// ─── palette ───────────────────────────────────────────────────────────────
// One hue per identity layer, reused by the grid and its legend so a block in
// the grid is traceable to a row without a lookup. WARN is deliberately clear
// of every layer hue — an over-budget marker that reads as another layer is
// worse than no color at all.
type Rgb = readonly [number, number, number];

const WARN: Rgb = [224, 108, 74];
const EMPTY: Rgb = [78, 78, 84];
const DIM: Rgb = [140, 140, 148];
const BAR_OK: Rgb = [120, 140, 170];
const BAR_NEAR: Rgb = [222, 178, 74];

type LayerKind = ComponentRow["kind"];

const LAYERS: { kind: LayerKind; label: string; rgb: Rgb }[] = [
  { kind: "soul", label: "soul stack", rgb: [242, 201, 76] },
  { kind: "memory", label: "project memory", rgb: [86, 178, 200] },
  { kind: "taste", label: "taste layer", rgb: [168, 133, 224] },
  { kind: "persona", label: "persona", rgb: [130, 170, 255] },
  { kind: "stack-hint", label: "stack hint", rgb: [126, 190, 130] },
];

const FILLED = "⛁";
const HOLLOW = "⛶";
const GRID_COLS = 20;
/** Floor for grid height; it grows to match the legend so the columns balance. */
const GRID_ROWS = 10;
const BAR_WIDTH = 8;

let useColor = true;

function c(rgb: Rgb, s: string): string {
  return useColor ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${s}\x1b[0m` : s;
}

function bold(s: string): string {
  return useColor ? `\x1b[1m${s}\x1b[0m` : s;
}

/** Visible length, ignoring SGR escapes, so padding survives colorization. */
function visLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visLen(s)));
}

function padStart(s: string, width: number): string {
  return " ".repeat(Math.max(0, width - visLen(s))) + s;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function tok(tokens: number): string {
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k tokens` : `~${tokens} tokens`;
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "0%";
}

const ICONS: Record<SizeStatus, string> = {
  get ok() { return c([126, 190, 130], "✓"); },
  get warn() { return c(WARN, "⚠"); },
};

/**
 * Fixed-width budget bar. A full bar means over budget and nothing else —
 * a 99%-full layer shows 7 of 8 so "full" stays unambiguous at a glance.
 */
function bar(bytes: number, budget: number): string {
  if (budget <= 0) return c(EMPTY, HOLLOW.repeat(BAR_WIDTH));
  const ratio = bytes / budget;
  if (ratio > 1) return c(WARN, "█".repeat(BAR_WIDTH));
  const filled = Math.min(BAR_WIDTH - 1, Math.max(bytes > 0 ? 1 : 0, Math.floor(ratio * BAR_WIDTH)));
  const hue = ratio >= 0.85 ? BAR_NEAR : BAR_OK;
  return c(hue, "█".repeat(filled)) + c(EMPTY, "░".repeat(BAR_WIDTH - filled));
}

/**
 * Largest-remainder apportionment: hand each slice its floor share, then give
 * the leftover cells to the largest remainders. Guarantees the grid is exactly
 * full, and that a nonzero slice never rounds away to nothing.
 */
function apportion(weights: number[], cells: number): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (w / total) * cells);
  const out = exact.map((e) => Math.floor(e));
  let left = cells - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((e, i) => ({ i, rem: e - Math.floor(e) }))
    .sort((a, b) => b.rem - a.rem);
  for (let k = 0; left > 0; k = (k + 1) % order.length) {
    out[order[k]!.i]!++;
    left--;
  }
  return out;
}

/** Print two columns, tolerating either side being longer. */
function sideBySide(left: string[], right: string[], gutter: number): void {
  const width = Math.max(0, ...left.map(visLen));
  const rows = Math.max(left.length, right.length);
  for (let i = 0; i < rows; i++) {
    const l = left[i] ?? "";
    const r = right[i] ?? "";
    console.log(r ? `  ${pad(l, width + gutter)}${r}` : `  ${l}`.trimEnd());
  }
}

interface Slice {
  label: string;
  rgb: Rgb;
  bytes: number;
  glyph: string;
  warn: boolean;
}

function slicesFor(report: ContextReport): Slice[] {
  const used: Slice[] = LAYERS.map((layer) => {
    const rows = report.components.filter((r) => r.kind === layer.kind);
    return {
      label: layer.label,
      rgb: layer.rgb,
      bytes: rows.reduce((sum, r) => sum + r.bytes, 0),
      glyph: FILLED,
      warn: rows.some((r) => r.status === "warn"),
    };
  })
    .filter((s) => s.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);

  const headroom = Math.max(0, report.total.budgetBytes - report.total.bytes);
  used.push({ label: "headroom", rgb: EMPTY, bytes: headroom, glyph: HOLLOW, warn: false });
  return used;
}

function renderGrid(slices: Slice[], rows: number): string[] {
  const cells = apportion(slices.map((s) => s.bytes), GRID_COLS * rows);
  const glyphs: string[] = [];
  slices.forEach((s, i) => {
    for (let n = 0; n < cells[i]!; n++) glyphs.push(c(s.rgb, s.glyph));
  });
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    lines.push(glyphs.slice(r * GRID_COLS, (r + 1) * GRID_COLS).join(" "));
  }
  return lines;
}

function renderLegend(report: ContextReport, slices: Slice[]): string[] {
  const scale = Math.max(report.total.bytes, report.total.budgetBytes);
  const nameWidth = Math.max(...slices.map((s) => s.label.length)) + 2;

  const lines = [
    bold("Identity injection"),
    c(DIM, report.projectId ? `project: ${report.projectId}` : "no project resolved from cwd"),
    `${kb(report.total.bytes)}${c(DIM, ` / ${kb(report.total.budgetBytes)} window`)}  ${c(DIM, `(${pct(report.total.bytes, report.total.budgetBytes)})`)}`,
    c(DIM, `${tok(report.total.tokens)} every session`),
    "",
    c(DIM, "Emitted by layer"),
  ];

  for (const s of slices) {
    lines.push(
      `${c(s.rgb, s.glyph)} ${pad(s.label, nameWidth)}` +
      `${padStart(kb(s.bytes), 7)}  ${c(DIM, padStart(pct(s.bytes, scale), 4))}` +
      (s.warn ? `  ${c(WARN, "⚠")}` : ""),
    );
  }
  return lines;
}

function renderPlainLayers(report: ContextReport, slices: Slice[]): void {
  console.log(`  ${bold("Identity injection")} ${c(DIM, report.projectId ? `· project: ${report.projectId}` : "· no project resolved from cwd")}`);
  console.log(`  ${kb(report.total.bytes)} / ${kb(report.total.budgetBytes)} window (${pct(report.total.bytes, report.total.budgetBytes)}) · ${tok(report.total.tokens)} every session\n`);
  const nameWidth = Math.max(...slices.map((s) => s.label.length)) + 2;
  const scale = Math.max(report.total.bytes, report.total.budgetBytes);
  for (const s of slices) {
    console.log(`  ${pad(s.label, nameWidth)}${padStart(kb(s.bytes), 7)}  ${padStart(pct(s.bytes, scale), 4)}${s.warn ? "  over budget" : ""}`);
  }
}

export async function contextCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const json = args.includes("--json");
  // Piping to a file or CI log should stay plain — the grid is unreadable
  // without color, so the no-color path drops it rather than emitting mush.
  const noColor =
    args.includes("--no-color") ||
    (!process.env.FORCE_COLOR && (!!process.env.NO_COLOR || !process.stdout.isTTY));
  const unknown = args.filter((a) => a !== "--json" && a !== "--no-color");
  if (unknown.length > 0) {
    throw new UsageError(`Unknown argument: ${unknown[0]}\n\n${USAGE}`);
  }
  useColor = !noColor;

  const report = await buildContextReport();

  if (json) {
    console.log(JSON.stringify({ budgets: CONTEXT_BUDGETS, ...report }, null, 2));
    process.exit(report.warnings > 0 ? 1 : 0);
  }

  console.log(`\n  ${bold("hive context")}\n`);

  if (report.components.length === 0) {
    console.log(`  ${ICONS.warn}  nothing to emit — is ~/.hive initialized? Run: hive init\n`);
    process.exit(1);
  }

  // ── the window, at a glance ────────────────────────────────────────────
  const slices = slicesFor(report);
  if (useColor) {
    // Grow the grid to at least the legend's height so neither column dangles
    // past the other — a legend row with no grid beside it loses the visual
    // anchor that ties its swatch to the block.
    const legend = renderLegend(report, slices);
    sideBySide(renderGrid(slices, Math.max(GRID_ROWS, legend.length)), legend, 4);
  } else {
    renderPlainLayers(report, slices);
  }

  // ── soul stack, biggest file first: the trim list ──────────────────────
  const soulFiles = report.components.filter((r) => r.kind === "soul").sort((a, b) => b.bytes - a.bytes);
  if (soulFiles.length > 0) {
    const s = report.soulStack;
    console.log(
      `\n  ${bold("Soul stack")} ${c(DIM, "·")} ${kb(s.bytes)}${c(DIM, ` / ${kb(s.budgetBytes)} budget`)}` +
      (s.status === "warn" ? `  ${ICONS.warn}` : ""),
    );
    console.log(`  ${c(DIM, "└")} ${soulFiles.map((f) => `${f.label} ${c(DIM, kb(f.bytes))}`).join(c(DIM, " · "))}`);
  }

  // ── layers with a budget of their own ──────────────────────────────────
  const budgeted = report.components.filter((r) => r.budgetBytes !== null);
  if (budgeted.length > 0) {
    console.log(`\n  ${bold("Budgeted layers")}`);
    const width = Math.max(...budgeted.map((r) => r.label.length)) + 2;
    for (const r of budgeted) {
      const over = r.budgetBytes! > 0 && r.bytes > r.budgetBytes! ? `  ${c(WARN, `${(r.bytes / r.budgetBytes!).toFixed(1)}× over`)}` : "";
      console.log(
        `  ${ICONS[r.status]}  ${pad(r.label, width)}${bar(r.bytes, r.budgetBytes!)}  ` +
        `${padStart(kb(r.bytes), 7)}${c(DIM, ` / ${kb(r.budgetBytes!)}`)}${over}`,
      );
      if (r.note) console.log(`       ${c(DIM, r.note)}`);
    }
  }

  // ── what every other project pays at session start ─────────────────────
  if (report.projects.length > 0) {
    console.log(`\n  ${bold("Per-project session-start load")}`);
    const width = Math.max(...report.projects.map((p) => p.projectId.length)) + 4;
    const memCol = BAR_WIDTH + 14;
    console.log(
      `  ${pad("", 3)}${pad("", width)}${pad(c(DIM, `memory index / ${kb(CONTEXT_BUDGETS.memoryIndexBytes)}`), memCol)}` +
      c(DIM, `CLAUDE.md / ${kb(CONTEXT_BUDGETS.claudeMdBytes)}`),
    );
    for (const p of report.projects) {
      const status: SizeStatus = p.memoryStatus === "warn" || p.claudeMdStatus === "warn" ? "warn" : "ok";
      const memory =
        p.memoryBytes === null
          ? pad(c(DIM, "no memory"), memCol)
          : `${bar(p.memoryBytes, CONTEXT_BUDGETS.memoryIndexBytes)}  ${pad(padStart(kb(p.memoryBytes), 7) + (p.memorySource === "knowledge" ? c(WARN, " raw") : ""), memCol - BAR_WIDTH - 2)}`;
      const claudeMd =
        p.claudeMdBytes === null
          ? c(DIM, "—")
          : `${bar(p.claudeMdBytes, CONTEXT_BUDGETS.claudeMdBytes)}  ${padStart(kb(p.claudeMdBytes), 7)}`;
      const name = p.current ? `${p.projectId} ${c(DIM, "*")}` : p.projectId;
      console.log(`  ${ICONS[status]}  ${pad(name, width)}${memory}${claudeMd}`);
      if (p.memoryNote) console.log(`       ${c(DIM, p.memoryNote)}`);
    }
  }

  console.log();
  if (report.warnings > 0) {
    console.log(
      `  ${c(WARN, `${report.warnings} over budget`)} ${c(DIM, "— trim before it compounds; the nightly rebuilds indexes, soul/taste edits are manual")}`,
    );
  } else {
    console.log(`  ${ICONS.ok}  ${c(DIM, "all within budget")}`);
  }
  console.log();
  process.exit(report.warnings > 0 ? 1 : 0);
}
