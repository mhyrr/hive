import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assembleWatchDigest,
  evaluateWatchDelta,
  rankProjectActivity,
  type DeltaSeams,
  type SessionFileInfo,
} from "./watch-delta";
import { parseWatchFile, type WatchDef } from "./watch";
import { createTicket } from "./ticket";
import { ensureHiveScaffold, type HivePaths } from "./paths";

// Date-anchored fixtures: all timestamps derive from ANCHOR; ticket `updated`
// stamps flow through HIVE_FIXED_NOW so the real ticket layer stays in play.
const ANCHOR = new Date("2026-08-12T10:00:00");
const HOUR = 3_600_000;
const SINCE = new Date(ANCHOR.getTime() - 24 * HOUR);

function makeWatch(overrides: Partial<WatchDef>): WatchDef {
  const { watch } = parseWatchFile("---\ncadence: 2h\n---\n\nStanding question?", "/w/test.md", null);
  return { ...watch!, ...overrides };
}

function seams(args: {
  gitByRepo?: Record<string, string>;
  sessions?: SessionFileInfo[];
}): DeltaSeams {
  return {
    gitLog: (repoPath) => args.gitByRepo?.[repoPath] ?? "",
    listSessions: async () => args.sessions ?? [],
  };
}

describe("evaluateWatchDelta", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-delta-"));
    paths = await ensureHiveScaffold(home);
    for (const p of ["alpha", "beta"]) {
      await mkdir(join(paths.projectsDir, p), { recursive: true });
      await writeFile(join(paths.projectsDir, p, "config.md"), `---\npath: /fake/${p}\n---\n`);
    }
    process.env.HIVE_FIXED_NOW = new Date(ANCHOR.getTime() - HOUR).toISOString();
  });

  afterEach(() => {
    delete process.env.HIVE_FIXED_NOW;
  });

  test("first evaluation over content triggers; unchanged scope does not", async () => {
    await createTicket(paths, "alpha", { title: "Do the thing" });
    const watch = makeWatch({ scope: ["tickets"], project: "alpha" });

    const first = await evaluateWatchDelta({ paths, watch, lastDigests: {}, since: SINCE, now: ANCHOR, seams: seams({}) });
    expect(first.changed).toBe(true);
    expect(first.reasons[0]).toContain("tickets");
    expect(first.reasons[0]).toContain("alpha");

    const second = await evaluateWatchDelta({
      paths,
      watch,
      lastDigests: first.fingerprints,
      since: ANCHOR,
      now: new Date(ANCHOR.getTime() + HOUR),
      seams: seams({}),
    });
    expect(second.changed).toBe(false);
    expect(second.reasons).toEqual([]);
  });

  test("entirely empty scope never triggers, even on first run", async () => {
    const watch = makeWatch({ scope: ["tickets", "commits", "inbox"], project: "alpha" });
    const result = await evaluateWatchDelta({ paths, watch, lastDigests: {}, since: SINCE, now: ANCHOR, seams: seams({}) });
    expect(result.changed).toBe(false);
  });

  test("a legacy Pass F tombstone is an empty inbox fingerprint", async () => {
    await writeFile(
      join(paths.projectsDir, "alpha", "inbox.md"),
      "# Inbox: alpha\n\n_Truncated by Pass F at 2026-08-14T02:00:00.000Z_\n",
    );
    const watch = makeWatch({ scope: ["inbox"], project: "alpha" });

    const result = await evaluateWatchDelta({
      paths,
      watch,
      lastDigests: {},
      since: SINCE,
      now: ANCHOR,
      seams: seams({}),
    });

    expect(result.changed).toBe(false);
    expect(result.fingerprints.inbox).toBe("");
  });

  test("a new ticket re-triggers a previously settled watch", async () => {
    await createTicket(paths, "alpha", { title: "First" });
    const watch = makeWatch({ scope: ["tickets"], project: "alpha" });
    const first = await evaluateWatchDelta({ paths, watch, lastDigests: {}, since: SINCE, now: ANCHOR, seams: seams({}) });

    process.env.HIVE_FIXED_NOW = new Date(ANCHOR.getTime() + HOUR).toISOString();
    await createTicket(paths, "alpha", { title: "Second" });

    const second = await evaluateWatchDelta({
      paths,
      watch,
      lastDigests: first.fingerprints,
      since: ANCHOR,
      now: new Date(ANCHOR.getTime() + 2 * HOUR),
      seams: seams({}),
    });
    expect(second.changed).toBe(true);
  });

  test("watermark kinds: aging out never phantom-triggers; newer marks do", async () => {
    const watch = makeWatch({ scope: ["commits"], project: "alpha" });

    const withCommit = seams({ gitByRepo: { "/fake/alpha": "1755000000 abc123 feat: x" } });
    const first = await evaluateWatchDelta({ paths, watch, lastDigests: {}, since: SINCE, now: ANCHOR, seams: withCommit });
    expect(first.changed).toBe(true);

    // Commit ages out of the window → empty log. Watermark holds; no trigger.
    const agedOut = await evaluateWatchDelta({
      paths,
      watch,
      lastDigests: first.fingerprints,
      since: ANCHOR,
      now: new Date(ANCHOR.getTime() + 25 * HOUR),
      seams: seams({}),
    });
    expect(agedOut.changed).toBe(false);
    expect(agedOut.fingerprints.commits).toContain("1755000000");

    // A genuinely newer commit moves the mark → trigger.
    const newer = seams({ gitByRepo: { "/fake/alpha": "1755100000 def456 fix: y\n1755000000 abc123 feat: x" } });
    const again = await evaluateWatchDelta({
      paths,
      watch,
      lastDigests: agedOut.fingerprints,
      since: new Date(ANCHOR.getTime() + 25 * HOUR),
      now: new Date(ANCHOR.getTime() + 26 * HOUR),
      seams: newer,
    });
    expect(again.changed).toBe(true);
  });

  test("scope restriction: a commits-only watch ignores ticket churn", async () => {
    await createTicket(paths, "alpha", { title: "Noise" });
    const watch = makeWatch({ scope: ["commits"], project: "alpha" });
    const result = await evaluateWatchDelta({ paths, watch, lastDigests: {}, since: SINCE, now: ANCHOR, seams: seams({}) });
    expect(result.changed).toBe(false);
  });

  test("cross-project watch names the project that moved", async () => {
    await createTicket(paths, "beta", { title: "Beta work" });
    const watch = makeWatch({ scope: ["tickets"], project: null });
    const result = await evaluateWatchDelta({ paths, watch, lastDigests: {}, since: SINCE, now: ANCHOR, seams: seams({}) });
    expect(result.changed).toBe(true);
    expect(result.reasons[0]).toContain("beta");
    expect(result.reasons[0]).not.toContain("alpha");
  });
});

describe("rankProjectActivity", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-rank-"));
    paths = await ensureHiveScaffold(home);
    for (const p of ["alpha", "beta", "gamma"]) {
      await mkdir(join(paths.projectsDir, p), { recursive: true });
      await writeFile(join(paths.projectsDir, p, "config.md"), `---\npath: /fake/${p}\n---\n`);
    }
    process.env.HIVE_FIXED_NOW = new Date(ANCHOR.getTime() - HOUR).toISOString();
  });

  afterEach(() => {
    delete process.env.HIVE_FIXED_NOW;
  });

  test("touched projects rank above cold ones; cold scores zero", async () => {
    await createTicket(paths, "beta", { title: "Moved" });
    const ranked = await rankProjectActivity({
      paths,
      since: SINCE,
      now: ANCHOR,
      seams: seams({
        gitByRepo: { "/fake/alpha": "1755000000 abc123 feat: x\n1754990000 abc124 fix: y" },
        sessions: [{ project: "alpha", file: "/s/one.jsonl", mtimeMs: ANCHOR.getTime() - HOUR }],
      }),
    });
    expect(ranked.map((r) => r.project)).toEqual(["alpha", "beta", "gamma"]);
    expect(ranked[0]).toMatchObject({ commits: 2, sessions: 1, score: 4 });
    expect(ranked[1]).toMatchObject({ ticketsMoved: 1, score: 1 });
    expect(ranked[2].score).toBe(0);
  });
});

describe("assembleWatchDigest", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-digest-"));
    paths = await ensureHiveScaffold(home);
    for (const p of ["alpha", "gamma"]) {
      await mkdir(join(paths.projectsDir, p), { recursive: true });
      await writeFile(join(paths.projectsDir, p, "config.md"), `---\npath: /fake/${p}\n---\n`);
    }
    process.env.HIVE_FIXED_NOW = new Date(ANCHOR.getTime() - HOUR).toISOString();
  });

  afterEach(() => {
    delete process.env.HIVE_FIXED_NOW;
  });

  test("digest carries evidence with provenance; cold projects stay unexpanded", async () => {
    const ticket = await createTicket(paths, "alpha", { title: "Ship the widget" });
    const watch = makeWatch({ scope: ["tickets", "commits"], project: null });
    const digest = await assembleWatchDigest({
      paths,
      watch,
      since: SINCE,
      now: ANCHOR,
      seams: seams({ gitByRepo: { "/fake/alpha": "1755000000 abc123 feat: widget" } }),
    });

    expect(digest.empty).toBe(false);
    expect(digest.text).toContain(ticket.id);
    expect(digest.text).toContain("Ship the widget");
    expect(digest.text).toContain("abc123");
    expect(digest.text).toContain("## Project: alpha");
    // gamma is cold — named in the not-expanded line, no section of its own.
    expect(digest.text).not.toContain("## Project: gamma");
    expect(digest.provenance).toContain(`[T:alpha/${ticket.id}]`);
    expect(digest.provenance).toContain("[C:alpha/abc123]");
  });

  test("nothing in scope → empty digest", async () => {
    const watch = makeWatch({ scope: ["tickets", "commits"], project: "gamma" });
    const digest = await assembleWatchDigest({ paths, watch, since: SINCE, now: ANCHOR, seams: seams({}) });
    expect(digest.empty).toBe(true);
  });

  test("legacy Pass F tombstones stay out of the digest", async () => {
    const inboxPath = join(paths.projectsDir, "alpha", "inbox.md");
    await writeFile(
      inboxPath,
      "# Inbox: alpha\n\n_Truncated by Pass F at 2026-08-14T02:00:00.000Z_\n",
    );
    await utimes(inboxPath, ANCHOR, ANCHOR);
    const watch = makeWatch({ scope: ["inbox"], project: "alpha" });

    const digest = await assembleWatchDigest({
      paths,
      watch,
      since: SINCE,
      now: ANCHOR,
      seams: seams({}),
    });

    expect(digest.empty).toBe(true);
    expect(digest.text).not.toContain("Truncated by Pass F");
  });
});

describe("runs scope kind", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-runs-"));
    paths = await ensureHiveScaffold(home);
  });

  test("nightly artifacts trigger once, then settle until the next run", async () => {
    const watch = makeWatch({ scope: ["runs"], project: null });

    // No runs yet → no trigger.
    const before = await evaluateWatchDelta({ paths, watch, lastDigests: {}, since: SINCE, now: ANCHOR, seams: seams({}) });
    expect(before.changed).toBe(false);

    const runDir = join(paths.memoryRunsDir, "2026-08-12");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "briefing.md"), "# HIVE — 2026-08-12\n\nShipped the watcher.");
    await utimes(runDir, new Date(ANCHOR.getTime() - HOUR), new Date(ANCHOR.getTime() - HOUR));

    const first = await evaluateWatchDelta({ paths, watch, lastDigests: {}, since: SINCE, now: ANCHOR, seams: seams({}) });
    expect(first.changed).toBe(true);
    expect(first.reasons[0]).toContain("runs");

    const second = await evaluateWatchDelta({
      paths,
      watch,
      lastDigests: first.fingerprints,
      since: ANCHOR,
      now: new Date(ANCHOR.getTime() + HOUR),
      seams: seams({}),
    });
    expect(second.changed).toBe(false);
  });

  test("digest includes run artifacts with provenance", async () => {
    const runDir = join(paths.memoryRunsDir, "2026-08-12");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "briefing.md"), "# HIVE — 2026-08-12\n\nShipped the watcher.");
    await writeFile(join(runDir, "taste-decisions.md"), "Approved: prefer boring solutions.");
    await utimes(runDir, new Date(ANCHOR.getTime() - HOUR), new Date(ANCHOR.getTime() - HOUR));

    const watch = makeWatch({ scope: ["runs"], project: null });
    const digest = await assembleWatchDigest({ paths, watch, since: SINCE, now: ANCHOR, seams: seams({}) });
    expect(digest.empty).toBe(false);
    expect(digest.text).toContain("Shipped the watcher");
    expect(digest.text).toContain("prefer boring solutions");
    expect(digest.provenance).toContain("[R:2026-08-12/briefing]");
    expect(digest.provenance).toContain("[R:2026-08-12/taste]");
  });
});
