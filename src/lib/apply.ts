// Pass F — Apply. Walks the verifier's decisions.json and turns it into
// canonical mutations: appends accepted entries, supersedes by hash, merges
// tags, drains mid-session candidates, lands accepted reflections, lands
// project-scoped gaps as questions, copies the briefing into ~/.hive/briefings/.
//
// Per-project atomic — a failure on alpha doesn't block bravo.
//
// docs/specs/2026-04-26-memory-design.md §Pass F — Apply

import { existsSync } from "node:fs";
import { mkdir, copyFile, appendFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { HivePaths } from "./paths";
import { listProjects } from "./paths";
import { emptyInbox, inboxBodyHash, parseInbox } from "./inbox";
import {
  appendProjectMemory,
  drainCandidates,
  markEntryRecurrence,
  mergeTagsIntoEntry,
  rebuildIndex,
  readCandidates,
  supersedeEntryByHash,
  type Candidate,
  type MemorySection,
} from "./memory";
import {
  appendReflectionsToDay,
  checkDuplicate,
  type ReflectionLanding,
} from "./reflections";
import type {
  VerifierDecision,
  VerifierGap,
  VerifierOutput,
} from "./verify";
import type { ProjectCandidate, ReflectionCandidate } from "./extract";

// ---------------------------------------------------------------------------
// Candidate ID resolution
// ---------------------------------------------------------------------------

type ResolvedSource =
  | { kind: "B"; project: string; index: number }
  | { kind: "C"; index: number }
  | { kind: "candidates"; project: string; index: number };

const CANDIDATE_ID_RE = /^(B|C|candidates)(?:\.([^[]+))?\[(\d+)\]$/;

export function parseCandidateId(id: string): ResolvedSource | null {
  const m = id.match(CANDIDATE_ID_RE);
  if (!m) return null;
  const [, kind, project, idxStr] = m;
  const index = Number(idxStr);
  if (kind === "C") return { kind: "C", index };
  if (!project) return null;
  if (kind === "B") return { kind: "B", project, index };
  if (kind === "candidates") return { kind: "candidates", project, index };
  return null;
}

interface CandidateSources {
  B: Map<string, ProjectCandidate[]>;       // by projectId
  C: ReflectionCandidate[];
  midSession: Map<string, Candidate[]>;     // by projectId
}

async function loadCandidateSources(
  paths: HivePaths,
  date: string,
  projectIds: string[],
): Promise<CandidateSources> {
  const runDir = join(paths.memoryRunsDir, date);

  const B = new Map<string, ProjectCandidate[]>();
  for (const projectId of projectIds) {
    const file = join(runDir, `candidates.B.${projectId}.json`);
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(await Bun.file(file).text()) as { candidates?: ProjectCandidate[] };
      if (Array.isArray(parsed.candidates)) B.set(projectId, parsed.candidates);
    } catch {
      // intentional: tolerate missing or malformed Pass B artifact
    }
  }

  let C: ReflectionCandidate[] = [];
  const cFile = join(runDir, "candidates.C.json");
  if (existsSync(cFile)) {
    try {
      const parsed = JSON.parse(await Bun.file(cFile).text()) as { candidates?: ReflectionCandidate[] };
      if (Array.isArray(parsed.candidates)) C = parsed.candidates;
    } catch {
      // intentional: tolerate missing or malformed Pass C artifact
    }
  }

  const midSession = new Map<string, Candidate[]>();
  for (const projectId of projectIds) {
    const items = await readCandidates(paths, projectId);
    if (items.length > 0) midSession.set(projectId, items);
  }

  return { B, C, midSession };
}

// ---------------------------------------------------------------------------
// Per-project + per-subject outcome bookkeeping
// ---------------------------------------------------------------------------

export interface ProjectApplyOutcome {
  projectId: string;
  accepted: number;
  superseded: number;
  merged: number;
  rejected: number;
  directivesForceAdmitted: number;  // directives the verifier tried to reject but were kept (TK-123)
  gapsLanded: number;
  gapsRecurring: number;            // re-observed gaps annotated on the existing question (TK-147)
  gapsCovered: number;              // gaps already answered by canon or the identity stack
  drainedCandidates: number;
  drainPath: string | null;
  inboxTruncated: boolean;
  rebuiltIndex: boolean;
  errors: string[];
}

export interface ApplyResult {
  date: string;
  totals: {
    accepted: number;
    superseded: number;
    merged: number;
    rejected: number;
    directivesForceAdmitted: number;
    gapsLanded: number;
    gapsRecurring: number;
    gapsCovered: number;
    reflectionsLanded: number;
  };
  perProject: ProjectApplyOutcome[];
  reflectionFile: string | null;
  briefingPath: string | null;
  rejections: VerifierDecision[];
  errors: string[];
}

function emptyOutcome(projectId: string): ProjectApplyOutcome {
  return {
    projectId,
    accepted: 0,
    superseded: 0,
    merged: 0,
    rejected: 0,
    directivesForceAdmitted: 0,
    gapsLanded: 0,
    gapsRecurring: 0,
    gapsCovered: 0,
    drainedCandidates: 0,
    drainPath: null,
    inboxTruncated: false,
    rebuiltIndex: false,
    errors: [],
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function loadDecisionsArtifact(
  paths: HivePaths,
  date: string,
): Promise<{ decisions: VerifierDecision[] }> {
  const file = join(paths.memoryRunsDir, date, "decisions.json");
  const raw = JSON.parse(await Bun.file(file).text()) as { decisions?: VerifierDecision[] };
  return { decisions: Array.isArray(raw.decisions) ? raw.decisions : [] };
}

async function loadVerifierOutputArtifacts(
  paths: HivePaths,
  date: string,
): Promise<{ gaps: VerifierGap[] }> {
  // gaps.md is human-readable; the structured gaps we land come from the
  // verifier-output.json sidecar runVerifier writes. If absent, treat as empty.
  const file = join(paths.memoryRunsDir, date, "verifier-output.json");
  if (!existsSync(file)) return { gaps: [] };
  try {
    const parsed = JSON.parse(await Bun.file(file).text()) as VerifierOutput;
    return { gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [] };
  } catch {
    // intentional: corrupted verifier output — return empty defaults
    return { gaps: [] };
  }
}

type CapturedInbox = { projectId: string; bodyHash: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function loadCapturedInboxes(paths: HivePaths, date: string): Promise<CapturedInbox[]> {
  const file = join(paths.memoryRunsDir, date, "inboxes.json");
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(await Bun.file(file).text());
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.inboxes)) return [];
    return parsed.inboxes.flatMap((value): CapturedInbox[] => {
      if (!isRecord(value)) return [];
      if (typeof value.projectId !== "string" || typeof value.bodyHash !== "string") return [];
      return [{ projectId: value.projectId, bodyHash: value.bodyHash }];
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The core walk — per project, atomic
// ---------------------------------------------------------------------------

interface ApplyContext {
  paths: HivePaths;
  date: string;
  dryRun: boolean;
  sources: CandidateSources;
  projectIds: Set<string>;
}

async function lookupContent(
  ctx: ApplyContext,
  source: ResolvedSource,
): Promise<{ type: MemorySection; content: string; tags: string[]; provenance: string; directive?: boolean } | null> {
  if (source.kind === "B") {
    // Pass B candidates are Sonnet-extracted, never user directives.
    const list = ctx.sources.B.get(source.project) ?? [];
    const c = list[source.index];
    if (!c) return null;
    return { type: c.type, content: c.content, tags: c.tags, provenance: c.provenance };
  }
  if (source.kind === "candidates") {
    const list = ctx.sources.midSession.get(source.project) ?? [];
    const c = list[source.index];
    if (!c) return null;
    return { type: c.type, content: c.content, tags: c.tags, provenance: c.provenance, directive: c.directive };
  }
  return null;
}

// Resolve whether a project decision targets a user directive — used both to
// keep the rejection audit log honest and to force-admit in applyProjectDecision.
function isDirectiveSource(ctx: ApplyContext, source: ResolvedSource): boolean {
  if (source.kind !== "candidates") return false;
  return (ctx.sources.midSession.get(source.project) ?? [])[source.index]?.directive === true;
}

async function applyProjectDecision(
  ctx: ApplyContext,
  outcome: ProjectApplyOutcome,
  decision: VerifierDecision,
  source: ResolvedSource,
): Promise<{ forceAdmitted: boolean }> {
  const none = { forceAdmitted: false };
  const projectId = "project" in source ? source.project : null;
  if (!projectId) return none; // shouldn't happen for project decisions

  const content = await lookupContent(ctx, source);
  if (!content) {
    outcome.errors.push(`Could not resolve candidate ${decision.candidate_id}`);
    return none;
  }

  if (decision.action === "accept") {
    if (!ctx.dryRun) {
      try {
        await appendProjectMemory(
          ctx.paths,
          projectId,
          content.type,
          content.content,
          content.tags,
        );
      } catch (err) {
        outcome.errors.push(
          `accept ${decision.candidate_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return none;
      }
    }
    outcome.accepted++;
    return none;
  }

  if (decision.action === "supersede") {
    if (!decision.target_hash) {
      outcome.errors.push(`supersede ${decision.candidate_id} missing target_hash`);
      return none;
    }
    if (!ctx.dryRun) {
      try {
        await supersedeEntryByHash(
          ctx.paths,
          projectId,
          content.type,
          decision.target_hash,
          content.content,
          content.tags,
        );
      } catch (err) {
        outcome.errors.push(
          `supersede ${decision.candidate_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return none;
      }
    }
    outcome.superseded++;
    return none;
  }

  if (decision.action === "merge") {
    if (!decision.target_hash) {
      outcome.errors.push(`merge ${decision.candidate_id} missing target_hash`);
      return none;
    }
    const tagsToMerge = decision.added_tags ?? content.tags;
    if (!ctx.dryRun) {
      try {
        await mergeTagsIntoEntry(
          ctx.paths,
          projectId,
          content.type,
          decision.target_hash,
          tagsToMerge,
        );
      } catch (err) {
        outcome.errors.push(
          `merge ${decision.candidate_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
        return none;
      }
    }
    outcome.merged++;
    return none;
  }

  if (decision.action === "reject") {
    // TK-123: a user directive is not subject to the verifier's veto. If the
    // model rejected one anyway, force-admit it to canon — the human already
    // decided it was worth keeping. The prompt tells the verifier never to
    // reject a directive; this is the backstop that makes the guarantee real.
    if (content.directive) {
      if (!ctx.dryRun) {
        try {
          await appendProjectMemory(
            ctx.paths,
            projectId,
            content.type,
            content.content,
            content.tags,
          );
        } catch (err) {
          outcome.errors.push(
            `directive force-admit ${decision.candidate_id}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { forceAdmitted: true };
        }
      }
      outcome.accepted++;
      outcome.directivesForceAdmitted++;
      return { forceAdmitted: true };
    }
    outcome.rejected++;
    return none;
  }

  return none;
}

async function applyReflectionDecision(
  ctx: ApplyContext,
  decision: VerifierDecision,
  index: number,
  pendingLandings: ReflectionLanding[],
  rejections: VerifierDecision[],
): Promise<{ accepted: number; rejected: number }> {
  const candidate = ctx.sources.C[index];
  if (!candidate) return { accepted: 0, rejected: 0 };

  if (decision.action === "accept") {
    pendingLandings.push({
      subject: candidate.subject,
      content: candidate.content,
      tags: candidate.tags,
      provenance: candidate.provenance,
    });
    return { accepted: 1, rejected: 0 };
  }
  if (decision.action === "reject") {
    rejections.push(decision);
    return { accepted: 0, rejected: 1 };
  }
  // supersede / merge for reflections is out of scope in V1 — the V0 reflections
  // file isn't hash-keyed. Treat as accept with a log entry.
  pendingLandings.push({
    subject: candidate.subject,
    content: candidate.content,
    tags: candidate.tags,
    provenance: candidate.provenance,
  });
  return { accepted: 1, rejected: 0 };
}

// ---------------------------------------------------------------------------
// Gaps that target a known project land as question-type entries.
// Gaps targeting greg/maya/system land as reflections.
// Other gap subjects stay briefing-only.
// ---------------------------------------------------------------------------

interface GapDisposition {
  subject: string;
  disposition: "question" | "recurring" | "covered" | "reflection" | "orphan";
  observation: string;
  source: string;
  /** What already covered it, for `covered` and `recurring`. */
  coveredBy?: string;
  /** New recurrence count, for `recurring`. */
  count?: number;
}

async function landGaps(
  ctx: ApplyContext,
  gaps: VerifierGap[],
  outcomeByProject: Map<string, ProjectApplyOutcome>,
  reflectionLandings: ReflectionLanding[],
): Promise<{
  asQuestions: number;
  asReflections: number;
  recurring: number;
  covered: number;
  orphans: number;
}> {
  let asQuestions = 0;
  let asReflections = 0;
  let recurring = 0;
  let covered = 0;
  let orphans = 0;
  // A gate that drops input has to say what it dropped, or the next reader
  // reads "3 gaps landed" as "3 gaps observed."
  const dispositions: GapDisposition[] = [];
  for (const g of gaps) {
    const subject = g.subject.toLowerCase();
    if (subject === "greg" || subject === "maya" || subject === "system") {
      reflectionLandings.push({
        subject: subject as ReflectionLanding["subject"],
        content: g.observation,
        tags: ["gap"],
        provenance: g.source,
      });
      dispositions.push({ subject, disposition: "reflection", observation: g.observation, source: g.source });
      asReflections++;
      continue;
    }
    if (ctx.projectIds.has(g.subject)) {
      const outcome = outcomeByProject.get(g.subject) ?? emptyOutcome(g.subject);
      outcomeByProject.set(g.subject, outcome);
      try {
        // TK-147: gaps go through the same dedupe gate as reflections. Without
        // it a gap the verifier re-observes lands as a fresh Open Question every
        // night, so a standing question reads as N unrelated ones.
        const dup = await checkDuplicate(ctx.paths, g.subject, g.observation);

        if (dup.duplicate && dup.knowledgeHit?.section === "question") {
          // Still open, seen again — one question getting louder.
          let count = 0;
          if (!ctx.dryRun) {
            ({ count } = await markEntryRecurrence(
              ctx.paths,
              g.subject,
              "question",
              dup.knowledgeHit.hash,
              ctx.date,
            ));
          }
          dispositions.push({
            subject: g.subject,
            disposition: "recurring",
            observation: g.observation,
            source: g.source,
            coveredBy: dup.coveredBy?.snippet,
            count,
          });
          outcome.gapsRecurring++;
          recurring++;
          continue;
        }

        if (dup.duplicate) {
          // Covered by a fact, convention, decision, or the identity stack —
          // it is not an open gap, so it does not become a question.
          dispositions.push({
            subject: g.subject,
            disposition: "covered",
            observation: g.observation,
            source: g.source,
            coveredBy: dup.coveredBy
              ? `${dup.coveredBy.source}: ${dup.coveredBy.snippet}`
              : undefined,
          });
          outcome.gapsCovered++;
          covered++;
          continue;
        }

        if (!ctx.dryRun) {
          await appendProjectMemory(
            ctx.paths,
            g.subject,
            "question",
            g.observation,
            ["gap"],
          );
        }
      } catch (err) {
        outcome.errors.push(
          `gap-as-question: ${err instanceof Error ? err.message : String(err)}`,
        );
        continue;
      }
      dispositions.push({
        subject: g.subject,
        disposition: "question",
        observation: g.observation,
        source: g.source,
      });
      outcome.gapsLanded++;
      asQuestions++;
      continue;
    }
    dispositions.push({ subject: g.subject, disposition: "orphan", observation: g.observation, source: g.source });
    orphans++;
  }

  if (dispositions.length > 0 && !ctx.dryRun) {
    const logPath = join(ctx.paths.memoryRunsDir, ctx.date, "gaps.applied.log");
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, dispositions.map((d) => JSON.stringify(d)).join("\n") + "\n");
  }

  return { asQuestions, asReflections, recurring, covered, orphans };
}

// ---------------------------------------------------------------------------
// Inbox truncation
// ---------------------------------------------------------------------------

async function truncateCapturedInbox(
  paths: HivePaths,
  projectId: string,
  expectedBodyHash: string,
): Promise<boolean> {
  const inboxPath = join(paths.projectsDir, projectId, "inbox.md");
  if (!existsSync(inboxPath)) return false;
  const current = parseInbox(await Bun.file(inboxPath).text(), projectId);
  if (inboxBodyHash(current.body) !== expectedBodyHash) return false;
  await writeFile(inboxPath, emptyInbox(projectId));
  return true;
}

// ---------------------------------------------------------------------------
// Briefing landing
// ---------------------------------------------------------------------------

async function landBriefing(paths: HivePaths, date: string): Promise<string | null> {
  const src = join(paths.memoryRunsDir, date, "briefing.md");
  if (!existsSync(src)) return null;
  const dest = join(paths.home, "briefings", `${date}.md`);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Top-level orchestration
// ---------------------------------------------------------------------------

export interface ApplyOptions {
  paths: HivePaths;
  date: string;
  dryRun?: boolean;
}

export async function applyDecisions(opts: ApplyOptions): Promise<ApplyResult> {
  const { paths, date } = opts;
  const dryRun = opts.dryRun ?? false;
  const projectIds = await listProjects(paths.projectsDir);
  const ctx: ApplyContext = {
    paths,
    date,
    dryRun,
    sources: await loadCandidateSources(paths, date, projectIds),
    projectIds: new Set(projectIds),
  };

  const { decisions } = await loadDecisionsArtifact(paths, date);
  const verifierExtras = await loadVerifierOutputArtifacts(paths, date);
  const capturedInboxes = await loadCapturedInboxes(paths, date);

  const outcomeByProject = new Map<string, ProjectApplyOutcome>();
  const ensureOutcome = (id: string): ProjectApplyOutcome => {
    let o = outcomeByProject.get(id);
    if (!o) {
      o = emptyOutcome(id);
      outcomeByProject.set(id, o);
    }
    return o;
  };

  const reflectionLandings: ReflectionLanding[] = [];
  const rejections: VerifierDecision[] = [];

  // Walk decisions
  for (const decision of decisions) {
    const source = parseCandidateId(decision.candidate_id);
    if (!source) {
      // Orphan id — log but continue
      continue;
    }
    if (source.kind === "C") {
      const r = await applyReflectionDecision(
        ctx,
        decision,
        source.index,
        reflectionLandings,
        rejections,
      );
      if (decision.action === "reject") {
        rejections.push(decision);
      }
      // C decisions don't have a project outcome; just skip
      void r;
      continue;
    }

    const outcome = ensureOutcome(source.project);
    const { forceAdmitted } = await applyProjectDecision(ctx, outcome, decision, source);
    // A force-admitted directive is an accept, not a rejection — keep it out of
    // the rejection audit log and the rejected tally (TK-123).
    if (decision.action === "reject" && !forceAdmitted) {
      rejections.push(decision);
    }
  }

  // Land gaps — projects-as-questions, identity-as-reflections
  const gapStats = await landGaps(ctx, verifierExtras.gaps, outcomeByProject, reflectionLandings);
  void gapStats; // captured indirectly via the per-project gap counters and reflectionLandings

  // Drain candidates.md and rebuild the index for projects whose canon changed.
  for (const projectId of projectIds) {
    const outcome = outcomeByProject.get(projectId);
    const midSession = ctx.sources.midSession.get(projectId) ?? [];
    // gapsRecurring counts too — a recurrence bump rewrites knowledge.md, so the
    // index has to be rebuilt from it. gapsCovered writes nothing.
    const touched =
      (outcome &&
        outcome.accepted + outcome.superseded + outcome.merged + outcome.gapsLanded + outcome.gapsRecurring > 0) ||
      midSession.length > 0;
    if (!touched) continue;
    const o = ensureOutcome(projectId);

    if (midSession.length > 0) {
      const drainPath = join(paths.memoryRunsDir, date, `candidates.consumed.${projectId}.md`);
      try {
        if (!dryRun) {
          const drain = await drainCandidates(paths, projectId, drainPath);
          o.drainedCandidates = drain.drained;
          o.drainPath = drain.destPath;
        } else {
          o.drainedCandidates = midSession.length;
          o.drainPath = drainPath;
        }
      } catch (err) {
        o.errors.push(`drain: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!dryRun) {
      try {
        await rebuildIndex(paths, projectId);
        o.rebuiltIndex = true;
      } catch (err) {
        o.errors.push(`rebuild-index: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Reflections + briefing
  let reflectionFile: string | null = null;
  let reflectionsLanded = 0;
  if (reflectionLandings.length > 0 && !dryRun) {
    try {
      const r = await appendReflectionsToDay(paths, date, reflectionLandings);
      reflectionFile = r.filePath;
      reflectionsLanded = r.written;
    } catch (err) {
      ensureOutcome("__reflections__").errors.push(
        `reflections: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else if (reflectionLandings.length > 0) {
    reflectionsLanded = reflectionLandings.length;
    reflectionFile = join(paths.reflectionsDir, `${date}.md`);
  }

  let briefingPath: string | null = null;
  if (!dryRun) {
    briefingPath = await landBriefing(paths, date);
  } else {
    const src = join(paths.memoryRunsDir, date, "briefing.md");
    if (existsSync(src)) briefingPath = join(paths.home, "briefings", `${date}.md`);
  }

  // The briefing is the acknowledgement for inbox consumption. Clear every
  // captured inbox, including inbox-only projects, only after that copy lands.
  // An inbox changed since Pass V is left intact so a concurrent note survives.
  if (!dryRun && briefingPath) {
    for (const captured of capturedInboxes) {
      const outcome = ensureOutcome(captured.projectId);
      try {
        outcome.inboxTruncated = await truncateCapturedInbox(
          paths,
          captured.projectId,
          captured.bodyHash,
        );
      } catch (err) {
        outcome.errors.push(`inbox-truncate: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Persist a rejection log for auditability
  if (rejections.length > 0 && !dryRun) {
    const rejPath = join(paths.memoryRunsDir, date, "rejections.log");
    const lines = rejections.map((r) => JSON.stringify(r));
    await mkdir(dirname(rejPath), { recursive: true });
    await appendFile(rejPath, lines.join("\n") + "\n");
  }

  const perProject = [...outcomeByProject.values()];
  const totals = perProject.reduce(
    (acc, o) => ({
      accepted: acc.accepted + o.accepted,
      superseded: acc.superseded + o.superseded,
      merged: acc.merged + o.merged,
      rejected: acc.rejected + o.rejected,
      directivesForceAdmitted: acc.directivesForceAdmitted + o.directivesForceAdmitted,
      gapsLanded: acc.gapsLanded + o.gapsLanded,
      gapsRecurring: acc.gapsRecurring + o.gapsRecurring,
      gapsCovered: acc.gapsCovered + o.gapsCovered,
      reflectionsLanded: acc.reflectionsLanded,
    }),
    {
      accepted: 0,
      superseded: 0,
      merged: 0,
      rejected: 0,
      directivesForceAdmitted: 0,
      gapsLanded: 0,
      gapsRecurring: 0,
      gapsCovered: 0,
      reflectionsLanded,
    },
  );
  totals.reflectionsLanded = reflectionsLanded;

  // Add raw rejection count too (some rejections weren't tied to a project outcome).
  totals.rejected = Math.max(totals.rejected, rejections.length);

  const errors = perProject.flatMap((o) => o.errors.map((e) => `${o.projectId}: ${e}`));

  return {
    date,
    totals,
    perProject,
    reflectionFile,
    briefingPath,
    rejections,
    errors,
  };
}
