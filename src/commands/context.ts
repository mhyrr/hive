import { buildContextReport, CONTEXT_BUDGETS, type SizeStatus } from "../lib/context-report";
import { UsageError } from "../lib/errors";

const USAGE = `Usage: hive context [--json]

Audit the context HIVE loads at session start — the identity injection
(soul stack, persona, project memory index, stack hint, taste layer) plus
each registered project's CLAUDE.md — against the size budgets set at the
2026-07 slim-down. Also available as: hive prompts.

  --json    Emit the full report as JSON (for tracking size over time)

Exits 1 if anything is over budget, so it can gate CI or a pre-push hook.`;

const ICONS: Record<SizeStatus, string> = {
  ok: "\x1b[32m✓\x1b[0m",
  warn: "\x1b[33m⚠\x1b[0m",
};

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function tok(tokens: number): string {
  return tokens >= 1000 ? `~${(tokens / 1000).toFixed(1)}k tokens` : `~${tokens} tokens`;
}

export async function contextCommand(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }
  const json = args.includes("--json");
  const unknown = args.filter((a) => a !== "--json");
  if (unknown.length > 0) {
    throw new UsageError(`Unknown argument: ${unknown[0]}\n\n${USAGE}`);
  }

  const report = await buildContextReport();

  if (json) {
    console.log(JSON.stringify({ budgets: CONTEXT_BUDGETS, ...report }, null, 2));
    process.exit(report.warnings > 0 ? 1 : 0);
  }

  console.log("hive context\n");

  const where = report.projectId ? `project: ${report.projectId}` : "no project resolved from cwd";
  console.log(`  Identity injection (per interactive session, ${where})`);

  if (report.components.length === 0) {
    console.log("  ⚠  nothing to emit — is ~/.hive initialized? Run: hive init");
  }

  const labelWidth = Math.max(...report.components.map((c) => c.label.length), "soul stack total".length) + 2;
  for (const c of report.components) {
    const size = c.budgetBytes
      ? `${kb(c.bytes)} / ${kb(c.budgetBytes)} budget`
      : kb(c.bytes);
    console.log(`  ${ICONS[c.status]}  ${c.label.padEnd(labelWidth)}${size}  (${tok(c.tokens)})`);
    if (c.note) console.log(`        ${c.note}`);
  }
  console.log(
    `  ${ICONS[report.soulStack.status]}  ${"soul stack total".padEnd(labelWidth)}` +
    `${kb(report.soulStack.bytes)} / ${kb(report.soulStack.budgetBytes)} budget  (${tok(report.soulStack.tokens)})`,
  );
  console.log(
    `  ${ICONS[report.total.status]}  ${"total emit".padEnd(labelWidth)}` +
    `${kb(report.total.bytes)} / ${kb(report.total.budgetBytes)} window  (${tok(report.total.tokens)})`,
  );

  if (report.projects.length > 0) {
    console.log("\n  Per-project session-start load");
    const idWidth = Math.max(...report.projects.map((p) => p.projectId.length)) + 2;
    for (const p of report.projects) {
      const status: SizeStatus = p.memoryStatus === "warn" || p.claudeMdStatus === "warn" ? "warn" : "ok";
      const memory =
        p.memorySource === "index" ? `index ${kb(p.memoryBytes!)} / ${kb(CONTEXT_BUDGETS.memoryIndexBytes)}`
        : p.memorySource === "knowledge" ? `knowledge.md ${kb(p.memoryBytes!)} (no index)`
        : "no memory";
      const claudeMd = p.claudeMdBytes !== null ? `CLAUDE.md ${kb(p.claudeMdBytes)}` : "no CLAUDE.md";
      const marker = p.current ? " *" : "";
      console.log(`  ${ICONS[status]}  ${(p.projectId + marker).padEnd(idWidth + 2)}${memory.padEnd(30)}${claudeMd}`);
      if (p.memoryNote) console.log(`        ${p.memoryNote}`);
    }
  }

  console.log();
  if (report.warnings > 0) {
    console.log(`  \x1b[33m${report.warnings} over budget\x1b[0m — trim before it compounds; the nightly rebuilds indexes, soul/taste edits are manual`);
  } else {
    console.log("  all within budget");
  }
  console.log();
  process.exit(report.warnings > 0 ? 1 : 0);
}
