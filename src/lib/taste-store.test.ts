import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listPendingUnits,
  readNegatives,
  readTasteUnits,
  recordNegative,
  removeUnit,
  searchTasteStore,
  setUnitStatus,
  unitHash,
  writeTasteUnit,
} from "./taste-store";
import type { TasteCandidate } from "./taste-types";

function candidate(over: Partial<TasteCandidate> = {}): TasteCandidate {
  return {
    category: "DESIGN",
    tier: "FUZZY",
    scope: { kind: "general-taste" },
    reasoning: "Trace every consumer of an invariant before relaxing it.",
    delta: { before: "updated one read path", after: "updated all read paths" },
    reason_source: "stated",
    rule_statement: "When relaxing a uniqueness constraint, update every query that assumed the old cardinality",
    canonical_example: { bad: "deduped list_for_agency only", good: "grep all queries on the table" },
    check_sketch: null,
    evidence: [{ anchor: { sessionFile: "s.jsonl", id: "u1", ts: null }, quote: "this was my miss", confidence: 0.9 }],
    dedupe_key: "trace-all-read-paths",
    provenance: "id=u1",
    ...over,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hive-taste-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("writeTasteUnit + readTasteUnits", () => {
  test("a new unit is stored pending with recurrence 1 and a stable hash", async () => {
    const r = await writeTasteUnit(dir, candidate(), { now: "2026-06-23" });
    expect(r.isNew).toBe(true);
    expect(r.recurrence).toBe(1);
    expect(r.hash).toBe(unitHash(candidate()));

    const units = await readTasteUnits(dir);
    expect(units).toHaveLength(1);
    expect(units[0]!.status).toBe("pending");
    expect(units[0]!.category).toBe("DESIGN");
    expect(units[0]!.reasoning).toContain("Trace every consumer");
  });

  test("re-observing the same unit bumps recurrence and merges evidence (no dup)", async () => {
    await writeTasteUnit(dir, candidate(), { now: "2026-06-23" });
    const r2 = await writeTasteUnit(
      dir,
      candidate({
        evidence: [
          { anchor: { sessionFile: "s.jsonl", id: "u1", ts: null }, quote: "dup anchor", confidence: 0.9 },
          { anchor: { sessionFile: "t.jsonl", id: "u9", ts: null }, quote: "new anchor", confidence: 0.8 },
        ],
      }),
      { now: "2026-06-24" },
    );
    expect(r2.isNew).toBe(false);
    expect(r2.recurrence).toBe(2);

    const units = await readTasteUnits(dir, "DESIGN");
    expect(units).toHaveLength(1);
    // u1 (already present) + u9 (new) = 2, not 3
    expect(units[0]!.evidence.map((e) => e.anchor.id).sort()).toEqual(["u1", "u9"]);
    expect(units[0]!.lastSeen).toBe("2026-06-24");
    expect(units[0]!.firstSeen).toBe("2026-06-23");
  });

  test("distinct units land in distinct category files", async () => {
    await writeTasteUnit(dir, candidate());
    await writeTasteUnit(dir, candidate({ category: "PROCESS", dedupe_key: "dont-deflect", reasoning: "Do the asked work before filing tangential tickets." }));
    expect(await readTasteUnits(dir, "DESIGN")).toHaveLength(1);
    expect(await readTasteUnits(dir, "PROCESS")).toHaveLength(1);
    expect(await readTasteUnits(dir)).toHaveLength(2);
  });

  test("round-trips all structured fields through the JSON-in-comment", async () => {
    await writeTasteUnit(dir, candidate({ scope: { kind: "general-taste", glob: "**/*.sql" }, ladders_up_hint: "exhaustive enumeration" }));
    const u = (await readTasteUnits(dir, "DESIGN"))[0]!;
    expect(u.scope.glob).toBe("**/*.sql");
    expect(u.ladders_up_hint).toBe("exhaustive enumeration");
    expect(u.reason_source).toBe("stated");
  });
});

describe("searchTasteStore", () => {
  test("returns the relevant unit and respects the category prefilter", async () => {
    await writeTasteUnit(dir, candidate());
    await writeTasteUnit(dir, candidate({ category: "PROCESS", dedupe_key: "dont-deflect", reasoning: "Do the asked work before filing tangential tickets about momentum." }));

    const hits = await searchTasteStore(dir, "uniqueness constraint query cardinality");
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.unit.category).toBe("DESIGN");

    const processHits = await searchTasteStore(dir, "momentum tickets", { category: "PROCESS" });
    expect(processHits.every((h) => h.unit.category === "PROCESS")).toBe(true);
  });

  test("an empty store returns no hits", async () => {
    expect(await searchTasteStore(dir, "anything")).toEqual([]);
  });

  test("a recall bumps the unit's decay metadata (retrieval strengthening)", async () => {
    await writeTasteUnit(dir, candidate());
    const before = await Bun.file(join(dir, "_meta.json")).json();
    const h = unitHash(candidate());
    expect(before.entries[h].recallCount).toBe(0);

    await searchTasteStore(dir, "uniqueness constraint cardinality");
    const after = await Bun.file(join(dir, "_meta.json")).json();
    expect(after.entries[h].recallCount).toBe(1);
  });

  test("noBump leaves the decay metadata untouched", async () => {
    await writeTasteUnit(dir, candidate());
    await searchTasteStore(dir, "uniqueness constraint cardinality", { noBump: true });
    const after = await Bun.file(join(dir, "_meta.json")).json();
    expect(after.entries[unitHash(candidate())].recallCount).toBe(0);
  });
});

describe("curation lifecycle", () => {
  test("listPendingUnits returns only pending units", async () => {
    await writeTasteUnit(dir, candidate());
    await writeTasteUnit(dir, candidate({ category: "PROCESS", dedupe_key: "p", reasoning: "do the asked work first" }), { status: "active" });
    const pending = await listPendingUnits(dir);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.category).toBe("DESIGN");
  });

  test("setUnitStatus promotes pending → active", async () => {
    const { hash } = await writeTasteUnit(dir, candidate());
    expect(await setUnitStatus(dir, hash, "active")).toBe(true);
    const u = (await readTasteUnits(dir, "DESIGN"))[0]!;
    expect(u.status).toBe("active");
    expect(await listPendingUnits(dir)).toHaveLength(0);
  });

  test("removeUnit drops the unit and its meta entry", async () => {
    const { hash } = await writeTasteUnit(dir, candidate());
    expect(await removeUnit(dir, hash)).toBe(true);
    expect(await readTasteUnits(dir, "DESIGN")).toHaveLength(0);
    const meta = await Bun.file(join(dir, "_meta.json")).json();
    expect(meta.entries[hash]).toBeUndefined();
  });

  test("recordNegative dedupes and persists killed dedupe_keys", async () => {
    await recordNegative(dir, "trace-all-read-paths");
    await recordNegative(dir, "trace-all-read-paths");
    await recordNegative(dir, "other");
    expect((await readNegatives(dir)).sort()).toEqual(["other", "trace-all-read-paths"]);
  });
});
