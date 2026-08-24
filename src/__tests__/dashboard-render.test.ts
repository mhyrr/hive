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
      { label: "WATCHES", lastLine: "observe: no-delta", mtime: "2026-04-17T07:03:00Z" },
      { label: "NIGHTLY", lastLine: "nightly complete", mtime: "2026-04-17T02:00:00Z" },
      { label: "SYNC", lastLine: "synced OK", mtime: "2026-04-17T11:00:00Z" },
    ],
    projects: [
      {
        id: "alpha",
        path: "/tmp/alpha",
        ticketCounts: {
          open: 2,
          inProgress: 1,
          closed: 3,
          byPriority: { 0: 0, 1: 1, 2: 2, 3: 0 },
        },
        ticketsTouched: 1,
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
    actWork: [],
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

  test("folds the dated Observe artifact into the same briefing", () => {
    const data = baseData();
    data.briefings[0]!.observe = "A connection across [two projects](#).";
    data.todayBriefing!.observe = data.briefings[0]!.observe;
    const html = renderDashboard(data);
    expect(html).toContain("<h3>Observe</h3>");
    expect(html).toContain("A connection across");
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
    // Generic execution history and the inbox band stay off the morning page;
    // repaired inbox attention is carried by the yard instead.
    expect(html).not.toContain("Dispatch Log");
    expect(html).not.toContain('class="inbox-entry');
  });

  test("renders archive cards and marks today's card active", () => {
    const html = renderDashboard(baseData());
    expect(html).toContain("Archive");
    expect(html).toContain('data-archive-card="2026-04-17"');
    expect(html).toContain('data-archive-card="2026-04-16"');
    expect(html).toMatch(/archive-card active"[^>]*data-archive-card="2026-04-17"/);
  });

  test("upkeep lists the three scheduled health labels", () => {
    const html = renderDashboard(baseData());
    expect(html).toContain("WATCHES");
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
      actWork: [],
      volumeNumber: 0,
    });
    const html = renderDashboard(data);
    expect(html).toStartWith("<!doctype html>");
    // A fresh install should say what to do, not render empty furniture.
    expect(html).toContain("No colonies registered");
    expect(html).toContain("hive project add");
  });

  test("every in-page jump link lands on a section the page actually renders", () => {
    // The condense pass cut four sections and left their links in the nav, so
    // five of seven jumps went nowhere. Enumerate, don't assume.
    for (const data of [baseData(), baseData({ todayBriefing: null, briefings: [], activity: [] })]) {
      const html = renderDashboard(data);
      const anchors = [...html.matchAll(/<a href="#(section-[a-z-]+)">/g)].map((m) => m[1]!);
      expect(anchors.length).toBeGreaterThan(0);
      for (const id of anchors) expect(html).toContain(`id="${id}"`);
    }
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

// The direction contract promises a first viewport of one sentence counting
// the colonies that want you, with the hives beneath it. The build shipped a
// commit count in that slot and the work band in between; the finish review
// caught it. These pin the shape.
describe("first viewport — the answer, then the hives", () => {
  test("the page's largest sentence counts the colonies that want you", () => {
    const html = renderDashboard(baseData());
    const call = html.match(/<div class="yard-call">([\s\S]*?)<\/div>/)![1]!;
    expect(call).toMatch(/need(s)? you today/);
    expect(call).toContain('<span class="count">');
    // Activity is not a verdict, and it used to hold this slot.
    expect(call).not.toContain("Work landed");
  });

  test("a quiet apiary says so rather than counting to zero", () => {
    const html = renderDashboard(baseData({ projects: [], briefings: [], todayBriefing: null }));
    expect(html).toContain("No colonies in the yard");
  });

  test("nothing stands between the sentence and the yard", () => {
    const html = renderDashboard(
      baseData({
        activity: [
          { projectId: "alpha", commits: 2, insertions: 8, deletions: 1, filesChanged: 2, subjects: ["a thing"] },
        ],
      }),
    );
    expect(html.indexOf('class="yard-call"')).toBeLessThan(html.indexOf('id="section-yard"'));
    expect(html.indexOf('id="section-yard"')).toBeLessThan(html.indexOf('id="section-work"'));
  });

  test("every section carries a heading and an accessible name", () => {
    const html = renderDashboard(baseData());
    for (const id of ["yard", "briefing", "tickets", "stores", "archive", "upkeep"]) {
      expect(html).toContain(`aria-labelledby="${id}-label"`);
      expect(html).toContain(`<h2 id="${id}-label">`);
    }
  });

  test("the briefing leads with its lede, not with the word Headline", () => {
    const html = renderDashboard(
      baseData({
        todayBriefing: {
          date: "2026-04-17",
          body: "# HIVE\n\n## Headline\nOne sentence that mattered.\n",
          headline: "One sentence",
        },
      }),
    );
    expect(html).toContain("One sentence that mattered.");
    expect(html).not.toContain("<h2>Headline</h2>");
  });
});

// The project filter hides `[data-project]` and nothing else, so every surface
// that speaks about one project has to say so in the markup. This has now been
// missed twice — once when the filter shipped, once when the redesign rebuilt
// the briefing band — which is what these tests are for.
describe("project filter — the surfaces it has to reach", () => {
  const briefed = (overrides: Partial<DashboardData> = {}) =>
    baseData({
      projects: [
        { ...baseData().projects[0]!, id: "alpha" },
        { ...baseData().projects[0]!, id: "bravo" },
      ],
      activity: [
        { projectId: "alpha", commits: 3, insertions: 90, deletions: 4, filesChanged: 6, subjects: ["did a thing"] },
        { projectId: "bravo", commits: 1, insertions: 5, deletions: 0, filesChanged: 1, subjects: ["did another"] },
      ],
      todayBriefing: {
        date: "2026-04-17",
        body: [
          "# HIVE — 2026-04-17",
          "",
          "## Headline",
          "A quiet night.",
          "",
          "## Per project",
          "### alpha",
          "- alpha shipped something",
          "### bravo",
          "- bravo shipped something",
          "",
          "## What needs your attention",
          "- **alpha — the thing.** Decide about it.",
          "- **bravo** — the other thing.",
          "- **Something else entirely.** Mentions alpha in passing.",
        ].join("\n"),
        headline: "A quiet night",
      },
      ...overrides,
    });

  test("per-project briefing subsections are tagged and flow as one run", () => {
    const html = renderDashboard(briefed());
    expect(html).toContain('<section class="briefing-project-section" data-project="alpha">');
    expect(html).toContain('<section class="briefing-project-section" data-project="bravo">');
    // Adjacent colonies share one column run; separate runs would hole out.
    expect(html).toMatch(/<div class="briefing-colonies">[\s\S]*bravo[\s\S]*?<\/div>/);
  });

  test("project-led bullets are tagged; a passing mention is not", () => {
    const html = renderDashboard(briefed());
    expect(html).toContain('<li data-project="alpha"><strong>alpha — the thing.</strong>');
    expect(html).toContain('<li data-project="bravo"><strong>bravo</strong>');
    // Guessing from prose is worse than covering less: this one stays untagged.
    expect(html).toContain("<li><strong>Something else entirely.</strong>");
  });

  test("the work band says which colony each row belongs to", () => {
    const html = renderDashboard(briefed());
    expect(html).toMatch(/<li class="work-item"[^>]*data-project="alpha"/);
    expect(html).toMatch(/<li class="work-item"[^>]*data-project="bravo"/);
  });

  test("a project-scoped watch is filterable; a fleet-wide one is not", () => {
    const card = {
      at: "2026-04-17T06:00:00Z",
      outcome: "surfaced",
      model: "opus",
      durationMs: 1000,
      error: null,
      quiet: false,
      dropped: false,
      logPath: "/tmp/log",
    };
    const watches = {
      generatedAt: "2026-04-17T07:00:00Z",
      ceiling: "propose",
      lastTick: "2026-04-17T06:00:00Z",
      tickStale: false,
      rows: [{ qualifiedName: "propose" }, { qualifiedName: "alpha/drift" }],
      latest: [
        { ...card, watch: "alpha/drift", output: "alpha is drifting" },
        { ...card, watch: "propose", output: "a fleet-wide thought" },
      ],
      artifacts: [],
      warnings: [],
    } as unknown as DashboardData["watches"];
    const html = renderDashboard(briefed({ watches }));
    expect(html).toContain('<li class="watch-card" data-project="alpha">');
    // A standing question about the whole apiary belongs to no colony, and
    // hiding it under a filter would claim it did.
    expect(html).toContain('<li class="watch-card">');
  });
});
