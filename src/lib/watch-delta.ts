// Watch delta gate + scope assembly (TK-138).
//
// Deterministic pre-check before any model call — the rules engine in front of
// the standing question, same posture as heartbeat-trigger.ts: all signals are
// cheap and local (no network, no LLM). If nothing in scope changed since the
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
import { listTickets } from "./ticket";
import { extractRepoPath } from "./project";
import { extractExchanges, findRecentSessions, redact, resolveProjectName, shouldSkipUserText } from "./sessions";
import type { WatchDef, WatchScopeKind } from "./watch";

// ---------------------------------------------------------------------------
// Seams (testing + reuse)
// ---------------------------------------------------------------------------

export interface SessionFileInfo {
  project: string;
  file: string;
  mtimeMs: number;
}

/** Raw `git log` lines, newest first, format "%ct %h %s". Empty string when
 * the path isn't a repo or nothing landed since `sinceIso`. */
export type GitLogFn = (repoPath: string, sinceIso: string) => string;

export type SessionLister = (hoursAgo: number, now: Date) => Promise<SessionFileInfo[]>;

export interface DeltaSeams {
  gitLog?: GitLogFn;
  listSessions?: SessionLister;
}

const defaultGitLog: GitLogFn = (repoPath, sinceIso) => {
  try {
    return execSync(`git log --since='${sinceIso}' --pretty=format:'%ct %h %s' 2>/dev/null`, {
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
  args: { paths: HivePaths; windowMs: number; now: Date; gitLog: GitLogFn; sessions: SessionFileInfo[] },
): Promise<KindObservation> {
  const { paths, windowMs, now, gitLog, sessions } = args;
  const sinceIso = new Date(now.getTime() - windowMs).toISOString();
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
        const firstLine = gitLog(repo, sinceIso).split("\n")[0]?.trim() ?? "";
        const ct = firstLine.split(" ")[0];
        values[p] = /^\d+$/.test(ct) ? ct : "";
      }
      return { values, watermark: true };
    }
    case "transcripts": {
      for (const p of projects) {
        const newest = Math.max(0, ...sessions.filter((s) => s.project === p).map((s) => Math.floor(s.mtimeMs)));
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
        const inbox = await readIfExists(getProjectPaths(paths, p).inbox);
        values[p] = inbox && inbox.trim() !== "" ? hash(inbox) : "";
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
 * heartbeat's first-tick rule); an entirely empty scope never triggers.
 */
export async function evaluateWatchDelta(args: {
  paths: HivePaths;
  watch: WatchDef;
  lastDigests: Record<string, string>;
  now: Date;
  seams?: DeltaSeams;
}): Promise<WatchDeltaEvaluation> {
  const { paths, watch, lastDigests, now } = args;
  const gitLog = args.seams?.gitLog ?? defaultGitLog;
  const listSessions = args.seams?.listSessions ?? defaultListSessions;

  const projects = watch.project ? [watch.project] : await listProjects(paths.projectsDir);
  const sessions = watch.scope.includes("transcripts")
    ? await listSessions(Math.max(1, Math.ceil(watch.windowMs / 3_600_000)), now)
    : [];

  const reasons: string[] = [];
  const fingerprints: Record<string, string> = {};

  for (const kind of watch.scope) {
    const { values, watermark } = await observeKind(kind, projects, {
      paths,
      windowMs: watch.windowMs,
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
  windowMs: number;
  now: Date;
  seams?: DeltaSeams;
}): Promise<ProjectActivity[]> {
  const { paths, windowMs, now } = args;
  const gitLog = args.seams?.gitLog ?? defaultGitLog;
  const listSessions = args.seams?.listSessions ?? defaultListSessions;
  const projects = args.projects ?? (await listProjects(paths.projectsDir));
  const sinceIso = new Date(now.getTime() - windowMs).toISOString();
  const sinceMs = now.getTime() - windowMs;
  const sessions = await listSessions(Math.max(1, Math.ceil(windowMs / 3_600_000)), now);

  const out: ProjectActivity[] = [];
  for (const p of projects) {
    const repo = await repoPathFor(paths, p);
    const commitLines = repo ? gitLog(repo, sinceIso).split("\n").filter((l) => l.trim()) : [];
    const sessionCount = sessions.filter((s) => s.project === p).length;
    let ticketsMoved = 0;
    try {
      const tickets = await listTickets(paths, p);
      ticketsMoved = tickets.filter((t) => {
        const u = new Date(t.updated).getTime();
        return !Number.isNaN(u) && u >= sinceMs;
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
}

/** Warm-project cap for cross-project digests: attention goes to the top
 * ranked projects; the rest are named in one line so nothing is silently
 * dropped (no-silent-caps canon). */
const MAX_DIGEST_PROJECTS = 5;
const SECTION_CHAR_CAP = 5_000;
const DIGEST_CHAR_CAP = 28_000;
const EXCERPT_CHAR_CAP = 280;
const MAX_SESSIONS_PER_PROJECT = 6;
const MAX_EXCERPTS_PER_SESSION = 4;
const MAX_COMMIT_LINES = 40;

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

export async function assembleWatchDigest(args: {
  paths: HivePaths;
  watch: WatchDef;
  now: Date;
  seams?: DeltaSeams;
}): Promise<WatchDigest> {
  const { paths, watch, now } = args;
  const gitLog = args.seams?.gitLog ?? defaultGitLog;
  const listSessions = args.seams?.listSessions ?? defaultListSessions;
  const sinceIso = new Date(now.getTime() - watch.windowMs).toISOString();
  const sinceMs = now.getTime() - watch.windowMs;

  const allProjects = watch.project ? [watch.project] : await listProjects(paths.projectsDir);
  const activity = await rankProjectActivity({
    paths,
    projects: allProjects,
    windowMs: watch.windowMs,
    now,
    seams: args.seams,
  });
  const warm = activity.filter((a) => a.score > 0);
  const focus = (warm.length > 0 ? warm : activity).slice(0, MAX_DIGEST_PROJECTS);
  const skipped = activity.filter((a) => !focus.some((f) => f.project === a.project));

  const sessions = watch.scope.includes("transcripts")
    ? await listSessions(Math.max(1, Math.ceil(watch.windowMs / 3_600_000)), now)
    : [];

  const provenance: string[] = [];
  const sections: string[] = [];
  const windowLabel = `${Math.round(watch.windowMs / 3_600_000)}h`;

  sections.push(
    `# Watch digest: ${watch.qualifiedName}`,
    `Window: last ${windowLabel}, as of ${now.toISOString()}.`,
    `Activity ranking: ${activity.map((a) => `${a.project}(${a.score})`).join(", ") || "none"}.`,
  );
  if (skipped.length > 0) {
    sections.push(`Not expanded (cold or beyond top ${MAX_DIGEST_PROJECTS}): ${skipped.map((a) => a.project).join(", ")}.`);
  }

  if (watch.scope.includes("runs")) {
    const runDirs = listRunDirs(paths).filter((d) => d.mtimeMs >= sinceMs).slice(0, 7);
    const lines: string[] = [];
    for (const d of runDirs) {
      const briefing = await readIfExists(join(paths.memoryRunsDir, d.date, "briefing.md"));
      if (briefing && briefing.trim()) {
        lines.push(`### runs/${d.date}/briefing.md`, briefing.trim().slice(0, 1_800));
        provenance.push(`runs/${d.date}/briefing.md`);
      }
      const taste = await readIfExists(join(paths.memoryRunsDir, d.date, "taste-decisions.md"));
      if (taste && taste.trim()) {
        lines.push(`### runs/${d.date}/taste-decisions.md (tail)`, taste.trim().slice(-600));
        provenance.push(`runs/${d.date}/taste-decisions.md`);
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
          return !Number.isNaN(u) && u >= sinceMs;
        });
        if (moved.length > 0) {
          projLines.push(`### Tickets updated in window`);
          projLines.push(capSection(moved.map((t) => `- ${t.id} [${t.status}] ${t.title} (updated ${t.updated})`)));
          provenance.push(...moved.map((t) => t.id));
        }
      } catch {
        // intentional: unreadable tickets dir — section omitted
      }
    }

    if (watch.scope.includes("commits")) {
      const repo = await repoPathFor(paths, project);
      const lines = repo ? gitLog(repo, sinceIso).split("\n").filter((l) => l.trim()) : [];
      if (lines.length > 0) {
        const rendered = lines.slice(0, MAX_COMMIT_LINES).map((l) => {
          const [, sha, ...subject] = l.split(" ");
          if (sha) provenance.push(sha);
          return `- ${sha ?? "?"} ${subject.join(" ")}`;
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
        provenance.push(label);
        lines.push(`— session ${label}`);
        const userTexts = extractExchanges(s.file)
          .filter((e) => e.role === "user" && !shouldSkipUserText(e.text))
          .map((e) => redact(e.text));
        for (const text of userTexts.slice(0, MAX_EXCERPTS_PER_SESSION)) {
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
      const knowledge = await readIfExists(knowledgePath);
      const candidates = await readIfExists(join(paths.memoryProjectsDir, project, "candidates.md"));
      const lines: string[] = [];
      if (knowledge && knowledge.trim()) {
        lines.push(`— knowledge.md (tail)`, knowledge.trim().slice(-2_500));
        provenance.push(`memory/projects/${project}/knowledge.md`);
      }
      if (candidates && candidates.trim()) {
        lines.push(`— candidates.md`, candidates.trim().slice(-1_500));
        provenance.push(`memory/projects/${project}/candidates.md`);
      }
      if (lines.length > 0) projLines.push(`### Memory`, capSection(lines));
    }

    if (watch.scope.includes("inbox")) {
      const inbox = await readIfExists(getProjectPaths(paths, project).inbox);
      if (inbox && inbox.trim()) {
        projLines.push(`### Inbox (tail)`, inbox.trim().slice(-1_200));
        provenance.push(`projects/${project}/inbox.md`);
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
  return { text, provenance, empty };
}
