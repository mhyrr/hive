import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectBriefings,
  collectDashboardData,
  collectHealth,
  collectInboxes,
  collectProjects,
  collectRuns,
  collectTickets,
} from "../lib/dashboard/collect";
import { ensureHiveScaffold } from "../lib/paths";

// ---------------------------------------------------------------------------
// Fixture: a fake ~/.hive tree with two projects, a few tickets, briefings,
// inboxes, runs, and log lines. Exercises every collector.
// ---------------------------------------------------------------------------

async function buildFixture(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hive-dashboard-"));

  // Scaffold uses HIVE_HOME via env, so we pass the home explicitly.
  const paths = await ensureHiveScaffold(home);

  // --- project: alpha (1 open, 1 in_progress, 1 blocked) ---
  const alphaTickets = join(paths.projectsDir, "alpha", "tickets");
  await mkdir(alphaTickets, { recursive: true });
  await writeFile(
    join(paths.projectsDir, "alpha", "config.md"),
    "---\nname: alpha\npath: /tmp/fake/alpha\n---\n\n",
  );
  await writeFile(
    join(paths.projectsDir, "alpha", "inbox.md"),
    "# Inbox: alpha\n\n## 2026-04-17 — Heartbeat tick\n\nSome news.\n",
  );
  await writeFile(
    join(paths.projectsDir, "alpha", "heartbeat.json"),
    JSON.stringify({
      lastTick: "2026-04-17T08:00:00Z",
      tickCount: 42,
      lastResult: "ACTION_TAKEN",
      enabled: true,
    }),
  );

  await writeFile(
    join(alphaTickets, "TK-001.md"),
    "---\nid: TK-001\ntitle: Ready ticket\nstatus: open\ntype: task\npriority: 1\ntags: foo\ncreated: 2026-04-10T00:00:00Z\nupdated: 2026-04-10T00:00:00Z\n---\n\nBody\n",
  );
  await writeFile(
    join(alphaTickets, "TK-002.md"),
    "---\nid: TK-002\ntitle: In-flight ticket\nstatus: in_progress\ntype: feature\npriority: 2\ntags: \ncreated: 2026-04-12T00:00:00Z\nupdated: 2026-04-15T00:00:00Z\n---\n\nBody\n",
  );
  await writeFile(
    join(alphaTickets, "TK-003.md"),
    "---\nid: TK-003\ntitle: Blocked ticket\nstatus: open\ntype: task\npriority: 2\ntags: \ncreated: 2026-04-11T00:00:00Z\nupdated: 2026-04-11T00:00:00Z\ndepends: TK-001\n---\n\nBody\n",
  );

  // --- project: bravo (empty inbox, no tickets) ---
  await mkdir(join(paths.projectsDir, "bravo", "tickets"), { recursive: true });
  await writeFile(
    join(paths.projectsDir, "bravo", "config.md"),
    "---\nname: bravo\npath: /tmp/fake/bravo\n---\n\n",
  );
  await writeFile(join(paths.projectsDir, "bravo", "inbox.md"), "# Inbox: bravo\n\n");

  // --- briefings ---
  const briefingsDir = join(home, "briefings");
  await mkdir(briefingsDir, { recursive: true });
  await writeFile(
    join(briefingsDir, "2026-04-17.md"),
    "# Morning Briefing — 2026-04-17\n\nToday is a good day.\n",
  );
  await writeFile(
    join(briefingsDir, "2026-04-16.md"),
    "# Morning Briefing — 2026-04-16\n\nYesterday was fine.\n",
  );

  // --- runs ---
  const runsDir = join(home, "runs");
  await mkdir(runsDir, { recursive: true });

  const r1 = join(runsDir, "RUN-001");
  await mkdir(r1, { recursive: true });
  await writeFile(
    join(r1, "goal.md"),
    "# Goal\n\nProject: alpha\n\nImplement TK-001 — the first feature.\n",
  );
  await writeFile(join(r1, "status"), "complete\n");

  const r2 = join(runsDir, "RUN-002");
  await mkdir(r2, { recursive: true });
  await writeFile(
    join(r2, "goal.md"),
    "# Goal\n\nProject: bravo\n\nFix TK-999 — hypothetical bug.\n",
  );
  await writeFile(join(r2, "status"), "failed\n");

  // --- logs ---
  const logsDir = join(home, "logs");
  await mkdir(logsDir, { recursive: true });
  await writeFile(
    join(logsDir, "heartbeat.log"),
    "=== HIVE heartbeat: 2026-04-17T08:00:00Z ===\n=== HIVE heartbeat complete: 2026-04-17T08:00:01Z ===\n",
  );
  await writeFile(
    join(logsDir, "morning.log"),
    "=== HIVE morning: 2026-04-17 07:00:00 ===\n=== HIVE morning complete: 07:03:10 ===\n",
  );
  await writeFile(join(logsDir, "nightly.log"), "=== HIVE nightly complete: 2026-04-17T02:00:00Z ===\n");
  await writeFile(join(logsDir, "hive-sync.log"), "synced OK\n");

  return home;
}

describe("dashboard collectors", () => {
  let home: string;

  beforeEach(async () => {
    home = await buildFixture();
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("collectProjects enumerates every project with counts and path", async () => {
    const paths = await ensureHiveScaffold(home);
    const projects = await collectProjects(paths);

    expect(projects.length).toBe(2);

    const alpha = projects.find((p) => p.id === "alpha")!;
    expect(alpha).toBeDefined();
    expect(alpha.path).toBe("/tmp/fake/alpha");
    expect(alpha.lastHeartbeat).toBe("2026-04-17T08:00:00Z");
    expect(alpha.tickCount).toBe(42);
    expect(alpha.lastResult).toBe("ACTION_TAKEN");
    expect(alpha.ticketCounts.open).toBe(2);          // TK-001, TK-003
    expect(alpha.ticketCounts.inProgress).toBe(1);    // TK-002
    expect(alpha.ticketCounts.closed).toBe(0);
    // P1 count: TK-001. P2 count: TK-002, TK-003.
    expect(alpha.ticketCounts.byPriority[1]).toBe(1);
    expect(alpha.ticketCounts.byPriority[2]).toBe(2);

    const bravo = projects.find((p) => p.id === "bravo")!;
    expect(bravo.ticketCounts.open).toBe(0);
    expect(bravo.lastHeartbeat).toBeNull();
  });

  test("collectInboxes returns per-project content with isEmpty flag", async () => {
    const paths = await ensureHiveScaffold(home);
    const inboxes = await collectInboxes(paths);

    expect(inboxes.length).toBe(2);

    const alpha = inboxes.find((i) => i.projectId === "alpha")!;
    expect(alpha.isEmpty).toBe(false);
    expect(alpha.body).toContain("Heartbeat tick");
    // Header line "# Inbox: alpha" should be stripped.
    expect(alpha.body.split("\n")[0]).not.toMatch(/^#\s*Inbox/);

    const bravo = inboxes.find((i) => i.projectId === "bravo")!;
    expect(bravo.isEmpty).toBe(true);
  });

  test("collectTickets groups into ready / inProgress / blocked", async () => {
    const paths = await ensureHiveScaffold(home);
    const buckets = await collectTickets(paths);

    const readyIds = buckets.ready.map((t) => t.id);
    const progressIds = buckets.inProgress.map((t) => t.id);
    const blockedIds = buckets.blocked.map((t) => t.id);

    expect(readyIds).toContain("TK-001");
    expect(progressIds).toContain("TK-002");
    expect(blockedIds).toContain("TK-003");

    const blocked = buckets.blocked[0]!;
    expect(blocked.depends).toEqual(["TK-001"]);
    expect(blocked.projectId).toBe("alpha");
  });

  test("collectTickets omits closed tickets entirely", async () => {
    const paths = await ensureHiveScaffold(home);
    // Add a closed one in-place
    await writeFile(
      join(paths.projectsDir, "alpha", "tickets", "TK-004.md"),
      "---\nid: TK-004\ntitle: Closed ticket\nstatus: closed\ntype: task\npriority: 2\ntags: \ncreated: 2026-04-01T00:00:00Z\nupdated: 2026-04-02T00:00:00Z\nclosed: 2026-04-02T00:00:00Z\n---\n\n",
    );

    const buckets = await collectTickets(paths);
    const allIds = [...buckets.ready, ...buckets.inProgress, ...buckets.blocked].map((t) => t.id);
    expect(allIds).not.toContain("TK-004");
  });

  test("collectRuns extracts projectId and ticketId from goal.md", async () => {
    const paths = await ensureHiveScaffold(home);
    const runs = await collectRuns(paths);

    expect(runs.length).toBe(2);
    // Reversed: RUN-002 newest-first
    expect(runs[0]!.id).toBe("RUN-002");
    expect(runs[0]!.status).toBe("failed");
    expect(runs[0]!.projectId).toBe("bravo");
    expect(runs[0]!.ticketId).toBe("TK-999");

    expect(runs[1]!.id).toBe("RUN-001");
    expect(runs[1]!.status).toBe("complete");
    expect(runs[1]!.ticketId).toBe("TK-001");
    expect(runs[1]!.goalSnippet.length).toBeGreaterThan(0);
  });

  test("collectBriefings sorts newest-first and produces headlines", async () => {
    const paths = await ensureHiveScaffold(home);
    const briefings = await collectBriefings(paths);

    expect(briefings.length).toBe(2);
    expect(briefings[0]!.date).toBe("2026-04-17");
    expect(briefings[1]!.date).toBe("2026-04-16");
    expect(briefings[0]!.headline).toMatch(/Morning Briefing/);
  });

  test("collectHealth produces entries per log file", async () => {
    const paths = await ensureHiveScaffold(home);
    const health = await collectHealth(paths);

    const labels = health.map((h) => h.label);
    expect(labels).toEqual(["HEARTBEAT", "MORNING", "NIGHTLY", "SYNC"]);

    const heartbeat = health.find((h) => h.label === "HEARTBEAT")!;
    expect(heartbeat.lastLine).toContain("heartbeat complete");
    expect(heartbeat.mtime).not.toBeNull();

    // SYNC has no marker requirement — last line is just "synced OK"
    const sync = health.find((h) => h.label === "SYNC")!;
    expect(sync.lastLine).toContain("synced OK");
  });

  test("collectDashboardData composes everything and picks today's briefing", async () => {
    const paths = await ensureHiveScaffold(home);
    const data = await collectDashboardData(paths);

    expect(data.projects.length).toBe(2);
    expect(data.tickets.ready.length + data.tickets.inProgress.length + data.tickets.blocked.length).toBe(3);
    expect(data.runs.length).toBe(2);
    expect(data.briefings.length).toBe(2);
    expect(data.volumeNumber).toBe(2);
    expect(data.today).toBe("2026-04-17");
    expect(data.todayBriefing?.date).toBe("2026-04-17");
    expect(data.health.length).toBe(4);
    expect(data.inboxes.length).toBe(2);
  });

  test("collectDashboardData is resilient to an empty HIVE_HOME", async () => {
    const emptyHome = await mkdtemp(join(tmpdir(), "hive-empty-"));
    try {
      const paths = await ensureHiveScaffold(emptyHome);
      const data = await collectDashboardData(paths);
      expect(data.projects).toEqual([]);
      expect(data.briefings).toEqual([]);
      expect(data.runs).toEqual([]);
      expect(data.tickets.ready).toEqual([]);
      expect(data.inboxes).toEqual([]);
      expect(data.todayBriefing).toBeNull();
    } finally {
      await rm(emptyHome, { recursive: true, force: true });
    }
  });
});
