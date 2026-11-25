import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkInstallDrift, diffLines, INSTALLED_TEMPLATES } from "../lib/install-drift";

const templatesRoot = join(import.meta.dir, "..", "..", "templates");

describe("install drift", () => {
  let home: string;
  let dirs: { scripts: string; launchd: string };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hive-drift-"));
    dirs = { scripts: join(home, ".hive", "scripts"), launchd: join(home, "Library", "LaunchAgents") };
  });

  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function install(): void {
    for (const dir of ["scripts", "launchd"] as const) {
      mkdirSync(dirs[dir], { recursive: true });
      for (const name of readdirSync(join(templatesRoot, dir))) {
        copyFileSync(join(templatesRoot, dir, name), join(dirs[dir], name));
      }
    }
  }

  test("embeds every file in templates/scripts and templates/launchd", () => {
    for (const dir of ["scripts", "launchd"] as const) {
      const embedded = INSTALLED_TEMPLATES.filter((t) => t.dir === dir);
      expect(embedded.map((t) => t.name).sort()).toEqual(readdirSync(join(templatesRoot, dir)).sort());
      for (const t of embedded) {
        expect(t.content).toBe(readFileSync(join(templatesRoot, dir, t.name), "utf-8"));
      }
    }
  });

  test("passes when every installed file matches", () => {
    install();
    const checks = checkInstallDrift(dirs);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("pass");
  });

  test("says nothing when nothing is installed", () => {
    expect(checkInstallDrift(dirs)).toEqual([]);
  });

  test("warns once, naming the file and the added line", () => {
    install();
    const path = join(dirs.scripts, "nightly.sh");
    const script = readFileSync(path, "utf-8").replace(
      "\nHIVE=",
      "\n# temporary\nexport HIVE_VERIFY_SHADOW=on\n\nHIVE=",
    );
    writeFileSync(path, script);

    const checks = checkInstallDrift(dirs);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.status).toBe("warn");
    expect(checks[0]!.label).toBe(`drift: ${path} (only in installed: export HIVE_VERIFY_SHADOW=on)`);
    expect(checks[0]!.detail).toContain("# temporary");
    expect(checks[0]!.detail!.match(/only in installed, line/g)).toHaveLength(3);
    expect(checks[0]!.detail).not.toContain("only in template, line");
  });

  test("warns about a plist and reports both sides of a changed line", () => {
    install();
    const path = join(dirs.launchd, "com.hive.sync.plist");
    writeFileSync(path, readFileSync(path, "utf-8").replace("2>&amp;1", "2>&1"));

    const [check, ...rest] = checkInstallDrift(dirs);
    expect(rest).toEqual([]);
    // Two long lines would swamp the label, so it falls back to a count.
    expect(check!.label).toBe(`drift: ${path} (2 lines differ)`);
    expect(check!.detail).toContain("only in template, line 11");
    expect(check!.detail).toContain("only in installed, line 11");
  });

  test("diffLines finds a deletion without flagging the lines after it", () => {
    expect(diffLines("a\nb\nc\nd", "a\nc\nd")).toEqual([{ side: "template", line: 2, text: "b" }]);
  });
});
