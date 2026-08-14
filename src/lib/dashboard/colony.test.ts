import { describe, test, expect } from "bun:test";

import { assignVerdicts, needsAttention, sortYard, type VerdictKind } from "./colony";
import type { DashboardData, MemoryStat, ProjectCard, RunEntry } from "./collect";

const TODAY = "2026-08-14";

/** Days before TODAY as an ISO stamp — anchored to the date under test, never the clock. */
function daysBefore(n: number): string {
  return new Date(Date.parse(`${TODAY}T12:00:00Z`) - n * 86_400_000).toISOString();
}

function project(id: string, over: Partial<ProjectCard> = {}): ProjectCard {
  return {
    id,
    path: `/work/${id}`,
    lastHeartbeat: daysBefore(0),
    tickCount: 4,
    lastResult: "quiet",
    ticketCounts: { open: 1, inProgress: 1, closed: 8, byPriority: { 0: 0, 1: 0, 2: 1, 3: 0 } },
    inboxMtime: null,
    ...over,
  } as ProjectCard;
}

/** A colony's holdings: whole-store totals, not the recentMemory display slice. */
function stat(projectId: string, over: Partial<MemoryStat> = {}): MemoryStat {
  return { projectId, total: 10, newestAt: daysBefore(1), ...over };
}

function run(projectId: string, status: string): RunEntry {
  return {
    id: "RUN-001",
    status,
    durationMs: 1000,
    startedAt: daysBefore(0),
    goalSnippet: "do the thing",
    projectId,
    ticketId: null,
  };
}

function dash(over: Partial<DashboardData> = {}): DashboardData {
  return {
    activity: [],
    memoryStats: [],
    generatedAt: daysBefore(0),
    volumeNumber: 1,
    today: TODAY,
    health: [],
    projects: [],
    inboxes: [],
    tickets: { ready: [], inProgress: [], blocked: [] },
    runs: [],
    briefings: [],
    todayBriefing: null,
    promotionCandidates: [],
    openQuestions: [],
    recentMemory: [],
    runUsage: {} as DashboardData["runUsage"],
    tasteTrack: {} as DashboardData["tasteTrack"],
    latestReflection: null,
    propose: null,
    ...over,
  } as DashboardData;
}

function verdictOf(data: DashboardData, id: string): VerdictKind {
  const c = assignVerdicts(data).find((x) => x.id === id);
  if (!c) throw new Error(`no colony ${id}`);
  return c.verdict;
}

describe("colony verdicts", () => {
  test("a healthy colony is left alone", () => {
    const data = dash({ projects: [project("hive")], memoryStats: [stat("hive")] });
    expect(verdictOf(data, "hive")).toBe("leave-alone");
  });

  test("a failed run needs you", () => {
    const data = dash({
      projects: [project("hive")],
      memoryStats: [stat("hive")],
      runs: [run("hive", "failed")],
    });
    const c = assignVerdicts(data)[0];
    expect(c.verdict).toBe("needs-you");
    expect(c.reason).toBe("1 run failed");
  });

  test("work parked at review_ready needs you", () => {
    const data = dash({
      projects: [project("hive")],
      memoryStats: [stat("hive")],
      runs: [run("hive", "review_ready")],
    });
    expect(assignVerdicts(data)[0].reason).toBe("1 run waiting on review");
  });

  // TK-144: Pass F tombstones make every inbox read as unread, so the inbox
  // is not consulted at all until `isEmpty` tells the truth. Locked down here
  // so re-wiring it is a deliberate act with a failing test, not a drift.
  test("the inbox does not drive verdicts while its signal is broken", () => {
    const data = dash({
      projects: [project("hive")],
      memoryStats: [stat("hive")],
      inboxes: [{ projectId: "hive", mtime: daysBefore(0), body: "note", isEmpty: false }],
    });
    expect(verdictOf(data, "hive")).toBe("leave-alone");
  });

  test("a missing heartbeat is not evidence of anything", () => {
    const data = dash({
      projects: [project("hive", { tickCount: 0, lastHeartbeat: null })],
      memoryStats: [stat("hive")],
    });
    expect(verdictOf(data, "hive")).toBe("leave-alone");
  });

  test("a project with no configured path is queenless", () => {
    const data = dash({ projects: [project("hive", { path: null })], memoryStats: [stat("hive")] });
    const c = assignVerdicts(data)[0];
    expect(c.verdict).toBe("queenless");
    expect(c.reason).toBe("no path configured");
  });

  test("an errored last inspection is queenless", () => {
    const data = dash({
      projects: [project("hive", { lastResult: "ERROR: dispatch refused" })],
      memoryStats: [stat("hive")],
    });
    expect(verdictOf(data, "hive")).toBe("queenless");
  });

  test("blocked tickets with nothing moving is swarm risk", () => {
    const data = dash({
      projects: [
        project("hive", {
          ticketCounts: { open: 4, inProgress: 0, closed: 0, byPriority: { 0: 0, 1: 0, 2: 4, 3: 0 } },
        }),
      ],
      memoryStats: [stat("hive")],
      tickets: {
        ready: [],
        inProgress: [],
        blocked: [{ projectId: "hive" } as never, { projectId: "hive" } as never],
      },
    });
    const c = assignVerdicts(data)[0];
    expect(c.verdict).toBe("swarm-risk");
    expect(c.reason).toBe("2 tickets blocked, none moving");
  });

  test("untouched high-priority work is swarm risk", () => {
    const data = dash({
      projects: [
        project("hive", {
          ticketCounts: { open: 2, inProgress: 0, closed: 0, byPriority: { 0: 1, 1: 1, 2: 0, 3: 0 } },
        }),
      ],
      memoryStats: [stat("hive")],
    });
    expect(assignVerdicts(data)[0].reason).toBe("2 high tickets untouched");
  });

  test("a colony that has stopped learning needs feeding", () => {
    const data = dash({
      projects: [project("hive")],
      memoryStats: [stat("hive", { newestAt: daysBefore(30) })],
    });
    const c = assignVerdicts(data)[0];
    expect(c.verdict).toBe("needs-feeding");
    expect(c.reason).toBe("nothing learned in 30 days");
  });

  test("a colony with no memory at all needs feeding", () => {
    const data = dash({ projects: [project("hive")] });
    expect(assignVerdicts(data)[0].reason).toBe("nothing learned in ever");
  });

  test("a deep store with a quiet week is not starving", () => {
    // The regression that made every colony read NEEDS FEEDING: judging
    // holdings by the 7-day/25-entry recentMemory slice instead of the store.
    const data = dash({
      projects: [project("hive")],
      recentMemory: [], // nothing in the display window
      memoryStats: [stat("hive", { total: 300, newestAt: daysBefore(3) })],
    });
    expect(verdictOf(data, "hive")).toBe("leave-alone");
  });

  test("staleness is measured from the date under test, not the wall clock", () => {
    const fresh = dash({
      projects: [project("hive")],
      memoryStats: [stat("hive", { newestAt: daysBefore(5) })],
    });
    expect(verdictOf(fresh, "hive")).toBe("leave-alone");

    const later = dash({
      today: "2026-09-14",
      projects: [project("hive")],
      memoryStats: [stat("hive", { newestAt: daysBefore(5) })],
    });
    expect(verdictOf(later, "hive")).toBe("needs-feeding");
  });

  test("priority is strict: a failed run outranks blocked tickets", () => {
    const data = dash({
      projects: [
        project("hive", {
          ticketCounts: { open: 4, inProgress: 0, closed: 0, byPriority: { 0: 2, 1: 0, 2: 2, 3: 0 } },
        }),
      ],
      memoryStats: [stat("hive", { newestAt: daysBefore(90) })],
      runs: [run("hive", "failed")],
    });
    expect(verdictOf(data, "hive")).toBe("needs-you");
  });

  test("stores share one scale across the yard, never per-colony", () => {
    const data = dash({
      projects: [project("big"), project("small")],
      memoryStats: [stat("big", { total: 8 }), stat("small", { total: 2 })],
    });
    const byId = Object.fromEntries(assignVerdicts(data).map((c) => [c.id, c.stores]));
    expect(byId.big).toBe(1);
    expect(byId.small).toBe(0.25);
  });

  test("colour is stable per project id regardless of yard order", () => {
    const a = assignVerdicts(dash({ projects: [project("alpha"), project("beta")] }));
    const b = assignVerdicts(dash({ projects: [project("beta"), project("alpha")] }));
    const colour = (cs: typeof a, id: string) => cs.find((c) => c.id === id)!.colour;
    expect(colour(a, "alpha")).toBe(colour(b, "alpha"));
    expect(colour(a, "beta")).toBe(colour(b, "beta"));
  });
});

describe("yard ordering", () => {
  test("what needs you stands at the front", () => {
    const data = dash({
      projects: [project("calm"), project("broken"), project("stale")],
      memoryStats: [stat("calm"), stat("broken"), stat("stale", { newestAt: daysBefore(60) })],
      runs: [run("broken", "failed")],
    });
    const order = sortYard(assignVerdicts(data)).map((c) => c.id);
    expect(order).toEqual(["broken", "stale", "calm"]);
  });

  test("needsAttention drops the quiet colonies", () => {
    const data = dash({
      projects: [project("calm"), project("broken")],
      memoryStats: [stat("calm"), stat("broken")],
      runs: [run("broken", "failed")],
    });
    expect(needsAttention(assignVerdicts(data)).map((c) => c.id)).toEqual(["broken"]);
  });
});
