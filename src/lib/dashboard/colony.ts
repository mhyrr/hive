/**
 * Colony verdicts — the spine of the yard.
 *
 * A beekeeper's inspection does not end in a log, it ends in a verdict per
 * colony drawn from a small closed vocabulary. This module is that step:
 * pure, testable, and the only place a verdict is decided. The renderer
 * draws what it says and never re-derives it.
 *
 * Priority is strict and first-match-wins: a colony that needs you today is
 * never reported as merely swarming.
 */

import type { DashboardData, ProjectCard } from "./collect";

export type VerdictKind =
  | "needs-you"
  | "queenless"
  | "swarm-risk"
  | "needs-feeding"
  | "leave-alone";

export type Colony = {
  id: string;
  verdict: VerdictKind;
  /** One short clause naming what fired the verdict. Never a restatement. */
  reason: string;
  /** 0..1 against the yard's strongest colony. Shared scale, never per-card. */
  stores: number;
  /** Live memory entries. What `stores` is a fraction of — shown, so the
   *  hive's height is readable rather than a thing you have to be told. */
  entries: number;
  /** Open + in-progress tickets. Raw count; the yard scales it. */
  brood: number;
  /** Palette slot, stable per project id. */
  colour: number;
};

/** Days without an admitted memory entry before stores read as low. */
const FEED_THRESHOLD_DAYS = 14;
/** Blocked tickets tolerated before the colony reads as swarming. */
const SWARM_BLOCKED = 2;

/** Run statuses that mean the run is over and it did not go well. */
const FAILED = new Set(["failed", "error", "timeout", "killed"]);
/** Work finished but parked, waiting on a human to look. */
const PARKED = new Set(["review_ready"]);

const PALETTE_SLOTS = 5;

/** Stable, order-independent slot assignment so a colony keeps its colour. */
export function colourFor(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % PALETTE_SLOTS;
}

function daysBetween(fromIso: string, toDate: string): number {
  const a = new Date(fromIso).getTime();
  const b = new Date(`${toDate}T23:59:59.999Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (b - a) / 86_400_000);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Assign a verdict to every project in the yard.
 *
 * `stores` is normalised against the strongest colony present rather than an
 * absolute ceiling, so the yard compares against itself on one scale — the
 * bands stay readable whether HIVE knows a little or a lot.
 */
export function assignVerdicts(data: DashboardData): Colony[] {
  // Stores come from the whole knowledge store, never from the recentMemory
  // display slice — that slice is 7 days and 25 entries, so reading it as a
  // colony's holdings makes every quiet project look empty.
  const stats = new Map((data.memoryStats ?? []).map((s) => [s.projectId, s]));
  const peak = Math.max(1, ...[...stats.values()].map((s) => s.total));

  const newestMemory = new Map<string, string>();
  for (const s of stats.values()) {
    if (s.newestAt) newestMemory.set(s.projectId, s.newestAt);
  }

  const blockedByProject = new Map<string, number>();
  for (const t of data.tickets?.blocked ?? []) {
    blockedByProject.set(t.projectId, (blockedByProject.get(t.projectId) ?? 0) + 1);
  }

  return data.projects.map((p) => {
    const entries = stats.get(p.id)?.total ?? 0;
    const stores = entries / peak;
    const brood = p.ticketCounts.open + p.ticketCounts.inProgress;
    const base = { id: p.id, stores, entries, brood, colour: colourFor(p.id) };
    const { verdict, reason } = decide(p, data, {
      blocked: blockedByProject.get(p.id) ?? 0,
      lastMemory: newestMemory.get(p.id) ?? null,
      today: data.today,
    });
    return { ...base, verdict, reason };
  });
}

function decide(
  p: ProjectCard,
  data: DashboardData,
  ctx: { blocked: number; lastMemory: string | null; today: string },
): { verdict: VerdictKind; reason: string } {
  const runs = (data.runs ?? []).filter((r) => r.projectId === p.id);
  const failed = runs.filter((r) => FAILED.has(r.status));
  const parked = runs.filter((r) => PARKED.has(r.status));
  const inbox = (data.inboxes ?? []).find((i) => i.projectId === p.id);

  // 1. Needs you — something finished badly, or finished and is waiting.
  if (failed.length > 0) {
    return { verdict: "needs-you", reason: `${plural(failed.length, "run", "runs")} failed` };
  }
  if (parked.length > 0) {
    return { verdict: "needs-you", reason: `${plural(parked.length, "run", "runs")} waiting on review` };
  }
  // Inbox deliberately not consulted: Pass F leaves a tombstone in the file
  // that reads as content, so every project looks unread. See TK-144. Wire it
  // back in only once `isEmpty` tells the truth.
  void inbox;

  // 2. Queenless — the colony has no working head.
  if (!p.path) {
    return { verdict: "queenless", reason: "no path configured" };
  }
  // A missing heartbeat is not evidence: heartbeat is off by choice on this
  // machine, so its absence says nothing about the colony.
  if (p.lastResult && /error|fail/i.test(p.lastResult)) {
    return { verdict: "queenless", reason: "last inspection errored" };
  }

  // 3. Swarm risk — building up faster than it is being worked.
  if (ctx.blocked >= SWARM_BLOCKED && p.ticketCounts.inProgress === 0) {
    return {
      verdict: "swarm-risk",
      reason: `${plural(ctx.blocked, "ticket", "tickets")} blocked, none moving`,
    };
  }
  const urgent = (p.ticketCounts.byPriority?.[0] ?? 0) + (p.ticketCounts.byPriority?.[1] ?? 0);
  if (urgent > 0 && p.ticketCounts.inProgress === 0) {
    return { verdict: "swarm-risk", reason: `${plural(urgent, "high ticket", "high tickets")} untouched` };
  }

  // 4. Needs feeding — stores are not being replenished.
  const quietFor = ctx.lastMemory ? daysBetween(ctx.lastMemory, ctx.today) : Number.POSITIVE_INFINITY;
  if (quietFor >= FEED_THRESHOLD_DAYS) {
    const label = Number.isFinite(quietFor) ? `${Math.floor(quietFor)} days` : "ever";
    return { verdict: "needs-feeding", reason: `nothing learned in ${label}` };
  }

  return { verdict: "leave-alone", reason: "working" };
}

/** Yard order: what needs attention stands at the front. */
const RANK: Record<VerdictKind, number> = {
  "needs-you": 0,
  queenless: 1,
  "swarm-risk": 2,
  "needs-feeding": 3,
  "leave-alone": 4,
};

export function sortYard(colonies: Colony[]): Colony[] {
  return [...colonies].sort(
    (a, b) => RANK[a.verdict] - RANK[b.verdict] || b.stores - a.stores || a.id.localeCompare(b.id),
  );
}

/** Colonies the reader has to do something about today. */
export function needsAttention(colonies: Colony[]): Colony[] {
  return colonies.filter((c) => c.verdict !== "leave-alone");
}
