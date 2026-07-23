/**
 * Pass TA-1 (Haiku flag) + Pass TB (Opus analyze) — design §4.1, §5.
 *
 * These ride the existing extraction plumbing: the `ModelCaller` seam,
 * `parseExtractionJson`, the validate-each-element discipline, and
 * `estimateCost`. TA-1 classifies the mechanically-segmented windows; TB reads
 * the survivors fully and emits typed taste candidates carrying reasoning +
 * immutable evidence. Most flags do not survive TB — that is the design.
 */
import { completeClaudeText } from "./claude";
import { parseExtractionJson, type ModelCaller } from "./extract";
import { estimateCost } from "./pricing";
import { segmentWindows, type SegmentOptions } from "./taste-segment";
import type { LoadedTranscript, TranscriptEvent } from "./transcript";
import {
  DIVERGENCE_TYPES,
  SCOPE_KINDS,
  TASTE_CATEGORIES,
  TASTE_TIERS,
  type DivergenceType,
  type DivergenceWindow,
  type TasteCandidate,
  type TasteCategory,
  type TasteFlag,
  type TasteTier,
} from "./taste-types";

// ---------------------------------------------------------------------------
// Model selection (mirrors extract.ts extractorModel / verify.ts verifierModel)
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER = "anthropic";
const CLASSIFY_MODEL = "claude-haiku-4-5";
const ANALYZE_MODEL = "claude-opus-4-6";

function resolveModel(envVar: string, fallback: string): { provider: string; modelId: string } {
  const override = process.env[envVar];
  if (override && override.includes("/")) {
    const [provider, modelId] = override.split("/", 2);
    return { provider: provider!, modelId: modelId! };
  }
  return {
    provider: process.env.HIVE_TASTE_PROVIDER || DEFAULT_PROVIDER,
    modelId: override || fallback,
  };
}

export const tasteClassifierModel = () => resolveModel("HIVE_TASTE_CLASSIFY_MODEL", CLASSIFY_MODEL);
export const tasteAnalyzerModel = () => resolveModel("HIVE_TASTE_ANALYZE_MODEL", ANALYZE_MODEL);

// Bound each model call so a stuck `claude --print` surfaces as a per-session
// error (caught by runTasteExtract's isolation) instead of hanging the run.
const CALL_TIMEOUT_MS = Number(process.env.HIVE_TASTE_CALL_TIMEOUT_MS) || 900_000;

const defaultCaller: ModelCaller = async (input) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  try {
    return await completeClaudeText({
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      userContent: input.userContent,
      signal: ctrl.signal,
      // Classify + extract don't need extended thinking; it only adds latency.
      disableThinking: true,
    });
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Prompts — the load-bearing artifacts (design §4.1, §5.4)
// ---------------------------------------------------------------------------

const TA_FLAG_SYSTEM_PROMPT = `You are a fast, high-recall classifier locating DIVERGENCE events in transcripts of an AI coding agent working with a human.

A divergence is a moment where work was redirected — the signal taste lives in:
- CORRECTION: the human corrects the agent's output ("no, do X instead").
- REWRITE: the human asks for a rework of something just produced.
- DISSATISFACTION: the human signals the output is off (too verbose, too clever, wrong).
- REDO: the human asks to redo / try again.
- PREFERENCE: the human states a preference about how it should be done.
- SELF_CORRECTION: the agent reverses itself — re-edits the same file, reverts (git checkout/revert), undoes a change — with no human prompt.
- ABANDONED_PATH: the agent starts an approach then abandons it.
- PRAISE: the human approves specifically ("perfect", "exactly", "that's it"). Rare and precious — never skip a genuine one.

You are given candidate WINDOWS the mechanical pre-filter flagged. For each, decide: is this a GENUINE divergence, or normal forward progress / mechanical noise (a failed command then retry, a lint fix nobody reacted to, the agent reading files)?

Output ONLY a compact JSON array — one TINY object per window that IS a divergence (omit the rest). Two fields each, nothing more:
[{"windowId":"<verbatim id>","type_guess":"<one of the 8 types>"}]

Rules:
- Be EXTREMELY terse: windowId + type_guess only. Do NOT quote the window, do NOT explain, do NOT restate anything. A downstream pass re-reads the full window itself.
- windowId must be copied verbatim.
- Err toward recall, but DO skip windows that are only mechanical noise with no judgment in them.
- No commentary, no markdown fences — just the JSON array. If nothing is a divergence, output [].`;

const TB_ANALYZE_SYSTEM_PROMPT = `You extract durable TASTE from flagged divergence windows in an AI coding agent's transcripts. Taste = "a senior engineer wouldn't have done that" judgments — the reusable preference under a specific correction.

For each window, decide whether there is a GENERALIZABLE judgment worth remembering. MOST WINDOWS DO NOT — skip ruthlessly. Emit a candidate ONLY when all hold:
- It would change future behavior on a NEW task, not just this one (it generalizes).
- It is something a capable model would NOT already reliably do. Skip obvious best-practice the model already has.
- There is verbatim evidence with an anchor id from the window. No anchor ⇒ no candidate.

Silence is never approval: an absence of reaction is not positive signal. Store the REASONING (the why), not a rule string — reasoning is the load-bearing field; rule_statement is only a scannable summary, never the source of truth. Frame senior-vs-junior where it fits. Be honest about reason_source: "stated" only if the why was actually said, else "inferred".

Assign three ORTHOGONAL facets independently:
- tier: DETERMINISTIC (a machine could check it — also fill check_sketch with a pseudo-rule a linter/semgrep/credo could run) | FUZZY (a reasoning criterion) | CONTEXTUAL (this is a project FACT, not taste — e.g. "this repo uses X"; still emit it, marked CONTEXTUAL).
- scope: {"kind":"project"|"general-taste"|"session-noise","glob":"**/*.sql" optional}. session-noise = a one-off, not taste. Tech/language specificity rides on glob, NOT on category.
- category (which facet of the work the judgment governs — primary required, at most one secondary):
  IDEAS (framing, problem selection, novelty), DESIGN (architecture, interfaces, decomposition, planning/sequencing), IMPLEMENTATION (code craft & convention; most deterministic glob-scoped rules), TEST_EVAL (testing, eval design, deploy/operational soundness — "does it actually work end to end"), COMMUNICATION (prose, naming-as-communication, commits, PRs, docs, metaphor), PROCESS (workflow, git hygiene, when-to-ask, tool discipline, doc practice).

Output ONE JSON array of candidates and nothing else (no prose, no markdown fences). Each element:
{
  "category": "<one of the six>",
  "secondary_category": "<optional, one of the six>",
  "tier": "DETERMINISTIC|FUZZY|CONTEXTUAL",
  "scope": {"kind":"project|general-taste|session-noise","glob":"optional glob"},
  "reasoning": "WHY this is taste, in prose — the load-bearing field. Senior-vs-junior framing where it fits.",
  "delta": {"before":"what the agent did","after":"what was preferred"},
  "reason_source": "stated|inferred",
  "rule_statement": "one-line generalizing heuristic (scannable summary, not the source of truth)",
  "canonical_example": {"bad":"...","good":"..."},
  "check_sketch": "pseudo-rule if DETERMINISTIC, else null",
  "evidence": [{"anchor":{"sessionFile":"<from the window header>","id":"<an [id=...] from the window>","ts":null},"quote":"verbatim snippet","confidence":0.0}],
  "dedupe_key": "stable slug",
  "ladders_up_hint": "optional apex principle this instantiates",
  "provenance": "free-text citing the anchor id"
}
If no window yields durable taste, output [].`;

export const __PROMPTS = { flag: TA_FLAG_SYSTEM_PROMPT, analyze: TB_ANALYZE_SYSTEM_PROMPT };

// ---------------------------------------------------------------------------
// Window rendering
// ---------------------------------------------------------------------------

function clip(s: string, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function eventLineCompact(e: TranscriptEvent): string {
  if (e.kind === "message") return `${e.role}: ${clip(e.text, 320)}`;
  if (e.kind === "thinking") return `assistant(thinking): ${clip(e.text, 200)}`;
  if (e.kind === "tool_use") {
    const t = e.tool?.target ? ` ${e.tool.target}` : "";
    return `assistant(${e.tool?.name}${t}): ${clip(e.tool?.summary ?? "", 160)}`;
  }
  if (e.kind === "tool_result") return `tool_result${e.tool?.isError ? "(error)" : ""}: ${clip(e.tool?.summary ?? "", 120)}`;
  return `${e.role}: ${clip(e.text, 120)}`;
}

function eventLineFull(e: TranscriptEvent): string {
  const id = `[id=${e.anchor.id}]`;
  if (e.kind === "message") return `${id} ${e.role}: ${clip(e.text, 1200)}`;
  if (e.kind === "thinking") return `${id} assistant(thinking): ${clip(e.text, 800)}`;
  if (e.kind === "tool_use") {
    const t = e.tool?.target ? ` ${e.tool.target}` : "";
    return `${id} assistant(${e.tool?.name}${t}): ${clip(e.tool?.summary ?? "", 600)}`;
  }
  if (e.kind === "tool_result") return `${id} tool_result${e.tool?.isError ? "(error)" : ""}: ${clip(e.tool?.summary ?? "", 400)}`;
  return `${id} ${e.role}: ${clip(e.text, 400)}`;
}

export function renderWindowCompact(w: DivergenceWindow): string {
  return `### window ${w.windowId}  [${w.locusKind}; cues: ${w.cues.join(", ")}]\n${w.events.map(eventLineCompact).join("\n")}`;
}

export function renderWindowFull(w: DivergenceWindow): string {
  const sessionFile = w.events[0]?.anchor.sessionFile ?? "";
  return `### window ${w.windowId}  [${w.locusKind}; cues: ${w.cues.join(", ")}]\nsessionFile: ${sessionFile}\n${w.events.map(eventLineFull).join("\n")}`;
}

export function buildFlagUserContent(windows: DivergenceWindow[]): string {
  return `Classify these ${windows.length} candidate windows.\n\n${windows.map(renderWindowCompact).join("\n\n")}`;
}

export function buildAnalyzeUserContent(windows: DivergenceWindow[]): string {
  return `Analyze these ${windows.length} flagged divergence windows for durable taste.\n\n${windows.map(renderWindowFull).join("\n\n")}`;
}

// ---------------------------------------------------------------------------
// Validators (siblings of validateProjectCandidate — extract.ts:84)
// ---------------------------------------------------------------------------

const DIV_SET = new Set<string>(DIVERGENCE_TYPES);
const CAT_SET = new Set<string>(TASTE_CATEGORIES);
const TIER_SET = new Set<string>(TASTE_TIERS);
const SCOPE_SET = new Set<string>(SCOPE_KINDS);

function clamp01(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.min(1, v));
}

/** The locus event's own text/summary — a human-scannable trigger snippet,
 * derived locally so the cheap classifier never has to (and can't) echo it. */
function deriveTrigger(window: DivergenceWindow): string {
  const locus = window.events.find((e) => e.anchor.id === window.anchor.id);
  const raw = locus?.text || locus?.tool?.summary || "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 160);
}

/** Rehydrate a flag against the known TA-0 windows so the model can't corrupt anchors. */
export function validateTasteFlag(
  obj: unknown,
  windowsById: Map<string, DivergenceWindow>,
): TasteFlag | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.windowId !== "string") return null;
  const window = windowsById.get(o.windowId);
  if (!window) return null;
  if (typeof o.type_guess !== "string" || !DIV_SET.has(o.type_guess)) return null;
  // Accept a short model-supplied quote if it bothered; otherwise derive locally.
  const modelQuote =
    typeof o.trigger_quote === "string" && o.trigger_quote.length <= 200 ? o.trigger_quote : "";
  return {
    windowId: window.windowId,
    anchor: { sessionFile: window.anchor.sessionFile, id: window.anchor.id, ts: window.anchor.ts },
    window: { startId: window.startId, endId: window.endId },
    type_guess: o.type_guess as DivergenceType,
    trigger_quote: modelQuote || deriveTrigger(window),
    crude_confidence: typeof o.crude_confidence === "number" ? clamp01(o.crude_confidence) : 0.5,
  };
}

function validStr(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function validateTasteCandidate(obj: unknown): TasteCandidate | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.category !== "string" || !CAT_SET.has(o.category)) return null;
  if (typeof o.tier !== "string" || !TIER_SET.has(o.tier)) return null;
  if (!validStr(o.reasoning)) return null;
  if (!validStr(o.provenance)) return null;

  const scope = o.scope as Record<string, unknown> | undefined;
  const scopeKind = scope && typeof scope.kind === "string" && SCOPE_SET.has(scope.kind) ? scope.kind : "project";
  const delta = o.delta as Record<string, unknown> | undefined;
  const example = o.canonical_example as Record<string, unknown> | undefined;

  const evidence = Array.isArray(o.evidence)
    ? o.evidence
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .map((e) => {
          const a = (e.anchor as Record<string, unknown>) ?? {};
          return {
            anchor: {
              sessionFile: typeof a.sessionFile === "string" ? a.sessionFile : "",
              id: typeof a.id === "string" ? a.id : "",
              ts: typeof a.ts === "string" ? a.ts : null,
            },
            quote: typeof e.quote === "string" ? e.quote : "",
            confidence: clamp01(e.confidence),
          };
        })
        // Require a real anchor id — quote-only evidence is unverifiable hearsay.
        .filter((e) => e.anchor.id)
    : [];

  // No anchor ⇒ no candidate (design §5.4).
  if (evidence.length === 0) return null;

  return {
    category: o.category as TasteCategory,
    ...(typeof o.secondary_category === "string" &&
    CAT_SET.has(o.secondary_category) &&
    o.secondary_category !== o.category
      ? { secondary_category: o.secondary_category as TasteCategory }
      : {}),
    tier: o.tier as TasteTier,
    scope: {
      kind: scopeKind as TasteCandidate["scope"]["kind"],
      ...(scope && validStr(scope.glob) ? { glob: (scope.glob as string).trim() } : {}),
    },
    reasoning: o.reasoning.trim(),
    delta: {
      before: delta && typeof delta.before === "string" ? delta.before : "",
      after: delta && typeof delta.after === "string" ? delta.after : "",
    },
    reason_source: o.reason_source === "stated" ? "stated" : "inferred",
    rule_statement: typeof o.rule_statement === "string" ? o.rule_statement.trim() : "",
    canonical_example: {
      bad: example && typeof example.bad === "string" ? example.bad : "",
      good: example && typeof example.good === "string" ? example.good : "",
    },
    check_sketch: typeof o.check_sketch === "string" && o.check_sketch.trim() ? o.check_sketch.trim() : null,
    evidence,
    dedupe_key: validStr(o.dedupe_key) ? (o.dedupe_key as string).trim() : o.category.toLowerCase(),
    ...(validStr(o.ladders_up_hint) ? { ladders_up_hint: (o.ladders_up_hint as string).trim() } : {}),
    provenance: o.provenance.trim(),
  };
}

// ---------------------------------------------------------------------------
// Pass calls (mirror callProjectExtractor — extract.ts:351)
// ---------------------------------------------------------------------------

export interface CallUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  provider: string;
  model: string;
}

export interface FlagCallResult {
  flags: TasteFlag[];
  rejected: number;
  raw: string;
  usage: CallUsage;
}

export interface AnalyzeCallResult {
  candidates: TasteCandidate[];
  rejected: number;
  raw: string;
  usage: CallUsage;
}

export async function callTasteClassifier(
  windows: DivergenceWindow[],
  caller: ModelCaller = defaultCaller,
): Promise<FlagCallResult> {
  const { provider, modelId } = tasteClassifierModel();
  const completion = await caller({
    provider,
    modelId,
    systemPrompt: TA_FLAG_SYSTEM_PROMPT,
    userContent: buildFlagUserContent(windows),
  });
  const byId = new Map(windows.map((w) => [w.windowId, w]));
  const parsed = parseExtractionJson(completion.text);
  const flags: TasteFlag[] = [];
  let rejected = 0;
  for (const item of parsed) {
    const f = validateTasteFlag(item, byId);
    if (f) flags.push(f);
    else rejected++;
  }
  return {
    flags,
    rejected,
    raw: completion.text,
    usage: {
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      durationMs: completion.durationMs,
      provider: completion.provider,
      model: completion.model,
    },
  };
}

export async function callTasteAnalyzer(
  windows: DivergenceWindow[],
  caller: ModelCaller = defaultCaller,
): Promise<AnalyzeCallResult> {
  const { provider, modelId } = tasteAnalyzerModel();
  const completion = await caller({
    provider,
    modelId,
    systemPrompt: TB_ANALYZE_SYSTEM_PROMPT,
    userContent: buildAnalyzeUserContent(windows),
  });
  const parsed = parseExtractionJson(completion.text);
  const candidates: TasteCandidate[] = [];
  let rejected = 0;
  for (const item of parsed) {
    const c = validateTasteCandidate(item);
    if (c) candidates.push(c);
    else rejected++;
  }
  return {
    candidates,
    rejected,
    raw: completion.text,
    usage: {
      inputTokens: completion.inputTokens,
      outputTokens: completion.outputTokens,
      durationMs: completion.durationMs,
      provider: completion.provider,
      model: completion.model,
    },
  };
}

// ---------------------------------------------------------------------------
// Offline driver — segment → TA-1 → TB over a set of transcripts (design §13)
// ---------------------------------------------------------------------------

export interface TasteExtractResult {
  flags: TasteFlag[];
  candidates: TasteCandidate[];
  sessionsProcessed: number;
  windowCount: number;
  flaggedCount: number;
  rejected: { flags: number; candidates: number };
  totalUsd: number;
  modelCalls: number;
  /** Per-session failures, isolated so one bad session never aborts the run. */
  errors: string[];
}

export interface RunTasteExtractOptions {
  caller?: ModelCaller;
  flagsOnly?: boolean;
  segmentOptions?: SegmentOptions;
  onProgress?: (msg: string) => void;
}

function usd(usage: CallUsage): number {
  return estimateCost({
    provider: usage.provider,
    model: usage.model,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
  }).totalUsd;
}

export async function runTasteExtract(
  loaded: LoadedTranscript[],
  opts: RunTasteExtractOptions = {},
): Promise<TasteExtractResult> {
  const caller = opts.caller ?? defaultCaller;
  const result: TasteExtractResult = {
    flags: [],
    candidates: [],
    sessionsProcessed: 0,
    windowCount: 0,
    flaggedCount: 0,
    rejected: { flags: 0, candidates: 0 },
    totalUsd: 0,
    modelCalls: 0,
    errors: [],
  };

  for (const t of loaded) {
    const label = t.sessionFile.split("/").pop() ?? t.sessionFile;
    try {
      const windows = segmentWindows(t.events, opts.segmentOptions);
      if (windows.length === 0) continue;
      result.sessionsProcessed++;
      result.windowCount += windows.length;
      opts.onProgress?.(`${label}: ${windows.length} windows → classifying`);

      const flagRes = await callTasteClassifier(windows, caller);
      result.modelCalls++;
      result.totalUsd += usd(flagRes.usage);
      result.flags.push(...flagRes.flags);
      result.rejected.flags += flagRes.rejected;
      result.flaggedCount += flagRes.flags.length;

      if (opts.flagsOnly || flagRes.flags.length === 0) continue;

      const byId = new Map(windows.map((w) => [w.windowId, w]));
      const flagged = flagRes.flags
        .map((f) => byId.get(f.windowId))
        .filter((w): w is DivergenceWindow => !!w);
      opts.onProgress?.(`  ${flagged.length} flagged → analyzing`);

      const analyzeRes = await callTasteAnalyzer(flagged, caller);
      result.modelCalls++;
      result.totalUsd += usd(analyzeRes.usage);
      result.candidates.push(...analyzeRes.candidates);
      result.rejected.candidates += analyzeRes.rejected;
    } catch (err) {
      const msg = `${label}: ${err instanceof Error ? err.message : String(err)}`;
      result.errors.push(msg);
      opts.onProgress?.(`  ! ${msg}`);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Nightly per-project driver — one TA call + one TB call over a project's whole
// window (design §4.4, §5.4: "one Haiku call per project", "single Opus call
// per project"). Distinct from runTasteExtract, which is session-granular for
// the offline `hive taste extract` workhorse. The orchestrator wants
// project-batched calls — cheaper (one prompt overhead, not one per session)
// and TB dedupes across the project's sessions — plus per-pass usage so it can
// write accurate TA/TB usage records.
// ---------------------------------------------------------------------------

export interface ProjectTasteUsage {
  pass: "TA" | "TB";
  usage: CallUsage;
}

export interface ProjectTasteResult {
  flags: TasteFlag[];
  candidates: TasteCandidate[];
  windowCount: number;
  flaggedCount: number;
  rejected: { flags: number; candidates: number };
  usageRecords: ProjectTasteUsage[];
}

export interface RunProjectTasteExtractOptions {
  caller?: ModelCaller;
  flagsOnly?: boolean;
  segmentOptions?: SegmentOptions;
  onProgress?: (msg: string) => void;
}

export async function runProjectTasteExtract(
  loaded: LoadedTranscript[],
  opts: RunProjectTasteExtractOptions = {},
): Promise<ProjectTasteResult> {
  const caller = opts.caller ?? defaultCaller;
  const result: ProjectTasteResult = {
    flags: [],
    candidates: [],
    windowCount: 0,
    flaggedCount: 0,
    rejected: { flags: 0, candidates: 0 },
    usageRecords: [],
  };

  // Segment every session in the project's window into one window pool. windowId
  // is `${basename}:${line}` — unique across a project's sessions (Claude/Codex
  // session filenames are unique), so the byId map below can't collide.
  const windows: DivergenceWindow[] = [];
  for (const t of loaded) windows.push(...segmentWindows(t.events, opts.segmentOptions));
  result.windowCount = windows.length;
  if (windows.length === 0) return result;

  // One TA (Haiku) call over all the project's windows.
  opts.onProgress?.(`${windows.length} windows → classifying`);
  const flagRes = await callTasteClassifier(windows, caller);
  result.flags = flagRes.flags;
  result.rejected.flags = flagRes.rejected;
  result.flaggedCount = flagRes.flags.length;
  result.usageRecords.push({ pass: "TA", usage: flagRes.usage });

  if (opts.flagsOnly || flagRes.flags.length === 0) return result;

  // One TB (Opus) call over the flagged windows, fully expanded.
  const byId = new Map(windows.map((w) => [w.windowId, w]));
  const flagged = flagRes.flags
    .map((f) => byId.get(f.windowId))
    .filter((w): w is DivergenceWindow => !!w);
  opts.onProgress?.(`${flagged.length} flagged → analyzing`);
  const analyzeRes = await callTasteAnalyzer(flagged, caller);
  result.candidates = analyzeRes.candidates;
  result.rejected.candidates = analyzeRes.rejected;
  result.usageRecords.push({ pass: "TB", usage: analyzeRes.usage });

  return result;
}
