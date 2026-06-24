import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelCaller } from "./extract";
import { getHivePaths, type HivePaths } from "./paths";
import { runTasteConsolidate, validateCoherenceDecision, type CoherenceDecision } from "./taste-consolidate";
import {
  generalTasteDir,
  projectTasteDir,
  readTasteUnits,
  recordNegative,
  unitHash,
  writeTasteUnit,
} from "./taste-store";
import type { TasteCandidate } from "./taste-types";

const PROJECT = "demo";
const PRINCIPLES = "### Solve the right problem\nFind the why under the ask.\n\n### As simple as possible\nThe best code is the code you didn't write.";

function candidate(over: Partial<TasteCandidate> = {}): TasteCandidate {
  return {
    category: "DESIGN",
    tier: "FUZZY",
    scope: { kind: "project" },
    reasoning: "Trace every consumer of an invariant before relaxing it.",
    delta: { before: "updated one read path", after: "updated all read paths" },
    reason_source: "stated",
    rule_statement: "When relaxing a constraint, update every query that assumed the old cardinality",
    canonical_example: { bad: "deduped one query", good: "grepped all queries" },
    check_sketch: null,
    evidence: [{ anchor: { sessionFile: "s1.jsonl", id: "u1", ts: null }, quote: "this was my miss", confidence: 0.9 }],
    dedupe_key: "trace-all-read-paths",
    provenance: "id=u1",
    ...over,
  };
}

/** A caller that replies with a fixed set of coherence decisions as JSON. */
function stubCaller(decisions: Partial<CoherenceDecision>[]): ModelCaller {
  return async (input) => ({
    provider: input.provider,
    model: input.modelId,
    text: JSON.stringify(decisions),
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
    durationMs: 5,
  });
}

let home: string;
let paths: HivePaths;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "hive-tc-"));
  paths = getHivePaths(home);
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function opts(caller: ModelCaller, over: Record<string, unknown> = {}) {
  return { paths, projectId: PROJECT, caller, principlesText: PRINCIPLES, now: "2026-06-24", ...over };
}

describe("validateCoherenceDecision", () => {
  test("rejects unknown dedupe_keys and coerces fields", () => {
    const known = new Set(["a"]);
    expect(validateCoherenceDecision({ dedupe_key: "ghost", coherence: "orthogonal" }, known)).toBeNull();
    const d = validateCoherenceDecision(
      { dedupe_key: "a", coherence: "instantiates", ladders_up_to: "Solve the right problem", human_confirmed: true },
      known,
    );
    expect(d?.coherence).toBe("instantiates");
    expect(d?.ladders_up_to).toBe("Solve the right problem");
    expect(d?.human_confirmed).toBe(true);
  });

  test("strips ladders_up_to unless coherence is instantiates", () => {
    const d = validateCoherenceDecision(
      { dedupe_key: "a", coherence: "orthogonal", ladders_up_to: "Some principle" },
      new Set(["a"]),
    );
    expect(d?.ladders_up_to).toBeNull();
  });
});

describe("deterministic partition", () => {
  test("session-noise is dropped, never written", async () => {
    const r = await runTasteConsolidate([candidate({ scope: { kind: "session-noise" }, dedupe_key: "noise" })], opts(stubCaller([])));
    expect(r.droppedNoise).toBe(1);
    expect(r.written).toBe(0);
    expect(r.decisions[0]!.routed).toBe("dropped-noise");
  });

  test("a previously-killed dedupe_key is dropped as a negative", async () => {
    await recordNegative(projectTasteDir(paths, PROJECT), "trace-all-read-paths");
    const r = await runTasteConsolidate([candidate()], opts(stubCaller([])));
    expect(r.droppedNegative).toBe(1);
    expect(r.written).toBe(0);
  });

  test("CONTEXTUAL candidates are handed back to the fact-candidates queue", async () => {
    const r = await runTasteConsolidate(
      [candidate({ tier: "CONTEXTUAL", dedupe_key: "repo-uses-x", reasoning: "This repo stores money in cents." })],
      opts(stubCaller([])),
    );
    expect(r.handoffsToFacts).toHaveLength(1);
    expect(r.decisions[0]!.routed).toBe("fact-candidates");
    expect(r.written).toBe(0);
    const candFile = join(home, "memory", "projects", PROJECT, "candidates.md");
    const text = await Bun.file(candFile).text();
    expect(text).toContain("This repo stores money in cents.");
    expect(text).toContain("taste-handoff");
  });
});

describe("recurrence gate", () => {
  test("a single-session first-sighting lands in holding, not review", async () => {
    const r = await runTasteConsolidate([candidate()], opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "orthogonal" }])));
    expect(r.holding).toBe(1);
    expect(r.reviewEligible).toBe(0);
    const u = (await readTasteUnits(projectTasteDir(paths, PROJECT), "DESIGN"))[0]!;
    expect(u.status).toBe("holding");
    expect(u.recurrence).toBe(1);
  });

  test("recurring across two distinct sessions in one run is review-eligible", async () => {
    const a = candidate(); // session s1
    const b = candidate({ evidence: [{ anchor: { sessionFile: "s2.jsonl", id: "u9", ts: null }, quote: "again", confidence: 0.8 }] });
    const r = await runTasteConsolidate([a, b], opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "orthogonal" }])));
    expect(r.reviewEligible).toBe(1);
    const u = (await readTasteUnits(projectTasteDir(paths, PROJECT), "DESIGN"))[0]!;
    expect(u.status).toBe("pending");
    expect(u.recurrence).toBe(2);
    // Evidence from both sessions merged onto the one unit.
    expect(u.evidence.map((e) => e.anchor.id).sort()).toEqual(["u1", "u9"]);
  });

  test("explicit human confirmation bypasses the recurrence gate", async () => {
    const r = await runTasteConsolidate(
      [candidate()],
      opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "orthogonal", human_confirmed: true }])),
    );
    expect(r.reviewEligible).toBe(1);
    expect((await readTasteUnits(projectTasteDir(paths, PROJECT), "DESIGN"))[0]!.status).toBe("pending");
  });
});

describe("coherence + conflict", () => {
  test("instantiates persists ladders_up_to onto the unit", async () => {
    const r = await runTasteConsolidate(
      [candidate()],
      opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "instantiates", ladders_up_to: "Solve the right problem" }])),
    );
    expect(r.decisions[0]!.ladders_up_to).toBe("Solve the right problem");
    const u = (await readTasteUnits(projectTasteDir(paths, PROJECT), "DESIGN"))[0]!;
    expect(u.ladders_up_hint).toBe("Solve the right problem");
  });

  test("a conflict with an existing unit is surfaced with the resolved hash", async () => {
    // Seed an existing active unit to conflict against.
    const existing = candidate({ dedupe_key: "always-dedupe-in-one-place", reasoning: "Always dedupe in exactly one query." });
    await writeTasteUnit(projectTasteDir(paths, PROJECT), existing, { status: "active" });

    const r = await runTasteConsolidate(
      [candidate({ dedupe_key: "spread-dedupe", reasoning: "Spread dedupe across read paths." })],
      opts(stubCaller([{ dedupe_key: "spread-dedupe", coherence: "orthogonal", conflict_with: "always-dedupe-in-one-place" }])),
    );
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.conflict_with).toBe(unitHash(existing));
  });

  test("a re-observed unit never conflicts with its own prior version", async () => {
    // Run 1: seed the unit (holding).
    await runTasteConsolidate([candidate()], opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "orthogonal" }])));
    // Run 2: the model (mistakenly) points conflict_with at the same key.
    const r = await runTasteConsolidate(
      [candidate()],
      opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "orthogonal", conflict_with: "trace-all-read-paths" }])),
    );
    expect(r.conflicts).toHaveLength(0);
    expect(r.decisions[0]!.conflict_with).toBeNull();
    // And the second observation still accrues recurrence → review-eligible.
    expect(r.reviewEligible).toBe(1);
    expect((await readTasteUnits(projectTasteDir(paths, PROJECT), "DESIGN"))[0]!.recurrence).toBe(2);
  });

  test("tensions are collected for human adjudication", async () => {
    const r = await runTasteConsolidate(
      [candidate()],
      opts(stubCaller([{ dedupe_key: "trace-all-read-paths", coherence: "tension", tension_note: "scoped-exception: only for hot paths" }])),
    );
    expect(r.tensions).toHaveLength(1);
    expect(r.tensions[0]!.tension_note).toContain("scoped-exception");
  });
});

describe("scope routing + resilience", () => {
  test("general-taste units land in the cross-project store", async () => {
    await runTasteConsolidate(
      [candidate({ scope: { kind: "general-taste" }, dedupe_key: "cross", reasoning: "Read the actual thing before reasoning about it." })],
      opts(stubCaller([{ dedupe_key: "cross", coherence: "orthogonal" }])),
    );
    expect(await readTasteUnits(generalTasteDir(paths))).toHaveLength(1);
    expect(await readTasteUnits(projectTasteDir(paths, PROJECT))).toHaveLength(0);
  });

  test("a failed coherence call still routes and writes (enrichment, not a gate)", async () => {
    const boom: ModelCaller = async () => {
      throw new Error("model down");
    };
    const r = await runTasteConsolidate([candidate()], opts(boom));
    expect(r.errors.some((e) => e.includes("coherence call"))).toBe(true);
    expect(r.written).toBe(1);
    expect(r.decisions[0]!.coherence).toBeNull();
  });

  test("empty input is a clean no-op", async () => {
    const r = await runTasteConsolidate([], opts(stubCaller([])));
    expect(r.written).toBe(0);
    expect(r.decisions).toHaveLength(0);
    expect(r.usage).toBeNull();
  });
});
