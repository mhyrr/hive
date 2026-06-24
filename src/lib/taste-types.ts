/**
 * Shared contract for the taste-extraction passes (design §4, §5). Kept in one
 * place so TA-0 (segment), TA-1 (flag), TB (analyze), and the CLI agree on the
 * shapes that flow between them.
 */
import type { EventAnchor, TranscriptEvent } from "./transcript";

// ---------------------------------------------------------------------------
// Taxonomies (design §4.1, §5.2, §5.3)
// ---------------------------------------------------------------------------

/** The divergence taxonomy a flag can carry (design §4a). */
export const DIVERGENCE_TYPES = [
  "CORRECTION",
  "REWRITE",
  "DISSATISFACTION",
  "REDO",
  "PREFERENCE",
  "SELF_CORRECTION",
  "ABANDONED_PATH",
  "PRAISE",
] as const;
export type DivergenceType = (typeof DIVERGENCE_TYPES)[number];

/** Which facet of the work a judgment governs — the retrieval key (design §5.3). */
export const TASTE_CATEGORIES = [
  "IDEAS",
  "DESIGN",
  "IMPLEMENTATION",
  "TEST_EVAL",
  "COMMUNICATION",
  "PROCESS",
] as const;
export type TasteCategory = (typeof TASTE_CATEGORIES)[number];

/** How a unit is enforced (design §5.3). */
export const TASTE_TIERS = ["DETERMINISTIC", "FUZZY", "CONTEXTUAL"] as const;
export type TasteTier = (typeof TASTE_TIERS)[number];

/** Breadth of activation (design §5.3). */
export const SCOPE_KINDS = ["project", "general-taste", "session-noise"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export type ReasonSource = "stated" | "inferred";

// ---------------------------------------------------------------------------
// TA-0 — mechanical segmentation output
// ---------------------------------------------------------------------------

/** Which kind of divergence locus seeded a window (design §4.1). */
export type LocusKind = "human-reaction" | "self-correction";

/** A contiguous slice of events centered on a likely divergence locus. */
export interface DivergenceWindow {
  /** Stable id: `${sessionBasename}:${locusLine}`. */
  windowId: string;
  /** The locus event's anchor — the flag location. */
  anchor: EventAnchor;
  locusKind: LocusKind;
  /** First / last event anchor id in the window (re-expandable by TB). */
  startId: string;
  endId: string;
  /** The mechanical cues that promoted this locus (auditability). */
  cues: string[];
  /** The window's events, in order. */
  events: TranscriptEvent[];
}

// ---------------------------------------------------------------------------
// TA-1 — Haiku flag output (design §4.1)
// ---------------------------------------------------------------------------

export interface TasteFlag {
  /** Back-reference to the TA-0 window TB re-expands. */
  windowId: string;
  anchor: { sessionFile: string; id: string; ts: string | null };
  window: { startId: string; endId: string };
  type_guess: DivergenceType;
  trigger_quote: string;
  crude_confidence: number;
}

// ---------------------------------------------------------------------------
// TB — Opus taste candidate (design §5.2)
// ---------------------------------------------------------------------------

export interface TasteScope {
  kind: ScopeKind;
  /** Tech-specificity rides here, not in the category. */
  glob?: string;
}

export interface TasteEvidence {
  anchor: { sessionFile: string; id: string; ts: string | null };
  quote: string;
  confidence: number;
}

export interface TasteCandidate {
  category: TasteCategory;
  /** Optional secondary facet (primary required, secondary optional — §5.3). */
  secondary_category?: TasteCategory;
  tier: TasteTier;
  scope: TasteScope;
  /** WHY, in prose. The load-bearing field (planning thesis 5). */
  reasoning: string;
  delta: { before: string; after: string };
  reason_source: ReasonSource;
  /** Scannable summary, explicitly NOT the source of truth. */
  rule_statement: string;
  canonical_example: { bad: string; good: string };
  /** Pseudo-rule a linter/semgrep/credo could run; null unless DETERMINISTIC. */
  check_sketch: string | null;
  evidence: TasteEvidence[];
  dedupe_key: string;
  /** Apex principle this seems to instantiate (TC confirms in phase 2). */
  ladders_up_hint?: string;
  /** Verifier-checkable, citing the anchor — matches existing candidate discipline. */
  provenance: string;
}
