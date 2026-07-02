/**
 * The taste store (design §7) — a category-sharded memory store wearing a taste
 * hat. It is NOT a new search engine: it reuses memory.ts's pure functions
 * (entryHash, entryStrength, bumpRecall, BM25) and only adds a thin file layer,
 * because memory.ts's high-level API hardcodes knowledge.md + four fixed headers
 * and so cannot operate on a <category>.md shard.
 *
 * Layout (per design §7.1):
 *   <storeDir>/<category>.md   one file per category, FUZZY units as markdown
 *   <storeDir>/_meta.json      strength/decay sidecar — the SAME shape memory.ts uses
 *
 * A unit's structured fields live in a `<!-- taste:unit {json} -->` comment (the
 * parse source of truth); the surrounding markdown is the human-readable face.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  bm25Score,
  buildCorpus,
  bumpRecall,
  createEntryMeta,
  entryHash,
  entryStrength,
  memoryProjectDir,
  type EntryMeta,
  type MetaSidecar,
} from "./memory";
import type { HivePaths } from "./paths";
import { TASTE_CATEGORIES, type TasteCandidate, type TasteCategory } from "./taste-types";

// ---------------------------------------------------------------------------
// Stored shape
// ---------------------------------------------------------------------------

/**
 * Lifecycle, in order (design §8.2, §10):
 *   holding  — written, below the recurrence gate. Accumulates recurrence across
 *              nights; never retrieved into a session, never surfaced to review.
 *              This is the design's "first-sighting waits in a pending state."
 *   pending  — past the recurrence (+ replay) gate, awaiting human sign-off.
 *              `hive taste review` walks exactly these.
 *   active   — human-approved canon; retrievable into working sessions.
 * A unit only ever moves forward (see maxStatus) — re-observation never demotes.
 */
export type TasteUnitStatus = "holding" | "pending" | "active";

const STATUS_RANK: Record<TasteUnitStatus, number> = { holding: 0, pending: 1, active: 2 };

/** Monotonic lifecycle: re-observing a unit can promote it, never demote it. */
function maxStatus(a: TasteUnitStatus, b: TasteUnitStatus): TasteUnitStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

/** A taste candidate as persisted, plus store-managed lifecycle fields. */
export interface TasteUnit extends TasteCandidate {
  /** Stable identity = entryHash(dedupe_key || reasoning). Keys the meta sidecar. */
  hash: string;
  /** Times this judgment has been observed (TC bumps; recurrence gate reads). */
  recurrence: number;
  /** holding → pending → active (design §8.2). */
  status: TasteUnitStatus;
  firstSeen: string;
  lastSeen: string;
}

// ---------------------------------------------------------------------------
// Locations (design §7.1) — project store vs. cross-project general store
// ---------------------------------------------------------------------------

export function projectTasteDir(paths: HivePaths, projectId: string): string {
  return join(memoryProjectDir(paths, projectId), "taste");
}

export function generalTasteDir(paths: HivePaths): string {
  return join(paths.memoryDir, "taste");
}

/** Route a candidate to its store dir by scope: general-taste → cross-project. */
export function storeDirForScope(
  paths: HivePaths,
  projectId: string,
  scopeKind: TasteCandidate["scope"]["kind"],
): string {
  return scopeKind === "general-taste" ? generalTasteDir(paths) : projectTasteDir(paths, projectId);
}

const CATEGORY_SLUG: Record<TasteCategory, string> = {
  IDEAS: "ideas",
  DESIGN: "design",
  IMPLEMENTATION: "implementation",
  TEST_EVAL: "test-eval",
  COMMUNICATION: "communication",
  PROCESS: "process",
};

function categoryFile(storeDir: string, category: TasteCategory): string {
  return join(storeDir, `${CATEGORY_SLUG[category]}.md`);
}

function metaFile(storeDir: string): string {
  return join(storeDir, "_meta.json");
}

// ---------------------------------------------------------------------------
// Identity, meta, search text
// ---------------------------------------------------------------------------

export function unitHash(candidate: TasteCandidate): string {
  return entryHash(candidate.dedupe_key?.trim() || candidate.reasoning);
}

/** The text BM25 scores against — what a reader would search for. */
function unitText(u: TasteCandidate): string {
  return [u.rule_statement, u.reasoning, u.canonical_example?.bad, u.canonical_example?.good]
    .filter(Boolean)
    .join(" ");
}

async function readTasteMeta(storeDir: string): Promise<MetaSidecar> {
  const file = Bun.file(metaFile(storeDir));
  try {
    if (await file.exists()) return await file.json();
  } catch {
    // intentional: corrupted meta — start fresh
  }
  return { entries: {}, version: 1 };
}

async function writeTasteMeta(storeDir: string, meta: MetaSidecar): Promise<void> {
  await mkdir(storeDir, { recursive: true });
  await Bun.write(metaFile(storeDir), JSON.stringify(meta, null, 2));
}

// ---------------------------------------------------------------------------
// Serialize / parse
// ---------------------------------------------------------------------------

function serializeUnit(u: TasteUnit): string {
  const ev = u.evidence
    .map((e) => `- "${e.quote}" — \`${e.anchor.id}\``)
    .join("\n");
  const glob = u.scope.glob ? ` · \`${u.scope.glob}\`` : "";
  const secondary = u.secondary_category ? ` (+${u.secondary_category})` : "";
  const ladders = u.ladders_up_hint ? `\n\n**Ladders up to:** ${u.ladders_up_hint}` : "";
  return [
    `### ${u.rule_statement || u.category}`,
    ``,
    `_${u.category}${secondary} · ${u.tier} · ${u.scope.kind}${glob} · ${u.reason_source} · seen ${u.recurrence}× · ${u.status}_`,
    ``,
    `**Why:** ${u.reasoning}`,
    ``,
    `**Bad:** ${u.canonical_example?.bad ?? "—"}`,
    `**Good:** ${u.canonical_example?.good ?? "—"}`,
    ``,
    `**Evidence:**\n${ev}`,
    ladders,
    ``,
    `<!-- taste:unit ${JSON.stringify(u)} -->`,
  ].join("\n");
}

const UNIT_COMMENT = /<!--\s*taste:unit\s*(\{[\s\S]*?\})\s*-->/g;

function parseUnits(content: string): TasteUnit[] {
  const units: TasteUnit[] = [];
  for (const m of content.matchAll(UNIT_COMMENT)) {
    try {
      units.push(JSON.parse(m[1]!) as TasteUnit);
    } catch {
      // intentional: skip a corrupted unit block rather than failing the file
    }
  }
  return units;
}

const FILE_HEADER = (category: TasteCategory) =>
  `# Taste — ${category}\n\n> Category-sharded taste units. Generated by HIVE's taste pipeline; edit via \`hive taste review\`.\n`;

function renderCategoryFile(category: TasteCategory, units: TasteUnit[]): string {
  return [FILE_HEADER(category), ...units.map(serializeUnit)].join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export async function readTasteUnits(
  storeDir: string,
  category?: TasteCategory,
): Promise<TasteUnit[]> {
  const cats = category ? [category] : TASTE_CATEGORIES;
  const out: TasteUnit[] = [];
  for (const cat of cats) {
    const file = Bun.file(categoryFile(storeDir, cat));
    if (await file.exists()) out.push(...parseUnits(await file.text()));
  }
  return out;
}

export interface WriteTasteResult {
  hash: string;
  isNew: boolean;
  recurrence: number;
}

/**
 * Upsert a candidate into its category file. A re-observed unit (same hash)
 * bumps recurrence and lastSeen rather than duplicating; a new unit is created
 * `pending` (the default; TC passes `holding` explicitly for first-sightings)
 * with a fresh meta entry. Reorganizes, never destroys evidence (design §4e):
 * a re-observation merges its evidence anchors in.
 *
 * `addRecurrence` is how much to credit this observation. Default 1 (one more
 * night/session). TC passes the count of *distinct sessions* a judgment recurred
 * across within a single run, so a historical sweep can surface a genuinely
 * recurring rule on its first consolidation instead of waiting N nights.
 */
export async function writeTasteUnit(
  storeDir: string,
  candidate: TasteCandidate,
  opts: { now?: string; status?: TasteUnitStatus; addRecurrence?: number } = {},
): Promise<WriteTasteResult> {
  await mkdir(storeDir, { recursive: true });
  const category = candidate.category;
  const hash = unitHash(candidate);
  const now = opts.now ?? new Date().toISOString().slice(0, 10);
  const add = Math.max(1, Math.floor(opts.addRecurrence ?? 1));

  const existing = await readTasteUnits(storeDir, category);
  const idx = existing.findIndex((u) => u.hash === hash);

  let unit: TasteUnit;
  let isNew: boolean;
  if (idx >= 0) {
    const prev = existing[idx]!;
    // Merge evidence anchors without duplicating (by anchor id).
    const seen = new Set(prev.evidence.map((e) => e.anchor.id));
    const mergedEvidence = [...prev.evidence, ...candidate.evidence.filter((e) => !seen.has(e.anchor.id))];
    unit = {
      ...candidate,
      hash,
      recurrence: prev.recurrence + add,
      // Monotonic: a re-observation can promote (holding→pending) but never demote.
      status: maxStatus(prev.status, opts.status ?? prev.status),
      firstSeen: prev.firstSeen,
      lastSeen: now,
      evidence: mergedEvidence,
    };
    existing[idx] = unit;
    isNew = false;
  } else {
    unit = {
      ...candidate,
      hash,
      recurrence: add,
      status: opts.status ?? "pending",
      firstSeen: now,
      lastSeen: now,
    };
    existing.push(unit);
    isNew = true;
  }

  await Bun.write(categoryFile(storeDir, category), renderCategoryFile(category, existing));

  // Manage the decay sidecar: create on first sight, preserve on re-observe.
  const meta = await readTasteMeta(storeDir);
  if (!meta.entries[hash]) meta.entries[hash] = createEntryMeta();
  await writeTasteMeta(storeDir, meta);

  return { hash, isNew, recurrence: unit.recurrence };
}

// ---------------------------------------------------------------------------
// Curation lifecycle — promote / reject / negatives (design §10)
// ---------------------------------------------------------------------------

export async function listPendingUnits(storeDir: string): Promise<TasteUnit[]> {
  return (await readTasteUnits(storeDir)).filter((u) => u.status === "pending");
}

/** Flip a unit's status (e.g. pending → active on human approval). */
export async function setUnitStatus(
  storeDir: string,
  hash: string,
  status: TasteUnitStatus,
): Promise<boolean> {
  for (const cat of TASTE_CATEGORIES) {
    const units = await readTasteUnits(storeDir, cat);
    const idx = units.findIndex((u) => u.hash === hash);
    if (idx >= 0) {
      units[idx] = { ...units[idx]!, status };
      await Bun.write(categoryFile(storeDir, cat), renderCategoryFile(cat, units));
      return true;
    }
  }
  return false;
}

/** Drop a unit from its category file and its decay sidecar. */
export async function removeUnit(storeDir: string, hash: string): Promise<boolean> {
  for (const cat of TASTE_CATEGORIES) {
    const units = await readTasteUnits(storeDir, cat);
    const next = units.filter((u) => u.hash !== hash);
    if (next.length !== units.length) {
      await Bun.write(categoryFile(storeDir, cat), renderCategoryFile(cat, next));
      const meta = await readTasteMeta(storeDir);
      delete meta.entries[hash];
      await writeTasteMeta(storeDir, meta);
      return true;
    }
  }
  return false;
}

function negativesFile(storeDir: string): string {
  return join(storeDir, "_negatives.json");
}

export async function readNegatives(storeDir: string): Promise<string[]> {
  const f = Bun.file(negativesFile(storeDir));
  try {
    if (await f.exists()) return await f.json();
  } catch {
    // intentional: corrupted negatives — start fresh
  }
  return [];
}

/** Record a killed unit's dedupe_key so it isn't re-proposed (design §10). */
export async function recordNegative(storeDir: string, dedupeKey: string): Promise<void> {
  const negs = await readNegatives(storeDir);
  if (!negs.includes(dedupeKey)) {
    negs.push(dedupeKey);
    await mkdir(storeDir, { recursive: true });
    await Bun.write(negativesFile(storeDir), JSON.stringify(negs, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Search — BM25 × strength × decay, category-prefiltered, top-K + floor (§7.2)
// ---------------------------------------------------------------------------

export interface TasteSearchResult {
  unit: TasteUnit;
  score: number;
  strength: number;
}

export interface TasteSearchOptions {
  category?: TasteCategory;
  topK?: number;
  /** Drop hits below this fraction of the top hit's score. */
  floor?: number;
  /** Skip the recall-strengthening write (e.g. dry inspection). */
  noBump?: boolean;
}

export async function searchTasteStore(
  storeDir: string,
  query: string,
  opts: TasteSearchOptions = {},
): Promise<TasteSearchResult[]> {
  const topK = opts.topK ?? 5;
  const floor = opts.floor ?? 0.25;

  // Retrieval guard (design §7.2): only ACTIVE (human-approved) units may enter
  // a working session. holding/pending are accumulating/awaiting-review — never
  // retrieved, so an un-curated judgment can't leak into context as if it were canon.
  const units = (await readTasteUnits(storeDir, opts.category)).filter((u) => u.status === "active");
  if (units.length === 0) return [];

  const meta = await readTasteMeta(storeDir);
  const texts = units.map(unitText);
  const corpus = buildCorpus(texts);

  const scored = units
    .map((unit, i) => {
      const strength = entryStrength(meta.entries[unit.hash]);
      return { unit, strength, score: bm25Score(query, texts[i]!, corpus) * strength };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return [];
  const top = scored[0]!.score;
  const kept = scored.filter((r) => r.score >= floor * top).slice(0, topK);

  // Retrieval strengthening: each recalled unit's decay clock resets a little.
  if (!opts.noBump && kept.length > 0) {
    for (const r of kept) {
      const m = meta.entries[r.unit.hash];
      if (m) meta.entries[r.unit.hash] = bumpRecall(m);
    }
    await writeTasteMeta(storeDir, meta);
  }

  return kept;
}

export interface TasteWorkSearchOptions {
  query?: string;
  topK?: number;
}

/**
 * Work-type retrieval — the in-session entry point (TK-132). The category IS the
 * retrieval key: the model picks the kind of work it's doing (IDEAS, DESIGN,
 * IMPLEMENTATION, TEST_EVAL, COMMUNICATION, PROCESS) and gets back the taste for
 * it. Merges the cross-project general store with the project's own store, and —
 * via searchTasteStore's guard — returns only ACTIVE (human-approved) units, so
 * a holding/pending judgment can never leak in as if it were canon.
 *
 * With a `query`, ranks BM25 × decay-strength within the category. Without one,
 * browses: every active unit in the category, ranked by strength × recurrence so
 * the most-recalled, most-recurring lead.
 */
export async function searchTasteForWork(
  paths: HivePaths,
  projectId: string | null,
  category: TasteCategory,
  opts: TasteWorkSearchOptions = {},
): Promise<TasteSearchResult[]> {
  const topK = opts.topK ?? 5;
  const query = (opts.query ?? "").trim();

  // General store first (general-taste applies everywhere), then the project's.
  const dirs = [generalTasteDir(paths)];
  if (projectId) dirs.push(projectTasteDir(paths, projectId));

  const merged: TasteSearchResult[] = [];
  for (const dir of dirs) {
    if (query) {
      merged.push(...(await searchTasteStore(dir, query, { category, topK })));
    } else {
      // Browse: active units in the category, ranked by strength × recurrence.
      const meta = await readTasteMeta(dir);
      const units = (await readTasteUnits(dir, category)).filter((u) => u.status === "active");
      for (const unit of units) {
        const strength = entryStrength(meta.entries[unit.hash]);
        merged.push({ unit, strength, score: strength * Math.max(1, unit.recurrence) });
      }
    }
  }

  return merged.sort((a, b) => b.score - a.score).slice(0, topK);
}
