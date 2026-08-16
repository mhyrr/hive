import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildContextReport, CONTEXT_BUDGETS, estimateTokens } from "../lib/context-report";
import { INDEX_SIZE_BUDGET_BYTES } from "../lib/memory";

// ---------------------------------------------------------------------------
// Fixture: a self-contained ~/.hive scaffold + project, same shape as
// identity.test.ts — the report measures the identity injection, so the
// fixture must satisfy the same layout.
// ---------------------------------------------------------------------------

let tempHive: string;
let tempCwd: string;
let originalHiveHome: string | undefined;
let originalCwd: string;

async function seedHive(hiveDir: string, projectId: string, projectPath: string): Promise<void> {
  await mkdir(hiveDir, { recursive: true });

  await writeFile(join(hiveDir, "SOUL.md"), "# soul-marker\n");
  await writeFile(join(hiveDir, "IDENTITY.md"), "# identity-marker\n- Name: TestMaya\n");
  await writeFile(join(hiveDir, "SELF.md"), "# self-marker\n");
  await writeFile(join(hiveDir, "AGENTS.md"), "# agents-marker\n");
  await writeFile(join(hiveDir, "TRUST.md"), "# trust-marker\n");

  const projDir = join(hiveDir, "projects", projectId);
  await mkdir(projDir, { recursive: true });
  await writeFile(join(projDir, "config.md"), `---\nname: ${projectId}\npath: ${projectPath}\n---\n`);

  const memDir = join(hiveDir, "memory", "projects", projectId);
  await mkdir(memDir, { recursive: true });
  await writeFile(join(memDir, "_index.md"), "# project-memory-marker\n");

  const tasteDir = join(hiveDir, "taste");
  await mkdir(tasteDir, { recursive: true });
  await writeFile(join(tasteDir, "principles.md"), "# taste-principles-marker\n");

  const personasDir = join(hiveDir, "personas");
  await mkdir(personasDir, { recursive: true });
  await writeFile(join(personasDir, "dry.md"), "# persona-dry-marker\n");
}

async function addProject(projectId: string, projectPath?: string): Promise<string> {
  const projDir = join(tempHive, "projects", projectId);
  await mkdir(projDir, { recursive: true });
  const path = projectPath ?? join(tempCwd, projectId);
  await writeFile(join(projDir, "config.md"), `---\nname: ${projectId}\npath: ${path}\n---\n`);
  return path;
}

beforeEach(async () => {
  // realpath both: on macOS tmpdir() hands back /var/folders/... while
  // process.cwd() reports /private/var/folders/..., so an unresolved fixture
  // path never matches cwd and project resolution silently falls through.
  tempHive = await realpath(await mkdtemp(join(tmpdir(), "hive-context-test-hive-")));
  tempCwd = await realpath(await mkdtemp(join(tmpdir(), "hive-context-test-proj-")));
  originalHiveHome = process.env.HIVE_HOME;
  originalCwd = process.cwd();
  process.env.HIVE_HOME = tempHive;
  await seedHive(tempHive, "testproj", tempCwd);
  process.chdir(tempCwd);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalHiveHome) process.env.HIVE_HOME = originalHiveHome;
  else delete process.env.HIVE_HOME;
  await rm(tempHive, { recursive: true, force: true });
  await rm(tempCwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Component measurement
// ---------------------------------------------------------------------------

describe("buildContextReport — components", () => {
  test("measures every emitted component and resolves the cwd project", async () => {
    const report = await buildContextReport();

    expect(report.projectId).toBe("testproj");
    const labels = report.components.map((c) => c.label);
    expect(labels).toEqual([
      "SOUL.md",
      "IDENTITY.md",
      "persona: dry",
      "SELF.md",
      "AGENTS.md",
      "TRUST.md",
      "_index.md",
      "taste layer",
    ]);
    for (const c of report.components) {
      expect(c.bytes).toBeGreaterThan(0);
      expect(c.tokens).toBe(estimateTokens(c.bytes));
    }
  });

  test("total is the sum of components; soul stack sums only soul files", async () => {
    const report = await buildContextReport();

    const sum = report.components.reduce((s, c) => s + c.bytes, 0);
    expect(report.total.bytes).toBe(sum);

    const soulSum = report.components
      .filter((c) => c.kind === "soul")
      .reduce((s, c) => s + c.bytes, 0);
    expect(report.soulStack.bytes).toBe(soulSum);
    // Persona is a separate register with its own budget, not soul stack.
    expect(report.components.find((c) => c.kind === "persona")).toBeDefined();
  });

  test("small fixture is fully within budget — zero warnings, ok statuses", async () => {
    const report = await buildContextReport();
    expect(report.warnings).toBe(0);
    expect(report.total.status).toBe("ok");
    expect(report.soulStack.status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Budget enforcement
// ---------------------------------------------------------------------------

describe("buildContextReport — budgets", () => {
  test("an _index.md over the 8KB cap warns (TK-133 regression guard)", async () => {
    const big = "x".repeat(INDEX_SIZE_BUDGET_BYTES + 100);
    await writeFile(join(tempHive, "memory", "projects", "testproj", "_index.md"), big);

    const report = await buildContextReport();
    const index = report.components.find((c) => c.label === "_index.md")!;
    expect(index.status).toBe("warn");
    expect(index.budgetBytes).toBe(INDEX_SIZE_BUDGET_BYTES);
    expect(report.warnings).toBeGreaterThan(0);

    const row = report.projects.find((p) => p.projectId === "testproj")!;
    expect(row.memoryStatus).toBe("warn");
  });

  test("knowledge.md fallback (no index) always warns — unbounded load", async () => {
    const memDir = join(tempHive, "memory", "projects", "testproj");
    await rm(join(memDir, "_index.md"));
    await writeFile(join(memDir, "knowledge.md"), "# knowledge-marker\n");

    const report = await buildContextReport();
    const mem = report.components.find((c) => c.kind === "memory")!;
    expect(mem.label).toBe("knowledge.md");
    expect(mem.status).toBe("warn");
    expect(mem.note).toContain("no _index.md");

    const row = report.projects.find((p) => p.projectId === "testproj")!;
    expect(row.memorySource).toBe("knowledge");
    expect(row.memoryStatus).toBe("warn");
  });

  test("an oversized soul stack warns at the rollup, not per file", async () => {
    await writeFile(join(tempHive, "AGENTS.md"), "y".repeat(CONTEXT_BUDGETS.soulStackBytes + 1));

    const report = await buildContextReport();
    expect(report.soulStack.status).toBe("warn");
    const agents = report.components.find((c) => c.label === "AGENTS.md")!;
    expect(agents.status).toBe("ok");
    expect(agents.budgetBytes).toBeNull();
  });

  test("an oversized persona register warns", async () => {
    await writeFile(
      join(tempHive, "personas", "dry.md"),
      "p".repeat(CONTEXT_BUDGETS.personaBytes + 1),
    );
    const report = await buildContextReport();
    const persona = report.components.find((c) => c.kind === "persona")!;
    expect(persona.status).toBe("warn");
  });
});

// ---------------------------------------------------------------------------
// Per-project sweep
// ---------------------------------------------------------------------------

describe("buildContextReport — project sweep", () => {
  test("covers all registered projects and marks the current one", async () => {
    await addProject("otherproj");
    const report = await buildContextReport();

    const ids = report.projects.map((p) => p.projectId).sort();
    expect(ids).toEqual(["otherproj", "testproj"]);
    expect(report.projects.find((p) => p.projectId === "testproj")!.current).toBe(true);
    expect(report.projects.find((p) => p.projectId === "otherproj")!.current).toBe(false);
    expect(report.projects.find((p) => p.projectId === "otherproj")!.memorySource).toBe("none");
  });

  test("measures a registered project's CLAUDE.md against its budget", async () => {
    await writeFile(join(tempCwd, "CLAUDE.md"), "z".repeat(CONTEXT_BUDGETS.claudeMdBytes + 1));

    const report = await buildContextReport();
    const row = report.projects.find((p) => p.projectId === "testproj")!;
    expect(row.claudeMdBytes).toBe(CONTEXT_BUDGETS.claudeMdBytes + 1);
    expect(row.claudeMdStatus).toBe("warn");
    expect(report.warnings).toBeGreaterThan(0);
  });

  test("missing CLAUDE.md is fine — null bytes, ok status", async () => {
    const report = await buildContextReport();
    const row = report.projects.find((p) => p.projectId === "testproj")!;
    expect(row.claudeMdBytes).toBeNull();
    expect(row.claudeMdStatus).toBe("ok");
  });
});
