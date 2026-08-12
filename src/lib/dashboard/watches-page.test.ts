import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectWatchesPage, renderWatchesPageDocument } from "./watches-page";
import { saveWatchState, stateEntry, type WatchState } from "../watch-state";
import { ensureHiveScaffold, type HivePaths } from "../paths";

const ANCHOR = new Date("2026-08-12T10:00:00");

describe("watches dashboard page", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-watchpage-"));
    paths = await ensureHiveScaffold(home);
    process.env.HIVE_FIXED_NOW = ANCHOR.toISOString();
  });

  afterEach(() => {
    delete process.env.HIVE_FIXED_NOW;
  });

  test("collect: rows carry clamped autonomy, state, spend, and artifacts", async () => {
    await writeFile(paths.config, "# Hive Config\n\nwatches.max_autonomy: observe\n");
    await writeFile(
      join(paths.watchesDir, "bets.md"),
      "---\nname: bets\ncadence: @nightly\nscope: runs\nmodel: judgment\nvenue: briefing\nautonomy: propose\n---\n\nWhat bets?",
    );

    const state: WatchState = { watches: {}, lastTick: new Date(ANCHOR.getTime() - 30 * 60_000).toISOString() };
    const entry = stateEntry(state, "bets");
    entry.lastRun = new Date(ANCHOR.getTime() - 3_600_000).toISOString();
    entry.lastOutcome = "surfaced";
    entry.usage.push({
      at: new Date(ANCHOR.getTime() - 3_600_000).toISOString(),
      model: "claude-opus-4-8",
      inputTokens: 1000,
      outputTokens: 200,
      durationMs: 900,
    });
    await saveWatchState(paths, state);

    const runDir = join(paths.memoryRunsDir, "2026-08-12");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "bets.md"), "# Watch: bets\n\nBet: something.");

    const data = await collectWatchesPage(paths);
    expect(data.ceiling).toBe("observe");
    expect(data.tickStale).toBe(false);
    expect(data.rows.length).toBe(1);
    expect(data.rows[0]).toMatchObject({
      qualifiedName: "bets",
      autonomy: "propose",
      effectiveAutonomy: "observe", // ceiling clamps on the page too
      lastOutcome: "surfaced",
      calls7d: 1,
      tokens7d: 1200,
    });
    expect(data.artifacts).toEqual([
      { watch: "bets", date: "2026-08-12", path: join(runDir, "bets.md") },
    ]);
  });

  test("collect: never-run tick reads as stale", async () => {
    const data = await collectWatchesPage(paths);
    expect(data.lastTick).toBeNull();
    expect(data.tickStale).toBe(true);
    expect(data.rows).toEqual([]);
  });

  test("render: fleet table, ceiling, liveness, and empty state", async () => {
    const empty = await collectWatchesPage(paths);
    const emptyHtml = renderWatchesPageDocument(empty);
    expect(emptyHtml).toContain("No watches yet");
    expect(emptyHtml).toContain("tick has never run");
    expect(emptyHtml).toContain('href="/watches"');

    await writeFile(
      join(paths.watchesDir, "muse.md"),
      "---\nname: muse\ncadence: mon,thu\nscope: transcripts\nautonomy: observe\n---\n\nThreads?",
    );
    const data = await collectWatchesPage(paths);
    const html = renderWatchesPageDocument(data);
    expect(html).toContain("muse");
    expect(html).toContain("mon,thu");
    expect(html).toContain("Autonomy ceiling: <strong>propose</strong>");
  });
});
