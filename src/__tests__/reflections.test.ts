import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseReflectionFile,
  readUnprocessedReflections,
  promoteReflections,
  promoteReflectionsBatch,
  projectFromReflectionEntry,
  tokenize,
  wordOverlap,
} from "../lib/reflections";
import { appendProjectMemory, knowledgePath } from "../lib/memory";
import { ensureHiveScaffold, type HivePaths, getProjectPaths } from "../lib/paths";

// ---------------------------------------------------------------------------
// Tokenization (reflection-specific, with stop word filtering)
// ---------------------------------------------------------------------------

describe("reflection tokenize", () => {
  test("filters stop words", () => {
    const tokens = tokenize("the quick brown fox is very fast");
    expect(tokens.has("the")).toBe(false);
    expect(tokens.has("is")).toBe(false);
    expect(tokens.has("very")).toBe(false);
    expect(tokens.has("quick")).toBe(true);
    expect(tokens.has("brown")).toBe(true);
    expect(tokens.has("fox")).toBe(true);
    expect(tokens.has("fast")).toBe(true);
  });

  test("filters short words (<=2 chars)", () => {
    const tokens = tokenize("I am a go to db");
    expect(tokens.size).toBe(0);
  });

  test("lowercases", () => {
    const tokens = tokenize("BM25 Search Engine");
    expect(tokens.has("bm25")).toBe(true);
    expect(tokens.has("search")).toBe(true);
    expect(tokens.has("engine")).toBe(true);
  });

  test("returns a Set (no duplicates)", () => {
    const tokens = tokenize("auth auth auth tokens");
    expect(tokens.size).toBe(2); // auth, tokens
  });
});

// ---------------------------------------------------------------------------
// Word Overlap
// ---------------------------------------------------------------------------

describe("wordOverlap", () => {
  test("identical text returns 1.0", () => {
    expect(wordOverlap("BM25 search engine", "BM25 search engine")).toBe(1.0);
  });

  test("no overlap returns 0", () => {
    expect(wordOverlap("database postgresql", "frontend react")).toBe(0);
  });

  test("partial overlap returns ratio", () => {
    const overlap = wordOverlap(
      "BM25 search replaces substring matching",
      "BM25 search engine for memory retrieval",
    );
    // "bm25" and "search" overlap, out of min(4, 5) = 4 significant words
    expect(overlap).toBeGreaterThan(0.3);
    expect(overlap).toBeLessThan(0.8);
  });

  test("empty strings return 0", () => {
    expect(wordOverlap("", "something")).toBe(0);
    expect(wordOverlap("something", "")).toBe(0);
  });

  test("stop-word-only text returns 0", () => {
    expect(wordOverlap("the is a an", "the was an")).toBe(0);
  });

  test("handles threshold-level overlap", () => {
    // 3/5 content words overlap — should be above 0.5
    const high = wordOverlap(
      "heartbeat cost monitoring on Opus is expensive",
      "heartbeat Opus cost tracking was invisible",
    );
    expect(high).toBeGreaterThanOrEqual(0.5);

    // 1/5 content words overlap — should be below 0.5
    const low = wordOverlap(
      "heartbeat cost monitoring on Opus is expensive",
      "database query performance on PostgreSQL",
    );
    expect(low).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Parse reflection files
// ---------------------------------------------------------------------------

describe("parseReflectionFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hive-reflect-"));
  });

  test("parses sections and entries", async () => {
    const content = `# Reflections — 2026-04-12

## About Greg
- Greg prefers design-first approaches
- States constraints as hard boundaries

## About Maya
- Cost tables enable fast decisions

## About the System
- BM25 search improved retrieval quality
- Metadata sidecar keeps knowledge clean
`;
    const filePath = join(tempDir, "2026-04-12.md");
    await Bun.write(filePath, content);

    const result = await parseReflectionFile(filePath);
    expect(result.date).toBe("2026-04-12");
    expect(result.promoted).toBe(false);
    expect(result.entries.length).toBe(5);
    expect(result.entries.filter((e) => e.section === "greg").length).toBe(2);
    expect(result.entries.filter((e) => e.section === "maya").length).toBe(1);
    expect(result.entries.filter((e) => e.section === "system").length).toBe(2);
  });

  test("detects promoted frontmatter", async () => {
    const content = `---
promoted: 2026-04-12
---

# Reflections — 2026-04-10

## About the System
- Already promoted entry
`;
    const filePath = join(tempDir, "2026-04-10.md");
    await Bun.write(filePath, content);

    const result = await parseReflectionFile(filePath);
    expect(result.promoted).toBe(true);
    expect(result.entries.length).toBe(1);
  });

  test("handles file with no entries", async () => {
    const content = `# Reflections — 2026-04-12

Nothing notable today.
`;
    const filePath = join(tempDir, "2026-04-12.md");
    await Bun.write(filePath, content);

    const result = await parseReflectionFile(filePath);
    expect(result.entries.length).toBe(0);
  });

  test("strips bullet prefix from entry text", async () => {
    const content = `# Reflections

## About the System
- Entry with leading bullet stripped
`;
    const filePath = join(tempDir, "2026-04-12.md");
    await Bun.write(filePath, content);

    const result = await parseReflectionFile(filePath);
    expect(result.entries[0]!.text).toBe("Entry with leading bullet stripped");
  });
});

// ---------------------------------------------------------------------------
// Read unprocessed reflections
// ---------------------------------------------------------------------------

describe("readUnprocessedReflections", () => {
  let tempDir: string;
  let paths: HivePaths;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hive-reflect-"));
    paths = await ensureHiveScaffold(tempDir);
  });

  test("skips promoted files", async () => {
    await Bun.write(
      join(paths.reflectionsDir, "2026-04-10.md"),
      `---\npromoted: 2026-04-10\n---\n\n# Reflections\n\n## About the System\n- old entry\n`,
    );
    await Bun.write(
      join(paths.reflectionsDir, "2026-04-12.md"),
      `# Reflections\n\n## About the System\n- new entry\n`,
    );

    const results = await readUnprocessedReflections(paths);
    expect(results.length).toBe(1);
    expect(results[0]!.date).toBe("2026-04-12");
  });

  test("returns empty for no reflections", async () => {
    const results = await readUnprocessedReflections(paths);
    expect(results.length).toBe(0);
  });

  test("returns files in chronological order", async () => {
    await Bun.write(
      join(paths.reflectionsDir, "2026-04-12.md"),
      `# Reflections\n\n## About the System\n- later\n`,
    );
    await Bun.write(
      join(paths.reflectionsDir, "2026-04-10.md"),
      `# Reflections\n\n## About the System\n- earlier\n`,
    );

    const results = await readUnprocessedReflections(paths);
    expect(results[0]!.date).toBe("2026-04-10");
    expect(results[1]!.date).toBe("2026-04-12");
  });
});

// ---------------------------------------------------------------------------
// Full promotion roundtrip
// ---------------------------------------------------------------------------

describe("promoteReflections", () => {
  let tempDir: string;
  let paths: HivePaths;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hive-reflect-"));
    paths = await ensureHiveScaffold(tempDir);
    // Ensure project directory exists for inbox
    await mkdir(join(paths.projectsDir, "test-project"), { recursive: true });
  });

  test("promotes system entries to knowledge", async () => {
    await Bun.write(
      join(paths.reflectionsDir, "2026-04-12.md"),
      `# Reflections\n\n## About the System\n- BM25 search improved retrieval quality\n- Metadata sidecar keeps knowledge clean\n`,
    );

    const result = await promoteReflections(paths, "test-project");
    expect(result.promoted).toBe(2);
    expect(result.skipped).toBe(0);

    // Verify entries landed in knowledge
    const content = await Bun.file(knowledgePath(paths, "test-project")).text();
    expect(content).toContain("BM25 search improved retrieval quality");
    expect(content).toContain("[reflection]");
  });

  test("routes greg entries to inbox as proposals", async () => {
    await Bun.write(
      join(paths.reflectionsDir, "2026-04-12.md"),
      `# Reflections\n\n## About Greg\n- Prefers design-first approaches\n- States constraints as hard boundaries\n`,
    );

    const result = await promoteReflections(paths, "test-project");
    expect(result.proposed).toBe(2);

    const inbox = await Bun.file(join(paths.projectsDir, "test-project", "inbox.md")).text();
    expect(inbox).toContain("SELF.md");
    expect(inbox).toContain("Prefers design-first approaches");
    expect(inbox).toContain("States constraints as hard boundaries");
  });

  test("routes maya entries to inbox for IDENTITY.md", async () => {
    await Bun.write(
      join(paths.reflectionsDir, "2026-04-12.md"),
      `# Reflections\n\n## About Maya\n- Cost tables enable fast decisions\n`,
    );

    const result = await promoteReflections(paths, "test-project");
    expect(result.proposed).toBe(1);

    const inbox = await Bun.file(join(paths.projectsDir, "test-project", "inbox.md")).text();
    expect(inbox).toContain("IDENTITY.md");
    expect(inbox).toContain("Cost tables enable fast decisions");
  });

  test("deduplicates against existing knowledge", async () => {
    // Pre-populate knowledge with an entry
    await appendProjectMemory(
      paths, "test-project", "fact",
      "BM25 search improved retrieval quality significantly",
      ["search"],
    );

    await Bun.write(
      join(paths.reflectionsDir, "2026-04-12.md"),
      `# Reflections\n\n## About the System\n- BM25 search improved retrieval quality in HIVE memory\n- Brand new unrelated insight about deployment\n`,
    );

    const result = await promoteReflections(paths, "test-project");
    expect(result.skipped).toBe(1); // BM25 entry is duplicate
    expect(result.promoted).toBe(1); // deployment entry is novel
  });

  test("marks files as promoted", async () => {
    await Bun.write(
      join(paths.reflectionsDir, "2026-04-12.md"),
      `# Reflections\n\n## About the System\n- An entry\n`,
    );

    await promoteReflections(paths, "test-project");

    const content = await Bun.file(join(paths.reflectionsDir, "2026-04-12.md")).text();
    expect(content).toContain("promoted:");
  });

  test("is idempotent — second run finds nothing", async () => {
    await Bun.write(
      join(paths.reflectionsDir, "2026-04-12.md"),
      `# Reflections\n\n## About the System\n- An entry\n`,
    );

    await promoteReflections(paths, "test-project");
    const result = await promoteReflections(paths, "test-project");
    expect(result.promoted).toBe(0);
    expect(result.proposed).toBe(0);
    expect(result.skipped).toBe(0);
  });

  test("handles no unprocessed reflections", async () => {
    const result = await promoteReflections(paths, "test-project");
    expect(result.promoted).toBe(0);
    expect(result.details).toContain("No unprocessed reflections found.");
  });

  test("handles mixed sections in single file", async () => {
    await Bun.write(
      join(paths.reflectionsDir, "2026-04-12.md"),
      `# Reflections

## About Greg
- Greg prefers depth over breadth

## About Maya
- Brainstorm before building works well

## About the System
- Four projects now registered in HIVE
`,
    );

    const result = await promoteReflections(paths, "test-project");
    expect(result.promoted).toBe(1);   // system entry
    expect(result.proposed).toBe(2);   // greg + maya
  });

  test("processes multiple files in order", async () => {
    await Bun.write(
      join(paths.reflectionsDir, "2026-04-10.md"),
      `# Reflections\n\n## About the System\n- BM25 search engine provides ranked retrieval\n`,
    );
    await Bun.write(
      join(paths.reflectionsDir, "2026-04-12.md"),
      `# Reflections\n\n## About the System\n- Deploy procedure requires staging verification\n`,
    );

    const result = await promoteReflections(paths, "test-project");
    expect(result.promoted).toBe(2);

    // Both files should be marked
    const f1 = await Bun.file(join(paths.reflectionsDir, "2026-04-10.md")).text();
    const f2 = await Bun.file(join(paths.reflectionsDir, "2026-04-12.md")).text();
    expect(f1).toContain("promoted:");
    expect(f2).toContain("promoted:");
  });
});

// ---------------------------------------------------------------------------
// TK-027 / TK-057 — batch promotion + tightened gate
// ---------------------------------------------------------------------------

describe("projectFromReflectionEntry", () => {
  test("extracts project name from provenance hint", () => {
    expect(projectFromReflectionEntry(
      "Maya plans more than she ships  \n  _provenance:_ project=hive, topRanked[2]",
    )).toBe("hive");
  });

  test("returns null when no project= hint is present", () => {
    expect(projectFromReflectionEntry("Some unrelated text with no hint")).toBe(null);
  });

  test("is case-insensitive and accepts hyphens", () => {
    expect(projectFromReflectionEntry("text — provenance: Project=My-Project")).toBe("my-project");
  });
});

describe("promoteReflectionsBatch", () => {
  let tempDir: string;
  let paths: HivePaths;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hive-reflect-batch-"));
    paths = await ensureHiveScaffold(tempDir);
    await mkdir(join(paths.projectsDir, "alpha"), { recursive: true });
    await mkdir(join(paths.projectsDir, "bravo"), { recursive: true });
  });

  test("TK-027: routes per-entry to the project named in provenance", async () => {
    await Bun.write(
      join(paths.reflectionsDir, "2026-05-18.md"),
      `# Reflections\n\n## About the System\n- Alpha learned how to recover from worktree pruning  \n  _provenance:_ project=alpha, topRanked[1]\n- Bravo's deploy script needs idempotency  \n  _provenance:_ project=bravo, topRanked[2]\n- Orphan entry without a hint goes to the default\n`,
    );

    const result = await promoteReflectionsBatch(paths, {
      defaultProjectId: "alpha",
      eligibleProjectIds: new Set(["alpha", "bravo"]),
      date: "2026-05-18",
    });

    expect(result.filesProcessed).toBe(1);
    expect(result.promoted).toBe(3);
    expect(result.perProject.alpha?.promoted).toBe(2); // alpha + orphan-fallback
    expect(result.perProject.bravo?.promoted).toBe(1);

    const alphaKnowledge = await Bun.file(knowledgePath(paths, "alpha")).text();
    expect(alphaKnowledge).toContain("Alpha learned how to recover from worktree pruning");
    expect(alphaKnowledge).toContain("Orphan entry without a hint");
    const bravoKnowledge = await Bun.file(knowledgePath(paths, "bravo")).text();
    expect(bravoKnowledge).toContain("Bravo's deploy script needs idempotency");
  });

  test("TK-027: falls back to default when claimed project is not registered", async () => {
    await Bun.write(
      join(paths.reflectionsDir, "2026-05-18.md"),
      `# Reflections\n\n## About the System\n- Ghost project learned a thing  \n  _provenance:_ project=ghost, topRanked[1]\n`,
    );

    const result = await promoteReflectionsBatch(paths, {
      defaultProjectId: "alpha",
      eligibleProjectIds: new Set(["alpha", "bravo"]),
      date: "2026-05-18",
    });

    expect(result.perProject.alpha?.promoted).toBe(1);
    expect(result.perProject.ghost).toBeUndefined();
  });

  test("TK-057: dedupes a 'system' entry against identity stack with a citation", async () => {
    // Plant a SOUL.md-style paragraph the reflection paraphrases.
    await Bun.write(
      join(paths.home, "SOUL.md"),
      `# HIVE Soul\n\n### Solve the right problem\nFind the why under the ask. Symptoms are loud; causes are quiet — fix the cause and the symptom stops returning.\n`,
    );
    await Bun.write(
      join(paths.reflectionsDir, "2026-05-18.md"),
      `# Reflections\n\n## About the System\n- Solving the right problem means finding the why under the ask, not the symptom which is loud\n`,
    );

    const result = await promoteReflectionsBatch(paths, {
      defaultProjectId: "alpha",
      eligibleProjectIds: new Set(["alpha"]),
      date: "2026-05-18",
    });

    expect(result.skipped).toBe(1);
    expect(result.promoted).toBe(0);
    const note = result.details.find((d) => d.includes("skip (dup)"));
    expect(note).toBeDefined();
    expect(note).toContain("SOUL.md");
  });

  test("TK-057: also dedupes 'About Greg' identity proposals against SELF.md", async () => {
    await Bun.write(
      join(paths.home, "SELF.md"),
      `# Self\n\n## Preferences\nGreg prefers depth over breadth. Get one thing right.\n`,
    );
    await Bun.write(
      join(paths.reflectionsDir, "2026-05-18.md"),
      `# Reflections\n\n## About Greg\n- Greg prefers depth over breadth, would rather get one thing right than ship many half-baked\n`,
    );

    const result = await promoteReflectionsBatch(paths, {
      defaultProjectId: "alpha",
      eligibleProjectIds: new Set(["alpha"]),
      date: "2026-05-18",
    });

    expect(result.proposed).toBe(0);
    expect(result.skipped).toBe(1);
    const dropped = result.details.find((d) => d.includes("skip identity-proposal"));
    expect(dropped).toBeDefined();
    expect(dropped).toContain("SELF.md");
  });

  test("TK-057: rate-limits identity proposals and surfaces overflow", async () => {
    const bullets = [
      "- Greg prefers terse responses with no trailing summary",
      "- Greg signals 'these all sound like tickets' to mean stop analyzing and file them",
      "- Greg expects pre-action announcement of intent in one short sentence",
      "- Greg validates non-obvious approaches without follow-up; absence of criticism is approval",
    ].join("\n");
    await Bun.write(
      join(paths.reflectionsDir, "2026-05-18.md"),
      `# Reflections\n\n## About Greg\n${bullets}\n`,
    );

    const result = await promoteReflectionsBatch(paths, {
      defaultProjectId: "alpha",
      eligibleProjectIds: new Set(["alpha"]),
      date: "2026-05-18",
    });

    expect(result.proposed).toBe(2); // capped at IDENTITY_PROPOSAL_RATE_LIMIT
    const overflow = result.details.find((d) => d.includes("rate-limited"));
    expect(overflow).toBeDefined();
    expect(overflow).toContain("2 extra SELF.md proposal(s)");
  });

  test("TK-057: inbox uses 'candidates for promotion' framing instead of 'Proposed edits to'", async () => {
    await Bun.write(
      join(paths.reflectionsDir, "2026-05-18.md"),
      `# Reflections\n\n## About Maya\n- Maya holds tension between plan and ship\n`,
    );

    await promoteReflectionsBatch(paths, {
      defaultProjectId: "alpha",
      eligibleProjectIds: new Set(["alpha"]),
      date: "2026-05-18",
    });

    const inbox = await Bun.file(join(paths.projectsDir, "alpha", "inbox.md")).text();
    expect(inbox).toContain("Session learnings — candidates for promotion");
    expect(inbox).not.toContain("Proposed edits to");
    expect(inbox).toContain("Target: `IDENTITY.md`");
  });
});
