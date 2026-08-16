import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseVerifierJson,
  validateVerifierOutput,
  serializeProjectCanon,
  buildBrieferSystemPrompt,
  buildProjectVerifierSystemPrompt,
  buildProjectVerifierUserContent,
  buildBriefingUserContent,
  blockHasCandidates,
  digestShardDecisions,
  estimatePromptTokens,
  assertPromptFits,
  loadVerifierBundle,
  callVerifier,
  runVerifier,
  refineBriefing,
  tallyBriefingCounts,
  VERIFY_WINDOW_TOKENS,
  type VerifierDecision,
  type ProjectVerifierBlock,
} from "../lib/verify";
import {
  estimateCost,
  rateForModel,
  formatUsd,
  loadUsageSummary,
  appendUsageRecord,
} from "../lib/pricing";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { appendCandidate, appendProjectMemory, entryHash } from "../lib/memory";
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

const emptyCondition = {
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
};

function alphaBlock(overrides: Partial<ProjectVerifierBlock> = {}): ProjectVerifierBlock {
  return {
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
    bCandidates: [{ type: "fact", content: "new fact", tags: [], provenance: "session-x" }],
    ...overrides,
  };
}

describe("buildProjectVerifierUserContent", () => {
  test("carries one project's canon, principles, and candidate ids", () => {
    const content = buildProjectVerifierUserContent(
      "2026-04-26",
      "## Principles\n- ship in layers",
      alphaBlock({
        midSessionCandidates: [
          {
            type: "convention",
            content: "mid fact",
            tags: [],
            provenance: "session-y",
            writtenAt: "2026-04-26T00:00:00Z",
          },
        ],
      }),
    );

    expect(content).toContain("Pass V — Verify");
    expect(content).toContain("project: alpha");
    expect(content).toContain("ship in layers");
    expect(content).toContain('"hash": "abcd1234"');
    expect(content).toContain("B.alpha[0]");
    expect(content).toContain("candidates.alpha[0]");
  });

  test("carries no other project and no briefing ask", () => {
    const content = buildProjectVerifierUserContent("2026-04-26", "", alphaBlock());
    expect(content).not.toContain("bravo");
    expect(content).not.toContain("Conditioning report");
    expect(content).toContain("No briefing.");
  });
});

describe("buildBriefingUserContent", () => {
  test("carries condition, inboxes, digest, and C candidates — but no canon", () => {
    const content = buildBriefingUserContent({
      date: "2026-04-26",
      condition: emptyCondition,
      inboxes: [
        { projectId: "alpha", inboxText: "- watch found a stale lock" },
        { projectId: "bravo", inboxText: "   " },
      ],
      cCandidates: [
        { subject: "greg", content: "Greg likes terse", tags: [], provenance: "global" },
      ],
      digest: [
        {
          candidate_id: "B.alpha[0]",
          action: "accept",
          project: "alpha",
          type: "fact",
          content: "new fact",
        },
      ],
      shardGaps: [{ subject: "alpha", observation: "missed X", source: "topRanked[5]" }],
      principlesText: "## Principles\n- ship in layers",
    });

    expect(content).toContain("Conditioning report");
    expect(content).toContain("stale lock");
    expect(content).toContain("C[0]");
    expect(content).toContain("new fact");
    expect(content).toContain("missed X");
    // Canon never reaches the briefer — it cites no hashes.
    expect(content).not.toContain("abcd1234");
    // An empty inbox isn't rendered as its own section.
    expect(content).toContain("1 with content");
  });
});

describe("blockHasCandidates", () => {
  test("canon alone does not earn a verifier call", () => {
    expect(blockHasCandidates(alphaBlock({ bCandidates: [] }))).toBe(false);
    expect(blockHasCandidates(alphaBlock())).toBe(true);
    expect(
      blockHasCandidates(
        alphaBlock({
          bCandidates: [],
          midSessionCandidates: [
            {
              type: "fact",
              content: "x",
              tags: [],
              provenance: "p",
              writtenAt: "2026-04-26T00:00:00Z",
            },
          ],
        }),
      ),
    ).toBe(true);
  });
});

describe("digestShardDecisions", () => {
  test("resolves each decision back to the candidate text it acted on", () => {
    const block = alphaBlock({
      midSessionCandidates: [
        {
          type: "convention",
          content: "mid convention",
          tags: [],
          provenance: "p",
          writtenAt: "2026-04-26T00:00:00Z",
        },
      ],
    });
    const digest = digestShardDecisions(block, [
      { candidate_id: "B.alpha[0]", action: "accept" },
      { candidate_id: "candidates.alpha[0]", action: "reject", reason: "trivial" },
    ]);

    expect(digest).toEqual([
      {
        candidate_id: "B.alpha[0]",
        action: "accept",
        project: "alpha",
        type: "fact",
        content: "new fact",
      },
      {
        candidate_id: "candidates.alpha[0]",
        action: "reject",
        project: "alpha",
        type: "convention",
        content: "mid convention",
      },
    ]);
  });

  test("an unresolvable id still digests, without inventing content", () => {
    const digest = digestShardDecisions(alphaBlock(), [
      { candidate_id: "B.alpha[9]", action: "accept" },
    ]);
    expect(digest).toEqual([
      { candidate_id: "B.alpha[9]", action: "accept", project: "alpha" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Prompt budget — the guard that turns an over-window prompt from a 0-token
// mystery envelope into a legible failure (TK-137)
// ---------------------------------------------------------------------------

describe("prompt budget", () => {
  test("estimate is conservative against the measured 2026-07-25 bundle", () => {
    // 734,495 chars measured 222,086 real tokens. The estimator must not
    // under-report, or the guard passes a prompt the API will reject.
    const chars = 734_495;
    const estimated = estimatePromptTokens("", "x".repeat(chars));
    expect(estimated).toBeGreaterThanOrEqual(222_086);
  });

  test("assertPromptFits passes a small prompt", () => {
    expect(() => assertPromptFits("V.alpha", "sys", "user")).not.toThrow();
  });

  test("assertPromptFits names the call and the overage", () => {
    const huge = "x".repeat(VERIFY_WINDOW_TOKENS * 4);
    expect(() => assertPromptFits("V.revrec", "sys", huge)).toThrow(/V\.revrec prompt is ~\d+k tokens/);
    expect(() => assertPromptFits("V.revrec", "sys", huge)).toThrow(/outgrown a single call/);
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

/** A caller that answers each call in sequence and records what it was asked. */
function scriptedCaller(texts: string[]): {
  caller: ModelCaller;
  calls: Array<{ systemPrompt: string; userContent: string }>;
} {
  const calls: Array<{ systemPrompt: string; userContent: string }> = [];
  const caller: ModelCaller = async (input) => {
    const text = texts[calls.length] ?? texts[texts.length - 1]!;
    calls.push({ systemPrompt: input.systemPrompt, userContent: input.userContent });
    return {
      provider: "anthropic",
      model: "claude-opus-4-8",
      text,
      inputTokens: 5000,
      outputTokens: 800,
      totalTokens: 5800,
      durationMs: 1234,
      raw: { content: [{ type: "text", text }] } as never,
    };
  };
  return { caller, calls };
}

const shardOutput = {
  decisions: [
    { candidate_id: "candidates.alpha[0]", action: "accept" },
  ],
  gaps: [{ subject: "alpha", observation: "missed X", source: "topRanked[5]" }],
};

const briefOutput = {
  decisions: [{ candidate_id: "C[0]", action: "reject", reason: "cite_unverifiable" }],
  gaps: [{ subject: "greg", observation: "cross-project pattern", source: "C[1]" }],
  briefing_markdown: "# HIVE — 2026-04-26\n\n## Headline\nA tight day.\n",
};

async function syntheticHome(prefix: string) {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const paths = await ensureHiveScaffold(home);
  await mkdir(join(home, "projects", "alpha"), { recursive: true });
  await writeFile(
    join(home, "projects", "alpha", "config.md"),
    "---\nname: alpha\npath: /tmp/nope\n---\n",
  );
  await appendProjectMemory(paths, "alpha", "fact", "existing fact", ["a"]);
  const report = await buildConditionReport(paths);
  await writeConditionReport(paths, report);
  return { home, paths };
}

describe("loadVerifierBundle", () => {
  test("an inbox-only project joins the bundle without its canon", async () => {
    // The briefer needs the inbox text; it never cites a target_hash. Reading
    // and serializing the canon for it is pure cost — revrec's alone is 183KB.
    const { home, paths } = await syntheticHome("hive-verify-bundle-");
    await writeFile(
      join(home, "projects", "alpha", "inbox.md"),
      "# Inbox: alpha\n\n- watch found a stale lock\n",
    );

    const report = await buildConditionReport(paths);
    await writeConditionReport(paths, report);
    const today = new Date().toISOString().slice(0, 10);
    const bundle = await loadVerifierBundle(paths, today);

    const alpha = bundle.perProject.find((p) => p.projectId === "alpha");
    expect(alpha).toBeDefined();
    expect(alpha!.inboxText).toContain("stale lock");
    expect(alpha!.canon.facts).toEqual([]);
    expect(blockHasCandidates(alpha!)).toBe(false);
  });

  test("a project with candidates gets its canon serialized", async () => {
    const { paths } = await syntheticHome("hive-verify-bundle-canon-");
    await appendCandidate(paths, "alpha", { type: "fact", content: "a pending fact" });

    const today = new Date().toISOString().slice(0, 10);
    const bundle = await loadVerifierBundle(paths, today);

    const alpha = bundle.perProject.find((p) => p.projectId === "alpha");
    expect(alpha!.canon.facts.map((f) => f.text)).toEqual(["existing fact"]);
    expect(blockHasCandidates(alpha!)).toBe(true);
  });

  test("a project with neither candidates nor inbox is left out entirely", async () => {
    const { paths } = await syntheticHome("hive-verify-bundle-skip-");
    const today = new Date().toISOString().slice(0, 10);
    const bundle = await loadVerifierBundle(paths, today);
    expect(bundle.perProject).toEqual([]);
  });

  test("a legacy Pass F tombstone does not put a project in the bundle", async () => {
    const { home, paths } = await syntheticHome("hive-verify-bundle-tombstone-");
    await writeFile(
      join(home, "projects", "alpha", "inbox.md"),
      "# Inbox: alpha\n\n_Truncated by Pass F at 2026-08-14T02:00:00.000Z_\n",
    );

    const today = new Date().toISOString().slice(0, 10);
    const bundle = await loadVerifierBundle(paths, today);
    expect(bundle.perProject).toEqual([]);
  });
});

describe("runVerifier (end-to-end with synthetic home)", () => {
  test("shards per project with candidates, then briefs", async () => {
    const { paths } = await syntheticHome("hive-verify-e2e-");
    await appendCandidate(paths, "alpha", { type: "fact", content: "a pending fact" });

    const { caller, calls } = scriptedCaller([
      JSON.stringify(shardOutput),
      JSON.stringify(briefOutput),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const result = await runVerifier({ paths, date: today, caller });

    // One call for alpha, one for the brief.
    expect(calls.length).toBe(2);
    expect(result.shardedProjects).toEqual(["alpha"]);
    expect(calls[0]?.userContent).toContain("project: alpha");
    expect(calls[0]?.userContent).toContain("candidates.alpha[0]");
    expect(calls[1]?.userContent).toContain("Conditioning report");
    // The brief sees what the shard decided, not the canon it decided against.
    expect(calls[1]?.userContent).toContain("a pending fact");
    expect(calls[1]?.userContent).toContain("Canon decisions already made (1)");

    // Merged output across both calls.
    expect(result.output.decisions.map((d) => d.candidate_id)).toEqual([
      "candidates.alpha[0]",
      "C[0]",
    ]);
    expect(result.output.gaps.length).toBe(2);

    const decisions = JSON.parse(await Bun.file(result.artifacts.decisionsPath).text());
    expect(decisions.decisions.length).toBe(2);
    const briefing = await Bun.file(result.artifacts.briefingPath).text();
    expect(briefing).toContain("HIVE");

    // One usage row for the pass, summed across both calls.
    const usage = await loadUsageSummary(paths, today);
    expect(usage.records.length).toBe(1);
    expect(usage.records[0]?.pass).toBe("V");
    expect(usage.records[0]?.inputTokens).toBe(10_000);
    expect(usage.records[0]?.outputTokens).toBe(1_600);
    expect(usage.totals.totalUsd).toBeGreaterThan(0);
  });

  test("a project with canon but no candidates gets no verifier call", async () => {
    // The TK-137 regression: canon presence alone used to buy a project a place
    // in the prompt, so nine projects shipped 546KB of canon to decide nothing.
    const { paths } = await syntheticHome("hive-verify-nocand-");

    const { caller, calls } = scriptedCaller([JSON.stringify(briefOutput)]);
    const today = new Date().toISOString().slice(0, 10);
    const result = await runVerifier({ paths, date: today, caller });

    expect(calls.length).toBe(1);
    expect(result.shardedProjects).toEqual([]);
    expect(calls[0]?.userContent).toContain("Conditioning report");
    expect(calls[0]?.userContent).not.toContain("existing fact");
  });

  test("drops briefer decisions that aren't reflections", async () => {
    // The briefer is told C[n] only. If it echoes a project candidate from the
    // digest, Pass F would apply that candidate twice.
    const { paths } = await syntheticHome("hive-verify-echo-");
    await appendCandidate(paths, "alpha", { type: "fact", content: "a pending fact" });

    const echoing = {
      ...briefOutput,
      decisions: [
        { candidate_id: "candidates.alpha[0]", action: "accept" },
        { candidate_id: "C[0]", action: "accept" },
      ],
    };
    const { caller } = scriptedCaller([
      JSON.stringify(shardOutput),
      JSON.stringify(echoing),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const result = await runVerifier({ paths, date: today, caller });

    const ids = result.output.decisions.map((d) => d.candidate_id);
    expect(ids).toEqual(["candidates.alpha[0]", "C[0]"]);
    expect(ids.filter((id) => id === "candidates.alpha[0]").length).toBe(1);
  });

  test("a failed shard aborts the pass — nothing is written for Pass F to apply", async () => {
    // Pass F drains candidates.md for any project that has candidates, decisions
    // or not. A partial V would drain a queue nothing decided on.
    const { paths } = await syntheticHome("hive-verify-partial-");
    await appendCandidate(paths, "alpha", { type: "fact", content: "a pending fact" });

    const today = new Date().toISOString().slice(0, 10);
    const failing: ModelCaller = async () => {
      throw new Error("claude --print exited 1.");
    };
    await expect(runVerifier({ paths, date: today, caller: failing })).rejects.toThrow(
      /exited 1/,
    );

    const decisionsPath = join(paths.memoryRunsDir, today, "decisions.json");
    expect(existsSync(decisionsPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SOUL injection — voice flows from ~/.hive/SOUL.md, not hardcoded adjectives
// ---------------------------------------------------------------------------

describe("buildBrieferSystemPrompt", () => {
  test("returns the bare verifier prompt when SOUL is empty", () => {
    const prompt = buildBrieferSystemPrompt("");
    expect(prompt).toContain("You are the verifier for HIVE's nightly memory pipeline");
    expect(prompt).not.toContain("---\n\n");
  });

  test("trims and prepends SOUL with a separator before the verifier instructions", () => {
    const soul = "  # HIVE Soul\n\nWe are craftsmen.\n  ";
    const prompt = buildBrieferSystemPrompt(soul);
    expect(prompt.startsWith("# HIVE Soul\n\nWe are craftsmen.")).toBe(true);
    expect(prompt).toContain("\n\n---\n\n");
    expect(prompt).toContain("You are the verifier for HIVE's nightly memory pipeline");
    expect(prompt.indexOf("HIVE Soul")).toBeLessThan(prompt.indexOf("You are the verifier"));
  });

  test("does not duplicate hardcoded voice adjectives — voice lives in SOUL only", () => {
    // Regression: earlier the verifier prompt carried inline voice copy
    // ("Tone: sharp, warm, dry"). Voice now lives in SOUL.md so the prompt
    // doesn't drift from the canonical doc.
    const prompt = buildBrieferSystemPrompt("");
    expect(prompt).not.toContain("Tone: sharp, warm, dry");
    expect(prompt).not.toContain("Write in HIVE voice — terse");
  });

  test("the briefer asks for prose; the project verifier explicitly does not", () => {
    expect(buildBrieferSystemPrompt("")).toContain("briefing_markdown");
    const shard = buildProjectVerifierSystemPrompt();
    expect(shard).not.toContain("briefing_markdown");
    expect(shard).toContain("Do not write a briefing");
  });

  test("both prompts share one accept bar", () => {
    const bar = 'Bar for accept: "would this still help a session a month from now?"';
    expect(buildProjectVerifierSystemPrompt()).toContain(bar);
    expect(buildBrieferSystemPrompt("")).toContain(bar);
  });
});

describe("runVerifier — SOUL injection", () => {
  test("the briefing call carries SOUL; the project call doesn't pay for it", async () => {
    const { paths } = await syntheticHome("hive-verify-soul-");
    const soulMarker = "## Voice\n\n- **Dry humor when it's natural.**";
    await writeFile(paths.soul, `# HIVE Soul\n\n${soulMarker}\n`);
    await appendCandidate(paths, "alpha", { type: "fact", content: "a pending fact" });

    const { caller, calls } = scriptedCaller([
      JSON.stringify(shardOutput),
      JSON.stringify(briefOutput),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    await runVerifier({ paths, date: today, caller });

    const brief = calls[1]!.systemPrompt;
    expect(brief).toContain(soulMarker);
    expect(brief.indexOf(soulMarker)).toBeLessThan(brief.indexOf("You are the verifier"));

    // A shard emits decisions, never prose — voice context there is spend
    // against the one budget this pass is short on.
    expect(calls[0]!.systemPrompt).not.toContain(soulMarker);
  });
});
