import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEvaluatedWatcherEvents,
  type DispatcherConfig,
} from "../src/lib/evaluation-dispatcher";
import type { OrientationSummary } from "../src/lib/orientation";

const ORIENTATION: OrientationSummary = {
  updatedAt: "2026-03-10T00:00:00Z",
  activeGoal: "stabilize watcher loop",
  state: "workers are active",
  workers: "alpha (run-1)",
  posture: "converging",
  watchFor: "run state changes",
  ignore: "routine feed noise",
};

let originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
const tempDirs: string[] = [];

afterEach(async () => {
  if (originalAnthropicApiKey === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await Bun.sleep(20);
  }

  throw new Error("timed out waiting for queued evaluation");
}

describe("evaluation dispatcher", () => {
  test("bounds repeated run-change events to one active and one trailing evaluation", async () => {
    originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    const dir = await mkdtemp(join(tmpdir(), "hive-eval-dispatcher-"));
    tempDirs.push(dir);

    const evalLogPath = join(dir, "eval.log");
    const seenRunPaths: string[] = [];
    let refreshCalls = 0;

    const fakeOrientationCache = {
      get: () => ORIENTATION,
      format: () => "## Orientation\nready",
      patch: () => {},
    } as unknown as DispatcherConfig["orientationCache"];

    const events = createEvaluatedWatcherEvents(
      {
        onRunChange: (runPath: string) => {
          seenRunPaths.push(runPath);
        },
      },
      {
        orientationCache: fakeOrientationCache,
        evalLogPath,
        projectId: "demo",
        projectRunsActiveDir: dir,
        getActiveContext: () => ({
          goalTitle: "demo",
          workerCount: 1,
          workerSummaries: "alpha (run-1)",
          boardDigest: "board digest",
          lastStrategicEval: "never",
        }),
        beforeEvaluate: async () => {
          await Bun.sleep(50);
          refreshCalls += 1;
        },
      },
    );

    events.onRunChange?.("/tmp/run-a");
    events.onRunChange?.("/tmp/run-b");
    events.onRunChange?.("/tmp/run-c");

    await waitFor(() => seenRunPaths.length === 3);

    const evalLogLines = (await Bun.file(evalLogPath).text())
      .trim()
      .split("\n")
      .filter(Boolean);

    expect(seenRunPaths).toEqual(["/tmp/run-a", "/tmp/run-b", "/tmp/run-c"]);
    expect(refreshCalls).toBe(2);
    expect(evalLogLines).toHaveLength(2);
  });
});
