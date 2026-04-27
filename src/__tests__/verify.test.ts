import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseVerifierJson,
  validateVerifierOutput,
  serializeProjectCanon,
  buildVerifierUserContent,
  callVerifier,
  runVerifier,
  refineBriefing,
  tallyBriefingCounts,
  type VerifierDecision,
} from "../lib/verify";
import {
  estimateCost,
  rateForModel,
  formatUsd,
  loadUsageSummary,
  appendUsageRecord,
} from "../lib/pricing";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { appendProjectMemory, entryHash } from "../lib/memory";
import { buildConditionReport, writeConditionReport } from "../lib/condition";
import type { ModelCaller } from "../lib/extract";

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe("pricing — rate table + cost math", () => {
  test("known model returns rate", () => {
    expect(rateForModel("claude-sonnet-4-6")?.inputPerMTok).toBe(3);
    expect(rateForModel("claude-opus-4-7")?.outputPerMTok).toBe(75);
  });

  test("unknown model returns null", () => {
    expect(rateForModel("imaginary-model-9000")).toBeNull();
  });

  test("estimateCost computes input+output USD correctly", () => {
    const cost = estimateCost({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
    });
    expect(cost.inputUsd).toBeCloseTo(3, 5);
    expect(cost.outputUsd).toBeCloseTo(7.5, 5);
    expect(cost.totalUsd).toBeCloseTo(10.5, 5);
    expect(cost.modelKnown).toBe(true);
  });

  test("estimateCost on unknown model returns zeros + flag", () => {
    const cost = estimateCost({
      provider: "anthropic",
      model: "ghost",
      inputTokens: 1000,
      outputTokens: 1000,
    });
    expect(cost.modelKnown).toBe(false);
    expect(cost.totalUsd).toBe(0);
  });

  test("formatUsd scales precision by magnitude", () => {
    expect(formatUsd(0.0023)).toBe("$0.0023");
    expect(formatUsd(0.123)).toBe("$0.123");
    expect(formatUsd(2.5)).toBe("$2.50");
  });
});

// ---------------------------------------------------------------------------
// Usage aggregation
// ---------------------------------------------------------------------------

describe("usage summary aggregation", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-usage-"));
    paths = await ensureHiveScaffold(home);
  });

  test("missing summary returns zeros", async () => {
    const summary = await loadUsageSummary(paths, "2026-04-26");
    expect(summary.totals.totalUsd).toBe(0);
    expect(summary.records).toEqual([]);
  });

  test("appendUsageRecord accumulates across passes", async () => {
    const date = "2026-04-26";
    await appendUsageRecord(paths, date, {
      pass: "B",
      project: "alpha",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      inputTokens: 10_000,
      outputTokens: 1_000,
      durationMs: 200,
      cost: estimateCost({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 10_000,
        outputTokens: 1_000,
      }),
    });
    await appendUsageRecord(paths, date, {
      pass: "V",
      provider: "anthropic",
      model: "claude-opus-4-6",
      inputTokens: 50_000,
      outputTokens: 5_000,
      durationMs: 1000,
      cost: estimateCost({
        provider: "anthropic",
        model: "claude-opus-4-6",
        inputTokens: 50_000,
        outputTokens: 5_000,
      }),
    });

    const summary = await loadUsageSummary(paths, date);
    expect(summary.records.length).toBe(2);
    expect(summary.totals.inputTokens).toBe(60_000);
    expect(summary.totals.outputTokens).toBe(6_000);
    // B: 10k * $3/Mtok + 1k * $15/Mtok = $0.045
    // V: 50k * $15/Mtok + 5k * $75/Mtok = $1.125
    expect(summary.totals.totalUsd).toBeCloseTo(1.17, 5);
  });
});

// ---------------------------------------------------------------------------
// Hash-serialized canon
// ---------------------------------------------------------------------------

describe("serializeProjectCanon", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-canon-"));
    paths = await ensureHiveScaffold(home);
  });

  test("emits each entry with its entryHash and type", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "Use Joken for JWT", ["auth"]);
    await appendProjectMemory(paths, "alpha", "convention", "Stage files by name");
    await appendProjectMemory(paths, "alpha", "decision", "Prefer Bun over Node");
    await appendProjectMemory(paths, "alpha", "question", "Should we cache layers?");

    const canon = await serializeProjectCanon(paths, "alpha");
    expect(canon.facts.length).toBe(1);
    expect(canon.facts[0]?.hash).toBe(entryHash("Use Joken for JWT"));
    expect(canon.facts[0]?.type).toBe("fact");
    expect(canon.facts[0]?.tags).toEqual(["auth"]);

    expect(canon.decisions[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(canon.questions[0]?.text).toBe("Should we cache layers?");
  });

  test("missing project returns empty arrays", async () => {
    const canon = await serializeProjectCanon(paths, "ghost");
    expect(canon.facts).toEqual([]);
    expect(canon.conventions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Verifier JSON parse + schema validation
// ---------------------------------------------------------------------------

describe("parseVerifierJson", () => {
  test("parses object directly", () => {
    expect(parseVerifierJson(`{"a":1}`)).toEqual({ a: 1 });
  });

  test("strips ```json fences", () => {
    expect(parseVerifierJson("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });

  test("falls back to brace extraction with surrounding prose", () => {
    expect(parseVerifierJson("Here you go: {\"a\":1} cheers")).toEqual({ a: 1 });
  });

  test("throws on unparseable", () => {
    expect(() => parseVerifierJson("nope")).toThrow();
  });
});

const validOutput = {
  decisions: [
    { candidate_id: "B.alpha[0]", action: "accept" },
    {
      candidate_id: "B.alpha[1]",
      action: "supersede",
      target_hash: "abcdef12",
    },
    {
      candidate_id: "B.alpha[2]",
      action: "merge",
      target_hash: "12345678",
      added_tags: ["auth"],
    },
    {
      candidate_id: "C[0]",
      action: "reject",
      reason: "cite_unverifiable",
    },
  ],
  gaps: [{ subject: "alpha", observation: "missed X", source: "topRanked[5]" }],
  taste: {
    reinforced: [{ principle: "ship multi-subsystem in layers", evidence: "saw it" }],
    corrections: [],
  },
  briefing_markdown: "# HIVE — 2026-04-26\n\n## Headline\nA tight day.\n",
};

describe("validateVerifierOutput", () => {
  test("accepts a fully-formed output", () => {
    const v = validateVerifierOutput(validOutput);
    if ("error" in v) throw new Error(`Unexpected error: ${v.error}`);
    expect(v.decisions.length).toBe(4);
    expect(v.gaps.length).toBe(1);
    expect(v.briefing_markdown).toContain("Headline");
  });

  test("rejects output missing decisions array", () => {
    const v = validateVerifierOutput({ ...validOutput, decisions: undefined });
    expect(v).toEqual({ error: expect.stringContaining("decisions") });
  });

  test("rejects supersede without target_hash", () => {
    const v = validateVerifierOutput({
      ...validOutput,
      decisions: [{ candidate_id: "x", action: "supersede" }],
      gaps: [],
    });
    expect(v).toEqual({ error: expect.stringContaining("target_hash") });
  });

  test("rejects reject without reason", () => {
    const v = validateVerifierOutput({
      ...validOutput,
      decisions: [{ candidate_id: "x", action: "reject" }],
      gaps: [],
    });
    expect(v).toEqual({ error: expect.stringContaining("reason") });
  });

  test("rejects empty briefing_markdown", () => {
    const v = validateVerifierOutput({ ...validOutput, briefing_markdown: "  " });
    expect(v).toEqual({ error: expect.stringContaining("briefing_markdown") });
  });
});

// ---------------------------------------------------------------------------
// User content assembly
// ---------------------------------------------------------------------------

describe("buildVerifierUserContent", () => {
  test("includes condition, principles, per-project blocks, and C candidates", () => {
    const content = buildVerifierUserContent({
      date: "2026-04-26",
      condition: {
        date: "2026-04-26",
        generatedAt: "x",
        hoursWindow: 24,
        trivial: false,
        trivialReason: null,
        projects: [],
        totals: {
          projectCount: 0,
          sessionCount: 0,
          exchangeCount: 0,
          commitCount: 0,
          ticketsMoved: 0,
        },
      },
      principlesText: "## Principles\n- ship in layers",
      perProject: [
        {
          projectId: "alpha",
          canon: {
            projectId: "alpha",
            facts: [{ hash: "abcd1234", type: "fact", text: "Existing fact", tags: [] }],
            conventions: [],
            decisions: [],
            questions: [],
          },
          midSessionCandidates: [],
          inboxText: "",
          bCandidates: [
            { type: "fact", content: "new fact", tags: [], provenance: "session-x" },
          ],
        },
      ],
      cCandidates: [
        { subject: "greg", content: "Greg likes terse", tags: [], provenance: "global" },
      ],
    });

    expect(content).toContain("Pass V — Verify");
    expect(content).toContain("ship in layers");
    expect(content).toContain("Project: alpha");
    expect(content).toContain('"hash": "abcd1234"');
    expect(content).toContain("B.alpha[0]");
    expect(content).toContain("C[0]");
  });
});

// ---------------------------------------------------------------------------
// callVerifier with stubbed Opus + end-to-end run
// ---------------------------------------------------------------------------

function stubCaller(text: string): ModelCaller {
  return async () =>
    ({
      provider: "anthropic",
      model: "claude-opus-4-6",
      text,
      inputTokens: 5000,
      outputTokens: 800,
      totalTokens: 5800,
      durationMs: 1234,
      raw: { content: [{ type: "text", text }] } as never,
    });
}

describe("callVerifier", () => {
  test("returns parsed output + cost on a clean response", async () => {
    const caller = stubCaller(JSON.stringify(validOutput));
    const result = await callVerifier("system", "user", caller);
    expect(result.output.decisions.length).toBe(4);
    expect(result.cost.modelKnown).toBe(true);
    expect(result.cost.totalUsd).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBe(5000);
  });

  test("throws on schema violations with descriptive error", async () => {
    const caller = stubCaller(`{"decisions": "not an array"}`);
    await expect(callVerifier("s", "u", caller)).rejects.toThrow(/Verifier output failed schema/);
  });
});

// ---------------------------------------------------------------------------
// Briefing refinement — deterministic post-processing
// ---------------------------------------------------------------------------

describe("tallyBriefingCounts", () => {
  test("counts accepts as added unless candidate is a reflection (C[*])", () => {
    const decisions: VerifierDecision[] = [
      { candidate_id: "B.alpha[0]", action: "accept" },
      { candidate_id: "B.alpha[1]", action: "accept" },
      { candidate_id: "B.bravo[0]", action: "accept" },
      { candidate_id: "candidates.alpha[0]", action: "accept" },
      { candidate_id: "C[0]", action: "accept" },
      { candidate_id: "C[1]", action: "accept" },
      { candidate_id: "C[2]", action: "accept" },
      { candidate_id: "B.alpha[2]", action: "supersede", target_hash: "abcd1234" },
      { candidate_id: "C[3]", action: "reject", reason: "duplicate" },
    ];
    const counts = tallyBriefingCounts(decisions);
    expect(counts.added).toBe(4);
    expect(counts.superseded).toBe(1);
    expect(counts.reflections).toBe(3);
  });

  test("merges and rejects don't count toward added", () => {
    const decisions: VerifierDecision[] = [
      { candidate_id: "B.alpha[0]", action: "merge", target_hash: "abcd1234" },
      { candidate_id: "B.alpha[1]", action: "reject", reason: "low_signal" },
    ];
    const counts = tallyBriefingCounts(decisions);
    expect(counts.added).toBe(0);
    expect(counts.superseded).toBe(0);
    expect(counts.reflections).toBe(0);
  });
});

describe("refineBriefing", () => {
  const baseBriefing = `# HIVE — 2026-04-27

## Headline
Quiet day.

## Memory + verifier
- Added: 11 entries. Superseded: 0. Reflections: 2.
- Taste: reinforced *foo*
- Verifier flags: 3 gaps`;

  test("rewrites the Added/Superseded/Reflections line with deterministic counts", () => {
    const decisions: VerifierDecision[] = [
      { candidate_id: "B.a[0]", action: "accept" },
      { candidate_id: "B.a[1]", action: "accept" },
      { candidate_id: "C[0]", action: "accept" },
      { candidate_id: "C[1]", action: "accept" },
      { candidate_id: "C[2]", action: "accept" },
      { candidate_id: "B.a[2]", action: "supersede", target_hash: "1d2e90e0" },
    ];
    const out = refineBriefing(baseBriefing, decisions, []);
    expect(out).toContain("- Added: 2 entries. Superseded: 1. Reflections: 3.");
    expect(out).not.toContain("Added: 11 entries");
  });

  test("appends a Memory + verifier footer when none exists", () => {
    const briefing = "# HIVE\n\n## Headline\nNo footer here.";
    const out = refineBriefing(briefing, [{ candidate_id: "B.a[0]", action: "accept" }], []);
    expect(out).toContain("## Memory + verifier");
    expect(out).toContain("- Added: 1 entries. Superseded: 0. Reflections: 0.");
  });

  test("injects a Verifier flags section when gaps exist and none is already present", () => {
    const out = refineBriefing(
      baseBriefing,
      [],
      [
        { subject: "alpha", observation: "Sonnet missed X", source: "topRanked[5]" },
        { subject: "system", observation: "Heartbeat slow", source: "inbox" },
      ],
    );
    expect(out).toContain("## Verifier flags");
    expect(out).toContain("- **alpha** — Sonnet missed X");
    expect(out).toContain("- **system** — Heartbeat slow");
  });

  test("rewrites a stale 'Verifier flags: 3 gaps' line to deterministic value", () => {
    const briefing = `# HIVE\n\n## Memory + verifier\n- Added: 0 entries. Superseded: 0. Reflections: 0.\n- Verifier flags: 3 gaps`;
    const out = refineBriefing(briefing, [], []);
    expect(out).toContain("- Verifier flags: none");
    expect(out).not.toContain("- Verifier flags: 3 gaps");
  });

  test("rewrites stale flags line and injects section when gaps exist", () => {
    const briefing = `# HIVE\n\n## Memory + verifier\n- Added: 1 entries. Superseded: 0. Reflections: 0.\n- Verifier flags: none`;
    const out = refineBriefing(briefing, [{ candidate_id: "B.a[0]", action: "accept" }], [
      { subject: "alpha", observation: "missed X", source: "topRanked[5]" },
    ]);
    expect(out).toContain("- Verifier flags: 1 (see section below)");
    expect(out).toContain("## Verifier flags");
    expect(out).toContain("- **alpha** — missed X");
    expect(out).not.toContain("- Verifier flags: none");
  });

  test("inserts flags line when missing", () => {
    const briefing = `# HIVE\n\n## Memory + verifier\n- Added: 0 entries. Superseded: 0. Reflections: 0.`;
    const out = refineBriefing(briefing, [], []);
    expect(out).toContain("- Verifier flags: none");
  });

  test("does not duplicate Verifier flags section if briefing already has one", () => {
    const briefing = `${baseBriefing}\n\n## Verifier flags\n- existing flag`;
    const out = refineBriefing(briefing, [], [
      { subject: "alpha", observation: "ignored", source: "x" },
    ]);
    const matches = out.match(/^## Verifier flags/gm);
    expect(matches?.length).toBe(1);
    expect(out).toContain("- existing flag");
    expect(out).not.toContain("Sonnet missed X");
  });

  test("no gaps → no Verifier flags section appended", () => {
    const out = refineBriefing(baseBriefing, [], []);
    expect(out).not.toContain("## Verifier flags");
  });
});

describe("runVerifier (end-to-end with synthetic home)", () => {
  test("writes decisions/gaps/taste/briefing + appends usage record", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-verify-e2e-"));
    const paths = await ensureHiveScaffold(home);

    // Register a project with a tiny canon
    await mkdir(join(home, "projects", "alpha"), { recursive: true });
    await writeFile(
      join(home, "projects", "alpha", "config.md"),
      "---\nname: alpha\npath: /tmp/nope\n---\n",
    );
    await appendProjectMemory(paths, "alpha", "fact", "existing fact", ["a"]);

    // Pass A condition
    const report = await buildConditionReport(paths);
    await writeConditionReport(paths, report);

    // Pass B + C artifacts can be empty/absent — verify still runs.
    const today = new Date().toISOString().slice(0, 10);
    const result = await runVerifier({
      paths,
      date: today,
      caller: stubCaller(JSON.stringify(validOutput)),
    });

    expect(result.artifacts.briefingPath).toContain("briefing.md");
    expect(result.artifacts.decisionsPath).toContain("decisions.json");
    expect(result.artifacts.usagePath).toContain("usage.json");

    const briefing = await Bun.file(result.artifacts.briefingPath).text();
    expect(briefing).toContain("HIVE");

    const decisions = JSON.parse(await Bun.file(result.artifacts.decisionsPath).text());
    expect(decisions.decisions.length).toBe(4);

    const usage = await loadUsageSummary(paths, today);
    expect(usage.records.length).toBe(1);
    expect(usage.records[0]?.pass).toBe("V");
    expect(usage.totals.totalUsd).toBeGreaterThan(0);
  });
});
