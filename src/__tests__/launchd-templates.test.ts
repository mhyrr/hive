import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const launchdDir = join(import.meta.dir, "..", "..", "templates", "launchd");
const plutil = Bun.which("plutil");
const plists = readdirSync(launchdDir).filter((f) => f.endsWith(".plist"));

describe("launchd templates", () => {
  test("there are templates to lint", () => {
    expect(plists.length).toBeGreaterThan(0);
  });

  // plutil ships with macOS only.
  test.skipIf(!plutil).each(plists)("%s passes plutil -lint", (name) => {
    const result = Bun.spawnSync([plutil!, "-lint", join(launchdDir, name)]);
    expect(result.stdout.toString().trim()).toEndWith(": OK");
    expect(result.exitCode).toBe(0);
  });
});
