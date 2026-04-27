// Pass V — Verify, gap-find, taste-read, brief. ONE Opus call that synthesizes
// the day's signal into canon decisions + a morning briefing.
//
// docs/specs/2026-04-26-memory-design.md §Pass V

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { completePiText, type PiTextCompletion } from "./pi";
import type { HivePaths } from "./paths";
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
const DEFAULT_MODEL = "claude-opus-4-6";

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

export interface VerifierTaste {
  reinforced: Array<{ principle: string; evidence: string }>;
  corrections: Array<{ pattern: string; evidence: string }>;
}

export interface VerifierOutput {
  decisions: VerifierDecision[];
  gaps: VerifierGap[];
  taste: VerifierTaste;
  briefing_markdown: string;
}

const VALID_ACTIONS = new Set<DecisionAction>(["accept", "supersede", "merge", "reject"]);

export function validateVerifierOutput(obj: unknown): VerifierOutput | { error: string } {
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

  if (!o.taste || typeof o.taste !== "object") return { error: "taste missing" };
  const t = o.taste as Record<string, unknown>;
  const reinforced: VerifierTaste["reinforced"] = [];
  const corrections: VerifierTaste["corrections"] = [];
  for (const r of (Array.isArray(t.reinforced) ? t.reinforced : []) as Array<Record<string, unknown>>) {
    if (typeof r.principle === "string" && typeof r.evidence === "string") {
      reinforced.push({ principle: r.principle, evidence: r.evidence });
    }
  }
  for (const c of (Array.isArray(t.corrections) ? t.corrections : []) as Array<Record<string, unknown>>) {
    if (typeof c.pattern === "string" && typeof c.evidence === "string") {
      corrections.push({ pattern: c.pattern, evidence: c.evidence });
    }
  }

  if (typeof o.briefing_markdown !== "string" || !o.briefing_markdown.trim()) {
    return { error: "briefing_markdown missing or empty" };
  }

  return { decisions, gaps, taste: { reinforced, corrections }, briefing_markdown: o.briefing_markdown };
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
    // fall through
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // give up
    }
  }
  throw new Error(`Could not parse verifier output as JSON object. First 200 chars: ${raw.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// System prompt — long, deliberate, structured-output + briefing template
// ---------------------------------------------------------------------------

const VERIFIER_SYSTEM_PROMPT = `You are the verifier for HIVE's nightly memory pipeline. Sonnet (in Pass B and C) extracted candidates from the day's signal; you decide what becomes canon and write the morning briefing.

You serve a craftsman named Greg. Tone: sharp, warm, dry. Lead with the insight, not the preamble. No filler ("Absolutely", "Great"). Honest about uncertainty.

# Your four jobs (one call, one JSON object out)

## 1) Per-candidate decisions
For every candidate from B (per-project), C (cross-project reflections), and every entry in mid-session candidates.md files, choose:
- **accept** — admits as a fresh entry to canon
- **supersede** with target_hash — the candidate is a better version of an existing canon entry; the old one is marked superseded
- **merge** with target_hash + added_tags — the candidate's tags are merged onto an existing entry; the candidate itself is dropped
- **reject** with reason ∈ {cite_unverifiable, duplicate, trivial, low_signal, other}

Bar for accept: "would this still help a session a month from now?" Be selective. Three excellent admissions beat ten mediocre ones.

If the candidate's quoted source isn't visible anywhere in the inputs, **reject as cite_unverifiable** — citation discipline matters more than charity.

## 2) Gap report
Things Sonnet missed but should have caught — patterns from the exchanges that didn't land in either candidate batch. Cite the specific source (e.g. "alpha:topRanked[5] — Greg established X but extractor missed it"). Empty array if Sonnet did fine.

## 3) Taste readout
Read the taste principles in the input. Surface:
- **reinforced**: principles the day visibly demonstrated, with the evidence
- **corrections**: patterns where Greg pushed back on something that violated a principle, with evidence

One or two of each, max. Skip if no clear signal.

## 4) Morning briefing
A single user-facing markdown document Greg reads at 7am. Write in HIVE voice — terse, opinionated, warm. Match the template below verbatim for sections, but vary the prose.

Template:

\`\`\`
# HIVE — YYYY-MM-DD

## Headline
<1–2 sentences. What mattered most overnight.>

## Per project
### project-name
- What shipped / decisions / open threads (≤5 bullets)
- Heartbeat findings since last briefing (folded from inbox.md)
- Tickets that moved

## What needs your attention
- Highest-priority unresolved across projects, ranked

## Memory + verifier
- Added: N entries. Superseded: N. Reflections: N.
- Taste: reinforced <principle> · correction <pattern>
- Verifier flags: <gap count, or "none">
\`\`\`

If a section has nothing real to say, omit it rather than padding. Section "What needs your attention" can be a single line — "All caught up."

# OUTPUT — strict schema

Return ONE JSON object, no fences, no prose around it:

{
  "decisions": [
    {
      "candidate_id": "B.<projectId>[<index>]" | "C[<index>]" | "candidates.<projectId>[<index>]",
      "action": "accept" | "supersede" | "merge" | "reject",
      "target_hash": "<8-char hex from canon, required for supersede/merge>",
      "reason": "<required for reject>",
      "added_tags": ["..."]            // optional, mainly for merge
    }
  ],
  "gaps": [
    { "subject": "<project or greg/maya/system>", "observation": "...", "source": "..." }
  ],
  "taste": {
    "reinforced": [{ "principle": "...", "evidence": "..." }],
    "corrections": [{ "pattern": "...", "evidence": "..." }]
  },
  "briefing_markdown": "<full briefing per template>"
}

Schema discipline: every candidate listed in the inputs MUST appear in decisions[] exactly once. No silent drops, no duplicate decisions.`;

// ---------------------------------------------------------------------------
// User content assembly
// ---------------------------------------------------------------------------

export interface VerifierInputBundle {
  date: string;
  condition: ConditionReport;
  perProject: Array<{
    projectId: string;
    canon: SerializedCanon;
    midSessionCandidates: Candidate[];
    inboxText: string;
    bCandidates: ProjectCandidate[];
  }>;
  cCandidates: ReflectionCandidate[];
  principlesText: string;
}

export function buildVerifierUserContent(bundle: VerifierInputBundle): string {
  const sections: string[] = [];

  sections.push(`# Pass V — Verify · ${bundle.date}

You receive the day's full signal below. Output the JSON object per the system prompt.

`);

  sections.push(`## Conditioning report (Pass A)

\`\`\`json
${JSON.stringify(
    {
      date: bundle.condition.date,
      hoursWindow: bundle.condition.hoursWindow,
      trivial: bundle.condition.trivial,
      totals: bundle.condition.totals,
      projects: bundle.condition.projects.map((p) => ({
        projectName: p.projectName,
        sessions: p.sessions,
        git: p.git,
        tickets: p.tickets,
        heartbeat: p.heartbeat,
      })),
    },
    null,
    2,
  )}
\`\`\`
`);

  sections.push(`## Taste principles (the lens)

${bundle.principlesText.trim() || "(no principles file present)"}
`);

  // Per-project blocks
  for (const block of bundle.perProject) {
    const headerLines: string[] = [`### Project: ${block.projectId}`];

    headerLines.push(`\n#### Canon (existing entries — reference target_hash by hash)\n`);
    headerLines.push(
      "```json\n" +
        JSON.stringify(
          {
            facts: block.canon.facts,
            conventions: block.canon.conventions,
            decisions: block.canon.decisions,
            questions: block.canon.questions,
          },
          null,
          2,
        ) +
        "\n```",
    );

    headerLines.push(`\n#### Mid-session candidates (candidates.md, ${block.midSessionCandidates.length})\n`);
    if (block.midSessionCandidates.length > 0) {
      headerLines.push(
        "```json\n" +
          JSON.stringify(
            block.midSessionCandidates.map((c, i) => ({
              candidate_id: `candidates.${block.projectId}[${i}]`,
              ...c,
            })),
            null,
            2,
          ) +
          "\n```",
      );
    } else {
      headerLines.push("(none)");
    }

    headerLines.push(`\n#### Pass B candidates (Sonnet, ${block.bCandidates.length})\n`);
    if (block.bCandidates.length > 0) {
      headerLines.push(
        "```json\n" +
          JSON.stringify(
            block.bCandidates.map((c, i) => ({
              candidate_id: `B.${block.projectId}[${i}]`,
              ...c,
            })),
            null,
            2,
          ) +
          "\n```",
      );
    } else {
      headerLines.push("(none — Pass B emitted nothing for this project)");
    }

    headerLines.push(`\n#### Heartbeat inbox (${block.inboxText.length} chars)\n`);
    headerLines.push(block.inboxText.trim() || "(empty)");

    sections.push(headerLines.join("\n"));
  }

  sections.push(`## Pass C reflection candidates (${bundle.cCandidates.length})

${
    bundle.cCandidates.length > 0
      ? "```json\n" +
        JSON.stringify(
          bundle.cCandidates.map((c, i) => ({ candidate_id: `C[${i}]`, ...c })),
          null,
          2,
        ) +
        "\n```"
      : "(none)"
  }
`);

  sections.push(`## Output

Return the JSON object per the system prompt schema. Every candidate id above must appear exactly once in decisions[].`);

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
      // tolerate missing or malformed Pass C
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
        // tolerate
      }
    }

    const canon = await serializeProjectCanon(paths, projectId);
    const midSession = await readCandidates(paths, projectId);
    const inboxPath = join(paths.projectsDir, projectId, "inbox.md");
    const inboxText = existsSync(inboxPath) ? readFileSync(inboxPath, "utf-8") : "";

    // Skip projects with zero signal AND zero inputs — saves Opus tokens.
    const hasInput =
      bCandidates.length > 0 ||
      midSession.length > 0 ||
      canon.facts.length > 0 ||
      canon.conventions.length > 0 ||
      canon.decisions.length > 0 ||
      canon.questions.length > 0 ||
      inboxText.trim().length > 0;
    if (!hasInput) continue;

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

const defaultCaller: ModelCaller = (input) => completePiText(input);

export async function callVerifier(
  systemPrompt: string,
  userContent: string,
  caller: ModelCaller = defaultCaller,
): Promise<VerifierCallResult> {
  const { provider, modelId } = verifierModel();
  const response = await caller({ provider, modelId, systemPrompt, userContent });
  const raw = response.text;
  const parsed = parseVerifierJson(raw);
  const validated = validateVerifierOutput(parsed);
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
    tastePath: string;
    briefingPath: string;
    verifierOutputPath: string;
    usagePath: string;
  };
  usage: PassUsageRecord;
  cost: CostBreakdown;
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

function formatTasteMarkdown(taste: VerifierTaste): string {
  const lines = ["# Taste readout", ""];
  if (taste.reinforced.length > 0) {
    lines.push("## Reinforced");
    for (const r of taste.reinforced) {
      lines.push(`- **${r.principle}** — ${r.evidence}`);
    }
    lines.push("");
  }
  if (taste.corrections.length > 0) {
    lines.push("## Corrections");
    for (const c of taste.corrections) {
      lines.push(`- **${c.pattern}** — ${c.evidence}`);
    }
    lines.push("");
  }
  if (taste.reinforced.length === 0 && taste.corrections.length === 0) {
    lines.push("No clear signal today.");
  }
  return lines.join("\n");
}

export async function runVerifier(opts: RunVerifierOptions): Promise<RunVerifierResult> {
  const runDir = join(opts.paths.memoryRunsDir, opts.date);
  await mkdir(runDir, { recursive: true });

  const decisionsPath = join(runDir, "decisions.json");
  const gapsPath = join(runDir, "gaps.md");
  const tastePath = join(runDir, "taste.md");
  const briefingPath = join(runDir, "briefing.md");
  const fullOutputPath = join(runDir, "verifier-output.json");

  // Clear any stale artifacts from a prior run on this date before the LLM
  // call. If Opus fails, downstream sees absence (correct) rather than
  // yesterday's success masquerading as today's.
  for (const p of [decisionsPath, gapsPath, tastePath, briefingPath, fullOutputPath]) {
    await rm(p, { force: true });
  }

  const bundle = await loadVerifierBundle(opts.paths, opts.date);
  const userContent = buildVerifierUserContent(bundle);
  const result = await callVerifier(VERIFIER_SYSTEM_PROMPT, userContent, opts.caller);

  await Bun.write(decisionsPath, JSON.stringify({ decisions: result.output.decisions }, null, 2));
  await Bun.write(gapsPath, formatGapsMarkdown(result.output.gaps));
  await Bun.write(tastePath, formatTasteMarkdown(result.output.taste));
  // Refine Opus's prose before landing — fixes flaky footer counts and surfaces
  // gaps as a section instead of just a count.
  const refined = refineBriefing(
    result.output.briefing_markdown,
    result.output.decisions,
    result.output.gaps,
  );
  await Bun.write(briefingPath, refined);
  // Full structured output — Pass F (Apply) consumes this for gap-landing
  // and taste-readout. Markdown files above are for humans.
  await Bun.write(fullOutputPath, JSON.stringify(result.output, null, 2));

  const usageRecord: Omit<PassUsageRecord, "recordedAt"> = {
    pass: "V",
    provider: result.usage.provider,
    model: result.usage.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    durationMs: result.usage.durationMs,
    cost: result.cost,
  };
  const summary = await appendUsageRecord(opts.paths, opts.date, usageRecord);

  return {
    output: result.output,
    artifacts: {
      decisionsPath,
      gapsPath,
      tastePath,
      briefingPath,
      verifierOutputPath: fullOutputPath,
      usagePath: usagePath(opts.paths, opts.date),
    },
    usage: summary.records[summary.records.length - 1]!,
    cost: result.cost,
  };
}

export const __VERIFIER_PROMPT = VERIFIER_SYSTEM_PROMPT;
