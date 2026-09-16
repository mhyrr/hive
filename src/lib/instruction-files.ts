// Instruction-file audit (TK-153, rules 1/2/3/5/6).
//
// A repo's root CLAUDE.md / AGENTS.md is the most expensive text in the
// project: every session pays for it, and Codex pays for it twice over — it
// loads ~/.codex/AGENTS.md plus the repo's AGENTS.md plus any nested
// AGENTS.md under a single `project_doc_max_bytes` ceiling, then truncates the
// overflow mid-file with no notice.
//
// This module is pure measurement: it walks a project and returns findings.
// `hive doctor` does the printing.

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

/** Rule 1: a root instruction file stays under 8 KB ... */
export const ROOT_BUDGET_BYTES = 8192;
/** ... and under 200 lines (Anthropic's documented target). */
export const ROOT_BUDGET_LINES = 200;
/** Rule 5: nested per-directory files stay small — they share the Codex budget. */
export const NESTED_BUDGET_BYTES = 4096;

/** The phx.new generated block: byte-identical to deps/phoenix/usage-rules/*.md. */
export const USAGE_RULES_MARKER = "<!-- usage-rules-start -->";

const MAX_WALK_DEPTH = 6;
// templates/ holds files emitted elsewhere (HIVE identity, stack starters), not doctrine for this repo.
const SKIP_DIRS = new Set(["node_modules", "deps", "_build", ".git", "dist", ".elixir_ls", "templates"]);
const SKIP_REL_DIRS = new Set([join("priv", "static")]);
const INSTRUCTION_FILENAMES = new Set(["CLAUDE.md", "AGENTS.md"]);

export type InstructionSeverity = "pass" | "warn";

export interface InstructionFinding {
  severity: InstructionSeverity;
  code: string;
  label: string;
  detail?: string;
}

export interface InstructionAuditOptions {
  /** Size of ~/.codex/AGENTS.md, or null when it doesn't exist. */
  codexGlobalBytes: number | null;
  /** Effective `project_doc_max_bytes` (Codex defaults to 32768 when unset). */
  codexMaxBytes: number;
}

/** "7.4 KB", "64 KB" — KB with one decimal, 1024 to the KB, trailing .0 dropped. */
export function formatBytes(bytes: number): string {
  return `${formatKb(bytes)} KB`;
}

/** The bare number half of formatBytes, for summing terms: "22.6+7.4 KB". */
export function formatKb(bytes: number): string {
  const rendered = (bytes / 1024).toFixed(1);
  return rendered.endsWith(".0") ? rendered.slice(0, -2) : rendered;
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.replace(/\n$/, "").split("\n").length;
}

interface RootFile {
  name: string;
  path: string;
  bytes: number;
  lines: number;
  /** True when the path is itself a symlink (the bytes live in the target). */
  symlink: boolean;
  content: string;
}

function readRootFile(projectPath: string, name: string): RootFile | null {
  const path = join(projectPath, name);
  if (!existsSync(path)) return null;
  try {
    return {
      name,
      path,
      bytes: statSync(path).size,
      lines: countLines(readFileSync(path, "utf-8")),
      symlink: lstatSync(path).isSymbolicLink(),
      content: readFileSync(path, "utf-8"),
    };
  } catch {
    // intentional: unreadable root file — treat as absent rather than throwing
    return null;
  }
}

/**
 * True when CLAUDE.md is essentially just `@AGENTS.md` — the Claude-side import
 * that keeps one source of truth without a symlink. Headings and comments
 * around the import line are allowed; real prose is not.
 */
export function isAgentsImport(content: string): boolean {
  const lines = content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return false;
  const hasImport = lines.some((line) => line === "@AGENTS.md" || line === "@./AGENTS.md");
  if (!hasImport) return false;
  return lines.every(
    (line) =>
      line === "@AGENTS.md" ||
      line === "@./AGENTS.md" ||
      line.startsWith("#") ||
      line.startsWith("<!--") ||
      line.startsWith(">"),
  );
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    // intentional: broken symlink — not the same file
    return false;
  }
}

export interface NestedInstructionFile {
  /** Path relative to the project root. */
  rel: string;
  name: string;
  bytes: number;
}

/**
 * Bounded, symlink-free walk for instruction files below the repo root.
 * `.claude/rules/*.md` is picked up separately: it lives under a hidden
 * directory the walk skips, and it is the Claude-only nested mechanism
 * (Codex ignores it) so it still counts against a reader's budget.
 */
export function findNestedInstructionFiles(projectPath: string): NestedInstructionFile[] {
  const found: NestedInstructionFile[] = [];

  const visit = (dir: string, depth: number): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // intentional: unreadable directory — skip it
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // never follow symlinks
      if (entry.isDirectory()) {
        if (depth >= MAX_WALK_DEPTH) continue;
        if (entry.name.startsWith(".")) continue;
        if (SKIP_DIRS.has(entry.name)) continue;
        const rel = relative(projectPath, full);
        if (SKIP_REL_DIRS.has(rel) || [...SKIP_REL_DIRS].some((s) => rel.endsWith(sep + s))) continue;
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (depth === 0) continue; // root files are audited separately
      if (!INSTRUCTION_FILENAMES.has(entry.name)) continue;
      try {
        found.push({ rel: relative(projectPath, full), name: entry.name, bytes: statSync(full).size });
      } catch {
        // intentional: file vanished mid-walk
      }
    }
  };

  visit(projectPath, 0);

  const rulesDir = join(projectPath, ".claude", "rules");
  if (existsSync(rulesDir)) {
    try {
      for (const entry of readdirSync(rulesDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        found.push({
          rel: join(".claude", "rules", entry.name),
          name: entry.name,
          bytes: statSync(join(rulesDir, entry.name)).size,
        });
      }
    } catch {
      // intentional: unreadable .claude/rules — skip
    }
  }

  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * Audit one project's instruction files against the TK-153 doctrine.
 * Pure: reads the filesystem, returns findings, prints nothing.
 */
export function auditProjectInstructionFiles(
  projectPath: string,
  opts: InstructionAuditOptions,
): InstructionFinding[] {
  const findings: InstructionFinding[] = [];

  const claude = readRootFile(projectPath, "CLAUDE.md");
  const agents = readRootFile(projectPath, "AGENTS.md");
  const nested = findNestedInstructionFiles(projectPath);

  // Rule 1 — root files under 8 KB and 200 lines. A pair that resolves to one
  // file is measured once (as the non-symlink side); any other root file,
  // symlink or not, loads on its own and is measured on its own.
  const pairIsSameFile = claude !== null && agents !== null && sameFile(claude.path, agents.path);
  const regularRoots = pairIsSameFile
    ? [claude!.symlink ? agents! : claude!]
    : [claude, agents].filter((f): f is RootFile => f !== null);
  for (const file of regularRoots) {
    const prefix = regularRoots.length > 1 ? file.name : "root";
    const size = `${formatBytes(file.bytes)} / ${file.lines} lines`;
    if (file.bytes > ROOT_BUDGET_BYTES || file.lines > ROOT_BUDGET_LINES) {
      findings.push({
        severity: "warn",
        code: "root-size",
        label: `${file.name} ${size} over budget (${formatBytes(ROOT_BUDGET_BYTES)} / ${ROOT_BUDGET_LINES} lines)`,
        detail:
          `${file.path} — keep only what the model would get wrong without it; framework guidance belongs in skills, incidents in HIVE memory.`,
      });
    } else {
      findings.push({ severity: "pass", code: "root-size", label: `${prefix} ${size}` });
    }
  }

  // Rule: one source of truth when both names are present.
  if (claude && agents) {
    if (pairIsSameFile) {
      findings.push({
        severity: "pass",
        code: "root-pair",
        label: `CLAUDE.md and AGENTS.md are the same file`,
      });
    } else if (isAgentsImport(claude.content)) {
      findings.push({
        severity: "pass",
        code: "root-pair",
        label: `CLAUDE.md imports @AGENTS.md`,
      });
    } else {
      findings.push({
        severity: "warn",
        code: "root-pair",
        label: `CLAUDE.md (${formatBytes(claude.bytes)}) and AGENTS.md (${formatBytes(agents.bytes)}) are separate files — they drift`,
        detail: "Fix with a symlink or @AGENTS.md-import so one file is the source of truth.",
      });
    }
  }

  // Rule 3 — framework canon lives in skills, not the root file.
  for (const file of regularRoots) {
    if (file.content.includes(USAGE_RULES_MARKER)) {
      findings.push({
        severity: "warn",
        code: "usage-rules",
        label: `${file.name} carries the generated ${USAGE_RULES_MARKER} block`,
        detail:
          "Framework guidance belongs in the matching skill (rule 3) — the block is byte-identical to deps/<framework>/usage-rules/*.md.",
      });
    }
  }

  // Rule 5 — nested files stay small.
  for (const file of nested) {
    if (file.bytes > NESTED_BUDGET_BYTES) {
      findings.push({
        severity: "warn",
        code: "nested-size",
        label: `${file.rel} ${formatBytes(file.bytes)} over the ${formatBytes(NESTED_BUDGET_BYTES)} nested budget`,
        detail: "Keep only directory-specific doctrine here; the rest goes to HIVE memory or a skill.",
      });
    }
  }

  if (!claude && !agents) {
    findings.push({ severity: "pass", code: "root-none", label: "no root instruction file" });
    return findings;
  }

  // Codex arithmetic: global identity + repo root + largest nested AGENTS.md,
  // all against one project_doc_max_bytes ceiling.
  if (!agents) {
    findings.push({
      severity: "pass",
      code: "codex-claude-only",
      label: "CLAUDE.md only — Codex reads AGENTS.md, so nothing from this repo loads",
    });
    return findings;
  }

  const largestNestedAgents = nested
    .filter((f) => f.name === "AGENTS.md")
    .sort((a, b) => b.bytes - a.bytes)[0];

  const terms: number[] = [];
  if (opts.codexGlobalBytes !== null) terms.push(opts.codexGlobalBytes);
  terms.push(agents.bytes);
  if (largestNestedAgents) terms.push(largestNestedAgents.bytes);

  const total = terms.reduce((sum, n) => sum + n, 0);
  const sum = terms.map(formatKb).join("+");
  const ceiling = formatBytes(opts.codexMaxBytes);

  if (total > opts.codexMaxBytes) {
    findings.push({
      severity: "warn",
      code: "codex-budget",
      label: `codex ${sum} KB over project_doc_max_bytes ${ceiling}`,
      detail: `Codex truncates the overflow mid-file with no notice. Raise project_doc_max_bytes (hive init) or shrink the files.`,
    });
  } else {
    findings.push({ severity: "pass", code: "codex-budget", label: `codex ${sum} KB of ${ceiling}` });
  }

  return findings;
}
