import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendCandidate,
  appendCandidates,
  readCandidates,
  drainCandidates,
  candidatesPath,
} from "../lib/memory";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";

describe("candidates — round trip", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-candidates-"));
    paths = await ensureHiveScaffold(home);
  });

  test("appendCandidate writes and readCandidates returns it", async () => {
    const c = await appendCandidate(paths, "alpha", {
      type: "fact",
      content: "Use Joken for JWT, not Guardian",
      tags: ["auth", "jwt"],
    });
    expect(c.type).toBe("fact");
    expect(c.content).toBe("Use Joken for JWT, not Guardian");
    expect(c.tags).toEqual(["auth", "jwt"]);
    expect(c.provenance).toMatch(/^session:pid-\d+ — agent-write at \d{2}:\d{2}:\d{2}Z$/);
    expect(c.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const read = await readCandidates(paths, "alpha");
    expect(read.length).toBe(1);
    expect(read[0]?.content).toBe("Use Joken for JWT, not Guardian");
    expect(read[0]?.provenance).toBe(c.provenance);
  });

  test("file starts with header line that read skips", async () => {
    await appendCandidate(paths, "alpha", { type: "fact", content: "first" });
    const raw = await Bun.file(candidatesPath(paths, "alpha")).text();
    expect(raw.startsWith("# Candidates")).toBe(true);
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(2); // header + 1 candidate
  });

  test("multiple appends accumulate without corrupting prior lines", async () => {
    await appendCandidate(paths, "alpha", { type: "fact", content: "one" });
    await appendCandidate(paths, "alpha", { type: "convention", content: "two" });
    await appendCandidate(paths, "alpha", { type: "decision", content: "three" });
    const read = await readCandidates(paths, "alpha");
    expect(read.map((c) => c.content)).toEqual(["one", "two", "three"]);
    expect(read.map((c) => c.type)).toEqual(["fact", "convention", "decision"]);
  });

  test("appendCandidates batches with shared timestamp", async () => {
    const batchTime = new Date("2026-04-26T14:00:00Z");
    const written = await appendCandidates(
      paths,
      "alpha",
      [
        { type: "fact", content: "batch one" },
        { type: "fact", content: "batch two" },
      ],
      { now: batchTime },
    );
    expect(written.length).toBe(2);
    expect(written[0]?.writtenAt).toBe(written[1]?.writtenAt);
    expect(written[0]?.provenance).toBe(written[1]?.provenance);
  });

  test("provenance_note is preserved when supplied", async () => {
    const c = await appendCandidate(paths, "alpha", {
      type: "fact",
      content: "ratio matters",
      provenanceNote: "Greg said 'this is the heart of it' in the design walk",
    });
    expect(c.provenanceNote).toContain("heart of it");
    const read = await readCandidates(paths, "alpha");
    expect(read[0]?.provenanceNote).toBe(c.provenanceNote);
  });

  test("supersedesHint is preserved when supplied", async () => {
    await appendCandidate(paths, "alpha", {
      type: "fact",
      content: "new fact replacing old",
      supersedesHint: "old fact text",
    });
    const read = await readCandidates(paths, "alpha");
    expect(read[0]?.supersedesHint).toBe("old fact text");
  });

  test("directive flag round-trips through appendCandidate", async () => {
    await appendCandidate(paths, "alpha", {
      type: "fact",
      content: "Greg said save this",
      directive: true,
    });
    const read = await readCandidates(paths, "alpha");
    expect(read[0]?.directive).toBe(true);
  });

  test("directive flag round-trips through appendCandidates (batch)", async () => {
    await appendCandidates(paths, "alpha", [
      { type: "fact", content: "directed one", directive: true },
      { type: "fact", content: "ordinary two" },
    ]);
    const read = await readCandidates(paths, "alpha");
    expect(read[0]?.directive).toBe(true);
    // Non-directive entries don't carry the flag at all.
    expect(read[1]?.directive).toBeUndefined();
  });

  test("absent optional fields stay undefined (not on disk)", async () => {
    await appendCandidate(paths, "alpha", { type: "fact", content: "minimal" });
    const raw = await Bun.file(candidatesPath(paths, "alpha")).text();
    // The serialized JSON should not carry the optional keys.
    expect(raw).not.toContain('"provenanceNote"');
    expect(raw).not.toContain('"supersedesHint"');
    expect(raw).not.toContain('"directive"');
  });

  test("malformed lines are skipped, valid ones survive", async () => {
    const file = candidatesPath(paths, "alpha");
    await appendCandidate(paths, "alpha", { type: "fact", content: "valid" });
    const existing = await Bun.file(file).text();
    await Bun.write(file, existing + "this is not json\n{not:json}\n");
    const read = await readCandidates(paths, "alpha");
    expect(read.length).toBe(1);
    expect(read[0]?.content).toBe("valid");
  });

  test("readCandidates on missing file returns empty array", async () => {
    const read = await readCandidates(paths, "ghost");
    expect(read).toEqual([]);
  });
});

describe("candidates — drain", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-candidates-drain-"));
    paths = await ensureHiveScaffold(home);
  });

  test("drainCandidates copies to dest and resets live file to header", async () => {
    await appendCandidate(paths, "alpha", { type: "fact", content: "one" });
    await appendCandidate(paths, "alpha", { type: "convention", content: "two" });

    const dest = join(paths.memoryRunsDir, "2026-04-26", "candidates.consumed.alpha.md");
    const result = await drainCandidates(paths, "alpha", dest);

    expect(result.drained).toBe(2);
    expect(result.destPath).toBe(dest);

    // Drained file holds all the original content.
    const drained = await Bun.file(dest).text();
    expect(drained).toContain('"content":"one"');
    expect(drained).toContain('"content":"two"');

    // Live file is back to just the header — no candidates.
    const live = await readCandidates(paths, "alpha");
    expect(live).toEqual([]);
    const raw = await Bun.file(candidatesPath(paths, "alpha")).text();
    expect(raw.startsWith("# Candidates")).toBe(true);
  });

  test("drain on empty/missing file is a no-op", async () => {
    const dest = join(paths.memoryRunsDir, "2026-04-26", "consumed.md");
    const result = await drainCandidates(paths, "ghost", dest);
    expect(result.drained).toBe(0);
  });

  test("drained candidates can land in next batch without collision", async () => {
    await appendCandidate(paths, "alpha", { type: "fact", content: "round one" });
    const dest1 = join(paths.memoryRunsDir, "2026-04-26", "consumed.md");
    await drainCandidates(paths, "alpha", dest1);

    await appendCandidate(paths, "alpha", { type: "fact", content: "round two" });
    const live = await readCandidates(paths, "alpha");
    expect(live.length).toBe(1);
    expect(live[0]?.content).toBe("round two");
  });
});

describe("candidates — content discipline (validateMemoryEntry)", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), "hive-candidates-validate-"));
    paths = await ensureHiveScaffold(home);
  });

  test("rejects empty content", async () => {
    await expect(
      appendCandidate(paths, "alpha", { type: "fact", content: "   " }),
    ).rejects.toThrow();
  });

  test("rejects markdown header injection", async () => {
    await expect(
      appendCandidate(paths, "alpha", { type: "fact", content: "## injection" }),
    ).rejects.toThrow();
  });

  test("collapses internal newlines to keep JSON clean", async () => {
    const c = await appendCandidate(paths, "alpha", {
      type: "fact",
      content: "first line\nsecond line\nthird line",
    });
    expect(c.content).toBe("first line second line third line");
  });
});
