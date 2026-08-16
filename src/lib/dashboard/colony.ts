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
import type { ProjectActivity } from "./activity";

export type VerdictKind =
  | "needs-you"
  | "queenless"
  | "active"
  | "waiting"
  | "quiet";

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
  /** Weighted attention score. Paint is `score >= PAINT_THRESHOLD`. */
  score: number;
};

/**
 * The attention rubric.
 *
 * A single trigger was too eager — one open P1 painted a colony that was
 * having an ordinary Tuesday. Attention is a weighted sum instead, so a
 * colony earns paint by combining momentum and pending work rather than by
 * tripping one wire. Every weight lives here; tuning the yard is editing
 * this block and nothing else.
 */
const WEIGHTS = {
  /** Commits in the last couple of days. The strongest single signal. */
  recentCommits: 3,
  /** A sustained month of work, not just yesterday's burst. */
  busyMonth: 2, // >= BUSY_MONTH_COMMITS
  steadyMonth: 1, // >= STEADY_MONTH_COMMITS
  /** Tickets actually moving, capped so a big queue cannot dominate. */
  perTicketTouched: 1,
  ticketTouchedCap: 2,
  /** Something open at the top of the queue. */
  highPriorityOpen: 2,
  /** Work in flight. */
  inProgress: 1,
  /** A queue that cannot move. */
  blockedStalled: 2,
} as const;

/** Score at or above this and the colony gets painted. */
export const PAINT_THRESHOLD = 3;

const BUSY_MONTH_COMMITS = 20;
const STEADY_MONTH_COMMITS = 5;

/** Days without an admitted memory entry before the store reads as cold. */
const STALE_MEMORY_DAYS = 30;

/** Act outcomes that mean branch-only work needs a human. */
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

  const activityByProject = new Map((data.activity ?? []).map((a) => [a.projectId, a]));

  return data.projects.map((p) => {
    const entries = stats.get(p.id)?.total ?? 0;
    const stores = entries / peak;
    const brood = p.ticketCounts.open + p.ticketCounts.inProgress;
    const base = { id: p.id, stores, entries, brood, colour: colourFor(p.id) };
    const { verdict, reason, score } = decide(p, data, {
      blocked: blockedByProject.get(p.id) ?? 0,
      lastMemory: newestMemory.get(p.id) ?? null,
      activity: activityByProject.get(p.id) ?? null,
      today: data.today,
    });
    return { ...base, verdict, reason, score };
  });
}

/** Named contributions, so the plate can say which signal carried the score. */
function scoreOf(
  p: ProjectCard,
  ctx: { blocked: number; activity: ProjectActivity | null },
): { score: number; parts: string[]; moving: boolean } {
  const parts: string[] = [];
  let score = 0;
  let moving = false;

  const recent = ctx.activity?.commits ?? 0;
  if (recent > 0) {
    score += WEIGHTS.recentCommits;
    moving = true;
    parts.push(`${recent} ${recent === 1 ? "commit" : "commits"}`);
  }

  const month = ctx.activity?.monthCommits ?? 0;
  if (month >= BUSY_MONTH_COMMITS) {
    score += WEIGHTS.busyMonth;
    if (recent === 0) parts.push(`${month} commits this month`);
  } else if (month >= STEADY_MONTH_COMMITS) {
    score += WEIGHTS.steadyMonth;
    if (recent === 0) parts.push(`${month} commits this month`);
  }

  if (p.ticketsTouched > 0) {
    score += Math.min(p.ticketsTouched * WEIGHTS.perTicketTouched, WEIGHTS.ticketTouchedCap);
    moving = true;
    parts.push(`${p.ticketsTouched} ${p.ticketsTouched === 1 ? "ticket" : "tickets"} moving`);
  }

  const high = (p.ticketCounts.byPriority?.[0] ?? 0) + (p.ticketCounts.byPriority?.[1] ?? 0);
  if (high > 0) {
    score += WEIGHTS.highPriorityOpen;
    parts.push(`${high} high ${high === 1 ? "ticket" : "tickets"} open`);
  }

  if (p.ticketCounts.inProgress > 0) {
    score += WEIGHTS.inProgress;
    moving = true;
  }

  if (ctx.blocked > 0 && p.ticketCounts.inProgress === 0) {
    score += WEIGHTS.blockedStalled;
    parts.push(`${ctx.blocked} blocked, none moving`);
  }

  return { score, parts, moving };
}

function decide(
  p: ProjectCard,
  data: DashboardData,
  ctx: {
    blocked: number;
    lastMemory: string | null;
    activity: ProjectActivity | null;
    today: string;
  },
): { verdict: VerdictKind; reason: string; score: number } {
  const actWork = (data.actWork ?? []).filter((item) => item.projectId === p.id);
  const failed = actWork.filter((item) => FAILED.has(item.status));
  const parked = actWork.filter((item) => PARKED.has(item.status));
  const inbox = (data.inboxes ?? []).find((i) => i.projectId === p.id);
  const { score, parts, moving } = scoreOf(p, { blocked: ctx.blocked, activity: ctx.activity });

  // 1. Needs you — Act finished badly, or finished and is waiting.
  // These bypass the score outright: no amount of quiet makes failed work
  // wait until tomorrow.
  if (failed.length > 0) {
    return { verdict: "needs-you", reason: `${plural(failed.length, "Act branch", "Act branches")} failed`, score };
  }
  if (parked.length > 0) {
    return {
      verdict: "needs-you",
      reason: `${plural(parked.length, "Act branch", "Act branches")} waiting on review`,
      score,
    };
  }
  if (inbox && !inbox.isEmpty) {
    return { verdict: "needs-you", reason: "inbox has findings", score };
  }

  // 2. Queenless — the colony has no working head.
  if (!p.path) {
    return { verdict: "queenless", reason: "no path configured", score };
  }
  // 3. Everything else is the rubric. Above the line it earns paint; the
  // label separates a colony with momentum from one that is only accruing.
  if (score >= PAINT_THRESHOLD) {
    return {
      verdict: moving ? "active" : "waiting",
      reason: parts.slice(0, 2).join(", ") || "in motion",
      score,
    };
  }

  // 4. Below the line. Say something true rather than nothing: a cold store
  // is worth knowing about even when it is not worth acting on.
  const coldFor = ctx.lastMemory ? daysBetween(ctx.lastMemory, ctx.today) : Number.POSITIVE_INFINITY;
  if (coldFor >= STALE_MEMORY_DAYS) {
    const label = Number.isFinite(coldFor) ? `${Math.floor(coldFor)} days` : "ever";
    return { verdict: "quiet", reason: `nothing learned in ${label}`, score };
  }

  return { verdict: "quiet", reason: parts[0] ?? "nothing pending", score };
}

/** Yard order: what needs attention stands at the front. */
const RANK: Record<VerdictKind, number> = {
  "needs-you": 0,
  queenless: 1,
  active: 2,
  waiting: 3,
  quiet: 4,
};

export function sortYard(colonies: Colony[]): Colony[] {
  return [...colonies].sort(
    (a, b) =>
      RANK[a.verdict] - RANK[b.verdict] ||
      b.score - a.score ||
      b.stores - a.stores ||
      a.id.localeCompare(b.id),
  );
}

/** Colonies worth a look today — the painted ones. */
export function needsAttention(colonies: Colony[]): Colony[] {
  return colonies.filter((c) => c.verdict !== "quiet");
}
