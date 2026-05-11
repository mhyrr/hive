import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectArcs, type Arc, type GoalArc, type CampaignArc, type DirectArc } from "../lib/dashboard/runs/collect";
import { ensureHiveScaffold } from "../lib/paths";
import { createTicket } from "../lib/ticket";
import type { HivePaths } from "../lib/paths";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function buildFixture(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "hive-arcs-"));
  await ensureHiveScaffold(home);
  return home;
}

async function registerProject(home: string, projectId: string): Promise<void> {
  await mkdir(join(home, "projects", projectId, "tickets"), { recursive: true });
}

async function createDispatchRun(
  home: string,
  id: string,
  opts: {
    status: string;
    goal?: string;
    ticketId?: string;
  },
): Promise<void> {
  const dir = join(home, "runs", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "status"), opts.status);
  const goalBody = opts.goal ?? `# Goal\n\nProject: test\n\nImplement ${opts.ticketId ?? id}.\n`;
  await writeFile(join(dir, "goal.md"), goalBody);
}

async function createCampaignDir(
  home: string,
  id: string,
  opts: {
    status: string;
    goal?: string;
    ticketId?: string;
    scorecardRows?: string[];
    resultTxt?: string;
  },
): Promise<void> {
  const dir = join(home, "campaigns", id);
  await mkdir(join(dir, "iterations"), { recursive: true });
  await writeFile(join(dir, "status"), opts.status);
  const goalText = opts.goal ?? `Campaign ${id} for ${opts.ticketId ?? "misc"}`;
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({ goal: goalText }),
  );
  if (opts.scorecardRows && opts.scorecardRows.length > 0) {
    await writeFile(
      join(dir, "scorecard.jsonl"),
      opts.scorecardRows.join("\n") + "\n",
    );
  }
  if (opts.resultTxt) {
    await writeFile(join(dir, "result.txt"), opts.resultTxt);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("collectArcs", () => {
  let home: string;
  let paths: HivePaths;

  beforeEach(async () => {
    home = await buildFixture();
    paths = await ensureHiveScaffold(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Goal arc: epic + children + runs joined via runsByTicket
  // -------------------------------------------------------------------------
  test("goal arc includes epic children with runs joined via runsByTicket()", async () => {
    await registerProject(home, "alpha");

    // Create an epic + 2 children
    const epic = await createTicket(paths, "alpha", {
      title: "Auth system",
      type: "epic",
    });
    const c1 = await createTicket(paths, "alpha", {
      title: "Session model",
      type: "task",
      parentEpic: epic.id,
    });
    const c2 = await createTicket(paths, "alpha", {
      title: "Login endpoint",
      type: "task",
      parentEpic: epic.id,
      depends: [c1.id],
    });

    // Create dispatch runs targeting the children
    await createDispatchRun(home, "RUN-001", {
      status: "complete",
      goal: `# Goal\n\nProject: alpha\n\nImplement ${c1.id} — session model.\n`,
      ticketId: c1.id,
    });
    await createDispatchRun(home, "RUN-002", {
      status: "complete",
      goal: `# Goal\n\nProject: alpha\n\nImplement ${c2.id} — login endpoint.\n`,
      ticketId: c2.id,
    });

    const arcs = await collectArcs(paths, { checkPid: false });

    // Should have exactly 1 goal arc
    const goalArcs = arcs.filter((a): a is GoalArc => a.kind === "goal");
    expect(goalArcs).toHaveLength(1);

    const arc = goalArcs[0]!;
    expect(arc.epic.id).toBe(epic.id);
    expect(arc.children).toHaveLength(2);
    expect(arc.runCount).toBe(2);
    expect(arc.totalCost).toBeNull(); // dispatch cost not tracked

    // Check children have runs joined
    const c1Arc = arc.children.find((c) => c.ticket.id === c1.id)!;
    expect(c1Arc.runs).toHaveLength(1);
    expect(c1Arc.runs[0]!.id).toBe("RUN-001");
    expect(c1Arc.runs[0]!.status).toBe("shipped");

    const c2Arc = arc.children.find((c) => c.ticket.id === c2.id)!;
    expect(c2Arc.runs).toHaveLength(1);
    expect(c2Arc.runs[0]!.id).toBe("RUN-002");

    // No direct arcs — all runs are claimed by the goal arc
    const directArcs = arcs.filter((a): a is DirectArc => a.kind === "direct");
    expect(directArcs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Goal arc status rollup
  // -------------------------------------------------------------------------
  test("goal arc status is 'shipped' when all children closed", async () => {
    await registerProject(home, "alpha");

    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    const c1 = await createTicket(paths, "alpha", {
      title: "C1",
      type: "task",
      parentEpic: epic.id,
    });

    // Create a shipped run for c1
    await createDispatchRun(home, "RUN-010", {
      status: "complete",
      goal: `# Goal\n\nProject: alpha\n\n${c1.id}\n`,
    });

    const arcs = await collectArcs(paths, { checkPid: false });
    const goalArcs = arcs.filter((a): a is GoalArc => a.kind === "goal");
    expect(goalArcs[0]!.status).toBe("shipped");
  });

  test("goal arc status is 'in-flight' when a child has a running run", async () => {
    await registerProject(home, "alpha");

    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    const c1 = await createTicket(paths, "alpha", {
      title: "C1",
      type: "task",
      parentEpic: epic.id,
    });

    // Note: with checkPid=false and status=running, it becomes "crashed"
    // To test in-flight we need a ticket that's in_progress
    // Use the ticket status rather than run status for this case
    const { updateTicket } = await import("../lib/ticket");
    await updateTicket(paths, "alpha", c1.id, { status: "in_progress" });

    const arcs = await collectArcs(paths, { checkPid: false });
    const goalArcs = arcs.filter((a): a is GoalArc => a.kind === "goal");
    expect(goalArcs[0]!.status).toBe("in-flight");
  });

  test("goal arc status is 'blocked' when child has unmet depends", async () => {
    await registerProject(home, "alpha");

    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    const c1 = await createTicket(paths, "alpha", {
      title: "C1",
      type: "task",
      parentEpic: epic.id,
    });
    // c2 depends on c1 (which is still open)
    await createTicket(paths, "alpha", {
      title: "C2",
      type: "task",
      parentEpic: epic.id,
      depends: [c1.id],
    });

    const arcs = await collectArcs(paths, { checkPid: false });
    const goalArcs = arcs.filter((a): a is GoalArc => a.kind === "goal");
    // c1 is open (not blocked), c2 is blocked → mixed? No — c1 isn't shipped or in-flight
    // c1 is open with no runs or in-progress status, c2 is blocked
    // Open + blocked → blocked dominates
    expect(goalArcs[0]!.status).toBe("blocked");
  });

  test("goal arc status is 'mixed' when some shipped, some open", async () => {
    await registerProject(home, "alpha");

    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    const c1 = await createTicket(paths, "alpha", {
      title: "C1",
      type: "task",
      parentEpic: epic.id,
    });
    const c2 = await createTicket(paths, "alpha", {
      title: "C2",
      type: "task",
      parentEpic: epic.id,
    });

    // Ship c1 but leave c2 open with no runs
    await createDispatchRun(home, "RUN-020", {
      status: "complete",
      goal: `# Goal\n\nProject: alpha\n\n${c1.id}\n`,
    });

    const arcs = await collectArcs(paths, { checkPid: false });
    const goalArcs = arcs.filter((a): a is GoalArc => a.kind === "goal");
    expect(goalArcs[0]!.status).toBe("mixed");
  });

  // -------------------------------------------------------------------------
  // Campaign arc: reads scorecard.jsonl
  // -------------------------------------------------------------------------
  test("campaign arc reads scorecard.jsonl and exposes per-iteration data", async () => {
    await createCampaignDir(home, "CAMP-001", {
      status: "done",
      goal: "Implement TK-074 campaign state model",
      scorecardRows: [
        JSON.stringify({
          iteration_n: 1,
          started_at: "2026-05-10T16:45:32Z",
          ended_at: "2026-05-10T16:46:20Z",
          exit_reason: "natural",
          judge_decision: "continue",
          tokens_used: 100000,
          cost_usd: 0.30,
        }),
        JSON.stringify({
          iteration_n: 2,
          started_at: "2026-05-10T16:47:00Z",
          ended_at: "2026-05-10T16:48:30Z",
          exit_reason: "natural",
          judge_decision: "done",
          tokens_used: 91758,
          cost_usd: 0.275,
        }),
      ],
    });

    const arcs = await collectArcs(paths, { checkPid: false });
    const campArcs = arcs.filter((a): a is CampaignArc => a.kind === "campaign");

    expect(campArcs).toHaveLength(1);
    const arc = campArcs[0]!;
    expect(arc.iterationCount).toBe(2);
    expect(arc.totalCost).toBeCloseTo(0.575, 3);
    expect(arc.status).toBe("shipped");

    // Per-iteration data
    expect(arc.iterations[0]!.iterationN).toBe(1);
    expect(arc.iterations[0]!.exitReason).toBe("natural");
    expect(arc.iterations[0]!.judgeDecision).toBe("continue");
    expect(arc.iterations[0]!.cost).toBeCloseTo(0.30, 2);
    expect(arc.iterations[0]!.elapsedSec).toBe(48); // 16:45:32 → 16:46:20 = 48s

    expect(arc.iterations[1]!.iterationN).toBe(2);
    expect(arc.iterations[1]!.judgeDecision).toBe("done");
    expect(arc.iterations[1]!.cost).toBeCloseTo(0.275, 3);
    expect(arc.iterations[1]!.elapsedSec).toBe(90); // 16:47:00 → 16:48:30 = 90s
  });

  test("campaign arc status reflects campaign run status", async () => {
    await createCampaignDir(home, "CAMP-002", {
      status: "aborted",
      goal: "Failed campaign",
      scorecardRows: [
        JSON.stringify({
          iteration_n: 1,
          started_at: "2026-05-10T10:00:00Z",
          ended_at: "2026-05-10T10:05:00Z",
          exit_reason: "error",
          judge_decision: "abort",
          cost_usd: 0.15,
        }),
      ],
    });

    const arcs = await collectArcs(paths, { checkPid: false });
    const campArcs = arcs.filter((a): a is CampaignArc => a.kind === "campaign");
    expect(campArcs[0]!.status).toBe("blocked"); // failed/crashed → blocked (stalled)
  });

  // TK-110: budget-exhausted with result.txt is a normal termination — no failure reason.
  // The last iteration's "natural · continue" is the most successful possible last state,
  // not a failure message.
  test("budget-exhausted campaign with result.txt has no failureReason", async () => {
    await createCampaignDir(home, "CAMP-003", {
      status: "budget-exhausted",
      goal: "Cap-hit campaign",
      scorecardRows: [
        JSON.stringify({
          iteration_n: 1,
          started_at: "2026-05-10T10:00:00Z",
          ended_at: "2026-05-10T10:05:00Z",
          exit_reason: "natural",
          judge_decision: "continue",
          cost_usd: 0.30,
        }),
      ],
      resultTxt: "Campaign CAMP-003 finished.\n  Reason: max_iterations\n",
    });

    const arcs = await collectArcs(paths, { checkPid: false });
    const campArcs = arcs.filter((a): a is CampaignArc => a.kind === "campaign");
    expect(campArcs[0]!.failureReason).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Direct arc: orphan dispatch runs
  // -------------------------------------------------------------------------
  test("orphan runs (no parent_epic, no campaign) classified as direct arcs", async () => {
    await registerProject(home, "alpha");

    // Create a standalone ticket (no parentEpic)
    const standalone = await createTicket(paths, "alpha", {
      title: "One-off fix",
      type: "task",
    });

    // Create a dispatch run for the standalone ticket
    await createDispatchRun(home, "RUN-050", {
      status: "complete",
      goal: `# Goal\n\nProject: alpha\n\n${standalone.id} — one-off fix.\n`,
    });

    const arcs = await collectArcs(paths, { checkPid: false });
    const directArcs = arcs.filter((a): a is DirectArc => a.kind === "direct");

    expect(directArcs).toHaveLength(1);
    expect(directArcs[0]!.run.id).toBe("RUN-050");
    expect(directArcs[0]!.run.status).toBe("shipped");
  });

  test("runs targeting epic children are NOT in direct arcs", async () => {
    await registerProject(home, "alpha");

    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    const child = await createTicket(paths, "alpha", {
      title: "C",
      type: "task",
      parentEpic: epic.id,
    });

    await createDispatchRun(home, "RUN-060", {
      status: "complete",
      goal: `# Goal\n\nProject: alpha\n\n${child.id}\n`,
    });

    const arcs = await collectArcs(paths, { checkPid: false });
    const directArcs = arcs.filter((a): a is DirectArc => a.kind === "direct");
    expect(directArcs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Edge: empty state
  // -------------------------------------------------------------------------
  test("empty state returns empty Arc[]", async () => {
    const arcs = await collectArcs(paths, { checkPid: false });
    expect(arcs).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Edge: run with no ticket at all → direct arc
  // -------------------------------------------------------------------------
  test("run with no ticketId at all is a direct arc", async () => {
    await createDispatchRun(home, "RUN-070", {
      status: "complete",
      goal: "# Goal\n\nSome ad-hoc work with no ticket reference.\n",
    });

    const arcs = await collectArcs(paths, { checkPid: false });
    const directArcs = arcs.filter((a): a is DirectArc => a.kind === "direct");
    expect(directArcs).toHaveLength(1);
    expect(directArcs[0]!.run.id).toBe("RUN-070");
  });

  // -------------------------------------------------------------------------
  // Mixed: all three arc kinds in one collection
  // -------------------------------------------------------------------------
  test("all three arc kinds appear together", async () => {
    await registerProject(home, "alpha");

    // Goal arc
    const epic = await createTicket(paths, "alpha", { title: "Epic", type: "epic" });
    const child = await createTicket(paths, "alpha", {
      title: "Child",
      type: "task",
      parentEpic: epic.id,
    });
    await createDispatchRun(home, "RUN-100", {
      status: "complete",
      goal: `# Goal\n\nProject: alpha\n\n${child.id}\n`,
    });

    // Campaign arc
    await createCampaignDir(home, "CAMP-010", {
      status: "done",
      goal: "Campaign goal",
      scorecardRows: [
        JSON.stringify({
          iteration_n: 1,
          started_at: "2026-05-10T10:00:00Z",
          ended_at: "2026-05-10T10:01:00Z",
          exit_reason: "natural",
          judge_decision: "done",
          cost_usd: 0.5,
        }),
      ],
    });

    // Direct arc
    await createDispatchRun(home, "RUN-101", {
      status: "partial",
      goal: "# Goal\n\nProject: alpha\n\nDirect work.\n",
    });

    const arcs = await collectArcs(paths, { checkPid: false });

    const goals = arcs.filter((a) => a.kind === "goal");
    const campaigns = arcs.filter((a) => a.kind === "campaign");
    const directs = arcs.filter((a) => a.kind === "direct");

    expect(goals).toHaveLength(1);
    expect(campaigns).toHaveLength(1);
    expect(directs).toHaveLength(1);
  });
});
