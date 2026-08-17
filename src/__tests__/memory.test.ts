import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  validateMemoryEntry,
  validateMemoryStructure,
  appendToSection,
  appendProjectMemory,
  readProjectMemorySnapshot,
  parseTags,
  formatTags,
  appendToLog,
  readLog,
  searchMemory,
  readMeta,
  SEARCH_TOP_K,
  formatSearchResults,
  rebuildIndex,
  supersedeEntry,
  knowledgePath,
  indexPath,
  metaPath,
  entryHash,
  parseRecurrence,
  formatRecurrence,
  markEntryRecurrence,
  INDEX_SIZE_BUDGET_BYTES,
  type MetaSidecar,
} from "../lib/memory";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";

// ---------------------------------------------------------------------------
// validateMemoryEntry
// ---------------------------------------------------------------------------

describe("validateMemoryEntry", () => {
  test("rejects empty string", () => {
    expect(() => validateMemoryEntry("")).toThrow("cannot be empty");
    expect(() => validateMemoryEntry("   ")).toThrow("cannot be empty");
  });

  test("rejects section header injection", () => {
    expect(() => validateMemoryEntry("## Durable Facts")).toThrow("markdown headers");
    expect(() => validateMemoryEntry("some text ## more")).toThrow("markdown headers");
  });

  test("rejects over-length entries", () => {
    const long = "a".repeat(1001);
    expect(() => validateMemoryEntry(long)).toThrow("exceeds 1000 characters");
  });

  test("strips leading bullet", () => {
    expect(validateMemoryEntry("- some fact")).toBe("some fact");
    expect(validateMemoryEntry("-  padded")).toBe("padded");
  });

  test("collapses newlines", () => {
    expect(validateMemoryEntry("line one\nline two\n\nline three")).toBe("line one line two line three");
  });

  test("passes normal text through", () => {
    expect(validateMemoryEntry("a valid memory entry")).toBe("a valid memory entry");
  });

  test("trims whitespace", () => {
    expect(validateMemoryEntry("  padded  ")).toBe("padded");
  });
});

// ---------------------------------------------------------------------------
// validateMemoryStructure
// ---------------------------------------------------------------------------

const validFile = `# Project Memory: test

## Durable Facts
- fact one

## Conventions
- conv one

## Decisions
- [2026-01-01] decision one

## Open Questions
- question one
`;

describe("validateMemoryStructure", () => {
  test("valid file passes", () => {
    expect(validateMemoryStructure(validFile)).toEqual({ valid: true });
  });

  test("missing title fails", () => {
    const bad = validFile.replace("# Project Memory:", "# Wrong Title:");
    expect(validateMemoryStructure(bad).valid).toBe(false);
    expect(validateMemoryStructure(bad).error).toContain("must start with");
  });

  test("missing section fails", () => {
    const bad = validFile.replace("## Conventions\n", "");
    expect(validateMemoryStructure(bad).valid).toBe(false);
    expect(validateMemoryStructure(bad).error).toContain("Missing section");
  });

  test("duplicate section fails", () => {
    const bad = validFile + "\n## Durable Facts\n- duplicate\n";
    expect(validateMemoryStructure(bad).valid).toBe(false);
    expect(validateMemoryStructure(bad).error).toContain("Duplicate section");
  });

  test("wrong order fails", () => {
    const bad = `# Project Memory: test

## Conventions
- conv

## Durable Facts
- fact

## Decisions
- dec

## Open Questions
- q
`;
    expect(validateMemoryStructure(bad).valid).toBe(false);
    expect(validateMemoryStructure(bad).error).toContain("out of expected order");
  });
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

describe("parseTags", () => {
  test("parses inline tags", () => {
    expect(parseTags("some fact [auth, security]")).toEqual({
      text: "some fact",
      tags: ["auth", "security"],
    });
  });

  test("handles no tags", () => {
    expect(parseTags("plain text")).toEqual({ text: "plain text", tags: [] });
  });

  test("normalizes to lowercase", () => {
    expect(parseTags("thing [Auth, API]")).toEqual({
      text: "thing",
      tags: ["auth", "api"],
    });
  });

  test("rejects a bracket containing an over-length tag — kept as prose", () => {
    const blob = "a".repeat(41);
    const input = `some fact [${blob}]`;
    expect(parseTags(input)).toEqual({ text: input, tags: [] });
  });

  test("rejects a bracket containing sentence punctuation — kept as prose", () => {
    const input = "some fact [this looks like prose. it has sentences]";
    expect(parseTags(input)).toEqual({ text: input, tags: [] });
    const mixed = "other fact [auth, but why? unclear]";
    expect(parseTags(mixed)).toEqual({ text: mixed, tags: [] });
  });

  test("accepts hyphenated tags up to 40 chars", () => {
    expect(parseTags("thing [claude-code-integration, design-question]")).toEqual({
      text: "thing",
      tags: ["claude-code-integration", "design-question"],
    });
  });
});

describe("formatTags", () => {
  test("formats tag array", () => {
    expect(formatTags(["auth", "api"])).toBe(" [auth, api]");
  });

  test("empty array returns empty string", () => {
    expect(formatTags([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// appendToSection
// ---------------------------------------------------------------------------

describe("appendToSection", () => {
  test("appends to existing section", () => {
    const result = appendToSection(validFile, "## Durable Facts", "- new fact");
    expect(result).toContain("- fact one");
    expect(result).toContain("- new fact");
  });

  test("replaces (none yet) placeholder", () => {
    const empty = `# Project Memory: test

## Durable Facts
(none yet)

## Conventions
(none yet)

## Decisions
(none yet)

## Open Questions
(none yet)
`;
    const result = appendToSection(empty, "## Durable Facts", "- first fact");
    expect(result).toContain("- first fact");
    expect(result).not.toContain("(none yet)\n\n## Conventions");
  });

  test("creates section if missing", () => {
    const noSection = `# Project Memory: test

## Durable Facts
- fact
`;
    const result = appendToSection(noSection, "## New Section", "- entry");
    expect(result).toContain("## New Section");
    expect(result).toContain("- entry");
  });
});

// ---------------------------------------------------------------------------
// Full roundtrip with temp directory
// ---------------------------------------------------------------------------

describe("appendProjectMemory + readProjectMemorySnapshot", () => {
  let tempDir: string;
  let paths: HivePaths;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hive-test-"));
    paths = await ensureHiveScaffold(tempDir);
  });

  test("write and read back a fact", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "TypeScript is used");
    const snapshot = await readProjectMemorySnapshot(paths, "test-project");
    expect(snapshot.facts.some((f) => f.text === "TypeScript is used")).toBe(true);
  });

  test("write with tags and read back", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "Uses Bun runtime", ["runtime", "infrastructure"]);
    const snapshot = await readProjectMemorySnapshot(paths, "test-project");
    const entry = snapshot.facts.find((f) => f.text === "Uses Bun runtime");
    expect(entry).toBeTruthy();
    expect(entry!.tags).toEqual(["runtime", "infrastructure"]);
  });

  test("write and read back a decision", async () => {
    await appendProjectMemory(paths, "test-project", "decision", "Use Bun for builds");
    const snapshot = await readProjectMemorySnapshot(paths, "test-project");
    expect(snapshot.decisions.length).toBe(1);
    expect(snapshot.decisions[0]!.text).toBe("Use Bun for builds");
    expect(snapshot.decisions[0]!.ts).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("multiple writes to same section accumulate", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "fact one");
    await appendProjectMemory(paths, "test-project", "fact", "fact two");
    await appendProjectMemory(paths, "test-project", "fact", "fact three");
    const snapshot = await readProjectMemorySnapshot(paths, "test-project");
    expect(snapshot.facts.map((f) => f.text)).toEqual(["fact one", "fact two", "fact three"]);
  });

  test("concurrent writes both land", async () => {
    const p1 = appendProjectMemory(paths, "test-project", "fact", "concurrent one");
    const p2 = appendProjectMemory(paths, "test-project", "fact", "concurrent two");
    await Promise.all([p1, p2]);
    const snapshot = await readProjectMemorySnapshot(paths, "test-project");
    const texts = snapshot.facts.map((f) => f.text);
    expect(texts).toContain("concurrent one");
    expect(texts).toContain("concurrent two");
  });

  test("validation rejects bad input in full path", async () => {
    expect(appendProjectMemory(paths, "test-project", "fact", "")).rejects.toThrow("cannot be empty");
    expect(appendProjectMemory(paths, "test-project", "fact", "## header")).rejects.toThrow("markdown headers");
  });

  test("knowledge file lives in project directory", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "a fact");
    const kPath = knowledgePath(paths, "test-project");
    expect(kPath).toContain("test-project/knowledge.md");
    const file = Bun.file(kPath);
    expect(await file.exists()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Supersession
// ---------------------------------------------------------------------------

describe("supersedeEntry", () => {
  let tempDir: string;
  let paths: HivePaths;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hive-test-"));
    paths = await ensureHiveScaffold(tempDir);
  });

  test("supersede marks old entry and adds new one", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "Uses express-session", ["auth"]);
    await supersedeEntry(paths, "test-project", "fact", "Uses express-session", "Uses stateless JWT", ["auth"]);
    const snapshot = await readProjectMemorySnapshot(paths, "test-project");
    expect(snapshot.facts.length).toBe(2);
    expect(snapshot.facts[0]!.superseded).toBe(true);
    expect(snapshot.facts[1]!.text).toBe("Uses stateless JWT");
    expect(snapshot.facts[1]!.superseded).toBeFalsy();
  });

  test("supersede throws if old entry not found", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "some fact");
    expect(
      supersedeEntry(paths, "test-project", "fact", "nonexistent entry", "new entry")
    ).rejects.toThrow("Could not find active entry");
  });
});

// ---------------------------------------------------------------------------
// Recurrence (TK-147)
// ---------------------------------------------------------------------------

describe("parseRecurrence / formatRecurrence", () => {
  test("an unmarked entry has been seen once", () => {
    const r = parseRecurrence("Is the heartbeat still earning its keep?");
    expect(r.count).toBe(1);
    expect(r.lastSeen).toBeNull();
    expect(r.text).toBe("Is the heartbeat still earning its keep?");
  });

  test("round-trips a marker", () => {
    const marked = `Still open?${formatRecurrence(4, "2026-08-17")}`;
    expect(marked).toBe("Still open? _(seen 4×, last 2026-08-17)_");
    const r = parseRecurrence(marked);
    expect(r).toEqual({ text: "Still open?", count: 4, lastSeen: "2026-08-17" });
  });

  test("prose that merely looks like a marker is left alone", () => {
    const text = "We render _(seen N×, last DATE)_ on recurring gaps";
    expect(parseRecurrence(text).text).toBe(text);
  });
});

describe("markEntryRecurrence", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    paths = await ensureHiveScaffold(await mkdtemp(join(tmpdir(), "hive-recur-")));
  });

  test("annotates the entry in place instead of adding one", async () => {
    await appendProjectMemory(paths, "alpha", "question", "Is the heartbeat earning its keep?", ["gap"]);
    const hash = entryHash("Is the heartbeat earning its keep?");

    const r = await markEntryRecurrence(paths, "alpha", "question", hash, "2026-08-17");
    expect(r.count).toBe(2);
    expect(r.text).toBe("Is the heartbeat earning its keep?");

    const snap = await readProjectMemorySnapshot(paths, "alpha");
    expect(snap.questions.length).toBe(1);
    expect(snap.questions[0]!.text).toBe(
      "Is the heartbeat earning its keep? _(seen 2×, last 2026-08-17)_",
    );
    expect(snap.questions[0]!.tags).toEqual(["gap"]);
  });

  test("increments across nights and keeps the entry's identity", async () => {
    await appendProjectMemory(paths, "alpha", "question", "Still unanswered?", ["gap"]);
    const hash = entryHash("Still unanswered?");

    await markEntryRecurrence(paths, "alpha", "question", hash, "2026-08-16");
    const third = await markEntryRecurrence(paths, "alpha", "question", hash, "2026-08-17");
    expect(third.count).toBe(3);

    const snap = await readProjectMemorySnapshot(paths, "alpha");
    expect(snap.questions.length).toBe(1);
    expect(snap.questions[0]!.text).toContain("_(seen 3×, last 2026-08-17)_");
    // The marker is metadata: hashing the rendered line still yields the
    // original hash, so meta stays linked and the verifier can still target it.
    expect(entryHash(snap.questions[0]!.text)).toBe(hash);

    const meta = await readMeta(paths, "alpha");
    expect(meta.entries[hash]).toBeTruthy();
    expect(meta.entries[hash]!.recallCount).toBeGreaterThan(0);
  });

  test("throws when no active entry carries the hash", async () => {
    await appendProjectMemory(paths, "alpha", "question", "Some question?");
    expect(
      markEntryRecurrence(paths, "alpha", "question", "deadbeef"),
    ).rejects.toThrow("No active question entry");
  });
});

// ---------------------------------------------------------------------------
// Session Log
// ---------------------------------------------------------------------------

describe("session log", () => {
  let tempDir: string;
  let paths: HivePaths;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hive-test-"));
    paths = await ensureHiveScaffold(tempDir);
  });

  test("appendToLog creates daily log file", async () => {
    const filePath = await appendToLog(paths, "test-project", [
      { type: "fact", content: "discovered something" },
      { type: "decision", content: "chose approach A" },
    ]);
    expect(filePath).toContain("/log/");
    expect(filePath).toMatch(/\d{4}-\d{2}-\d{2}\.md$/);
    const content = await Bun.file(filePath).text();
    expect(content).toContain("fact | discovered something");
    expect(content).toContain("decision | chose approach A");
  });

  test("readLog returns parsed entries", async () => {
    await appendToLog(paths, "test-project", [
      { type: "fact", content: "test entry" },
    ]);
    const entries = await readLog(paths, "test-project", 7);
    expect(entries.length).toBe(1);
    expect(entries[0]!.type).toBe("fact");
    expect(entries[0]!.text).toBe("test entry");
  });

  test("multiple appends to same day accumulate", async () => {
    await appendToLog(paths, "test-project", [{ type: "fact", content: "first" }]);
    await appendToLog(paths, "test-project", [{ type: "fact", content: "second" }]);
    const entries = await readLog(paths, "test-project", 7);
    expect(entries.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

describe("searchMemory", () => {
  let tempDir: string;
  let paths: HivePaths;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hive-test-"));
    paths = await ensureHiveScaffold(tempDir);
  });

  test("finds entries in knowledge by text", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "Auth uses JWT tokens", ["auth"]);
    await appendProjectMemory(paths, "test-project", "fact", "Database is Postgres", ["database"]);
    const { results } = await searchMemory(paths, "test-project", "auth");
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.entry.includes("JWT"))).toBe(true);
  });

  test("finds entries by tag", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "some auth fact", ["auth"]);
    await appendProjectMemory(paths, "test-project", "fact", "some db fact", ["database"]);
    const { results } = await searchMemory(paths, "test-project", "fact", { tag: "auth" });
    expect(results.every((r) => r.tags.includes("auth") || r.source !== "knowledge")).toBe(true);
  });

  test("finds entries in log", async () => {
    await appendToLog(paths, "test-project", [{ type: "fact", content: "discovered JWT issue" }]);
    // Logs are opt-in now — excluded by default, returned when asked.
    const off = await searchMemory(paths, "test-project", "JWT");
    expect(off.results.some((r) => r.source === "log")).toBe(false);
    const { results } = await searchMemory(paths, "test-project", "JWT", { includeLogs: true });
    expect(results.some((r) => r.source === "log")).toBe(true);
  });

  test("excludes superseded entries by default", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "Uses express-session", ["auth"]);
    await supersedeEntry(paths, "test-project", "fact", "Uses express-session", "Uses JWT", ["auth"]);
    const { results } = await searchMemory(paths, "test-project", "auth");
    const knowledgeResults = results.filter((r) => r.source === "knowledge");
    // Should only find the active entry
    expect(knowledgeResults.some((r) => r.entry.includes("JWT"))).toBe(true);
    expect(knowledgeResults.some((r) => r.entry.includes("express-session"))).toBe(false);
  });

  test("caps results at topK and reports what it dropped", async () => {
    // 20 entries that all match "auth" — the shape that produced 162-result
    // responses before the cap existed.
    for (let i = 0; i < 20; i++) {
      await appendProjectMemory(paths, "test-project", "fact", `Auth detail number ${i} about tokens`, ["auth"]);
    }
    const { results, total } = await searchMemory(paths, "test-project", "auth tokens");
    expect(results.length).toBe(SEARCH_TOP_K);
    expect(total).toBeGreaterThan(SEARCH_TOP_K);

    const output = formatSearchResults(results, "auth tokens", total);
    expect(output).toContain(`Showing top ${SEARCH_TOP_K} of ${total}`);
  });

  test("topK is overridable", async () => {
    for (let i = 0; i < 20; i++) {
      await appendProjectMemory(paths, "test-project", "fact", `Auth detail number ${i} about tokens`, ["auth"]);
    }
    const { results } = await searchMemory(paths, "test-project", "auth tokens", { topK: 3 });
    expect(results.length).toBe(3);
  });

  test("the relevance floor drops weak matches below a dominant hit", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "Postgres connection pooling uses PgBouncer in transaction mode", ["db"]);
    for (let i = 0; i < 5; i++) {
      await appendProjectMemory(paths, "test-project", "fact", `Unrelated note ${i} mentioning mode once`, ["misc"]);
    }
    // A sharp query: one entry carries every term, the others share one weak term.
    const { results } = await searchMemory(paths, "test-project", "PgBouncer transaction pooling");
    expect(results.length).toBeLessThan(6);
    expect(results[0]!.entry).toContain("PgBouncer");
  });

  test("retrieval strengthening bumps only what was returned", async () => {
    for (let i = 0; i < 20; i++) {
      await appendProjectMemory(paths, "test-project", "fact", `Auth detail number ${i} about tokens`, ["auth"]);
    }
    await searchMemory(paths, "test-project", "auth tokens");
    const meta = await readMeta(paths, "test-project");
    const bumped = Object.values(meta.entries).filter((m) => m.recallCount > 0);
    // Previously every entry scoring above zero was strengthened, which flattens
    // decay: if everything is recalled, nothing ever ranks lower.
    expect(bumped.length).toBe(SEARCH_TOP_K);
  });

  test("a dedupe probe does not strengthen anything", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "Auth uses JWT tokens", ["auth"]);
    await searchMemory(paths, "test-project", "auth tokens", { noBump: true });
    const meta = await readMeta(paths, "test-project");
    expect(Object.values(meta.entries).every((m) => m.recallCount === 0)).toBe(true);
  });

  test("formatSearchResults produces readable output", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "Uses Bun runtime", ["runtime"]);
    const { results } = await searchMemory(paths, "test-project", "Bun");
    const output = formatSearchResults(results, "Bun");
    expect(output).toContain("Knowledge (compiled)");
    expect(output).toContain("Bun runtime");
  });
});

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

describe("rebuildIndex", () => {
  let tempDir: string;
  let paths: HivePaths;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "hive-test-"));
    paths = await ensureHiveScaffold(tempDir);
  });

  test("generates index with summary", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "Uses TypeScript", ["language"]);
    await appendProjectMemory(paths, "test-project", "decision", "Chose Bun over Node", ["runtime"]);
    const output = await rebuildIndex(paths, "test-project");
    expect(output).toContain("# Index: test-project");
    expect(output).toContain("1 facts");
    expect(output).toContain("1 decisions");
    expect(output).toContain("language");
    expect(output).toContain("runtime");
  });

  test("index file is written to disk", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "a fact");
    await rebuildIndex(paths, "test-project");
    const iPath = indexPath(paths, "test-project");
    const content = await Bun.file(iPath).text();
    expect(content).toContain("# Index: test-project");
  });

  test("auto-load strengthening — bumps damped recall for indexed facts", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "auto-load fact one");
    await appendProjectMemory(paths, "test-project", "convention", "auto-load convention one");
    await appendProjectMemory(paths, "test-project", "decision", "auto-load decision one");
    await appendProjectMemory(paths, "test-project", "question", "auto-load question one");

    await rebuildIndex(paths, "test-project");

    const meta: MetaSidecar = await Bun.file(metaPath(paths, "test-project")).json();
    const factHash = entryHash("auto-load fact one");
    const convHash = entryHash("auto-load convention one");
    const decisionHash = entryHash("auto-load decision one");
    const questionHash = entryHash("auto-load question one");

    expect(meta.entries[factHash]?.recallCount).toBe(0.25);
    expect(meta.entries[factHash]?.halfLife).toBe(31);
    expect(meta.entries[convHash]?.recallCount).toBe(0.25);
    expect(meta.entries[decisionHash]?.recallCount).toBe(0.25);
    expect(meta.entries[questionHash]?.recallCount).toBe(0.25);
  });

  test("auto-load bumps accumulate across multiple rebuilds", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "persistent fact");

    await rebuildIndex(paths, "test-project");
    await rebuildIndex(paths, "test-project");
    await rebuildIndex(paths, "test-project");
    await rebuildIndex(paths, "test-project");

    const meta: MetaSidecar = await Bun.file(metaPath(paths, "test-project")).json();
    const hash = entryHash("persistent fact");
    // 4 damped bumps: recallCount 0 + 0.25*4 = 1.0, halfLife 30 + 1*4 = 34
    expect(meta.entries[hash]?.recallCount).toBeCloseTo(1.0, 5);
    expect(meta.entries[hash]?.halfLife).toBe(34);
  });

  test("omits the Tags section", async () => {
    await appendProjectMemory(paths, "test-project", "fact", "tagged fact one", ["auth", "api"]);
    await appendProjectMemory(paths, "test-project", "fact", "tagged fact two", ["auth"]);
    const output = await rebuildIndex(paths, "test-project");
    expect(output).not.toContain("## Tags");
  });

  test("excludes gap-tagged questions from Open Questions", async () => {
    await appendProjectMemory(paths, "test-project", "question", "a real open question", ["design"]);
    await appendProjectMemory(paths, "test-project", "question", "pipeline gap self-report", ["gap"]);
    const output = await rebuildIndex(paths, "test-project");
    expect(output).toContain("a real open question");
    expect(output).not.toContain("pipeline gap self-report");

    // Excluded entries earn no auto-load strengthening
    const meta: MetaSidecar = await Bun.file(metaPath(paths, "test-project")).json();
    expect(meta.entries[entryHash("pipeline gap self-report")]?.recallCount).toBe(0);
  });

  test("truncates long entries with a search_memory pointer", async () => {
    const longFact = ("alpha bravo charlie delta ".repeat(30)).trim(); // ~780 chars
    const longDecision = ("echo foxtrot golf hotel ".repeat(30)).trim();
    await appendProjectMemory(paths, "test-project", "fact", longFact, ["long"]);
    await appendProjectMemory(paths, "test-project", "decision", longDecision, ["long"]);
    const output = await rebuildIndex(paths, "test-project");
    expect(output).not.toContain(longFact);
    expect(output).not.toContain(longDecision);
    expect(output).toContain("truncated — search_memory for the rest");
    // Every rendered line stays within the entry cap plus marker/tags slack
    for (const line of output.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(520);
    }
  });

  test("caps Key Facts at 15 with an overflow pointer", async () => {
    for (let i = 1; i <= 17; i++) {
      const label = String(i).padStart(2, "0");
      await appendProjectMemory(paths, "test-project", "fact", `numbered fact ${label}`);
    }
    const output = await rebuildIndex(paths, "test-project");
    expect(output).toContain("numbered fact 15");
    expect(output).not.toContain("numbered fact 16");
    expect(output).not.toContain("numbered fact 17");
    expect(output).toContain("2 more — use search_memory");
  });

  test("caps Conventions at 10", async () => {
    for (let i = 1; i <= 12; i++) {
      const label = String(i).padStart(2, "0");
      await appendProjectMemory(paths, "test-project", "convention", `numbered convention ${label}`);
    }
    const output = await rebuildIndex(paths, "test-project");
    expect(output).toContain("numbered convention 10");
    expect(output).not.toContain("numbered convention 11");
  });

  test("caps Open Questions at 10", async () => {
    for (let i = 1; i <= 12; i++) {
      const label = String(i).padStart(2, "0");
      await appendProjectMemory(paths, "test-project", "question", `numbered question ${label}`);
    }
    const output = await rebuildIndex(paths, "test-project");
    expect(output).toContain("numbered question 10");
    expect(output).not.toContain("numbered question 11");
  });

  test("caps Recent Decisions at 5 most recent with an overflow pointer", async () => {
    for (let i = 1; i <= 8; i++) {
      const label = String(i).padStart(2, "0");
      await appendProjectMemory(paths, "test-project", "decision", `numbered decision ${label}`);
    }
    const output = await rebuildIndex(paths, "test-project");
    expect(output).toContain("numbered decision 08");
    expect(output).toContain("numbered decision 04");
    expect(output).not.toContain("numbered decision 03");
    expect(output).toContain("3 more — use search_memory");
  });

  test("worst-case corpus stays within the whole-index size budget", async () => {
    // Max-length entries in every section — the shape of real verbose canon.
    const longText = (label: string) => `${label} ${"word ".repeat(185)}`.trim(); // ~930 chars
    for (let i = 1; i <= 20; i++) {
      await appendProjectMemory(paths, "test-project", "fact", longText(`fact-${i}`), ["a-tag", "another-tag"]);
    }
    for (let i = 1; i <= 12; i++) {
      await appendProjectMemory(paths, "test-project", "convention", longText(`conv-${i}`), ["a-tag"]);
    }
    for (let i = 1; i <= 12; i++) {
      await appendProjectMemory(paths, "test-project", "question", longText(`ques-${i}`), ["a-tag"]);
    }
    for (let i = 1; i <= 8; i++) {
      await appendProjectMemory(paths, "test-project", "decision", longText(`deci-${i}`), ["a-tag"]);
    }
    await appendToLog(
      paths,
      "test-project",
      Array.from({ length: 12 }, (_, i) => ({ type: "fact" as const, content: longText(`log-${i}`) })),
    );
    const output = await rebuildIndex(paths, "test-project");
    expect(Buffer.byteLength(output, "utf-8")).toBeLessThanOrEqual(INDEX_SIZE_BUDGET_BYTES);
  });
});
