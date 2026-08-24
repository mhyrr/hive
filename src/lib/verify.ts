// Pass V — Verify, gap-find, brief. Opus turns the day's signal into canon
// decisions + a morning briefing.
//
// Two prompt shapes, N+1 serial calls:
//   1. Project verifier — one call per project that has candidates. Sees that
//      project's canon and its candidates; returns decisions + gaps.
//   2. Briefer — one call. Sees the conditioning report, inboxes, Pass C
//      reflections, and a digest of every decision the shards made; returns the
//      C decisions, cross-project gaps, and the briefing prose.
//
// It used to be ONE call carrying every project's full canon. That prompt grew
// with the canon rather than with the day's work, and on 2026-07-23 it crossed
// the 200k window: `Prompt is too long · ~222086 tokens` — a client-side reject
// that surfaces as a 0-token error envelope and blocked every canon write for
// three nights (TK-137). Sharded, the prompt is bounded by the largest single
// project instead of the sum of all of them, and canon-less projects cost
// nothing. `assertPromptFits` guards each call so the next time this ceiling is
// reached it says so in one legible line.
//
// docs/specs/2026-04-26-memory-design.md §Pass V

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { completeClaudeTextBounded } from "./claude";
import type { HivePaths } from "./paths";
import { inboxBodyHash, parseInbox } from "./inbox";
import { listProjects } from "./paths";
import {
  entryHash,
  readCandidates,
  readProjectMemorySnapshot,
  type Candidate,
  type MemoryEntry,
  type ProjectDecision,
} from "./memory";
import type { ConditionReport } from "./condition";
import {
  estimateCost,
  appendUsageRecord,
  usagePath,
  type UsageDelta,
  type CostBreakdown,
  type PassUsageRecord,
} from "./pricing";
import type { ProjectCandidate, ReflectionCandidate, ModelCaller } from "./extract";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-opus-4-8";

function verifierModel(): { provider: string; modelId: string } {
  const override = process.env.HIVE_VERIFY_MODEL;
  if (override && override.includes("/")) {
    const [provider, modelId] = override.split("/", 2);
    return { provider: provider!, modelId: modelId! };
  }
  return {
    provider: process.env.HIVE_VERIFY_PROVIDER || DEFAULT_PROVIDER,
    modelId: override || DEFAULT_MODEL,
  };
}

// ---------------------------------------------------------------------------
// Prompt budget — a spawned `claude --print` rejects an over-window prompt
// client-side: exit 1, `is_error: true`, zero tokens, zero api_ms, and the real
// message ("Prompt is too long · the request is ~N tokens") buried in a `result`
// field that claude.ts truncates away. Indistinguishable from an auth failure
// unless you replay the prompt by hand. So measure before spawning.
// ---------------------------------------------------------------------------

/** Context window of the verifier model. Override when pointing V at a
 * larger-window model (e.g. a `[1m]` variant). */
export const VERIFY_WINDOW_TOKENS = Number(process.env.HIVE_VERIFY_WINDOW_TOKENS) || 200_000;

/** Room left for the model's own output plus the CLI's envelope overhead. */
const OUTPUT_HEADROOM_TOKENS = 16_000;

/** Chars per token. Calibrated against the 2026-07-25 bundle that broke Pass V:
 * 734,495 chars measured 222,086 tokens = 3.31 chars/token. JSON-heavy canon
 * tokenizes denser than prose, so round down — a conservative estimate fails
 * loudly on our side instead of silently on Anthropic's. */
const CHARS_PER_TOKEN = 3.2;

export function estimatePromptTokens(systemPrompt: string, userContent: string): number {
  return Math.ceil((systemPrompt.length + userContent.length) / CHARS_PER_TOKEN);
}

/** Throw a legible error when a prompt cannot fit, naming the call and the
 * overage. `label` is the pass id the orchestrator logs (e.g. "V.revrec"). */
export function assertPromptFits(label: string, systemPrompt: string, userContent: string): void {
  const estimated = estimatePromptTokens(systemPrompt, userContent);
  const budget = VERIFY_WINDOW_TOKENS - OUTPUT_HEADROOM_TOKENS;
  if (estimated <= budget) return;
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  throw new Error(
    `${label} prompt is ~${k(estimated)} tokens, over the ${k(budget)} budget ` +
      `(${k(VERIFY_WINDOW_TOKENS)} window less ${k(OUTPUT_HEADROOM_TOKENS)} for output). ` +
      `Shrink the inputs — this canon has outgrown a single call.`,
  );
}

// ---------------------------------------------------------------------------
// Hash-serialized canon — Opus references existing entries by hash for
// supersede / merge decisions, eliminating ambiguity about which entry to touch.
// ---------------------------------------------------------------------------

export interface CanonEntryRef {
  hash: string;
  type: "fact" | "convention" | "decision" | "question";
  text: string;
  tags: string[];
  ts?: string; // decisions carry a timestamp
}

export interface SerializedCanon {
  projectId: string;
  facts: CanonEntryRef[];
  conventions: CanonEntryRef[];
  decisions: CanonEntryRef[];
  questions: CanonEntryRef[];
}

function hashEntries<T extends MemoryEntry | ProjectDecision>(
  entries: T[],
  type: CanonEntryRef["type"],
): CanonEntryRef[] {
  return entries
    .filter((e) => !e.superseded)
    .map((e) => {
      const ref: CanonEntryRef = {
        hash: entryHash(e.text),
        type,
        text: e.text,
        tags: e.tags,
      };
      if ("ts" in e && e.ts) ref.ts = (e as ProjectDecision).ts;
      return ref;
    });
}

export async function serializeProjectCanon(
  paths: HivePaths,
  projectId: string,
): Promise<SerializedCanon> {
  const snap = await readProjectMemorySnapshot(paths, projectId).catch(() => null);
  if (!snap) {
    return { projectId, facts: [], conventions: [], decisions: [], questions: [] };
  }
  return {
    projectId,
    facts: hashEntries(snap.facts, "fact"),
    conventions: hashEntries(snap.conventions, "convention"),
    decisions: hashEntries(snap.decisions, "decision"),
    questions: hashEntries(snap.questions, "question"),
  };
}

// ---------------------------------------------------------------------------
// Verifier output schema
// ---------------------------------------------------------------------------

export type DecisionAction = "accept" | "supersede" | "merge" | "reject";

export interface VerifierDecision {
  candidate_id: string;          // e.g. "B.alpha[0]" | "C[2]" | "candidates.alpha[0]"
  action: DecisionAction;
  target_hash?: string;          // required for supersede / merge
  reason?: string;               // required for reject
  added_tags?: string[];         // for merge — tags to add to the existing entry
}

export interface VerifierGap {
  subject: string;               // project id, "greg", "maya", "system"
  observation: string;
  source: string;                // citation back into the inputs
}

export interface VerifierOutput {
  decisions: VerifierDecision[];
  gaps: VerifierGap[];
  briefing_markdown: string;
}

const VALID_ACTIONS = new Set<DecisionAction>(["accept", "supersede", "merge", "reject"]);

/** Validate a verifier response. Project-shard calls write no prose, so they
 * pass `requireBriefing: false`; only the briefer must return a briefing. */
export function validateVerifierOutput(
  obj: unknown,
  opts: { requireBriefing?: boolean } = {},
): VerifierOutput | { error: string } {
  const requireBriefing = opts.requireBriefing ?? true;
  if (!obj || typeof obj !== "object") return { error: "root is not an object" };
  const o = obj as Record<string, unknown>;

  if (!Array.isArray(o.decisions)) return { error: "decisions[] missing or not array" };
  const decisions: VerifierDecision[] = [];
  for (const [i, raw] of o.decisions.entries()) {
    if (!raw || typeof raw !== "object") return { error: `decisions[${i}] not an object` };
    const d = raw as Record<string, unknown>;
    if (typeof d.candidate_id !== "string" || !d.candidate_id) {
      return { error: `decisions[${i}].candidate_id missing` };
    }
    const action = d.action as DecisionAction;
    if (!VALID_ACTIONS.has(action)) {
      return { error: `decisions[${i}].action invalid: ${String(d.action)}` };
    }
    if ((action === "supersede" || action === "merge") && typeof d.target_hash !== "string") {
      return { error: `decisions[${i}] needs target_hash for ${action}` };
    }
    if (action === "reject" && typeof d.reason !== "string") {
      return { error: `decisions[${i}] needs reason for reject` };
    }
    decisions.push({
      candidate_id: d.candidate_id,
      action,
      ...(typeof d.target_hash === "string" ? { target_hash: d.target_hash } : {}),
      ...(typeof d.reason === "string" ? { reason: d.reason } : {}),
      ...(Array.isArray(d.added_tags)
        ? { added_tags: (d.added_tags as unknown[]).filter((t): t is string => typeof t === "string") }
        : {}),
    });
  }

  if (!Array.isArray(o.gaps)) return { error: "gaps[] missing or not array" };
  const gaps: VerifierGap[] = [];
  for (const [i, raw] of o.gaps.entries()) {
    if (!raw || typeof raw !== "object") return { error: `gaps[${i}] not an object` };
    const g = raw as Record<string, unknown>;
    if (typeof g.subject !== "string" || typeof g.observation !== "string" || typeof g.source !== "string") {
      return { error: `gaps[${i}] missing subject/observation/source` };
    }
    gaps.push({ subject: g.subject, observation: g.observation, source: g.source });
  }

  const briefing = typeof o.briefing_markdown === "string" ? o.briefing_markdown : "";
  if (requireBriefing && !briefing.trim()) {
    return { error: "briefing_markdown missing or empty" };
  }

  return { decisions, gaps, briefing_markdown: briefing };
}

// ---------------------------------------------------------------------------
// JSON parsing — same tolerance as extract.ts but expects an object
// ---------------------------------------------------------------------------

export function parseVerifierJson(raw: string): unknown {
  let text = raw.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/);
  if (fenceMatch) text = fenceMatch[1]!.trim();

  try {
    return JSON.parse(text);
  } catch {
    // intentional: raw text isn't valid JSON — try bracket extraction below
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // intentional: bracket-extracted substring also invalid — fall through to throw
    }
  }
  throw new Error(`Could not parse verifier output as JSON object. First 200 chars: ${raw.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// System prompt — long, deliberate, structured-output + briefing template
// ---------------------------------------------------------------------------

/** The action menu + accept bar. Shared so the project verifier and the briefer
 * judge by the same standard rather than drifting apart in two prompts. */
const DECISION_RULES = `- **accept** — admits as a fresh entry to canon
- **supersede** with target_hash — the candidate is a better version of an existing canon entry; the old one is marked superseded
- **merge** with target_hash + added_tags — the candidate's tags are merged onto an existing entry; the candidate itself is dropped
- **reject** with reason ∈ {cite_unverifiable, duplicate, trivial, low_signal, other}

Bar for accept: "would this still help a session a month from now?" Be selective. Three excellent admissions beat ten mediocre ones.

If the candidate's quoted source isn't visible anywhere in the inputs, **reject as cite_unverifiable** — citation discipline matters more than charity.`;

const PROJECT_VERIFIER_SYSTEM_PROMPT = `You are the verifier for HIVE's nightly memory pipeline. Sonnet (in Pass B) extracted candidates from one project's day; you decide what becomes that project's canon.

You see exactly one project. Every candidate below belongs to it, and every target_hash you cite must come from the canon block below — you cannot reach into another project's memory, and you shouldn't try.

# Your two jobs (one JSON object out)

## 1) Per-candidate decisions
For every Pass B candidate and every mid-session candidates.md entry, choose:

${DECISION_RULES}

**Directives.** A mid-session candidate marked \`"directive": true\` was saved on Greg's explicit instruction — it is his decision, not an extractor's guess. You MAY **accept**, **supersede**, or **merge** a directive: refine its wording, place it well, or fold it into an existing entry. You may NOT **reject** it — the human already decided it's worth keeping, so the accept-bar, cite_unverifiable, trivial, and low_signal do not apply. Your job on a directive is placement, never veto. (A directive you try to reject is force-admitted downstream anyway, so a reject decision just produces a worse-placed entry.)

## 2) Gap report
Things Sonnet missed but should have caught — patterns from this project's day that didn't land in the candidate batch. Cite the specific source (e.g. "alpha:topRanked[5] — Greg established X but extractor missed it"). Empty array if Sonnet did fine.

# OUTPUT — strict schema

Return ONE JSON object, no fences, no prose around it:

{
  "decisions": [
    {
      "candidate_id": "B.<projectId>[<index>]" | "candidates.<projectId>[<index>]",
      "action": "accept" | "supersede" | "merge" | "reject",
      "target_hash": "<8-char hex from the canon block, required for supersede/merge>",
      "reason": "<required for reject>",
      "added_tags": ["..."]            // optional, mainly for merge
    }
  ],
  "gaps": [
    { "subject": "<this project, or greg/maya/system>", "observation": "...", "source": "..." }
  ]
}

Schema discipline: every candidate listed in the inputs MUST appear in decisions[] exactly once. No silent drops, no duplicate decisions. Do not write a briefing — a later call does that.`;

const BRIEFER_SYSTEM_PROMPT = `You are the verifier for HIVE's nightly memory pipeline. The per-project verifier calls have already decided what enters each project's canon; their decisions are digested below. You do the two jobs that span projects.

# Your jobs (one JSON object out)

## 1) Reflection decisions
Pass C extracted cross-project reflections — patterns about Greg, Maya, or the system rather than any one codebase. For each, choose:

${DECISION_RULES}

Reflections land in the reflections store, not a project canon, so **supersede and merge have no target to cite** — use accept or reject only.

## 2) Gap report
Things the extractors missed that span projects, or that concern Greg/Maya/the system itself. The per-project calls already reported their own gaps (digested below — don't repeat them). Cite the specific source. Empty array if there's nothing.

## 3) Morning briefing
A single user-facing markdown document Greg reads at 7am. Write in HIVE voice per the SOUL preamble above. Match the template below verbatim for sections, but vary the prose — voice belongs in the headline and per-project bullets, not in section names.

Write it from the conditioning report (what actually happened: sessions, commits, tickets), the inboxes, and the decision digest. The digest tells you what became canon overnight — cite the substance, not the counts (a deterministic pass rewrites the count line after you).

Template:

\`\`\`
# HIVE — YYYY-MM-DD

## Headline
<1–2 sentences. What mattered most overnight.>

## Per project
### project-name
- What shipped / decisions / open threads (≤5 bullets)
- Watch and nightly findings since last briefing (folded from inbox.md)
- Tickets that moved

## What needs your attention
- Highest-priority unresolved across projects, ranked

## Memory + verifier
- Added: N entries. Superseded: N. Reflections: N.
- Verifier flags: <gap count, or "none">
\`\`\`

If a section has nothing real to say, omit it rather than padding. Section "What needs your attention" can be a single line — "All caught up."

# OUTPUT — strict schema

Return ONE JSON object, no fences, no prose around it:

{
  "decisions": [
    {
      "candidate_id": "C[<index>]",
      "action": "accept" | "reject",
      "reason": "<required for reject>"
    }
  ],
  "gaps": [
    { "subject": "<project or greg/maya/system>", "observation": "...", "source": "..." }
  ],
  "briefing_markdown": "<full briefing per template>"
}

Schema discipline: every C candidate listed in the inputs MUST appear in decisions[] exactly once, and decisions[] must contain nothing else — the project candidates in the digest are already decided, and repeating one would double-admit it.`;

/**
 * The briefer's system prompt, with the HIVE soul prepended as voice context.
 * SOUL.md is the single source of truth for HIVE voice across every surface
 * (CLI sessions, Watch Act, briefing) — Pass V reads the same file rather than
 * carrying its own duplicated voice instructions.
 *
 * If SOUL is empty or missing, the verifier instructions stand alone and
 * the briefing comes back neutral. That's the desired failure mode —
 * silent voice loss is better than fabricated personality.
 */
export function buildBrieferSystemPrompt(soulText: string): string {
  const soul = soulText.trim();
  if (!soul) return BRIEFER_SYSTEM_PROMPT;
  return `${soul}\n\n---\n\n${BRIEFER_SYSTEM_PROMPT}`;
}

/**
 * The project verifier's system prompt. No SOUL: a shard emits decisions and
 * gaps, never prose, so voice context would be several thousand tokens spent on
 * nothing — and those tokens are exactly what's scarce here.
 */
export function buildProjectVerifierSystemPrompt(): string {
  return PROJECT_VERIFIER_SYSTEM_PROMPT;
}

// ---------------------------------------------------------------------------
// User content assembly
// ---------------------------------------------------------------------------

export interface ProjectVerifierBlock {
  projectId: string;
  canon: SerializedCanon;
  midSessionCandidates: Candidate[];
  inboxText: string;
  bCandidates: ProjectCandidate[];
}

export interface VerifierInputBundle {
  date: string;
  condition: ConditionReport;
  perProject: ProjectVerifierBlock[];
  cCandidates: ReflectionCandidate[];
  principlesText: string;
}

/** A block earns its own Opus call only if it has something to decide. Canon
 * alone is not signal — that was the bug that blew the context window: nine
 * projects shipped 546KB of canon so the verifier could decide nothing about
 * five of them. */
export function blockHasCandidates(block: ProjectVerifierBlock): boolean {
  return block.bCandidates.length > 0 || block.midSessionCandidates.length > 0;
}

function fence(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

/** The per-project verifier prompt: one project's canon and its candidates.
 * Bounded by that project's canon size, not by how many projects HIVE tracks. */
export function buildProjectVerifierUserContent(
  date: string,
  principlesText: string,
  block: ProjectVerifierBlock,
): string {
  const sections: string[] = [];

  sections.push(`# Pass V — Verify · ${date} · project: ${block.projectId}

Decide every candidate below against this project's canon. Output the JSON object per the system prompt.
`);

  sections.push(`## Taste principles (the lens)

${principlesText.trim() || "(no principles file present)"}
`);

  sections.push(`## Canon (existing entries — reference target_hash by hash)

${fence({
    facts: block.canon.facts,
    conventions: block.canon.conventions,
    decisions: block.canon.decisions,
    questions: block.canon.questions,
  })}
`);

  sections.push(`## Mid-session candidates (candidates.md, ${block.midSessionCandidates.length})

${
    block.midSessionCandidates.length > 0
      ? fence(
        block.midSessionCandidates.map((c, i) => ({
          candidate_id: `candidates.${block.projectId}[${i}]`,
          ...c,
        })),
      )
      : "(none)"
  }
`);

  sections.push(`## Pass B candidates (Sonnet, ${block.bCandidates.length})

${
    block.bCandidates.length > 0
      ? fence(
        block.bCandidates.map((c, i) => ({
          candidate_id: `B.${block.projectId}[${i}]`,
          ...c,
        })),
      )
      : "(none — Pass B emitted nothing for this project)"
  }
`);

  sections.push(`## Output

Return the JSON object per the system prompt schema. Every candidate id above must appear exactly once in decisions[]. No briefing.`);

  return sections.join("\n");
}

/** One digested decision, for the briefer's benefit — what became canon
 * overnight, in substance rather than counts. */
export interface DecisionDigestEntry {
  candidate_id: string;
  action: DecisionAction;
  project: string;
  type?: string;
  content?: string;
}

/** Map a shard's decisions back onto the candidate text they acted on. The ids
 * are the ones this module minted when rendering the block, so the lookup is
 * exact — no id re-parsing, no guessing. */
export function digestShardDecisions(
  block: ProjectVerifierBlock,
  decisions: VerifierDecision[],
): DecisionDigestEntry[] {
  const byId = new Map<string, { type: string; content: string }>();
  block.midSessionCandidates.forEach((c, i) => {
    byId.set(`candidates.${block.projectId}[${i}]`, { type: c.type, content: c.content });
  });
  block.bCandidates.forEach((c, i) => {
    byId.set(`B.${block.projectId}[${i}]`, { type: c.type, content: c.content });
  });

  return decisions.map((d) => {
    const src = byId.get(d.candidate_id);
    return {
      candidate_id: d.candidate_id,
      action: d.action,
      project: block.projectId,
      ...(src ? { type: src.type, content: src.content } : {}),
    };
  });
}

/** The briefer prompt: what happened (conditioning report), what watches and
 * nightly found (inboxes), what became canon (digest), and the reflections still to
 * decide. No canon — the briefer never cites a target_hash. */
export function buildBriefingUserContent(input: {
  date: string;
  condition: ConditionReport;
  inboxes: Array<{ projectId: string; inboxText: string }>;
  cCandidates: ReflectionCandidate[];
  digest: DecisionDigestEntry[];
  shardGaps: VerifierGap[];
  principlesText: string;
}): string {
  const sections: string[] = [];

  sections.push(`# Pass V — Brief · ${input.date}

Decide the reflection candidates and write the morning briefing. Output the JSON object per the system prompt.
`);

  sections.push(`## Conditioning report (Pass A)

${fence({
    date: input.condition.date,
    hoursWindow: input.condition.hoursWindow,
    trivial: input.condition.trivial,
    totals: input.condition.totals,
    projects: input.condition.projects.map((p) => ({
      projectName: p.projectName,
      sessions: p.sessions,
      git: p.git,
      tickets: p.tickets,
      inbox: p.inbox,
    })),
  })}
`);

  sections.push(`## Taste principles (the lens)

${input.principlesText.trim() || "(no principles file present)"}
`);

  const withInbox = input.inboxes.filter((i) => i.inboxText.trim().length > 0);
  sections.push(`## Project inboxes (${withInbox.length} with content)

${
    withInbox.length > 0
      ? withInbox
        .map((i) => `### ${i.projectId}\n\n${i.inboxText.trim()}`)
        .join("\n\n")
      : "(all empty)"
  }
`);

  sections.push(`## Canon decisions already made (${input.digest.length})

The per-project verifier calls decided these. They are settled — do not re-decide them, and do not put their ids in your decisions[]. They're here so the briefing can say what actually landed.

${input.digest.length > 0 ? fence(input.digest) : "(no candidates were in play tonight)"}
`);

  sections.push(`## Gaps already reported by the per-project calls (${input.shardGaps.length})

${input.shardGaps.length > 0 ? fence(input.shardGaps) : "(none)"}
`);

  sections.push(`## Pass C reflection candidates (${input.cCandidates.length}) — yours to decide

${
    input.cCandidates.length > 0
      ? fence(input.cCandidates.map((c, i) => ({ candidate_id: `C[${i}]`, ...c })))
      : "(none)"
  }
`);

  sections.push(`## Output

Return the JSON object per the system prompt schema: decisions[] for the C candidates only, gaps[], and briefing_markdown.`);

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Loader — assembles the input bundle from runs/{DATE}/ artifacts
// ---------------------------------------------------------------------------

export async function loadVerifierBundle(
  paths: HivePaths,
  date: string,
): Promise<VerifierInputBundle> {
  const runDir = join(paths.memoryRunsDir, date);

  // Pass A
  const conditionRaw = await Bun.file(join(runDir, "condition.json")).text();
  const condition = JSON.parse(conditionRaw) as ConditionReport;

  // Pass C
  let cCandidates: ReflectionCandidate[] = [];
  const cPath = join(runDir, "candidates.C.json");
  if (existsSync(cPath)) {
    try {
      const parsed = JSON.parse(await Bun.file(cPath).text()) as { candidates?: ReflectionCandidate[] };
      cCandidates = parsed.candidates ?? [];
    } catch {
      // intentional: tolerate missing or malformed Pass C artifact
    }
  }

  // Per-project: B candidates + canon + mid-session candidates + inbox
  const perProject: VerifierInputBundle["perProject"] = [];
  const projectIds = await listProjects(paths.projectsDir);
  for (const projectId of projectIds) {
    const bPath = join(runDir, `candidates.B.${projectId}.json`);
    let bCandidates: ProjectCandidate[] = [];
    if (existsSync(bPath)) {
      try {
        const parsed = JSON.parse(await Bun.file(bPath).text()) as { candidates?: ProjectCandidate[] };
        bCandidates = parsed.candidates ?? [];
      } catch {
        // intentional: tolerate missing or malformed Pass B artifact
      }
    }

    const midSession = await readCandidates(paths, projectId);
    const inboxPath = join(paths.projectsDir, projectId, "inbox.md");
    const inboxRaw = existsSync(inboxPath) ? readFileSync(inboxPath, "utf-8") : "";
    const inboxText = parseInbox(inboxRaw, projectId).body;

    // A project earns a place in the bundle if it has candidates to decide or an
    // inbox for the briefing to fold in. Canon presence used to qualify a
    // project on its own, which shipped the entire canon of projects the
    // verifier could decide nothing about (TK-137).
    const hasCandidates = bCandidates.length > 0 || midSession.length > 0;
    if (!hasCandidates && inboxText.trim().length === 0) continue;

    // Canon is only read for projects that will get a verifier call. Serializing
    // revrec's 183KB to hand it to the briefer, which never cites a hash, is
    // pure cost.
    const canon = hasCandidates
      ? await serializeProjectCanon(paths, projectId)
      : { projectId, facts: [], conventions: [], decisions: [], questions: [] };

    perProject.push({ projectId, canon, midSessionCandidates: midSession, inboxText, bCandidates });
  }

  // Principles
  const principlesPath = join(paths.home, "taste", "principles.md");
  const principlesText = existsSync(principlesPath) ? readFileSync(principlesPath, "utf-8") : "";

  return { date, condition, perProject, cCandidates, principlesText };
}

// ---------------------------------------------------------------------------
// Verifier invocation
// ---------------------------------------------------------------------------

export interface VerifierCallResult {
  output: VerifierOutput;
  raw: string;
  usage: UsageDelta & { durationMs: number | null };
  cost: CostBreakdown;
}

const defaultCaller: ModelCaller = (input) =>
  completeClaudeTextBounded({
    modelId: input.modelId,
    systemPrompt: input.systemPrompt,
    userContent: input.userContent,
  });

export async function callVerifier(
  systemPrompt: string,
  userContent: string,
  caller: ModelCaller = defaultCaller,
  opts: { label?: string; requireBriefing?: boolean } = {},
): Promise<VerifierCallResult> {
  const { provider, modelId } = verifierModel();
  assertPromptFits(opts.label ?? "V", systemPrompt, userContent);
  const response = await caller({ provider, modelId, systemPrompt, userContent });
  const raw = response.text;
  const parsed = parseVerifierJson(raw);
  const validated = validateVerifierOutput(parsed, { requireBriefing: opts.requireBriefing });
  if ("error" in validated) {
    throw new Error(`Verifier output failed schema: ${validated.error}\nFirst 400 chars: ${raw.slice(0, 400)}`);
  }
  const usage: UsageDelta & { durationMs: number | null } = {
    provider: response.provider,
    model: response.model,
    inputTokens: response.inputTokens ?? 0,
    outputTokens: response.outputTokens ?? 0,
    durationMs: response.durationMs,
  };
  const cost = estimateCost(usage);
  return { output: validated, raw, usage, cost };
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

export interface RunVerifierOptions {
  paths: HivePaths;
  date: string;
  caller?: ModelCaller;
}

export interface RunVerifierResult {
  output: VerifierOutput;
  artifacts: {
    decisionsPath: string;
    gapsPath: string;
    briefingPath: string;
    verifierOutputPath: string;
    inboxSnapshotPath: string;
    usagePath: string;
  };
  usage: PassUsageRecord;
  cost: CostBreakdown;
  /** Projects that got their own verifier call, in order. */
  shardedProjects: string[];
}

// ---------------------------------------------------------------------------
// Briefing refinement — deterministic post-processing of the Opus prose.
//
// Opus is good at the headline, the per-project bullets, and the taste read.
// It's flaky on counting (last run had "Reflections: 2" when 3 reflections
// landed). And it sometimes treats gaps as a footer count when they earn a
// section. Pass V owns the briefing's accuracy, so we touch up the prose
// before persisting:
//   - Replace the "Added/Superseded/Reflections" line with deterministic counts
//   - Inject a `## Verifier flags` section listing each gap, if any
// ---------------------------------------------------------------------------

interface BriefingFooterCounts {
  added: number;
  superseded: number;
  reflections: number;
}

export function tallyBriefingCounts(decisions: VerifierDecision[]): BriefingFooterCounts {
  let added = 0;
  let superseded = 0;
  let reflections = 0;
  for (const d of decisions) {
    const isReflection = d.candidate_id.startsWith("C[");
    if (d.action === "accept") {
      if (isReflection) reflections++;
      else added++;
    } else if (d.action === "supersede") {
      superseded++;
    }
  }
  return { added, superseded, reflections };
}

const ADDED_LINE_RE = /^\s*-\s*Added:.*$/m;
const VERIFIER_FLAGS_LINE_RE = /^\s*-\s*Verifier flags:.*$/m;

export function refineBriefing(
  briefing: string,
  decisions: VerifierDecision[],
  gaps: VerifierGap[],
): string {
  const counts = tallyBriefingCounts(decisions);
  const accurateLine = `- Added: ${counts.added} entries. Superseded: ${counts.superseded}. Reflections: ${counts.reflections}.`;

  let out = briefing;
  if (ADDED_LINE_RE.test(out)) {
    out = out.replace(ADDED_LINE_RE, accurateLine);
  } else {
    // Briefing didn't include the canonical footer line — append a footer block.
    const footer = `\n\n## Memory + verifier\n${accurateLine}\n`;
    out = out.trimEnd() + footer;
  }

  // Rewrite or set the Verifier flags footer line so it always agrees with
  // the section below. Opus has historically hallucinated counts here.
  const flagsLine =
    gaps.length === 0
      ? "- Verifier flags: none"
      : `- Verifier flags: ${gaps.length} (see section below)`;
  if (VERIFIER_FLAGS_LINE_RE.test(out)) {
    out = out.replace(VERIFIER_FLAGS_LINE_RE, flagsLine);
  } else {
    // Inject after the Added line so the footer reads as a coherent block.
    out = out.replace(ADDED_LINE_RE, (m) => `${m}\n${flagsLine}`);
  }

  // Inject Verifier flags section when gaps exist and one isn't already there.
  if (gaps.length > 0 && !/^## Verifier flags/m.test(out)) {
    const lines = ["", "## Verifier flags"];
    for (const g of gaps) {
      lines.push(`- **${g.subject}** — ${g.observation}`);
    }
    lines.push("");
    out = out.trimEnd() + "\n" + lines.join("\n");
  }

  return out;
}

function formatGapsMarkdown(gaps: VerifierGap[]): string {
  if (gaps.length === 0) return "# Verifier gaps\n\nNo gaps surfaced.\n";
  const lines = ["# Verifier gaps", ""];
  for (const g of gaps) {
    lines.push(`- **${g.subject}** — ${g.observation}`);
    lines.push(`  - source: ${g.source}`);
  }
  return lines.join("\n") + "\n";
}

export async function runVerifier(opts: RunVerifierOptions): Promise<RunVerifierResult> {
  const runDir = join(opts.paths.memoryRunsDir, opts.date);
  await mkdir(runDir, { recursive: true });

  const decisionsPath = join(runDir, "decisions.json");
  const gapsPath = join(runDir, "gaps.md");
  const briefingPath = join(runDir, "briefing.md");
  const fullOutputPath = join(runDir, "verifier-output.json");
  const inboxSnapshotPath = join(runDir, "inboxes.json");

  // Clear any stale artifacts from a prior run on this date before the LLM
  // call. If Opus fails, downstream sees absence (correct) rather than
  // yesterday's success masquerading as today's.
  for (const p of [decisionsPath, gapsPath, briefingPath, fullOutputPath, inboxSnapshotPath]) {
    await rm(p, { force: true });
  }

  const bundle = await loadVerifierBundle(opts.paths, opts.date);
  const soulText = existsSync(opts.paths.soul)
    ? readFileSync(opts.paths.soul, "utf-8")
    : "";

  const decisions: VerifierDecision[] = [];
  const gaps: VerifierGap[] = [];
  const digest: DecisionDigestEntry[] = [];
  const usages: Array<UsageDelta & { durationMs: number | null }> = [];
  const shardedProjects: string[] = [];

  // ---- Per-project calls, serialized -------------------------------------
  // Serial, not parallel: concurrent `claude --print` children contend on the
  // OAuth credential store in a no-GUI launchd context and stall each other out
  // — the same reason Pass B runs in series.
  //
  // Any shard failure aborts the whole pass. Pass F drains a project's
  // candidates.md whenever that project has candidates, decisions or not, so a
  // partial run would drain candidates nothing decided on. All-or-nothing keeps
  // the queue intact for tomorrow.
  const shardSystem = buildProjectVerifierSystemPrompt();
  for (const block of bundle.perProject) {
    if (!blockHasCandidates(block)) continue;
    const userContent = buildProjectVerifierUserContent(
      bundle.date,
      bundle.principlesText,
      block,
    );
    const shard = await callVerifier(shardSystem, userContent, opts.caller, {
      label: `V.${block.projectId}`,
      requireBriefing: false,
    });
    decisions.push(...shard.output.decisions);
    gaps.push(...shard.output.gaps);
    digest.push(...digestShardDecisions(block, shard.output.decisions));
    usages.push(shard.usage);
    shardedProjects.push(block.projectId);
  }

  // ---- Briefing call ------------------------------------------------------
  const briefSystem = buildBrieferSystemPrompt(soulText);
  const briefUser = buildBriefingUserContent({
    date: bundle.date,
    condition: bundle.condition,
    inboxes: bundle.perProject.map((b) => ({ projectId: b.projectId, inboxText: b.inboxText })),
    cCandidates: bundle.cCandidates,
    digest,
    shardGaps: gaps,
    principlesText: bundle.principlesText,
  });
  const brief = await callVerifier(briefSystem, briefUser, opts.caller, {
    label: "V.brief",
    requireBriefing: true,
  });
  usages.push(brief.usage);
  gaps.push(...brief.output.gaps);

  // The briefer is told to decide C candidates only, but a decision it repeats
  // from the digest would double-admit an entry Pass F already has a decision
  // for. Drop anything that isn't a reflection rather than trusting the prompt.
  for (const d of brief.output.decisions) {
    if (d.candidate_id.startsWith("C[")) decisions.push(d);
  }

  const output: VerifierOutput = {
    decisions,
    gaps,
    briefing_markdown: brief.output.briefing_markdown,
  };

  await Bun.write(decisionsPath, JSON.stringify({ decisions: output.decisions }, null, 2));
  await Bun.write(gapsPath, formatGapsMarkdown(output.gaps));
  // Refine Opus's prose before landing — fixes flaky footer counts and surfaces
  // gaps as a section instead of just a count.
  const refined = refineBriefing(output.briefing_markdown, output.decisions, output.gaps);
  await Bun.write(briefingPath, refined);
  // Full structured output — Pass F (Apply) consumes this for gap-landing
  // and taste-readout. Markdown files above are for humans.
  await Bun.write(fullOutputPath, JSON.stringify(output, null, 2));
  await Bun.write(inboxSnapshotPath, JSON.stringify({
    version: 1,
    inboxes: bundle.perProject
      .filter((block) => block.inboxText.trim().length > 0)
      .map((block) => ({
        projectId: block.projectId,
        bodyHash: inboxBodyHash(block.inboxText),
      })),
  }, null, 2));

  // One usage record for the pass, summed across its calls. Same model
  // throughout, so the cost math holds — and usage.json keeps exactly one V row
  // regardless of how many projects were in play.
  const totalUsage: UsageDelta & { durationMs: number | null } = {
    provider: usages[0]?.provider ?? DEFAULT_PROVIDER,
    model: usages[0]?.model ?? verifierModel().modelId,
    inputTokens: usages.reduce((n, u) => n + u.inputTokens, 0),
    outputTokens: usages.reduce((n, u) => n + u.outputTokens, 0),
    durationMs: usages.reduce((n, u) => n + (u.durationMs ?? 0), 0),
  };
  const cost = estimateCost(totalUsage);
  const usageRecord: Omit<PassUsageRecord, "recordedAt"> = {
    pass: "V",
    provider: totalUsage.provider,
    model: totalUsage.model,
    inputTokens: totalUsage.inputTokens,
    outputTokens: totalUsage.outputTokens,
    durationMs: totalUsage.durationMs,
    cost,
  };
  const summary = await appendUsageRecord(opts.paths, opts.date, usageRecord);

  return {
    output,
    artifacts: {
      decisionsPath,
      gapsPath,
      briefingPath,
      verifierOutputPath: fullOutputPath,
      inboxSnapshotPath,
      usagePath: usagePath(opts.paths, opts.date),
    },
    usage: summary.records[summary.records.length - 1]!,
    cost,
    shardedProjects,
  };
}

export const __PROJECT_VERIFIER_PROMPT = PROJECT_VERIFIER_SYSTEM_PROMPT;
export const __BRIEFER_PROMPT = BRIEFER_SYSTEM_PROMPT;
