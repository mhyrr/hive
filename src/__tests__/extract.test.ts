import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseExtractionJson,
  validateProjectCandidate,
  validateReflectionCandidate,
  buildProjectExtractionUserContent,
  buildReflectionExtractionUserContent,
  callProjectExtractor,
  callReflectionExtractor,
  runProjectExtractor,
  runReflectionExtractor,
  type ModelCaller,
} from "../lib/extract";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import {
  buildConditionReport,
  writeConditionReport,
  type ConditionReport,
  type ProjectSignal,
} from "../lib/condition";

// ---------------------------------------------------------------------------
// parseExtractionJson — tolerates code fences and stray prose
// ---------------------------------------------------------------------------

describe("parseExtractionJson", () => {
  test("parses a clean JSON array", () => {
    const raw = `[{"a":1},{"b":2}]`;
    expect(parseExtractionJson(raw)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("strips ```json fences", () => {
    const raw = "```json\n[{\"a\":1}]\n```";
    expect(parseExtractionJson(raw)).toEqual([{ a: 1 }]);
  });

  test("strips bare ``` fences", () => {
    const raw = "```\n[{\"a\":1}]\n```";
    expect(parseExtractionJson(raw)).toEqual([{ a: 1 }]);
  });

  test("unwraps {candidates: [...]} wrapper", () => {
    const raw = `{"candidates":[{"a":1}]}`;
    expect(parseExtractionJson(raw)).toEqual([{ a: 1 }]);
  });

  test("falls back to bracket extraction when prose surrounds the array", () => {
    const raw = "Here are the candidates:\n\n[{\"a\":1}]\n\nHope this helps!";
    expect(parseExtractionJson(raw)).toEqual([{ a: 1 }]);
  });

  test("extracts a fenced array when prose (itself starting with '[') precedes the fence", () => {
    // Real TA-classifier failure (2026-06-30): a prose preamble that itself
    // starts with "[" defeated bracket-extraction, and the fence wasn't at the
    // very start so the old anchored fence regex missed it entirely.
    const raw =
      "[Looking at the full conversation, I'm classifying this window.]\n\n" +
      '```json\n[{"windowId":"x.jsonl:23","type_guess":"PREFERENCE"}]\n```';
    expect(parseExtractionJson(raw)).toEqual([
      { windowId: "x.jsonl:23", type_guess: "PREFERENCE" },
    ]);
  });

  test("does not corrupt a valid array containing a ``` fence inside a string", () => {
    // Direct-parse must win before fence-stripping, or this self-destructs.
    const raw = '[{"example":"```json\\n{}\\n```"}]';
    expect(parseExtractionJson(raw)).toEqual([{ example: "```json\n{}\n```" }]);
  });

  test("empty array is valid", () => {
    expect(parseExtractionJson("[]")).toEqual([]);
  });

  test("throws with a useful preview when totally unparseable", () => {
    expect(() => parseExtractionJson("not json at all")).toThrow(/Could not parse/);
  });
});

// ---------------------------------------------------------------------------
// validateProjectCandidate
// ---------------------------------------------------------------------------

describe("validateProjectCandidate", () => {
  test("accepts a well-formed candidate", () => {
    const v = validateProjectCandidate({
      type: "fact",
      content: "Use Joken for JWT",
      tags: ["AUTH", "jwt"],
      provenance: "topRanked[0] — Greg said so",
    });
    expect(v?.type).toBe("fact");
    expect(v?.tags).toEqual(["auth", "jwt"]); // lowercased
    expect(v?.supersedes_hint).toBeUndefined();
  });

  test("preserves supersedes_hint when supplied", () => {
    const v = validateProjectCandidate({
      type: "decision",
      content: "Switch to Joken",
      tags: [],
      provenance: "p",
      supersedes_hint: "Use Guardian",
    });
    expect(v?.supersedes_hint).toBe("Use Guardian");
  });

  test("rejects unknown types", () => {
    expect(
      validateProjectCandidate({
        type: "preference",
        content: "x",
        provenance: "p",
      }),
    ).toBeNull();
  });

  test("rejects empty content", () => {
    expect(
      validateProjectCandidate({ type: "fact", content: "   ", provenance: "p" }),
    ).toBeNull();
  });

  test("rejects empty provenance", () => {
    expect(
      validateProjectCandidate({ type: "fact", content: "x", provenance: "" }),
    ).toBeNull();
  });

  test("tolerates missing tags (defaults to [])", () => {
    const v = validateProjectCandidate({
      type: "fact",
      content: "x",
      provenance: "p",
    });
    expect(v?.tags).toEqual([]);
  });

  test("filters non-string tag entries", () => {
    const v = validateProjectCandidate({
      type: "fact",
      content: "x",
      tags: ["good", 42, null, "also-good"],
      provenance: "p",
    });
    expect(v?.tags).toEqual(["good", "also-good"]);
  });
});

// ---------------------------------------------------------------------------
// validateReflectionCandidate
// ---------------------------------------------------------------------------

describe("validateReflectionCandidate", () => {
  test("accepts greg/maya/system subjects (case insensitive)", () => {
    expect(
      validateReflectionCandidate({
        subject: "Greg",
        content: "x",
        provenance: "p",
      })?.subject,
    ).toBe("greg");
    expect(
      validateReflectionCandidate({
        subject: "MAYA",
        content: "x",
        provenance: "p",
      })?.subject,
    ).toBe("maya");
    expect(
      validateReflectionCandidate({
        subject: "system",
        content: "x",
        provenance: "p",
      })?.subject,
    ).toBe("system");
  });

  test("rejects invalid subjects", () => {
    expect(
      validateReflectionCandidate({
        subject: "claude",
        content: "x",
        provenance: "p",
      }),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const fakeSignal: ProjectSignal = {
  projectName: "alpha",
  projectPath: "/tmp/alpha",
  sessions: {
    sessionCount: 2,
    exchangeCount: 12,
    tokenEstimate: 4000,
    topRanked: [
      {
        role: "user",
        preview: "Greg: should we use Joken or Guardian?",
        score: 12,
        tokenCount: 30,
        novelty: 0.8,
        alwaysInclude: false,
      },
      {
        role: "assistant",
        preview: "Maya: Joken — API-only app, no controller-level needs.",
        score: 11,
        tokenCount: 28,
        novelty: 0.7,
        alwaysInclude: false,
      },
    ],
  },
  git: {
    available: true,
    commits: 2,
    insertions: 40,
    deletions: 5,
    filesChanged: 3,
    subjects: ["feat: add Joken JWT", "test: cover Joken edge cases"],
  },
  tickets: {
    moved: [
      { id: "TK-001", title: "Wire JWT", status: "closed", updated: "2026-04-26T10:00Z" },
    ],
  },
  heartbeat: { inboxBytes: 0, findings: 0 },
};

describe("buildProjectExtractionUserContent", () => {
  test("includes project id, knowledge, git, tickets, exchanges", () => {
    const out = buildProjectExtractionUserContent({
      projectId: "alpha",
      signal: fakeSignal,
      knowledgeText: "## Facts\n- existing canon entry\n",
      date: "2026-04-26",
    });
    expect(out).toContain("Project: alpha");
    expect(out).toContain("existing canon entry");
    expect(out).toContain("feat: add Joken JWT");
    expect(out).toContain("+40 −5");
    expect(out).toContain("TK-001");
    expect(out).toContain("topRanked[0]");
    expect(out).toContain("Joken or Guardian");
  });

  test("renders gracefully when project has no activity", () => {
    const empty: ProjectSignal = {
      ...fakeSignal,
      sessions: { sessionCount: 0, exchangeCount: 0, tokenEstimate: 0, topRanked: [] },
      git: { available: false, commits: 0, insertions: 0, deletions: 0, filesChanged: 0, subjects: [] },
      tickets: { moved: [] },
    };
    const out = buildProjectExtractionUserContent({
      projectId: "alpha",
      signal: empty,
      knowledgeText: "",
      date: "2026-04-26",
    });
    expect(out).toContain("(no commits in window)");
    expect(out).toContain("(no session exchanges in window)");
    expect(out).toContain("(empty — this is a fresh project)");
  });
});

describe("buildReflectionExtractionUserContent", () => {
  test("skips quiet projects but includes active ones", () => {
    const report: ConditionReport = {
      date: "2026-04-26",
      generatedAt: "2026-04-26T00:00:00Z",
      hoursWindow: 24,
      trivial: false,
      trivialReason: null,
      projects: [
        fakeSignal,
        {
          projectName: "quiet",
          projectPath: null,
          sessions: { sessionCount: 0, exchangeCount: 0, tokenEstimate: 0, topRanked: [] },
          git: { available: false, commits: 0, insertions: 0, deletions: 0, filesChanged: 0, subjects: [] },
          tickets: { moved: [] },
          heartbeat: { inboxBytes: 0, findings: 0 },
        },
      ],
      totals: {
        projectCount: 2,
        sessionCount: 2,
        exchangeCount: 12,
        commitCount: 2,
        ticketsMoved: 1,
      },
    };
    const out = buildReflectionExtractionUserContent({
      identityText: "## About Maya\n- existing observation\n",
      report,
      date: "2026-04-26",
    });
    expect(out).toContain("existing observation");
    expect(out).toContain("Project: alpha");
    expect(out).not.toContain("Project: quiet");
  });
});

// ---------------------------------------------------------------------------
// Extractor invocation with stubbed model
// ---------------------------------------------------------------------------

const fakeUsage = {
  inputTokens: 1000,
  outputTokens: 100,
  totalTokens: 1100,
  durationMs: 250,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

function stubCaller(text: string): ModelCaller {
  return async () =>
    ({
      provider: fakeUsage.provider,
      model: fakeUsage.model,
      text,
      inputTokens: fakeUsage.inputTokens,
      outputTokens: fakeUsage.outputTokens,
      totalTokens: fakeUsage.totalTokens,
      durationMs: fakeUsage.durationMs,
      raw: { content: [{ type: "text", text }] } as never,
    });
}

describe("callProjectExtractor", () => {
  test("parses and validates Sonnet output", async () => {
    const out = await callProjectExtractor(
      "system",
      "user",
      stubCaller(
        `[
          {"type":"fact","content":"Use Joken","tags":["auth"],"provenance":"topRanked[1]"},
          {"type":"convention","content":"PRs ship green","tags":[],"provenance":"git: feat"}
        ]`,
      ),
    );
    expect(out.candidates.length).toBe(2);
    expect(out.rejected).toBe(0);
    expect(out.candidates[0]?.type).toBe("fact");
    expect(out.usage.model).toBe("claude-sonnet-4-6");
  });

  test("counts rejected entries without throwing", async () => {
    const out = await callProjectExtractor(
      "system",
      "user",
      stubCaller(
        `[{"type":"fact","content":"good","provenance":"p"},{"type":"bogus","content":"bad","provenance":"p"}]`,
      ),
    );
    expect(out.candidates.length).toBe(1);
    expect(out.rejected).toBe(1);
  });

  test("empty array yields zero candidates", async () => {
    const out = await callProjectExtractor("system", "user", stubCaller("[]"));
    expect(out.candidates).toEqual([]);
  });
});

describe("callReflectionExtractor", () => {
  test("parses reflection candidates", async () => {
    const out = await callReflectionExtractor(
      "system",
      "user",
      stubCaller(
        `[
          {"subject":"greg","content":"Greg pushes back early","tags":["feedback"],"provenance":"alpha:topRanked[0]"},
          {"subject":"maya","content":"Maya should announce intent before long bash","tags":[],"provenance":"alpha:topRanked[2]"}
        ]`,
      ),
    );
    expect(out.candidates.length).toBe(2);
    expect(out.candidates[0]?.subject).toBe("greg");
    expect(out.candidates[1]?.subject).toBe("maya");
  });
});

// ---------------------------------------------------------------------------
// End-to-end orchestration with synthetic HIVE home
// ---------------------------------------------------------------------------

async function buildFixture(): Promise<HivePaths> {
  const home = await mkdtemp(join(tmpdir(), "hive-extract-"));
  const paths = await ensureHiveScaffold(home);

  // Register one project
  const projectDir = join(home, "projects", "alpha");
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "config.md"),
    "---\nname: alpha\npath: /tmp/nonexistent/alpha\n---\n",
  );

  // Build & write a condition report so the extractors have input.
  const report = await buildConditionReport(paths);
  await writeConditionReport(paths, report);

  return paths;
}

describe("runProjectExtractor (end-to-end with stub)", () => {
  let paths: HivePaths;
  beforeEach(async () => {
    paths = await buildFixture();
  });

  test("writes JSON artifact at runs/{DATE}/candidates.B.{name}.json", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { outputPath, result } = await runProjectExtractor({
      paths,
      projectId: "alpha",
      date: today,
      caller: stubCaller(
        `[{"type":"fact","content":"sample","tags":[],"provenance":"p"}]`,
      ),
    });
    expect(outputPath).toContain(`candidates.B.alpha.json`);
    expect(result.candidates.length).toBe(1);
    const persisted = JSON.parse(await Bun.file(outputPath).text());
    expect(persisted.pass).toBe("B");
    expect(persisted.project).toBe("alpha");
    expect(persisted.candidates.length).toBe(1);
  });

  test("throws when project absent from condition.json", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await expect(
      runProjectExtractor({
        paths,
        projectId: "ghost",
        date: today,
        caller: stubCaller("[]"),
      }),
    ).rejects.toThrow(/not present in condition.json/);
  });
});

describe("runReflectionExtractor (end-to-end with stub)", () => {
  test("writes JSON artifact at runs/{DATE}/candidates.C.json", async () => {
    const paths = await buildFixture();
    const today = new Date().toISOString().slice(0, 10);
    const { outputPath, result } = await runReflectionExtractor({
      paths,
      date: today,
      caller: stubCaller(
        `[{"subject":"system","content":"HIVE works","tags":[],"provenance":"global"}]`,
      ),
    });
    expect(outputPath.endsWith("candidates.C.json")).toBe(true);
    expect(result.candidates.length).toBe(1);
    const persisted = JSON.parse(await Bun.file(outputPath).text());
    expect(persisted.pass).toBe("C");
    expect(persisted.candidates[0].subject).toBe("system");
  });
});
