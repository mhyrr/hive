#!/usr/bin/env bun
// Offline replay of neighbour-scoped Pass V (TK-166). No model calls.
//
// For each night, it takes the candidates Pass V saw (candidates.B.<p>.json and
// candidates.consumed.<p>.md) and the canon as of that night, and asks the
// production selector (src/lib/forgetting.ts selectNeighbors) two questions:
//
//   1. Scope: how much of canon do the top-k neighbours of all the night's
//      candidates cover? Printed in the TK-165 audit's appendix format, so the
//      lines can be compared with docs/design/2026-11-23-forgetting.md.
//   2. Coverage: for each supersede or merge V made that night, was its target
//      among the candidate's top-k neighbours?
//
// It reads copies, never ~/.hive/memory itself:
//
//   bun scripts/forgetting-replay.ts --snap <dir> --runs <dir> --project matreas \
//     [--dates 2026-10-27,2026-11-03] [--k 20]
//
//   --snap  a directory of <project>/knowledge.md + <project>/_meta.json copies
//   --runs  a directory of <DATE>/ run folders (copies of ~/.hive/memory/runs/<DATE>)
//
// Method, matching the audit: "canon that night" is the snapshot's active
// entries whose meta createdAt is before the night's date. For coverage, the
// pool also keeps superseded entries (the target may have been superseded
// since) and always includes the target itself.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { entryHash, readMeta, readProjectMemorySnapshot } from "../src/lib/memory";
import { canonEntryBytes, NEIGHBOR_K, selectNeighbors } from "../src/lib/forgetting";
import type { HivePaths } from "../src/lib/paths";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const snap = arg("snap");
const runs = arg("runs");
const project = arg("project");
const k = Number(arg("k") ?? NEIGHBOR_K);
if (!snap || !runs || !project) {
  console.error("usage: bun scripts/forgetting-replay.ts --snap <dir> --runs <dir> --project <p> [--dates d1,d2] [--k 20]");
  process.exit(2);
}
const dates = (arg("dates")?.split(",") ?? readdirSync(runs).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).sort();

const paths = { memoryProjectsDir: snap } as HivePaths;
const snapshot = await readProjectMemorySnapshot(paths, project);
const meta = await readMeta(paths, project);
const all = [...snapshot.facts, ...snapshot.conventions, ...snapshot.decisions, ...snapshot.questions].map((e) => {
  const hash = entryHash(e.text);
  return {
    hash,
    text: e.text,
    tags: e.tags,
    superseded: e.superseded === true,
    created: meta.entries[hash]?.createdAt ?? "0000",
  };
});
const active = all.filter((e) => !e.superseded);

function candidatesOf(date: string): { b: string[]; mid: string[] } {
  const b: string[] = [];
  const mid: string[] = [];
  const bPath = join(runs!, date, `candidates.B.${project}.json`);
  if (existsSync(bPath)) {
    try {
      for (const c of JSON.parse(readFileSync(bPath, "utf-8")).candidates ?? []) b.push(c.content);
    } catch {
      // intentional: a malformed artifact contributes no candidates
    }
  }
  const mPath = join(runs!, date, `candidates.consumed.${project}.md`);
  if (existsSync(mPath)) {
    for (const line of readFileSync(mPath, "utf-8").split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        mid.push(JSON.parse(line).content);
      } catch {
        // intentional: skip a torn JSONL line, as readCandidates does
      }
    }
  }
  return { b, mid };
}

const kb = (n: number) => Math.round(n / 1024);
let tested = 0;
let hits = 0;
console.log(`== ${project} (k=${k})`);
for (const date of dates) {
  const { b, mid } = candidatesOf(date);
  const cands = [...b, ...mid];
  if (cands.length === 0) continue;

  // 1. Scope
  const pool = active.filter((e) => e.created < date);
  const poolBytes = pool.reduce((s, e) => s + canonEntryBytes(e), 0);
  const scope = new Set(selectNeighbors(pool, cands, k).hashes);
  const shownBytes = pool.filter((e) => scope.has(e.hash)).reduce((s, e) => s + canonEntryBytes(e), 0);
  const line =
    `${date} cands=${String(cands.length).padStart(3)} canon=${pool.length}/${kb(poolBytes)}KB  ` +
    `k${k}=${scope.size}/${kb(shownBytes)}KB(${Math.round((100 * shownBytes) / Math.max(1, poolBytes))}%)`;

  // 2. Coverage of that night's supersede/merge targets
  const decPath = join(runs!, date, "decisions.json");
  let nightTested = 0;
  let nightHits = 0;
  if (existsSync(decPath)) {
    const decisions = (JSON.parse(readFileSync(decPath, "utf-8")).decisions ?? []) as Array<{
      candidate_id: string;
      action: string;
      target_hash?: string;
    }>;
    for (const d of decisions) {
      if (!d.target_hash || (d.action !== "supersede" && d.action !== "merge")) continue;
      const m = /^(B|candidates)\.([^[]+)\[(\d+)\]$/.exec(d.candidate_id);
      if (!m || m[2] !== project) continue;
      const cand = (m[1] === "B" ? b : mid)[Number(m[3])];
      if (!cand || !all.some((e) => e.hash === d.target_hash)) continue;
      const covPool = all.filter((e) => e.created < date || e.hash === d.target_hash);
      const top = selectNeighbors(covPool, [cand], k).perQuery[0]!;
      nightTested++;
      if (top.includes(d.target_hash)) nightHits++;
    }
  }
  tested += nightTested;
  hits += nightHits;
  console.log(`${line}  targets in top ${k}: ${nightHits}/${nightTested}`);
}
console.log(`targets in top ${k}, all nights: ${hits}/${tested}${tested ? ` = ${Math.round((100 * hits) / tested)}%` : ""}`);
