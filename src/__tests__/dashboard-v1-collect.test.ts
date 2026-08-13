import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectBets,
  collectOpenQuestions,
  collectRecentMemory,
  collectRunUsage,
  collectTasteTrack,
} from "../lib/dashboard/collect";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import {
  appendProjectMemory,
  entryHash,
  metaPath,
  readMeta,
  type MetaSidecar,
} from "../lib/memory";
import {
  appendUsageRecord,
  estimateCost,
} from "../lib/pricing";

async function freshHome(): Promise<HivePaths> {
  const home = await mkdtemp(join(tmpdir(), "hive-dash-v1-"));
  return ensureHiveScaffold(home);
}

describe("collectBets", () => {
  test("returns the latest bets.md with its H1 stripped; null when none", async () => {
    const paths = await freshHome();
    expect(await collectBets(paths)).toBeNull();

    for (const [date, body] of [
      ["2026-08-10", "# Watch: bets — 2026-08-10\n\nOld bet."],
      ["2026-08-12", "# Watch: bets — 2026-08-12\n\nBet: TK-001 — ship it."],
    ] as const) {
      await mkdir(join(paths.memoryRunsDir, date), { recursive: true });
      await writeFile(join(paths.memoryRunsDir, date, "bets.md"), body);
    }
    // A newer run dir with no bets.md must not shadow the latest actual bets.
    await mkdir(join(paths.memoryRunsDir, "2026-08-13"), { recursive: true });

    const bets = await collectBets(paths);
    expect(bets?.date).toBe("2026-08-12");
    expect(bets?.body).toBe("Bet: TK-001 — ship it.");
    expect(bets?.body).not.toContain("# Watch");
  });
});

async function registerProject(paths: HivePaths, projectId: string): Promise<void> {
  await mkdir(join(paths.projectsDir, projectId), { recursive: true });
  await writeFile(
    join(paths.projectsDir, projectId, "config.md"),
    `---\nname: ${projectId}\npath: /tmp/nope/${projectId}\n---\n`,
  );
}

// ---------------------------------------------------------------------------
// collectOpenQuestions
// ---------------------------------------------------------------------------

describe("collectOpenQuestions", () => {
  test("aggregates questions across projects", async () => {
    const paths = await freshHome();
    await registerProject(paths, "alpha");
    await registerProject(paths, "bravo");
    await appendProjectMemory(paths, "alpha", "question", "How do we cache layers?", ["caching"]);
    await appendProjectMemory(paths, "alpha", "question", "Should we move off Kafka?", []);
    await appendProjectMemory(paths, "bravo", "question", "Migrate to v2 of the SDK?", ["sdk"]);

    const out = await collectOpenQuestions(paths);
    expect(out.length).toBe(3);
    const byProject = new Map(out.map((q) => [q.text, q.projectId]));
    expect(byProject.get("How do we cache layers?")).toBe("alpha");
    expect(byProject.get("Migrate to v2 of the SDK?")).toBe("bravo");
  });

  test("ignores superseded questions", async () => {
    const paths = await freshHome();
    await registerProject(paths, "alpha");
    await appendProjectMemory(paths, "alpha", "question", "Old question");
    // Manually mark the entry superseded by overwriting knowledge.md.
    const file = join(paths.memoryProjectsDir, "alpha", "knowledge.md");
    const content = await Bun.file(file).text();
    await Bun.write(
      file,
      content.replace(/- Old question/, "- ~~Old question~~ → superseded 2026-04-26"),
    );
    const out = await collectOpenQuestions(paths);
    expect(out).toEqual([]);
  });

  test("empty home returns []", async () => {
    const paths = await freshHome();
    const out = await collectOpenQuestions(paths);
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// collectRecentMemory
// ---------------------------------------------------------------------------

async function pinMeta(
  paths: HivePaths,
  projectId: string,
  text: string,
  patch: { createdAt?: string; lastRecalled?: string | null; recallCount?: number; halfLife?: number },
): Promise<void> {
  const file = metaPath(paths, projectId);
  const meta: MetaSidecar = await readMeta(paths, projectId);
  const hash = entryHash(text);
  const existing = meta.entries[hash] ?? {
    createdAt: new Date().toISOString().slice(0, 10),
    lastRecalled: null,
    recallCount: 0,
    halfLife: 30,
  };
  meta.entries[hash] = { ...existing, ...patch };
  await Bun.write(file, JSON.stringify(meta, null, 2));
}

describe("collectRecentMemory", () => {
  test("only includes entries active within the window", async () => {
    const paths = await freshHome();
    await registerProject(paths, "alpha");
    await appendProjectMemory(paths, "alpha", "fact", "fresh fact");
    await appendProjectMemory(paths, "alpha", "fact", "stale fact");

    // Stale entry: created 30 days ago, never recalled.
    const today = new Date();
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 3600 * 1000)
      .toISOString().slice(0, 10);
    await pinMeta(paths, "alpha", "stale fact", { createdAt: thirtyDaysAgo, lastRecalled: null });

    const out = await collectRecentMemory(paths);
    const texts = out.map((e) => e.text);
    expect(texts).toContain("fresh fact");
    expect(texts).not.toContain("stale fact");
  });

  test("ranks by strength descending", async () => {
    const paths = await freshHome();
    await registerProject(paths, "alpha");
    await appendProjectMemory(paths, "alpha", "fact", "weak");
    await appendProjectMemory(paths, "alpha", "fact", "strong");

    // Make "strong" actually strong via recallCount + halfLife
    await pinMeta(paths, "alpha", "strong", { recallCount: 5, halfLife: 60 });

    const out = await collectRecentMemory(paths);
    expect(out[0]?.text).toBe("strong");
  });

  test("respects limit parameter", async () => {
    const paths = await freshHome();
    await registerProject(paths, "alpha");
    for (let i = 0; i < 5; i++) {
      await appendProjectMemory(paths, "alpha", "fact", `fact ${i}`);
    }
    const out = await collectRecentMemory(paths, { limit: 2 });
    expect(out.length).toBe(2);
  });

  test("ignores entries with no metadata (graceful)", async () => {
    const paths = await freshHome();
    await registerProject(paths, "alpha");
    await appendProjectMemory(paths, "alpha", "fact", "tracked");
    // Add an entry directly to disk that has no meta record.
    const file = join(paths.memoryProjectsDir, "alpha", "knowledge.md");
    const existing = await Bun.file(file).text();
    await Bun.write(file, existing + "- untracked orphan\n");
    const out = await collectRecentMemory(paths);
    expect(out.map((e) => e.text)).toContain("tracked");
    expect(out.map((e) => e.text)).not.toContain("untracked orphan");
  });
});

// ---------------------------------------------------------------------------
// collectRunUsage
// ---------------------------------------------------------------------------

describe("collectRunUsage", () => {
  test("missing usage.json returns available=false with zeros", async () => {
    const paths = await freshHome();
    const snap = await collectRunUsage(paths, "2026-04-26");
    expect(snap.available).toBe(false);
    expect(snap.totalUsd).toBe(0);
    expect(snap.passes).toEqual([]);
    expect(snap.totalUsdFormatted).toMatch(/^\$/);
  });

  test("aggregates B + C + V records with formatted USD", async () => {
    const paths = await freshHome();
    const date = "2026-04-26";
    const sonnetCost = (input: number, output: number) =>
      estimateCost({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: input,
        outputTokens: output,
      });
    const opusCost = (input: number, output: number) =>
      estimateCost({
        provider: "anthropic",
        model: "claude-opus-4-6",
        inputTokens: input,
        outputTokens: output,
      });

    await appendUsageRecord(paths, date, {
      pass: "B",
      project: "alpha",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 8_000,
      outputTokens: 800,
      durationMs: 200,
      cost: sonnetCost(8_000, 800),
    });
    await appendUsageRecord(paths, date, {
      pass: "C",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 12_000,
      outputTokens: 1_200,
      durationMs: 250,
      cost: sonnetCost(12_000, 1_200),
    });
    await appendUsageRecord(paths, date, {
      pass: "V",
      provider: "anthropic",
      model: "claude-opus-4-6",
      inputTokens: 60_000,
      outputTokens: 4_000,
      durationMs: 1_500,
      cost: opusCost(60_000, 4_000),
    });

    const snap = await collectRunUsage(paths, date);
    expect(snap.available).toBe(true);
    expect(snap.passes.length).toBe(3);
    expect(snap.totalInputTokens).toBe(80_000);
    expect(snap.totalOutputTokens).toBe(6_000);
    // 8k*$3 + 0.8k*$15 + 12k*$3 + 1.2k*$15 + 60k*$15 + 4k*$75 = 1.2M = $1.20 + bits
    expect(snap.totalUsd).toBeGreaterThan(1);
    expect(snap.totalUsdFormatted.startsWith("$")).toBe(true);
    // Per-pass projects pass through (B carries project, C/V do not)
    const b = snap.passes.find((p) => p.pass === "B");
    expect(b?.project).toBe("alpha");
    const v = snap.passes.find((p) => p.pass === "V");
    expect(v?.project).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// collectTasteTrack
// ---------------------------------------------------------------------------

describe("collectTasteTrack", () => {
  const date = "2026-06-25";

  async function writeDecisions(paths: HivePaths, obj: unknown): Promise<void> {
    const dir = join(paths.memoryRunsDir, date);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "taste-decisions.json"), JSON.stringify(obj, null, 2));
  }

  test("no artifact → unavailable, all zeros", async () => {
    const paths = await freshHome();
    const snap = await collectTasteTrack(paths, date);
    expect(snap.available).toBe(false);
    expect(snap.written).toBe(0);
    expect(snap.reviewEligibleUnits).toEqual([]);
  });

  test("summarizes counts, replay verdicts, and the review-eligible queue", async () => {
    const paths = await freshHome();
    await writeDecisions(paths, {
      written: 3,
      reviewEligible: 1,
      holding: 2,
      conflicts: [{ dedupe_key: "x" }],
      tensions: [],
      handoffsToFacts: [{ dedupe_key: "fact" }],
      droppedNoise: 4,
      droppedNegative: 1,
      newPrincipleProposals: ["maybe a new principle is emerging"],
      decisions: [
        { dedupe_key: "use-uuid", category: "IMPLEMENTATION", tier: "FUZZY", recurrence: 2, reviewEligible: true, status: "pending", ladders_up_to: "As simple as possible", replay: { passed: true, inconclusive: false } },
        { dedupe_key: "held-thin", category: "DESIGN", tier: "FUZZY", recurrence: 2, reviewEligible: false, status: "holding", ladders_up_to: null, replay: { passed: false, inconclusive: true } },
        { dedupe_key: "first-sight", category: "PROCESS", tier: "FUZZY", recurrence: 1, reviewEligible: false, status: "holding", replay: null },
      ],
    });

    const snap = await collectTasteTrack(paths, date);
    expect(snap.available).toBe(true);
    expect(snap.written).toBe(3);
    expect(snap.reviewEligible).toBe(1);
    expect(snap.holding).toBe(2);
    expect(snap.conflicts).toBe(1);
    expect(snap.handoffs).toBe(1);
    expect(snap.droppedNoise).toBe(4);
    expect(snap.replayPassed).toBe(1);
    expect(snap.replayInconclusive).toBe(1);
    expect(snap.newPrincipleProposals).toEqual(["maybe a new principle is emerging"]);
    // Only the review-eligible unit makes the actionable queue.
    expect(snap.reviewEligibleUnits).toHaveLength(1);
    expect(snap.reviewEligibleUnits[0]!.dedupeKey).toBe("use-uuid");
    expect(snap.reviewEligibleUnits[0]!.laddersUpTo).toBe("As simple as possible");
  });

  test("a corrupt artifact reads as unavailable, never throws", async () => {
    const paths = await freshHome();
    const dir = join(paths.memoryRunsDir, date);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "taste-decisions.json"), "{ not valid json");
    const snap = await collectTasteTrack(paths, date);
    expect(snap.available).toBe(false);
  });
});
