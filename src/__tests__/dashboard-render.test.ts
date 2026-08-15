import { describe, test, expect } from "bun:test";

import { renderDashboard } from "../lib/dashboard/render";
import type { DashboardData } from "../lib/dashboard/collect";

function baseData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generatedAt: "2026-04-17T12:34:56.000Z",
    volumeNumber: 16,
    today: "2026-04-17",
    recentMemory: [
      {
        projectId: "alpha",
        section: "fact",
        text: "The nightly verifier is the only path into knowledge.md.",
        tags: ["memory"],
        createdAt: "2026-04-16",
        lastRecalled: null,
        strength: 0.9,
      },
    ],
    openQuestions: [
      { projectId: "alpha", text: "Should open questions expire?", tags: ["memory"] },
    ],
    health: [
      { label: "HEARTBEAT", lastLine: "heartbeat complete", mtime: "2026-04-17T12:00:00Z" },
      { label: "MORNING", lastLine: "morning complete", mtime: "2026-04-17T07:03:00Z" },
      { label: "NIGHTLY", lastLine: "nightly complete", mtime: "2026-04-17T02:00:00Z" },
      { label: "SYNC", lastLine: "synced OK", mtime: "2026-04-17T11:00:00Z" },
    ],
    projects: [
      {
        id: "alpha",
        path: "/tmp/alpha",
        lastHeartbeat: "2026-04-17T08:00:00Z",
        tickCount: 42,
        lastResult: "ACTION_TAKEN",
        ticketCounts: {
          open: 2,
          inProgress: 1,
          closed: 3,
          byPriority: { 0: 0, 1: 1, 2: 2, 3: 0 },
        },
        inboxMtime: "2026-04-17T08:00:00Z",
      },
    ],
    inboxes: [
      { projectId: "alpha", mtime: "2026-04-17T08:00:00Z", body: "Some **news**.", isEmpty: false },
      { projectId: "bravo", mtime: null, body: "", isEmpty: true },
    ],
    tickets: {
      ready: [
        {
          id: "TK-001",
          title: "Ready ticket",
          projectId: "alpha",
          priority: 1,
          tags: ["foo"],
          depends: [],
          ageDays: 7,
        },
      ],
      inProgress: [
        {
          id: "TK-002",
          title: "In-flight ticket",
          projectId: "alpha",
          priority: 2,
          tags: [],
          depends: [],
          ageDays: 5,
        },
      ],
      blocked: [
        {
          id: "TK-003",
          title: "Blocked ticket",
          projectId: "alpha",
          priority: 2,
          tags: [],
          depends: ["TK-001"],
          ageDays: 6,
        },
      ],
    },
    runs: [
      {
        id: "RUN-002",
        status: "failed",
        durationMs: 60_000,
        startedAt: "2026-04-17T10:00:00Z",
        goalSnippet: "Fix some bug",
        projectId: "bravo",
        ticketId: "TK-999",
      },
      {
        id: "RUN-001",
        status: "complete",
        durationMs: 120_000,
        startedAt: "2026-04-17T09:00:00Z",
        goalSnippet: "Implement first feature",
        projectId: "alpha",
        ticketId: "TK-001",
      },
    ],
    briefings: [
      {
        date: "2026-04-17",
        body: "# Morning Briefing — 2026-04-17\n\nToday is a good day.",
        headline: "Morning Briefing",
      },
      {
        date: "2026-04-16",
        body: "# Morning Briefing — 2026-04-16\n\nYesterday was fine.",
        headline: "Morning Briefing",
      },
    ],
    todayBriefing: {
      date: "2026-04-17",
      body: "# Morning Briefing — 2026-04-17\n\nToday is a good day.",
      headline: "Morning Briefing",
    },
    ...overrides,
  };
}

describe("renderDashboard", () => {
  test("produces a full HTML document with head, body, and the yard head", () => {
    const html = renderDashboard(baseData());
    expect(html).toStartWith("<!doctype html>");
    expect(html).toContain("<title>HIVE");
    expect(html).toContain('<header class="yard-head">');
    expect(html).toContain("<h1>Hive</h1>");
  });

  test("carries its direction contract into the emitted markup", () => {
    // The contract has to survive into the built page or nobody can audit
    // the build against the direction it committed to.
    const html = renderDashboard(baseData());
    expect(html).toContain("THESIS:");
    expect(html).toContain("FIRST VIEWPORT:");
    expect(html).toContain("2570ec1e");
  });

  test("embeds CSS and JS inline and has no external references", () => {
    const html = renderDashboard(baseData());
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
    expect(html).not.toContain("<link");
    expect(html).not.toContain('href="http');
    expect(html).not.toContain('src="http');
    expect(html).not.toContain("googleapis");
    expect(html).not.toContain("fonts.googleapis");
    expect(html).not.toContain("cdn.");
  });

  test("the briefing band carries today only; past days live in the archive", () => {
    const html = renderDashboard(baseData());
    expect(html).toContain('id="section-briefing"');
    expect(html).toContain("April 17, 2026");
    // The old every-day-stacked article list is gone.
    expect(html).not.toContain('data-briefing-date="2026-04-16"');
  });

  test("renders every project as a colony in the yard", () => {
    const html = renderDashboard(baseData());
    expect(html).toContain('<section class="yard"');
    expect(html).toContain('data-project="alpha"');
    // Figures use HIVE's vocabulary, not the apiary's.
    expect(html).toContain("tickets <b>");
    expect(html).toContain("memory <b>");
    expect(html).not.toContain("brood <b>");
  });

  test("tickets are a per-project shortlist, with the full board one click away", () => {
    const html = renderDashboard(baseData());
    expect(html).toContain("TK-001");
    expect(html).toContain("TK-002");
    expect(html).toContain("TK-003");
    expect(html).toContain("3 active");
    expect(html).toContain('href="/tickets"');
  });

  test("a long queue is capped per project and says how much it withheld", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      id: `TK-1${String(i).padStart(2, "0")}`,
      title: `ticket ${i}`,
      projectId: "alpha",
      priority: 2 as const,
      tags: [],
      depends: [],
      ageDays: i,
      updatedDays: i,
    }));
    const html = renderDashboard(baseData({ tickets: { ready: many, inProgress: [], blocked: [] } }));
    expect(html).toContain("4 more"); // 9 - 5 shown
    expect(html).toContain('href="/tickets#project=alpha"');
  });

  test("the shortlist keeps its controls rather than shipping a read-only list", () => {
    const html = renderDashboard(baseData());
    expect(html).toContain('data-action="ticket-start"');
    expect(html).toContain('data-action="ticket-close"');
  });

  test("the page carries only the sections worth a morning read", () => {
    const html = renderDashboard(baseData());
    for (const id of ["yard", "briefing", "stores", "upkeep"]) {
      expect(html).toContain(`id="section-${id}"`);
    }
    // Cut deliberately: dispatch (TK-143) and the inbox (TK-144) are dead or
    // lying, and neither earns a place on the page while that is true.
    expect(html).not.toContain("Dispatch Log");
    expect(html).not.toContain('class="inbox-entry');
  });

  test("renders archive cards and marks today's card active", () => {
    const html = renderDashboard(baseData());
    expect(html).toContain("The Archive");
    expect(html).toContain('data-archive-card="2026-04-17"');
    expect(html).toContain('data-archive-card="2026-04-16"');
    expect(html).toMatch(/archive-card active"[^>]*data-archive-card="2026-04-17"/);
  });

  test("upkeep lists all four health labels", () => {
    const html = renderDashboard(baseData());
    expect(html).toContain("HEARTBEAT");
    expect(html).toContain("MORNING");
    expect(html).toContain("NIGHTLY");
    expect(html).toContain("SYNC");
  });

  test("stores merges recent memory, open questions, and promotion candidates", () => {
    const html = renderDashboard(baseData());
    expect(html).toContain('id="section-stores"');
    expect(html).toContain("Lately admitted");
    // Three views of one store, in one place rather than three sections.
    expect(html).not.toContain('id="section-openquestions"');
    expect(html).not.toContain('id="section-memory"');
  });

  test("inspection number and dateline land in the yard head", () => {
    const html = renderDashboard(baseData());
    expect(html).toContain("Inspection 16");
    expect(html).toContain("April 17, 2026");
  });

  test("gracefully handles the no-data case", () => {
    const data = baseData({
      briefings: [],
      todayBriefing: null,
      projects: [],
      inboxes: [],
      tickets: { ready: [], inProgress: [], blocked: [] },
      runs: [],
      volumeNumber: 0,
    });
    const html = renderDashboard(data);
    expect(html).toStartWith("<!doctype html>");
    // A fresh install should say what to do, not render empty furniture.
    expect(html).toContain("No colonies registered");
    expect(html).toContain("hive project add");
  });

  test("escapes HTML in ticket titles", () => {
    const data = baseData({
      tickets: {
        ready: [
          {
            id: "TK-042",
            title: "<script>alert(1)</script>",
            projectId: "alpha",
            priority: 2,
            tags: [],
            depends: [],
            ageDays: 0,
          },
        ],
        inProgress: [],
        blocked: [],
      },
    });
    const html = renderDashboard(data);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
