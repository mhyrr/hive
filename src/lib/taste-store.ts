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

export type TasteUnitStatus = "pending" | "active";

/** A taste candidate as persisted, plus store-managed lifecycle fields. */
export interface TasteUnit extends TasteCandidate {
  /** Stable identity = entryHash(dedupe_key || reasoning). Keys the meta sidecar. */
  hash: string;
  /** Times this judgment has been observed (TC bumps; recurrence gate reads). */
  recurrence: number;
  /** pending until TC promotes on recurrence/confirmation (design §8.2). */
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
 * `pending` with a fresh meta entry. Reorganizes, never destroys evidence
 * (design §4e): a re-observation merges its evidence anchors in.
 */
export async function writeTasteUnit(
  storeDir: string,
  candidate: TasteCandidate,
  opts: { now?: string; status?: TasteUnitStatus } = {},
): Promise<WriteTasteResult> {
  await mkdir(storeDir, { recursive: true });
  const category = candidate.category;
  const hash = unitHash(candidate);
  const now = opts.now ?? new Date().toISOString().slice(0, 10);

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
      recurrence: prev.recurrence + 1,
      status: opts.status ?? prev.status,
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
      recurrence: 1,
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

  const units = await readTasteUnits(storeDir, opts.category);
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
