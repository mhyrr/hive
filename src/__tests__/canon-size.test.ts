import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CANON_ACT_AT,
  CANON_WARN_AT,
  canonSizeLevel,
  canonSizePath,
  canonSizeWarnings,
  computeCanonGrowth,
  measureAllCanons,
  recordCanonSize,
  upsertCanonSizeSection,
  type CanonSizeMeasurement,
  type CanonSizeRecord,
} from "../lib/canon-size";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { CHARS_PER_TOKEN, VERIFY_BUDGET_TOKENS, VERIFY_WINDOW_TOKENS } from "../lib/verify";
import { renderCanonSize } from "../lib/dashboard/render";

// ---------------------------------------------------------------------------
// Pure threshold + wording
// ---------------------------------------------------------------------------

function measurement(projectId: string, promptTokens: number, budget = 100_000): CanonSizeMeasurement {
  const pctOfBudget = promptTokens / budget;
  return {
    projectId,
    knowledgeBytes: promptTokens * 3,
    promptChars: Math.round(promptTokens * CHARS_PER_TOKEN),
    promptTokens,
    pctOfBudget,
    level: canonSizeLevel(pctOfBudget),
  };
}

function record(date: string, projects: CanonSizeMeasurement[], budget = 100_000): CanonSizeRecord {
  return {
    version: 1,
    date,
    measuredAt: `${date}T02:00:00Z`,
    windowTokens: budget + 16_000,
    budgetTokens: budget,
    projects: [...projects].sort((a, b) => b.promptTokens - a.promptTokens),
  };
}

describe("canonSizeLevel", () => {
  test("thresholds are 60% warn and 80% act", () => {
    expect(CANON_WARN_AT).toBe(0.6);
    expect(CANON_ACT_AT).toBe(0.8);
  });

  test("quiet below 60%, warn from 60%, act from 80%", () => {
    expect(canonSizeLevel(0)).toBe("ok");
    expect(canonSizeLevel(0.5999)).toBe("ok");
    expect(canonSizeLevel(0.6)).toBe("warn");
    expect(canonSizeLevel(0.7999)).toBe("warn");
    expect(canonSizeLevel(0.8)).toBe("act");
    expect(canonSizeLevel(1.2)).toBe("act");
  });
});

describe("canonSizeWarnings", () => {
  test("no lines when every project is below the warn line", () => {
    const rec = record("2026-11-19", [measurement("a", 59_999), measurement("b", 10_000)]);
    expect(canonSizeWarnings(rec, new Map())).toEqual([]);
  });

  test("one line per project over a threshold, worst first, naming project and growth", () => {
    const today = record("2026-11-19", [
      measurement("quiet", 59_000),
      measurement("warned", 60_000),
      measurement("acted", 80_000),
    ]);
    const weekAgo = record("2026-11-12", [
      measurement("quiet", 50_000),
      measurement("warned", 55_000),
      measurement("acted", 70_000),
    ]);
    const lines = canonSizeWarnings(today, computeCanonGrowth(today, [weekAgo]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("**acted**");
    expect(lines[0]).toContain("80% of the 100k budget");
    expect(lines[0]).toContain("+10k tokens");
    expect(lines[0]).toContain("over 7 days");
    expect(lines[0]).toContain("**Act:**");
    expect(lines[0]).toMatch(/split the Verify shard by section or tag/i);
    expect(lines[1]).toContain("**warned**");
    expect(lines[1]).toContain("60% of the 100k budget");
    expect(lines[1]).toContain("+5k tokens");
    expect(lines[1]).toContain("**Warn:**");
    expect(lines.join("\n")).not.toContain("quiet");
  });

  test("a project with no earlier record still warns, and says so", () => {
    const rec = record("2026-11-19", [measurement("fresh", 90_000)]);
    const [line] = canonSizeWarnings(rec, computeCanonGrowth(rec, []));
    expect(line).toContain("no earlier record to measure growth");
  });

  test("growth uses the oldest record in the window and reports its span", () => {
    const today = record("2026-11-19", [measurement("p", 70_000)]);
    const growth = computeCanonGrowth(today, [
      record("2026-11-15", [measurement("p", 66_000)]),
      record("2026-11-18", [measurement("p", 69_000)]),
    ]);
    expect(growth.get("p")).toMatchObject({ days: 4, tokens: 4_000 });
  });
});

describe("upsertCanonSizeSection", () => {
  const briefing = "# Briefing\n\nHeadline.\n\n## Memory + verifier\n- Added: 1 entries.\n";

  test("appends a section, and replaces it rather than duplicating", () => {
    const once = upsertCanonSizeSection(briefing, ["- line one"]);
    expect(once).toContain("## Canon size\n- line one\n");
    const twice = upsertCanonSizeSection(once, ["- line two"]);
    expect(twice.match(/## Canon size/g)).toHaveLength(1);
    expect(twice).toContain("- line two");
    expect(twice).not.toContain("- line one");
    expect(twice).toContain("## Memory + verifier");
  });

  test("no lines leaves no section", () => {
    const withSection = upsertCanonSizeSection(briefing, ["- x"]);
    expect(upsertCanonSizeSection(withSection, [])).not.toContain("## Canon size");
    expect(upsertCanonSizeSection(briefing, [])).toBe(briefing);
  });
});

// ---------------------------------------------------------------------------
// End to end against a real ~/.hive layout, at the real budget
// ---------------------------------------------------------------------------

/** A knowledge.md whose canon is ~`chars` characters of fact text. */
function knowledgeOf(projectId: string, chars: number): string {
  const entry = "x".repeat(990);
  const n = Math.ceil(chars / entry.length);
  const facts = Array.from({ length: n }, (_, i) => `- ${i} ${entry} [t]`).join("\n");
  return `# Project Memory: ${projectId}\n\n## Durable Facts\n${facts}\n\n## Conventions\n(none yet)\n\n## Decisions\n(none yet)\n\n## Open Questions\n(none yet)\n`;
}

async function fixture(sizes: Record<string, number>): Promise<HivePaths> {
  const home = await mkdtemp(join(tmpdir(), "hive-canon-size-"));
  const paths = await ensureHiveScaffold(home);
  for (const [id, chars] of Object.entries(sizes)) {
    await mkdir(join(paths.projectsDir, id), { recursive: true });
    await writeFile(join(paths.projectsDir, id, "config.md"), `---\nname: ${id}\n---\n`);
    await mkdir(join(paths.memoryProjectsDir, id), { recursive: true });
    await writeFile(join(paths.memoryProjectsDir, id, "knowledge.md"), knowledgeOf(id, chars));
  }
  return paths;
}

describe("recordCanonSize", () => {
  test("percentage is the assertPromptFits estimate over its budget", async () => {
    const paths = await fixture({ small: 20_000 });
    const rec = await measureAllCanons(paths, "2026-11-19");
    const m = rec.projects[0]!;
    expect(rec.budgetTokens).toBe(VERIFY_BUDGET_TOKENS);
    expect(rec.windowTokens).toBe(VERIFY_WINDOW_TOKENS);
    // Same arithmetic as estimatePromptTokens: ceil(chars / CHARS_PER_TOKEN).
    expect(m.promptTokens).toBe(Math.ceil(m.promptChars / CHARS_PER_TOKEN));
    expect(m.pctOfBudget).toBeCloseTo(m.promptTokens / VERIFY_BUDGET_TOKENS, 10);
    // The prompt carries the JSON-serialized canon, so it outweighs the file.
    expect(m.promptChars).toBeGreaterThan(m.knowledgeBytes);
  });

  test("warns in the briefing at the act line, stays quiet for a small project, records the night", async () => {
    // Size the big canon to land between 80% and 100% of the real budget.
    const target = Math.round(VERIFY_BUDGET_TOKENS * CHARS_PER_TOKEN * 0.85);
    const paths = await fixture({ big: target, small: 20_000 });
    const date = "2026-11-19";
    const runDir = join(paths.memoryRunsDir, date);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "briefing.md"), "# Briefing\n\nHeadline.\n");

    // A record from a week earlier, for growth.
    const prior = join(paths.memoryRunsDir, "2026-11-12");
    await mkdir(prior, { recursive: true });
    const priorRec = await measureAllCanons(paths, "2026-11-12");
    priorRec.projects = priorRec.projects.map((p) =>
      p.projectId === "big" ? { ...p, promptTokens: p.promptTokens - 12_000, knowledgeBytes: p.knowledgeBytes - 40_000 } : p,
    );
    await writeFile(join(prior, "canon-size.json"), JSON.stringify(priorRec));

    const { record: rec, warnings } = await recordCanonSize(paths, date);
    const big = rec.projects.find((p) => p.projectId === "big")!;
    expect(big.level).toBe("act");
    expect(big.pctOfBudget).toBeGreaterThanOrEqual(0.8);
    expect(big.pctOfBudget).toBeLessThan(1);
    expect(rec.projects.find((p) => p.projectId === "small")!.level).toBe("ok");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("**big**");
    expect(warnings[0]).toContain("+12k tokens (+39 KB) over 7 days");

    const briefing = await readFile(join(runDir, "briefing.md"), "utf-8");
    expect(briefing).toContain("## Canon size");
    expect(briefing).toContain("**big**");
    expect(briefing).not.toContain("**small**");

    const saved = JSON.parse(await readFile(canonSizePath(paths, date), "utf-8")) as CanonSizeRecord;
    expect(saved.projects.map((p) => p.projectId)).toEqual(["big", "small"]);

    // A second apply of the same night does not stack sections.
    await recordCanonSize(paths, date);
    const again = await readFile(join(runDir, "briefing.md"), "utf-8");
    expect(again.match(/## Canon size/g)).toHaveLength(1);
  });

  test("below the warn line the briefing is untouched", async () => {
    const paths = await fixture({ small: 20_000 });
    const date = "2026-11-19";
    const runDir = join(paths.memoryRunsDir, date);
    await mkdir(runDir, { recursive: true });
    const body = "# Briefing\n\nHeadline.\n";
    await writeFile(join(runDir, "briefing.md"), body);
    const { warnings } = await recordCanonSize(paths, date);
    expect(warnings).toEqual([]);
    expect(await readFile(join(runDir, "briefing.md"), "utf-8")).toBe(body);
  });

  test("a project without knowledge.md is skipped and not created", async () => {
    const paths = await fixture({ small: 20_000 });
    await mkdir(join(paths.projectsDir, "empty"), { recursive: true });
    const rec = await measureAllCanons(paths, "2026-11-19");
    expect(rec.projects.map((p) => p.projectId)).toEqual(["small"]);
    expect(existsSync(join(paths.memoryProjectsDir, "empty", "knowledge.md"))).toBe(false);
  });
});

describe("renderCanonSize", () => {
  test("lists every project with bytes, tokens, % and growth; opens when one is flagged", () => {
    const today = record("2026-11-19", [measurement("acted", 85_000), measurement("quiet", 10_000)]);
    const html = renderCanonSize({
      record: today,
      growth: { acted: { days: 7, tokens: 3_000, bytes: 10_240 } },
    });
    expect(html).toContain("<details class=\"canon-size\" open>");
    expect(html).toContain("Verify budget · acted 85%");
    expect(html).toContain("acted");
    expect(html).toContain("quiet");
    expect(html).toContain("+3k tokens (+10 KB) over 7 days");
    expect(html).toContain("<tr class=\"canon-act\">");
  });

  test("collapsed when nothing is flagged, empty with no data", () => {
    const html = renderCanonSize({ record: record("2026-11-19", [measurement("q", 10_000)]), growth: {} });
    expect(html).toContain("<details class=\"canon-size\">");
    expect(renderCanonSize(null)).toBe("");
  });
});
