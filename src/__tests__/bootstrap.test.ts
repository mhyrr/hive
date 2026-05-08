import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  scanRepo,
  scanToCandidates,
  emitBootstrapCandidates,
  formatScanReport,
  selectRepresentativeFiles,
  readStackSkillContent,
  buildInferencePrompt,
  parseInferenceOutput,
  inferenceToCandidates,
  formatInferenceReport,
  type BootstrapScanResult,
  type RepresentativeFile,
  type InferenceResult,
} from "../lib/bootstrap";
import { readCandidates } from "../lib/memory";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";

// ---------------------------------------------------------------------------
// Fixture helpers — create minimal project directories
// ---------------------------------------------------------------------------

async function makeTypescriptProject(root: string): Promise<void> {
  const pkg = {
    name: "my-ts-app",
    main: "src/index.ts",
    scripts: {
      build: "bun build src/cli.ts --outfile dist/cli.js",
      test: "bun test",
      dev: "bun run src/cli.ts",
      lint: "eslint src/",
    },
    dependencies: { zod: "^3.0.0" },
    devDependencies: { "@types/bun": "latest" },
  };

  await writeFile(join(root, "package.json"), JSON.stringify(pkg, null, 2));
  await writeFile(join(root, "bun.lockb"), "fake-lockfile");
  await writeFile(join(root, "tsconfig.json"), "{}");
  await writeFile(join(root, ".eslintrc.json"), "{}");
  await writeFile(join(root, ".prettierrc"), "{}");

  await mkdir(join(root, "src", "__tests__"), { recursive: true });
  await writeFile(join(root, "src", "cli.ts"), "console.log('hi')");
  await writeFile(join(root, "src", "index.ts"), "export {}");
  await writeFile(join(root, "src", "__tests__", "cli.test.ts"), "test('x', () => {})");

  await mkdir(join(root, ".github", "workflows"), { recursive: true });
  await writeFile(join(root, ".github", "workflows", "ci.yml"), "name: CI");
  await writeFile(join(root, "fly.toml"), "[app]");
}

async function makeElixirProject(root: string): Promise<void> {
  const mixExs = `
defmodule MyApp.MixProject do
  use Mix.Project

  def project do
    [
      app: :my_app,
      version: "0.1.0",
      elixir: "~> 1.16",
      deps: deps()
    ]
  end

  defp deps do
    [
      {:phoenix, "~> 1.7"},
      {:ecto_sql, "~> 3.10"},
      {:credo, "~> 1.7", only: [:dev, :test]},
      {:dialyxir, "~> 1.4", only: :dev}
    ]
  end
end
`;

  await writeFile(join(root, "mix.exs"), mixExs);
  await writeFile(join(root, ".formatter.exs"), "[inputs: [\"*.ex\"]]");

  await mkdir(join(root, "lib", "my_app"), { recursive: true });
  await writeFile(
    join(root, "lib", "my_app", "application.ex"),
    "defmodule MyApp.Application do\nend",
  );

  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "test", "my_app_test.exs"), "defmodule MyAppTest do\nend");
}

async function makeGenericProject(root: string): Promise<void> {
  await writeFile(join(root, "Makefile"), "build:\n\techo building\n\ntest:\n\techo testing\n");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.py"), "print('hello')");
  await writeFile(join(root, "Dockerfile"), "FROM python:3.12");
}

async function makeRustProject(root: string): Promise<void> {
  await writeFile(join(root, "Cargo.toml"), '[package]\nname = "my-app"\nversion = "0.1.0"');
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.rs"), "fn main() {}");
  await writeFile(join(root, "src", "lib.rs"), "pub fn lib() {}");
}

async function makePythonProject(root: string): Promise<void> {
  const pyproject = `
[project]
name = "my-app"
version = "0.1.0"

[tool.pytest]
testpaths = ["tests"]

[tool.ruff]
line-length = 88

[tool.mypy]
strict = true
`;
  await writeFile(join(root, "pyproject.toml"), pyproject);
  await writeFile(join(root, "uv.lock"), "fake");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "main.py"), "print('hi')");
  await mkdir(join(root, "tests"), { recursive: true });
  await writeFile(join(root, "tests", "test_main.py"), "def test_main(): pass");
}

// ---------------------------------------------------------------------------
// scanRepo tests
// ---------------------------------------------------------------------------

describe("scanRepo", () => {
  test("scans a TypeScript/Bun project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-ts-"));
    await makeTypescriptProject(root);

    const scan = scanRepo(root);

    expect(scan.stack).toBe("typescript");
    expect(scan.runtime).toBe("bun");
    expect(scan.language).toBe("typescript");
    expect(scan.packageManager).toBe("bun");

    // Entrypoints
    expect(scan.entrypoints).toContain("src/index.ts");
    expect(scan.entrypoints).toContain("src/cli.ts");

    // Scripts
    const scriptNames = scan.scripts.map(s => s.name);
    expect(scriptNames).toContain("build");
    expect(scriptNames).toContain("test");
    expect(scriptNames).toContain("dev");

    // Test config
    expect(scan.testConfig).not.toBeNull();
    expect(scan.testConfig!.framework).toBe("bun:test");
    expect(scan.testConfig!.pattern).toContain("__tests__");

    // Linters
    const linterTools = scan.linters.map(l => l.tool);
    expect(linterTools).toContain("eslint");
    expect(linterTools).toContain("prettier");

    // CI
    expect(scan.ciConfig).not.toBeNull();
    expect(scan.ciConfig!.system).toBe("github-actions");
    expect(scan.ciConfig!.files).toContain(".github/workflows/ci.yml");

    // Deploy
    expect(scan.deploy).toContain("fly.toml");

    // File stats
    expect(scan.fileStats.totalFiles).toBeGreaterThan(0);
    expect(scan.fileStats.byExtension[".ts"]).toBeGreaterThan(0);
  });

  test("scans an Elixir/Phoenix project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-ex-"));
    await makeElixirProject(root);

    const scan = scanRepo(root);

    expect(scan.stack).toBe("elixir");
    expect(scan.runtime).toBe("beam");
    expect(scan.language).toBe("elixir");
    expect(scan.packageManager).toBe("mix");

    // Scripts — Phoenix + Ecto
    const scriptNames = scan.scripts.map(s => s.name);
    expect(scriptNames).toContain("test");
    expect(scriptNames).toContain("server");
    expect(scriptNames).toContain("ecto.migrate");

    // Test config
    expect(scan.testConfig!.framework).toBe("exunit");
    expect(scan.testConfig!.pattern).toBe("test/**/*_test.exs");

    // Linters
    const linterTools = scan.linters.map(l => l.tool);
    expect(linterTools).toContain("mix format");
    expect(linterTools).toContain("credo");
    expect(linterTools).toContain("dialyzer");

    // Entrypoints
    expect(scan.entrypoints).toContain("lib/my_app/application.ex");

    // File stats
    expect(scan.fileStats.byExtension[".ex"] ?? 0).toBeGreaterThan(0);
  });

  test("scans a Rust project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-rs-"));
    await makeRustProject(root);

    const scan = scanRepo(root);

    expect(scan.stack).toBe("rust");
    expect(scan.runtime).toBe("cargo");
    expect(scan.language).toBe("rust");
    expect(scan.packageManager).toBe("cargo");

    expect(scan.entrypoints).toContain("src/main.rs");
    expect(scan.entrypoints).toContain("src/lib.rs");

    expect(scan.testConfig!.framework).toBe("cargo-test");

    const scriptNames = scan.scripts.map(s => s.name);
    expect(scriptNames).toContain("build");
    expect(scriptNames).toContain("test");
    expect(scriptNames).toContain("run");
  });

  test("scans a Python project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-py-"));
    await makePythonProject(root);

    const scan = scanRepo(root);

    expect(scan.stack).toBe("python");
    expect(scan.runtime).toBe("python");
    expect(scan.language).toBe("python");
    expect(scan.packageManager).toBe("uv");

    expect(scan.testConfig!.framework).toBe("pytest");
    expect(scan.testConfig!.pattern).toBe("tests/");

    const linterTools = scan.linters.map(l => l.tool);
    expect(linterTools).toContain("ruff");
    expect(linterTools).toContain("mypy");
  });

  test("scans a generic project with only a Makefile", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-generic-"));
    await makeGenericProject(root);

    const scan = scanRepo(root);

    // No recognized stack (mix.exs, package.json, etc.)
    expect(scan.stack).toBeNull();

    // But Makefile targets are found
    const scriptNames = scan.scripts.map(s => s.name);
    expect(scriptNames).toContain("build");
    expect(scriptNames).toContain("test");

    // Deploy
    expect(scan.deploy).toContain("Dockerfile");
  });

  test("handles empty directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-empty-"));
    const scan = scanRepo(root);

    expect(scan.stack).toBeNull();
    expect(scan.runtime).toBeNull();
    expect(scan.scripts).toEqual([]);
    expect(scan.entrypoints).toEqual([]);
    expect(scan.testConfig).toBeNull();
    expect(scan.linters).toEqual([]);
    expect(scan.ciConfig).toBeNull();
    expect(scan.deploy).toEqual([]);
    expect(scan.fileStats.totalFiles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// scanToCandidates tests
// ---------------------------------------------------------------------------

describe("scanToCandidates", () => {
  test("generates candidates from a full scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-cand-"));
    await makeTypescriptProject(root);

    const scan = scanRepo(root);
    const candidates = scanToCandidates(scan);

    expect(candidates.length).toBeGreaterThan(0);

    // All candidates should be facts with bootstrap tag
    for (const c of candidates) {
      expect(c.type).toBe("fact");
      expect(c.tags).toContain("bootstrap");
    }

    // Check for specific content
    const contents = candidates.map(c => c.content);
    expect(contents.some(c => c.includes("typescript"))).toBe(true);
    expect(contents.some(c => c.includes("bun:test"))).toBe(true);
    expect(contents.some(c => c.includes("github-actions"))).toBe(true);
    expect(contents.some(c => c.includes("eslint"))).toBe(true);
  });

  test("generates no candidates from empty scan", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-empty2-"));
    const scan = scanRepo(root);
    const candidates = scanToCandidates(scan);
    expect(candidates.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// emitBootstrapCandidates tests
// ---------------------------------------------------------------------------

describe("emitBootstrapCandidates", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-boot-emit-"));
    paths = await ensureHiveScaffold(home);
  });

  test("emits candidates for a TypeScript project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-emit-ts-"));
    await makeTypescriptProject(root);

    const scan = scanRepo(root);
    const result = await emitBootstrapCandidates(paths, "test-project", scan);

    expect(result.written).toBeGreaterThan(0);
    expect(result.skipped).toBe(0);

    // Verify candidates are actually in the file
    const stored = await readCandidates(paths, "test-project");
    expect(stored.length).toBe(result.written);
    expect(stored[0]!.provenance).toBe("bootstrap:mechanical-scan");
  });

  test("idempotent — running twice writes nothing new", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-idem-"));
    await makeTypescriptProject(root);

    const scan = scanRepo(root);
    const first = await emitBootstrapCandidates(paths, "test-project", scan);
    expect(first.written).toBeGreaterThan(0);

    const second = await emitBootstrapCandidates(paths, "test-project", scan);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(first.written);

    // Total candidates in file should match first run
    const stored = await readCandidates(paths, "test-project");
    expect(stored.length).toBe(first.written);
  });

  test("skips facts already in knowledge.md", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-know-"));
    await makeTypescriptProject(root);

    const scan = scanRepo(root);
    const candidates = scanToCandidates(scan);

    // Pre-populate knowledge with one of the candidates
    const { appendProjectMemory } = await import("../lib/memory");
    await appendProjectMemory(paths, "test-project", "fact", candidates[0]!.content);

    const result = await emitBootstrapCandidates(paths, "test-project", scan);
    // Should have written all but the one that was already in knowledge
    expect(result.written).toBe(candidates.length - 1);
    expect(result.skipped).toBe(1);
  });

  test("handles project with no scannable content", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-none-"));
    const scan = scanRepo(root);
    const result = await emitBootstrapCandidates(paths, "test-project", scan);

    expect(result.written).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatScanReport tests
// ---------------------------------------------------------------------------

describe("formatScanReport", () => {
  test("produces a readable report for a TS project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-report-"));
    await makeTypescriptProject(root);

    const scan = scanRepo(root);
    const report = formatScanReport(scan);

    expect(report).toContain("Bootstrap Scan Results");
    expect(report).toContain("typescript");
    expect(report).toContain("bun");
    expect(report).toContain("Key Commands");
    expect(report).toContain("eslint");
    expect(report).toContain("github-actions");
    expect(report).toContain("fly.toml");
  });

  test("produces a report for an empty project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-boot-report-empty-"));
    const scan = scanRepo(root);
    const report = formatScanReport(scan);

    expect(report).toContain("Bootstrap Scan Results");
    // Should not crash, just show minimal info
    expect(report).not.toContain("undefined");
  });
});

// ===========================================================================
// Phase 2 — Inference (TK-072)
// ===========================================================================

// ---------------------------------------------------------------------------
// selectRepresentativeFiles tests
// ---------------------------------------------------------------------------

describe("selectRepresentativeFiles", () => {
  test("selects files from a TypeScript project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-infer-ts-"));
    await makeTypescriptProject(root);

    const scan = scanRepo(root);
    const files = selectRepresentativeFiles(root, scan);

    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(files.length).toBeLessThanOrEqual(5);

    const categories = files.map(f => f.category);
    expect(categories).toContain("entrypoint");
    expect(categories).toContain("test");
    expect(categories).toContain("config");

    // Every file should have content
    for (const f of files) {
      expect(f.content.length).toBeGreaterThan(0);
      expect(f.path.length).toBeGreaterThan(0);
    }
  });

  test("selects files from an Elixir project", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-infer-ex-"));
    await makeElixirProject(root);

    const scan = scanRepo(root);
    const files = selectRepresentativeFiles(root, scan);

    expect(files.length).toBeGreaterThanOrEqual(2);

    const categories = files.map(f => f.category);
    expect(categories).toContain("entrypoint");
    expect(categories).toContain("config");

    // The entrypoint should be the application.ex
    const entrypoint = files.find(f => f.category === "entrypoint");
    expect(entrypoint?.path).toContain("application.ex");
  });

  test("handles empty project gracefully", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-infer-empty-"));
    const scan = scanRepo(root);
    const files = selectRepresentativeFiles(root, scan);

    // Should not crash, just return what it can find
    expect(files.length).toBe(0);
  });

  test("truncates large files", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-infer-large-"));
    await mkdir(join(root, "src"), { recursive: true });

    // Create a file larger than MAX_FILE_BYTES (16KB)
    const largeContent = "x".repeat(20_000);
    await writeFile(join(root, "src", "index.ts"), largeContent);
    await writeFile(join(root, "package.json"), '{"name":"test","main":"src/index.ts"}');
    await writeFile(join(root, "bun.lockb"), "fake");
    await writeFile(join(root, "tsconfig.json"), "{}");

    const scan = scanRepo(root);
    const files = selectRepresentativeFiles(root, scan);

    const entrypoint = files.find(f => f.category === "entrypoint");
    expect(entrypoint).toBeDefined();
    expect(entrypoint!.truncated).toBe(true);
    expect(entrypoint!.content).toContain("[truncated]");
    expect(entrypoint!.content.length).toBeLessThan(largeContent.length);
  });

  test("uses stack-specific patterns for Rust", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-infer-rs-"));
    await makeRustProject(root);

    const scan = scanRepo(root);
    const files = selectRepresentativeFiles(root, scan);

    const categories = files.map(f => f.category);
    expect(categories).toContain("entrypoint");
    expect(categories).toContain("config");

    const entrypoint = files.find(f => f.category === "entrypoint");
    expect(entrypoint?.path).toBe("src/main.rs");

    const config = files.find(f => f.category === "config");
    expect(config?.path).toBe("Cargo.toml");
  });
});

// ---------------------------------------------------------------------------
// readStackSkillContent tests
// ---------------------------------------------------------------------------

describe("readStackSkillContent", () => {
  test("returns empty for null stack", () => {
    const content = readStackSkillContent(null);
    expect(content).toBe("");
  });

  test("returns empty for non-existent stack", () => {
    // Set HOME to a temp dir with no skills
    const originalHome = process.env.HOME;
    process.env.HOME = "/tmp/nonexistent-hive-test";
    try {
      const content = readStackSkillContent("rust");
      expect(content).toBe("");
    } finally {
      process.env.HOME = originalHome;
    }
  });

  // Note: Testing actual skill reading requires skills installed at
  // ~/.claude/skills/, which is environment-dependent. The function
  // is integration-tested by the real bootstrap --infer run.
});

// ---------------------------------------------------------------------------
// buildInferencePrompt tests
// ---------------------------------------------------------------------------

describe("buildInferencePrompt", () => {
  test("includes scan results and files in the prompt", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-infer-prompt-"));
    await makeTypescriptProject(root);

    const scan = scanRepo(root);
    const files = selectRepresentativeFiles(root, scan);
    const { systemPrompt, userPrompt } = buildInferencePrompt(scan, files, "");

    // System prompt has the JSON schema
    expect(systemPrompt).toContain("conventions");
    expect(systemPrompt).toContain("architecture_summary");
    expect(systemPrompt).toContain("key_dependencies");
    expect(systemPrompt).toContain("valid JSON");

    // User prompt has scan results
    expect(userPrompt).toContain("Mechanical Scan Results");
    expect(userPrompt).toContain("typescript");

    // User prompt has representative files
    expect(userPrompt).toContain("Representative Files");
    for (const f of files) {
      expect(userPrompt).toContain(f.path);
    }
  });

  test("includes skill content when provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-infer-prompt-skill-"));
    await makeTypescriptProject(root);

    const scan = scanRepo(root);
    const files = selectRepresentativeFiles(root, scan);
    const skillContent = "### Skill: typescript-react\n\nAlways use functional components.";
    const { userPrompt } = buildInferencePrompt(scan, files, skillContent);

    expect(userPrompt).toContain("Stack-Specific Knowledge");
    expect(userPrompt).toContain("typescript-react");
    expect(userPrompt).toContain("functional components");
  });

  test("omits skill section when no skills available", async () => {
    const root = await mkdtemp(join(tmpdir(), "hive-infer-prompt-noskill-"));
    await makeTypescriptProject(root);

    const scan = scanRepo(root);
    const files = selectRepresentativeFiles(root, scan);
    const { userPrompt } = buildInferencePrompt(scan, files, "");

    expect(userPrompt).not.toContain("Stack-Specific Knowledge");
  });
});

// ---------------------------------------------------------------------------
// parseInferenceOutput tests
// ---------------------------------------------------------------------------

describe("parseInferenceOutput", () => {
  test("parses valid JSON output", () => {
    const raw = JSON.stringify({
      conventions: [
        { text: "Controllers delegate to context modules", confidence: "high" },
        { text: "Tests use factory pattern", confidence: "medium" },
      ],
      architecture_summary: "A Phoenix web app that manages deals.",
      key_dependencies: [
        { name: "Phoenix", role: "web framework" },
        { name: "Ecto", role: "ORM" },
      ],
    });

    const result = parseInferenceOutput(raw);

    expect(result.conventions.length).toBe(2);
    expect(result.conventions[0]!.text).toBe("Controllers delegate to context modules");
    expect(result.conventions[0]!.confidence).toBe("high");
    expect(result.architectureSummary).toContain("Phoenix web app");
    expect(result.keyDependencies.length).toBe(2);
    expect(result.keyDependencies[0]!.name).toBe("Phoenix");
  });

  test("strips markdown fences", () => {
    const raw = "```json\n" + JSON.stringify({
      conventions: [{ text: "Uses repository pattern", confidence: "high" }],
      architecture_summary: "A REST API.",
      key_dependencies: [],
    }) + "\n```";

    const result = parseInferenceOutput(raw);
    expect(result.conventions.length).toBe(1);
    expect(result.conventions[0]!.text).toBe("Uses repository pattern");
  });

  test("handles plain ``` fences", () => {
    const raw = "```\n" + JSON.stringify({
      conventions: [],
      architecture_summary: "A CLI tool.",
      key_dependencies: [{ name: "clap", role: "argument parsing" }],
    }) + "\n```";

    const result = parseInferenceOutput(raw);
    expect(result.architectureSummary).toBe("A CLI tool.");
    expect(result.keyDependencies.length).toBe(1);
  });

  test("throws on completely invalid JSON", () => {
    expect(() => parseInferenceOutput("not json at all")).toThrow("Failed to parse");
  });

  test("throws on empty result", () => {
    const raw = JSON.stringify({
      conventions: [],
      architecture_summary: "",
      key_dependencies: [],
    });
    expect(() => parseInferenceOutput(raw)).toThrow("no usable data");
  });

  test("filters out malformed conventions", () => {
    const raw = JSON.stringify({
      conventions: [
        { text: "Valid one", confidence: "high" },
        { text: "", confidence: "high" },     // empty text — skip
        { confidence: "high" },                 // no text — skip
        { text: "Valid two", confidence: "invalid" }, // bad confidence → default to medium
      ],
      architecture_summary: "Something.",
      key_dependencies: [],
    });

    const result = parseInferenceOutput(raw);
    expect(result.conventions.length).toBe(2);
    expect(result.conventions[0]!.text).toBe("Valid one");
    expect(result.conventions[1]!.text).toBe("Valid two");
    expect(result.conventions[1]!.confidence).toBe("medium");
  });

  test("handles missing key_dependencies gracefully", () => {
    const raw = JSON.stringify({
      conventions: [{ text: "Test", confidence: "high" }],
      architecture_summary: "Thing.",
    });
    const result = parseInferenceOutput(raw);
    expect(result.keyDependencies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// inferenceToCandidates tests
// ---------------------------------------------------------------------------

describe("inferenceToCandidates", () => {
  const sampleResult: InferenceResult = {
    conventions: [
      { text: "Controllers stay thin, delegate to contexts", confidence: "high" },
      { text: "Tests use ExMachina factories", confidence: "medium" },
    ],
    architectureSummary: "A Phoenix 1.7 web app with Ecto for persistence.",
    keyDependencies: [
      { name: "Phoenix", role: "web framework" },
      { name: "Ecto", role: "database wrapper" },
    ],
  };

  test("generates convention candidates", () => {
    const candidates = inferenceToCandidates(sampleResult);

    const conventions = candidates.filter(c => c.type === "convention");
    expect(conventions.length).toBe(2);
    expect(conventions[0]!.content).toBe("Controllers stay thin, delegate to contexts");
    expect(conventions[0]!.tags).toContain("bootstrap");
    expect(conventions[0]!.tags).toContain("inference");
    expect(conventions[0]!.tags).toContain("convention");
  });

  test("generates architecture fact", () => {
    const candidates = inferenceToCandidates(sampleResult);

    const archFact = candidates.find(c => c.content.startsWith("Architecture:"));
    expect(archFact).toBeDefined();
    expect(archFact!.type).toBe("fact");
    expect(archFact!.content).toContain("Phoenix 1.7");
  });

  test("generates dependency fact", () => {
    const candidates = inferenceToCandidates(sampleResult);

    const depFact = candidates.find(c => c.content.startsWith("Key dependencies:"));
    expect(depFact).toBeDefined();
    expect(depFact!.type).toBe("fact");
    expect(depFact!.content).toContain("Phoenix (web framework)");
    expect(depFact!.content).toContain("Ecto (database wrapper)");
  });

  test("total candidate count matches expected", () => {
    const candidates = inferenceToCandidates(sampleResult);
    // 2 conventions + 1 architecture + 1 dependencies = 4
    expect(candidates.length).toBe(4);
  });

  test("handles empty result", () => {
    const empty: InferenceResult = {
      conventions: [],
      architectureSummary: "",
      keyDependencies: [],
    };
    const candidates = inferenceToCandidates(empty);
    expect(candidates.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatInferenceReport tests
// ---------------------------------------------------------------------------

describe("formatInferenceReport", () => {
  test("formats a full result", () => {
    const result: InferenceResult = {
      conventions: [
        { text: "Uses repository pattern", confidence: "high" },
        { text: "Tests use mocks", confidence: "medium" },
      ],
      architectureSummary: "A REST API built with Express.",
      keyDependencies: [
        { name: "Express", role: "HTTP framework" },
      ],
    };

    const report = formatInferenceReport(result);

    expect(report).toContain("Inference Results");
    expect(report).toContain("Architecture:");
    expect(report).toContain("REST API");
    expect(report).toContain("[high]");
    expect(report).toContain("[med]");
    expect(report).toContain("repository pattern");
    expect(report).toContain("Express");
    expect(report).toContain("HTTP framework");
  });

  test("includes emit stats when provided", () => {
    const result: InferenceResult = {
      conventions: [{ text: "Test", confidence: "high" }],
      architectureSummary: "Thing.",
      keyDependencies: [],
    };

    const report = formatInferenceReport(result, {
      written: 2,
      skipped: 1,
      candidates: [],
      inference: result,
      durationMs: 3500,
      model: "claude-sonnet-4-5-20250514",
    });

    expect(report).toContain("claude-sonnet-4-5-20250514");
    expect(report).toContain("3500ms");
    expect(report).toContain("Wrote 2 candidate(s)");
    expect(report).toContain("1 skipped");
  });
});
