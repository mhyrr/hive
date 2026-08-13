import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectWatchesPage, renderWatchesPageDocument } from "./watches-page";
import { saveWatchState, stateEntry, type WatchState } from "../watch-state";
import { writeInvocationLog } from "../watch-log";
import { parseWatchFile } from "../watch";
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

  test("the latest output of each watch renders inline, not as a path", async () => {
    await writeWatchFile(paths, "bets.md", "---\nname: bets\ncadence: @nightly\nscope: runs\nvenue: briefing\nautonomy: propose\n---\n\nWhat bets?");
    await writeWatchFile(paths, "muse.md", "---\nname: muse\ncadence: mon,thu\nscope: transcripts\nautonomy: observe\n---\n\nThreads?");

    await logCall(paths, "bets", new Date(ANCHOR.getTime() - 4 * 3_600_000), {
      output: "**Bet 1** — santo-api ships distribution before trust.",
      outcome: "surfaced",
    });
    // Older bets call: the page shows the newest, never both.
    await logCall(paths, "bets", new Date(ANCHOR.getTime() - 28 * 3_600_000), {
      output: "Yesterday's bet.",
      outcome: "surfaced",
    });
    await logCall(paths, "muse", new Date(ANCHOR.getTime() - 2 * 3_600_000), {
      output: "NO_SIGNAL",
      outcome: "quiet",
    });

    const data = await collectWatchesPage(paths);
    expect(data.latest.map((c) => c.watch)).toEqual(["muse", "bets"]); // newest first
    expect(data.latest.find((c) => c.watch === "bets")!.output).toContain("santo-api");
    expect(data.latest.find((c) => c.watch === "muse")!.quiet).toBe(true);

    const html = renderWatchesPageDocument(data);
    expect(html).toContain("Latest output");
    expect(html).toContain("<strong>Bet 1</strong>"); // markdown, rendered
    expect(html).not.toContain("Yesterday's bet");
    expect(html).toContain("Chose silence");
    expect(html).toContain('href="/watches/bets"'); // fleet row links to the prompts
  });

  test("output the provenance gate dropped is labelled as having reached nowhere", async () => {
    await writeWatchFile(paths, "muse.md", "---\nname: muse\ncadence: mon,thu\nscope: transcripts\n---\n\nThreads?");
    await logCall(paths, "muse", new Date(ANCHOR.getTime() - 3_600_000), {
      output: "A memo with no citations.",
      outcome: "quiet (output dropped — no evidence anchor cited)",
    });

    const data = await collectWatchesPage(paths);
    expect(data.latest[0]!.dropped).toBe(true);
    expect(data.latest[0]!.quiet).toBe(false); // it spoke; the gate stopped it

    const html = renderWatchesPageDocument(data);
    expect(html).toContain("reached no venue");
    expect(html).toContain("A memo with no citations.");
  });

  test("an errored call surfaces the error in place of output", async () => {
    await writeWatchFile(paths, "bets.md", "---\nname: bets\ncadence: @nightly\nscope: runs\n---\n\nWhat bets?");
    await logCall(paths, "bets", new Date(ANCHOR.getTime() - 3_600_000), {
      output: null,
      error: "ConnectionRefused",
      outcome: "error",
    });

    const html = renderWatchesPageDocument(await collectWatchesPage(paths));
    expect(html).toContain("ConnectionRefused");
  });
});

async function writeWatchFile(paths: HivePaths, file: string, content: string): Promise<void> {
  await writeFile(join(paths.watchesDir, file), content);
}

/** Log a model call the way the runner does, so the page reads a real file. */
async function logCall(
  paths: HivePaths,
  name: string,
  at: Date,
  over: { output?: string | null; error?: string; outcome: string },
): Promise<void> {
  const { watch } = parseWatchFile(
    `---\nname: ${name}\ncadence: @nightly\nscope: runs\n---\n\nStanding question for ${name}?`,
    join(paths.watchesDir, `${name}.md`),
    null,
  );
  await writeInvocationLog({
    paths,
    watch: watch!,
    now: at,
    modelId: "claude-opus-4-8",
    autonomy: "propose",
    reasons: ["runs: new activity"],
    systemPrompt: "You are a HIVE watch",
    userContent: "# Watch digest\n\nstuff",
    output: over.output ?? null,
    error: over.error,
    outcome: over.outcome,
    durationMs: 60_019,
  });
}
