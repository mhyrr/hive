/**
 * Pass TC — Consolidate, gate & principle-coherence (design §8).
 *
 * TC is the taste-track sibling of the fact track's Opus verifier (Pass V). It
 * reads TB's candidates + the existing taste store + `principles.md`, and turns
 * them into routed, gated decisions. Two stages:
 *
 *   1. Deterministic consolidation (no model). Drop session-noise; drop killed
 *      dedupe_keys (negatives); split CONTEXTUAL out to the fact-candidates
 *      queue (taste stays taste); dedupe within the run by stable hash, merging
 *      evidence and counting the number of DISTINCT sessions a judgment recurred
 *      across.
 *   2. One Opus coherence call over rationale: for each survivor, resolve it
 *      against the ~24 apex principles (instantiates / orthogonal / tension),
 *      detect conflicts with existing units, and judge whether the human
 *      explicitly endorsed the rule (the recurrence-gate bypass).
 *
 * Then it routes by tier and upserts each survivor into its category store —
 * `holding` below the recurrence gate, `pending` (review-eligible) above it.
 *
 * Write discipline (design §8 "nothing auto-admits"): TC writes only
 * non-active states. A unit becomes `active` canon ONLY when a human approves it
 * in `hive taste review`. The store-write here is the recurrence accumulator,
 * not admission — `holding` units are never retrieved into a session and never
 * surfaced to review until they cross the gate. This is how a judgment seen on
 * one night persists to be counted on the next without polluting working
 * context; decay sinks the ones that never recur (design §11).
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { completeClaudeText } from "./claude";
import { parseExtractionJson, type ModelCaller } from "./extract";
import { appendCandidate, type CandidateInput } from "./memory";
import type { HivePaths } from "./paths";
import { estimateCost } from "./pricing";
import {
  replayCandidates,
  type ReplayCorpus,
  type ReplayRuleResult,
  type ReplayThresholds,
  type ReplayUsage,
} from "./taste-replay";
import { buildTasteLayer } from "./taste";
import {
  readNegatives,
  readTasteUnits,
  storeDirForScope,
  unitHash,
  writeTasteUnit,
  type TasteUnit,
  type TasteUnitStatus,
} from "./taste-store";
import {
  TASTE_CATEGORIES,
  type ScopeKind,
  type TasteCandidate,
  type TasteCategory,
  type TasteTier,
} from "./taste-types";

// ---------------------------------------------------------------------------
// Model selection (mirrors taste-extract.ts; TC is Opus, like the fact verifier)
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER = "anthropic";
const CONSOLIDATE_MODEL = "claude-opus-4-6";

export function tasteConsolidatorModel(): { provider: string; modelId: string } {
  const override = process.env.HIVE_TASTE_CONSOLIDATE_MODEL;
  if (override && override.includes("/")) {
    const [provider, modelId] = override.split("/", 2);
    return { provider: provider!, modelId: modelId! };
  }
  return {
    provider: process.env.HIVE_TASTE_PROVIDER || DEFAULT_PROVIDER,
    modelId: override || CONSOLIDATE_MODEL,
  };
}

// ---------------------------------------------------------------------------
// Coherence — the one Opus call's output shape (design §8.4)
// ---------------------------------------------------------------------------

export type Coherence = "instantiates" | "orthogonal" | "tension";
const COHERENCE_SET = new Set<string>(["instantiates", "orthogonal", "tension"]);

export interface CoherenceDecision {
  dedupe_key: string;
  coherence: Coherence;
  /** Apex principle (its heading) this instantiates, else null. */
  ladders_up_to: string | null;
  /** If tension: which of the three is true, and why (design §8.4). */
  tension_note: string | null;
  /** dedupe_key of an existing store unit this contradicts, else null. */
  conflict_with: string | null;
  /** The human explicitly endorsed this rule — the recurrence-gate bypass. */
  human_confirmed: boolean;
  note: string;
}

const TC_SYSTEM_PROMPT = `You are the consolidation gate for a taste-memory system. You reason over the RATIONALE of candidate taste rules — never string-matching — and decide how each relates to a small set of apex PRINCIPLES and to the rules already stored.

You are given:
- PRINCIPLES: the ~two-dozen apex principles, verbatim. These are the canon a granular rule may ladder up to.
- EXISTING UNITS: taste rules already in the store (for conflict detection).
- CANDIDATES: new candidate rules to judge.

For EACH candidate, output one object. Output ONLY a JSON array, no prose, no markdown fences:
[{
  "dedupe_key": "<copied verbatim from the candidate>",
  "coherence": "instantiates|orthogonal|tension",
  "ladders_up_to": "<the exact PRINCIPLE heading it instantiates, or null>",
  "tension_note": "<if coherence=tension: state which is true — 'candidate-wrong' | 'principle-too-broad' | 'scoped-exception' — and one sentence why; else null>",
  "conflict_with": "<dedupe_key of an EXISTING UNIT this contradicts, or null>",
  "human_confirmed": <true only if the evidence shows the human EXPLICITLY endorsed this as a rule (e.g. 'yes, always do X', 'remember this'); a one-off correction is NOT an endorsement>,
  "note": "<one sentence of reasoning>"
}]

Rules:
- coherence=instantiates ⇒ the candidate is a specific application of an apex principle; set ladders_up_to to that principle's heading.
- coherence=orthogonal ⇒ stands on its own, no apex principle covers it.
- coherence=tension ⇒ it appears to CONTRADICT an apex principle. Never resolve it yourself; just name which of the three explanations holds.
- Be conservative on human_confirmed and on conflict_with. Default both to false/null unless the evidence is explicit.
- dedupe_key must be copied verbatim so the decision can be matched back.`;

export const __TC_PROMPT = TC_SYSTEM_PROMPT;

// ---------------------------------------------------------------------------
// Rendering the Opus call's input
// ---------------------------------------------------------------------------

function clip(s: string, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function renderCandidateForCoherence(c: TasteCandidate, i: number): string {
  const sec = c.secondary_category ? `/${c.secondary_category}` : "";
  const glob = c.scope.glob ? ` glob=${c.scope.glob}` : "";
  const ev = c.evidence[0]?.quote ? `\n  evidence: "${clip(c.evidence[0]!.quote, 200)}"` : "";
  return [
    `${i + 1}. dedupe_key: ${c.dedupe_key}`,
    `  category: ${c.category}${sec} · tier: ${c.tier} · scope: ${c.scope.kind}${glob} · reason_source: ${c.reason_source}`,
    `  rule: ${clip(c.rule_statement || "(none)", 200)}`,
    `  why: ${clip(c.reasoning, 600)}${ev}`,
  ].join("\n");
}

function renderExistingUnit(u: TasteUnit): string {
  return `- ${u.dedupe_key} [${u.category}]: ${clip(u.rule_statement || u.reasoning, 200)}`;
}

export function buildConsolidateUserContent(
  candidates: TasteCandidate[],
  existing: TasteUnit[],
  principles: string | null,
): string {
  const parts: string[] = [];
  parts.push(`PRINCIPLES:\n${principles?.trim() || "(none configured)"}`);
  parts.push(
    `EXISTING UNITS:\n${existing.length ? existing.map(renderExistingUnit).join("\n") : "(none)"}`,
  );
  parts.push(
    `CANDIDATES (${candidates.length}):\n${candidates.map(renderCandidateForCoherence).join("\n\n")}`,
  );
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Coherence decision validator
// ---------------------------------------------------------------------------

export function validateCoherenceDecision(
  obj: unknown,
  knownKeys: Set<string>,
): CoherenceDecision | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.dedupe_key !== "string" || !knownKeys.has(o.dedupe_key)) return null;
  const coherence = typeof o.coherence === "string" && COHERENCE_SET.has(o.coherence)
    ? (o.coherence as Coherence)
    : "orthogonal";
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : null;
  return {
    dedupe_key: o.dedupe_key,
    coherence,
    ladders_up_to: coherence === "instantiates" ? str(o.ladders_up_to) : null,
    tension_note: coherence === "tension" ? str(o.tension_note) : null,
    conflict_with: str(o.conflict_with),
    human_confirmed: o.human_confirmed === true,
    note: typeof o.note === "string" ? o.note.trim() : "",
  };
}

// ---------------------------------------------------------------------------
// Decision + result shapes
// ---------------------------------------------------------------------------

export type RouteTarget =
  | "category-store" // FUZZY → its category .md
  | "checks" // DETERMINISTIC → checks/ (compiled in phase 3; stored in category .md for now)
  | "fact-candidates" // CONTEXTUAL → handed back to the fact pipeline
  | "dropped-noise" // scope = session-noise
  | "dropped-negative"; // dedupe_key previously killed in review

export interface TasteDecision {
  dedupe_key: string;
  hash: string;
  category: TasteCategory;
  tier: TasteTier;
  scopeKind: ScopeKind;
  routed: RouteTarget;
  /** Combined recurrence after this run (store prior + distinct sessions this run). */
  recurrence: number;
  withinRunRecurrence: number;
  reviewEligible: boolean;
  humanConfirmed: boolean;
  /** Replay verdict (design §9), non-null only when this candidate was judged. */
  replay: ReplayRuleResult | null;
  /** The lifecycle state written to the store (null when not written). */
  status: TasteUnitStatus | null;
  coherence: Coherence | null;
  ladders_up_to: string | null;
  tension_note: string | null;
  /** Hash of the existing unit this conflicts with (resolved from dedupe_key). */
  conflict_with: string | null;
  note: string;
}

export interface TasteConsolidateResult {
  decisions: TasteDecision[];
  written: number;
  reviewEligible: number;
  holding: number;
  /** CONTEXTUAL candidates handed back to the fact pipeline. */
  handoffsToFacts: TasteCandidate[];
  conflicts: TasteDecision[];
  tensions: TasteDecision[];
  newPrincipleProposals: string[];
  droppedNoise: number;
  droppedNegative: number;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
    provider: string;
    model: string;
    usd: number;
  } | null;
  /** Replay judge usage (design §9), separate from the coherence call's. */
  replayUsage: ReplayUsage | null;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Within-run dedupe
// ---------------------------------------------------------------------------

interface DedupedCandidate {
  candidate: TasteCandidate;
  hash: string;
  /** Distinct sessionFiles this judgment showed up in across the run. */
  distinctSessions: number;
}

/**
 * Collapse same-hash candidates from a single run into one, merging evidence and
 * counting how many DISTINCT sessions the judgment recurred across — that count
 * (not raw mention count) is the within-run recurrence credit. The richest
 * candidate (most evidence) wins as the representative.
 */
function dedupeWithinRun(candidates: TasteCandidate[]): DedupedCandidate[] {
  const byHash = new Map<string, { rep: TasteCandidate; sessions: Set<string>; evCount: number }>();
  for (const c of candidates) {
    const hash = unitHash(c);
    const sessions = new Set(c.evidence.map((e) => e.anchor.sessionFile).filter(Boolean));
    const evById = new Map(c.evidence.map((e) => [e.anchor.id, e]));
    const entry = byHash.get(hash);
    if (!entry) {
      byHash.set(hash, { rep: c, sessions, evCount: evById.size });
    } else {
      for (const s of sessions) entry.sessions.add(s);
      // Keep the representative with the most distinct evidence anchors.
      if (evById.size > entry.evCount) {
        entry.rep = c;
        entry.evCount = evById.size;
      } else {
        // Still merge the other candidate's evidence anchors into the rep.
        const seen = new Set(entry.rep.evidence.map((e) => e.anchor.id));
        entry.rep = {
          ...entry.rep,
          evidence: [...entry.rep.evidence, ...c.evidence.filter((e) => !seen.has(e.anchor.id))],
        };
      }
    }
  }
  return [...byHash.entries()].map(([hash, v]) => ({
    candidate: v.rep,
    hash,
    distinctSessions: Math.max(1, v.sessions.size),
  }));
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export interface ConsolidateOptions {
  paths: HivePaths;
  /** Project context for `project`-scoped units. `general-taste` ignores it. */
  projectId: string;
  caller?: ModelCaller;
  /** Apex principles text; loaded from ~/.hive/taste/principles.md if omitted. */
  principlesText?: string | null;
  now?: string;
  /** Recurrence needed to become review-eligible (design §8.2). Default 2. */
  minRecurrence?: number;
  /**
   * Replay eval corpus (design §9), passed IN to keep TC disk-free and
   * hermetically testable (mirrors the orchestrator's transcriptLoader seam).
   * Semantics:
   *   undefined → replay DISABLED — recurrence-only gate (backward compatible).
   *   null / thin → replay INCONCLUSIVE — FUZZY/recurrence-cleared candidates
   *                 stay in holding (precision-weighted: never promote on no evidence).
   *   valid corpus → the one judge call runs over the eligible set.
   */
  replayCorpus?: ReplayCorpus | null;
  /** Override the replay precision/recall/sample thresholds (design §9). */
  replayThresholds?: Partial<ReplayThresholds>;
  /** Also write CONTEXTUAL handoffs to the fact candidates queue. Default true. */
  writeHandoffs?: boolean;
  onProgress?: (m: string) => void;
}

export async function runTasteConsolidate(
  candidates: TasteCandidate[],
  opts: ConsolidateOptions,
): Promise<TasteConsolidateResult> {
  const { paths, projectId } = opts;
  const minRecurrence = opts.minRecurrence ?? 2;
  const writeHandoffs = opts.writeHandoffs ?? true;
  const now = opts.now ?? new Date().toISOString().slice(0, 10);
  const log = opts.onProgress ?? (() => {});

  const result: TasteConsolidateResult = {
    decisions: [],
    written: 0,
    reviewEligible: 0,
    holding: 0,
    handoffsToFacts: [],
    conflicts: [],
    tensions: [],
    newPrincipleProposals: [],
    droppedNoise: 0,
    droppedNegative: 0,
    usage: null,
    replayUsage: null,
    errors: [],
  };

  // --- Stage 1: deterministic partition --------------------------------------
  const negativesByDir = new Map<string, Set<string>>();
  const getNegatives = async (dir: string): Promise<Set<string>> => {
    let n = negativesByDir.get(dir);
    if (!n) {
      n = new Set(await readNegatives(dir));
      negativesByDir.set(dir, n);
    }
    return n;
  };

  const survivors: TasteCandidate[] = [];
  for (const c of candidates) {
    if (c.scope.kind === "session-noise") {
      result.droppedNoise++;
      result.decisions.push(emptyDecision(c, "dropped-noise"));
      continue;
    }
    const dir = storeDirForScope(paths, projectId, c.scope.kind);
    if ((await getNegatives(dir)).has(c.dedupe_key)) {
      result.droppedNegative++;
      result.decisions.push(emptyDecision(c, "dropped-negative"));
      continue;
    }
    if (c.tier === "CONTEXTUAL") {
      result.handoffsToFacts.push(c);
      result.decisions.push(emptyDecision(c, "fact-candidates"));
      continue;
    }
    survivors.push(c);
  }

  // Hand CONTEXTUAL candidates back to the fact-candidates queue (design §5.3, §8.5).
  if (writeHandoffs && result.handoffsToFacts.length > 0) {
    for (const c of result.handoffsToFacts) {
      try {
        const input: CandidateInput = {
          type: "fact",
          content: c.reasoning,
          tags: ["taste-handoff", c.category.toLowerCase()],
          provenanceNote: `TC handoff (CONTEXTUAL): ${c.provenance}`,
        };
        await appendCandidate(paths, projectId, input);
      } catch (err) {
        result.errors.push(`fact-handoff ${c.dedupe_key}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (survivors.length === 0) {
    log("no FUZZY/DETERMINISTIC survivors to consolidate");
    return result;
  }

  // --- Stage 1b: within-run dedupe -------------------------------------------
  const deduped = dedupeWithinRun(survivors);
  log(`${survivors.length} survivors → ${deduped.length} unique after within-run dedupe`);

  // --- Stage 2: one Opus coherence call --------------------------------------
  const principles = opts.principlesText ?? (await buildTasteLayer());
  // Existing units across the stores the survivors touch. `existingAll` feeds
  // the prior-recurrence / lifecycle lookup; for CONFLICT detection we must hide
  // a candidate's own prior version (same hash = a re-observation, not a rival)
  // or the model flags the rule as conflicting with itself on every later night.
  const storeDirs = new Set(deduped.map((d) => storeDirForScope(paths, projectId, d.candidate.scope.kind)));
  const candidateHashes = new Set(deduped.map((d) => d.hash));
  const existingAll: TasteUnit[] = [];
  for (const dir of storeDirs) existingAll.push(...(await readTasteUnits(dir)));
  const existingForConflict = existingAll.filter((u) => !candidateHashes.has(u.hash));

  const coherenceByKey = new Map<string, CoherenceDecision>();
  try {
    const { provider, modelId } = tasteConsolidatorModel();
    const caller = opts.caller ?? defaultConsolidateCaller;
    const dedupeCandidates = deduped.map((d) => d.candidate);
    const completion = await caller({
      provider,
      modelId,
      systemPrompt: TC_SYSTEM_PROMPT,
      userContent: buildConsolidateUserContent(dedupeCandidates, existingForConflict, principles),
    });
    const knownKeys = new Set(dedupeCandidates.map((c) => c.dedupe_key));
    for (const item of parseExtractionJson(completion.text)) {
      const d = validateCoherenceDecision(item, knownKeys);
      if (d) coherenceByKey.set(d.dedupe_key, d);
    }
    const usd = estimateCost({
      provider: completion.provider,
      model: completion.model,
      inputTokens: completion.inputTokens ?? 0,
      outputTokens: completion.outputTokens ?? 0,
    }).totalUsd;
    result.usage = {
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      durationMs: completion.durationMs,
      provider: completion.provider,
      model: completion.model,
      usd,
    };
  } catch (err) {
    // Coherence is enrichment, not a gate — a failed call still routes + writes,
    // just without ladders-up / conflict links. Surface it; don't abort.
    result.errors.push(`coherence call: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Map existing units by dedupe_key so conflict_with (a key) resolves to a hash.
  // Built from the same set the model saw (re-observations excluded).
  const existingByKey = new Map(existingForConflict.map((u) => [u.dedupe_key, u]));

  // --- Stage 2b: gate inputs + replay validation (design §9) -----------------
  // Pre-compute each candidate's recurrence + human-confirmation so we can pick
  // the replay-eligible set, then run ONE judge call over it. Replay slots
  // between the recurrence gate and the store write: recurrence says "this
  // happened more than once," replay says "and a rule for it actually predicts
  // the corrections." Both must pass (humanConfirmed bypasses both).
  interface GateInput {
    d: DedupedCandidate;
    coh: CoherenceDecision | null;
    prior: TasteUnit | undefined;
    combined: number;
    humanConfirmed: boolean;
    recurrencePasses: boolean;
  }
  const gate: GateInput[] = deduped.map((d) => {
    const coh = coherenceByKey.get(d.candidate.dedupe_key) ?? null;
    const prior = existingAll.find((u) => u.hash === d.hash);
    const combined = (prior?.recurrence ?? 0) + d.distinctSessions;
    const humanConfirmed = coh?.human_confirmed ?? false;
    return { d, coh, prior, combined, humanConfirmed, recurrencePasses: combined >= minRecurrence };
  });

  // Replay runs ONLY on candidates that already cleared recurrence AND are FUZZY
  // AND aren't humanConfirmed — bounds the judge to the handful that matter.
  // DETERMINISTIC skips replay (its checks aren't compiled until phase 3);
  // humanConfirmed bypasses it. `replayCorpus === undefined` disables replay
  // (recurrence-only gate, backward compatible). One call, sequenced AFTER the
  // coherence call above — never concurrent (nested-claude contention).
  const replayEnabled = opts.replayCorpus !== undefined;
  const replayByKey = new Map<string, ReplayRuleResult>();
  if (replayEnabled) {
    const eligible = gate.filter(
      (g) => g.d.candidate.tier === "FUZZY" && g.recurrencePasses && !g.humanConfirmed,
    );
    if (eligible.length > 0) {
      const rep = await replayCandidates(
        eligible.map((g) => g.d.candidate),
        opts.replayCorpus ?? null,
        { caller: opts.caller, thresholds: opts.replayThresholds, onProgress: log },
      );
      for (const [k, v] of rep.byKey) replayByKey.set(k, v);
      result.replayUsage = rep.usage;
      if (rep.errors.length) result.errors.push(...rep.errors);
    }
  }

  // --- Stage 3: route, gate, write -------------------------------------------
  let orthogonalEligible = 0;
  for (const g of gate) {
    const { d, coh, prior, combined, humanConfirmed, recurrencePasses } = g;
    const c = d.candidate;
    const dir = storeDirForScope(paths, projectId, c.scope.kind);

    // Replay AND-s into the gate for the eligible set only; everything else
    // (DETERMINISTIC, humanConfirmed, recurrence-failures, replay-off) is not
    // gated by replay. A missing verdict for an eligible candidate means
    // inconclusive (thin corpus / failed judge) ⇒ hold, never promote.
    const replay = replayByKey.get(c.dedupe_key) ?? null;
    let replayPasses = true;
    if (replayEnabled && c.tier === "FUZZY" && recurrencePasses && !humanConfirmed) {
      replayPasses = replay?.passed ?? false;
    }
    const reviewEligible = humanConfirmed || (recurrencePasses && replayPasses);

    // Never demote an already-active unit; otherwise gate decides holding/pending.
    const target: TasteUnitStatus =
      prior?.status === "active" ? "active" : reviewEligible ? "pending" : "holding";

    // Enrich with the laddered principle before persisting.
    const enriched: TasteCandidate = {
      ...c,
      ...(coh?.ladders_up_to ? { ladders_up_hint: coh.ladders_up_to } : {}),
    };

    let status: TasteUnitStatus | null = null;
    let finalRecurrence = combined;
    try {
      const w = await writeTasteUnit(dir, enriched, {
        now,
        status: target,
        addRecurrence: d.distinctSessions,
      });
      status = target;
      // w.recurrence is authoritative (handles the active-no-demote merge path).
      finalRecurrence = w.recurrence;
      result.written++;
      if (target === "pending") result.reviewEligible++;
      if (target === "holding") result.holding++;
    } catch (err) {
      result.errors.push(`write ${c.dedupe_key}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Resolve conflict_with to a hash; never let a unit conflict with itself.
    const rawConflict = coh?.conflict_with ? existingByKey.get(coh.conflict_with)?.hash ?? null : null;
    const conflictHash = rawConflict === d.hash ? null : rawConflict;

    const decision: TasteDecision = {
      dedupe_key: c.dedupe_key,
      hash: d.hash,
      category: c.category,
      tier: c.tier,
      scopeKind: c.scope.kind,
      routed: c.tier === "DETERMINISTIC" ? "checks" : "category-store",
      recurrence: finalRecurrence,
      withinRunRecurrence: d.distinctSessions,
      reviewEligible,
      humanConfirmed,
      replay,
      status,
      coherence: coh?.coherence ?? null,
      ladders_up_to: coh?.ladders_up_to ?? null,
      tension_note: coh?.tension_note ?? null,
      conflict_with: conflictHash,
      note: coh?.note ?? "",
    };
    result.decisions.push(decision);
    if (conflictHash) result.conflicts.push(decision);
    if (decision.coherence === "tension") result.tensions.push(decision);
    if (decision.coherence === "orthogonal" && reviewEligible) orthogonalEligible++;
  }

  // Orphan-cluster signal (design §8.4): a band of review-eligible orphans hints
  // a new apex principle may be emerging. Deterministic + deliberately gentle —
  // a prompt to the curator, never a write.
  if (orthogonalEligible >= 3) {
    result.newPrincipleProposals.push(
      `${orthogonalEligible} review-eligible taste units laddered up to no apex principle — consider whether a new principle is emerging. Inspect the orthogonal decisions and draft one in principles.md if so.`,
    );
  }

  log(
    `wrote ${result.written} (${result.reviewEligible} review-eligible, ${result.holding} holding); ` +
      `${result.conflicts.length} conflicts, ${result.tensions.length} tensions, ${result.handoffsToFacts.length} fact-handoffs`,
  );
  return result;
}

function emptyDecision(c: TasteCandidate, routed: RouteTarget): TasteDecision {
  return {
    dedupe_key: c.dedupe_key,
    hash: unitHash(c),
    category: c.category,
    tier: c.tier,
    scopeKind: c.scope.kind,
    routed,
    recurrence: 0,
    withinRunRecurrence: 0,
    reviewEligible: false,
    humanConfirmed: false,
    replay: null,
    status: null,
    coherence: null,
    ladders_up_to: null,
    tension_note: null,
    conflict_with: null,
    note: "",
  };
}

/**
 * Merge per-project TC results into one aggregate for the combined
 * runs/{DATE}/taste-decisions.{json,md} artifact. The orchestrator runs TC
 * per project (project context drives store routing), but the morning artifact
 * is a single file. Per-project usage records still land authoritatively via
 * appendUsageRecord; the merged `usage` here is only the artifact's summary.
 */
export function mergeConsolidateResults(
  results: TasteConsolidateResult[],
): TasteConsolidateResult {
  const merged: TasteConsolidateResult = {
    decisions: [],
    written: 0,
    reviewEligible: 0,
    holding: 0,
    handoffsToFacts: [],
    conflicts: [],
    tensions: [],
    newPrincipleProposals: [],
    droppedNoise: 0,
    droppedNegative: 0,
    usage: null,
    replayUsage: null,
    errors: [],
  };
  for (const r of results) {
    merged.decisions.push(...r.decisions);
    merged.written += r.written;
    merged.reviewEligible += r.reviewEligible;
    merged.holding += r.holding;
    merged.handoffsToFacts.push(...r.handoffsToFacts);
    merged.conflicts.push(...r.conflicts);
    merged.tensions.push(...r.tensions);
    merged.newPrincipleProposals.push(...r.newPrincipleProposals);
    merged.droppedNoise += r.droppedNoise;
    merged.droppedNegative += r.droppedNegative;
    merged.errors.push(...r.errors);
    if (r.usage) {
      if (!merged.usage) {
        merged.usage = { ...r.usage };
      } else {
        merged.usage.inputTokens = (merged.usage.inputTokens ?? 0) + (r.usage.inputTokens ?? 0);
        merged.usage.outputTokens = (merged.usage.outputTokens ?? 0) + (r.usage.outputTokens ?? 0);
        merged.usage.durationMs = (merged.usage.durationMs ?? 0) + (r.usage.durationMs ?? 0);
        merged.usage.usd += r.usage.usd;
      }
    }
    if (r.replayUsage) {
      if (!merged.replayUsage) {
        merged.replayUsage = { ...r.replayUsage };
      } else {
        merged.replayUsage.inputTokens = (merged.replayUsage.inputTokens ?? 0) + (r.replayUsage.inputTokens ?? 0);
        merged.replayUsage.outputTokens = (merged.replayUsage.outputTokens ?? 0) + (r.replayUsage.outputTokens ?? 0);
        merged.replayUsage.durationMs = (merged.replayUsage.durationMs ?? 0) + (r.replayUsage.durationMs ?? 0);
        merged.replayUsage.usd += r.replayUsage.usd;
      }
    }
  }
  return merged;
}

const defaultConsolidateCaller: ModelCaller = async (input) => {
  const ctrl = new AbortController();
  const timeoutMs = Number(process.env.HIVE_TASTE_CALL_TIMEOUT_MS) || 900_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await completeClaudeText({
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      userContent: input.userContent,
      signal: ctrl.signal,
      disableThinking: true,
    });
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Artifact writers — taste-decisions.{json,md} (design §8 output, §14)
// ---------------------------------------------------------------------------

export async function writeTasteDecisions(
  outDir: string,
  result: TasteConsolidateResult,
  date: string,
): Promise<{ json: string; md: string }> {
  await mkdir(outDir, { recursive: true });
  const jsonPath = join(outDir, "taste-decisions.json");
  const mdPath = join(outDir, "taste-decisions.md");
  await Bun.write(jsonPath, JSON.stringify(result, null, 2));
  await Bun.write(mdPath, renderDecisionsMarkdown(result, date));
  return { json: jsonPath, md: mdPath };
}

export function renderDecisionsMarkdown(result: TasteConsolidateResult, date: string): string {
  const lines: string[] = [];
  lines.push(`# Taste decisions — ${date}`);
  lines.push("");
  lines.push(
    `Wrote ${result.written} units — ${result.reviewEligible} review-eligible (\`hive taste review\`), ` +
      `${result.holding} holding. ${result.conflicts.length} conflicts, ${result.tensions.length} tensions, ` +
      `${result.handoffsToFacts.length} CONTEXTUAL handoffs, ${result.droppedNoise} noise / ${result.droppedNegative} negatives dropped.`,
  );
  lines.push("");

  const eligible = result.decisions.filter((d) => d.reviewEligible && d.status);
  if (eligible.length) {
    lines.push("## Review-eligible");
    for (const d of eligible) lines.push(renderDecisionLine(d));
    lines.push("");
  }
  if (result.tensions.length) {
    lines.push("## Tensions (need a human call)");
    for (const d of result.tensions) {
      lines.push(`${renderDecisionLine(d)}\n  - ${d.tension_note ?? "(no note)"}`);
    }
    lines.push("");
  }
  if (result.conflicts.length) {
    lines.push("## Conflicts with existing units");
    for (const d of result.conflicts) lines.push(`${renderDecisionLine(d)} — conflicts with \`${d.conflict_with}\``);
    lines.push("");
  }
  if (result.newPrincipleProposals.length) {
    lines.push("## New-principle proposals");
    for (const p of result.newPrincipleProposals) lines.push(`- ${p}`);
    lines.push("");
  }
  const holding = result.decisions.filter((d) => d.status === "holding");
  if (holding.length) {
    lines.push(`## Holding (below recurrence gate, accumulating)`);
    for (const d of holding) lines.push(renderDecisionLine(d));
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function renderDecisionLine(d: TasteDecision): string {
  const ladder = d.ladders_up_to ? ` ↑ ${d.ladders_up_to}` : "";
  return `- **${d.dedupe_key}** [${d.category}/${d.tier}] seen ${d.recurrence}× → ${d.status ?? d.routed}${ladder}`;
}

// Re-export for callers that want to render category names.
export { TASTE_CATEGORIES };
