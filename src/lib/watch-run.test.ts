import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runWatches, type WatchCaller } from "./watch-run";
import { loadWatchState } from "./watch-state";
import type { DeltaSeams } from "./watch-delta";
import { createTicket, updateTicket } from "./ticket";
import { readNextSelection } from "./next";
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

  async function makeActProject(): Promise<void> {
    const repo = join(paths.home, "alpha-repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "watch@test.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Watch Test"], { cwd: repo });
    await writeFile(join(repo, "README.md"), "# Alpha\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo });
    await writeFile(join(paths.projectsDir, "alpha", "config.md"), `---\npath: ${repo}\n---\n`);
    await writeFile(paths.config, "# Hive Config\n\nwatches.max_autonomy: act\n");
  }

  test("surfaced output lands in the project inbox with citation intact", async () => {
    const ticket = await createTicket(paths, "alpha", { title: "Ship it" });
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(
      join(projWatches, "ready.md"),
      "---\ncadence: 2h\nscope: tickets\nvenue: inbox\nautonomy: propose\n---\n\nWhich tickets are ready?",
    );

    const { caller, calls } = stubCaller(`[T:alpha/${ticket.id}] looks ready — first step: start it.`);
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
    const first = stubCaller("[T:alpha/TK-001] noted.");
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

    const { caller, calls } = stubCaller("[T:alpha/TK-001] noted.");
    const { reports } = await runWatches({ paths, mode: "due", now: ANCHOR, caller, seams: NO_SESSIONS });

    expect(reports[0]?.effectiveAutonomy).toBe("observe");
    expect(calls[0]?.systemPrompt).toContain("OBSERVE");
    expect(calls[0]?.systemPrompt).not.toContain("PROPOSE");
  });

  test("without config, autonomy act clamps to the default (propose)", async () => {
    await createTicket(paths, "alpha", { title: "Ship it" });
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "eager.md"), "---\ncadence: 2h\nscope: tickets\nautonomy: act\n---\n\nQ?");

    const { caller, calls } = stubCaller("[T:alpha/TK-001] noted.");
    const { reports } = await runWatches({ paths, mode: "due", now: ANCHOR, caller, seams: NO_SESSIONS });
    expect(reports[0]?.effectiveAutonomy).toBe("propose");
    expect(calls[0]?.systemPrompt).toContain("PROPOSE");
  });

  test("act starts exactly one eligible qualified ticket for review", async () => {
    await makeActProject();
    const ticket = await createTicket(paths, "alpha", {
      title: "Add the follow-on",
      body: "Implement the already-decided follow-on and cover it with tests.",
    });
    await writeWatch("act", "cadence: 6h\nscope: tickets\nvenue: act\nmodel: judgment\nautonomy: act");

    const call = stubCaller(`[A:alpha/${ticket.id}] Clear follow-on.\nACT alpha/${ticket.id}`);
    const started: string[] = [];
    const result = await runWatches({
      paths,
      mode: "due",
      now: ANCHOR,
      caller: call.caller,
      seams: NO_SESSIONS,
      actRunner: async (input) => {
        started.push(`${input.project}/${input.ticketId}`);
        return { runId: "RUN-042", detail: "review branch" };
      },
    });

    expect(started).toEqual([`alpha/${ticket.id}`]);
    expect(result.reports[0]).toMatchObject({ outcome: "surfaced", detail: "RUN-042 started for human review" });
    expect(call.calls[0]?.userContent).toContain(`[A:alpha/${ticket.id}]`);
    expect((await loadWatchState(paths)).watches.act?.lastRun).toBe("2026-08-12T10:00:00Z");
    expect(await readNextSelection(paths)).toMatchObject({
      disposition: "started",
      projectId: "alpha",
      ticketId: ticket.id,
      runId: "RUN-042",
    });
  });

  test("a clamped Act watch replaces the one next recommendation", async () => {
    await makeActProject();
    await writeFile(paths.config, "# Hive Config\n\nwatches.max_autonomy: propose\n");
    const first = await createTicket(paths, "alpha", {
      title: "First follow-on",
      body: "Implement the first complete follow-on.",
    });
    const second = await createTicket(paths, "alpha", {
      title: "Second follow-on",
      body: "Implement the second complete follow-on.",
    });
    await writeWatch("act", "cadence: 6h\nscope: tickets\nvenue: act\nautonomy: act");

    const one = stubCaller(`[A:alpha/${first.id}] Compounds the current work.\nACT alpha/${first.id}`);
    await runWatches({ paths, mode: "named", names: ["act"], now: ANCHOR, caller: one.caller, seams: NO_SESSIONS });
    expect(await readNextSelection(paths)).toMatchObject({
      disposition: "recommended",
      ticketId: first.id,
      rationale: "Compounds the current work.",
    });

    process.env.HIVE_FIXED_NOW = new Date(ANCHOR.getTime() + 30 * 60_000).toISOString();
    await updateTicket(paths, "alpha", second.id, { title: second.title });
    const two = stubCaller(`[A:alpha/${second.id}] Removes the next bottleneck.\nACT alpha/${second.id}`);
    const secondResult = await runWatches({
      paths,
      mode: "named",
      names: ["act"],
      now: new Date(ANCHOR.getTime() + HOUR),
      caller: two.caller,
      seams: NO_SESSIONS,
    });
    expect(secondResult.reports[0]).toMatchObject({ outcome: "surfaced" });
    expect(await readNextSelection(paths)).toMatchObject({
      disposition: "recommended",
      ticketId: second.id,
      rationale: "Removes the next bottleneck.",
    });
    expect(existsSync(join(paths.home, "inbox.md"))).toBe(false);
  });

  test("act rejects multiple selections and does not start work", async () => {
    await makeActProject();
    const one = await createTicket(paths, "alpha", { title: "One", body: "Complete specification one." });
    const two = await createTicket(paths, "alpha", { title: "Two", body: "Complete specification two." });
    await writeWatch("act", "cadence: 6h\nscope: tickets\nvenue: act\nautonomy: act");
    let starts = 0;
    const caller = stubCaller(`[A:alpha/${one.id}]\nACT alpha/${one.id}\n[A:alpha/${two.id}]\nACT alpha/${two.id}`);

    const result = await runWatches({
      paths, mode: "due", now: ANCHOR, caller: caller.caller, seams: NO_SESSIONS,
      actRunner: async () => { starts++; return { runId: "RUN-999", detail: "no" }; },
    });

    expect(starts).toBe(0);
    expect(result.reports[0]).toMatchObject({ outcome: "quiet", detail: expect.stringContaining("exactly one") });
  });

  test("act makes no model call when deterministic eligibility finds no ticket", async () => {
    await makeActProject();
    await createTicket(paths, "alpha", { title: "Needs Greg", body: "Choose the product direction.", tags: ["needs-greg"] });
    await writeWatch("act", "cadence: 6h\nscope: tickets\nvenue: act\nautonomy: act");

    const result = await runWatches({ paths, mode: "due", now: ANCHOR, caller: throwingCaller, seams: NO_SESSIONS });

    expect(result.reports[0]).toMatchObject({ outcome: "no-delta", detail: "no eligible Act ticket" });
  });

  test("act execution failure leaves the interval unsettled", async () => {
    await makeActProject();
    const ticket = await createTicket(paths, "alpha", { title: "One", body: "Complete specification." });
    await writeWatch("act", "cadence: 6h\nscope: tickets\nvenue: act\nautonomy: act");
    const caller = stubCaller(`[A:alpha/${ticket.id}]\nACT alpha/${ticket.id}`);

    const result = await runWatches({
      paths, mode: "due", now: ANCHOR, caller: caller.caller, seams: NO_SESSIONS,
      actRunner: async () => { throw new Error("claim raced"); },
    });

    expect(result.reports[0]).toMatchObject({ outcome: "error", error: "claim raced" });
    expect((await loadWatchState(paths)).watches.act?.lastRun).toBeNull();
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

    const { caller } = stubCaller("[T:alpha/TK-001] noted.");
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
      return "[T:alpha/TK-001] noted.";
    });
    const { reports } = await runWatches({ paths, mode: "due", now: ANCHOR, caller, seams: NO_SESSIONS });

    expect(reports.find((r) => r.watch === "alpha/a-bad")?.outcome).toBe("error");
    expect(reports.find((r) => r.watch === "alpha/b-good")?.outcome).toBe("surfaced");
  });

  test("briefing venue writes runs/{DATE}/<name>.md; nightly mode selects @nightly watches", async () => {
    await createTicket(paths, "alpha", { title: "Ship it" });
    await writeWatch("propose", "cadence: @nightly\nscope: tickets\nvenue: briefing\nmodel: judgment\nautonomy: propose", "What should we propose over {{interval}}?");

    // The hourly tick never runs @nightly watches.
    const tick = await runWatches({ paths, mode: "due", now: ANCHOR, caller: throwingCaller, seams: NO_SESSIONS });
    expect(tick.reports.find((r) => r.watch === "propose")).toBeUndefined();

    const { caller, calls } = stubCaller("Proposal: [T:alpha/TK-001] — first step: ship it.");
    const { reports } = await runWatches({
      paths,
      mode: "nightly",
      now: ANCHOR,
      date: "2026-08-12",
      caller,
      seams: NO_SESSIONS,
    });
    expect(reports[0]?.outcome).toBe("surfaced");
    const artifact = join(paths.memoryRunsDir, "2026-08-12", "propose.md");
    expect(existsSync(artifact)).toBe(true);
    expect(await Bun.file(artifact).text()).toContain("TK-001");
    expect(calls[0]?.modelId).toBeTruthy();
    expect(calls[0]?.userContent).toContain("24 hours");
  });

  test("a legacy cross-project inbox venue falls forward to a dated briefing artifact", async () => {
    const ticket = await createTicket(paths, "alpha", { title: "Ship it" });
    await writeWatch("observe", "cadence: 2h\nscope: tickets\nvenue: inbox\nautonomy: observe", "What threads?");

    const { caller } = stubCaller(`Thread detected around [T:alpha/${ticket.id}].`);
    const { reports } = await runWatches({ paths, mode: "due", now: ANCHOR, caller, seams: NO_SESSIONS });

    expect(reports.find((r) => r.watch === "observe")?.outcome).toBe("surfaced");
    const globalInbox = join(paths.home, "inbox.md");
    expect(existsSync(globalInbox)).toBe(false);
    const artifact = join(paths.memoryRunsDir, "2026-08-12", "observe.md");
    expect(existsSync(artifact)).toBe(true);
    const content = await Bun.file(artifact).text();
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

    const { caller } = stubCaller(`[T:alpha/${ticket.id}] noted.`);
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

    const first = stubCaller("[T:alpha/TK-001] noted.");
    await runWatches({ paths, mode: "due", now: ANCHOR, caller: first.caller, seams: NO_SESSIONS });

    // Settled and not due — but the operator asked by name, so it runs.
    const forced = stubCaller("NO_SIGNAL");
    const { reports } = await runWatches({
      paths,
      mode: "named",
      names: ["alpha/ready"],
      now: new Date(ANCHOR.getTime() + 10 * 60_000),
      caller: forced.caller,
      seams: NO_SESSIONS,
    });
    expect(forced.calls.length).toBe(1);
    expect(reports[0]?.outcome).toBe("quiet");
  });
});
