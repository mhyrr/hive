import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateLegacyWatches } from "./init";
import { ensureHiveScaffold } from "../lib/paths";
import { loadWatchState, saveWatchState, stateEntry } from "../lib/watch-state";

describe("legacy watch migration", () => {
  test("retires old definitions and moves their settled cursors once", async () => {
    const paths = await ensureHiveScaffold(await mkdtemp(join(tmpdir(), "hive-watch-migrate-")));
    await writeFile(join(paths.watchesDir, "bets.md"), "legacy proposal prompt");
    await writeFile(join(paths.watchesDir, "muse.md"), "legacy observation prompt");
    await writeFile(join(paths.watchesDir, "act.md"), "---\ncadence: 6h\nvenue: dispatch\nautonomy: act\n---\n\nAct question.");
    const state = { watches: {} };
    stateEntry(state, "bets").lastRun = "2026-08-12T02:00:00Z";
    stateEntry(state, "muse").lastRun = "2026-08-10T06:00:00Z";
    await saveWatchState(paths, state);

    expect(await migrateLegacyWatches(paths)).toBe(3);
    expect(existsSync(join(paths.watchesDir, "bets.md"))).toBe(false);
    expect(existsSync(join(paths.watchesDir, "muse.md"))).toBe(false);
    expect(existsSync(join(paths.watchesDir, "bets.legacy"))).toBe(true);
    expect(existsSync(join(paths.watchesDir, "muse.legacy"))).toBe(true);
    expect(await Bun.file(join(paths.watchesDir, "act.md")).text()).toContain("venue: act");
    expect(await loadWatchState(paths)).toMatchObject({
      watches: {
        propose: { lastRun: "2026-08-12T02:00:00Z" },
        observe: { lastRun: "2026-08-10T06:00:00Z" },
      },
    });
    expect((await loadWatchState(paths)).watches.bets).toBeUndefined();
    expect((await loadWatchState(paths)).watches.muse).toBeUndefined();

    expect(await migrateLegacyWatches(paths)).toBe(0);
  });
});
