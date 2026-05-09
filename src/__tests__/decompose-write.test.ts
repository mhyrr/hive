import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { listTickets, readTicket } from "../lib/ticket";
import {
  renderWriteResult,
  topologicalOrder,
  writeProposal,
} from "../lib/decompose-write";
import type { Proposal } from "../lib/decompose";

// ---------------------------------------------------------------------------
// topologicalOrder — pure
// ---------------------------------------------------------------------------

describe("topologicalOrder", () => {
  test("respects deps", () => {
    const proposal: Proposal = {
      epic: { title: "X", body: "", tags: [] },
      children: [
        { ref: "C2", title: "B", body: "", type: "task", tags: [], depends: ["C1"] },
        { ref: "C1", title: "A", body: "", type: "task", tags: [], depends: [] },
        { ref: "C3", title: "C", body: "", type: "task", tags: [], depends: ["C2"] },
      ],
    };
    expect(topologicalOrder(proposal)).toEqual(["C1", "C2", "C3"]);
  });

  test("independent branches dispatch in declaration order", () => {
    const proposal: Proposal = {
      epic: { title: "X", body: "", tags: [] },
      children: [
        { ref: "A", title: "A", body: "", type: "task", tags: [], depends: [] },
        { ref: "B", title: "B", body: "", type: "task", tags: [], depends: [] },
        { ref: "C", title: "C", body: "", type: "task", tags: [], depends: ["A", "B"] },
      ],
    };
    expect(topologicalOrder(proposal)).toEqual(["A", "B", "C"]);
  });
});

// ---------------------------------------------------------------------------
// writeProposal — dry run (pure, no FS)
// ---------------------------------------------------------------------------

describe("writeProposal — dry run", () => {
  test("emits synthetic IDs and edges for an epic + 3 children", async () => {
    const proposal: Proposal = {
      epic: { title: "Build auth", body: "## Goal\n…", tags: ["auth"] },
      children: [
        { ref: "C1", title: "model", body: "", type: "task", tags: [], depends: [] },
        { ref: "C2", title: "ep", body: "", type: "feature", tags: [], depends: ["C1"] },
        { ref: "C3", title: "ui", body: "", type: "feature", tags: [], depends: ["C2"] },
      ],
    };
    const fakePaths = {} as HivePaths;
    const result = await writeProposal(fakePaths, "hive", proposal, { dryRun: true });

    expect(result.shape).toBe("epic-with-children");
    expect(result.epicId).toMatch(/^TK-DRY-/);
    expect(result.childIds).toHaveLength(3);
    expect(result.edges).toHaveLength(2);
    // Edges are real-id pairs, not placeholders.
    for (const e of result.edges) {
      expect(e.from).toMatch(/^TK-DRY-/);
      expect(e.to).toMatch(/^TK-DRY-/);
    }
  });

  test("single-child shape skips epic", async () => {
    const proposal: Proposal = {
      epic: { title: "X", body: "", tags: [] },
      children: [
        { ref: "C1", title: "only", body: "", type: "task", tags: [], depends: [] },
      ],
    };
    const result = await writeProposal({} as HivePaths, "hive", proposal, { dryRun: true });
    expect(result.shape).toBe("single-ticket");
    expect(result.epicId).toBeNull();
    expect(result.childIds).toHaveLength(1);
  });

  test("pair shape skips epic but wires deps", async () => {
    const proposal: Proposal = {
      epic: { title: "X", body: "", tags: [] },
      children: [
        { ref: "C1", title: "first", body: "", type: "task", tags: [], depends: [] },
        { ref: "C2", title: "second", body: "", type: "task", tags: [], depends: ["C1"] },
      ],
    };
    const result = await writeProposal({} as HivePaths, "hive", proposal, { dryRun: true });
    expect(result.shape).toBe("pair");
    expect(result.epicId).toBeNull();
    expect(result.childIds).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// writeProposal — live FS
// ---------------------------------------------------------------------------

describe("writeProposal — live", () => {
  let paths: HivePaths;
  const project = "demo";

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-decompose-write-"));
    paths = await ensureHiveScaffold(home);
  });

  test("writes epic + 3 children in topological order with deps wired", async () => {
    const proposal: Proposal = {
      epic: {
        title: "Add overnight retry",
        body: "## Goal\nMake dispatch self-heal\n## Why\nFlakes",
        tags: ["dispatch"],
      },
      children: [
        // C2 listed first to prove writer reorders.
        {
          ref: "C2",
          title: "Wire retry into orchestrator",
          body: "## Scope\n…\n## Acceptance\n- [ ] retries fire",
          type: "feature",
          tags: ["dispatch"],
          depends: ["C1"],
        },
        {
          ref: "C1",
          title: "Add retry-policy module",
          body: "## Scope\n…\n## Acceptance\n- [ ] decision tree exists",
          type: "task",
          tags: ["dispatch"],
          depends: [],
        },
        {
          ref: "C3",
          title: "Surface retry counts in dashboard",
          body: "## Scope\n…\n## Acceptance\n- [ ] count visible",
          type: "feature",
          tags: ["dispatch", "dashboard"],
          depends: ["C2"],
        },
      ],
    };

    const result = await writeProposal(paths, project, proposal, { priority: 1 });
    expect(result.shape).toBe("epic-with-children");
    expect(result.epicId).toBe("TK-001");
    expect(result.childIds).toEqual(["TK-002", "TK-003", "TK-004"]);

    // C1 → TK-002, C2 → TK-003, C3 → TK-004 because of topological order.
    expect(result.refMap.C1).toBe("TK-002");
    expect(result.refMap.C2).toBe("TK-003");
    expect(result.refMap.C3).toBe("TK-004");

    // Dependencies are wired with real IDs.
    const c2 = await readTicket(paths, project, "TK-003");
    expect(c2?.depends).toEqual(["TK-002"]);
    const c3 = await readTicket(paths, project, "TK-004");
    expect(c3?.depends).toEqual(["TK-003"]);

    // Epic is type=epic and carries the operator-chosen priority.
    const epic = await readTicket(paths, project, "TK-001");
    expect(epic?.type).toBe("epic");
    expect(epic?.priority).toBe(1);

    // Children inherit the same priority.
    expect(c2?.priority).toBe(1);

    // Epic body has a Children section even if the LLM forgot one.
    expect(epic?.body).toContain("## Children");

    // All four tickets exist on disk.
    const all = await listTickets(paths, project);
    expect(all).toHaveLength(4);
  });

  test("single-child shape: only the child ticket is written", async () => {
    const proposal: Proposal = {
      epic: { title: "Should be skipped", body: "", tags: [] },
      children: [
        {
          ref: "C1",
          title: "Just do it",
          body: "## Scope\n…",
          type: "task",
          tags: ["x"],
          depends: [],
        },
      ],
    };
    const result = await writeProposal(paths, project, proposal);
    expect(result.shape).toBe("single-ticket");
    expect(result.epicId).toBeNull();
    const all = await listTickets(paths, project);
    expect(all).toHaveLength(1);
    expect(all[0]?.type).toBe("task");
  });

  test("epic-with-children: parent_epic field is set on every child", async () => {
    const proposal: Proposal = {
      epic: { title: "An epic", body: "## Goal\nDo it", tags: [] },
      children: [
        { ref: "C1", title: "first", body: "", type: "task", tags: [], depends: [] },
        { ref: "C2", title: "second", body: "", type: "task", tags: [], depends: ["C1"] },
        { ref: "C3", title: "third", body: "", type: "task", tags: [], depends: ["C2"] },
      ],
    };
    const result = await writeProposal(paths, project, proposal);
    expect(result.epicId).toBe("TK-001");
    for (const childId of result.childIds) {
      const t = await readTicket(paths, project, childId);
      expect(t?.parentEpic).toBe("TK-001");
    }
  });

  test("standalone (1 child) and pair (2 children) do NOT set parent_epic", async () => {
    const single: Proposal = {
      epic: { title: "Skipped", body: "", tags: [] },
      children: [
        { ref: "C1", title: "lone", body: "", type: "task", tags: [], depends: [] },
      ],
    };
    const r1 = await writeProposal(paths, project, single);
    const t1 = await readTicket(paths, project, r1.childIds[0]!);
    expect(t1?.parentEpic).toBeNull();
  });

  test("epic body has real TK-NNN ids after write, not placeholder refs", async () => {
    const proposal: Proposal = {
      epic: { title: "Auth epic", body: "## Goal\nLand auth", tags: [] },
      children: [
        { ref: "C1", title: "session model", body: "", type: "task", tags: [], depends: [] },
        { ref: "C2", title: "login endpoint", body: "", type: "feature", tags: [], depends: ["C1"] },
        { ref: "C3", title: "ui shell", body: "", type: "feature", tags: [], depends: ["C2"] },
      ],
    };
    const result = await writeProposal(paths, project, proposal);
    const epic = await readTicket(paths, project, result.epicId!);
    expect(epic?.body).toContain("## Children");
    // Real ids present
    expect(epic?.body).toContain("TK-002 — session model");
    expect(epic?.body).toContain("TK-003 — login endpoint (depends on TK-002)");
    expect(epic?.body).toContain("TK-004 — ui shell (depends on TK-003)");
    // Placeholder refs gone
    expect(epic?.body).not.toContain("- C1 —");
    expect(epic?.body).not.toContain("- C2 —");
  });

  test("pair shape: two tickets, no epic", async () => {
    const proposal: Proposal = {
      epic: { title: "Skipped", body: "", tags: [] },
      children: [
        { ref: "A", title: "First", body: "## Scope\n…", type: "task", tags: [], depends: [] },
        { ref: "B", title: "Second", body: "## Scope\n…", type: "task", tags: [], depends: ["A"] },
      ],
    };
    const result = await writeProposal(paths, project, proposal);
    expect(result.shape).toBe("pair");
    expect(result.epicId).toBeNull();
    const all = await listTickets(paths, project);
    expect(all).toHaveLength(2);
    const second = all.find((t) => t.title === "Second")!;
    expect(second.depends).toEqual([all.find((t) => t.title === "First")!.id]);
  });
});

// ---------------------------------------------------------------------------
// renderWriteResult — string formatting
// ---------------------------------------------------------------------------

describe("renderWriteResult", () => {
  test("renders epic + children tree", () => {
    const text = renderWriteResult({
      shape: "epic-with-children",
      epicId: "TK-100",
      refMap: { EPIC: "TK-100", C1: "TK-101", C2: "TK-102" },
      childIds: ["TK-101", "TK-102"],
      edges: [{ from: "TK-101", to: "TK-102" }],
    });
    expect(text).toContain("Epic: TK-100");
    expect(text).toContain("- TK-101");
    expect(text).toContain("- TK-102  (deps: TK-101)");
  });

  test("renders single-ticket note", () => {
    const text = renderWriteResult({
      shape: "single-ticket",
      epicId: null,
      refMap: { C1: "TK-050" },
      childIds: ["TK-050"],
      edges: [],
    });
    expect(text).toContain("Single ticket: TK-050");
    expect(text).toContain("smaller than typical");
  });
});
