import { describe, test, expect } from "bun:test";

import {
  assignVerdicts,
  needsAttention,
  sortYard,
  PAINT_THRESHOLD,
  type VerdictKind,
} from "./colony";
import type { ProjectActivity } from "./activity";
import type { ActWorkEntry, DashboardData, MemoryStat, ProjectCard } from "./collect";

const TODAY = "2026-08-14";

/** Days before TODAY as an ISO stamp — anchored to the date under test, never the clock. */
function daysBefore(n: number): string {
  return new Date(Date.parse(`${TODAY}T12:00:00Z`) - n * 86_400_000).toISOString();
}

/** A deliberately inert project: nothing moving, nothing pending, score 0. */
function project(id: string, over: Partial<ProjectCard> = {}): ProjectCard {
  return {
    id,
    path: `/work/${id}`,
    ticketCounts: { open: 1, inProgress: 0, closed: 8, byPriority: { 0: 0, 1: 0, 2: 1, 3: 0 } },
    ticketsTouched: 0,
    inboxMtime: null,
    ...over,
  } as ProjectCard;
}

/** A colony's holdings: whole-store totals, not the recentMemory display slice. */
function stat(projectId: string, over: Partial<MemoryStat> = {}): MemoryStat {
  return { projectId, total: 10, newestAt: daysBefore(1), ...over };
}

function activity(projectId: string, over: Partial<ProjectActivity> = {}): ProjectActivity {
  return {
    projectId,
    commits: 0,
    insertions: 0,
    deletions: 0,
    filesChanged: 0,
    subjects: [],
    monthCommits: 0,
    ...over,
  };
}

function actWork(projectId: string, status: string): ActWorkEntry {
  return { status, projectId };
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
    actWork: [],
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

function only(data: DashboardData) {
  return assignVerdicts(data)[0];
}

function verdictOf(data: DashboardData, id: string): VerdictKind {
  const c = assignVerdicts(data).find((x) => x.id === id);
  if (!c) throw new Error(`no colony ${id}`);
  return c.verdict;
}

describe("escalations bypass the rubric", () => {
  test("a failed Act branch needs you no matter how quiet the colony is", () => {
    const c = only(
      dash({
        projects: [project("hive")],
        memoryStats: [stat("hive")],
        actWork: [actWork("hive", "failed")],
      }),
    );
    expect(c.verdict).toBe("needs-you");
    expect(c.reason).toBe("1 Act branch failed");
    expect(c.score).toBeLessThan(PAINT_THRESHOLD); // painted despite scoring low
  });

  test("work parked at review_ready needs you", () => {
    const c = only(
      dash({
        projects: [project("hive")],
        memoryStats: [stat("hive")],
        actWork: [actWork("hive", "review_ready")],
      }),
    );
    expect(c.verdict).toBe("needs-you");
    expect(c.reason).toBe("1 Act branch waiting on review");
  });

  test("a project with no configured path is queenless", () => {
    const c = only(dash({ projects: [project("hive", { path: null })], memoryStats: [stat("hive")] }));
    expect(c.verdict).toBe("queenless");
    expect(c.reason).toBe("no path configured");
  });

});

describe("the attention rubric", () => {
  // The bug this rubric exists to fix: one open P1 used to paint a colony
  // that was otherwise having an ordinary Tuesday.
  test("a single open P1 is not enough on its own", () => {
    const c = only(
      dash({
        projects: [
          project("hive", {
            ticketCounts: { open: 1, inProgress: 0, closed: 0, byPriority: { 0: 0, 1: 1, 2: 0, 3: 0 } },
          }),
        ],
        memoryStats: [stat("hive")],
      }),
    );
    expect(c.score).toBeLessThan(PAINT_THRESHOLD);
    expect(c.verdict).toBe("quiet");
  });

  test("recent commits alone clear the line", () => {
    const c = only(
      dash({
        projects: [project("hive")],
        memoryStats: [stat("hive")],
        activity: [activity("hive", { commits: 4, monthCommits: 4 })],
      }),
    );
    expect(c.verdict).toBe("active");
    expect(c.reason).toContain("4 commits");
  });

  test("a busy month with a quiet week still registers, but not alone", () => {
    const quietWeek = only(
      dash({
        projects: [project("hive")],
        memoryStats: [stat("hive")],
        activity: [activity("hive", { commits: 0, monthCommits: 40 })],
      }),
    );
    expect(quietWeek.score).toBe(2);
    expect(quietWeek.verdict).toBe("quiet");

    const plusPending = only(
      dash({
        projects: [
          project("hive", {
            ticketCounts: { open: 1, inProgress: 0, closed: 0, byPriority: { 0: 1, 1: 0, 2: 0, 3: 0 } },
          }),
        ],
        memoryStats: [stat("hive")],
        activity: [activity("hive", { commits: 0, monthCommits: 40 })],
      }),
    );
    expect(plusPending.verdict).toBe("waiting");
    expect(plusPending.reason).toContain("40 commits this month");
  });

  test("tickets moving counts as momentum and reads as active", () => {
    const c = only(
      dash({
        projects: [
          project("hive", {
            ticketsTouched: 3,
            ticketCounts: { open: 3, inProgress: 1, closed: 0, byPriority: { 0: 0, 1: 0, 2: 3, 3: 0 } },
          }),
        ],
        memoryStats: [stat("hive")],
      }),
    );
    expect(c.verdict).toBe("active");
    expect(c.reason).toContain("3 tickets moving");
  });

  test("a big touched queue cannot run away with the score", () => {
    const c = only(
      dash({
        projects: [project("hive", { ticketsTouched: 40 })],
        memoryStats: [stat("hive")],
      }),
    );
    expect(c.score).toBe(2); // capped, not 40
  });

  test("pending work with nothing moving reads as waiting, not active", () => {
    const c = only(
      dash({
        projects: [
          project("hive", {
            ticketCounts: { open: 4, inProgress: 0, closed: 0, byPriority: { 0: 1, 1: 0, 2: 3, 3: 0 } },
          }),
        ],
        memoryStats: [stat("hive")],
        tickets: {
          ready: [],
          inProgress: [],
          blocked: [{ projectId: "hive" } as never, { projectId: "hive" } as never],
        },
      }),
    );
    expect(c.verdict).toBe("waiting");
    expect(c.reason).toContain("blocked, none moving");
  });

  test("a non-empty inbox asks for attention", () => {
    const data = dash({
      projects: [project("hive")],
      memoryStats: [stat("hive")],
      inboxes: [{ projectId: "hive", mtime: daysBefore(0), body: "note", isEmpty: false }],
    });
    const colony = only(data);
    expect(colony.verdict).toBe("needs-you");
    expect(colony.reason).toBe("inbox has findings");
  });

});

describe("what a quiet colony still says", () => {
  test("a cold store is reported even though it is not actionable", () => {
    const c = only(
      dash({
        projects: [project("hive")],
        memoryStats: [stat("hive", { newestAt: daysBefore(89) })],
      }),
    );
    expect(c.verdict).toBe("quiet");
    expect(c.reason).toBe("nothing learned in 89 days");
  });

  test("coldness is measured from the date under test, not the wall clock", () => {
    const fixture = { projects: [project("hive")], memoryStats: [stat("hive", { newestAt: daysBefore(5) })] };
    expect(only(dash(fixture)).reason).toBe("nothing pending");
    expect(only(dash({ ...fixture, today: "2026-10-14" })).reason).toContain("nothing learned in");
  });

  test("a deep store with a quiet week is not reported as starving", () => {
    const c = only(
      dash({
        projects: [project("hive")],
        recentMemory: [], // nothing in the 7-day display slice
        memoryStats: [stat("hive", { total: 300, newestAt: daysBefore(3) })],
      }),
    );
    expect(c.reason).toBe("nothing pending");
  });
});

describe("yard shape", () => {
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

  test("escalation leads, then momentum, then the quiet", () => {
    const data = dash({
      projects: [project("calm"), project("broken"), project("busy")],
      memoryStats: [stat("calm"), stat("broken"), stat("busy")],
      activity: [activity("busy", { commits: 9, monthCommits: 30 })],
      actWork: [actWork("broken", "failed")],
    });
    expect(sortYard(assignVerdicts(data)).map((c) => c.id)).toEqual(["broken", "busy", "calm"]);
  });

  test("needsAttention returns exactly the painted colonies", () => {
    const data = dash({
      projects: [project("calm"), project("broken")],
      memoryStats: [stat("calm"), stat("broken")],
      actWork: [actWork("broken", "failed")],
    });
    expect(needsAttention(assignVerdicts(data)).map((c) => c.id)).toEqual(["broken"]);
  });
});
