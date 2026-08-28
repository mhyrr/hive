import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyDecisions, parseCandidateId } from "../lib/apply";
import {
  appendCandidate,
  appendProjectMemory,
  entryHash,
  mergeTagsIntoEntry,
  readProjectMemorySnapshot,
  supersedeEntryByHash,
} from "../lib/memory";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { inboxBodyHash } from "../lib/inbox";

// ---------------------------------------------------------------------------
// parseCandidateId
// ---------------------------------------------------------------------------

describe("parseCandidateId", () => {
  test("parses B candidate id", () => {
    const r = parseCandidateId("B.alpha[3]");
    expect(r).toEqual({ kind: "B", project: "alpha", index: 3 });
  });

  test("parses C candidate id", () => {
    expect(parseCandidateId("C[2]")).toEqual({ kind: "C", index: 2 });
  });

  test("parses mid-session candidates id", () => {
    const r = parseCandidateId("candidates.alpha[0]");
    expect(r).toEqual({ kind: "candidates", project: "alpha", index: 0 });
  });

  test("project ids may contain hyphens and digits", () => {
    expect(parseCandidateId("B.proj-2[5]")).toEqual({
      kind: "B",
      project: "proj-2",
      index: 5,
    });
  });

  test("returns null on garbage input", () => {
    expect(parseCandidateId("nope")).toBeNull();
    expect(parseCandidateId("B[3]")).toBeNull(); // no project
  });
});

// ---------------------------------------------------------------------------
// supersedeEntryByHash + mergeTagsIntoEntry primitives
// ---------------------------------------------------------------------------

describe("supersedeEntryByHash", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-supersede-"));
    paths = await ensureHiveScaffold(home);
  });

  test("marks the matching entry superseded and appends new", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "Use Guardian for JWT", ["auth"]);
    const oldHash = entryHash("Use Guardian for JWT");

    const r = await supersedeEntryByHash(
      paths,
      "alpha",
      "fact",
      oldHash,
      "Use Joken for JWT",
      ["auth", "jwt"],
    );
    expect(r.supersededText).toBe("Use Guardian for JWT");
    expect(r.newHash).toBe(entryHash("Use Joken for JWT"));

    const snap = await readProjectMemorySnapshot(paths, "alpha");
    const old = snap.facts.find((f) => f.text === "Use Guardian for JWT");
    const fresh = snap.facts.find((f) => f.text === "Use Joken for JWT");
    expect(old?.superseded).toBe(true);
    expect(fresh?.superseded).toBeFalsy();
    expect(fresh?.tags).toEqual(["auth", "jwt"]);
  });

  test("throws when hash doesn't match any active entry", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "an entry");
    await expect(
      supersedeEntryByHash(paths, "alpha", "fact", "deadbeef", "new entry"),
    ).rejects.toThrow(/No active fact entry/);
  });

  test("preserves decision timestamp when superseding", async () => {
    await appendProjectMemory(paths, "alpha", "decision", "Pick Bun");
    const hash = entryHash("Pick Bun");
    await supersedeEntryByHash(paths, "alpha", "decision", hash, "Stay on Bun");
    const snap = await readProjectMemorySnapshot(paths, "alpha");
    const old = snap.decisions.find((d) => d.text === "Pick Bun");
    expect(old?.superseded).toBe(true);
    expect(old?.ts).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("mergeTagsIntoEntry", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-merge-"));
    paths = await ensureHiveScaffold(home);
  });

  test("adds new tags, leaves existing alone", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "an entry", ["existing"]);
    const hash = entryHash("an entry");
    const r = await mergeTagsIntoEntry(paths, "alpha", "fact", hash, ["new", "EXISTING", "another"]);
    expect(r.addedTags.sort()).toEqual(["another", "new"]);
    expect(r.mergedTags.includes("existing")).toBe(true);

    const snap = await readProjectMemorySnapshot(paths, "alpha");
    const entry = snap.facts.find((f) => f.text === "an entry");
    expect(entry?.tags.sort()).toEqual(["another", "existing", "new"]);
  });

  test("no-op when all tags already present", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "x", ["a", "b"]);
    const hash = entryHash("x");
    const r = await mergeTagsIntoEntry(paths, "alpha", "fact", hash, ["a", "b"]);
    expect(r.addedTags).toEqual([]);
  });

  test("throws on missing target", async () => {
    await expect(
      mergeTagsIntoEntry(paths, "alpha", "fact", "deadbeef", ["x"]),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// applyDecisions end-to-end
// ---------------------------------------------------------------------------

interface FixtureContext {
  paths: HivePaths;
  date: string;
  runDir: string;
}

async function buildApplyFixture(): Promise<FixtureContext> {
  const home = await mkdtemp(join(tmpdir(), "hive-apply-"));
  const paths = await ensureHiveScaffold(home);
  const date = new Date().toISOString().slice(0, 10);
  const runDir = join(paths.memoryRunsDir, date);
  await mkdir(runDir, { recursive: true });

  // Register two projects
  for (const projectId of ["alpha", "bravo"]) {
    await mkdir(join(home, "projects", projectId), { recursive: true });
    await writeFile(
      join(home, "projects", projectId, "config.md"),
      `---\nname: ${projectId}\npath: /tmp/nope/${projectId}\n---\n`,
    );
    // Pre-existing inbox so we can verify truncation
    await writeFile(
      join(home, "projects", projectId, "inbox.md"),
      `# Inbox: ${projectId}\n\n- earlier finding\n`,
    );
  }

  // Seed canon — alpha has an entry that'll be superseded; bravo has one to merge tags into
  await appendProjectMemory(paths, "alpha", "fact", "Use Guardian for JWT", ["auth"]);
  await appendProjectMemory(paths, "bravo", "convention", "Stage by name", []);

  // Mid-session candidate on alpha (will be accepted)
  await appendCandidate(paths, "alpha", {
    type: "fact",
    content: "Mid-session learned thing",
    tags: ["mid"],
  });

  // Pass B candidates — alpha + bravo
  await Bun.write(
    join(runDir, "candidates.B.alpha.json"),
    JSON.stringify({
      pass: "B",
      project: "alpha",
      candidates: [
        {
          type: "fact",
          content: "Use Joken for JWT",
          tags: ["auth", "jwt"],
          provenance: "topRanked[0]",
        },
        {
          type: "fact",
          content: "Spurious noisy fact that should reject",
          tags: [],
          provenance: "topRanked[1]",
        },
      ],
    }),
  );
  await Bun.write(
    join(runDir, "candidates.B.bravo.json"),
    JSON.stringify({
      pass: "B",
      project: "bravo",
      candidates: [
        {
          type: "convention",
          content: "Stage by name",
          tags: ["git", "hygiene"],
          provenance: "topRanked[0]",
        },
      ],
    }),
  );

  // Pass C — one accepted reflection
  await Bun.write(
    join(runDir, "candidates.C.json"),
    JSON.stringify({
      pass: "C",
      candidates: [
        {
          subject: "greg",
          content: "Greg pushes back early",
          tags: ["feedback"],
          provenance: "alpha:topRanked[2]",
        },
      ],
    }),
  );

  // Verifier output (full structured) — gaps target a known project + identity
  const guardianHash = entryHash("Use Guardian for JWT");
  const stageByNameHash = entryHash("Stage by name");
  await Bun.write(
    join(runDir, "verifier-output.json"),
    JSON.stringify({
      decisions: [],
      gaps: [
        {
          subject: "alpha",
          observation: "Sonnet missed that the team agreed on weekly retros.",
          source: "topRanked[5]",
        },
        {
          subject: "system",
          observation: "Heartbeat tick took >2× normal duration.",
          source: "alpha:inbox.md",
        },
      ],
      briefing_markdown: "# HIVE\n",
    }),
  );

  // decisions.json — accept Mid-session, supersede Guardian→Joken, merge tags into bravo's
  // existing convention, reject the noisy fact, accept the reflection.
  await Bun.write(
    join(runDir, "decisions.json"),
    JSON.stringify({
      decisions: [
        { candidate_id: "candidates.alpha[0]", action: "accept" },
        {
          candidate_id: "B.alpha[0]",
          action: "supersede",
          target_hash: guardianHash,
        },
        {
          candidate_id: "B.alpha[1]",
          action: "reject",
          reason: "low_signal",
        },
        {
          candidate_id: "B.bravo[0]",
          action: "merge",
          target_hash: stageByNameHash,
          added_tags: ["git", "hygiene"],
        },
        { candidate_id: "C[0]", action: "accept" },
      ],
    }),
  );

  // Briefing artifact for landing
  await writeFile(join(runDir, "briefing.md"), `# HIVE — ${date}\n\n## Headline\nQuiet day.\n`);
  await Bun.write(join(runDir, "inboxes.json"), JSON.stringify({
    version: 1,
    inboxes: ["alpha", "bravo"].map((projectId) => ({
      projectId,
      bodyHash: inboxBodyHash("- earlier finding"),
    })),
  }));

  return { paths, date, runDir };
}

describe("applyDecisions — end to end", () => {
  test("walks decisions, mutates canon, drains, lands briefing + reflections", async () => {
    const { paths, date } = await buildApplyFixture();
    const result = await applyDecisions({ paths, date });

    // Totals — accepted counts only project-canon entries; reflections + gaps
    // are reported in their own buckets (matches the briefing footer schema).
    expect(result.totals.accepted).toBe(1); // just mid-session
    expect(result.totals.superseded).toBe(1);
    expect(result.totals.merged).toBe(1);
    expect(result.totals.rejected).toBe(1);
    expect(result.totals.reflectionsLanded).toBe(1); // C accept only — gaps never become reflections
    expect(result.totals.gapsBriefed).toBe(2); // alpha + system gaps → briefing only, never canon

    // Per-project outcomes
    const alpha = result.perProject.find((p) => p.projectId === "alpha")!;
    expect(alpha.accepted).toBe(1);
    expect(alpha.superseded).toBe(1);
    expect(alpha.drainedCandidates).toBe(1);
    expect(alpha.inboxTruncated).toBe(true);
    expect(alpha.rebuiltIndex).toBe(true);

    const bravo = result.perProject.find((p) => p.projectId === "bravo")!;
    expect(bravo.merged).toBe(1);
    expect(bravo.rebuiltIndex).toBe(true);
    expect(bravo.inboxTruncated).toBe(true);

    // Canon mutations
    const alphaSnap = await readProjectMemorySnapshot(paths, "alpha");
    const guardian = alphaSnap.facts.find((f) => f.text === "Use Guardian for JWT");
    const joken = alphaSnap.facts.find((f) => f.text === "Use Joken for JWT");
    const mid = alphaSnap.facts.find((f) => f.text === "Mid-session learned thing");
    expect(guardian?.superseded).toBe(true);
    expect(joken?.superseded).toBeFalsy();
    expect(mid?.superseded).toBeFalsy();
    // A project gap never enters canon — it lives in the briefing and gaps.md.
    const q = alphaSnap.questions.find((qq) => qq.text.includes("weekly retros"));
    expect(q).toBeUndefined();

    const bravoSnap = await readProjectMemorySnapshot(paths, "bravo");
    const stageByName = bravoSnap.conventions.find((c) => c.text === "Stage by name");
    expect(stageByName?.tags.sort()).toEqual(["git", "hygiene"]);

    // Briefing landed
    expect(result.briefingPath).toBeTruthy();
    const briefing = await Bun.file(result.briefingPath!).text();
    expect(briefing).toContain("# HIVE");

    // Reflection file written
    expect(result.reflectionFile).toBeTruthy();
    const reflection = await Bun.file(result.reflectionFile!).text();
    expect(reflection).toContain("## About Greg");
    expect(reflection).toContain("Greg pushes back early");
    // The system-subject verifier gap stays in the briefing — never a reflection.
    expect(reflection).not.toContain("Heartbeat tick");

    // Inbox truncated to the canonical header-only empty file.
    const alphaInbox = await Bun.file(join(paths.projectsDir, "alpha", "inbox.md")).text();
    expect(alphaInbox).toBe("# Inbox: alpha\n\n");

    // No leftover errors
    expect(result.errors).toEqual([]);
  });

  test("dry-run leaves canon and inbox untouched", async () => {
    const { paths, date } = await buildApplyFixture();
    const result = await applyDecisions({ paths, date, dryRun: true });

    // Totals are reported the same in dry-run as wet-run.
    expect(result.totals.accepted).toBe(1);
    expect(result.totals.superseded).toBe(1);
    expect(result.totals.merged).toBe(1);

    // Canon should be unchanged from fixture seed.
    const alphaSnap = await readProjectMemorySnapshot(paths, "alpha");
    const guardian = alphaSnap.facts.find((f) => f.text === "Use Guardian for JWT");
    expect(guardian?.superseded).toBeFalsy(); // not touched
    const joken = alphaSnap.facts.find((f) => f.text === "Use Joken for JWT");
    expect(joken).toBeUndefined();

    // Inbox should still have the seeded line
    const inbox = await Bun.file(join(paths.projectsDir, "alpha", "inbox.md")).text();
    expect(inbox).toContain("earlier finding");

    // briefingPath returned but file not written (it already exists from the fixture though)
    // The test mostly cares that canon wasn't mutated.
  });

  test("clears an inbox-only project after its briefing lands", async () => {
    const { paths, date, runDir } = await buildApplyFixture();
    await mkdir(join(paths.projectsDir, "charlie"), { recursive: true });
    await writeFile(join(paths.projectsDir, "charlie", "config.md"), "---\nname: charlie\npath: /tmp/nope/charlie\n---\n");
    await writeFile(join(paths.projectsDir, "charlie", "inbox.md"), "# Inbox: charlie\n\nObserve found one thread.\n");
    const snapshots = JSON.parse(await Bun.file(join(runDir, "inboxes.json")).text()) as {
      version: number;
      inboxes: Array<{ projectId: string; bodyHash: string }>;
    };
    snapshots.inboxes.push({
      projectId: "charlie",
      bodyHash: inboxBodyHash("Observe found one thread."),
    });
    await Bun.write(join(runDir, "inboxes.json"), JSON.stringify(snapshots));

    const result = await applyDecisions({ paths, date });
    expect(result.perProject.find((item) => item.projectId === "charlie")?.inboxTruncated).toBe(true);
    expect(await Bun.file(join(paths.projectsDir, "charlie", "inbox.md")).text()).toBe("# Inbox: charlie\n\n");
  });

  test("preserves an inbox changed after verification", async () => {
    const { paths, date } = await buildApplyFixture();
    const inboxPath = join(paths.projectsDir, "alpha", "inbox.md");
    await writeFile(inboxPath, "# Inbox: alpha\n\n- earlier finding\n- note added after Pass V\n");

    const result = await applyDecisions({ paths, date });
    expect(result.perProject.find((item) => item.projectId === "alpha")?.inboxTruncated).toBe(false);
    expect(await Bun.file(inboxPath).text()).toContain("note added after Pass V");
  });

  test("preserves captured inboxes when no briefing lands", async () => {
    const { paths, date, runDir } = await buildApplyFixture();
    await rm(join(runDir, "briefing.md"));

    const result = await applyDecisions({ paths, date });
    expect(result.briefingPath).toBeNull();
    expect(await Bun.file(join(paths.projectsDir, "alpha", "inbox.md")).text()).toContain("earlier finding");
    expect(result.perProject.find((item) => item.projectId === "alpha")?.inboxTruncated).toBe(false);
  });

  test("missing decisions.json throws clearly", async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-apply-empty-"));
    const paths = await ensureHiveScaffold(home);
    await expect(
      applyDecisions({ paths, date: "2026-01-01" }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Directive guard (TK-123): a user-directed save the verifier rejected anyway
// must be force-admitted, not dropped.
// ---------------------------------------------------------------------------

async function buildDirectiveFixture(opts: { directive: boolean }): Promise<{ paths: HivePaths; date: string }> {
  const home = await mkdtemp(join(tmpdir(), "hive-apply-directive-"));
  const paths = await ensureHiveScaffold(home);
  const date = new Date().toISOString().slice(0, 10);
  const runDir = join(paths.memoryRunsDir, date);
  await mkdir(runDir, { recursive: true });

  await mkdir(join(home, "projects", "alpha"), { recursive: true });
  await writeFile(
    join(home, "projects", "alpha", "config.md"),
    `---\nname: alpha\npath: /tmp/nope/alpha\n---\n`,
  );

  // One mid-session candidate; directive flag varies by case.
  await appendCandidate(paths, "alpha", {
    type: "fact",
    content: "Changelog is user-facing; pricing and admin stay out",
    tags: ["changelog"],
    directive: opts.directive,
  });

  // The verifier rejected it.
  await writeFile(
    join(runDir, "decisions.json"),
    JSON.stringify({
      decisions: [
        { candidate_id: "candidates.alpha[0]", action: "reject", reason: "low_signal" },
      ],
    }),
  );
  await writeFile(join(runDir, "briefing.md"), `# HIVE — ${date}\n`);

  return { paths, date };
}

describe("applyDecisions — directive guard (TK-123)", () => {
  test("a rejected directive is force-admitted to canon", async () => {
    const { paths, date } = await buildDirectiveFixture({ directive: true });
    const result = await applyDecisions({ paths, date });

    // Counted as an accept, not a rejection.
    expect(result.totals.accepted).toBe(1);
    expect(result.totals.rejected).toBe(0);
    expect(result.totals.directivesForceAdmitted).toBe(1);

    // It actually landed in canon.
    const snap = await readProjectMemorySnapshot(paths, "alpha");
    const landed = snap.facts.find((f) => f.text.includes("Changelog is user-facing"));
    expect(landed).toBeTruthy();
    expect(landed?.superseded).toBeFalsy();

    // It must NOT appear in the rejection audit log.
    const rejPath = join(paths.memoryRunsDir, date, "rejections.log");
    expect(await Bun.file(rejPath).exists()).toBe(false);
  });

  test("a rejected non-directive candidate is still dropped", async () => {
    const { paths, date } = await buildDirectiveFixture({ directive: false });
    const result = await applyDecisions({ paths, date });

    expect(result.totals.accepted).toBe(0);
    expect(result.totals.rejected).toBe(1);
    expect(result.totals.directivesForceAdmitted).toBe(0);

    const snap = await readProjectMemorySnapshot(paths, "alpha");
    const landed = snap.facts.find((f) => f.text.includes("Changelog is user-facing"));
    expect(landed).toBeUndefined();

    // Ordinary rejection is logged.
    const rejPath = join(paths.memoryRunsDir, date, "rejections.log");
    expect(await Bun.file(rejPath).exists()).toBe(true);
  });

  test("dry-run force-admits in the tally but does not mutate canon", async () => {
    const { paths, date } = await buildDirectiveFixture({ directive: true });
    const result = await applyDecisions({ paths, date, dryRun: true });

    expect(result.totals.directivesForceAdmitted).toBe(1);
    expect(result.totals.accepted).toBe(1);

    const snap = await readProjectMemorySnapshot(paths, "alpha");
    const landed = snap.facts.find((f) => f.text.includes("Changelog is user-facing"));
    expect(landed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Gap dedupe (TK-147)
// ---------------------------------------------------------------------------

const STANDING_QUESTION =
  "Is the heartbeat still earning its keep now that campaigns cover long-horizon work?";
const KNOWN_FACT =
  "The dashboard collects run artifacts from the nightly runs directory.";

async function buildGapFixture(
  observations: string[],
): Promise<{ paths: HivePaths; date: string }> {
  const home = await mkdtemp(join(tmpdir(), "hive-apply-gaps-"));
  const paths = await ensureHiveScaffold(home);
  const date = new Date().toISOString().slice(0, 10);
  const runDir = join(paths.memoryRunsDir, date);
  await mkdir(runDir, { recursive: true });

  await mkdir(join(home, "projects", "alpha"), { recursive: true });
  await writeFile(
    join(home, "projects", "alpha", "config.md"),
    `---\nname: alpha\npath: /tmp/nope/alpha\n---\n`,
  );

  // Canon already holds one open question and one settled fact.
  await appendProjectMemory(paths, "alpha", "question", STANDING_QUESTION, ["gap"]);
  await appendProjectMemory(paths, "alpha", "fact", KNOWN_FACT, ["dashboard"]);

  await writeFile(
    join(runDir, "verifier-output.json"),
    JSON.stringify({
      decisions: [],
      gaps: observations.map((observation, i) => ({
        subject: "alpha",
        observation,
        source: `topRanked[${i}]`,
      })),
      briefing_markdown: "# HIVE\n",
    }),
  );
  await writeFile(join(runDir, "decisions.json"), JSON.stringify({ decisions: [] }));
  await writeFile(join(runDir, "briefing.md"), `# HIVE — ${date}\n`);

  return { paths, date };
}

describe("landGaps — project gaps stay out of canon", () => {
  test("a project gap writes nothing to knowledge.md", async () => {
    const fresh = "Nobody has checked whether watches fire while the machine is asleep.";
    const { paths, date } = await buildGapFixture([fresh]);
    const result = await applyDecisions({ paths, date });

    expect(result.totals.gapsBriefed).toBe(1);
    const snap = await readProjectMemorySnapshot(paths, "alpha");
    expect(snap.questions.length).toBe(1); // just the seeded one
    expect(snap.questions.find((q) => q.text === fresh)).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  test("a re-observed gap leaves the existing question untouched", async () => {
    const { paths, date } = await buildGapFixture([STANDING_QUESTION]);
    await applyDecisions({ paths, date });
    await applyDecisions({ paths, date });

    const snap = await readProjectMemorySnapshot(paths, "alpha");
    expect(snap.questions.length).toBe(1);
    expect(snap.questions[0]!.text).toBe(STANDING_QUESTION);
  });

  test("gaps alone do not touch a project's index", async () => {
    const { paths, date } = await buildGapFixture([STANDING_QUESTION, KNOWN_FACT]);
    const result = await applyDecisions({ paths, date });
    const alpha = result.perProject.find((p) => p.projectId === "alpha");
    expect(alpha?.rebuiltIndex ?? false).toBe(false);
  });

  test("every gap's disposition is logged as briefing", async () => {
    const fresh = "Nobody has checked whether watches fire while the machine is asleep.";
    const { paths, date } = await buildGapFixture([STANDING_QUESTION, KNOWN_FACT, fresh]);
    await applyDecisions({ paths, date });

    const logPath = join(paths.memoryRunsDir, date, "gaps.applied.log");
    const lines = (await Bun.file(logPath).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.disposition)).toEqual(["briefing", "briefing", "briefing"]);
    expect(lines[2]!.observation).toBe(fresh);
  });

  test("dry-run logs nothing and touches nothing", async () => {
    const fresh = "Nobody has checked whether watches fire while the machine is asleep.";
    const { paths, date } = await buildGapFixture([fresh]);
    const result = await applyDecisions({ paths, date, dryRun: true });

    expect(result.totals.gapsBriefed).toBe(1);
    const logPath = join(paths.memoryRunsDir, date, "gaps.applied.log");
    expect(await Bun.file(logPath).exists()).toBe(false);
    const snap = await readProjectMemorySnapshot(paths, "alpha");
    expect(snap.questions.length).toBe(1);
  });
});
