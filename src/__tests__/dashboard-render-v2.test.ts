import { describe, test, expect } from "bun:test";

import {
  renderDashboard,
  renderStickyNav,
  renderTopThree,
  selectTopThree,
  renderProjects,
  renderTickets,
  renderInboxes,
  renderRuns,
} from "../lib/dashboard/render";
import type { DashboardData } from "../lib/dashboard/collect";

function baseData(overrides: Partial<DashboardData> = {}): DashboardData {
  return {
    generatedAt: "2026-04-17T12:00:00Z",
    volumeNumber: 16,
    today: "2026-04-17",
    health: [],
    projects: [
      {
        id: "alpha",
        path: "/tmp/alpha",
        lastHeartbeat: "2026-04-17T08:00:00Z",
        tickCount: 10,
        lastResult: "ACTION_TAKEN",
        ticketCounts: {
          open: 2, inProgress: 1, closed: 0,
          byPriority: { 0: 1, 1: 1, 2: 1, 3: 0 },
        },
        inboxMtime: "2026-04-17T08:00:00Z",
      },
      {
        id: "beta",
        path: null,
        lastHeartbeat: null,
        tickCount: 0,
        lastResult: null,
        ticketCounts: {
          open: 0, inProgress: 0, closed: 0,
          byPriority: { 0: 0, 1: 0, 2: 0, 3: 0 },
        },
        inboxMtime: null,
      },
    ],
    inboxes: [
      { projectId: "alpha", mtime: "2026-04-17T08:00:00Z", body: "News", isEmpty: false },
    ],
    tickets: {
      ready: [{ id: "TK-001", title: "ready", projectId: "alpha", priority: 1, tags: [], depends: [], ageDays: 1 }],
      inProgress: [{ id: "TK-002", title: "wip", projectId: "alpha", priority: 2, tags: [], depends: [], ageDays: 1 }],
      blocked: [{ id: "TK-003", title: "blocked", projectId: "beta", priority: 0, tags: [], depends: ["TK-001"], ageDays: 1 }],
    },
    runs: [
      {
        id: "RUN-001", status: "running", durationMs: null, startedAt: "2026-04-17T09:00:00Z",
        goalSnippet: "running one", projectId: "alpha", ticketId: "TK-002",
      },
      {
        id: "RUN-002", status: "failed", durationMs: 1000, startedAt: "2026-04-17T08:00:00Z",
        goalSnippet: "failed one", projectId: null, ticketId: null,
      },
    ],
    briefings: [
      {
        date: "2026-04-17",
        body: "# Briefing\n\n## Top Three\n\n- first thing\n- second thing\n- third thing\n\n## Rest\n\nother stuff",
        headline: "Briefing",
      },
    ],
    todayBriefing: {
      date: "2026-04-17",
      body: "# Briefing\n\n## Top Three\n\n- first thing\n- second thing\n- third thing\n\n## Rest\n\nother stuff",
      headline: "Briefing",
    },
    ...overrides,
  };
}

describe("Sticky nav", () => {
  test("renders jump links, ALL pill + one pill per project in interactive mode", () => {
    const html = renderStickyNav(baseData(), { interactive: true });
    expect(html).toContain('class="sticky-nav"');
    expect(html).toContain('href="#section-briefing"');
    // Tickets is now its own page (TK-036 dashboard tickets-page redesign).
    expect(html).toContain('href="/tickets"');
    expect(html).toContain('href="#section-archive"');
    expect(html).toContain('data-project-filter="ALL"');
    expect(html).toContain('data-project-filter="alpha"');
    expect(html).toContain('data-project-filter="beta"');
    expect(html).toContain("pill--active");
    expect(html).toContain("needs-action-toggle");
    expect(html).toContain('id="filter-banner"');
  });

  test("omits entirely in non-interactive mode", () => {
    const html = renderStickyNav(baseData(), { interactive: false });
    expect(html).toBe("");
  });

  test("renders nav + jump links without pills when there are no projects", () => {
    const html = renderStickyNav(baseData({ projects: [] }), { interactive: true });
    expect(html).toContain('class="sticky-nav"');
    expect(html).toContain('href="#section-briefing"');
    expect(html).not.toContain("data-project-filter");
    expect(html).not.toContain("needs-action-toggle");
  });
});

describe("Today's Three Things", () => {
  test("prefers explicit ## Top Three section", () => {
    const sel = selectTopThree(baseData());
    expect(sel.items).toEqual(["first thing", "second thing", "third thing"]);
    expect(sel.sourceLabel).toBe("from briefing");
  });

  test("falls back to Priorities bullets when no Top Three", () => {
    const data = baseData({
      todayBriefing: {
        date: "2026-04-17",
        body: "# Briefing\n\n## Priorities\n\n- ship TK-044\n- fix TK-039\n- watchdog\n- demo-prep",
        headline: "Briefing",
      },
    });
    const sel = selectTopThree(data);
    expect(sel.items).toEqual(["ship TK-044", "fix TK-039", "watchdog"]);
    expect(sel.sourceLabel).toBe("from briefing priorities");
  });

  test("falls back to high-priority tickets when briefing has nothing", () => {
    const data = baseData({
      todayBriefing: {
        date: "2026-04-17",
        body: "# Briefing\n\nall-prose, no bullets",
        headline: "Briefing",
      },
    });
    const sel = selectTopThree(data);
    expect(sel.sourceLabel).toBe("auto-selected");
    // Blocked TK-003 is P0, ready TK-001 is P1 — TK-002 is P2 so excluded.
    expect(sel.items.map((s) => s.slice(0, 8))).toEqual(
      expect.arrayContaining(["**TK-003", "**TK-001"]),
    );
  });

  test("renderTopThree emits a card with the chosen source label", () => {
    const html = renderTopThree(baseData());
    expect(html).toContain("Today&rsquo;s Three Things");
    expect(html).toContain("from briefing");
    expect(html).toContain("first thing");
    expect(html).toContain("third thing");
  });

  test("renderTopThree returns empty string when no items", () => {
    const data = baseData({
      todayBriefing: null,
      tickets: { ready: [], inProgress: [], blocked: [] },
    });
    expect(renderTopThree(data)).toBe("");
  });
});

describe("Projects at a Glance — ledger only", () => {
  test("renders the summary table without per-project expandables", () => {
    const html = renderProjects(baseData(), { interactive: true });
    expect(html).toContain('<tr data-project="alpha">');
    expect(html).toContain('<tr data-project="beta">');
    expect(html).not.toContain("per-project-section");
    expect(html).not.toContain("project-details");
  });
});

describe("Tickets — action buttons + data-project", () => {
  test("interactive ticket rows include action buttons", () => {
    const html = renderTickets(baseData().tickets, { interactive: true });
    expect(html).toContain('data-action="ticket-start"');
    expect(html).toContain('data-action="ticket-close"');
    expect(html).toContain('data-action="ticket-dispatch-run"');
    expect(html).toContain('data-action="ticket-note"');
    expect(html).toContain('data-confirm="true"'); // close is destructive
    expect(html).toContain('data-project="alpha"');
    expect(html).toContain('data-project="beta"');
  });

  test("frozen ticket rows have no action buttons", () => {
    const html = renderTickets(baseData().tickets, { interactive: false });
    expect(html).not.toContain('data-action="ticket-start"');
    expect(html).not.toContain('<button');
  });
});

describe("Inbox entries — data-project + actions", () => {
  test("non-empty inbox entries expose promote/dispatch/ack", () => {
    const html = renderInboxes(baseData().inboxes, { interactive: true });
    expect(html).toContain('data-action="inbox-promote"');
    expect(html).toContain('data-action="inbox-dispatch"');
    expect(html).toContain('data-action="inbox-ack"');
    expect(html).toContain('data-project="alpha"');
  });
});

describe("Dispatch log — kill + override actions", () => {
  test("running run has kill button; all runs have override", () => {
    const html = renderRuns(baseData().runs, { interactive: true });
    expect(html).toContain('data-action="dispatch-kill"');
    expect(html).toContain('data-run-id="RUN-001"');
    // failed run shouldn't have kill
    expect(html).not.toMatch(/data-run-id="RUN-002"[^>]*>[\s\S]*?data-action="dispatch-kill"/);
    expect(html).toContain('data-action="dispatch-override"');
  });
});

describe("Archive — server links vs frozen links", () => {
  test("interactive archive links point at /archive/:date", () => {
    const html = renderDashboard(baseData(), { interactive: true });
    expect(html).toContain('href="/archive/2026-04-17"');
  });

  test("frozen archive links are inert (#)", () => {
    const html = renderDashboard(baseData(), { interactive: false });
    expect(html).toContain('href="#"');
    expect(html).not.toContain('href="/archive/');
  });
});

describe("Snackbar", () => {
  test("renders in interactive mode only", () => {
    expect(renderDashboard(baseData(), { interactive: true })).toContain('id="snackbar"');
    expect(renderDashboard(baseData(), { interactive: false })).not.toContain('id="snackbar"');
  });
});
