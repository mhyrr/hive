// Watch delta gate + scope assembly (TK-138).
//
// Deterministic pre-check before any model call — the rules engine in front of
// the standing question. All signals are cheap and local (no network, no
// LLM). If nothing in scope changed since the
// watch last looked, the tick costs zero tokens.
//
// Two detector styles, chosen to avoid phantom deltas from sliding windows:
// - content-hash kinds (tickets, memory, inbox): fingerprint the FULL current
//   state — it only changes when someone actually edits something.
// - watermark kinds (commits, transcripts): a monotonic high-water mark
//   (newest commit time, newest session mtime). Items aging OUT of the window
//   can only lower the current mark, and lower never triggers.
//
// Digest assembly is separate from the gate: the gate gathers fingerprints
// (cheap), the digest gathers actual content — and only runs for watches the
// gate passed. The digest is the model's ENTIRE input; the model judges, it
// never gathers (budget design, TK-138 note).

import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

import { getProjectPaths, listProjects, type HivePaths } from "./paths";
import { parseInbox } from "./inbox";
import { listTickets, readTicket } from "./ticket";
import { extractRepoPath } from "./project";
import { extractExchanges, findRecentSessions, redact, resolveProjectName, shouldSkipUserText } from "./sessions";
import { canonEntriesCreatedBetween } from "./memory";
import type { WatchDef, WatchScopeKind } from "./watch";

// ---------------------------------------------------------------------------
// Seams (testing + reuse)
// ---------------------------------------------------------------------------

export interface SessionFileInfo {
  project: string;
  file: string;
  mtimeMs: number;
}

/** Raw `git log` lines, newest first, format "%ct %h %s". */
export type GitLogFn = (repoPath: string, sinceIso: string, untilIso: string) => string;

export type SessionLister = (hoursAgo: number, now: Date) => Promise<SessionFileInfo[]>;

export interface DeltaSeams {
  gitLog?: GitLogFn;
  listSessions?: SessionLister;
}

const defaultGitLog: GitLogFn = (repoPath, sinceIso, untilIso) => {
  try {
    return execSync(`git log --since='${sinceIso}' --until='${untilIso}' --pretty=format:'%ct %h %s' 2>/dev/null`, {
      cwd: repoPath,
      encoding: "utf-8",
    }).trim();
  } catch {
    // intentional: not a git repo or git unavailable — no commit signal
    return "";
  }
};

const defaultListSessions: SessionLister = async (hoursAgo, now) => {
  const out: SessionFileInfo[] = [];
  for (const bundle of findRecentSessions(hoursAgo, now)) {
    const project = await resolveProjectName(bundle);
    for (const file of bundle.files) {
      try {
        out.push({ project, file, mtimeMs: statSync(file).mtimeMs });
      } catch {
        // intentional: session file vanished between listing and stat
      }
    }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

async function repoPathFor(paths: HivePaths, project: string): Promise<string | null> {
  try {
    const config = await Bun.file(getProjectPaths(paths, project).config).text();
    return extractRepoPath(config);
  } catch {
    // intentional: unregistered or configless project — no repo signal
    return null;
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

function changedWithin(path: string, sinceMs: number, untilMs: number): boolean {
  try {
    const mtime = statSync(path).mtimeMs;
    return mtime >= sinceMs && mtime <= untilMs;
  } catch {
    return false;
  }
}

/** Encode per-project values into one storable fingerprint string, and back.
 * Kept human-readable so state.json stays debuggable. */
function encodePerProject(values: Record<string, string>): string {
  return Object.entries(values)
    .filter(([, v]) => v !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([p, v]) => `${p}=${v}`)
    .join(";");
}

function decodePerProject(fingerprint: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fingerprint) return out;
  for (const part of fingerprint.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Fingerprints (the gate)
// ---------------------------------------------------------------------------

interface KindObservation {
  /** project → current value ("" = nothing observed). */
  values: Record<string, string>;
  watermark: boolean;
}

async function observeKind(
  kind: WatchScopeKind,
  projects: string[],
  args: { paths: HivePaths; since: Date; now: Date; gitLog: GitLogFn; sessions: SessionFileInfo[] },
): Promise<KindObservation> {
  const { paths, since, now, gitLog, sessions } = args;
  const sinceIso = since.toISOString();
  const untilIso = now.toISOString();
  const values: Record<string, string> = {};

  switch (kind) {
    case "tickets": {
      for (const p of projects) {
        try {
          const tickets = await listTickets(paths, p);
          values[p] = tickets.length === 0
            ? ""
            : hash(tickets.map((t) => `${t.id}:${t.status}:${t.updated}`).sort().join("\n"));
        } catch {
          values[p] = ""; // intentional: unreadable tickets dir — no signal
        }
      }
      return { values, watermark: false };
    }
    case "commits": {
      for (const p of projects) {
        const repo = await repoPathFor(paths, p);
        if (!repo) {
          values[p] = "";
          continue;
        }
        const firstLine = gitLog(repo, sinceIso, untilIso).split("\n")[0]?.trim() ?? "";
        const ct = firstLine.split(" ")[0];
        values[p] = /^\d+$/.test(ct) ? ct : "";
      }
      return { values, watermark: true };
    }
    case "transcripts": {
      for (const p of projects) {
        const newest = Math.max(0, ...sessions
          .filter((s) => s.project === p && s.mtimeMs >= since.getTime() && s.mtimeMs <= now.getTime())
          .map((s) => Math.floor(s.mtimeMs)));
        values[p] = newest > 0 ? String(newest) : "";
      }
      return { values, watermark: true };
    }
    case "memory": {
      for (const p of projects) {
        const knowledge = await readIfExists(join(paths.memoryProjectsDir, p, "knowledge.md"));
        const candidates = await readIfExists(join(paths.memoryProjectsDir, p, "candidates.md"));
        const combined = `${knowledge ?? ""}\n${candidates ?? ""}`.trim();
        values[p] = combined === "" ? "" : hash(combined);
      }
      return { values, watermark: false };
    }
    case "inbox": {
      for (const p of projects) {
        const raw = await readIfExists(getProjectPaths(paths, p).inbox);
        const inbox = parseInbox(raw ?? "", p);
        values[p] = inbox.kind === "content" ? hash(inbox.body) : "";
      }
      return { values, watermark: false };
    }
    case "runs": {
      // Global, not per-project: the nightly run artifacts live in one tree.
      // Watermark = newest run-dir mtime, so a completed nightly (fresh
      // briefing/taste files) is the trigger.
      const newest = newestRunDirMtime(paths);
      values["nightly runs"] = newest > 0 ? String(newest) : "";
      return { values, watermark: true };
    }
  }
}

function listRunDirs(paths: HivePaths): Array<{ date: string; mtimeMs: number }> {
  try {
    const entries = readdirSync(paths.memoryRunsDir, { withFileTypes: true });
    const out: Array<{ date: string; mtimeMs: number }> = [];
    for (const e of entries) {
      if (!e.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(e.name)) continue;
      try {
        out.push({ date: e.name, mtimeMs: statSync(join(paths.memoryRunsDir, e.name)).mtimeMs });
      } catch {
        // intentional: dir vanished mid-scan
      }
    }
    return out.sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

function newestRunDirMtime(paths: HivePaths): number {
  return Math.floor(Math.max(0, ...listRunDirs(paths).map((d) => d.mtimeMs)));
}

export interface WatchDeltaEvaluation {
  changed: boolean;
  reasons: string[];
  /** kind → encoded per-project fingerprint, ready to persist as lastDigests. */
  fingerprints: Record<string, string>;
}

/**
 * The gate. `changed` is true when any in-scope kind shows something NEW for
 * some project: a hash kind whose non-empty value differs from what this watch
 * last saw, or a watermark kind whose mark moved forward. First evaluation of
 * a watch over non-empty scope counts as new (establish baseline AND look —
 * the first-tick rule); an entirely empty scope never triggers.
 */
export async function evaluateWatchDelta(args: {
  paths: HivePaths;
  watch: WatchDef;
  lastDigests: Record<string, string>;
  since: Date;
  now: Date;
  seams?: DeltaSeams;
}): Promise<WatchDeltaEvaluation> {
  const { paths, watch, lastDigests, since, now } = args;
  const gitLog = args.seams?.gitLog ?? defaultGitLog;
  const listSessions = args.seams?.listSessions ?? defaultListSessions;

  const projects = watch.project ? [watch.project] : await listProjects(paths.projectsDir);
  const sessions = watch.scope.includes("transcripts")
    ? await listSessions(Math.max(1, Math.ceil((now.getTime() - since.getTime()) / 3_600_000)), now)
    : [];

  const reasons: string[] = [];
  const fingerprints: Record<string, string> = {};

  for (const kind of watch.scope) {
    const { values, watermark } = await observeKind(kind, projects, {
      paths,
      since,
      now,
      gitLog,
      sessions,
    });
    const last = decodePerProject(lastDigests[kind]);
    const changedProjects: string[] = [];
    const next: Record<string, string> = {};

    // Iterate the observation's own keys: per-project kinds key by project,
    // the global `runs` kind keys by its single label.
    for (const p of Object.keys(values)) {
      const current = values[p] ?? "";
      const prior = last[p] ?? "";
      if (watermark) {
        // Monotonic: only a mark strictly beyond the stored one is news.
        const currentN = Number(current || 0);
        const priorN = Number(prior || 0);
        if (currentN > priorN) changedProjects.push(p);
        const maxN = Math.max(currentN, priorN);
        next[p] = maxN > 0 ? String(maxN) : "";
      } else {
        if (current !== "" && current !== prior) changedProjects.push(p);
        next[p] = current;
      }
    }

    fingerprints[kind] = encodePerProject(next);
    if (changedProjects.length > 0) {
      reasons.push(`${kind}: new activity in ${changedProjects.join(", ")}`);
    }
  }

  return { changed: reasons.length > 0, reasons, fingerprints };
}

// ---------------------------------------------------------------------------
// Activity ranking — where has the work actually been happening?
// ---------------------------------------------------------------------------

export interface ProjectActivity {
  project: string;
  commits: number;
  sessions: number;
  ticketsMoved: number;
  score: number;
}

/**
 * Deterministic attention ranking for cross-project watches: projects Greg has
 * actually touched in the window (commits, sessions, ticket movement) rank
 * first; untouched repos score 0 and get skipped by digest assembly. This is
 * the "ambient agent looks where you've been working" behavior — computed from
 * local signals, never a model call.
 */
export async function rankProjectActivity(args: {
  paths: HivePaths;
  projects?: string[];
  since: Date;
  now: Date;
  seams?: DeltaSeams;
}): Promise<ProjectActivity[]> {
  const { paths, since, now } = args;
  const gitLog = args.seams?.gitLog ?? defaultGitLog;
  const listSessions = args.seams?.listSessions ?? defaultListSessions;
  const projects = args.projects ?? (await listProjects(paths.projectsDir));
  const sinceIso = since.toISOString();
  const sinceMs = since.getTime();
  const untilMs = now.getTime();
  const sessions = (await listSessions(Math.max(1, Math.ceil((now.getTime() - sinceMs) / 3_600_000)), now))
    .filter((session) => session.mtimeMs >= sinceMs && session.mtimeMs <= untilMs);

  const out: ProjectActivity[] = [];
  for (const p of projects) {
    const repo = await repoPathFor(paths, p);
    const commitLines = repo ? gitLog(repo, sinceIso, now.toISOString()).split("\n").filter((l) => l.trim()) : [];
    const sessionCount = sessions.filter((s) => s.project === p).length;
    let ticketsMoved = 0;
    try {
      const tickets = await listTickets(paths, p);
      ticketsMoved = tickets.filter((t) => {
        const u = new Date(t.updated).getTime();
        return !Number.isNaN(u) && u >= sinceMs && u <= untilMs;
      }).length;
    } catch {
      // intentional: unreadable tickets dir — counts as no movement
    }
    const commits = commitLines.length;
    out.push({
      project: p,
      commits,
      sessions: sessionCount,
      ticketsMoved,
      score: commits + 2 * sessionCount + ticketsMoved,
    });
  }
  return out.sort((a, b) => b.score - a.score || a.project.localeCompare(b.project));
}

// ---------------------------------------------------------------------------
// Digest assembly (the model's input)
// ---------------------------------------------------------------------------

export interface WatchDigest {
  /** Markdown, pre-assembled — the model's entire evidence base. */
  text: string;
  /** Citable anchors present in the digest (ticket IDs, SHAs, session files). */
  provenance: string[];
  empty: boolean;
  /** Present only for an Act watch; zero means code found nothing dispatchable. */
  actCandidateCount?: number;
}

/** Warm-project cap is gone for fleet Observe: expand every project with
 * activity. Project-scoped Act/Propose already see one colony. Char caps
 * still bound the digest. Cold projects are named, not silently dropped. */
const SECTION_CHAR_CAP = 5_000;
const DIGEST_CHAR_CAP = 28_000;
const EXCERPT_CHAR_CAP = 280;
const MAX_SESSIONS_PER_PROJECT = 6;
const MAX_EXCERPTS_PER_SESSION = 4;
const MAX_COMMIT_LINES = 40;
const MAX_CANON_ENTRIES = 12;
const CANON_ENTRY_CHAR_CAP = 400;
const MAX_ACT_CANDIDATES = 12;
const MAX_ACT_TICKET_BODY_CHARS = 6_000;
const MAX_ACT_SECTION_CHARS = 16_000;

function capSection(lines: string[], cap: number = SECTION_CHAR_CAP): string {
  let total = 0;
  const kept: string[] = [];
  for (const line of lines) {
    if (total + line.length + 1 > cap) {
      kept.push(`… (${lines.length - kept.length} more line(s) truncated)`);
      break;
    }
    kept.push(line);
    total += line.length + 1;
  }
  return kept.join("\n");
}

async function runningTicketKeys(paths: HivePaths): Promise<Set<string>> {
  const out = new Set<string>();
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(paths.runsDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const name of entries) {
    if (!name.isDirectory() || !name.name.startsWith("RUN-")) continue;
    const dir = join(paths.runsDir, name.name);
    const status = await readIfExists(join(dir, "status"));
    if (status?.trim() !== "running") continue;
    const metadata = await readIfExists(join(dir, "run.json"));
    if (metadata) {
      try {
        const parsed = JSON.parse(metadata) as { projectId?: string; ticketId?: string };
        if (parsed.projectId && parsed.ticketId) {
          out.add(`${parsed.projectId}/${parsed.ticketId}`);
          continue;
        }
      } catch {
        // Legacy prose fallback below.
      }
    }
    const goal = await readIfExists(join(dir, "goal.md"));
    if (!goal) continue;
    const project = goal.match(/^Project:\s*(\S+)$/m)?.[1];
    const ticket = goal.match(/\b(TK-\d+)\b/)?.[1];
    if (project && ticket) out.add(`${project}/${ticket}`);
  }
  return out;
}

/** Deterministic half of Act: judgment sees only tickets code can safely execute. */
async function assembleActCandidates(
  paths: HivePaths,
  projects: string[],
  provenance: string[],
): Promise<{ lines: string[]; omitted: number }> {
  const running = await runningTicketKeys(paths);
  const candidates: Array<{ project: string; projectRank: number; priority: number; updated: string; tag: string; line: string }> = [];
  let omitted = 0;

  for (const [projectRank, project] of projects.entries()) {
    const repo = await repoPathFor(paths, project);
    if (!repo) continue;
    try {
      execSync("git rev-parse --verify main^{commit}", { cwd: repo, encoding: "utf-8", stdio: "pipe" });
    } catch {
      continue;
    }
    const all = await listTickets(paths, project).catch(() => []);
    const byId = new Map(all.map((ticket) => [ticket.id, ticket]));
    for (const ticket of all) {
      const key = `${project}/${ticket.id}`;
      if (ticket.status !== "open" || ticket.type === "epic" || ticket.priority === 0) continue;
      if (ticket.tags.includes("needs-greg") || running.has(key)) continue;
      if (ticket.depends.some((id) => byId.get(id)?.status !== "closed")) continue;
      const full = await readTicket(paths, project, ticket.id);
      if (!full?.body.trim()) continue;
      const body = full.body.trim();
      if (body.length > MAX_ACT_TICKET_BODY_CHARS) {
        omitted++;
        continue;
      }
      const tag = `[A:${key}]`;
      candidates.push({
        project,
        projectRank,
        priority: ticket.priority,
        updated: ticket.updated,
        tag,
        line: `- ${tag} P${ticket.priority} ${ticket.title}\n  ${body.replace(/\n/g, "\n  ")}`,
      });
    }
  }

  const ordered = candidates
    .sort((a, b) => a.projectRank - b.projectRank || a.priority - b.priority || b.updated.localeCompare(a.updated) || a.project.localeCompare(b.project));
  const selected: typeof ordered = [];
  let chars = 0;
  for (const candidate of ordered) {
    if (selected.length >= MAX_ACT_CANDIDATES || chars + candidate.line.length + 1 > MAX_ACT_SECTION_CHARS) {
      omitted++;
      continue;
    }
    selected.push(candidate);
    chars += candidate.line.length + 1;
    provenance.push(candidate.tag);
  }
  return { lines: selected.map((candidate) => candidate.line), omitted };
}

export async function assembleWatchDigest(args: {
  paths: HivePaths;
  watch: WatchDef;
  since: Date;
  now: Date;
  seams?: DeltaSeams;
}): Promise<WatchDigest> {
  const { paths, watch, since, now } = args;
  const gitLog = args.seams?.gitLog ?? defaultGitLog;
  const listSessions = args.seams?.listSessions ?? defaultListSessions;
  const sinceIso = since.toISOString();
  const sinceMs = since.getTime();
  const untilMs = now.getTime();

  const allProjects = watch.project ? [watch.project] : await listProjects(paths.projectsDir);
  const activity = await rankProjectActivity({
    paths,
    projects: allProjects,
    since,
    now,
    seams: args.seams,
  });
  const warm = activity.filter((a) => a.score > 0);
  const focus = watch.autonomy === "act" ? warm : (warm.length > 0 ? warm : activity);
  const skipped = activity.filter((a) => !focus.some((f) => f.project === a.project));

  const sessions = watch.scope.includes("transcripts")
    ? (await listSessions(Math.max(1, Math.ceil((now.getTime() - sinceMs) / 3_600_000)), now))
      .filter((session) => session.mtimeMs >= sinceMs && session.mtimeMs <= untilMs)
    : [];

  const provenance: string[] = [];
  const sections: string[] = [];
  let actCandidateCount: number | undefined;
  const elapsedMinutes = Math.max(1, Math.round((now.getTime() - sinceMs) / 60_000));
  const windowLabel = elapsedMinutes % 60 === 0
    ? `${elapsedMinutes / 60} hour${elapsedMinutes === 60 ? "" : "s"}`
    : `${Math.floor(elapsedMinutes / 60)}h ${elapsedMinutes % 60}m`;

  sections.push(
    `# Watch digest: ${watch.qualifiedName}`,
    `Activity interval: ${since.toISOString()} → ${now.toISOString()} (${windowLabel}).`,
    `Activity ranking: ${activity.map((a) => `${a.project}(${a.score})`).join(", ") || "none"}.`,
  );
  if (skipped.length > 0) {
    sections.push(`Not expanded (cold): ${skipped.map((a) => a.project).join(", ")}.`);
  }

  // Act's complete shortlist goes first so the global digest cap can never
  // leave a selectable tag whose specification was cut off later.
  if (watch.autonomy === "act") {
    const candidates = await assembleActCandidates(paths, focus.map((item) => item.project), provenance);
    actCandidateCount = candidates.lines.length;
    if (candidates.lines.length > 0) {
      sections.push(
        `\n## Eligible tickets`,
        `Code has already excluded P0s, epics, needs-greg, blocked, in-flight, and bodyless tickets. The model judges whether one is an unambiguous follow-on.`,
        candidates.lines.join("\n"),
        ...(candidates.omitted > 0 ? [`${candidates.omitted} additional ticket(s) omitted because the complete specification did not fit the Act shortlist.`] : []),
      );
    }
  }

  if (watch.scope.includes("runs")) {
    const runDirs = listRunDirs(paths).filter((d) => d.mtimeMs >= sinceMs && d.mtimeMs <= untilMs).slice(0, 7);
    const lines: string[] = [];
    for (const d of runDirs) {
      const briefing = await readIfExists(join(paths.memoryRunsDir, d.date, "briefing.md"));
      if (briefing && briefing.trim()) {
        const tag = `[R:${d.date}/briefing]`;
        lines.push(`### ${tag} runs/${d.date}/briefing.md`, briefing.trim().slice(0, 1_800));
        provenance.push(tag);
      }
      const taste = await readIfExists(join(paths.memoryRunsDir, d.date, "taste-decisions.md"));
      if (taste && taste.trim()) {
        const tag = `[R:${d.date}/taste]`;
        lines.push(`### ${tag} runs/${d.date}/taste-decisions.md (tail)`, taste.trim().slice(-600));
        provenance.push(tag);
      }
    }
    if (lines.length > 0) sections.push(`\n## Nightly runs in window`, capSection(lines, 12_000));
  }

  for (const { project } of focus) {
    const projLines: string[] = [`\n## Project: ${project}`];

    if (watch.scope.includes("tickets")) {
      try {
        const moved = (await listTickets(paths, project)).filter((t) => {
          const u = new Date(t.updated).getTime();
          return !Number.isNaN(u) && u >= sinceMs && u <= untilMs;
        });
        if (moved.length > 0) {
          projLines.push(`### Tickets updated in interval`);
          projLines.push(capSection(moved.map((t) => {
            const tag = `[T:${project}/${t.id}]`;
            provenance.push(tag);
            return `- ${tag} [${t.status}] ${t.title} (updated ${t.updated})`;
          })));
        }
      } catch {
        // intentional: unreadable tickets dir — section omitted
      }
    }

    if (watch.scope.includes("commits")) {
      const repo = await repoPathFor(paths, project);
      const lines = repo ? gitLog(repo, sinceIso, now.toISOString()).split("\n").filter((l) => l.trim()) : [];
      if (lines.length > 0) {
        const rendered = lines.slice(0, MAX_COMMIT_LINES).map((l) => {
          const [, sha, ...subject] = l.split(" ");
          const tag = sha ? `[C:${project}/${sha}]` : "[C:unknown]";
          if (sha) provenance.push(tag);
          return `- ${tag} ${subject.join(" ")}`;
        });
        if (lines.length > MAX_COMMIT_LINES) rendered.push(`… (${lines.length - MAX_COMMIT_LINES} more commit(s) truncated)`);
        projLines.push(`### Commits in window`, capSection(rendered));
      }
    }

    if (watch.scope.includes("transcripts")) {
      const projSessions = sessions
        .filter((s) => s.project === project)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, MAX_SESSIONS_PER_PROJECT);
      const lines: string[] = [];
      for (const s of projSessions) {
        const label = `${basename(s.file)} (${new Date(s.mtimeMs).toISOString().slice(0, 10)})`;
        const tag = `[S:${project}/${basename(s.file)}]`;
        provenance.push(tag);
        lines.push(`— ${tag} session ${label}`);
        const userTexts = extractExchanges(s.file)
          .filter((e) => e.role === "user" && !shouldSkipUserText(e.text))
          .map((e) => redact(e.text));
        // A session file can span hours or days. The tail is the part that most
        // plausibly caused its in-interval mtime and avoids leading setup text
        // masquerading as the latest activity.
        for (const text of userTexts.slice(-MAX_EXCERPTS_PER_SESSION)) {
          lines.push(`  > ${text.slice(0, EXCERPT_CHAR_CAP).replace(/\s+/g, " ")}${text.length > EXCERPT_CHAR_CAP ? "…" : ""}`);
        }
        if (userTexts.length > MAX_EXCERPTS_PER_SESSION) {
          lines.push(`  … (${userTexts.length - MAX_EXCERPTS_PER_SESSION} more exchange(s) in session)`);
        }
      }
      if (lines.length > 0) projLines.push(`### Sessions in window`, capSection(lines));
    }

    if (watch.scope.includes("memory")) {
      const knowledgePath = join(paths.memoryProjectsDir, project, "knowledge.md");
      const candidatesPath = join(paths.memoryProjectsDir, project, "candidates.md");
      const candidates = await readIfExists(candidatesPath);
      const lines: string[] = [];
      if (changedWithin(knowledgePath, sinceMs, untilMs)) {
        // What entered canon in the interval — not the file's tail. knowledge.md
        // is sectioned by type, so its tail is always Open Questions whatever
        // changed, and a watch reading it saw the same standing questions every
        // cycle as if they were news.
        const added = await canonEntriesCreatedBetween(
          paths,
          project,
          new Date(sinceMs).toISOString().slice(0, 10),
          new Date(untilMs).toISOString().slice(0, 10),
        ).catch(() => []);
        if (added.length > 0) {
          const tag = `[M:${project}/knowledge]`;
          const rendered = added.slice(0, MAX_CANON_ENTRIES).map((e) => {
            const text = e.text.length > CANON_ENTRY_CHAR_CAP ? `${e.text.slice(0, CANON_ENTRY_CHAR_CAP)}…` : e.text;
            return `- [${e.section} · ${e.createdAt}] ${text}`;
          });
          if (added.length > MAX_CANON_ENTRIES) {
            rendered.push(`… (${added.length - MAX_CANON_ENTRIES} more entr${added.length - MAX_CANON_ENTRIES === 1 ? "y" : "ies"} added in interval)`);
          }
          lines.push(`— ${tag} canon entries added in interval (${added.length})`, ...rendered);
          provenance.push(tag);
        }
      }
      if (candidates && candidates.trim() && changedWithin(candidatesPath, sinceMs, untilMs)) {
        const tag = `[M:${project}/candidates]`;
        lines.push(`— ${tag} candidates.md (current tail; file changed in interval)`, candidates.trim().slice(-1_500));
        provenance.push(tag);
      }
      if (lines.length > 0) projLines.push(`### Memory`, capSection(lines));
    }

    if (watch.scope.includes("inbox")) {
      const inboxPath = getProjectPaths(paths, project).inbox;
      const raw = await readIfExists(inboxPath);
      const inbox = parseInbox(raw ?? "", project);
      if (inbox.kind === "content" && changedWithin(inboxPath, sinceMs, untilMs)) {
        const tag = `[I:${project}]`;
        projLines.push(`### ${tag} Inbox (tail)`, inbox.body.slice(-1_200));
        provenance.push(tag);
      }
    }

    // A project heading with no content sections adds noise, not signal.
    if (projLines.length > 1) sections.push(...projLines);
  }

  let text = sections.join("\n");
  if (text.length > DIGEST_CHAR_CAP) {
    text = text.slice(0, DIGEST_CHAR_CAP) + "\n… (digest truncated at cap)";
  }
  const empty = !sections.some((s) => s.startsWith("\n## "));
  return { text, provenance: provenance.filter((tag) => text.includes(tag)), empty, actCandidateCount };
}
