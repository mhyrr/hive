import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
};

let context: TestContext;

async function setupContext(): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), "hive-memory-"));
  const repo = join(root, "repo");
  const hiveHome = join(root, ".hive");

  await mkdir(repo, { recursive: true });

  process.env.HIVE_HOME = hiveHome;
  process.env.HIVE_FIXED_NOW = "2026-03-09T15:08:00Z";

  return { root, repo, hiveHome };
}

async function initAndAddProject(): Promise<void> {
  await runCli(["init"]);
  await runCli(["project", "add", "TestProject", context.repo]);
}

beforeEach(async () => {
  context = await setupContext();
});

afterEach(async () => {
  delete process.env.HIVE_HOME;
  delete process.env.HIVE_FIXED_NOW;
  await rm(context.root, { recursive: true, force: true });
});

describe("hive memory", () => {
  test("hive memory shows project memory for active project", async () => {
    await initAndAddProject();

    const output = await runCli(["memory"]);

    expect(output).toContain("# Project Memory: TestProject");
    expect(output).toContain("## Durable Facts");
    expect(output).toContain("## Conventions");
    expect(output).toContain("## Decisions");
    expect(output).toContain("## Open Questions");
  });

  test("hive memory fact appends to Durable Facts section", async () => {
    await initAndAddProject();

    const output = await runCli(["memory", "fact", "Uses", "Bun", "runtime"]);

    expect(output).toBe("Recorded fact: Uses Bun runtime");

    const memory = await runCli(["memory"]);

    expect(memory).toContain("- Uses Bun runtime");

    // The Durable Facts section should no longer have the placeholder
    const factsSection = memory.slice(
      memory.indexOf("## Durable Facts"),
      memory.indexOf("## Conventions"),
    );
    expect(factsSection).not.toContain("(none yet)");
  });

  test("hive memory convention appends to Conventions section", async () => {
    await initAndAddProject();

    const output = await runCli(["memory", "convention", "snake_case", "for", "file", "names"]);

    expect(output).toBe("Recorded convention: snake_case for file names");

    const memory = await runCli(["memory"]);
    const conventionsIndex = memory.indexOf("## Conventions");
    const decisionsIndex = memory.indexOf("## Decisions");
    const conventionsSection = memory.slice(conventionsIndex, decisionsIndex);

    expect(conventionsSection).toContain("- snake_case for file names");
  });

  test("hive memory decision appends to Decisions section with timestamp", async () => {
    await initAndAddProject();

    const output = await runCli(["memory", "decision", "Use", "SQLite", "for", "persistence"]);

    expect(output).toBe("Recorded decision: Use SQLite for persistence");

    const memory = await runCli(["memory"]);
    const decisionsIndex = memory.indexOf("## Decisions");
    const questionsIndex = memory.indexOf("## Open Questions");
    const decisionsSection = memory.slice(decisionsIndex, questionsIndex);

    expect(decisionsSection).toContain("- [2026-03-09T15:08:00Z] Use SQLite for persistence");
  });

  test("hive memory question appends to Open Questions section", async () => {
    await initAndAddProject();

    const output = await runCli(["memory", "question", "Should", "we", "add", "caching?"]);

    expect(output).toBe("Recorded question: Should we add caching?");

    const memory = await runCli(["memory"]);
    const questionsIndex = memory.indexOf("## Open Questions");

    expect(memory.slice(questionsIndex)).toContain("- Should we add caching?");
  });

  test("multiple appends accumulate correctly", async () => {
    await initAndAddProject();

    await runCli(["memory", "fact", "Uses Bun runtime"]);
    await runCli(["memory", "fact", "TypeScript only"]);
    await runCli(["memory", "convention", "No npm deps"]);
    await runCli(["memory", "decision", "Markdown for state"]);
    await runCli(["memory", "question", "Need a DB?"]);

    const memory = await runCli(["memory"]);

    expect(memory).toContain("- Uses Bun runtime");
    expect(memory).toContain("- TypeScript only");
    expect(memory).toContain("- No npm deps");
    expect(memory).toContain("- [2026-03-09T15:08:00Z] Markdown for state");
    expect(memory).toContain("- Need a DB?");

    // All (none yet) placeholders should be gone for sections with entries
    const factsSection = memory.slice(
      memory.indexOf("## Durable Facts"),
      memory.indexOf("## Conventions"),
    );
    expect(factsSection).not.toContain("(none yet)");
  });

  test("(none yet) placeholder gets replaced on first entry", async () => {
    await initAndAddProject();

    const memoryBefore = await runCli(["memory"]);
    const factsSectionBefore = memoryBefore.slice(
      memoryBefore.indexOf("## Durable Facts"),
      memoryBefore.indexOf("## Conventions"),
    );
    expect(factsSectionBefore).toContain("(none yet)");

    await runCli(["memory", "fact", "First fact"]);

    const memoryAfter = await runCli(["memory"]);
    const factsSectionAfter = memoryAfter.slice(
      memoryAfter.indexOf("## Durable Facts"),
      memoryAfter.indexOf("## Conventions"),
    );
    expect(factsSectionAfter).not.toContain("(none yet)");
    expect(factsSectionAfter).toContain("- First fact");
  });

  test("error when no active project", async () => {
    await runCli(["init"]);

    try {
      await runCli(["memory"]);
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.message).toContain("No active project");
    }
  });

  test("error when missing text", async () => {
    await initAndAddProject();

    try {
      await runCli(["memory", "fact"]);
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.message).toContain("Usage: hive memory fact <text>");
    }
  });

  test("error for unknown section", async () => {
    await initAndAddProject();

    try {
      await runCli(["memory", "bogus", "some text"]);
      expect(true).toBe(false); // Should not reach here
    } catch (err: any) {
      expect(err.message).toContain("Unknown memory section: bogus");
    }
  });

  test("memory updates are logged to feed", async () => {
    await initAndAddProject();

    await runCli(["memory", "fact", "Uses Bun runtime"]);

    const feed = await runCli(["feed", "5"]);

    expect(feed).toContain("Memory updated: fact");
    expect(feed).toContain("Uses Bun runtime");
  });

  test("memory extract writes journal, derived state, and project entity summary", async () => {
    await initAndAddProject();
    await runCli(["memory", "fact", "Uses Bun runtime"]);
    await runCli(["memory", "convention", "Keep state on disk"]);
    await runCli(["memory", "decision", "Ship a persistent steward"]);
    await runCli(["approval", "request", "deploy", "Promote the latest build"]);

    const output = await runCli(["memory", "extract"]);

    expect(output).toContain("Extracted memory");

    const journal = await Bun.file(
      join(context.hiveHome, "memory", "journal", "2026", "03", "09.md"),
    ).text();
    const summary = JSON.parse(
      await Bun.file(join(context.hiveHome, "memory", "state", "memory-summary.json")).text(),
    ) as {
      knowledge: string[];
      projects: Array<{ id: string; facts: string[]; conventions: string[] }>;
    };
    const recentDecisions = JSON.parse(
      await Bun.file(join(context.hiveHome, "memory", "state", "recent-decisions.json")).text(),
    ) as {
      items: Array<{ project: string | null; text: string }>;
    };
    const projectEntitySummary = await Bun.file(
      join(context.hiveHome, "memory", "entities", "projects", "testproject", "summary.md"),
    ).text();

    expect(journal).toContain("# Journal: 2026-03-09");
    expect(journal).toContain("approval.requested [testproject] Promote the latest build");
    expect(summary.projects[0]?.id).toBe("testproject");
    expect(summary.projects[0]?.facts).toContain("Uses Bun runtime");
    expect(summary.projects[0]?.conventions).toContain("Keep state on disk");
    expect(recentDecisions.items.some((item) => item.text === "Ship a persistent steward")).toBeTrue();
    expect(projectEntitySummary).toContain("# Entity Memory: project/testproject");
    expect(projectEntitySummary).toContain("Uses Bun runtime");
  });

  test("entity memory supports durable person notes", async () => {
    await initAndAddProject();

    const first = await runCli([
      "memory",
      "entity",
      "person",
      "greg",
      "fact",
      "Prefers direct, high-signal updates",
    ]);
    const second = await runCli([
      "memory",
      "entity",
      "person",
      "greg",
      "note",
      "Re-check gateway UX before adding more automation",
    ]);
    const summaryUpdate = await runCli([
      "memory",
      "entity",
      "person",
      "greg",
      "summary",
      "Founder and primary operator for HIVE.",
    ]);
    const detail = await runCli(["memory", "entity", "person", "greg"]);
    const items = await Bun.file(
      join(context.hiveHome, "memory", "entities", "people", "greg", "items.jsonl"),
    ).text();

    expect(first).toContain("Recorded fact for person/greg");
    expect(second).toContain("Recorded note for person/greg");
    expect(summaryUpdate).toContain("Recorded summary for person/greg");
    expect(detail).toContain("Founder and primary operator for HIVE.");
    expect(detail).toContain("Prefers direct, high-signal updates");
    expect(detail).toContain("Re-check gateway UX before adding more automation");
    expect(items).toContain("\"type\":\"fact\"");
    expect(items).toContain("\"type\":\"note\"");
  });

  test("prompt includes compact durable memory digests", async () => {
    await initAndAddProject();
    await runCli(["memory", "fact", "Uses Bun runtime"]);
    await runCli(["memory", "decision", "Use file-backed events"]);

    const prompt = await runCli(["prompt", "alpha"]);
    const heat = JSON.parse(
      await Bun.file(join(context.hiveHome, "memory", "state", "memory-heat.json")).text(),
    ) as {
      projects: Array<{ id: string; accessCount: number; lastAccessed: string | null }>;
    };

    expect(prompt).toContain("## Durable Memory");
    expect(prompt).toContain("Uses Bun runtime");
    expect(prompt).toContain("Use file-backed events");
    expect(heat.projects.find((project) => project.id === "testproject")?.accessCount).toBe(1);
    expect(heat.projects.find((project) => project.id === "testproject")?.lastAccessed).toBe(
      "2026-03-09T15:08:00Z",
    );
  });
});
