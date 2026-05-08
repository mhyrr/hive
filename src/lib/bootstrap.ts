/**
 * bootstrap.ts — Mechanical repo scanner for project bootstrap.
 *
 * Scans a repo root and produces structured facts that can be emitted as
 * candidates for the V1 memory pipeline. No LLM calls. Deterministic.
 * Designed to run in <2s on a typical repo.
 *
 * TK-032
 */

import { existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join, relative, extname } from "node:path";

import { autoDetectStack, resolveProjectStack } from "./stack";
import {
  appendCandidates,
  readCandidates,
  readProjectMemorySnapshot,
  type CandidateInput,
} from "./memory";
import { type HivePaths } from "./paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScriptEntry = {
  name: string;
  command: string;
};

export type CIConfig = {
  system: string;       // "github-actions" | "gitlab-ci" | "circleci" | etc.
  files: string[];
};

export type TestConfig = {
  framework: string;    // "bun:test" | "jest" | "vitest" | "exunit" | "pytest" | "cargo-test" | etc.
  pattern: string;      // e.g. "src/__tests__/**/*.test.ts" or "test/**/*_test.exs"
};

export type LintConfig = {
  tool: string;
  configFile: string;
};

export type BootstrapScanResult = {
  stack: string | null;
  runtime: string | null;       // "bun" | "node" | "beam" | "cargo" | "python" | null
  language: string | null;
  packageManager: string | null;
  entrypoints: string[];
  scripts: ScriptEntry[];
  testConfig: TestConfig | null;
  linters: LintConfig[];
  ciConfig: CIConfig | null;
  deploy: string[];             // detected deploy config files
  fileStats: {
    totalFiles: number;
    byExtension: Record<string, number>;
    topDirs: string[];           // top-level directories with source code
  };
};

// ---------------------------------------------------------------------------
// File-counting helpers
// ---------------------------------------------------------------------------

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "_build", "deps", "target", ".elixir_ls",
  "__pycache__", ".pytest_cache", ".mypy_cache", "dist", "build",
  ".next", ".turbo", ".vercel", "coverage", ".cache",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".ex", ".exs", ".erl",
  ".rs",
  ".py", ".pyi",
  ".go",
  ".rb",
  ".java", ".kt", ".scala",
  ".swift",
  ".c", ".cpp", ".h", ".hpp",
]);

function countFiles(
  root: string,
  maxDepth = 6,
): { totalFiles: number; byExtension: Record<string, number>; topDirs: string[] } {
  const byExtension: Record<string, number> = {};
  let totalFiles = 0;
  const topDirCounts: Record<string, number> = {};

  function walk(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(join(dir, entry.name), depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!SOURCE_EXTENSIONS.has(ext)) continue;
        totalFiles++;
        byExtension[ext] = (byExtension[ext] ?? 0) + 1;
        const rel = relative(root, dir);
        const topDir = rel.split("/")[0] || ".";
        topDirCounts[topDir] = (topDirCounts[topDir] ?? 0) + 1;
      }
    }
  }

  walk(root, 0);

  const topDirs = Object.entries(topDirCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([dir]) => dir);

  return { totalFiles, byExtension, topDirs };
}

// ---------------------------------------------------------------------------
// Config file readers
// ---------------------------------------------------------------------------

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function readTextFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript project scanning
// ---------------------------------------------------------------------------

function scanPackageJson(root: string): {
  scripts: ScriptEntry[];
  runtime: string | null;
  packageManager: string | null;
  testFramework: string | null;
  linters: LintConfig[];
  entrypoints: string[];
} {
  const pkg = readJsonFile(join(root, "package.json"));
  if (!pkg) return { scripts: [], runtime: null, packageManager: null, testFramework: null, linters: [], entrypoints: [] };

  // Scripts
  const rawScripts = (pkg.scripts ?? {}) as Record<string, string>;
  const scripts: ScriptEntry[] = Object.entries(rawScripts).map(([name, command]) => ({
    name,
    command: String(command),
  }));

  // Runtime detection
  let runtime: string | null = null;
  const devDeps = (pkg.devDependencies ?? {}) as Record<string, string>;
  const allDeps = { ...(pkg.dependencies ?? {}), ...devDeps } as Record<string, string>;

  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock")) || pkg.trustedDependencies) {
    runtime = "bun";
  } else if (existsSync(join(root, "yarn.lock"))) {
    runtime = "node";
  } else if (existsSync(join(root, "pnpm-lock.yaml"))) {
    runtime = "node";
  } else if (existsSync(join(root, "package-lock.json"))) {
    runtime = "node";
  }

  // Package manager
  let packageManager: string | null = null;
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) {
    packageManager = "bun";
  } else if (existsSync(join(root, "yarn.lock"))) {
    packageManager = "yarn";
  } else if (existsSync(join(root, "pnpm-lock.yaml"))) {
    packageManager = "pnpm";
  } else if (existsSync(join(root, "package-lock.json"))) {
    packageManager = "npm";
  }

  // Test framework
  let testFramework: string | null = null;
  const testScript = rawScripts.test ?? "";
  if (testScript.includes("vitest") || allDeps.vitest) {
    testFramework = "vitest";
  } else if (testScript.includes("jest") || allDeps.jest) {
    testFramework = "jest";
  } else if (testScript.includes("bun test") || runtime === "bun") {
    testFramework = "bun:test";
  } else if (testScript.includes("mocha") || allDeps.mocha) {
    testFramework = "mocha";
  }

  // Linters
  const linters: LintConfig[] = [];
  const eslintConfigs = [
    ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml",
    "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs",
  ];
  for (const cfg of eslintConfigs) {
    if (existsSync(join(root, cfg))) {
      linters.push({ tool: "eslint", configFile: cfg });
      break;
    }
  }
  if (allDeps.prettier || existsSync(join(root, ".prettierrc")) || existsSync(join(root, ".prettierrc.json"))) {
    const configFile = existsSync(join(root, ".prettierrc")) ? ".prettierrc"
      : existsSync(join(root, ".prettierrc.json")) ? ".prettierrc.json"
      : "package.json";
    linters.push({ tool: "prettier", configFile });
  }
  if (allDeps.biome || existsSync(join(root, "biome.json")) || existsSync(join(root, "biome.jsonc"))) {
    const configFile = existsSync(join(root, "biome.json")) ? "biome.json"
      : existsSync(join(root, "biome.jsonc")) ? "biome.jsonc"
      : "package.json";
    linters.push({ tool: "biome", configFile });
  }

  // Entrypoints
  const entrypoints: string[] = [];
  const mainField = pkg.main as string | undefined;
  if (mainField && existsSync(join(root, mainField))) {
    entrypoints.push(mainField);
  }
  const moduleField = pkg.module as string | undefined;
  if (moduleField && existsSync(join(root, moduleField))) {
    entrypoints.push(moduleField);
  }
  // Common entrypoint patterns
  for (const ep of ["src/index.ts", "src/index.js", "src/main.ts", "src/main.js", "src/cli.ts", "src/app.ts", "index.ts", "index.js"]) {
    if (existsSync(join(root, ep)) && !entrypoints.includes(ep)) {
      entrypoints.push(ep);
    }
  }

  return { scripts, runtime, packageManager, testFramework, linters, entrypoints };
}

// ---------------------------------------------------------------------------
// Elixir project scanning
// ---------------------------------------------------------------------------

function scanMixExs(root: string): {
  scripts: ScriptEntry[];
  testFramework: string | null;
  linters: LintConfig[];
  entrypoints: string[];
  version: string | null;
} {
  const content = readTextFile(join(root, "mix.exs"));
  if (!content) return { scripts: [], testFramework: null, linters: [], entrypoints: [], version: null };

  // Extract version
  const versionMatch = content.match(/elixir:\s*"([^"]+)"/);
  const version = versionMatch ? versionMatch[1] : null;

  // Common tasks are always available
  const scripts: ScriptEntry[] = [
    { name: "test", command: "mix test" },
    { name: "compile", command: "mix compile" },
    { name: "deps.get", command: "mix deps.get" },
  ];

  // Detect Phoenix
  const hasPhoenix = content.includes(":phoenix");
  if (hasPhoenix) {
    scripts.push({ name: "server", command: "mix phx.server" });
    scripts.push({ name: "routes", command: "mix phx.routes" });
  }

  // Detect ecto
  const hasEcto = content.includes(":ecto");
  if (hasEcto) {
    scripts.push({ name: "ecto.migrate", command: "mix ecto.migrate" });
    scripts.push({ name: "ecto.setup", command: "mix ecto.setup" });
  }

  // Test framework — ExUnit is built in
  const testFramework = "exunit";

  // Linters
  const linters: LintConfig[] = [];
  if (existsSync(join(root, ".formatter.exs"))) {
    linters.push({ tool: "mix format", configFile: ".formatter.exs" });
  }
  if (content.includes(":credo")) {
    const credoConfig = existsSync(join(root, ".credo.exs")) ? ".credo.exs" : "mix.exs";
    linters.push({ tool: "credo", configFile: credoConfig });
  }
  if (content.includes(":dialyxir")) {
    linters.push({ tool: "dialyzer", configFile: "mix.exs" });
  }

  // Entrypoints
  const entrypoints: string[] = [];
  if (existsSync(join(root, "lib"))) {
    try {
      const libEntries = readdirSync(join(root, "lib"), { withFileTypes: true });
      // Look for application.ex or the main module file
      for (const entry of libEntries) {
        if (entry.isDirectory()) {
          const appEx = join("lib", entry.name, "application.ex");
          if (existsSync(join(root, appEx))) {
            entrypoints.push(appEx);
          }
        }
      }
    } catch { /* skip */ }
  }

  return { scripts, testFramework, linters, entrypoints, version };
}

// ---------------------------------------------------------------------------
// Rust project scanning
// ---------------------------------------------------------------------------

function scanCargoToml(root: string): {
  scripts: ScriptEntry[];
  testFramework: string | null;
  entrypoints: string[];
} {
  const content = readTextFile(join(root, "Cargo.toml"));
  if (!content) return { scripts: [], testFramework: null, entrypoints: [] };

  const scripts: ScriptEntry[] = [
    { name: "build", command: "cargo build" },
    { name: "test", command: "cargo test" },
    { name: "run", command: "cargo run" },
  ];

  const entrypoints: string[] = [];
  if (existsSync(join(root, "src", "main.rs"))) entrypoints.push("src/main.rs");
  if (existsSync(join(root, "src", "lib.rs"))) entrypoints.push("src/lib.rs");

  return { scripts, testFramework: "cargo-test", entrypoints };
}

// ---------------------------------------------------------------------------
// Python project scanning
// ---------------------------------------------------------------------------

function scanPyProject(root: string): {
  scripts: ScriptEntry[];
  testFramework: string | null;
  linters: LintConfig[];
  entrypoints: string[];
  packageManager: string | null;
} {
  const content = readTextFile(join(root, "pyproject.toml"));
  const scripts: ScriptEntry[] = [];
  let testFramework: string | null = null;
  const linters: LintConfig[] = [];
  const entrypoints: string[] = [];
  let packageManager: string | null = null;

  if (content) {
    if (content.includes("pytest")) testFramework = "pytest";
    if (content.includes("[tool.ruff]")) linters.push({ tool: "ruff", configFile: "pyproject.toml" });
    if (content.includes("[tool.black]")) linters.push({ tool: "black", configFile: "pyproject.toml" });
    if (content.includes("[tool.mypy]")) linters.push({ tool: "mypy", configFile: "pyproject.toml" });
    if (content.includes("[tool.poetry]")) packageManager = "poetry";
    if (content.includes("[tool.uv]") || existsSync(join(root, "uv.lock"))) packageManager = "uv";
  }

  // Check for setup.py as entrypoint
  if (existsSync(join(root, "setup.py"))) entrypoints.push("setup.py");
  // Common patterns
  for (const ep of ["src/main.py", "main.py", "app.py", "manage.py"]) {
    if (existsSync(join(root, ep))) entrypoints.push(ep);
  }

  if (!packageManager) {
    if (existsSync(join(root, "Pipfile"))) packageManager = "pipenv";
    else if (existsSync(join(root, "requirements.txt"))) packageManager = "pip";
  }

  return { scripts, testFramework, linters, entrypoints, packageManager };
}

// ---------------------------------------------------------------------------
// Makefile scanning
// ---------------------------------------------------------------------------

function scanMakefile(root: string): ScriptEntry[] {
  const content = readTextFile(join(root, "Makefile"));
  if (!content) return [];

  const targets: ScriptEntry[] = [];
  for (const line of content.split("\n")) {
    // Match makefile targets: "name:" at the start of a line (not variables like FOO = bar)
    const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):\s*/);
    if (match && !line.includes("=")) {
      targets.push({ name: match[1]!, command: `make ${match[1]}` });
    }
  }
  return targets.slice(0, 15); // Cap to avoid noise
}

// ---------------------------------------------------------------------------
// CI detection
// ---------------------------------------------------------------------------

function detectCI(root: string): CIConfig | null {
  // GitHub Actions
  const ghDir = join(root, ".github", "workflows");
  if (existsSync(ghDir)) {
    try {
      const files = readdirSync(ghDir)
        .filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
        .map(f => `.github/workflows/${f}`);
      if (files.length > 0) return { system: "github-actions", files };
    } catch { /* skip */ }
  }

  // GitLab CI
  if (existsSync(join(root, ".gitlab-ci.yml"))) {
    return { system: "gitlab-ci", files: [".gitlab-ci.yml"] };
  }

  // CircleCI
  if (existsSync(join(root, ".circleci", "config.yml"))) {
    return { system: "circleci", files: [".circleci/config.yml"] };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Deploy detection
// ---------------------------------------------------------------------------

function detectDeploy(root: string): string[] {
  const files: string[] = [];
  const checks = [
    "Dockerfile",
    "docker-compose.yml", "docker-compose.yaml",
    "fly.toml",
    "render.yaml",
    "vercel.json",
    "netlify.toml",
    "Procfile",
    "app.yaml",  // Google App Engine
    "serverless.yml",
  ];
  for (const file of checks) {
    if (existsSync(join(root, file))) files.push(file);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Test pattern detection
// ---------------------------------------------------------------------------

function detectTestPattern(root: string, stack: string | null, framework: string | null): TestConfig | null {
  if (!framework) return null;

  let pattern: string;
  switch (stack) {
    case "elixir":
      pattern = "test/**/*_test.exs";
      break;
    case "rust":
      pattern = "src/**/*.rs (inline #[test]) + tests/";
      break;
    case "python":
      if (existsSync(join(root, "tests"))) pattern = "tests/";
      else if (existsSync(join(root, "test"))) pattern = "test/";
      else pattern = "test_*.py / *_test.py";
      break;
    default: {
      // TypeScript/JS: check common patterns
      if (existsSync(join(root, "src", "__tests__"))) {
        pattern = "src/__tests__/**/*.test.{ts,tsx}";
      } else if (existsSync(join(root, "__tests__"))) {
        pattern = "__tests__/**/*.test.{ts,tsx}";
      } else if (existsSync(join(root, "test"))) {
        pattern = "test/**/*.test.{ts,tsx}";
      } else if (existsSync(join(root, "tests"))) {
        pattern = "tests/**/*.test.{ts,tsx}";
      } else {
        pattern = "**/*.test.{ts,tsx,js,jsx}";
      }
      break;
    }
  }

  return { framework, pattern };
}

// ---------------------------------------------------------------------------
// Main scanner
// ---------------------------------------------------------------------------

export function scanRepo(repoPath: string): BootstrapScanResult {
  const stack = autoDetectStack(repoPath);

  let runtime: string | null = null;
  let language: string | null = null;
  let packageManager: string | null = null;
  let scripts: ScriptEntry[] = [];
  let testFramework: string | null = null;
  let linters: LintConfig[] = [];
  let entrypoints: string[] = [];

  // Stack-specific scanning
  switch (stack) {
    case "typescript": {
      const ts = scanPackageJson(repoPath);
      runtime = ts.runtime;
      language = "typescript";
      packageManager = ts.packageManager;
      scripts = ts.scripts;
      testFramework = ts.testFramework;
      linters = ts.linters;
      entrypoints = ts.entrypoints;
      break;
    }
    case "elixir": {
      const ex = scanMixExs(repoPath);
      runtime = "beam";
      language = "elixir";
      packageManager = "mix";
      scripts = ex.scripts;
      testFramework = ex.testFramework;
      linters = ex.linters;
      entrypoints = ex.entrypoints;
      break;
    }
    case "rust": {
      const rs = scanCargoToml(repoPath);
      runtime = "cargo";
      language = "rust";
      packageManager = "cargo";
      scripts = rs.scripts;
      testFramework = rs.testFramework;
      entrypoints = rs.entrypoints;
      break;
    }
    case "python": {
      const py = scanPyProject(repoPath);
      runtime = "python";
      language = "python";
      packageManager = py.packageManager;
      scripts = py.scripts;
      testFramework = py.testFramework;
      linters = py.linters;
      entrypoints = py.entrypoints;
      break;
    }
    default: {
      // Try package.json even if stack detection didn't match "typescript"
      // (e.g. JS-only project)
      const fallback = scanPackageJson(repoPath);
      if (fallback.scripts.length > 0) {
        runtime = fallback.runtime;
        language = "javascript";
        packageManager = fallback.packageManager;
        scripts = fallback.scripts;
        testFramework = fallback.testFramework;
        linters = fallback.linters;
        entrypoints = fallback.entrypoints;
      }
      break;
    }
  }

  // Makefile scripts (supplement, don't replace)
  const makeTargets = scanMakefile(repoPath);
  if (makeTargets.length > 0 && scripts.length === 0) {
    scripts = makeTargets;
  }

  // CI
  const ciConfig = detectCI(repoPath);

  // Deploy
  const deploy = detectDeploy(repoPath);

  // File stats
  const fileStats = countFiles(repoPath);

  // Test config
  const testConfig = detectTestPattern(repoPath, stack, testFramework);

  return {
    stack,
    runtime,
    language,
    packageManager,
    entrypoints,
    scripts,
    testConfig,
    linters,
    ciConfig,
    deploy,
    fileStats,
  };
}

// ---------------------------------------------------------------------------
// Candidate generation — turns scan results into CandidateInput[]
// ---------------------------------------------------------------------------

export function scanToCandidates(scan: BootstrapScanResult): CandidateInput[] {
  const candidates: CandidateInput[] = [];
  const tags = ["bootstrap"];

  // Stack + runtime + language
  if (scan.stack || scan.language) {
    const parts: string[] = [];
    if (scan.language) parts.push(`Language: ${scan.language}`);
    if (scan.stack) parts.push(`stack: ${scan.stack}`);
    if (scan.runtime) parts.push(`runtime: ${scan.runtime}`);
    if (scan.packageManager) parts.push(`package manager: ${scan.packageManager}`);

    candidates.push({
      type: "fact",
      content: `Project ${parts.join(", ")}.`,
      tags: [...tags, "stack"],
    });
  }

  // Build / run / test commands
  const keyScripts = scan.scripts.filter(s =>
    ["build", "test", "start", "dev", "serve", "server", "compile", "lint", "format", "typecheck", "check"].includes(s.name)
  );
  if (keyScripts.length > 0) {
    const scriptLines = keyScripts.map(s => `\`${s.name}\`: \`${s.command}\``).join("; ");
    candidates.push({
      type: "fact",
      content: `Key project commands: ${scriptLines}.`,
      tags: [...tags, "commands"],
    });
  }

  // Entrypoints
  if (scan.entrypoints.length > 0) {
    candidates.push({
      type: "fact",
      content: `Entrypoint files: ${scan.entrypoints.join(", ")}.`,
      tags: [...tags, "architecture"],
    });
  }

  // Test config
  if (scan.testConfig) {
    candidates.push({
      type: "fact",
      content: `Test framework: ${scan.testConfig.framework}. Test file pattern: ${scan.testConfig.pattern}.`,
      tags: [...tags, "testing"],
    });
  }

  // Linters / formatters
  if (scan.linters.length > 0) {
    const lintDesc = scan.linters.map(l => `${l.tool} (${l.configFile})`).join(", ");
    candidates.push({
      type: "fact",
      content: `Linting/formatting: ${lintDesc}.`,
      tags: [...tags, "tooling"],
    });
  }

  // CI
  if (scan.ciConfig) {
    candidates.push({
      type: "fact",
      content: `CI system: ${scan.ciConfig.system}. Workflow files: ${scan.ciConfig.files.join(", ")}.`,
      tags: [...tags, "ci"],
    });
  }

  // Deploy
  if (scan.deploy.length > 0) {
    candidates.push({
      type: "fact",
      content: `Deploy configuration detected: ${scan.deploy.join(", ")}.`,
      tags: [...tags, "deploy"],
    });
  }

  // File stats summary
  if (scan.fileStats.totalFiles > 0) {
    const extSummary = Object.entries(scan.fileStats.byExtension)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext, count]) => `${ext}: ${count}`)
      .join(", ");
    const dirList = scan.fileStats.topDirs.join(", ");
    candidates.push({
      type: "fact",
      content: `Codebase: ${scan.fileStats.totalFiles} source files (${extSummary}). Top directories: ${dirList}.`,
      tags: [...tags, "architecture"],
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Emit candidates — with idempotency
// ---------------------------------------------------------------------------

export type BootstrapEmitResult = {
  written: number;
  skipped: number;
  candidates: CandidateInput[];
};

/**
 * Emit bootstrap scan results as candidates, deduplicating against existing
 * candidates and knowledge entries.
 */
export async function emitBootstrapCandidates(
  paths: HivePaths,
  projectId: string,
  scan: BootstrapScanResult,
): Promise<BootstrapEmitResult> {
  const candidates = scanToCandidates(scan);
  if (candidates.length === 0) {
    return { written: 0, skipped: 0, candidates: [] };
  }

  // Read existing candidates and knowledge for dedup
  const existingCandidates = await readCandidates(paths, projectId);
  const existingCandidateTexts = new Set(existingCandidates.map(c => c.content));

  let snapshot;
  try {
    snapshot = await readProjectMemorySnapshot(paths, projectId);
  } catch {
    snapshot = null;
  }

  const existingKnowledgeTexts = new Set<string>();
  if (snapshot) {
    for (const f of snapshot.facts) existingKnowledgeTexts.add(f.text);
    for (const c of snapshot.conventions) existingKnowledgeTexts.add(c.text);
  }

  // Filter out duplicates
  const newCandidates = candidates.filter(c => {
    // Exact match against existing candidates
    if (existingCandidateTexts.has(c.content)) return false;
    // Exact match against knowledge
    if (existingKnowledgeTexts.has(c.content)) return false;
    return true;
  });

  if (newCandidates.length === 0) {
    return { written: 0, skipped: candidates.length, candidates: [] };
  }

  await appendCandidates(paths, projectId, newCandidates, {
    provenanceOverride: "bootstrap:mechanical-scan",
  });

  return {
    written: newCandidates.length,
    skipped: candidates.length - newCandidates.length,
    candidates: newCandidates,
  };
}

// ---------------------------------------------------------------------------
// Format scan results for human-readable output
// ---------------------------------------------------------------------------

export function formatScanReport(scan: BootstrapScanResult): string {
  const lines: string[] = ["## Bootstrap Scan Results", ""];

  if (scan.stack) {
    lines.push(`**Stack:** ${scan.stack}`);
  }
  if (scan.language) {
    lines.push(`**Language:** ${scan.language}`);
  }
  if (scan.runtime) {
    lines.push(`**Runtime:** ${scan.runtime}`);
  }
  if (scan.packageManager) {
    lines.push(`**Package Manager:** ${scan.packageManager}`);
  }
  lines.push("");

  if (scan.entrypoints.length > 0) {
    lines.push(`**Entrypoints:** ${scan.entrypoints.join(", ")}`);
  }

  if (scan.scripts.length > 0) {
    const keyScripts = scan.scripts.filter(s =>
      ["build", "test", "start", "dev", "serve", "server", "compile", "lint", "format"].includes(s.name)
    );
    if (keyScripts.length > 0) {
      lines.push("**Key Commands:**");
      for (const s of keyScripts) {
        lines.push(`  - \`${s.name}\`: \`${s.command}\``);
      }
    }
  }

  if (scan.testConfig) {
    lines.push(`**Tests:** ${scan.testConfig.framework} (${scan.testConfig.pattern})`);
  }

  if (scan.linters.length > 0) {
    lines.push(`**Linters:** ${scan.linters.map(l => `${l.tool} (${l.configFile})`).join(", ")}`);
  }

  if (scan.ciConfig) {
    lines.push(`**CI:** ${scan.ciConfig.system} (${scan.ciConfig.files.join(", ")})`);
  }

  if (scan.deploy.length > 0) {
    lines.push(`**Deploy:** ${scan.deploy.join(", ")}`);
  }

  if (scan.fileStats.totalFiles > 0) {
    const extSummary = Object.entries(scan.fileStats.byExtension)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext, count]) => `${ext}(${count})`)
      .join(", ");
    lines.push(`**Files:** ${scan.fileStats.totalFiles} source files — ${extSummary}`);
    lines.push(`**Directories:** ${scan.fileStats.topDirs.join(", ")}`);
  }

  return lines.join("\n");
}
