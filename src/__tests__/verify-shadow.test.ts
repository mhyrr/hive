import { describe, test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendCandidate,
  appendProjectMemory,
  entryHash,
  knowledgePath,
  readArchive,
  readMeta,
  readProjectMemorySnapshot,
  searchMemory,
} from "../lib/memory";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { buildConditionReport, writeConditionReport } from "../lib/condition";
import {
  buildProjectVerifierSystemPrompt,
  parseRetirements,
  runVerifier,
  validateVerifierOutput,
  type VerifierDecision,
} from "../lib/verify";
import { applyDecisions } from "../lib/apply";
import { loadUsageSummary } from "../lib/pricing";
import {
  compareShard,
  loadShadowNights,
  summarizeShadowNights,
  type ShadowNight,
} from "../lib/verify-shadow";
import type { ModelCaller } from "../lib/extract";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);

async function home(prefix: string): Promise<{ paths: HivePaths }> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const paths = await ensureHiveScaffold(dir);
  await mkdir(join(dir, "projects", "alpha"), { recursive: true });
  await writeFile(join(dir, "projects", "alpha", "config.md"), "---\nname: alpha\npath: /tmp/nope\n---\n");
  await writeConditionReport(paths, await buildConditionReport(paths));
  return { paths };
}

/** Thirty filler entries about billing, plus two about deploys. A candidate
 * about deploys has exactly those two as neighbours. */
async function seedCanon(paths: HivePaths): Promise<{ deployA: string; deployB: string }> {
  for (let i = 0; i < 30; i++) {
    await appendProjectMemory(paths, "alpha", "fact", `billing ledger rule number ${i} for invoices`);
  }
  await appendProjectMemory(paths, "alpha", "fact", "deploys run from the main branch via fly");
  await appendProjectMemory(paths, "alpha", "convention", "deploys need a green CI run first");
  return {
    deployA: entryHash("deploys run from the main branch via fly"),
    deployB: entryHash("deploys need a green CI run first"),
  };
}

type Call = { systemPrompt: string; userContent: string; kind: "full" | "shadow" | "brief" };

/** Routes by prompt: the shadow call is the one whose system prompt carries the
 * neighbour-scope note; the brief is the one with the conditioning report. */
function routedCaller(responses: { full: unknown; shadow: unknown | Error; brief?: unknown }): {
  caller: ModelCaller;
  calls: Call[];
} {
  const calls: Call[] = [];
  const brief = responses.brief ?? {
    decisions: [],
    gaps: [],
    briefing_markdown: "# HIVE\n\n## Headline\nQuiet.\n\n## Memory + verifier\n- Added: 9 entries. Superseded: 9. Reflections: 9.\n",
  };
  const caller: ModelCaller = async (input) => {
    const kind: Call["kind"] = input.systemPrompt.includes("# Canon scope tonight")
      ? "shadow"
      : input.userContent.includes("Conditioning report")
        ? "brief"
        : "full";
    calls.push({ systemPrompt: input.systemPrompt, userContent: input.userContent, kind });
    const body = kind === "shadow" ? responses.shadow : kind === "brief" ? brief : responses.full;
    if (body instanceof Error) throw body;
    const text = JSON.stringify(body);
    return {
      provider: "anthropic",
      model: "claude-opus-4-8",
      text,
      inputTokens: 1000,
      outputTokens: 100,
      totalTokens: 1100,
      durationMs: 10,
      raw: {} as never,
    };
  };
  return { caller, calls };
}

// ---------------------------------------------------------------------------
// Shadow mode
// ---------------------------------------------------------------------------

describe("runVerifier with shadow on", () => {
  test("writes nothing to canon from the shadow, and lands a comparison file", async () => {
    const { paths } = await home("hive-shadow-");
    const { deployA } = await seedCanon(paths);
    await appendCandidate(paths, "alpha", { type: "fact", content: "deploys run from main via fly.io" });
    await appendCandidate(paths, "alpha", { type: "fact", content: "invoices close on the first business day" });

    const { caller, calls } = routedCaller({
      full: {
        decisions: [
          { candidate_id: "candidates.alpha[0]", action: "reject", reason: "duplicate" },
          { candidate_id: "candidates.alpha[1]", action: "accept" },
        ],
        gaps: [],
      },
      // Neighbour V accepts the duplicate: the open risk the shadow exists to measure.
      shadow: {
        decisions: [
          { candidate_id: "candidates.alpha[0]", action: "accept" },
          { candidate_id: "candidates.alpha[1]", action: "accept" },
        ],
        gaps: [],
      },
    });

    const before = await Bun.file(knowledgePath(paths, "alpha")).text();
    const result = await runVerifier({ paths, date: today(), caller, shadow: true });
    expect(calls.map((c) => c.kind)).toEqual(["full", "brief", "shadow"]);
    // V never writes canon, shadow or not.
    expect(await Bun.file(knowledgePath(paths, "alpha")).text()).toBe(before);

    // The shadow saw neighbours, the full call saw everything.
    const full = calls.find((c) => c.kind === "full")!;
    const shadow = calls.find((c) => c.kind === "shadow")!;
    expect(full.userContent).toContain("billing ledger rule number 0 ");
    expect(shadow.userContent).toContain(deployA);
    expect(shadow.userContent).toMatch(/Canon: the \d+ of 32 entries nearest/);
    expect(shadow.userContent.length).toBeLessThan(full.userContent.length);

    // decisions.json is full V's alone; Pass F applies only that.
    const decisions = JSON.parse(await Bun.file(result.artifacts.decisionsPath).text());
    expect(decisions.decisions.map((d: VerifierDecision) => d.action)).toEqual(["reject", "accept"]);
    const applied = await applyDecisions({ paths, date: today() });
    expect(applied.totals.accepted).toBe(1);
    const snap = await readProjectMemorySnapshot(paths, "alpha");
    expect(snap.facts.filter((f) => f.text.includes("fly.io"))).toEqual([]);
    expect(snap.facts.some((f) => f.text === "invoices close on the first business day")).toBe(true);

    // The comparison.
    const json = join(paths.memoryRunsDir, today(), "verify-shadow.json");
    const md = join(paths.memoryRunsDir, today(), "verify-shadow.md");
    expect(existsSync(json)).toBe(true);
    expect(existsSync(md)).toBe(true);
    const night = JSON.parse(await Bun.file(json).text()) as ShadowNight;
    expect(night.totals).toMatchObject({
      candidates: 2,
      agree: 1,
      actionDiffers: 1,
      dupRejects: 1,
      dupRejectsLeaked: 1,
      errors: 0,
    });
    expect(night.projects[0]!.matrix).toEqual({ "reject>accept": 1, "accept>accept": 1 });
    expect(night.projects[0]!.canon.totalEntries).toBe(32);
    expect(night.projects[0]!.canon.shownEntries).toBeLessThan(32);
    expect(await Bun.file(md).text()).toContain("**duplicate leak**");

    // Shadow spend is its own usage row, apart from V's.
    const usage = await loadUsageSummary(paths, today());
    expect(usage.records.map((r) => r.pass)).toEqual(["V", "VS"]);
    expect(night.usage?.inputTokens).toBe(1000);

    // The briefing says so, and Pass F copies it out with the section.
    expect(await Bun.file(result.artifacts.briefingPath).text()).toContain("## Shadow verifier");
    expect(await Bun.file(applied.briefingPath!).text()).toContain("## Shadow verifier");
  });

  test("a failed shadow call is recorded and never fails Pass V", async () => {
    const { paths } = await home("hive-shadow-fail-");
    await seedCanon(paths);
    await appendCandidate(paths, "alpha", { type: "fact", content: "deploys use fly" });
    const { caller } = routedCaller({
      full: { decisions: [{ candidate_id: "candidates.alpha[0]", action: "accept" }], gaps: [] },
      shadow: new Error("claude --print exited 1."),
    });
    const result = await runVerifier({ paths, date: today(), caller, shadow: true });
    expect(result.output.decisions.length).toBe(1);
    expect(result.shadow?.report.totals.errors).toBe(1);
    expect(result.shadow?.report.projects[0]?.error).toContain("exited 1");
    expect(await loadUsageSummary(paths, today()).then((u) => u.records.map((r) => r.pass))).toEqual(["V"]);
  });

  test("a shadow call past its time budget is cut off and recorded", async () => {
    const { paths } = await home("hive-shadow-budget-");
    await seedCanon(paths);
    await appendCandidate(paths, "alpha", { type: "fact", content: "deploys use fly" });
    const { caller: base } = routedCaller({
      full: { decisions: [{ candidate_id: "candidates.alpha[0]", action: "accept" }], gaps: [] },
      shadow: { decisions: [{ candidate_id: "candidates.alpha[0]", action: "accept" }], gaps: [] },
    });
    const slow: ModelCaller = async (input) => {
      if (input.systemPrompt.includes("# Canon scope tonight")) await Bun.sleep(300);
      return base(input);
    };
    const prev = process.env.HIVE_VERIFY_SHADOW_BUDGET_MS;
    process.env.HIVE_VERIFY_SHADOW_BUDGET_MS = "50";
    try {
      const result = await runVerifier({ paths, date: today(), caller: slow, shadow: true });
      expect(result.output.decisions.length).toBe(1);
      expect(result.shadow?.report.projects[0]?.error).toContain("timed out after 50ms");
    } finally {
      if (prev === undefined) delete process.env.HIVE_VERIFY_SHADOW_BUDGET_MS;
      else process.env.HIVE_VERIFY_SHADOW_BUDGET_MS = prev;
    }
  });

  test("off by default: no shadow call, no comparison file", async () => {
    const { paths } = await home("hive-shadow-off-");
    await seedCanon(paths);
    await appendCandidate(paths, "alpha", { type: "fact", content: "deploys use fly" });
    const { caller, calls } = routedCaller({
      full: { decisions: [{ candidate_id: "candidates.alpha[0]", action: "accept" }], gaps: [] },
      shadow: new Error("must not be called"),
    });
    const prev = process.env.HIVE_VERIFY_SHADOW;
    delete process.env.HIVE_VERIFY_SHADOW;
    try {
      await runVerifier({ paths, date: today(), caller });
    } finally {
      if (prev !== undefined) process.env.HIVE_VERIFY_SHADOW = prev;
    }
    expect(calls.map((c) => c.kind)).toEqual(["full", "brief"]);
    expect(calls[0]!.systemPrompt).toBe(buildProjectVerifierSystemPrompt());
    expect(existsSync(join(paths.memoryRunsDir, today(), "verify-shadow.json"))).toBe(false);
  });
});

describe("runVerifier with scope=neighbors", () => {
  test("the real V call reads only the neighbours", async () => {
    const { paths } = await home("hive-neighbors-");
    const { deployA, deployB } = await seedCanon(paths);
    await appendCandidate(paths, "alpha", { type: "fact", content: "deploys need CI green and run from main" });
    const { caller, calls } = routedCaller({
      full: { decisions: [{ candidate_id: "candidates.alpha[0]", action: "merge", target_hash: deployB }], gaps: [] },
      shadow: { decisions: [{ candidate_id: "candidates.alpha[0]", action: "merge", target_hash: deployB }], gaps: [] },
    });
    await runVerifier({ paths, date: today(), caller, scope: "neighbors", shadow: true });
    // Shadow is meaningless when V already reads neighbours: one shard call, then the brief.
    expect(calls.map((c) => c.kind)).toEqual(["shadow", "brief"]);
    const shard = calls[0]!;
    expect(shard.userContent).toContain(deployA);
    expect(shard.userContent).toContain(deployB);
    // The candidate shares no word with the billing entries, so none is shown.
    expect(shard.userContent).not.toContain("billing ledger rule");
    expect(existsSync(join(paths.memoryRunsDir, today(), "verify-shadow.json"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Retire end to end
// ---------------------------------------------------------------------------

describe("retire", () => {
  test("V's retire moves the entry to archive.md through Pass F, and search finds it", async () => {
    const { paths } = await home("hive-retire-");
    const { deployA } = await seedCanon(paths);
    await appendCandidate(paths, "alpha", { type: "fact", content: "deploys moved off fly to render in November" });
    const { caller, calls } = routedCaller({
      full: {
        decisions: [{ candidate_id: "candidates.alpha[0]", action: "accept" }],
        gaps: [],
        retirements: [
          { target_hash: deployA, reason: "stale", evidence: "candidates.alpha[0]", note: "deploys left fly" },
          { target_hash: "deadbeef", reason: "stale", evidence: "candidates.alpha[0]" },
          { target_hash: deployA, reason: "unused", evidence: "x" },
        ],
      },
      shadow: new Error("unused"),
    });

    const result = await runVerifier({ paths, date: today(), caller, retire: true });
    expect(calls[0]!.systemPrompt).toContain("# Retire (optional third job)");
    expect(result.output.retirements).toEqual([
      { target_hash: deployA, reason: "stale", evidence: "candidates.alpha[0]", note: "deploys left fly", project: "alpha" },
    ]);
    expect(result.output.retirement_errors).toEqual([
      expect.stringContaining("reason must be one of"),
      expect.stringContaining("deadbeef names an entry the call was not shown"),
    ]);

    const applied = await applyDecisions({ paths, date: today() });
    expect(applied.totals.retired).toBe(1);
    expect(applied.errors).toEqual([]);

    const knowledge = await Bun.file(knowledgePath(paths, "alpha")).text();
    expect(knowledge).not.toContain("deploys run from the main branch via fly");
    expect(knowledge).toContain("deploys moved off fly to render");
    const [archived] = await readArchive(paths, "alpha");
    expect(archived).toMatchObject({ hash: deployA, kind: "retired", reason: "stale" });
    expect(archived!.note).toBe("candidates.alpha[0]: deploys left fly");
    expect((await readMeta(paths, "alpha")).entries[deployA]).toBeUndefined();

    const { results } = await searchMemory(paths, "alpha", "main branch fly");
    expect(results.find((r) => r.hash === deployA)?.source).toBe("archive");

    // The briefing footer counts it.
    expect(await Bun.file(result.artifacts.briefingPath).text()).toContain("Retired: 1.");
  });

  test("a retire whose target a decision supersedes tonight is skipped", async () => {
    const { paths } = await home("hive-retire-skip-");
    const { deployA } = await seedCanon(paths);
    await appendCandidate(paths, "alpha", { type: "fact", content: "deploys run from main via fly v2" });
    const { caller } = routedCaller({
      full: {
        decisions: [{ candidate_id: "candidates.alpha[0]", action: "supersede", target_hash: deployA }],
        gaps: [],
        retirements: [{ target_hash: deployA, reason: "stale", evidence: "candidates.alpha[0]" }],
      },
      shadow: new Error("unused"),
    });
    await runVerifier({ paths, date: today(), caller, retire: true });
    const applied = await applyDecisions({ paths, date: today(), archiveSuperseded: true });
    expect(applied.totals.superseded).toBe(1);
    expect(applied.totals.retired).toBe(0);
    expect(applied.errors).toEqual([]);
    // The supersede archived the old line itself.
    const archived = await readArchive(paths, "alpha");
    expect(archived.map((a) => [a.hash, a.kind])).toEqual([[deployA, "superseded"]]);
    const skipped = await Bun.file(join(paths.memoryRunsDir, today(), "retirements.skipped.log")).text();
    expect(skipped).toContain(`retire ${deployA} skipped`);
  });

  test("with retire off, the prompt has no retire job and retirements are ignored", async () => {
    const { paths } = await home("hive-retire-off-");
    const { deployA } = await seedCanon(paths);
    await appendCandidate(paths, "alpha", { type: "fact", content: "deploys use render" });
    const { caller, calls } = routedCaller({
      full: {
        decisions: [{ candidate_id: "candidates.alpha[0]", action: "accept" }],
        gaps: [],
        retirements: [{ target_hash: deployA, reason: "stale", evidence: "candidates.alpha[0]" }],
      },
      shadow: new Error("unused"),
    });
    const result = await runVerifier({ paths, date: today(), caller, retire: false });
    expect(calls[0]!.systemPrompt).not.toContain("Retire");
    expect(result.output.retirements).toBeUndefined();
    const decisions = JSON.parse(await Bun.file(result.artifacts.decisionsPath).text());
    expect(decisions.retirements).toBeUndefined();
    await applyDecisions({ paths, date: today() });
    expect(await readArchive(paths, "alpha")).toEqual([]);
  });
});

describe("parseRetirements", () => {
  test("keeps the well-formed ones and names each dropped one", () => {
    const r = parseRetirements([
      { target_hash: "aaaa1111", reason: "trivia", evidence: "B.alpha[0]" },
      { target_hash: "bbbb2222", reason: "trivia" },
      { reason: "stale", evidence: "x" },
      "junk",
    ]);
    expect(r.retirements).toEqual([{ target_hash: "aaaa1111", reason: "trivia", evidence: "B.alpha[0]" }]);
    expect(r.errors.length).toBe(3);
    expect(parseRetirements("nope").errors).toEqual(["retirements is not an array"]);
  });

  test("a bad retirement never fails schema validation", () => {
    const v = validateVerifierOutput(
      { decisions: [], gaps: [], retirements: [{ target_hash: 1 }] },
      { requireBriefing: false },
    );
    expect("error" in v).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Comparison and the multi-night summary
// ---------------------------------------------------------------------------

describe("compareShard", () => {
  const canon = { totalEntries: 10, totalBytes: 1000, shownEntries: 4, shownBytes: 400 };

  test("separates action and target disagreements and checks target scope", () => {
    const report = compareShard({
      projectId: "alpha",
      canon,
      neighborScope: new Set(["t1", "t2"]),
      fullDecisions: [
        { candidate_id: "B.alpha[0]", action: "supersede", target_hash: "t1" },
        { candidate_id: "B.alpha[1]", action: "merge", target_hash: "t9" },
        { candidate_id: "B.alpha[2]", action: "reject", reason: "duplicate" },
        { candidate_id: "B.alpha[3]", action: "reject", reason: "duplicate" },
        { candidate_id: "B.alpha[4]", action: "accept" },
        { candidate_id: "B.alpha[5]", action: "accept" },
      ],
      neighborDecisions: [
        { candidate_id: "B.alpha[0]", action: "supersede", target_hash: "t1" },
        { candidate_id: "B.alpha[1]", action: "merge", target_hash: "t2" },
        { candidate_id: "B.alpha[2]", action: "merge", target_hash: "t2" },
        { candidate_id: "B.alpha[3]", action: "reject", reason: "duplicate" },
        { candidate_id: "B.alpha[4]", action: "reject", reason: "duplicate" },
      ],
      fullRetirements: [{ target_hash: "t1", reason: "stale", evidence: "x" }],
      neighborRetirements: [
        { target_hash: "t1", reason: "stale", evidence: "x" },
        { target_hash: "t2", reason: "trivia", evidence: "y" },
      ],
    });
    expect(report.rows.map((r) => r.outcome)).toEqual(["agree", "target", "action", "agree", "action", "missing"]);
    expect(report.rows[1]!.fullTargetInScope).toBe(false);
    expect(report.counts).toMatchObject({
      candidates: 6,
      agree: 2,
      actionDiffers: 2,
      targetDiffers: 1,
      missing: 1,
      fullTargets: 2,
      fullTargetsInScope: 1,
      dupRejects: 2,
      dupRejectsLeaked: 0,
      dupRejectsHeldOtherwise: 1,
      neighborOnlyDupRejects: 1,
      retiresFull: 1,
      retiresNeighbor: 2,
      retiresBoth: 1,
    });
    expect(report.matrix).toEqual({
      "supersede>supersede": 1,
      "merge>merge": 1,
      "reject>merge": 1,
      "reject>reject": 1,
      "accept>reject": 1,
      "accept>none": 1,
    });
  });
});

describe("shadow summary over nights", () => {
  test("totals the last N nights and lists duplicate leaks", async () => {
    const { paths } = await home("hive-shadow-sum-");
    const night = (date: string, leak: boolean): ShadowNight => {
      const p = compareShard({
        projectId: "alpha",
        canon: { totalEntries: 10, totalBytes: 1000, shownEntries: 4, shownBytes: 400 },
        neighborScope: new Set(),
        fullDecisions: [{ candidate_id: "B.alpha[0]", action: "reject", reason: "duplicate" }],
        neighborDecisions: [{ candidate_id: "B.alpha[0]", action: leak ? "accept" : "reject", reason: "duplicate" }],
        contentById: new Map([["B.alpha[0]", `the candidate on ${date}`]]),
      });
      return { version: 1, date, k: 20, projects: [p], totals: p.counts, usage: { inputTokens: 1, outputTokens: 1, totalUsd: 0.5 } };
    };
    for (const [d, leak] of [["2026-11-20", false], ["2026-11-21", true], ["2026-11-22", false]] as const) {
      await mkdir(join(paths.memoryRunsDir, d), { recursive: true });
      await Bun.write(join(paths.memoryRunsDir, d, "verify-shadow.json"), JSON.stringify(night(d, leak)));
    }
    const nights = await loadShadowNights(paths, "2026-11-22", 2);
    expect(nights.map((n) => n.date)).toEqual(["2026-11-21", "2026-11-22"]);
    const text = summarizeShadowNights(nights);
    expect(text).toContain("2 night(s), 2026-11-21 to 2026-11-22");
    expect(text).toContain("1/2 candidates decided alike");
    expect(text).toContain("duplicate rejects 2: 1 accepted by neighbour V");
    expect(text).toContain("Shadow cost: $1.00");
    expect(text).toContain("2026-11-21 B.alpha[0]: the candidate on 2026-11-21");
    expect(summarizeShadowNights([])).toContain("HIVE_VERIFY_SHADOW=on");
  });
});
