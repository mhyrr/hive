/**
 * Replay validation (design §9) — the fickleness fix. A FUZZY taste candidate
 * is promoted only if it *predicts past corrections*: your correction history
 * is the held-out eval set, no external ground truth needed.
 *
 * Two pure-ish stages:
 *   1. buildReplayCorpus — stride historical events into labeled windows.
 *      detectLoci (taste-segment) supplies ground truth: a window is a
 *      `correction` if it contains a real correction locus, `accepted` if the
 *      human moved on without reacting. Pure, fully unit-testable.
 *   2. replayCandidates — ONE judge call per project over a balanced sample:
 *      "for each rule, would it flag each window?" Score precision + recall vs
 *      the labels (the judge never sees them). Precision is weighted over
 *      recall: a rule that nags accepted work is worse than a silent one
 *      (thesis 3). Judge model is mid-tier (Sonnet) — the task is mechanical.
 *
 * Thin-corpus discipline (design §9, precision-weighted): if there aren't
 * enough labeled windows to evaluate, replay is INCONCLUSIVE — the candidate
 * stays in holding (we do NOT fail open and promote on no evidence), and the
 * inconclusive verdict is logged so it's visible.
 */
import { completeClaudeText } from "./claude";
import { parseExtractionJson, type ModelCaller } from "./extract";
import { estimateCost } from "./pricing";
import { findLoci, type Locus } from "./taste-segment";
import type { SegmentOptions } from "./taste-segment";
import type { TranscriptEvent } from "./transcript";
import type { TasteCandidate } from "./taste-types";

// ---------------------------------------------------------------------------
// Model selection (mirrors taste-extract.ts; the judge is mid-tier — Sonnet)
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER = "anthropic";
const REPLAY_MODEL = "claude-sonnet-4-6";

export function tasteReplayModel(): { provider: string; modelId: string } {
  const override = process.env.HIVE_TASTE_REPLAY_MODEL;
  if (override && override.includes("/")) {
    const [provider, modelId] = override.split("/", 2);
    return { provider: provider!, modelId: modelId! };
  }
  return {
    provider: process.env.HIVE_TASTE_PROVIDER || DEFAULT_PROVIDER,
    modelId: override || REPLAY_MODEL,
  };
}

// ---------------------------------------------------------------------------
// Thresholds — tunable config with the design §9 starting values
// ---------------------------------------------------------------------------

export interface ReplayThresholds {
  /** A rule's flags must land on real corrections this often (the expensive error is a false alarm). */
  precision: number;
  /** And cover at least this fraction of the corrections it claims. */
  recall: number;
  /** Balanced windows sent to the judge in one call. */
  sample: number;
  /** Below this many labeled windows → inconclusive (don't promote on no evidence). */
  minWindows: number;
  /** And we need at least this many of each class for a meaningful score. */
  minPositives: number;
  minNegatives: number;
}

export const DEFAULT_REPLAY_THRESHOLDS: ReplayThresholds = {
  precision: 0.6,
  recall: 0.1,
  sample: 20,
  minWindows: 8,
  minPositives: 2,
  minNegatives: 2,
};

// ---------------------------------------------------------------------------
// Corpus (design §9 eval set)
// ---------------------------------------------------------------------------

export type ReplayLabel = "correction" | "accepted";

export interface ReplayWindow {
  /** Stable, unique within the corpus: `w0`, `w1`, … */
  windowId: string;
  label: ReplayLabel;
  sessionFile: string;
  events: TranscriptEvent[];
}

export interface ReplayCorpus {
  windows: ReplayWindow[];
  positives: number;
  negatives: number;
}

export interface BuildCorpusOptions {
  /** Events per strided window. Default 8 (matches TA-0's locus ± k breadth). */
  windowSize?: number;
  /** Forwarded to findLoci for the locus pass. */
  segmentOptions?: SegmentOptions;
}

// Cues that signal redirection/dissatisfaction — a genuine correction. Anything
// NOT in PRAISE_OR_AMBIGUOUS counts. Praise = approval (a clean negative);
// post-action / always-include alone are too ambiguous to label either way.
const PRAISE_OR_AMBIGUOUS = new Set(["praise", "praise-strong", "post-action", "always-include"]);

function isCorrectionLocus(locus: Locus): boolean {
  return locus.cues.some((c) => !PRAISE_OR_AMBIGUOUS.has(c));
}

function isPraiseLocus(locus: Locus): boolean {
  return locus.cues.some((c) => c === "praise" || c === "praise-strong");
}

function hasAssistantOutput(events: TranscriptEvent[]): boolean {
  return events.some((e) => e.role === "assistant" && (e.kind === "message" || e.kind === "tool_use"));
}

/**
 * Label one strided window by the loci that fall inside it.
 *  - correction: contains a real correction locus (the human redirected).
 *  - accepted:   approved (praise) or untouched assistant output (moved on).
 *  - null:       ambiguous-only loci, or no assistant work — dropped, to keep
 *                labels clean (precision-weighted: fewer clean labels beat noisy ones).
 */
function labelWindow(lociInWindow: Locus[], windowEvents: TranscriptEvent[]): ReplayLabel | null {
  if (lociInWindow.some(isCorrectionLocus)) return "correction";
  const assistantOutput = hasAssistantOutput(windowEvents);
  if (!assistantOutput) return null;
  if (lociInWindow.length === 0) return "accepted"; // assistant produced work, human didn't react
  if (lociInWindow.every(isPraiseLocus)) return "accepted"; // explicitly approved
  return null; // only ambiguous (post-action / always-include) loci
}

/**
 * Stride historical events into labeled windows. Events are grouped by
 * sessionFile so a window never spans sessions; loci are detected once over the
 * full session (the detector's state machine needs the preceding context),
 * then each non-overlapping window inherits the loci whose index falls in range.
 */
export function buildReplayCorpus(
  events: TranscriptEvent[],
  opts: BuildCorpusOptions = {},
): ReplayCorpus {
  const windowSize = Math.max(2, Math.floor(opts.windowSize ?? 8));

  // Group preserving order; events already arrive session-contiguous from the
  // loader, but a flat array is the documented input so we group defensively.
  const bySession = new Map<string, TranscriptEvent[]>();
  for (const e of events) {
    const key = e.anchor.sessionFile || "session";
    const arr = bySession.get(key);
    if (arr) arr.push(e);
    else bySession.set(key, [e]);
  }

  const windows: ReplayWindow[] = [];
  let n = 0;
  for (const [sessionFile, sessionEvents] of bySession) {
    if (sessionEvents.length === 0) continue;
    const loci = findLoci(sessionEvents, opts.segmentOptions);
    for (let start = 0; start < sessionEvents.length; start += windowSize) {
      const end = Math.min(start + windowSize, sessionEvents.length);
      const winEvents = sessionEvents.slice(start, end);
      const lociInWindow = loci.filter((l) => l.index >= start && l.index < end);
      const label = labelWindow(lociInWindow, winEvents);
      if (!label) continue;
      windows.push({ windowId: `w${n++}`, label, sessionFile, events: winEvents });
    }
  }

  return {
    windows,
    positives: windows.filter((w) => w.label === "correction").length,
    negatives: windows.filter((w) => w.label === "accepted").length,
  };
}

// ---------------------------------------------------------------------------
// Judge — one call, rules × a balanced window sample
// ---------------------------------------------------------------------------

const REPLAY_SYSTEM_PROMPT = `You are validating candidate taste rules against a coding agent's transcript history. You are given:
- RULES: candidate taste rules, each with an id (dedupe_key) and its reasoning.
- WINDOWS: slices of past transcript between an AI coding agent and a human, each with an id. The windows are UNLABELED — do not assume any are good or bad.

For EACH rule, decide which windows it WOULD FIRE ON — windows where the rule's specific criterion is present AND the agent's work violates it (so the rule would flag a problem). A rule that predicts where the human actually had to correct the agent is a good rule.

Output ONLY a JSON array, one object per rule, no prose, no markdown fences:
[{"dedupe_key":"<copied verbatim>","flagged":["<windowId>", ...]}]

Rules:
- flagged = the window ids where this rule would genuinely fire. Omit windows it would not flag; an empty array is fine.
- Fire only on a real APPLICATION of the rule — its criterion present and violated — never on mere topical overlap.
- Be precise. A false alarm on good work is the expensive mistake; when unsure, do NOT flag.
- dedupe_key and every windowId copied verbatim.`;

export const __REPLAY_PROMPT = REPLAY_SYSTEM_PROMPT;

function clip(s: string, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function eventLine(e: TranscriptEvent): string {
  if (e.kind === "message") return `${e.role}: ${clip(e.text, 320)}`;
  if (e.kind === "thinking") return `assistant(thinking): ${clip(e.text, 160)}`;
  if (e.kind === "tool_use") {
    const t = e.tool?.target ? ` ${e.tool.target}` : "";
    return `assistant(${e.tool?.name ?? "tool"}${t}): ${clip(e.tool?.summary ?? "", 160)}`;
  }
  if (e.kind === "tool_result") return `tool_result${e.tool?.isError ? "(error)" : ""}: ${clip(e.tool?.summary ?? "", 120)}`;
  return `${e.role}: ${clip(e.text, 120)}`;
}

function renderWindow(w: ReplayWindow): string {
  return `## ${w.windowId}\n${w.events.map(eventLine).join("\n")}`;
}

function renderRule(c: TasteCandidate, i: number): string {
  return `${i + 1}. [${c.dedupe_key}] ${clip(c.rule_statement || c.category, 160)}\n   why: ${clip(c.reasoning, 400)}`;
}

export function buildReplayUserContent(rules: TasteCandidate[], windows: ReplayWindow[]): string {
  return [
    `RULES (${rules.length}):\n${rules.map(renderRule).join("\n")}`,
    `WINDOWS (${windows.length}):\n${windows.map(renderWindow).join("\n\n")}`,
    `For each rule, list the window ids it would fire on.`,
  ].join("\n\n");
}

interface JudgedRule {
  dedupe_key: string;
  flagged: string[];
}

export function validateReplayJudgment(
  obj: unknown,
  knownKeys: Set<string>,
  knownWindowIds: Set<string>,
): JudgedRule | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.dedupe_key !== "string" || !knownKeys.has(o.dedupe_key)) return null;
  const flagged = Array.isArray(o.flagged)
    ? o.flagged.filter((id): id is string => typeof id === "string" && knownWindowIds.has(id))
    : [];
  return { dedupe_key: o.dedupe_key, flagged: [...new Set(flagged)] };
}

// ---------------------------------------------------------------------------
// Scoring + driver
// ---------------------------------------------------------------------------

export interface ReplayRuleResult {
  precision: number | null;
  recall: number | null;
  passed: boolean;
  /** Windows actually judged (the sample size); 0 when inconclusive without a call. */
  evaluated: number;
  /** True ⇒ too little held-out signal to decide; candidate stays in holding. */
  inconclusive: boolean;
}

export interface ReplayUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  provider: string;
  model: string;
  usd: number;
}

export interface ReplayResult {
  byKey: Map<string, ReplayRuleResult>;
  usage: ReplayUsage | null;
  /** Whole-corpus inconclusive (thin) — every rule held. */
  inconclusive: boolean;
  /** Windows sent to the judge. */
  sampled: number;
  positives: number;
  negatives: number;
  errors: string[];
}

export interface ReplayOptions {
  thresholds?: Partial<ReplayThresholds>;
  caller?: ModelCaller;
  onProgress?: (m: string) => void;
}

/**
 * Pick a budget-filling, positives-first window sample. Deterministic (first-N,
 * no RNG) so replay is reproducible. Positives are filled up to half the budget
 * first (never starved), then negatives fill the remainder — giving the judge a
 * rich negative set to be precise against (precision-weighted).
 */
function balancedSample(corpus: ReplayCorpus, sample: number): ReplayWindow[] {
  const pos = corpus.windows.filter((w) => w.label === "correction");
  const neg = corpus.windows.filter((w) => w.label === "accepted");
  const half = Math.max(1, Math.floor(sample / 2));
  const takePos = Math.min(half, pos.length);
  const takeNeg = Math.min(sample - takePos, neg.length);
  return [...pos.slice(0, takePos), ...neg.slice(0, takeNeg)];
}

const CALL_TIMEOUT_MS = Number(process.env.HIVE_TASTE_CALL_TIMEOUT_MS) || 180_000;

const defaultReplayCaller: ModelCaller = async (input) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
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

function inconclusive(rules: TasteCandidate[], corpus: ReplayCorpus | null): ReplayResult {
  const byKey = new Map<string, ReplayRuleResult>();
  for (const r of rules) {
    byKey.set(r.dedupe_key, { precision: null, recall: null, passed: false, evaluated: 0, inconclusive: true });
  }
  return {
    byKey,
    usage: null,
    inconclusive: true,
    sampled: 0,
    positives: corpus?.positives ?? 0,
    negatives: corpus?.negatives ?? 0,
    errors: [],
  };
}

/**
 * Judge each FUZZY candidate against the held-out corpus in ONE call. Returns a
 * per-rule verdict; the caller AND-s `passed` into its promotion gate. A thin
 * corpus short-circuits to inconclusive with NO model call (don't fail open).
 */
export async function replayCandidates(
  rules: TasteCandidate[],
  corpus: ReplayCorpus | null,
  opts: ReplayOptions = {},
): Promise<ReplayResult> {
  const t = { ...DEFAULT_REPLAY_THRESHOLDS, ...opts.thresholds };
  const log = opts.onProgress ?? (() => {});

  if (rules.length === 0) {
    return { byKey: new Map(), usage: null, inconclusive: false, sampled: 0, positives: 0, negatives: 0, errors: [] };
  }

  // Thin-corpus guard — too little held-out signal to decide. Hold, don't promote.
  if (
    !corpus ||
    corpus.windows.length < t.minWindows ||
    corpus.positives < t.minPositives ||
    corpus.negatives < t.minNegatives
  ) {
    log(
      `replay inconclusive: thin corpus (${corpus?.windows.length ?? 0} windows, ` +
        `${corpus?.positives ?? 0}+/${corpus?.negatives ?? 0}−; need ≥${t.minWindows}, ≥${t.minPositives}+, ≥${t.minNegatives}−) — ` +
        `${rules.length} candidate(s) stay in holding`,
    );
    return inconclusive(rules, corpus);
  }

  const sample = balancedSample(corpus, t.sample);
  const sampleIds = new Set(sample.map((w) => w.windowId));
  const posIds = new Set(sample.filter((w) => w.label === "correction").map((w) => w.windowId));

  // posIds can only be empty under a pathological sample budget; treat as inconclusive.
  if (posIds.size === 0) {
    log(`replay inconclusive: sample held no positives (${sample.length} windows)`);
    return inconclusive(rules, corpus);
  }

  const errors: string[] = [];
  const flaggedByKey = new Map<string, Set<string>>();
  let usage: ReplayUsage | null = null;

  try {
    const { provider, modelId } = tasteReplayModel();
    const caller = opts.caller ?? defaultReplayCaller;
    log(`replay: judging ${rules.length} rule(s) over ${sample.length} windows (${posIds.size}+ / ${sample.length - posIds.size}−)`);
    const completion = await caller({
      provider,
      modelId,
      systemPrompt: REPLAY_SYSTEM_PROMPT,
      userContent: buildReplayUserContent(rules, sample),
    });
    const knownKeys = new Set(rules.map((r) => r.dedupe_key));
    for (const item of parseExtractionJson(completion.text)) {
      const j = validateReplayJudgment(item, knownKeys, sampleIds);
      if (j) flaggedByKey.set(j.dedupe_key, new Set(j.flagged));
    }
    usage = {
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      durationMs: completion.durationMs,
      provider: completion.provider,
      model: completion.model,
      usd: estimateCost({
        provider: completion.provider,
        model: completion.model,
        inputTokens: completion.inputTokens ?? 0,
        outputTokens: completion.outputTokens ?? 0,
      }).totalUsd,
    };
  } catch (err) {
    // A failed judge call is INCONCLUSIVE (hold), not a pass — never fail open.
    const msg = err instanceof Error ? err.message : String(err);
    log(`replay judge call failed: ${msg} — ${rules.length} candidate(s) stay in holding`);
    const res = inconclusive(rules, corpus);
    res.errors.push(`replay judge call: ${msg}`);
    return res;
  }

  const byKey = new Map<string, ReplayRuleResult>();
  for (const r of rules) {
    const flagged = flaggedByKey.get(r.dedupe_key) ?? new Set<string>();
    let tp = 0;
    for (const id of flagged) if (posIds.has(id)) tp++;
    const precision = flagged.size > 0 ? tp / flagged.size : 0;
    const recall = tp / posIds.size;
    const passed = precision >= t.precision && recall >= t.recall;
    byKey.set(r.dedupe_key, { precision, recall, passed, evaluated: sample.length, inconclusive: false });
  }

  return {
    byKey,
    usage,
    inconclusive: false,
    sampled: sample.length,
    positives: posIds.size,
    negatives: sample.length - posIds.size,
    errors,
  };
}
