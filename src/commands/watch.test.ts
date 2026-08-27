import { describe, expect, test, afterEach } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { watchCommand } from "./watch";
import { ensureHiveScaffold } from "../lib/paths";
import { parseWatchFile } from "../lib/watch";

describe("watch command mutations", () => {
  const originalHome = process.env.HIVE_HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = originalHome;
  });

  test("set on a qualified fanned watch does not rewrite the fleet spec", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-watch-cmd-"));
    process.env.HIVE_HOME = home;
    const paths = await ensureHiveScaffold(home);
    await mkdir(join(paths.projectsDir, "alpha"), { recursive: true });
    await mkdir(join(paths.projectsDir, "beta"), { recursive: true });
    const fleet = join(paths.watchesDir, "act.md");
    await writeFile(fleet, "---\ncadence: 6h\nautonomy: act\nvenue: act\nenabled: true\n---\n\nFleet act.");

    await watchCommand(["set", "alpha/act", "cadence=12h"]);

    expect(parseWatchFile(await Bun.file(fleet).text(), fleet, null).watch?.cadence).toEqual({
      type: "interval",
      ms: 6 * 3_600_000,
    });
    const override = join(paths.projectsDir, "alpha", "watches", "act.md");
    expect(parseWatchFile(await Bun.file(override).text(), override, "alpha").watch).toMatchObject({
      cadence: { type: "interval", ms: 12 * 3_600_000 },
      enabled: true,
      question: "Fleet act.",
    });
  });

  test("set on a bare fanned name refuses and leaves the fleet spec alone", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-watch-cmd-bare-"));
    process.env.HIVE_HOME = home;
    const paths = await ensureHiveScaffold(home);
    await mkdir(join(paths.projectsDir, "alpha"), { recursive: true });
    await mkdir(join(paths.projectsDir, "beta"), { recursive: true });
    const fleet = join(paths.watchesDir, "act.md");
    await writeFile(fleet, "---\ncadence: 6h\nautonomy: act\nvenue: act\nenabled: true\n---\n\nFleet act.");

    await expect(watchCommand(["set", "act", "cadence=12h"])).rejects.toThrow(/qualified name/);
    expect(parseWatchFile(await Bun.file(fleet).text(), fleet, null).watch?.cadence).toEqual({
      type: "interval",
      ms: 6 * 3_600_000,
    });
  });
});
