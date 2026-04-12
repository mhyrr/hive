import { describe, test, expect } from "bun:test";

import {
  tokenize,
  buildCorpus,
  bm25Score,
  entryStrength,
  bumpRecall,
  createEntryMeta,
  daysBetween,
  entryHash,
  type EntryMeta,
} from "../lib/memory";

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  test("lowercases and splits on whitespace", () => {
    expect(tokenize("Hello World")).toEqual(["hello", "world"]);
  });

  test("strips punctuation", () => {
    expect(tokenize("it's a test!")).toEqual(["it", "s", "a", "test"]);
  });

  test("handles empty string", () => {
    expect(tokenize("")).toEqual([]);
  });

  test("preserves hyphens in words", () => {
    expect(tokenize("pre-commit hooks")).toEqual(["pre-commit", "hooks"]);
  });

  test("collapses multiple spaces", () => {
    expect(tokenize("spread   out   words")).toEqual(["spread", "out", "words"]);
  });
});

// ---------------------------------------------------------------------------
// BM25 Corpus + Scoring
// ---------------------------------------------------------------------------

describe("buildCorpus", () => {
  test("counts document frequencies correctly", () => {
    const corpus = buildCorpus(["jwt auth tokens", "auth middleware", "database query"]);
    expect(corpus.docCount).toBe(3);
    expect(corpus.df.get("auth")).toBe(2); // appears in 2 docs
    expect(corpus.df.get("jwt")).toBe(1);
    expect(corpus.df.get("database")).toBe(1);
  });

  test("handles empty corpus", () => {
    const corpus = buildCorpus([]);
    expect(corpus.docCount).toBe(0);
    expect(corpus.avgDocLen).toBe(1); // default to avoid divide by zero
  });

  test("counts each term once per document for df", () => {
    const corpus = buildCorpus(["auth auth auth"]); // repeated in same doc
    expect(corpus.df.get("auth")).toBe(1); // only 1 document contains it
  });
});

describe("bm25Score", () => {
  const docs = [
    "jwt authentication tokens are used for api auth",
    "database uses postgresql for persistent storage",
    "the frontend uses react with typescript",
    "bun runtime replaces node for faster builds",
  ];
  const corpus = buildCorpus(docs);

  test("relevant document scores higher than irrelevant", () => {
    const authScore = bm25Score("auth tokens", docs[0]!, corpus);
    const dbScore = bm25Score("auth tokens", docs[1]!, corpus);
    expect(authScore).toBeGreaterThan(dbScore);
  });

  test("exact match scores high", () => {
    const score = bm25Score("postgresql", docs[1]!, corpus);
    expect(score).toBeGreaterThan(0);
  });

  test("no matching terms scores zero", () => {
    const score = bm25Score("python django", docs[0]!, corpus);
    expect(score).toBe(0);
  });

  test("empty query scores zero", () => {
    expect(bm25Score("", docs[0]!, corpus)).toBe(0);
  });

  test("empty document scores zero", () => {
    expect(bm25Score("auth", "", corpus)).toBe(0);
  });

  test("rare terms score higher than common terms", () => {
    // "postgresql" only appears in 1 doc (high IDF)
    // vs a hypothetical common term
    const rareScore = bm25Score("postgresql", docs[1]!, corpus);
    // Build a corpus where "uses" is common (appears in 3 of 4 docs)
    const commonScore = bm25Score("uses", docs[1]!, corpus);
    expect(rareScore).toBeGreaterThan(commonScore);
  });

  test("multiple query terms accumulate score", () => {
    const singleTerm = bm25Score("jwt", docs[0]!, corpus);
    const multiTerm = bm25Score("jwt authentication tokens", docs[0]!, corpus);
    expect(multiTerm).toBeGreaterThan(singleTerm);
  });
});

// ---------------------------------------------------------------------------
// Entry Hashing
// ---------------------------------------------------------------------------

describe("entryHash", () => {
  test("produces 8-char hex string", () => {
    const hash = entryHash("some entry text");
    expect(hash).toMatch(/^[a-f0-9]{8}$/);
  });

  test("same text produces same hash", () => {
    expect(entryHash("consistent")).toBe(entryHash("consistent"));
  });

  test("different text produces different hash", () => {
    expect(entryHash("one")).not.toBe(entryHash("two"));
  });

  test("strips tags before hashing", () => {
    // Same text with and without tags should hash the same
    expect(entryHash("a fact [auth, api]")).toBe(entryHash("a fact"));
  });
});

// ---------------------------------------------------------------------------
// daysBetween
// ---------------------------------------------------------------------------

describe("daysBetween", () => {
  test("same day is 0", () => {
    expect(daysBetween("2026-04-12", "2026-04-12")).toBe(0);
  });

  test("one day apart", () => {
    expect(daysBetween("2026-04-11", "2026-04-12")).toBe(1);
  });

  test("30 days", () => {
    expect(daysBetween("2026-03-13", "2026-04-12")).toBe(30);
  });

  test("reversed dates clamp to 0", () => {
    expect(daysBetween("2026-04-12", "2026-04-10")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Decay / Strength
// ---------------------------------------------------------------------------

describe("createEntryMeta", () => {
  test("creates with default half-life and zero recalls", () => {
    const meta = createEntryMeta();
    expect(meta.recallCount).toBe(0);
    expect(meta.halfLife).toBe(30);
    expect(meta.lastRecalled).toBeNull();
    expect(meta.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("bumpRecall", () => {
  test("increments recall count", () => {
    const meta = createEntryMeta();
    const bumped = bumpRecall(meta);
    expect(bumped.recallCount).toBe(1);
  });

  test("extends half-life by 7 days", () => {
    const meta = createEntryMeta();
    const bumped = bumpRecall(meta);
    expect(bumped.halfLife).toBe(37);
  });

  test("caps half-life at 90", () => {
    const meta: EntryMeta = {
      createdAt: "2026-01-01",
      lastRecalled: null,
      recallCount: 0,
      halfLife: 88,
    };
    const bumped = bumpRecall(meta);
    expect(bumped.halfLife).toBe(90);
  });

  test("sets lastRecalled to today", () => {
    const meta = createEntryMeta();
    const bumped = bumpRecall(meta);
    expect(bumped.lastRecalled).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("multiple bumps accumulate", () => {
    let meta = createEntryMeta();
    meta = bumpRecall(meta);
    meta = bumpRecall(meta);
    meta = bumpRecall(meta);
    expect(meta.recallCount).toBe(3);
    expect(meta.halfLife).toBe(51); // 30 + 7*3
  });
});

describe("entryStrength", () => {
  test("undefined meta returns 1.0", () => {
    expect(entryStrength(undefined)).toBe(1.0);
  });

  test("brand new entry has strength ~1.0", () => {
    // Use HIVE_FIXED_NOW to control time
    const today = new Date().toISOString().slice(0, 10);
    const meta: EntryMeta = {
      createdAt: today,
      lastRecalled: null,
      recallCount: 0,
      halfLife: 30,
    };
    const strength = entryStrength(meta);
    // Should be very close to 1.0 (same day, 0 age)
    expect(strength).toBeCloseTo(1.0, 1);
  });

  test("entry at half-life with no recalls has strength ~0.5", () => {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const meta: EntryMeta = {
      createdAt: thirtyDaysAgo,
      lastRecalled: null,
      recallCount: 0,
      halfLife: 30,
    };
    const strength = entryStrength(meta);
    expect(strength).toBeCloseTo(0.5, 1);
  });

  test("recalls boost strength via log2 multiplier", () => {
    const today = new Date().toISOString().slice(0, 10);
    const noRecalls: EntryMeta = {
      createdAt: today, lastRecalled: null, recallCount: 0, halfLife: 30,
    };
    const threeRecalls: EntryMeta = {
      createdAt: today, lastRecalled: today, recallCount: 3, halfLife: 30,
    };
    // 1 + log2(4) = 3.0 for 3 recalls vs 1 + log2(1) = 1.0 for 0
    expect(entryStrength(threeRecalls)).toBeGreaterThan(entryStrength(noRecalls) * 2);
  });

  test("old entry with many recalls can still be strong", () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const meta: EntryMeta = {
      createdAt: sixtyDaysAgo,
      lastRecalled: today,
      recallCount: 7,
      halfLife: 79, // 30 + 7*7 = 79 (capped at 90)
    };
    const strength = entryStrength(meta);
    // Decay: 0.5^(60/79) ≈ 0.59, multiplier: 1 + log2(8) = 4.0 → ~2.4
    expect(strength).toBeGreaterThan(1.5);
  });

  test("very old unreinforced entry decays significantly", () => {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
      .toISOString().slice(0, 10);
    const meta: EntryMeta = {
      createdAt: ninetyDaysAgo,
      lastRecalled: null,
      recallCount: 0,
      halfLife: 30,
    };
    const strength = entryStrength(meta);
    // 0.5^(90/30) = 0.5^3 = 0.125
    expect(strength).toBeCloseTo(0.125, 1);
  });
});
