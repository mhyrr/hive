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
    expect(snapshot.facts).toContain("TypeScript is used");
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
    expect(snapshot.facts).toEqual(["fact one", "fact two", "fact three"]);
  });

  test("concurrent writes both land", async () => {
    const p1 = appendProjectMemory(paths, "test-project", "fact", "concurrent one");
    const p2 = appendProjectMemory(paths, "test-project", "fact", "concurrent two");
    await Promise.all([p1, p2]);
    const snapshot = await readProjectMemorySnapshot(paths, "test-project");
    expect(snapshot.facts).toContain("concurrent one");
    expect(snapshot.facts).toContain("concurrent two");
  });

  test("validation rejects bad input in full path", async () => {
    expect(appendProjectMemory(paths, "test-project", "fact", "")).rejects.toThrow("cannot be empty");
    expect(appendProjectMemory(paths, "test-project", "fact", "## header")).rejects.toThrow("markdown headers");
  });
});
