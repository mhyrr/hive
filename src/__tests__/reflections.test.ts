import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  parseReflectionFile,
  readUnprocessedReflections,
  promoteReflections,
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
