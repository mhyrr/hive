import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { collectIdentityComponents, type IdentityComponent } from "./identity";
import { INDEX_SIZE_BUDGET_BYTES } from "./memory";
import { getHivePaths, listProjects } from "./paths";
import { extractRepoPath, resolveProjectFromCwd } from "./project";
import type { Harness } from "./stack";

/**
 * Session-context size budgets for `hive context`.
 *
 * Calibrated against the 2026-07-23 slim-down (TK-133/TK-134), the last time
 * the injection was measured end to end:
 *   - soul stack (SOUL/IDENTITY/SELF/AGENTS/TRUST) measured ~20KB live
 *   - _index.md regenerated at 4.2–6.9KB per project against the 8KB cap
 *   - taste principles.md targets ~500 tokens (~2KB)
 *   - pre-slim-down, the full emit ran ~63KB — the failure mode these
 *     budgets exist to catch early
 *
 * Budgets are warn thresholds, not hard caps: headroom above the measured
 * baseline so normal growth doesn't nag, tight enough that drift back toward
 * pre-slim sizes surfaces before it costs a quarter of every session.
 */
export const CONTEXT_BUDGETS = {
  /** Soul stack total (all IDENTITY_FILES + persona excluded). Live baseline ~20KB. */
  soulStackBytes: 24 * 1024,
  /** Swappable persona register — a voice, not a knowledge dump. */
  personaBytes: 4 * 1024,
  /** Per-project memory index. Canonical cap lives in memory.ts (TK-133). */
  memoryIndexBytes: INDEX_SIZE_BUDGET_BYTES,
  /** Taste layer (principles.md) — targets ~500 tokens. */
  tasteBytes: 4 * 1024,
  /** A registered project's CLAUDE.md, which Claude Code loads alongside identity. */
  claudeMdBytes: 16 * 1024,
  /** Whole interactive emit. Pre-slim was ~63KB; post-slim baseline ~30KB. */
  totalBytes: 40 * 1024,
} as const;

/**
 * Markdown-prose token estimate, same convention as the _index.md generator
 * (~4 chars/token; memory.ts). JSON-heavy content runs denser (~3.3, see
 * verify.ts) but the injection is prose, so /4 is the honest estimate.
 */
export function estimateTokens(bytes: number): number {
  return Math.round(bytes / 4);
}

export type SizeStatus = "ok" | "warn";

export interface ComponentRow {
  kind: IdentityComponent["kind"];
  label: string;
  path: string | null;
  bytes: number;
  tokens: number;
  /** Budget the row is judged against, when one applies to it individually. */
  budgetBytes: number | null;
  status: SizeStatus;
  note?: string;
}

export interface RollupRow {
  bytes: number;
  tokens: number;
  budgetBytes: number;
  status: SizeStatus;
}

export interface ProjectRow {
  projectId: string;
  /** True when this is the project the identity section was resolved for. */
  current: boolean;
  /** What a session in this project would load as memory. */
  memorySource: "index" | "knowledge" | "none";
  memoryBytes: number | null;
  memoryStatus: SizeStatus;
  memoryNote?: string;
  claudeMdBytes: number | null;
  claudeMdStatus: SizeStatus;
}

export interface ContextReport {
  projectId: string | null;
  components: ComponentRow[];
  soulStack: RollupRow;
  total: RollupRow;
  projects: ProjectRow[];
  warnings: number;
}

function statusFor(bytes: number, budget: number): SizeStatus {
  return bytes > budget ? "warn" : "ok";
}

function componentRow(c: IdentityComponent): ComponentRow {
  const bytes = Buffer.byteLength(c.content, "utf-8");
  const base = { kind: c.kind, label: c.label, path: c.path, bytes, tokens: estimateTokens(bytes) };

  switch (c.kind) {
    case "persona":
      return { ...base, budgetBytes: CONTEXT_BUDGETS.personaBytes, status: statusFor(bytes, CONTEXT_BUDGETS.personaBytes) };
    case "memory": {
      const overBudget = statusFor(bytes, CONTEXT_BUDGETS.memoryIndexBytes);
      if (c.label === "knowledge.md") {
        return {
          ...base,
          budgetBytes: CONTEXT_BUDGETS.memoryIndexBytes,
          status: "warn",
          note: "no _index.md — full knowledge.md loads unbounded; the nightly run rebuilds the index",
        };
      }
      return { ...base, budgetBytes: CONTEXT_BUDGETS.memoryIndexBytes, status: overBudget };
    }
    case "taste":
      return { ...base, budgetBytes: CONTEXT_BUDGETS.tasteBytes, status: statusFor(bytes, CONTEXT_BUDGETS.tasteBytes) };
    default: // soul files judged as a stack, stack hint is a line or two
      return { ...base, budgetBytes: null, status: "ok" };
  }
}

function projectRow(projectId: string, currentProjectId: string | null): ProjectRow {
  const paths = getHivePaths();
  const memDir = join(paths.memoryProjectsDir, projectId);
  const indexPath = join(memDir, "_index.md");
  const knowledgePath = join(memDir, "knowledge.md");

  let memorySource: ProjectRow["memorySource"] = "none";
  let memoryBytes: number | null = null;
  let memoryStatus: SizeStatus = "ok";
  let memoryNote: string | undefined;

  if (existsSync(indexPath)) {
    memorySource = "index";
    memoryBytes = statSync(indexPath).size;
    memoryStatus = statusFor(memoryBytes, CONTEXT_BUDGETS.memoryIndexBytes);
    if (memoryStatus === "warn") {
      memoryNote = "rebuilt nightly — persistent overage means caps need tightening or memory needs pruning";
    }
  } else if (existsSync(knowledgePath)) {
    memorySource = "knowledge";
    memoryBytes = statSync(knowledgePath).size;
    memoryStatus = "warn";
    memoryNote = "no _index.md — sessions load full knowledge.md; the nightly run rebuilds the index";
  }

  // CLAUDE.md at the registered repo path — Claude Code loads it on top of
  // the identity injection, so it's part of the same per-session window.
  let claudeMdBytes: number | null = null;
  let claudeMdStatus: SizeStatus = "ok";
  const configPath = join(paths.projectsDir, projectId, "config.md");
  if (existsSync(configPath)) {
    const repoPath = extractRepoPath(readFileSync(configPath, "utf-8"));
    if (repoPath) {
      const claudeMdPath = join(repoPath, "CLAUDE.md");
      if (existsSync(claudeMdPath)) {
        claudeMdBytes = statSync(claudeMdPath).size;
        claudeMdStatus = statusFor(claudeMdBytes, CONTEXT_BUDGETS.claudeMdBytes);
      }
    }
  }

  return {
    projectId,
    current: projectId === currentProjectId,
    memorySource,
    memoryBytes,
    memoryStatus,
    memoryNote,
    claudeMdBytes,
    claudeMdStatus,
  };
}

/**
 * Measure the context HIVE injects at session start.
 *
 * The component list comes from collectIdentityComponents — the same code
 * path `hive identity emit` renders — so the audit cannot drift from the
 * real injection. Measured as the interactive default (persona included),
 * which is the largest emit variant.
 */
export async function buildContextReport(opts?: {
  harness?: Harness;
  persona?: string | null;
}): Promise<ContextReport> {
  const paths = getHivePaths();
  const projectId = resolveProjectFromCwd();

  const components = (
    await collectIdentityComponents({
      projectId,
      includeProjectMemory: true,
      includePersona: true,
      harness: opts?.harness,
      persona: opts?.persona,
    })
  ).map(componentRow);

  const soulBytes = components.filter((c) => c.kind === "soul").reduce((sum, c) => sum + c.bytes, 0);
  const soulStack: RollupRow = {
    bytes: soulBytes,
    tokens: estimateTokens(soulBytes),
    budgetBytes: CONTEXT_BUDGETS.soulStackBytes,
    status: statusFor(soulBytes, CONTEXT_BUDGETS.soulStackBytes),
  };

  const totalBytes = components.reduce((sum, c) => sum + c.bytes, 0);
  const total: RollupRow = {
    bytes: totalBytes,
    tokens: estimateTokens(totalBytes),
    budgetBytes: CONTEXT_BUDGETS.totalBytes,
    status: statusFor(totalBytes, CONTEXT_BUDGETS.totalBytes),
  };

  const projects = (await listProjects(paths.projectsDir)).map((p) => projectRow(p, projectId));

  const warnings =
    components.filter((c) => c.status === "warn").length +
    (soulStack.status === "warn" ? 1 : 0) +
    (total.status === "warn" ? 1 : 0) +
    projects.filter((p) => p.memoryStatus === "warn").length +
    projects.filter((p) => p.claudeMdStatus === "warn").length;

  return { projectId, components, soulStack, total, projects, warnings };
}
