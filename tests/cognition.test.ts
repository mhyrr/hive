import { describe, expect, test } from "bun:test";

import { CognitionWorkbench, type CompileTask } from "../src/lib/cognition";

describe("cognition workbench", () => {
  test("runs cloud-tier batches with bounded concurrency", async () => {
    let active = 0;
    let maxActive = 0;

    const task: CompileTask<number, number> = {
      id: "test-cloud-batch",
      kind: "diff-triage",
      trigger: "event",
      freshnessMs: 1_000,
      shouldRun: () => true,
      fingerprint: (input) => String(input),
      classify: () => "tier1-cloud",
      run: async (input) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(20);
        active -= 1;
        return input * 2;
      },
    };

    const workbench = new CognitionWorkbench([task], {
      schedulerLimits: {
        "tier1-cloud": 2,
      },
    });
    const packets = await workbench.runBatch(task, [1, 2, 3, 4]);

    expect(maxActive).toBe(2);
    expect(packets.map((packet) => packet?.data)).toEqual([2, 4, 6, 8]);
  });

  test("reuses cached packets when the fingerprint is unchanged", async () => {
    let runs = 0;

    const task: CompileTask<string, string> = {
      id: "test-cache",
      kind: "human-request",
      trigger: "event",
      freshnessMs: 60_000,
      shouldRun: () => true,
      fingerprint: (input) => input,
      classify: () => "deterministic",
      run: async (input) => {
        runs += 1;
        return `compiled:${input}`;
      },
    };

    const workbench = new CognitionWorkbench([task]);
    const first = await workbench.runTask(task, "same");
    const second = await workbench.runTask(task, "same");

    expect(runs).toBe(1);
    expect(first?.fingerprint).toBe(second?.fingerprint);
    expect(first?.compiledAt).toBe(second?.compiledAt);
    expect(second?.data).toBe("compiled:same");
  });
});
