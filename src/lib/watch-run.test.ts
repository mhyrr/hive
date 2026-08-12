import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWatches, type WatchCaller } from "./watch-run";
import { loadWatchState } from "./watch-state";
import type { DeltaSeams } from "./watch-delta";
import { createTicket } from "./ticket";
import { ensureHiveScaffold, getProjectPaths, type HivePaths } from "./paths";
import type { ClaudeTextCompletion } from "./claude";

const ANCHOR = new Date("2026-08-12T10:00:00");
const HOUR = 3_600_000;

const NO_SESSIONS: DeltaSeams = { gitLog: () => "", listSessions: async () => [] };

interface RecordedCall {
  modelId: string;
  systemPrompt: string;
  userContent: string;
}

function stubCaller(reply: string | ((input: RecordedCall) => string)): {
  caller: WatchCaller;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const caller: WatchCaller = async (input) => {
    calls.push(input);
    const text = typeof reply === "function" ? reply(input) : reply;
    return {
      provider: "anthropic",
      model: input.modelId,
      text,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      durationMs: 50,
    } satisfies ClaudeTextCompletion;
  };
  return { caller, calls };
}

const throwingCaller: WatchCaller = async () => {
  throw new Error("model call attempted — the delta gate should have prevented this");
};

describe("runWatches", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-watchrun-"));
    paths = await ensureHiveScaffold(home);
    await mkdir(join(paths.projectsDir, "alpha"), { recursive: true });
    await writeFile(join(paths.projectsDir, "alpha", "config.md"), "---\npath: /fake/alpha\n---\n");
    process.env.HIVE_FIXED_NOW = new Date(ANCHOR.getTime() - HOUR).toISOString();
  });

  afterEach(() => {
    delete process.env.HIVE_FIXED_NOW;
  });

  async function writeWatch(name: string, frontmatter: string, question = "What changed?"): Promise<void> {
    await writeFile(join(paths.watchesDir, `${name}.md`), `---\n${frontmatter}\n---\n\n${question}`);
  }

  test("surfaced output lands in the project inbox with citation intact", async () => {
    const ticket = await createTicket(paths, "alpha", { title: "Ship it" });
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(
      join(projWatches, "ready.md"),
      "---\ncadence: 2h\nscope: tickets\nvenue: inbox\nautonomy: propose\n---\n\nWhich tickets are ready?",
    );

    const { caller, calls } = stubCaller(`${ticket.id} looks ready — first step: dispatch it.`);
    const { reports } = await runWatches({ paths, mode: "due", now: ANCHOR, caller, seams: NO_SESSIONS });

    const report = reports.find((r) => r.watch === "alpha/ready");
    expect(report?.outcome).toBe("surfaced");
    expect(calls.length).toBeGreaterThan(0);
    const inbox = await Bun.file(getProjectPaths(paths, "alpha").inbox).text();
    expect(inbox).toContain("watch:alpha/ready");
    expect(inbox).toContain(ticket.id);
  });

  test("delta gate: unchanged scope → zero model spawns", async () => {
    await createTicket(paths, "alpha", { title: "Ship it" });
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "ready.md"), "---\ncadence: 2h\nscope: tickets\n---\n\nQ?");

    // First run settles the fingerprints.
    const first = stubCaller("TK-001 noted.");
    await runWatches({ paths, mode: "due", now: ANCHOR, caller: first.caller, seams: NO_SESSIONS });

    // Second run, due again, nothing changed: the caller MUST NOT run.
    const { reports } = await runWatches({
      paths,
      mode: "due",
      now: new Date(ANCHOR.getTime() + 3 * HOUR),
      caller: throwingCaller,
      seams: NO_SESSIONS,
    });
    expect(reports.find((r) => r.watch === "alpha/ready")?.outcome).toBe("no-delta");
  });

  test("quiet discipline: no-op ticks write nothing to the inbox", async () => {
    const ticket = await createTicket(paths, "alpha", { title: "Ship it" });
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "quiet.md"), "---\ncadence: 2h\nscope: tickets\n---\n\nQ?");
    const inboxPath = getProjectPaths(paths, "alpha").inbox;

    // Model chooses silence → no inbox file appears.
    const silent = stubCaller("NO_SIGNAL");
    const run1 = await runWatches({ paths, mode: "due", now: ANCHOR, caller: silent.caller, seams: NO_SESSIONS });
    expect(run1.reports[0]?.outcome).toBe("quiet");
    expect(run1.reports[0]?.watch).toBe("alpha/quiet");
    expect(existsSync(inboxPath)).toBe(false);
    // The prompt told it silence was valid.
    expect(silent.calls[0]?.systemPrompt).toContain("NO_SIGNAL");

    // No-delta tick → still no inbox file.
    const run2 = await runWatches({
      paths,
      mode: "due",
      now: new Date(ANCHOR.getTime() + 3 * HOUR),
      caller: throwingCaller,
      seams: NO_SESSIONS,
    });
    expect(run2.reports[0]?.outcome).toBe("no-delta");
    expect(existsSync(inboxPath)).toBe(false);

    // Output with no citation → dropped, not surfaced.
    process.env.HIVE_FIXED_NOW = new Date(ANCHOR.getTime() + 4 * HOUR).toISOString();
    await createTicket(paths, "alpha", { title: "More work" });
    const uncited = stubCaller("Something feels off about the project lately.");
    const run3 = await runWatches({
      paths,
      mode: "due",
      now: new Date(ANCHOR.getTime() + 5 * HOUR),
      caller: uncited.caller,
      seams: NO_SESSIONS,
    });
    expect(run3.reports[0]?.outcome).toBe("quiet");
    expect(run3.reports[0]?.detail).toContain("no evidence anchor");
    expect(existsSync(inboxPath)).toBe(false);
    expect(ticket.id).toBe("TK-001"); // fixture sanity
  });

  test("global autonomy ceiling clamps every watch", async () => {
    await createTicket(paths, "alpha", { title: "Ship it" });
    await writeFile(paths.config, "# Hive Config\n\nwatches.max_autonomy: observe\n");
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "eager.md"), "---\ncadence: 2h\nscope: tickets\nautonomy: act\n---\n\nQ?");

    const { caller, calls } = stubCaller("TK-001 noted.");
    const { reports } = await runWatches({ paths, mode: "due", now: ANCHOR, caller, seams: NO_SESSIONS });

    expect(reports[0]?.effectiveAutonomy).toBe("observe");
    expect(calls[0]?.systemPrompt).toContain("OBSERVE");
    expect(calls[0]?.systemPrompt).not.toContain("PROPOSE");
  });

  test("without config, autonomy act clamps to the shipping default (propose)", async () => {
    await createTicket(paths, "alpha", { title: "Ship it" });
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "eager.md"), "---\ncadence: 2h\nscope: tickets\nautonomy: act\n---\n\nQ?");

    const { caller, calls } = stubCaller("TK-001 noted.");
    const { reports } = await runWatches({ paths, mode: "due", now: ANCHOR, caller, seams: NO_SESSIONS });
    expect(reports[0]?.effectiveAutonomy).toBe("propose");
    expect(calls[0]?.systemPrompt).toContain("PROPOSE");
  });

  test("rate-limit → deferred:quota, and the same delta re-fires next tick", async () => {
    await createTicket(paths, "alpha", { title: "Ship it" });
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "ready.md"), "---\ncadence: 2h\nscope: tickets\n---\n\nQ?");

    const limited: WatchCaller = async () => {
      throw new Error("API error 429: rate limited");
    };
    const run1 = await runWatches({ paths, mode: "due", now: ANCHOR, caller: limited, seams: NO_SESSIONS });
    expect(run1.reports[0]?.outcome).toBe("deferred:quota");

    // State never settled — the next tick retries and succeeds.
    const state = await loadWatchState(paths);
    expect(state.watches["alpha/ready"]?.lastRun).toBeNull();

    const { caller } = stubCaller("TK-001 noted.");
    const run2 = await runWatches({
      paths,
      mode: "due",
      now: new Date(ANCHOR.getTime() + HOUR),
      caller,
      seams: NO_SESSIONS,
    });
    expect(run2.reports[0]?.outcome).toBe("surfaced");
  });

  test("per-watch failure isolation: one throwing watch doesn't kill the tick", async () => {
    await createTicket(paths, "alpha", { title: "Ship it" });
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "a-bad.md"), "---\ncadence: 2h\nscope: tickets\n---\n\nBad?");
    await writeFile(join(projWatches, "b-good.md"), "---\ncadence: 2h\nscope: tickets\n---\n\nGood?");

    const { caller } = stubCaller((input) => {
      if (input.userContent.includes("Bad?")) throw new Error("kaboom");
      return "TK-001 noted.";
    });
    const { reports } = await runWatches({ paths, mode: "due", now: ANCHOR, caller, seams: NO_SESSIONS });

    expect(reports.find((r) => r.watch === "alpha/a-bad")?.outcome).toBe("error");
    expect(reports.find((r) => r.watch === "alpha/b-good")?.outcome).toBe("surfaced");
  });

  test("briefing venue writes runs/{DATE}/<name>.md; nightly mode selects @nightly watches", async () => {
    await createTicket(paths, "alpha", { title: "Ship it" });
    await writeWatch("bets", "cadence: @nightly\nscope: tickets\nvenue: briefing\nmodel: judgment\nautonomy: propose", "What bets?");

    // The hourly tick never runs @nightly watches.
    const tick = await runWatches({ paths, mode: "due", now: ANCHOR, caller: throwingCaller, seams: NO_SESSIONS });
    expect(tick.reports.find((r) => r.watch === "bets")).toBeUndefined();

    const { caller, calls } = stubCaller("Bet: TK-001 — first step: ship it.");
    const { reports } = await runWatches({
      paths,
      mode: "nightly",
      now: ANCHOR,
      date: "2026-08-12",
      caller,
      seams: NO_SESSIONS,
    });
    expect(reports[0]?.outcome).toBe("surfaced");
    const artifact = join(paths.memoryRunsDir, "2026-08-12", "bets.md");
    expect(existsSync(artifact)).toBe(true);
    expect(await Bun.file(artifact).text()).toContain("TK-001");
    expect(calls[0]?.modelId).toBeTruthy();
  });

  test("cross-project inbox venue writes the global ~/.hive/inbox.md", async () => {
    const ticket = await createTicket(paths, "alpha", { title: "Ship it" });
    await writeWatch("muse", "cadence: 2h\nscope: tickets\nvenue: inbox\nautonomy: observe", "What threads?");

    const { caller } = stubCaller(`Thread detected around ${ticket.id}.`);
    const { reports } = await runWatches({ paths, mode: "due", now: ANCHOR, caller, seams: NO_SESSIONS });

    expect(reports.find((r) => r.watch === "muse")?.outcome).toBe("surfaced");
    const globalInbox = join(paths.home, "inbox.md");
    expect(existsSync(globalInbox)).toBe(true);
    const content = await Bun.file(globalInbox).text();
    expect(content).toContain("watch:muse");
    expect(content).toContain(ticket.id);
    // The project inbox stays untouched — this is a cross-project surface.
    expect(existsSync(getProjectPaths(paths, "alpha").inbox)).toBe(false);
  });

  test("disabled watches are skipped by the tick", async () => {
    await createTicket(paths, "alpha", { title: "Ship it" });
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "off.md"), "---\ncadence: 2h\nscope: tickets\nenabled: false\n---\n\nQ?");

    const { reports } = await runWatches({ paths, mode: "due", now: ANCHOR, caller: throwingCaller, seams: NO_SESSIONS });
    expect(reports.find((r) => r.watch === "alpha/off")).toBeUndefined();
  });

  test("every model invocation logs its exact prompts to watches/log/", async () => {
    const ticket = await createTicket(paths, "alpha", { title: "Ship it" });
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "ready.md"), "---\ncadence: 2h\nscope: tickets\n---\n\nWhich are ready?");

    const { caller } = stubCaller(`${ticket.id} noted.`);
    await runWatches({ paths, mode: "due", now: ANCHOR, caller, seams: NO_SESSIONS });

    const logDir = join(paths.watchesDir, "log", ANCHOR.toISOString().slice(0, 10));
    const files = (await import("node:fs/promises")).readdir(logDir);
    const names = await files;
    expect(names.length).toBe(1);
    expect(names[0]).toContain("alpha--ready");
    const content = await Bun.file(join(logDir, names[0]!)).text();
    // The complete audit trail: prompts in, output out, outcome on top.
    expect(content).toContain("## System prompt");
    expect(content).toContain("You are a HIVE watch");
    expect(content).toContain("## User content (digest + standing question)");
    expect(content).toContain("Which are ready?");
    expect(content).toContain(ticket.id);
    expect(content).toContain("## Output");
    expect(content).toContain("outcome: surfaced");

    // A no-delta tick makes no call and logs nothing new.
    await runWatches({
      paths,
      mode: "due",
      now: new Date(ANCHOR.getTime() + 3 * HOUR),
      caller: throwingCaller,
      seams: NO_SESSIONS,
    });
    expect((await (await import("node:fs/promises")).readdir(logDir)).length).toBe(1);
  });

  test("README.md in a watches dir is never parsed as a watch", async () => {
    await writeFile(join(paths.watchesDir, "README.md"), "# Docs, not a watch\n\nNo cadence here.");
    const { reports, warnings } = await runWatches({ paths, mode: "due", now: ANCHOR, caller: throwingCaller, seams: NO_SESSIONS });
    expect(reports).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("named mode bypasses due-ness and the delta gate", async () => {
    await createTicket(paths, "alpha", { title: "Ship it" });
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "ready.md"), "---\ncadence: 2h\nscope: tickets\n---\n\nQ?");

    const first = stubCaller("TK-001 noted.");
    await runWatches({ paths, mode: "due", now: ANCHOR, caller: first.caller, seams: NO_SESSIONS });

    // Settled and not due — but the operator asked by name, so it runs.
    const forced = stubCaller("TK-001 again.");
    const { reports } = await runWatches({
      paths,
      mode: "named",
      names: ["alpha/ready"],
      now: new Date(ANCHOR.getTime() + 10 * 60_000),
      caller: forced.caller,
      seams: NO_SESSIONS,
    });
    expect(forced.calls.length).toBe(1);
    expect(reports[0]?.outcome).toBe("surfaced");
  });
});
