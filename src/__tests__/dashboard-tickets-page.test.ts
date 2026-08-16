import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { createTicket, updateTicket } from "../lib/ticket";
import { collectTicketsPage } from "../lib/dashboard/collect";
import { renderTicketsPage, renderTicketsPageDocument } from "../lib/dashboard/render";

let paths: HivePaths;

async function registerProject(name: string): Promise<void> {
  const dir = join(paths.projectsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "config.md"),
    `---\nname: ${name}\npath: /tmp/${name}\n---\n`,
  );
}

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-tickets-page-"));
  paths = await ensureHiveScaffold(home);
});
describe("collectTicketsPage", () => {
  test("groups children under their parent epic", async () => {
    await registerProject("alpha");

    const epic = await createTicket(paths, "alpha", {
      title: "Build auth",
      type: "epic",
      priority: 1,
      tags: ["auth"],
    });
    const c1 = await createTicket(paths, "alpha", {
      title: "Session model",
      type: "task",
      priority: 1,
      tags: ["auth"],
      parentEpic: epic.id,
    });
    const c2 = await createTicket(paths, "alpha", {
      title: "Login endpoint",
      type: "feature",
      priority: 1,
      tags: ["auth"],
      depends: [c1.id],
      parentEpic: epic.id,
    });

    const data = await collectTicketsPage(paths);
    expect(data.epics).toHaveLength(1);
    const board = data.epics[0]!;
    expect(board.epic.id).toBe(epic.id);
    expect(board.childCount).toBe(2);
    expect(board.buckets.ready.map((c) => c.id)).toEqual([c1.id]);
    expect(board.buckets.blocked.map((c) => c.id)).toEqual([c2.id]);
  });

  test("standalone tickets land in the standalone block", async () => {
    await registerProject("alpha");
    await createTicket(paths, "alpha", {
      title: "Lone task",
      type: "task",
      priority: 2,
    });
    const data = await collectTicketsPage(paths);
    expect(data.epics).toHaveLength(0);
    expect(data.standalone.ready).toHaveLength(1);
    expect(data.standalone.ready[0]?.title).toBe("Lone task");
  });

  test("in_progress children land in the InProgress column", async () => {
    await registerProject("alpha");
    const epic = await createTicket(paths, "alpha", {
      title: "Epic",
      type: "epic",
    });
    const child = await createTicket(paths, "alpha", {
      title: "Child",
      type: "task",
      parentEpic: epic.id,
    });
    await updateTicket(paths, "alpha", child.id, { status: "in_progress" });

    const data = await collectTicketsPage(paths);
    expect(data.epics[0]?.buckets.inProgress).toHaveLength(1);
    expect(data.epics[0]?.buckets.ready).toHaveLength(0);
  });

  test("closed children are excluded; epic with all-closed children disappears", async () => {
    await registerProject("alpha");
    const epic = await createTicket(paths, "alpha", {
      title: "Epic",
      type: "epic",
    });
    const child = await createTicket(paths, "alpha", {
      title: "Child",
      type: "task",
      parentEpic: epic.id,
    });
    await updateTicket(paths, "alpha", child.id, { status: "closed" });
    await updateTicket(paths, "alpha", epic.id, { status: "closed" });

    const data = await collectTicketsPage(paths);
    expect(data.epics).toHaveLength(0);
    expect(data.totalActive).toBe(0);
  });

  test("epics sort by lastActivity desc", async () => {
    await registerProject("alpha");

    // Two epics; the second epic's child gets touched last, so it should sort first.
    const e1 = await createTicket(paths, "alpha", { title: "E1", type: "epic" });
    const c1 = await createTicket(paths, "alpha", {
      title: "E1 child",
      type: "task",
      parentEpic: e1.id,
    });

    // Sleep a hair so the timestamps differ. ISO comparison falls through fine.
    await new Promise((r) => setTimeout(r, 5));

    const e2 = await createTicket(paths, "alpha", { title: "E2", type: "epic" });
    const c2 = await createTicket(paths, "alpha", {
      title: "E2 child",
      type: "task",
      parentEpic: e2.id,
    });

    // Update e1's child so e1 wins on activity.
    await new Promise((r) => setTimeout(r, 5));
    await updateTicket(paths, "alpha", c1.id, { status: "in_progress" });

    const data = await collectTicketsPage(paths);
    expect(data.epics.map((e) => e.epic.id)).toEqual([e1.id, e2.id]);
  });

  test("cross-project: tickets stay scoped to their project", async () => {
    await registerProject("alpha");
    await registerProject("bravo");

    const epicA = await createTicket(paths, "alpha", { title: "A epic", type: "epic" });
    await createTicket(paths, "alpha", {
      title: "A child",
      type: "task",
      parentEpic: epicA.id,
    });
    await createTicket(paths, "bravo", { title: "B standalone", type: "task" });

    const data = await collectTicketsPage(paths);
    expect(data.epics).toHaveLength(1);
    expect(data.epics[0]?.epic.projectId).toBe("alpha");
    expect(data.standalone.ready[0]?.projectId).toBe("bravo");
    expect(data.projectCount).toBe(2);
  });

  test("totals: sum of standalone + per-epic active counts", async () => {
    await registerProject("alpha");
    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    await createTicket(paths, "alpha", { title: "c1", type: "task", parentEpic: epic.id });
    await createTicket(paths, "alpha", { title: "c2", type: "task", parentEpic: epic.id });
    await createTicket(paths, "alpha", { title: "lone", type: "task" });

    const data = await collectTicketsPage(paths);
    expect(data.totalActive).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// renderTicketsPage / renderTicketsPageDocument — structural assertions
// ---------------------------------------------------------------------------

const ctx = { interactive: true };

describe("renderTicketsPage", () => {
  test("empty state when no active tickets", async () => {
    await registerProject("alpha");
    const data = await collectTicketsPage(paths);
    const html = renderTicketsPage(data, ctx);
    expect(html).toContain("Clean desk");
    expect(html).toContain("No active tickets across any project.");
  });

  test("renders one epic-board per epic with kanban columns", async () => {
    await registerProject("alpha");
    const epic = await createTicket(paths, "alpha", {
      title: "Build auth",
      type: "epic",
      priority: 1,
      tags: ["auth"],
    });
    const c1 = await createTicket(paths, "alpha", {
      title: "Session model",
      type: "task",
      priority: 1,
      parentEpic: epic.id,
    });
    await createTicket(paths, "alpha", {
      title: "Login endpoint",
      type: "feature",
      priority: 1,
      depends: [c1.id],
      parentEpic: epic.id,
    });
    const data = await collectTicketsPage(paths);
    const html = renderTicketsPage(data, ctx);

    expect(html).toContain('class="epic-board"');
    expect(html).toContain(epic.id);
    expect(html).toContain("Build auth");
    expect(html).toContain("Session model");
    expect(html).toContain("Login endpoint");
    expect(html).toContain('class="kanban"');
    expect(html).toContain('class="kanban-col-head ready"');
    expect(html).toContain('class="kanban-col-head progress"');
    expect(html).toContain('class="kanban-col-head blocked"');
  });

  test("blocked cards show ↳ TK-X annotation, ready cards do not", async () => {
    await registerProject("alpha");
    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    const c1 = await createTicket(paths, "alpha", {
      title: "first",
      type: "task",
      parentEpic: epic.id,
    });
    await createTicket(paths, "alpha", {
      title: "second",
      type: "task",
      depends: [c1.id],
      parentEpic: epic.id,
    });

    const data = await collectTicketsPage(paths);
    const html = renderTicketsPage(data, ctx);
    expect(html).toContain("blocked-by");
    expect(html).toContain(c1.id); // referenced from the blocked card
    // Ready card (c1) shouldn't have a blocked-by line itself.
    const readyMatch = html.match(/<article class="ticket-card"[^>]*data-ticket-id="TK-002"[\s\S]*?<\/article>/);
    expect(readyMatch?.[0]).not.toContain("blocked-by");
  });

  test("standalone block renders only when non-empty", async () => {
    await registerProject("alpha");
    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    await createTicket(paths, "alpha", { title: "c1", type: "task", parentEpic: epic.id });

    const data = await collectTicketsPage(paths);
    const html = renderTicketsPage(data, ctx);
    expect(html).not.toContain("standalone-board");
  });
});

describe("renderTicketsPageDocument", () => {
  test("emits a full HTML document with TICKETS active in nav", async () => {
    await registerProject("alpha");
    await createTicket(paths, "alpha", { title: "lone", type: "task" });
    const data = await collectTicketsPage(paths);
    const html = renderTicketsPageDocument(data);

    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>HIVE · Tickets");
    expect(html).toContain('class="page-nav"');
    expect(html).toContain('<a href="/tickets" class="nav-active">TICKETS</a>');
    expect(html).toContain('<a href="/">BRIEFING</a>');
  });

  test("renders a project filter bar with ALL + one pill per project, ALL active", async () => {
    await registerProject("alpha");
    await registerProject("bravo");
    await createTicket(paths, "alpha", { title: "a1", type: "task" });
    await createTicket(paths, "bravo", { title: "b1", type: "task" });

    const data = await collectTicketsPage(paths);
    expect(data.projectIds).toEqual(["alpha", "bravo"]);

    const html = renderTicketsPageDocument(data, { interactive: true });
    expect(html).toContain('class="tickets-filter-bar"');
    expect(html).toContain('<button type="button" class="pill pill--active" data-project-filter="ALL">ALL</button>');
    expect(html).toContain('data-project-filter="alpha"');
    expect(html).toContain('data-project-filter="bravo"');
    expect(html).toContain('id="filter-banner"');
  });

  test("filter bar is omitted in non-interactive mode", async () => {
    await registerProject("alpha");
    await createTicket(paths, "alpha", { title: "lone", type: "task" });
    const data = await collectTicketsPage(paths);
    const html = renderTicketsPageDocument(data, { interactive: false });
    expect(html).not.toContain('class="tickets-filter-bar"');
    expect(html).not.toContain("data-project-filter");
  });

  test("filter bar is omitted when no projects have tickets", async () => {
    const data = await collectTicketsPage(paths);
    expect(data.projectIds).toEqual([]);
    const html = renderTicketsPageDocument(data, { interactive: true });
    expect(html).not.toContain('class="tickets-filter-bar"');
  });
});
