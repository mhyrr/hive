// Pass B + C extractors. Single-model Sonnet calls that read the day's
// signal and emit structured candidate JSON for the verifier (Pass V) to admit.
//
// docs/specs/2026-04-26-memory-design.md §Pass B + Pass C

import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { completeClaudeTextBounded } from "./claude";
import type { HivePaths } from "./paths";
import { renderCanonDigest } from "./memory";
import { buildExchangeExcerpt } from "./condition";
import type { ConditionReport, ProjectSignal } from "./condition";
import { estimateCost, appendUsageRecord } from "./pricing";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODEL = "claude-sonnet-5";

function extractorModel(): { provider: string; modelId: string } {
  const override = process.env.HIVE_EXTRACT_MODEL;
  if (override && override.includes("/")) {
    const [provider, modelId] = override.split("/", 2);
    return { provider: provider!, modelId: modelId! };
  }
  return {
    provider: process.env.HIVE_EXTRACT_PROVIDER || DEFAULT_PROVIDER,
    modelId: override || DEFAULT_MODEL,
  };
}

// ---------------------------------------------------------------------------
// JSON parsing — tolerant of code fences and stray prose around the array
// ---------------------------------------------------------------------------

/** Parse `text` as a JSON array (or a `{candidates:[...]}` wrapper). Returns
 *  null on any failure so callers can fall through to the next strategy. */
function tryParseJsonArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray((parsed as { candidates?: unknown[] }).candidates)) {
      return (parsed as { candidates: unknown[] }).candidates;
    }
  } catch {
    // intentional: not valid JSON — caller tries the next strategy
  }
  return null;
}

export function parseExtractionJson(raw: string): unknown[] {
  const text = raw.trim();

  // 1. Direct parse FIRST. A valid array may contain ``` fences inside string
  //    values (taste candidates carry code examples) — stripping fences before
  //    parsing would corrupt it, so the clean case must win outright.
  const direct = tryParseJsonArray(text);
  if (direct) return direct;

  // 2. Strip a ``` / ```json fence wherever it appears. Models sometimes emit a
  //    prose preamble before the fenced block, and that preamble may itself
  //    start with "[" (which would defeat the bracket fallback below), so match
  //    the first fenced block ANYWHERE — not just an anchored whole-string one.
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch) {
    const fenced = tryParseJsonArray(fenceMatch[1]!.trim());
    if (fenced) return fenced;
  }

  // 3. Last resort: grab the first balanced [...] in the text.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    const sliced = tryParseJsonArray(text.slice(start, end + 1));
    if (sliced) return sliced;
  }

  throw new Error(
    `Could not parse extractor output as JSON array. First 200 chars: ${raw.slice(0, 200)}`,
  );
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const PROJECT_TYPES = new Set(["fact", "convention", "decision", "question"]);

export interface ProjectCandidate {
  type: "fact" | "convention" | "decision" | "question";
  content: string;
  tags: string[];
  provenance: string;
  supersedes_hint?: string;
}

export function validateProjectCandidate(obj: unknown): ProjectCandidate | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.type !== "string" || !PROJECT_TYPES.has(o.type)) return null;
  if (typeof o.content !== "string" || !o.content.trim()) return null;
  if (typeof o.provenance !== "string" || !o.provenance.trim()) return null;
  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase())
    : [];
  return {
    type: o.type as ProjectCandidate["type"],
    content: o.content.trim(),
    tags,
    provenance: o.provenance.trim(),
    ...(typeof o.supersedes_hint === "string" && o.supersedes_hint.trim()
      ? { supersedes_hint: o.supersedes_hint.trim() }
      : {}),
  };
}

const REFLECTION_SUBJECTS = new Set(["greg", "maya", "system"]);

export interface ReflectionCandidate {
  subject: "greg" | "maya" | "system";
  content: string;
  tags: string[];
  provenance: string;
}

export function validateReflectionCandidate(obj: unknown): ReflectionCandidate | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const subj = typeof o.subject === "string" ? o.subject.toLowerCase() : null;
  if (!subj || !REFLECTION_SUBJECTS.has(subj)) return null;
  if (typeof o.content !== "string" || !o.content.trim()) return null;
  if (typeof o.provenance !== "string" || !o.provenance.trim()) return null;
  const tags = Array.isArray(o.tags)
    ? o.tags.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase())
    : [];
  return {
    subject: subj as ReflectionCandidate["subject"],
    content: o.content.trim(),
    tags,
    provenance: o.provenance.trim(),
  };
}

// ---------------------------------------------------------------------------
// Pass B — Project extraction prompts
// ---------------------------------------------------------------------------

const PROJECT_SYSTEM_PROMPT = `You are a memory extractor for HIVE, a project-intelligence system that powers a craftsman's daily work.

Your job: read the day's signal for ONE project — top exchanges from sessions, git activity, ticket movement — and extract durable learnings as structured candidates. Another model (Opus, the verifier) will read your output and decide what lands in canon.

A learning is durable if:
- It will help a session a month from now (a constraint, decision rationale, gotcha, convention)
- It is non-obvious from the code or git history alone — i.e. someone reading the codebase later wouldn't reach this insight without the conversational context
- It can stand on its own without the surrounding exchange

Skip ruthlessly:
- Task status, work-in-progress, "currently doing X", "next we'll Y"
- Anything already in the canon digest below. The digest is truncated and budgeted; the verifier holds the full canon and dedupes by hash, so when you are unsure whether something is already captured, include it
- Speculative observations or ones with weak grounding
- User preferences or working-style observations — those go to a separate self-reflection channel
- Anything obvious from a glance at the code or commit messages

Output format: ONE valid JSON array. No prose, no commentary, no code fences.

Each element:
{
  "type": "fact" | "convention" | "decision" | "question",
  "content": "string under 600 chars, single line, no markdown headers",
  "tags": ["lowercase", "short", "topic-style"],
  "provenance": "brief reference to the source — e.g. 'topRanked[2] — Greg said: <short quote>' or 'commit <subject> — <why this matters>'",
  "supersedes_hint": "optional — if this clearly replaces an existing canon entry, paste a short snippet of that entry here. The verifier decides whether to honor."
}

Type discipline:
- fact: a durable truth about the project (architecture, constraint, dependency, gotcha)
- convention: an established way of working ("we always X", "never Y")
- decision: a deliberate choice with rationale, dated implicitly to today
- question: an open question worth tracking across sessions

If the day yielded no durable learnings for this project, return [].`;

function blockquote(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

interface BuildProjectUserContentOpts {
  projectId: string;
  signal: ProjectSignal;
  knowledgeText: string;
  date: string;
}

export function buildProjectExtractionUserContent(
  opts: BuildProjectUserContentOpts,
): string {
  const { projectId, signal, knowledgeText, date } = opts;
  const sections: string[] = [];

  sections.push(`# Pass B — Project extraction
Project: ${projectId}
Date: ${date}
`);

  sections.push(`## Existing canon (digest — one line per entry, strongest first)

${knowledgeText.trim() || "(empty — this is a fresh project)"}
`);

  sections.push(`## Git activity (last ${signal.git.commits} commit(s))

${signal.git.commits === 0
    ? "(no commits in window)"
    : signal.git.subjects.map((s) => `- ${s}`).join("\n") +
      `\n\nDiff: +${signal.git.insertions} −${signal.git.deletions} across ${signal.git.filesChanged} file(s)`}
`);

  if (signal.tickets.moved.length > 0) {
    sections.push(`## Tickets that moved

${signal.tickets.moved.map((t) => `- ${t.id} [${t.status}] ${t.title}`).join("\n")}
`);
  }

  if (signal.sessions.topRanked.length > 0) {
    const previews = signal.sessions.topRanked
      .map((r, i) => {
        const tags: string[] = [];
        if (r.alwaysInclude) tags.push("always-include");
        if (r.truncated) tags.push("head+tail excerpt");
        const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
        const timestamp = r.timestamp ? ` · ${r.timestamp}` : "";
        const session = r.source && r.sessionId ? ` · ${r.source}:${r.sessionId}` : "";
        const rank = Number.isFinite(r.signalRank) ? ` · signal-rank ${r.signalRank}` : "";
        return `### topRanked[${i}] — ${r.role}${timestamp}${session}${rank}${tagStr}\n${blockquote(r.preview)}`;
      })
      .join("\n\n");
    sections.push(`## Selected exchanges (${signal.sessions.exchangeCount} total in window)

The excerpts below are in chronological order. Later corrections and resolutions override earlier questions or plans. A "middle omitted" marker preserves the opening and conclusion of one long exchange.

${previews}
`);
  } else {
    sections.push(`## Sessions

(no session exchanges in window)
`);
  }

  sections.push(`## Output

Return a JSON array of candidates per the system prompt. Look for reusable conventions, decision rationale, and mechanisms across exchanges, not only local artifact facts. The verifier filters, so err toward surfacing: a durable learning you leave out is lost, a weak one costs one rejection.`);

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Pass C — Self-reflection extraction prompts
// ---------------------------------------------------------------------------

const REFLECTION_SYSTEM_PROMPT = `You are a self-reflection extractor for HIVE.

Your job: read the day's signal across ALL projects and surface durable observations about three subjects:
- "greg" — communication style, work patterns, what he values, how he gives feedback, friction points
- "maya" — Maya's tool habits, voice, productive moves, anti-patterns to learn from, recurring blind spots
- "system" — what's working in HIVE itself, what's friction, brittle paths, automation that earns its keep

A reflection is durable if it's broader than today — it would help a session a month from now calibrate working style or system design. One observation grounded in two pieces of evidence beats five speculative ones.

Skip:
- One-off events without a pattern
- Observations already captured in IDENTITY.md / SELF.md / AGENTS.md (provided below)
- Project-specific decisions or constraints — those are extracted in a separate per-project pass
- Vague platitudes ("Greg likes good code") — observations must be specific and actionable

Output format: ONE valid JSON array. No prose, no fences.

{
  "subject": "greg" | "maya" | "system",
  "content": "string under 600 chars, single line, specific and concrete",
  "tags": ["lowercase", "short"],
  "provenance": "brief reference — e.g. 'project=hive, topRanked[3] — Greg pushed back on length cap, accepted the tighter version'"
}

If the day yielded no durable reflections, return [].`;

interface BuildReflectionUserContentOpts {
  identityText: string; // bundled IDENTITY + SELF + AGENTS
  report: ConditionReport;
  date: string;
}

export function buildReflectionExtractionUserContent(
  opts: BuildReflectionUserContentOpts,
): string {
  const { identityText, report, date } = opts;
  const sections: string[] = [];

  sections.push(`# Pass C — Self-reflection extraction
Date: ${date}
`);

  sections.push(`## Existing identity layer (do not restate what's here)

${identityText.trim() || "(empty)"}
`);

  for (const project of report.projects) {
    if (project.sessions.topRanked.length === 0 && project.git.commits === 0) continue;
    const previews = [...project.sessions.topRanked]
      .sort((a, b) => {
        const aRank = Number.isFinite(a.signalRank) ? a.signalRank : Number.POSITIVE_INFINITY;
        const bRank = Number.isFinite(b.signalRank) ? b.signalRank : Number.POSITIVE_INFINITY;
        return aRank - bRank;
      })
      .slice(0, 10) // cap per-project to keep input bounded
      .sort((a, b) => {
        const aTime = Date.parse(a.timestamp ?? "");
        const bTime = Date.parse(b.timestamp ?? "");
        if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return 0;
        return aTime - bTime;
      })
      .map((r, i) => {
        const excerpt = buildExchangeExcerpt(r.preview, 300);
        const timestamp = r.timestamp ? `${r.timestamp} ` : "";
        return `- [${i}] ${timestamp}${r.role}: "${excerpt.text}"`;
      })
      .join("\n");
    sections.push(`### Project: ${project.projectName}

Git: ${project.git.commits} commit(s), +${project.git.insertions}/−${project.git.deletions}.
Top exchanges:
${previews || "(none)"}
`);
  }

  sections.push(`## Output

Return a JSON array of reflection candidates. Three sharp ones beat fifteen vague ones.`);

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Extractor invocation
// ---------------------------------------------------------------------------

export interface ExtractorCallResult<T> {
  candidates: T[];
  rejected: number;
  raw: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    durationMs: number | null;
    provider: string;
    model: string;
  };
}

// Harness-agnostic completion shape. `provider` is kept in the contract for
// usage accounting even though Claude Code is anthropic-only — pricing tables
// key off it.
export interface ModelTextCompletion {
  provider: string;
  model: string;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  durationMs: number | null;
}

export type ModelCaller = (input: {
  provider: string;
  modelId: string;
  systemPrompt: string;
  userContent: string;
}) => Promise<ModelTextCompletion>;

const defaultCaller: ModelCaller = (input) =>
  completeClaudeTextBounded({
    modelId: input.modelId,
    systemPrompt: input.systemPrompt,
    userContent: input.userContent,
  });

export async function callProjectExtractor(
  systemPrompt: string,
  userContent: string,
  caller: ModelCaller = defaultCaller,
): Promise<ExtractorCallResult<ProjectCandidate>> {
  const { provider, modelId } = extractorModel();
  const response = await caller({ provider, modelId, systemPrompt, userContent });
  const raw = response.text;
  const parsed = parseExtractionJson(raw);
  let rejected = 0;
  const candidates: ProjectCandidate[] = [];
  for (const item of parsed) {
    const valid = validateProjectCandidate(item);
    if (valid) candidates.push(valid);
    else rejected++;
  }
  return {
    candidates,
    rejected,
    raw,
    usage: {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      cacheReadTokens: response.cacheReadTokens,
      cacheCreationTokens: response.cacheCreationTokens,
      durationMs: response.durationMs,
      provider: response.provider,
      model: response.model,
    },
  };
}

export async function callReflectionExtractor(
  systemPrompt: string,
  userContent: string,
  caller: ModelCaller = defaultCaller,
): Promise<ExtractorCallResult<ReflectionCandidate>> {
  const { provider, modelId } = extractorModel();
  const response = await caller({ provider, modelId, systemPrompt, userContent });
  const raw = response.text;
  const parsed = parseExtractionJson(raw);
  let rejected = 0;
  const candidates: ReflectionCandidate[] = [];
  for (const item of parsed) {
    const valid = validateReflectionCandidate(item);
    if (valid) candidates.push(valid);
    else rejected++;
  }
  return {
    candidates,
    rejected,
    raw,
    usage: {
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      cacheReadTokens: response.cacheReadTokens,
      cacheCreationTokens: response.cacheCreationTokens,
      durationMs: response.durationMs,
      provider: response.provider,
      model: response.model,
    },
  };
}

// ---------------------------------------------------------------------------
// Top-level orchestration — read condition.json + canon, call extractor, write JSON
// ---------------------------------------------------------------------------

export async function loadConditionReport(
  paths: HivePaths,
  date: string,
): Promise<ConditionReport> {
  const file = join(paths.memoryRunsDir, date, "condition.json");
  const raw = await Bun.file(file).text();
  return JSON.parse(raw) as ConditionReport;
}

export async function loadProjectKnowledgeText(
  paths: HivePaths,
  projectId: string,
): Promise<string> {
  // A budgeted digest, not the file. The verifier holds the full canon and
  // dedupes by hash; Pass B only needs enough of it to steer away from the
  // obvious repeats.
  return renderCanonDigest(paths, projectId).catch(() => "");
}

export async function loadIdentityText(paths: HivePaths): Promise<string> {
  const files = [paths.identity, paths.self, paths.agents];
  const sections: string[] = [];
  for (const file of files) {
    try {
      sections.push(await Bun.file(file).text());
    } catch {
      // intentional: skip missing identity files — assemble what's available
    }
  }
  return sections.join("\n\n---\n\n");
}

export async function writeJsonArtifact(
  filePath: string,
  payload: unknown,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, JSON.stringify(payload, null, 2));
}

// Convenience surfaces used by the CLI.

export interface RunProjectExtractorOptions {
  paths: HivePaths;
  projectId: string;
  date: string;
  caller?: ModelCaller;
}

export async function runProjectExtractor(
  opts: RunProjectExtractorOptions,
): Promise<{ outputPath: string; result: ExtractorCallResult<ProjectCandidate> }> {
  const report = await loadConditionReport(opts.paths, opts.date);
  const signal = report.projects.find((p) => p.projectName === opts.projectId);
  if (!signal) {
    throw new Error(
      `Project "${opts.projectId}" not present in condition.json for ${opts.date}. Run \`hive memory condition\` first.`,
    );
  }
  // Clear any stale artifact from a prior run before the LLM call. If the
  // call fails, downstream sees absence (correct) instead of yesterday's
  // success masquerading as today's.
  const outputPath = join(
    opts.paths.memoryRunsDir,
    opts.date,
    `candidates.B.${opts.projectId}.json`,
  );
  await rm(outputPath, { force: true });

  const knowledgeText = await loadProjectKnowledgeText(opts.paths, opts.projectId);
  const userContent = buildProjectExtractionUserContent({
    projectId: opts.projectId,
    signal,
    knowledgeText,
    date: opts.date,
  });
  const result = await callProjectExtractor(
    PROJECT_SYSTEM_PROMPT,
    userContent,
    opts.caller,
  );
  const cost = estimateCost({
    provider: result.usage.provider,
    model: result.usage.model,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheCreationTokens: result.usage.cacheCreationTokens,
  });
  await writeJsonArtifact(outputPath, {
    pass: "B",
    project: opts.projectId,
    date: opts.date,
    extractedAt: new Date().toISOString(),
    candidates: result.candidates,
    rejected: result.rejected,
    usage: result.usage,
    cost,
  });
  await appendUsageRecord(opts.paths, opts.date, {
    pass: "B",
    project: opts.projectId,
    provider: result.usage.provider,
    model: result.usage.model,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    durationMs: result.usage.durationMs,
    cost,
  });
  return { outputPath, result };
}

export interface RunReflectionExtractorOptions {
  paths: HivePaths;
  date: string;
  caller?: ModelCaller;
}

export async function runReflectionExtractor(
  opts: RunReflectionExtractorOptions,
): Promise<{ outputPath: string; result: ExtractorCallResult<ReflectionCandidate> }> {
  const outputPath = join(opts.paths.memoryRunsDir, opts.date, "candidates.C.json");
  await rm(outputPath, { force: true });

  const report = await loadConditionReport(opts.paths, opts.date);
  const identityText = await loadIdentityText(opts.paths);
  const userContent = buildReflectionExtractionUserContent({
    identityText,
    report,
    date: opts.date,
  });
  const result = await callReflectionExtractor(
    REFLECTION_SYSTEM_PROMPT,
    userContent,
    opts.caller,
  );
  const cost = estimateCost({
    provider: result.usage.provider,
    model: result.usage.model,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheCreationTokens: result.usage.cacheCreationTokens,
  });
  await writeJsonArtifact(outputPath, {
    pass: "C",
    date: opts.date,
    extractedAt: new Date().toISOString(),
    candidates: result.candidates,
    rejected: result.rejected,
    usage: result.usage,
    cost,
  });
  await appendUsageRecord(opts.paths, opts.date, {
    pass: "C",
    provider: result.usage.provider,
    model: result.usage.model,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    durationMs: result.usage.durationMs,
    cost,
  });
  return { outputPath, result };
}

// Exposed for tests + downstream tooling.
export const __PROMPTS = {
  project: PROJECT_SYSTEM_PROMPT,
  reflection: REFLECTION_SYSTEM_PROMPT,
};
