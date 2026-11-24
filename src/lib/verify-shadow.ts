// Shadow verifier comparison (TK-166).
//
// On a shadow night, full-canon Pass V decides and applies as usual, and a
// second, neighbour-scoped V decides the same candidates without applying
// anything. This module compares the two per candidate and writes
// runs/{DATE}/verify-shadow.{json,md}; `hive memory shadow-report` totals the
// nights. Greg decides whether to switch V to neighbours from those totals.
//
// The open risk the design doc names is duplicate rejects. They cite no
// target, so the TK-165 replay could not test them: if neighbour-scoped V
// cannot see the entry a candidate repeats, it may accept a duplicate. Every
// full-V duplicate reject is therefore tracked by what neighbour V did with it.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { HivePaths } from "./paths";
import type { DecisionAction, RetireDecision, VerifierDecision } from "./verify";

export interface ShadowSide {
  action: DecisionAction;
  target_hash?: string;
  reason?: string;
}

/**
 * agree         same action, and the same target for supersede and merge
 * action        different actions
 * target        both supersede or both merge, on different targets
 * missing       neighbour V returned no decision for the candidate
 */
export type ShadowOutcome = "agree" | "action" | "target" | "missing";

export interface ShadowRow {
  candidate_id: string;
  content?: string;
  full: ShadowSide;
  neighbor: ShadowSide | null;
  outcome: ShadowOutcome;
  /** For a full-V supersede or merge: whether its target was in neighbour V's canon. */
  fullTargetInScope?: boolean;
}

export interface ShadowCounts {
  candidates: number;
  agree: number;
  actionDiffers: number;
  targetDiffers: number;
  missing: number;
  /** Full-V supersede/merge decisions, and how many had their target in scope. */
  fullTargets: number;
  fullTargetsInScope: number;
  /** Full V rejected as duplicate. */
  dupRejects: number;
  /** ...and neighbour V accepted it: a duplicate that would have entered canon. */
  dupRejectsLeaked: number;
  /** ...and neighbour V kept it out some other way (another reject, merge, supersede). */
  dupRejectsHeldOtherwise: number;
  /** Neighbour V rejected as duplicate where full V did not. */
  neighborOnlyDupRejects: number;
  retiresFull: number;
  retiresNeighbor: number;
  retiresBoth: number;
  /** Projects whose shadow call failed. Their candidates are not in the counts. */
  errors: number;
}

export interface ShadowProjectReport {
  projectId: string;
  canon: { totalEntries: number; totalBytes: number; shownEntries: number; shownBytes: number };
  promptTokens?: { full: number; neighbor: number };
  rows: ShadowRow[];
  /** Full × neighbour action counts, "full>neighbor" → n. */
  matrix: Record<string, number>;
  retirements: { full: string[]; neighbor: string[] };
  counts: ShadowCounts;
  error?: string;
}

export interface ShadowNight {
  version: 1;
  date: string;
  k: number;
  projects: ShadowProjectReport[];
  totals: ShadowCounts;
  usage?: { inputTokens: number; outputTokens: number; totalUsd: number };
}

export function emptyCounts(): ShadowCounts {
  return {
    candidates: 0,
    agree: 0,
    actionDiffers: 0,
    targetDiffers: 0,
    missing: 0,
    fullTargets: 0,
    fullTargetsInScope: 0,
    dupRejects: 0,
    dupRejectsLeaked: 0,
    dupRejectsHeldOtherwise: 0,
    neighborOnlyDupRejects: 0,
    retiresFull: 0,
    retiresNeighbor: 0,
    retiresBoth: 0,
    errors: 0,
  };
}

export function addCounts(a: ShadowCounts, b: ShadowCounts): ShadowCounts {
  const out = emptyCounts();
  for (const k of Object.keys(out) as Array<keyof ShadowCounts>) out[k] = a[k] + b[k];
  return out;
}

const isDuplicateReject = (s: ShadowSide | null): boolean =>
  s?.action === "reject" && /duplicate/i.test(s.reason ?? "");

const side = (d: VerifierDecision): ShadowSide => ({
  action: d.action,
  ...(d.target_hash ? { target_hash: d.target_hash } : {}),
  ...(d.reason ? { reason: d.reason } : {}),
});

/** Compare one project's two decision sets. `fullDecisions` drives the rows:
 * every candidate full V decided gets one row. */
export function compareShard(input: {
  projectId: string;
  fullDecisions: VerifierDecision[];
  neighborDecisions: VerifierDecision[];
  neighborScope: Set<string>;
  canon: ShadowProjectReport["canon"];
  contentById?: Map<string, string>;
  fullRetirements?: RetireDecision[];
  neighborRetirements?: RetireDecision[];
  promptTokens?: { full: number; neighbor: number };
}): ShadowProjectReport {
  const byId = new Map(input.neighborDecisions.map((d) => [d.candidate_id, d]));
  const counts = emptyCounts();
  const matrix: Record<string, number> = {};
  const rows: ShadowRow[] = [];

  for (const f of input.fullDecisions) {
    const n = byId.get(f.candidate_id);
    const full = side(f);
    const neighbor = n ? side(n) : null;
    counts.candidates++;

    let outcome: ShadowOutcome;
    if (!neighbor) outcome = "missing";
    else if (neighbor.action !== full.action) outcome = "action";
    else if ((full.action === "supersede" || full.action === "merge") && neighbor.target_hash !== full.target_hash) {
      outcome = "target";
    } else outcome = "agree";

    if (outcome === "agree") counts.agree++;
    else if (outcome === "action") counts.actionDiffers++;
    else if (outcome === "target") counts.targetDiffers++;
    else counts.missing++;
    const cell = `${full.action}>${neighbor?.action ?? "none"}`;
    matrix[cell] = (matrix[cell] ?? 0) + 1;

    const row: ShadowRow = {
      candidate_id: f.candidate_id,
      ...(input.contentById?.get(f.candidate_id) ? { content: input.contentById.get(f.candidate_id)! } : {}),
      full,
      neighbor,
      outcome,
    };
    if ((full.action === "supersede" || full.action === "merge") && full.target_hash) {
      counts.fullTargets++;
      row.fullTargetInScope = input.neighborScope.has(full.target_hash);
      if (row.fullTargetInScope) counts.fullTargetsInScope++;
    }
    if (isDuplicateReject(full)) {
      counts.dupRejects++;
      if (neighbor?.action === "accept") counts.dupRejectsLeaked++;
      else if (neighbor && !isDuplicateReject(neighbor)) counts.dupRejectsHeldOtherwise++;
    } else if (isDuplicateReject(neighbor)) {
      counts.neighborOnlyDupRejects++;
    }
    rows.push(row);
  }

  const fullRet = (input.fullRetirements ?? []).map((r) => r.target_hash);
  const nRet = (input.neighborRetirements ?? []).map((r) => r.target_hash);
  counts.retiresFull = fullRet.length;
  counts.retiresNeighbor = nRet.length;
  counts.retiresBoth = fullRet.filter((h) => nRet.includes(h)).length;

  return {
    projectId: input.projectId,
    canon: input.canon,
    ...(input.promptTokens ? { promptTokens: input.promptTokens } : {}),
    rows,
    matrix,
    retirements: { full: fullRet, neighbor: nRet },
    counts,
  };
}

export function shadowFailure(projectId: string, canon: ShadowProjectReport["canon"], error: string): ShadowProjectReport {
  return {
    projectId,
    canon,
    rows: [],
    matrix: {},
    retirements: { full: [], neighbor: [] },
    counts: { ...emptyCounts(), errors: 1 },
    error,
  };
}

export function totalCounts(projects: ShadowProjectReport[]): ShadowCounts {
  return projects.reduce((t, p) => addCounts(t, p.counts), emptyCounts());
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const pct = (n: number, d: number): string => (d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`);
const kb = (b: number): string => `${Math.round(b / 1024)}KB`;

function describeSide(s: ShadowSide | null): string {
  if (!s) return "(no decision)";
  if (s.target_hash) return `${s.action} ${s.target_hash}`;
  if (s.reason) return `${s.action}: ${s.reason}`;
  return s.action;
}

/** The headline line for a set of counts. Used by the night file, the
 * briefing section and the multi-night summary, so all three read alike. */
export function countsLine(c: ShadowCounts): string {
  const parts = [
    `${c.agree}/${c.candidates} candidates decided alike (${pct(c.agree, c.candidates)})`,
    `${c.actionDiffers} by action, ${c.targetDiffers} by target${c.missing ? `, ${c.missing} undecided` : ""}`,
    `targets in scope ${c.fullTargetsInScope}/${c.fullTargets}`,
    `duplicate rejects ${c.dupRejects}: ${c.dupRejectsLeaked} accepted by neighbour V, ${c.dupRejectsHeldOtherwise} kept out another way`,
  ];
  if (c.retiresFull + c.retiresNeighbor > 0) {
    parts.push(`retires full ${c.retiresFull} · neighbour ${c.retiresNeighbor} · both ${c.retiresBoth}`);
  }
  if (c.errors > 0) parts.push(`${c.errors} shadow call(s) failed`);
  return parts.join(" · ");
}

export function renderShadowMarkdown(night: ShadowNight): string {
  const lines = [
    `# Shadow verifier — ${night.date}`,
    "",
    `Full-canon V applied. Neighbour-scoped V (top ${night.k} per candidate) decided the same candidates and applied nothing.`,
    "",
    `**Total:** ${countsLine(night.totals)}`,
  ];
  if (night.usage) {
    lines.push(`**Shadow cost:** $${night.usage.totalUsd.toFixed(2)} (${night.usage.inputTokens} in, ${night.usage.outputTokens} out)`);
  }
  for (const p of night.projects) {
    lines.push("", `## ${p.projectId}`, "");
    lines.push(
      `Canon shown: ${p.canon.shownEntries}/${p.canon.totalEntries} entries, ` +
        `${kb(p.canon.shownBytes)}/${kb(p.canon.totalBytes)} (${pct(p.canon.shownBytes, p.canon.totalBytes)})` +
        (p.promptTokens ? ` · prompt ~${p.promptTokens.neighbor} vs ~${p.promptTokens.full} tokens` : ""),
    );
    if (p.error) {
      lines.push("", `Shadow call failed: ${p.error}`);
      continue;
    }
    lines.push("", countsLine(p.counts));
    const cells = Object.entries(p.matrix).sort(([a], [b]) => a.localeCompare(b));
    if (cells.length > 0) {
      lines.push("", "| full → neighbour | n |", "|---|---:|");
      for (const [cell, n] of cells) lines.push(`| ${cell.replace(">", " → ")} | ${n} |`);
    }
    const differ = p.rows.filter((r) => r.outcome !== "agree");
    if (differ.length > 0) {
      lines.push("", "Disagreements:");
      for (const r of differ) {
        const scope = r.fullTargetInScope === false ? " (full V's target was NOT in scope)" : "";
        const leak = isDuplicateReject(r.full) && r.neighbor?.action === "accept" ? " **duplicate leak**" : "";
        lines.push(
          `- \`${r.candidate_id}\` full: ${describeSide(r.full)} · neighbour: ${describeSide(r.neighbor)}${scope}${leak}` +
            (r.content ? `\n  > ${r.content.replace(/\s+/g, " ").slice(0, 240)}` : ""),
        );
      }
    }
    if (p.retirements.full.length + p.retirements.neighbor.length > 0) {
      lines.push("", `Retired by full V: ${p.retirements.full.join(", ") || "none"}`);
      lines.push(`Retired by neighbour V: ${p.retirements.neighbor.join(", ") || "none"}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** A short section for the night's briefing. */
export function renderShadowBriefingSection(night: ShadowNight): string {
  return [
    "## Shadow verifier",
    `- ${countsLine(night.totals)}`,
    `- Details: runs/${night.date}/verify-shadow.md · running total: \`hive memory shadow-report\``,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Multi-night summary
// ---------------------------------------------------------------------------

export function shadowNightPath(paths: HivePaths, date: string): string {
  return join(paths.memoryRunsDir, date, "verify-shadow.json");
}

/** The most recent `days` shadow nights on or before `through`, oldest first. */
export async function loadShadowNights(paths: HivePaths, through: string, days: number): Promise<ShadowNight[]> {
  if (!existsSync(paths.memoryRunsDir)) return [];
  const dates = readdirSync(paths.memoryRunsDir)
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= through && existsSync(shadowNightPath(paths, d)))
    .sort()
    .slice(-days);
  const out: ShadowNight[] = [];
  for (const d of dates) {
    try {
      out.push(JSON.parse(await Bun.file(shadowNightPath(paths, d)).text()) as ShadowNight);
    } catch {
      // intentional: a torn night file is skipped, and the report says how many nights it read
    }
  }
  return out;
}

export function summarizeShadowNights(nights: ShadowNight[]): string {
  if (nights.length === 0) {
    return "No shadow nights yet. Set HIVE_VERIFY_SHADOW=on for the nightly to start one.";
  }
  const total = nights.reduce((t, n) => addCounts(t, n.totals), emptyCounts());
  const cost = nights.reduce((s, n) => s + (n.usage?.totalUsd ?? 0), 0);
  const lines = [
    `Shadow verifier: ${nights.length} night(s), ${nights[0]!.date} to ${nights[nights.length - 1]!.date}`,
    "",
    `Total: ${countsLine(total)}`,
    `Shadow cost: $${cost.toFixed(2)}`,
    "",
    "| night | candidates | alike | by action | by target | targets in scope | dup rejects | dup leaks | errors |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const n of nights) {
    const c = n.totals;
    lines.push(
      `| ${n.date} | ${c.candidates} | ${c.agree} | ${c.actionDiffers} | ${c.targetDiffers} | ` +
        `${c.fullTargetsInScope}/${c.fullTargets} | ${c.dupRejects} | ${c.dupRejectsLeaked} | ${c.errors} |`,
    );
  }
  const matrix = new Map<string, number>();
  for (const n of nights) {
    for (const p of n.projects) for (const [k, v] of Object.entries(p.matrix)) matrix.set(k, (matrix.get(k) ?? 0) + v);
  }
  if (matrix.size > 0) {
    lines.push("", "By decision (full → neighbour):", "");
    for (const [k, v] of [...matrix].sort(([a], [b]) => a.localeCompare(b))) lines.push(`  ${k.replace(">", " → ")}: ${v}`);
  }
  const leaks = nights.flatMap((n) =>
    n.projects.flatMap((p) =>
      p.rows
        .filter((r) => isDuplicateReject(r.full) && r.neighbor?.action === "accept")
        .map((r) => `  ${n.date} ${r.candidate_id}${r.content ? `: ${r.content.replace(/\s+/g, " ").slice(0, 160)}` : ""}`),
    ),
  );
  if (leaks.length > 0) lines.push("", "Duplicate leaks (full V rejected as duplicate, neighbour V accepted):", ...leaks);
  return lines.join("\n");
}
