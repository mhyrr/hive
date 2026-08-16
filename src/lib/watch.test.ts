import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverWatches,
  findWatch,
  formatCadence,
  formatWatchDuration,
  isDue,
  parseCadence,
  parseWatchFile,
  renderWatchQuestion,
  rewriteWatchFrontmatter,
  watchInterval,
} from "./watch";
import {
  loadWatchState,
  recordUsage,
  saveWatchState,
  stateEntry,
  usageSince,
  watchStatePath,
  type WatchState,
} from "./watch-state";
import { ensureHiveScaffold, type HivePaths } from "./paths";

// Date-anchored fixtures: every timestamp derives from this anchor, never the
// wall clock. 2026-08-12 is a Wednesday; constructed without a Z suffix so
// local-time cadence logic (morning hour, weekday) is deterministic anywhere.
const ANCHOR = new Date("2026-08-12T10:00:00");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (d: Date) => d.toISOString();

// ---------------------------------------------------------------------------
// parseCadence / tick intervals
// ---------------------------------------------------------------------------

describe("parseCadence", () => {
  test("parses intervals", () => {
    expect(parseCadence("2h")).toEqual({ type: "interval", ms: 2 * HOUR });
    expect(parseCadence("45m")).toEqual({ type: "interval", ms: 45 * 60_000 });
    expect(parseCadence("1d")).toEqual({ type: "interval", ms: DAY });
  });

  test("parses @nightly and @morning", () => {
    expect(parseCadence("@nightly")).toEqual({ type: "nightly" });
    expect(parseCadence("@morning")).toEqual({ type: "morning" });
  });

  test("parses weekday lists, deduped and sorted", () => {
    expect(parseCadence("mon,thu")).toEqual({ type: "weekdays", days: [1, 4] });
    expect(parseCadence("thu, mon, thu")).toEqual({ type: "weekdays", days: [1, 4] });
  });

  test("rejects garbage", () => {
    expect(parseCadence("often")).toBeNull();
    expect(parseCadence("0h")).toBeNull();
    expect(parseCadence("mon,whenever")).toBeNull();
  });

  test("round-trips through formatCadence", () => {
    for (const raw of ["2h", "45m", "1d", "@nightly", "@morning", "mon,thu"]) {
      expect(formatCadence(parseCadence(raw)!)).toBe(raw);
    }
  });
});

describe("watchInterval", () => {
  test("first run uses one cadence period", () => {
    const interval = watchInterval(parseCadence("6h")!, null, ANCHOR);
    expect(interval.since.toISOString()).toBe(new Date(ANCHOR.getTime() - 6 * HOUR).toISOString());
    expect(interval.until).toEqual(ANCHOR);
  });

  test("late wake widens to the previous settled tick", () => {
    const last = new Date(ANCHOR.getTime() - 8 * HOUR);
    const interval = watchInterval(parseCadence("6h")!, last.toISOString(), ANCHOR);
    expect(interval.durationMs).toBe(8 * HOUR);
    expect(formatWatchDuration(interval.durationMs)).toBe("8 hours");
    expect(renderWatchQuestion("Activity over {{interval}}.", interval)).toBe("Activity over 8 hours.");
  });
});

// ---------------------------------------------------------------------------
// isDue
// ---------------------------------------------------------------------------

describe("isDue", () => {
  const interval = parseCadence("2h")!;

  test("interval: due on first run and after the interval", () => {
    expect(isDue(interval, null, ANCHOR)).toBe(true);
    expect(isDue(interval, iso(new Date(ANCHOR.getTime() - 3 * HOUR)), ANCHOR)).toBe(true);
  });

  test("interval: not due inside the interval", () => {
    expect(isDue(interval, iso(new Date(ANCHOR.getTime() - HOUR)), ANCHOR)).toBe(false);
  });

  test("interval: corrupt lastRun fails open (due)", () => {
    expect(isDue(interval, "not-a-date", ANCHOR)).toBe(true);
  });

  test("@nightly: never due on the tick — the orchestrator invokes it", () => {
    expect(isDue(parseCadence("@nightly")!, null, ANCHOR)).toBe(false);
  });

  test("@morning: due after the morning hour, once per day", () => {
    const morning = parseCadence("@morning")!;
    const at5am = new Date("2026-08-12T05:00:00");
    const at7am = new Date("2026-08-12T07:00:00");
    expect(isDue(morning, null, at5am)).toBe(false);
    expect(isDue(morning, null, at7am)).toBe(true);
    // Already ran at 07:00 → not due again at 10:00 the same day.
    expect(isDue(morning, iso(at7am), ANCHOR)).toBe(false);
    // Ran yesterday → due today.
    expect(isDue(morning, iso(new Date(at7am.getTime() - DAY)), ANCHOR)).toBe(true);
  });

  test("weekdays: due only on listed days, after morning hour, once per day", () => {
    const monThu = parseCadence("mon,thu")!;
    // ANCHOR is Wednesday.
    expect(isDue(monThu, null, ANCHOR)).toBe(false);
    const thursday = new Date("2026-08-13T10:00:00");
    expect(isDue(monThu, null, thursday)).toBe(true);
    expect(isDue(monThu, null, new Date("2026-08-13T05:00:00"))).toBe(false);
    expect(isDue(monThu, iso(new Date("2026-08-13T07:00:00")), thursday)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseWatchFile
// ---------------------------------------------------------------------------

const FULL_WATCH = `---
name: nightly-propose
cadence: @nightly
scope: memory, tickets
model: judgment
venue: briefing
autonomy: propose
enabled: true
---

Given the actual activity, what should we propose?
`;

describe("parseWatchFile", () => {
  test("parses a full watch file", () => {
    const { watch, warnings } = parseWatchFile(FULL_WATCH, "/w/nightly-propose.md", null);
    expect(warnings).toEqual([]);
    expect(watch).toMatchObject({
      name: "nightly-propose",
      qualifiedName: "nightly-propose",
      cadence: { type: "nightly" },
      scope: ["memory", "tickets"],
      model: "judgment",
      venue: "briefing",
      autonomy: "propose",
      enabled: true,
      project: null,
    });
    expect(watch?.question).toContain("what should we propose");
  });

  test("applies defaults: name from filename, observe, inbox, standard, all scopes", () => {
    const { watch } = parseWatchFile("---\ncadence: 2h\n---\n\nA question.", "/w/my-watch.md", "alpha");
    expect(watch).toMatchObject({
      name: "my-watch",
      qualifiedName: "alpha/my-watch",
      autonomy: "observe",
      venue: "inbox",
      model: "standard",
      project: "alpha",
    });
    expect(watch?.scope).toEqual(["tickets", "commits", "transcripts", "memory", "inbox"]);
  });

  test("legacy window is ignored with a migration warning", () => {
    const { watch, warnings } = parseWatchFile("---\ncadence: 2h\nwindow: 7d\n---\n\nQ.", "/w/x.md", null);
    expect(watch).not.toBeNull();
    expect(warnings).toEqual([expect.stringContaining("window is obsolete")]);
  });

  test("legacy dispatch venue remains readable as Act", () => {
    const { watch, warnings } = parseWatchFile(
      "---\ncadence: 6h\nvenue: dispatch\nautonomy: act\n---\n\nQ.",
      "/w/act.md",
      null,
    );
    expect(watch?.venue).toBe("act");
    expect(warnings).toEqual([expect.stringContaining('treating it as "act"')]);
  });

  test("empty body → skipped with warning", () => {
    const { watch, warnings } = parseWatchFile("---\ncadence: 2h\n---\n\n", "/w/empty.md", null);
    expect(watch).toBeNull();
    expect(warnings[0]).toContain("empty body");
  });

  test("missing or invalid cadence → skipped with warning", () => {
    expect(parseWatchFile("A question.", "/w/x.md", null).watch).toBeNull();
    const bad = parseWatchFile("---\ncadence: often\n---\n\nQ.", "/w/x.md", null);
    expect(bad.watch).toBeNull();
    expect(bad.warnings[0]).toContain("unparseable cadence");
  });

  test("unknown enum values degrade to defaults with warnings", () => {
    const { watch, warnings } = parseWatchFile(
      "---\ncadence: 2h\nmodel: opus-4-8\nautonomy: yolo\nvenue: slack\nscope: tickets, vibes\n---\n\nQ.",
      "/w/x.md",
      null,
    );
    expect(watch).toMatchObject({ model: "standard", autonomy: "observe", venue: "inbox" });
    expect(watch?.scope).toEqual(["tickets"]);
    expect(warnings.length).toBe(4);
  });

  test("enabled: false parses", () => {
    const { watch } = parseWatchFile("---\ncadence: 2h\nenabled: false\n---\n\nQ.", "/w/x.md", null);
    expect(watch?.enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// discovery + frontmatter rewrite
// ---------------------------------------------------------------------------

describe("discoverWatches", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-watch-"));
    paths = await ensureHiveScaffold(home);
  });

  test("finds cross-project and project watches; bad files become warnings", async () => {
    await writeFile(join(paths.watchesDir, "observe.md"), "---\ncadence: 3d\n---\n\nQ1.");
    const projWatches = join(paths.projectsDir, "alpha", "watches");
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "harvest.md"), "---\ncadence: @morning\n---\n\nQ2.");
    await writeFile(join(projWatches, "broken.md"), "no frontmatter, no cadence");

    const { watches, warnings } = await discoverWatches(paths);
    expect(watches.map((w) => w.qualifiedName).sort()).toEqual(["alpha/harvest", "observe"]);
    expect(watches.find((w) => w.qualifiedName === "alpha/harvest")?.project).toBe("alpha");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("cadence");
  });

  test("duplicate qualified names keep the first, warn on the rest", async () => {
    await writeFile(join(paths.watchesDir, "a.md"), "---\nname: observe\ncadence: 2h\n---\n\nQ1.");
    await writeFile(join(paths.watchesDir, "b.md"), "---\nname: observe\ncadence: 4h\n---\n\nQ2.");
    const { watches, warnings } = await discoverWatches(paths);
    expect(watches.length).toBe(1);
    expect(watches[0].question).toBe("Q1.");
    expect(warnings[0]).toContain("duplicate");
  });

  test("findWatch resolves bare names when unambiguous", async () => {
    await writeFile(join(paths.watchesDir, "observe.md"), "---\ncadence: 2h\n---\n\nQ.");
    const projWatches = join(paths.projectsDir, "alpha", "watches");
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "harvest.md"), "---\ncadence: 2h\n---\n\nQ.");

    const { watches } = await discoverWatches(paths);
    expect(findWatch(watches, "harvest")?.qualifiedName).toBe("alpha/harvest");
    expect(findWatch(watches, "alpha/harvest")?.qualifiedName).toBe("alpha/harvest");
    expect(findWatch(watches, "nope")).toBeNull();
  });

  test("rewriteWatchFrontmatter updates keys, preserves body and other keys", async () => {
    const file = join(paths.watchesDir, "observe.md");
    await writeFile(file, "---\ncadence: mon,thu\nautonomy: observe\n---\n\nThe question survives.");
    await rewriteWatchFrontmatter(file, { enabled: "false", autonomy: "propose" });
    const { watch } = parseWatchFile(await Bun.file(file).text(), file, null);
    expect(watch).toMatchObject({
      enabled: false,
      autonomy: "propose",
      cadence: { type: "weekdays", days: [1, 4] },
      question: "The question survives.",
    });
  });
});

// ---------------------------------------------------------------------------
// Shipped templates stay parseable with their designed settings
// ---------------------------------------------------------------------------

describe("shipped watch templates", () => {
  const templatesDir = join(import.meta.dir, "..", "..", "templates", "watches");

  test("propose: nightly judgment into the briefing", async () => {
    const file = join(templatesDir, "propose.md");
    const { watch, warnings } = parseWatchFile(await Bun.file(file).text(), file, null);
    expect(warnings).toEqual([]);
    expect(watch).toMatchObject({
      name: "propose",
      cadence: { type: "nightly" },
      scope: ["runs", "tickets"],
      model: "judgment",
      venue: "briefing",
      autonomy: "propose",
      enabled: true,
    });
  });

  test("observe: every 3 days, judgment, inbox, transcripts+memory", async () => {
    const file = join(templatesDir, "observe.md");
    const { watch, warnings } = parseWatchFile(await Bun.file(file).text(), file, null);
    expect(warnings).toEqual([]);
    expect(watch).toMatchObject({
      name: "observe",
      cadence: { type: "interval", ms: 3 * DAY },
      scope: ["transcripts", "memory"],
      model: "judgment",
      venue: "inbox",
      autonomy: "observe",
      enabled: true,
    });
    expect(watch?.question).toContain("NO_SIGNAL");
  });

  test("act: every 6 hours, judgment, isolated review execution", async () => {
    const file = join(templatesDir, "act.md");
    const { watch, warnings } = parseWatchFile(await Bun.file(file).text(), file, null);
    expect(warnings).toEqual([]);
    expect(watch).toMatchObject({
      name: "act",
      cadence: { type: "interval", ms: 6 * HOUR },
      scope: ["tickets", "commits", "transcripts"],
      model: "judgment",
      venue: "act",
      autonomy: "act",
      enabled: true,
    });
    expect(watch?.question).toContain("unmerged and unpushed");
  });
});

// ---------------------------------------------------------------------------
// watch-state
// ---------------------------------------------------------------------------

describe("watch-state", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-watchstate-"));
    paths = await ensureHiveScaffold(home);
  });

  test("round-trips state", async () => {
    const state: WatchState = { watches: {} };
    const entry = stateEntry(state, "observe");
    entry.lastRun = iso(ANCHOR);
    entry.lastOutcome = "no-delta";
    entry.lastDigests = { commits: "abc123" };
    await saveWatchState(paths, state);

    const loaded = await loadWatchState(paths);
    expect(loaded.watches.observe).toMatchObject({
      lastRun: iso(ANCHOR),
      lastOutcome: "no-delta",
      lastDigests: { commits: "abc123" },
    });
  });

  test("missing and corrupt state load fresh", async () => {
    expect((await loadWatchState(paths)).watches).toEqual({});
    await mkdir(paths.watchesDir, { recursive: true });
    await writeFile(watchStatePath(paths), "{not json");
    expect((await loadWatchState(paths)).watches).toEqual({});
  });

  test("usage log caps at 100 and usageSince filters by time", () => {
    const state: WatchState = { watches: {} };
    const entry = stateEntry(state, "observe");
    // Chronological append, one per hour ending at ANCHOR — matches how ticks
    // record usage. The cap should drop the OLDEST 10.
    for (let i = 0; i < 110; i++) {
      recordUsage(entry, {
        at: iso(new Date(ANCHOR.getTime() - (109 - i) * HOUR)),
        model: "claude-x",
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 100,
      });
    }
    expect(entry.usage.length).toBe(100);
    expect(entry.usage[0].at).toBe(iso(new Date(ANCHOR.getTime() - 99 * HOUR)));
    // Entries at 0h..10h ago (inclusive) fall inside a 10h-since window → 11.
    const recent = usageSince(entry, ANCHOR.getTime() - 10 * HOUR);
    expect(recent.calls).toBe(11);
    expect(recent.inputTokens).toBe(110);
    expect(recent.outputTokens).toBe(55);
  });
});
