import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

import { runNightly } from "../lib/orchestrator";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { appendProjectMemory, entryHash, readProjectMemorySnapshot } from "../lib/memory";
import type { ModelCaller } from "../lib/extract";
import { parseTranscriptContent, type LoadedTranscript, type TranscriptEvent } from "../lib/transcript";
import { loadUsageSummary } from "../lib/pricing";
import { projectTasteDir, readTasteUnits } from "../lib/taste-store";

// ---------------------------------------------------------------------------
// Smart model stub — pattern-matches on the system prompt to choose what to
// return for each pass (B, C, V).
// ---------------------------------------------------------------------------

interface StubBehavior {
  bResponses?: Record<string, string>; // by projectId
  cResponse?: string;
  vShardResponses?: Record<string, string>; // Pass V per-project call, by projectId
  vResponse?: string;                       // Pass V briefing call (the one with prose)
  failProjectsB?: Set<string>;
  failC?: boolean;
  failV?: boolean;
  // Taste track
  taFlagAll?: boolean; // flag every window shown to the TA classifier
  tbCandidates?: string; // TB JSON returned for every TB call
  tcDecisions?: string; // TC coherence JSON returned for every TC call
  replayFlags?: Record<string, string[]>; // replay judge: dedupe_key → flagged window ids
  failTASessionFiles?: Set<string>; // throw TA when its content mentions one
  // @nightly watches (W pass)
  watchResponse?: string;
}

function makeStub(behavior: StubBehavior): ModelCaller {
  return async (input) => {
    let text: string;
    let model = "claude-sonnet-4-6";
    if (input.systemPrompt.includes("locating DIVERGENCE")) {
      // Pass TA (flag) — Haiku.
      model = "claude-haiku-4-5";
      for (const sf of behavior.failTASessionFiles ?? []) {
        if (input.userContent.includes(sf)) throw new Error(`stubbed TA failure (${sf})`);
      }
      const ids = behavior.taFlagAll
        ? [...input.userContent.matchAll(/window (\S+:\d+)/g)].map((m) => m[1])
        : [];
      text = JSON.stringify(ids.map((id) => ({ windowId: id, type_guess: "CORRECTION" })));
    } else if (input.systemPrompt.includes("extract durable TASTE")) {
      // Pass TB (analyze) — Opus.
      model = "claude-opus-4-6";
      text = behavior.tbCandidates ?? "[]";
    } else if (input.systemPrompt.includes("consolidation gate for a taste-memory")) {
      // Pass TC (consolidate/gate) — Opus.
      model = "claude-opus-4-6";
      text = behavior.tcDecisions ?? "[]";
    } else if (input.systemPrompt.includes("validating candidate taste rules")) {
      // Replay judge (TR) — Sonnet.
      model = "claude-sonnet-4-6";
      const flags = behavior.replayFlags ?? {};
      text = JSON.stringify(Object.entries(flags).map(([dedupe_key, flagged]) => ({ dedupe_key, flagged })));
    } else if (input.systemPrompt.includes("You see exactly one project")) {
      // Pass V — per-project call. Decisions + gaps, no prose.
      model = "claude-opus-4-8";
      if (behavior.failV) throw new Error("stubbed V failure");
      const projectMatch = input.userContent.match(/project:\s*(\S+)/);
      const projectId = projectMatch?.[1] ?? "unknown";
      text = behavior.vShardResponses?.[projectId] ?? `{ "decisions": [], "gaps": [] }`;
    } else if (input.systemPrompt.includes("verifier for HIVE")) {
      // Pass V — briefing call.
      model = "claude-opus-4-8";
      if (behavior.failV) throw new Error("stubbed V failure");
      text = behavior.vResponse ?? `{
        "decisions": [],
        "gaps": [],
        "briefing_markdown": "# HIVE — stub\\n\\n## Headline\\nStubbed run."
      }`;
    } else if (input.systemPrompt.includes("self-reflection extractor")) {
      // Pass C
      if (behavior.failC) throw new Error("stubbed C failure");
      text = behavior.cResponse ?? "[]";
    } else if (input.systemPrompt.includes("You are a HIVE watch")) {
      // W pass (@nightly watches) — judgment tier.
      model = "claude-opus-4-8";
      text = behavior.watchResponse ?? "NO_SIGNAL";
    } else {
      // Pass B — figure out which project from the user content.
      const projectMatch = input.userContent.match(/Project:\s*(\S+)/);
      const projectId = projectMatch?.[1] ?? "unknown";
      if (behavior.failProjectsB?.has(projectId)) {
        throw new Error(`stubbed B failure for ${projectId}`);
      }
      text = behavior.bResponses?.[projectId] ?? "[]";
    }
    return {
      provider: "anthropic",
      model,
      text,
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      durationMs: 50,
      raw: { content: [{ type: "text", text }] } as never,
    };
  };
}

async function freshHomeWith(projects: string[]): Promise<HivePaths> {
  const home = await mkdtemp(join(tmpdir(), "hive-orch-"));
  const paths = await ensureHiveScaffold(home);
  for (const id of projects) {
    await mkdir(join(paths.projectsDir, id), { recursive: true });
    await writeFile(
      join(paths.projectsDir, id, "config.md"),
      `---\nname: ${id}\npath: /tmp/nope/${id}\n---\n`,
    );
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Trivial-day path
// ---------------------------------------------------------------------------

describe("runNightly — trivial day", () => {
  test("with no signal, writes a stub briefing and skips B/C/V", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    const result = await runNightly({ paths, date, caller: makeStub({}) });

    expect(result.trivial).toBe(true);
    expect(result.passes.A.status).toBe("complete");
    expect(result.passes.B[0]?.status).toBe("skipped");
    expect(result.passes.C.status).toBe("skipped");
    expect(result.passes.V.status).toBe("skipped");
    expect(result.passes.W[0]?.status).toBe("skipped");

    const stubBriefing = join(paths.memoryRunsDir, date, "briefing.md");
    expect(existsSync(stubBriefing)).toBe(true);
    const body = await Bun.file(stubBriefing).text();
    expect(body).toContain("Quiet day");

    // Wet-run lands the briefing
    expect(result.briefingPath).toContain(`/briefings/${date}.md`);
    expect(existsSync(result.briefingPath!)).toBe(true);
  });

  test("dry-run trivial day skips landing", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    const result = await runNightly({ paths, date, dryRun: true, caller: makeStub({}) });
    expect(result.trivial).toBe(true);
    expect(result.briefingPath).toBeNull();
    expect(result.passes.dashboard.status).toBe("skipped");
  });
});

// ---------------------------------------------------------------------------
// Full pipeline (stubs the LLM calls; everything else is real)
// ---------------------------------------------------------------------------

async function seedActivity(
  paths: HivePaths,
  projectId: string,
  date: string,
): Promise<string> {
  // Drop a ticket update to tip Pass A out of trivial.
  //
  // Stamp it at noon UTC on the date under test — NOT wall-clock-relative.
  // buildConditionReport anchors its window to `{date}T23:59:59.999Z` and looks
  // back hoursWindow (24), so the window for date D is
  // [D-1 23:59:59.999Z, D 23:59:59.999Z]. The old `Date.now() - 1h` stamp only
  // landed inside that window once the wall clock passed 00:59:59.999Z, so every
  // test using this fixture failed between 00:00 and 01:00 UTC and passed the
  // other 23 hours — a trivial-day short-circuit that skipped B/C/V and the
  // taste track. Noon on D is inside the window for any D.
  const ticketsDir = join(paths.projectsDir, projectId, "tickets");
  await mkdir(ticketsDir, { recursive: true });
  const recentTs = `${date}T12:00:00.000Z`;
  await writeFile(
    join(ticketsDir, "TK-001.md"),
    `---\nid: TK-001\ntitle: Activity ticket\nstatus: in_progress\ntype: task\npriority: 2\ntags: \ncreated: 2026-04-01T00:00:00Z\nupdated: ${recentTs}\nclosed: \nref: \ndepends: \n---\n\nBody\n`,
  );
  // Pre-seed canon with one entry so verifier has hashes to reference.
  await appendProjectMemory(paths, projectId, "fact", "Existing baseline fact", ["seed"]);
  return entryHash("Existing baseline fact");
}

// ---------------------------------------------------------------------------
// W pass — @nightly watches ride the end of the pipeline (TK-138)
// ---------------------------------------------------------------------------

describe("runNightly — @nightly watches (W pass)", () => {
  test("a bets-style watch fires after the tracks and lands its briefing artifact", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);
    await writeFile(
      join(paths.watchesDir, "bets.md"),
      "---\nname: bets\ncadence: @nightly\nscope: runs, tickets\nwindow: 7d\nmodel: judgment\nvenue: briefing\nautonomy: propose\n---\n\nWhat bets should we be thinking about?",
    );

    const stub = makeStub({
      vResponse: JSON.stringify({
        decisions: [],
        gaps: [],
        briefing_markdown: `# HIVE — ${date}\n\n## Headline\nWatch test landed.`,
      }),
      watchResponse: "Bet: TK-001 suggests the activity lane is real — first step: keep it.",
    });

    const result = await runNightly({ paths, date, caller: stub });

    expect(result.passes.W.length).toBe(1);
    expect(result.passes.W[0]?.pass).toBe("W.bets");
    expect(result.passes.W[0]?.status).toBe("complete");
    expect(result.passes.W[0]?.detail).toContain("surfaced");

    const artifact = join(paths.memoryRunsDir, date, "bets.md");
    expect(existsSync(artifact)).toBe(true);
    expect(await Bun.file(artifact).text()).toContain("TK-001");
  });

  test("dry-run skips the W pass entirely", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);
    await writeFile(
      join(paths.watchesDir, "bets.md"),
      "---\nname: bets\ncadence: @nightly\nscope: runs, tickets\nvenue: briefing\n---\n\nWhat bets?",
    );

    const result = await runNightly({ paths, date, dryRun: true, caller: makeStub({}) });
    expect(result.passes.W[0]?.status).toBe("skipped");
    expect(result.passes.W[0]?.detail).toBe("dry-run");
    expect(existsSync(join(paths.memoryRunsDir, date, "bets.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// P1 — --date flag threading through Pass A (no calendar mismatch)
// ---------------------------------------------------------------------------

describe("runNightly — explicit --date threads through every pass", () => {
  test("artifacts land in runs/{date}/ matching the requested date", async () => {
    const paths = await freshHomeWith(["alpha"]);
    // Pick a deterministic date in the past so today's clock isn't the answer.
    const date = "2026-04-25";
    await seedActivity(paths, "alpha", date);

    const stub = makeStub({
      bResponses: { alpha: "[]" },
      cResponse: "[]",
      vResponse: JSON.stringify({
        decisions: [],
        gaps: [],
        briefing_markdown: `# HIVE — ${date}\n\n## Headline\nDated.`,
      }),
    });

    const result = await runNightly({ paths, date, caller: stub });
    expect(result.date).toBe(date);
    expect(result.artifactsDir).toContain(`/runs/${date}`);

    const conditionPath = join(paths.memoryRunsDir, date, "condition.json");
    expect(existsSync(conditionPath)).toBe(true);
    const cond = JSON.parse(await Bun.file(conditionPath).text());
    expect(cond.date).toBe(date);

    // Today's runs dir must NOT have leaked condition.json from this call.
    const today = new Date().toISOString().slice(0, 10);
    if (today !== date) {
      expect(existsSync(join(paths.memoryRunsDir, today, "condition.json"))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// P2 — Failed extractor reruns must not silently reuse stale artifacts
// ---------------------------------------------------------------------------

describe("runNightly — stale artifact safety", () => {
  test("a failed Pass B clears the prior project's candidates.B file", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);

    // Plant a stale Pass B artifact pretending an earlier run succeeded.
    await mkdir(paths.memoryRunsDir, { recursive: true });
    await mkdir(join(paths.memoryRunsDir, date), { recursive: true });
    const stalePath = join(paths.memoryRunsDir, date, "candidates.B.alpha.json");
    await writeFile(
      stalePath,
      JSON.stringify({ pass: "B", project: "alpha", candidates: [{ stale: true }] }),
    );

    const stub = makeStub({
      failProjectsB: new Set(["alpha"]),
      cResponse: "[]",
      vResponse: JSON.stringify({
        decisions: [],
        gaps: [],
        briefing_markdown: "# HIVE",
      }),
    });

    const result = await runNightly({ paths, date, caller: stub });
    const alphaB = result.passes.B.find((p) => p.pass === "B.alpha");
    expect(alphaB?.status).toBe("failed");

    // The stale artifact must be gone — verify must NOT be able to read it.
    expect(existsSync(stalePath)).toBe(false);
  });

  test("a failed Pass V clears the prior decisions/briefing artifacts", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);

    await mkdir(join(paths.memoryRunsDir, date), { recursive: true });
    const staleBriefing = join(paths.memoryRunsDir, date, "briefing.md");
    const staleDecisions = join(paths.memoryRunsDir, date, "decisions.json");
    await writeFile(staleBriefing, "# Stale briefing from yesterday's run");
    await writeFile(staleDecisions, JSON.stringify({ decisions: [{ stale: true }] }));

    const stub = makeStub({
      bResponses: { alpha: "[]" },
      cResponse: "[]",
      failV: true,
    });
    await runNightly({ paths, date, caller: stub });

    expect(existsSync(staleBriefing)).toBe(false);
    expect(existsSync(staleDecisions)).toBe(false);
  });
});

describe("runNightly — full pipeline (A → B → C → V → F)", () => {
  test("walks every pass, lands canon mutations + briefing", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    const seedHash = await seedActivity(paths, "alpha", date);

    const stub = makeStub({
      bResponses: {
        alpha: JSON.stringify([
          {
            type: "fact",
            content: "Brand-new fact discovered in stubbed B",
            tags: ["b-extract"],
            provenance: "topRanked[0]",
          },
        ]),
      },
      cResponse: JSON.stringify([
        {
          subject: "system",
          content: "Stubbed reflection about the system",
          tags: [],
          provenance: "global",
        },
      ]),
      // Project candidates are decided by the per-project V call; reflections by
      // the briefing call.
      vShardResponses: {
        alpha: JSON.stringify({
          decisions: [{ candidate_id: "B.alpha[0]", action: "accept" }],
          gaps: [],
        }),
      },
      vResponse: JSON.stringify({
        decisions: [{ candidate_id: "C[0]", action: "accept" }],
        gaps: [],
        briefing_markdown: `# HIVE — ${date}\n\n## Headline\nFull pipeline test landed.`,
      }),
    });

    const result = await runNightly({ paths, date, caller: stub });

    // Pass status
    expect(result.passes.A.status).toBe("complete");
    expect(result.passes.B.length).toBe(1);
    expect(result.passes.B[0]?.status).toBe("complete");
    expect(result.passes.C.status).toBe("complete");
    expect(result.passes.V.status).toBe("complete");
    expect(result.passes.F.status).toBe("complete");
    expect(result.passes.dashboard.status).toBe("complete");

    // Decision counts
    expect(result.decisionCounts.accept).toBe(2);

    // Briefing landed
    expect(result.briefingPath).toBeTruthy();
    const briefing = await Bun.file(result.briefingPath!).text();
    expect(briefing).toContain("Full pipeline test landed");

    // Canon mutated — new fact landed
    const snap = await readProjectMemorySnapshot(paths, "alpha");
    const newFact = snap.facts.find((f) => f.text.includes("Brand-new fact"));
    expect(newFact).toBeTruthy();

    // Reflection landed
    const reflectionFile = join(paths.reflectionsDir, `${date}.md`);
    const reflection = await Bun.file(reflectionFile).text();
    expect(reflection).toContain("Stubbed reflection about the system");

    // Cost aggregated
    const usagePath = join(paths.memoryRunsDir, date, "usage.json");
    expect(existsSync(usagePath)).toBe(true);
    const usage = JSON.parse(await Bun.file(usagePath).text());
    expect(usage.records.length).toBeGreaterThan(0);

    // Seed hash still queryable for downstream tests
    expect(seedHash).toMatch(/^[a-f0-9]{8}$/);
  });

  test("dry-run runs A/B/C/V but skips F + dashboard", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);

    const stub = makeStub({
      bResponses: { alpha: "[]" },
      cResponse: "[]",
      vResponse: JSON.stringify({
        decisions: [],
        gaps: [],
        briefing_markdown: `# HIVE — ${date}\n\n## Headline\nDry-run.`,
      }),
    });

    const result = await runNightly({ paths, date, dryRun: true, caller: stub });

    expect(result.dryRun).toBe(true);
    expect(result.passes.V.status).toBe("complete");
    expect(result.passes.F.status).toBe("skipped");
    expect(result.passes.F.detail).toContain("dry-run");
    expect(result.passes.dashboard.status).toBe("skipped");

    // Briefing draft exists in runs/, but NOT in ~/.hive/briefings/
    expect(existsSync(join(paths.memoryRunsDir, date, "briefing.md"))).toBe(true);
    expect(existsSync(join(paths.home, "briefings", `${date}.md`))).toBe(false);
  });

  test("Pass B failure on one project doesn't block the others or downstream", async () => {
    const paths = await freshHomeWith(["alpha", "bravo"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);
    await seedActivity(paths, "bravo", date);

    const stub = makeStub({
      bResponses: { bravo: "[]" }, // alpha will fail
      failProjectsB: new Set(["alpha"]),
      cResponse: "[]",
      vResponse: JSON.stringify({
        decisions: [],
        gaps: [],
        briefing_markdown: `# HIVE — ${date}`,
      }),
    });

    const result = await runNightly({ paths, date, caller: stub });

    const alphaB = result.passes.B.find((p) => p.pass === "B.alpha");
    const bravoB = result.passes.B.find((p) => p.pass === "B.bravo");
    expect(alphaB?.status).toBe("failed");
    expect(bravoB?.status).toBe("complete");
    expect(result.passes.V.status).toBe("complete");
    expect(result.passes.F.status).toBe("complete");
    expect(result.errors.length).toBe(1);
  });

  test("Pass V failure skips F + dashboard but reports cleanly", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);

    const stub = makeStub({
      bResponses: { alpha: "[]" },
      cResponse: "[]",
      failV: true,
    });

    const result = await runNightly({ paths, date, caller: stub });
    expect(result.passes.V.status).toBe("failed");
    expect(result.passes.F.status).toBe("skipped");
    expect(result.passes.F.detail).toContain("verify failed");
    expect(result.passes.dashboard.status).toBe("skipped");
    expect(result.errors.some((e) => e.includes("Pass V"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Taste track (TA → TB → TC), sequenced after the fact track
// ---------------------------------------------------------------------------

let tcn = 0;
/** A correction transcript whose anchors live in `<project>.jsonl`, so windowIds
 *  read `<project>.jsonl:<line>` — lets a stub key TA failures by project. */
function tasteSession(project: string): LoadedTranscript {
  const sessionFile = `/Users/x/.claude/projects/-p/${project}.jsonl`;
  const lines = [
    { type: "user", uuid: `u${tcn++}`, parentUuid: null, timestamp: "t", message: { role: "user", content: "build a schema" } },
    {
      type: "assistant", uuid: `a${tcn++}`, parentUuid: null, timestamp: "t",
      message: { role: "assistant", content: [{ type: "text", text: "done" }, { type: "tool_use", id: `tu${tcn++}`, name: "Edit", input: { file_path: "/x/schema.sql", old_string: "a", new_string: "b" } }] },
    },
    { type: "user", uuid: `u${tcn++}`, parentUuid: null, timestamp: "t", message: { role: "user", content: "no, use a foreign key instead" } },
  ];
  const events = parseTranscriptContent(lines.map((l) => JSON.stringify(l)).join("\n"), {
    sessionFile, source: "claude", project,
  });
  return { sessionFile, source: "claude", project, events };
}

function tasteLoader(byProject: Record<string, LoadedTranscript[]>): typeof import("../lib/transcript").loadTranscripts {
  return async (opts) => byProject[opts.project ?? ""] ?? [];
}

// --- Replay (TR) fixtures: a wider 90d historical corpus to validate against ---
let hseq = 0;
function hev(role: TranscriptEvent["role"], text: string, sf: string): TranscriptEvent {
  hseq++;
  return { anchor: { sessionFile: sf, id: `h${hseq}`, line: hseq, ts: null }, parentId: null, source: "claude", project: "alpha", role, kind: "message", text };
}
/** One window each: a correction (human redirects) and an accepted (no reaction). */
function histCorrection(i: number): LoadedTranscript {
  const sf = `/h/hist-c${i}.jsonl`;
  return { sessionFile: sf, source: "claude", project: "alpha", events: [hev("assistant", "here is the code", sf), hev("user", "no, that's wrong, use X instead", sf)] };
}
function histAccepted(i: number): LoadedTranscript {
  const sf = `/h/hist-a${i}.jsonl`;
  return { sessionFile: sf, source: "claude", project: "alpha", events: [hev("assistant", "shipped it", sf), hev("assistant", "added the docs", sf)] };
}
/** 5 corrections (w0..w4) + 5 accepted (w5..w9): a non-thin, balanced corpus. */
function historicalCorpus(): LoadedTranscript[] {
  return [...[0, 1, 2, 3, 4].map(histCorrection), ...[0, 1, 2, 3, 4].map(histAccepted)];
}

/** since-set ⇒ the 90d replay corpus; otherwise ⇒ the 24h TA/TB session. */
function replayLoader(): typeof import("../lib/transcript").loadTranscripts {
  return async (opts) => (opts.since ? historicalCorpus() : [tasteSession("alpha")]);
}

/** Same rule as TB_ONE_CANDIDATE but with evidence in TWO sessions → recurrence 2. */
const TB_RECURRING = JSON.stringify([
  {
    category: "IMPLEMENTATION",
    tier: "FUZZY",
    scope: { kind: "project" },
    reasoning: "Integrity belongs in the schema; prefer a foreign key over an app-level check.",
    delta: { before: "plain id column", after: "foreign key" },
    reason_source: "stated",
    rule_statement: "SQL relations use foreign keys",
    canonical_example: { bad: "user_id int", good: "user_id references users(id)" },
    check_sketch: null,
    evidence: [
      { anchor: { sessionFile: "s1.jsonl", id: "u3", ts: null }, quote: "no, use a foreign key instead", confidence: 0.9 },
      { anchor: { sessionFile: "s2.jsonl", id: "u7", ts: null }, quote: "again, foreign key", confidence: 0.9 },
    ],
    dedupe_key: "sql-foreign-keys",
    provenance: "human correction across two sessions",
  },
]);

const TB_ONE_CANDIDATE = JSON.stringify([
  {
    category: "IMPLEMENTATION",
    tier: "FUZZY",
    scope: { kind: "project" },
    reasoning: "Integrity belongs in the schema; prefer a foreign key over an app-level check.",
    delta: { before: "plain id column", after: "foreign key" },
    reason_source: "stated",
    rule_statement: "SQL relations use foreign keys",
    canonical_example: { bad: "user_id int", good: "user_id references users(id)" },
    check_sketch: null,
    evidence: [{ anchor: { sessionFile: "f", id: "u3", ts: null }, quote: "no, use a foreign key instead", confidence: 0.9 }],
    dedupe_key: "sql-foreign-keys",
    provenance: "human correction",
  },
]);

// ---------------------------------------------------------------------------
// Pass B serialization — concurrent `claude --print` subprocesses contend on
// OAuth/Keychain in the detached launchd context and stall past claude's own
// 6-min cap. Every other claude-heavy pass (C, V, taste) is serial; B must be
// too. This test pins B to one-at-a-time so the fan-out can't silently return.
// ---------------------------------------------------------------------------

describe("runNightly — Pass B serialization", () => {
  test("project extractors run one at a time (max concurrency 1)", async () => {
    const paths = await freshHomeWith(["alpha", "bravo", "charlie"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);
    await seedActivity(paths, "bravo", date);
    await seedActivity(paths, "charlie", date);

    let active = 0;
    let maxActive = 0;
    // taste:false leaves only B/C/V on the caller. C and V are already
    // sequential, so the run-wide max concurrency is governed by Pass B.
    const trackingCaller: ModelCaller = async (input) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 25));
      active--;
      const text = input.systemPrompt.includes("verifier for HIVE")
        ? JSON.stringify({ decisions: [], gaps: [], briefing_markdown: "# HIVE" })
        : "[]";
      return {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        text,
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        durationMs: 25,
      };
    };

    const result = await runNightly({ paths, date, taste: false, caller: trackingCaller });

    expect(result.passes.B.length).toBe(3);
    expect(result.passes.B.every((p) => p.status === "complete")).toBe(true);
    expect(maxActive).toBe(1);
  });
});

describe("runNightly — taste track", () => {
  test("runs TA→TB→TC for a project, writes artifacts + store unit + usage", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);

    const result = await runNightly({
      paths,
      date,
      caller: makeStub({ taFlagAll: true, tbCandidates: TB_ONE_CANDIDATE, tcDecisions: "[]" }),
      transcriptLoader: tasteLoader({ alpha: [tasteSession("alpha")] }),
    });

    expect(result.passes.TA[0]?.status).toBe("complete");
    expect(result.passes.TB[0]?.status).toBe("complete");
    expect(result.passes.TC[0]?.status).toBe("complete");

    const runDir = join(paths.memoryRunsDir, date);
    const flags = JSON.parse(await Bun.file(join(runDir, "taste-flags.alpha.json")).text());
    expect(flags.length).toBeGreaterThanOrEqual(1);
    const tb = JSON.parse(await Bun.file(join(runDir, "candidates.TB.alpha.json")).text());
    expect(tb.length).toBe(1);
    expect(existsSync(join(runDir, "taste-decisions.json"))).toBe(true);
    expect(existsSync(join(runDir, "taste-decisions.md"))).toBe(true);
    // Deprecation: Pass V ran (briefing landed) but the old taste.md readout is
    // gone — taste-decisions.md is its replacement.
    expect(existsSync(join(runDir, "taste.md"))).toBe(false);
    expect(result.passes.V.status).toBe("complete");

    // TC wrote the unit to the store (holding — single session, below the gate).
    const units = await readTasteUnits(projectTasteDir(paths, "alpha"), "IMPLEMENTATION");
    expect(units).toHaveLength(1);
    expect(units[0]?.status).toBe("holding");

    // Usage records for every taste pass, with the right models.
    const usage = await loadUsageSummary(paths, date);
    const ta = usage.records.find((r) => r.pass === "TA");
    const tbU = usage.records.find((r) => r.pass === "TB");
    const tcU = usage.records.find((r) => r.pass === "TC");
    expect(ta?.model).toBe("claude-haiku-4-5");
    expect(tbU?.model).toBe("claude-opus-4-6");
    expect(tcU?.model).toBe("claude-opus-4-6");
  });

  test("replay (TR) runs hermetically: a recurring FUZZY candidate that passes replay → pending + a TR usage record", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);

    const result = await runNightly({
      paths,
      date,
      caller: makeStub({
        taFlagAll: true,
        tbCandidates: TB_RECURRING,
        tcDecisions: "[]",
        replayFlags: { "sql-foreign-keys": ["w0", "w1", "w2", "w3", "w4"] }, // flag the 5 real corrections
      }),
      transcriptLoader: replayLoader(),
    });

    expect(result.passes.TC[0]?.status).toBe("complete");

    // Recurrence 2 cleared the gate AND replay predicted the corrections → pending.
    const units = await readTasteUnits(projectTasteDir(paths, "alpha"), "IMPLEMENTATION");
    expect(units).toHaveLength(1);
    expect(units[0]?.status).toBe("pending");
    expect(units[0]?.recurrence).toBe(2);

    // A TR usage record landed, billed to the mid-tier judge model.
    const usage = await loadUsageSummary(paths, date);
    const tr = usage.records.find((r) => r.pass === "TR");
    expect(tr).toBeDefined();
    expect(tr?.model).toBe("claude-sonnet-4-6");
  });

  test("--no-taste skips the taste track entirely", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);

    let tasteLoaderCalled = false;
    const result = await runNightly({
      paths,
      date,
      taste: false,
      caller: makeStub({ taFlagAll: true, tbCandidates: TB_ONE_CANDIDATE }),
      transcriptLoader: (async (o) => { tasteLoaderCalled = true; return tasteLoader({ alpha: [tasteSession("alpha")] })(o); }) as typeof import("../lib/transcript").loadTranscripts,
    });

    expect(tasteLoaderCalled).toBe(false);
    expect(result.passes.TA[0]?.status).toBe("skipped");
    expect(result.passes.TA[0]?.detail).toContain("--no-taste");
    expect(existsSync(join(paths.memoryRunsDir, date, "taste-flags.alpha.json"))).toBe(false);
  });

  test("dry-run runs TA/TB but skips TC and the store write", async () => {
    const paths = await freshHomeWith(["alpha"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);

    const result = await runNightly({
      paths,
      date,
      dryRun: true,
      caller: makeStub({ taFlagAll: true, tbCandidates: TB_ONE_CANDIDATE }),
      transcriptLoader: tasteLoader({ alpha: [tasteSession("alpha")] }),
    });

    expect(result.passes.TA[0]?.status).toBe("complete");
    expect(result.passes.TB[0]?.status).toBe("complete");
    expect(result.passes.TC[0]?.status).toBe("skipped");
    expect(result.passes.TC[0]?.detail).toContain("dry-run");

    const runDir = join(paths.memoryRunsDir, date);
    expect(existsSync(join(runDir, "candidates.TB.alpha.json"))).toBe(true); // TB artifact written
    expect(existsSync(join(runDir, "taste-decisions.json"))).toBe(false); // TC artifact NOT written
    expect(await readTasteUnits(projectTasteDir(paths, "alpha"))).toHaveLength(0); // no store mutation
  });

  test("one project's TA failure doesn't block another", async () => {
    const paths = await freshHomeWith(["alpha", "bravo"]);
    const date = new Date().toISOString().slice(0, 10);
    await seedActivity(paths, "alpha", date);
    await seedActivity(paths, "bravo", date);

    const result = await runNightly({
      paths,
      date,
      caller: makeStub({
        taFlagAll: true,
        tbCandidates: TB_ONE_CANDIDATE,
        tcDecisions: "[]",
        failTASessionFiles: new Set(["alpha.jsonl"]),
      }),
      transcriptLoader: tasteLoader({ alpha: [tasteSession("alpha")], bravo: [tasteSession("bravo")] }),
    });

    const alphaTA = result.passes.TA.find((p) => p.pass === "TA.alpha");
    const bravoTC = result.passes.TC.find((p) => p.pass === "TC.bravo");
    expect(alphaTA?.status).toBe("failed");
    expect(bravoTC?.status).toBe("complete");
    expect(result.errors.some((e) => e.includes("Pass TA/TB (alpha)"))).toBe(true);
    // Bravo still wrote its unit; alpha did not.
    expect(await readTasteUnits(projectTasteDir(paths, "bravo"))).toHaveLength(1);
    expect(await readTasteUnits(projectTasteDir(paths, "alpha"))).toHaveLength(0);
  });
});
