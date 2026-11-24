import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendProjectMemory,
  archivePath,
  archiveSupersededLines,
  entryHash,
  formatSearchResults,
  knowledgePath,
  parseArchive,
  readArchive,
  readMeta,
  readProjectMemorySnapshot,
  restoreArchivedEntry,
  retireEntryByHash,
  searchMemory,
  supersedeEntryByHash,
} from "../lib/memory";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { NEIGHBOR_K, scopeCanon, selectNeighbors } from "../lib/forgetting";
import { serializeProjectCanon } from "../lib/verify";

let paths: HivePaths;

beforeEach(async () => {
  paths = await ensureHiveScaffold(await mkdtemp(join(tmpdir(), "hive-forget-")));
});

// ---------------------------------------------------------------------------
// retire → archive.md, and search still finds it
// ---------------------------------------------------------------------------

describe("retireEntryByHash", () => {
  test("moves the entry out of knowledge.md into archive.md, and search finds it there", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "RE-style campaigns are unbuilt in matreas", ["campaigns"]);
    await appendProjectMemory(paths, "alpha", "fact", "Receipts are issued by issue_receipt", ["receipts"]);
    const hash = entryHash("RE-style campaigns are unbuilt in matreas");

    const r = await retireEntryByHash(paths, "alpha", hash, "stale", "B.alpha[2] says the campaign tree landed");
    expect(r).toEqual({ section: "fact", retiredText: "RE-style campaigns are unbuilt in matreas" });

    const knowledge = await Bun.file(knowledgePath(paths, "alpha")).text();
    expect(knowledge).not.toContain("campaigns are unbuilt");
    expect(knowledge).toContain("issue_receipt");
    const snap = await readProjectMemorySnapshot(paths, "alpha");
    expect(snap.facts.map((f) => f.text)).toEqual(["Receipts are issued by issue_receipt"]);

    // Its meta row goes with it, as on supersede.
    expect((await readMeta(paths, "alpha")).entries[hash]).toBeUndefined();

    const archived = await readArchive(paths, "alpha");
    expect(archived).toEqual([
      {
        section: "fact",
        hash,
        text: "RE-style campaigns are unbuilt in matreas",
        tags: ["campaigns"],
        ts: null,
        kind: "retired",
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        reason: "stale",
        note: "B.alpha[2] says the campaign tree landed",
      },
    ]);

    // V never reads archive.md: the serialized canon no longer holds it.
    const canon = await serializeProjectCanon(paths, "alpha");
    expect(canon.facts.map((f) => f.hash)).not.toContain(hash);

    // Search still does, labelled as archived, and without a recall bump.
    const { results } = await searchMemory(paths, "alpha", "campaigns unbuilt");
    const hit = results.find((x) => x.hash === hash);
    expect(hit?.source).toBe("archive");
    expect(hit?.file).toBe("archive.md");
    expect(hit?.archived).toEqual({ kind: "retired", date: expect.any(String), reason: "stale" });
    expect((await readMeta(paths, "alpha")).entries[hash]).toBeUndefined();
    const text = formatSearchResults(results, "campaigns unbuilt");
    expect(text).toContain("### Archive");
    expect(text).toContain(`retired`);
    expect(text).toContain(`hash ${hash}`);
  });

  test("finds the entry in any section and keeps a decision's timestamp", async () => {
    await appendProjectMemory(paths, "alpha", "decision", "Pin Elixir 1.17.3 in the Dockerfile");
    const hash = entryHash("Pin Elixir 1.17.3 in the Dockerfile");
    const r = await retireEntryByHash(paths, "alpha", hash, "contradicted");
    expect(r.section).toBe("decision");
    const [a] = await readArchive(paths, "alpha");
    expect(a?.ts).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(a?.reason).toBe("contradicted");
    expect(a?.note).toBeUndefined();
  });

  test("an archive hit ranks below an equally matching live entry", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "the widget cache uses redis");
    await appendProjectMemory(paths, "alpha", "fact", "the widget cache used memcached");
    await retireEntryByHash(paths, "alpha", entryHash("the widget cache used memcached"), "stale");
    const { results } = await searchMemory(paths, "alpha", "widget cache", { floor: 0 });
    expect(results.map((r) => r.source)).toEqual(["knowledge", "archive"]);
  });

  test("refuses an unknown hash and an unknown reason", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "an entry");
    await expect(retireEntryByHash(paths, "alpha", "deadbeef", "stale")).rejects.toThrow(/No active entry/);
    await expect(
      retireEntryByHash(paths, "alpha", entryHash("an entry"), "unused" as never),
    ).rejects.toThrow(/Unknown retire reason/);
    expect(existsSync(archivePath(paths, "alpha"))).toBe(false);
  });

  test("keeps the note on one line", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "an entry");
    await retireEntryByHash(paths, "alpha", entryHash("an entry"), "trivia", "line one\nline two");
    const [a] = await readArchive(paths, "alpha");
    expect(a?.note).toBe("line one line two");
  });
});

describe("restoreArchivedEntry", () => {
  test("moves a retired entry back to its section with tags and a fresh meta row", async () => {
    await appendProjectMemory(paths, "alpha", "convention", "scope LiveView test selectors", ["testing"]);
    const hash = entryHash("scope LiveView test selectors");
    await retireEntryByHash(paths, "alpha", hash, "trivia");

    const back = await restoreArchivedEntry(paths, "alpha", hash);
    expect(back.text).toBe("scope LiveView test selectors");

    const snap = await readProjectMemorySnapshot(paths, "alpha");
    expect(snap.conventions).toEqual([{ text: "scope LiveView test selectors", tags: ["testing"] }]);
    expect(await readArchive(paths, "alpha")).toEqual([]);
    expect((await readMeta(paths, "alpha")).entries[hash]?.recallCount).toBe(0);
  });

  test("refuses a hash the archive does not hold", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "x entry");
    await retireEntryByHash(paths, "alpha", entryHash("x entry"), "stale");
    await expect(restoreArchivedEntry(paths, "alpha", "deadbeef")).rejects.toThrow(/No archived entry/);
  });
});

// ---------------------------------------------------------------------------
// superseded lines → archive.md
// ---------------------------------------------------------------------------

describe("supersede with archive", () => {
  test("moves the old line to archive.md instead of striking it through", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "Use Guardian for JWT", ["auth"]);
    const oldHash = entryHash("Use Guardian for JWT");
    await supersedeEntryByHash(paths, "alpha", "fact", oldHash, "Use Joken for JWT", ["auth"], { archive: true });

    const knowledge = await Bun.file(knowledgePath(paths, "alpha")).text();
    expect(knowledge).not.toContain("Guardian");
    expect(knowledge).not.toContain("~~");
    const [a] = await readArchive(paths, "alpha");
    expect(a).toMatchObject({ hash: oldHash, kind: "superseded", tags: ["auth"] });

    // Superseded archive lines follow the old include_superseded rule.
    const hidden = await searchMemory(paths, "alpha", "Guardian JWT");
    expect(hidden.results.some((r) => r.hash === oldHash)).toBe(false);
    const shown = await searchMemory(paths, "alpha", "Guardian JWT", { includeSuperseded: true });
    expect(shown.results.find((r) => r.hash === oldHash)?.source).toBe("archive");
  });

  test("without the option, supersede is unchanged", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "old way");
    await supersedeEntryByHash(paths, "alpha", "fact", entryHash("old way"), "new way");
    const knowledge = await Bun.file(knowledgePath(paths, "alpha")).text();
    expect(knowledge).toContain("~~old way~~ → superseded");
    expect(existsSync(archivePath(paths, "alpha"))).toBe(false);
  });
});

describe("archiveSupersededLines", () => {
  test("moves existing strikethrough lines with their dates; dry run writes nothing", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "old fact", ["a"]);
    await appendProjectMemory(paths, "alpha", "decision", "old decision");
    await appendProjectMemory(paths, "alpha", "fact", "keeper");
    await supersedeEntryByHash(paths, "alpha", "fact", entryHash("old fact"), "new fact");
    await supersedeEntryByHash(paths, "alpha", "decision", entryHash("old decision"), "new decision");
    const before = await Bun.file(knowledgePath(paths, "alpha")).text();

    expect(await archiveSupersededLines(paths, "alpha", { dryRun: true })).toEqual({ moved: 2 });
    expect(await Bun.file(knowledgePath(paths, "alpha")).text()).toBe(before);

    expect(await archiveSupersededLines(paths, "alpha")).toEqual({ moved: 2 });
    const after = await Bun.file(knowledgePath(paths, "alpha")).text();
    expect(after).not.toContain("~~");
    const snap = await readProjectMemorySnapshot(paths, "alpha");
    expect(snap.facts.map((f) => f.text)).toEqual(["keeper", "new fact"]);
    expect(snap.decisions.map((d) => d.text)).toEqual(["new decision"]);

    const archived = await readArchive(paths, "alpha");
    expect(archived.map((a) => [a.section, a.text, a.kind])).toEqual([
      ["fact", "old fact", "superseded"],
      ["decision", "old decision", "superseded"],
    ]);
    expect(archived[0]?.tags).toEqual(["a"]);
    expect(archived[1]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("parseArchive", () => {
  test("takes the last marker on the line and ignores lines outside a section", () => {
    const parsed = parseArchive(
      [
        "# Archive: alpha",
        "- stray → retired 2026-11-01: stale",
        "## Durable Facts",
        "- A → B means A implies B [logic] → retired 2026-11-24: trivia — one-off",
        "- [2026-10-01] not a decision header here → superseded 2026-11-02",
      ].join("\n"),
    );
    expect(parsed.map((p) => [p.text, p.tags, p.kind, p.date, p.reason ?? null, p.ts])).toEqual([
      ["A → B means A implies B", ["logic"], "retired", "2026-11-24", "trivia", null],
      ["not a decision header here", [], "superseded", "2026-11-02", null, "2026-10-01"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Neighbour scoping picks the right 20
// ---------------------------------------------------------------------------

describe("selectNeighbors", () => {
  // 40 entries. Entry i mentions "deploy" i times when i < 25, so BM25 orders
  // them by term frequency; entries 25..39 never mention it.
  const entries = Array.from({ length: 40 }, (_, i) => {
    const text =
      i < 25
        ? `entry ${i} ${Array.from({ length: i + 1 }, () => "deploy").join(" ")} pipeline notes`
        : `entry ${i} about invoices and ledgers only`;
    return { hash: `h${String(i).padStart(2, "0")}`, text };
  });

  test("takes the 20 best-scoring entries, best first", () => {
    const sel = selectNeighbors(entries, ["how do we deploy"]);
    expect(NEIGHBOR_K).toBe(20);
    // Highest term frequency first: entries 24 down to 5.
    expect(sel.perQuery[0]).toEqual(
      Array.from({ length: 20 }, (_, j) => `h${String(24 - j).padStart(2, "0")}`),
    );
    // The union comes back in canon order.
    expect(sel.hashes).toEqual(Array.from({ length: 20 }, (_, j) => `h${String(5 + j).padStart(2, "0")}`));
  });

  test("never includes a zero-score entry, so a narrow query brings fewer than k", () => {
    const sel = selectNeighbors(entries, ["ledgers"]);
    expect(sel.perQuery[0]!.sort()).toEqual(Array.from({ length: 15 }, (_, j) => `h${25 + j}`));
    expect(selectNeighbors(entries, ["zebra"]).hashes).toEqual([]);
  });

  test("unions over queries without duplicates", () => {
    const sel = selectNeighbors(entries, ["deploy", "invoices"], 3);
    expect(sel.perQuery).toEqual([["h24", "h23", "h22"], ["h25", "h26", "h27"]]);
    expect(sel.hashes).toEqual(["h22", "h23", "h24", "h25", "h26", "h27"]);
  });

  test("ignores tags: the ranking is over entry text only", async () => {
    await appendProjectMemory(paths, "alpha", "fact", "unrelated words here", ["deploy"]);
    await appendProjectMemory(paths, "alpha", "fact", "deploy runs from the main branch");
    const canon = await serializeProjectCanon(paths, "alpha");
    const scoped = scopeCanon(canon, ["deploy"]);
    expect(scoped.canon.facts.map((f) => f.text)).toEqual(["deploy runs from the main branch"]);
    expect(scoped.totalEntries).toBe(2);
    expect(scoped.shownEntries).toBe(1);
    expect(scoped.shownBytes).toBeLessThan(scoped.totalBytes);
  });
});
