/**
 * Drift between the scripts and launchd plists that `hive init` installs and
 * the templates they came from (TK-167). `hive init` never overwrites an
 * installed file, so a hand edit and a newer template both persist unnoticed.
 *
 * The templates are text imports because a compiled binary cannot read
 * `templates/` at runtime (`import.meta.dir` is `/$bunfs/root` there). The
 * check therefore compares against the templates this binary was built with.
 * `install-drift.test.ts` fails when a file in those two template directories
 * is missing from this list.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import dashboardPlist from "../../templates/launchd/com.hive.dashboard.plist" with { type: "text" };
import nightlyPlist from "../../templates/launchd/com.hive.nightly.plist" with { type: "text" };
import syncPlist from "../../templates/launchd/com.hive.sync.plist" with { type: "text" };
import tasteReviewPlist from "../../templates/launchd/com.hive.taste-review.plist" with { type: "text" };
import syncScript from "../../templates/scripts/hive-sync.sh" with { type: "text" };
import nightlyScript from "../../templates/scripts/nightly.sh" with { type: "text" };
import tasteReviewScript from "../../templates/scripts/taste-review.sh" with { type: "text" };

export type InstalledTemplate = {
  dir: "scripts" | "launchd";
  name: string;
  content: string;
};

// Bun types a `.sh`/`.plist` import by its default loader; `type: "text"`
// makes the value a string.
const text = (value: unknown): string => value as string;

export const INSTALLED_TEMPLATES: InstalledTemplate[] = [
  { dir: "scripts", name: "hive-sync.sh", content: text(syncScript) },
  { dir: "scripts", name: "nightly.sh", content: text(nightlyScript) },
  { dir: "scripts", name: "taste-review.sh", content: text(tasteReviewScript) },
  { dir: "launchd", name: "com.hive.dashboard.plist", content: text(dashboardPlist) },
  { dir: "launchd", name: "com.hive.nightly.plist", content: text(nightlyPlist) },
  { dir: "launchd", name: "com.hive.sync.plist", content: text(syncPlist) },
  { dir: "launchd", name: "com.hive.taste-review.plist", content: text(tasteReviewPlist) },
];

export type DiffLine = { side: "installed" | "template"; line: number; text: string };

/** Lines present on only one side, from a longest-common-subsequence diff. */
export function diffLines(template: string, installed: string): DiffLine[] {
  const a = template.split("\n");
  const b = installed.split("\n");
  // common[i][j] = LCS length of a[i..] and b[j..]
  const common = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      common[i]![j] = a[i] === b[j]
        ? common[i + 1]![j + 1]! + 1
        : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && common[i + 1]![j]! >= common[i]![j + 1]!)) {
      out.push({ side: "template", line: i + 1, text: a[i]! });
      i++;
    } else {
      out.push({ side: "installed", line: j + 1, text: b[j]! });
      j++;
    }
  }
  return out;
}

const MAX_QUOTED = 2;
const MAX_QUOTED_CHARS = 100;
const MAX_DETAIL = 20;

function isCode(line: string): boolean {
  const trimmed = line.trim();
  return trimmed !== "" && !trimmed.startsWith("#") && !trimmed.startsWith("<!--");
}

/** One line for the doctor label, which prints without --verbose. */
export function summarizeDrift(diff: DiffLine[]): string {
  const code = diff.filter((d) => isCode(d.text));
  if (code.length === 0 || code.length > MAX_QUOTED) {
    return `${diff.length} line${diff.length === 1 ? "" : "s"} differ`;
  }
  const quoted = code.map((d) => `only in ${d.side}: ${d.text.trim()}`).join("; ");
  return quoted.length > MAX_QUOTED_CHARS ? `${diff.length} lines differ` : quoted;
}

export type DriftCheck = { status: "pass" | "warn"; label: string; detail?: string };

/**
 * One warning per installed file that differs from its template, or a single
 * pass when every installed file matches. A file that is not installed is
 * skipped: that is not drift, and the scheduler checks report missing agents.
 */
export function checkInstallDrift(dirs: { scripts: string; launchd: string }): DriftCheck[] {
  const checks: DriftCheck[] = [];
  let compared = 0;

  for (const template of INSTALLED_TEMPLATES) {
    const path = join(dirs[template.dir], template.name);
    if (!existsSync(path)) continue;

    let installed: string;
    try {
      installed = readFileSync(path, "utf-8");
    } catch (err) {
      checks.push({
        status: "warn",
        label: `${path} unreadable, drift unverified`,
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    compared++;
    if (installed === template.content) continue;

    const diff = diffLines(template.content, installed);
    const lines = diff
      .slice(0, MAX_DETAIL)
      .map((d) => `only in ${d.side}, line ${d.line}: ${d.text}`);
    if (diff.length > MAX_DETAIL) lines.push(`… and ${diff.length - MAX_DETAIL} more`);
    checks.push({
      status: "warn",
      label: `drift: ${path} (${summarizeDrift(diff)})`,
      detail: [
        `Differs from templates/${template.dir}/${template.name} as built into this binary. Drift is not an error; hive init never overwrites the installed file.`,
        ...lines,
      ].join("\n        "),
    });
  }

  if (checks.length === 0 && compared > 0) {
    checks.push({ status: "pass", label: `${compared} installed script(s) and plist(s) match their templates` });
  }
  return checks;
}
