// Forgetting (TK-166): the switches, and neighbour scoping for Pass V.
//
// docs/design/2026-11-23-forgetting.md. Every switch is off by default, so a
// nightly with none of these variables set behaves exactly as before TK-166.
//
//   HIVE_VERIFY_SCOPE=neighbors        Pass V reads each candidate's 20 nearest
//                                      canon entries instead of the whole canon.
//                                      Greg decides this after the shadow week.
//   HIVE_VERIFY_SHADOW=on              Full-canon V decides and applies as usual.
//                                      A second, neighbour-scoped V decides the
//                                      same candidates, writes nothing to canon,
//                                      and a comparison lands in
//                                      runs/{DATE}/verify-shadow.{json,md}.
//                                      Roughly doubles V's spend.
//   HIVE_VERIFY_RETIRE=on              V may retire canon entries on the night's
//                                      evidence (stale, contradicted, trivia).
//                                      Retired entries move to archive.md.
//   HIVE_MEMORY_ARCHIVE_SUPERSEDED=on  A supersede moves the old line to
//                                      archive.md instead of leaving it struck
//                                      through in knowledge.md.

import { bm25Score, buildCorpus } from "./memory";
import type { CanonEntryRef, SerializedCanon } from "./verify";

export type VerifyScope = "full" | "neighbors";

export function verifyScope(): VerifyScope {
  return process.env.HIVE_VERIFY_SCOPE === "neighbors" ? "neighbors" : "full";
}

export function verifyShadowOn(): boolean {
  return process.env.HIVE_VERIFY_SHADOW === "on";
}

export function retireOn(): boolean {
  return process.env.HIVE_VERIFY_RETIRE === "on";
}

export function archiveSupersededOn(): boolean {
  return process.env.HIVE_MEMORY_ARCHIVE_SUPERSEDED === "on";
}

/** Neighbours per candidate. The TK-165 replay found past supersede and merge
 * targets in the BM25 top 20 for 97% (matreas) and 99% (revrec) of decisions. */
export const NEIGHBOR_K = 20;

export interface NeighborSelection {
  /** Hashes of the union of every query's top-k, in canon order. */
  hashes: string[];
  /** Each query's own top-k hashes, best first. */
  perQuery: string[][];
}

/**
 * The top-k canon entries for each query, by BM25 over entry text alone.
 *
 * Text only, on both sides: this is the ranking the TK-165 replay measured, so
 * its coverage numbers hold for exactly this function. (Tags would leak in a
 * replay, because a merge copies the candidate's tags onto its target.) Entries
 * that score zero are never neighbours; a candidate with no word in common with
 * canon brings no neighbours. Ties keep canon order.
 */
export function selectNeighbors(
  entries: Array<Pick<CanonEntryRef, "hash" | "text">>,
  queries: string[],
  k: number = NEIGHBOR_K,
): NeighborSelection {
  const corpus = buildCorpus(entries.map((e) => e.text));
  const union = new Set<string>();
  const perQuery: string[][] = [];
  for (const q of queries) {
    const top = entries
      .map((e, i) => ({ hash: e.hash, i, s: bm25Score(q, e.text, corpus) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s || a.i - b.i)
      .slice(0, k)
      .map((r) => r.hash);
    perQuery.push(top);
    for (const h of top) union.add(h);
  }
  return { hashes: entries.map((e) => e.hash).filter((h) => union.has(h)), perQuery };
}

export function canonEntries(canon: SerializedCanon): CanonEntryRef[] {
  return [...canon.facts, ...canon.conventions, ...canon.decisions, ...canon.questions];
}

/** Bytes an entry adds to V's canon block, measured the way the TK-165 audit
 * measured them, so per-night shares compare with its appendix. */
export function canonEntryBytes(e: Pick<CanonEntryRef, "hash" | "text" | "tags">): number {
  return Buffer.byteLength(JSON.stringify({ hash: e.hash, text: e.text, tags: e.tags }));
}

export interface ScopedCanon {
  canon: SerializedCanon;
  /** Active entries in the full canon. */
  totalEntries: number;
  totalBytes: number;
  shownEntries: number;
  shownBytes: number;
}

/** The canon cut down to the neighbours of `queries`, sections and order kept. */
export function scopeCanon(
  canon: SerializedCanon,
  queries: string[],
  k: number = NEIGHBOR_K,
): ScopedCanon {
  const all = canonEntries(canon);
  const keep = new Set(selectNeighbors(all, queries, k).hashes);
  const pick = (xs: CanonEntryRef[]) => xs.filter((e) => keep.has(e.hash));
  const scoped: SerializedCanon = {
    projectId: canon.projectId,
    facts: pick(canon.facts),
    conventions: pick(canon.conventions),
    decisions: pick(canon.decisions),
    questions: pick(canon.questions),
  };
  const shown = canonEntries(scoped);
  return {
    canon: scoped,
    totalEntries: all.length,
    totalBytes: all.reduce((n, e) => n + canonEntryBytes(e), 0),
    shownEntries: shown.length,
    shownBytes: shown.reduce((n, e) => n + canonEntryBytes(e), 0),
  };
}
