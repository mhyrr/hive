import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { realpathSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  auditProjectInstructionFiles,
  formatBytes,
  isAgentsImport,
  NESTED_BUDGET_BYTES,
  ROOT_BUDGET_BYTES,
  ROOT_BUDGET_LINES,
  USAGE_RULES_MARKER,
  type InstructionFinding,
} from "../lib/instruction-files";

let repo: string;

const BUDGET = { codexGlobalBytes: 22_600, codexMaxBytes: 65_536 };

function audit(opts: Partial<typeof BUDGET> = {}): InstructionFinding[] {
  return auditProjectInstructionFiles(repo, { ...BUDGET, ...opts });
}

function byCode(findings: InstructionFinding[], code: string): InstructionFinding[] {
  return findings.filter((f) => f.code === code);
}

/** `size` bytes of markdown across `lines` lines. */
function filler(size: number): string {
  return "x".repeat(size - 1) + "\n";
}

beforeEach(async () => {
  // realpath: macOS mkdtemp hands back /var/... which is a symlink to /private/var
  repo = realpathSync(await mkdtemp(join(tmpdir(), "hive-instruction-files-")));
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("root budget", () => {
  test("an under-budget root file passes with its size in the label", async () => {
    await writeFile(join(repo, "AGENTS.md"), "# Facts\n\nOne line of truth.\n");
    const findings = audit();
    const root = byCode(findings, "root-size");
    expect(root).toHaveLength(1);
    expect(root[0]!.severity).toBe("pass");
    expect(root[0]!.label).toMatch(/^root 0 KB \/ 3 lines$/);
  });

  test("an oversize root file warns with the byte count", async () => {
    await writeFile(join(repo, "AGENTS.md"), filler(9000));
    const root = byCode(audit(), "root-size");
    expect(root).toHaveLength(1);
    expect(root[0]!.severity).toBe("warn");
    expect(root[0]!.label).toContain("AGENTS.md");
    expect(root[0]!.label).toContain(formatBytes(9000)); // 8.8 KB
    expect(root[0]!.label).toContain(`over budget (${formatBytes(ROOT_BUDGET_BYTES)} / ${ROOT_BUDGET_LINES} lines)`);
  });

  test("a line-count overflow warns even when the file is small in bytes", async () => {
    const content = "x\n".repeat(ROOT_BUDGET_LINES + 50);
    await writeFile(join(repo, "AGENTS.md"), content);
    const root = byCode(audit(), "root-size");
    expect(root[0]!.severity).toBe("warn");
    expect(root[0]!.label).toContain(`${ROOT_BUDGET_LINES + 50} lines`);
    expect(content.length).toBeLessThan(ROOT_BUDGET_BYTES);
  });

  test("CLAUDE.md is measured too when it is the only root file", async () => {
    await writeFile(join(repo, "CLAUDE.md"), filler(9000));
    const root = byCode(audit(), "root-size");
    expect(root).toHaveLength(1);
    expect(root[0]!.severity).toBe("warn");
    expect(root[0]!.label).toContain("CLAUDE.md");
  });
});

describe("one source of truth", () => {
  test("two separate root files warn to symlink or import", async () => {
    await writeFile(join(repo, "CLAUDE.md"), "# Claude facts\n");
    await writeFile(join(repo, "AGENTS.md"), "# Agents facts\n");
    const pair = byCode(audit(), "root-pair");
    expect(pair).toHaveLength(1);
    expect(pair[0]!.severity).toBe("warn");
    expect(pair[0]!.label).toContain("separate files");
    expect(pair[0]!.detail).toContain("symlink");
    expect(pair[0]!.detail).toContain("@AGENTS.md");
  });

  test("a symlinked pair passes and is measured once", async () => {
    await writeFile(join(repo, "AGENTS.md"), "# Facts\n");
    symlinkSync("AGENTS.md", join(repo, "CLAUDE.md"));
    const findings = audit();
    const pair = byCode(findings, "root-pair");
    expect(pair).toHaveLength(1);
    expect(pair[0]!.severity).toBe("pass");
    // the symlink carries no bytes of its own, so only the target is measured
    expect(byCode(findings, "root-size")).toHaveLength(1);
  });

  test("a lone root file that is a symlink elsewhere is still measured", async () => {
    await mkdir(join(repo, "shared"), { recursive: true });
    await writeFile(join(repo, "shared", "CLAUDE.md"), filler(9000));
    symlinkSync(join("shared", "CLAUDE.md"), join(repo, "CLAUDE.md"));
    const root = byCode(audit(), "root-size");
    expect(root).toHaveLength(1);
    expect(root[0]!.severity).toBe("warn");
  });

  test("a dangling symlink root is treated as absent", async () => {
    symlinkSync("nowhere.md", join(repo, "CLAUDE.md"));
    await writeFile(join(repo, "AGENTS.md"), "# Facts\n");
    const findings = audit();
    expect(byCode(findings, "root-pair")).toHaveLength(0);
    expect(byCode(findings, "root-size")).toHaveLength(1);
  });

  test("a CLAUDE.md that is just the @AGENTS.md import passes", async () => {
    await writeFile(join(repo, "AGENTS.md"), "# Facts\n");
    await writeFile(join(repo, "CLAUDE.md"), "# Project\n\n@AGENTS.md\n");
    const pair = byCode(audit(), "root-pair");
    expect(pair[0]!.severity).toBe("pass");
    expect(pair[0]!.label).toContain("@AGENTS.md");
  });

  test("isAgentsImport rejects a file with real prose alongside the import", () => {
    expect(isAgentsImport("@AGENTS.md\n")).toBe(true);
    expect(isAgentsImport("# Title\n\n@AGENTS.md\n")).toBe(true);
    expect(isAgentsImport("@AGENTS.md\n\nAlso: never run migrations in prod.\n")).toBe(false);
    expect(isAgentsImport("# Title\n\nSome facts.\n")).toBe(false);
  });
});

describe("generated framework blocks", () => {
  test("a usage-rules marker in a root file warns to move it to skills", async () => {
    await writeFile(join(repo, "AGENTS.md"), `# Facts\n\n${USAGE_RULES_MARKER}\nphoenix stuff\n`);
    const warn = byCode(audit(), "usage-rules");
    expect(warn).toHaveLength(1);
    expect(warn[0]!.severity).toBe("warn");
    expect(warn[0]!.detail).toContain("skill");
  });

  test("no marker means no finding", async () => {
    await writeFile(join(repo, "AGENTS.md"), "# Facts\n");
    expect(byCode(audit(), "usage-rules")).toHaveLength(0);
  });
});

describe("nested instruction files", () => {
  test("a nested file over 4 KB warns with the byte count", async () => {
    await writeFile(join(repo, "AGENTS.md"), "# Facts\n");
    await mkdir(join(repo, "lib", "giving"), { recursive: true });
    await writeFile(join(repo, "lib", "giving", "AGENTS.md"), filler(5000));
    const nested = byCode(audit(), "nested-size");
    expect(nested).toHaveLength(1);
    expect(nested[0]!.severity).toBe("warn");
    expect(nested[0]!.label).toContain(join("lib", "giving", "AGENTS.md"));
    expect(nested[0]!.label).toContain(formatBytes(5000)); // 4.9 KB
    expect(nested[0]!.label).toContain(formatBytes(NESTED_BUDGET_BYTES));
  });

  test("a nested file under budget produces no warning", async () => {
    await writeFile(join(repo, "AGENTS.md"), "# Facts\n");
    await mkdir(join(repo, "lib"), { recursive: true });
    await writeFile(join(repo, "lib", "AGENTS.md"), filler(1000));
    expect(byCode(audit(), "nested-size")).toHaveLength(0);
  });

  test("vendored trees are skipped", async () => {
    await writeFile(join(repo, "AGENTS.md"), "# Facts\n");
    for (const dir of ["deps", "node_modules", "_build", "dist", ".elixir_ls"]) {
      await mkdir(join(repo, dir, "phoenix"), { recursive: true });
      await writeFile(join(repo, dir, "phoenix", "AGENTS.md"), filler(5000));
    }
    await mkdir(join(repo, "priv", "static"), { recursive: true });
    await writeFile(join(repo, "priv", "static", "AGENTS.md"), filler(5000));
    expect(byCode(audit(), "nested-size")).toHaveLength(0);
  });

  test(".claude/rules/*.md counts as a nested instruction file", async () => {
    await writeFile(join(repo, "AGENTS.md"), "# Facts\n");
    await mkdir(join(repo, ".claude", "rules"), { recursive: true });
    await writeFile(join(repo, ".claude", "rules", "money.md"), filler(5000));
    const nested = byCode(audit(), "nested-size");
    expect(nested).toHaveLength(1);
    expect(nested[0]!.label).toContain(join(".claude", "rules", "money.md"));
  });
});

describe("codex arithmetic", () => {
  test("global + root under the ceiling passes with the numbers", async () => {
    await writeFile(join(repo, "AGENTS.md"), filler(4000));
    const budget = byCode(audit({ codexGlobalBytes: 30_000, codexMaxBytes: 65_536 }), "codex-budget");
    expect(budget).toHaveLength(1);
    expect(budget[0]!.severity).toBe("pass");
    expect(budget[0]!.label).toBe("codex 29.3+3.9 KB of 64 KB");
  });

  test("global + root over the ceiling warns", async () => {
    await writeFile(join(repo, "AGENTS.md"), filler(4000));
    const budget = byCode(audit({ codexGlobalBytes: 30_000, codexMaxBytes: 32_768 }), "codex-budget");
    expect(budget[0]!.severity).toBe("warn");
    expect(budget[0]!.label).toContain("29.3+3.9 KB");
    expect(budget[0]!.label).toContain("32 KB");
  });

  test("the largest nested AGENTS.md joins the sum", async () => {
    await writeFile(join(repo, "AGENTS.md"), filler(4000));
    await mkdir(join(repo, "lib", "a"), { recursive: true });
    await mkdir(join(repo, "lib", "b"), { recursive: true });
    await writeFile(join(repo, "lib", "a", "AGENTS.md"), filler(1024));
    await writeFile(join(repo, "lib", "b", "AGENTS.md"), filler(2048));
    const budget = byCode(audit({ codexGlobalBytes: 30_000, codexMaxBytes: 65_536 }), "codex-budget");
    expect(budget[0]!.label).toBe("codex 29.3+3.9+2 KB of 64 KB");
  });

  test("a CLAUDE.md-only repo gets a note instead of arithmetic", async () => {
    await writeFile(join(repo, "CLAUDE.md"), "# Facts\n");
    const findings = audit();
    expect(byCode(findings, "codex-budget")).toHaveLength(0);
    const note = byCode(findings, "codex-claude-only");
    expect(note).toHaveLength(1);
    expect(note[0]!.severity).toBe("pass");
    expect(note[0]!.label).toContain("Codex reads AGENTS.md");
  });

  test("an absent ~/.codex/AGENTS.md drops the global term", async () => {
    await writeFile(join(repo, "AGENTS.md"), filler(4000));
    const budget = byCode(audit({ codexGlobalBytes: null }), "codex-budget");
    expect(budget[0]!.label).toBe("codex 3.9 KB of 64 KB");
  });
});

describe("no root instruction file", () => {
  test("reports one pass-level note and no arithmetic", async () => {
    const findings = audit();
    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({ severity: "pass", code: "root-none", label: "no root instruction file" });
  });
});
