/**
 * `hive attach <name>`: attach this terminal to a comb agent's background
 * Claude session, in the agent's own directory.
 *
 * comb keeps one workspace per agent at $COMB_HOME/agents/<name>/ with a
 * session.json that names the Claude session. This command reads it, checks
 * the session is still live in `claude agents --json`, and runs
 * `claude attach <id>` there with the terminal inherited.
 *
 * It never resumes an ended session: `--resume` on a session that is in fact
 * still live starts a second copy (comb docs/design.md §13). It prints how to
 * wake the agent instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

import { UsageError } from "../lib/errors";

/** The fields of comb's session.json this command reads. */
export type AgentSession = {
  name: string;
  id: string;
  sessionId: string;
  cwd: string;
  worktree: boolean;
};

/** One row of `claude agents --json`. Only the fields read here. */
export type LiveRow = {
  /** Short id; background rows have one, interactive rows do not. */
  id?: string;
  sessionId: string;
  name?: string;
  kind?: string;
  state?: string;
  status?: string;
};

// Agent names are directory names under $COMB_HOME/agents. Anything else
// (a slash, "..") is not an agent and must not become a path.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function combHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMB_HOME || join(homedir(), ".comb");
}

/** Agent names: workspaces under $COMB_HOME/agents that hold a session.json. */
export function listAgentNames(home: string): string[] {
  const dir = join(home, "agents");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "session.json")))
    .map((e) => e.name)
    .sort();
}

/** The agent's session.json, or null when there is no such agent. */
export function readAgentSession(home: string, name: string): AgentSession | null {
  if (!NAME_RE.test(name)) return null;
  const path = join(home, "agents", name, "session.json");
  if (!existsSync(path)) return null;
  let parsed: Partial<AgentSession>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new UsageError(`hive attach: ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed.cwd !== "string" || typeof parsed.sessionId !== "string" || typeof parsed.id !== "string") {
    throw new UsageError(`hive attach: ${path} has no cwd, id or sessionId.`);
  }
  return {
    name,
    id: parsed.id,
    sessionId: parsed.sessionId,
    cwd: parsed.cwd,
    worktree: parsed.worktree === true,
  };
}

/**
 * The directory the agent works in. Same rule as comb's agentWorkdir
 * (comb src/terminal.ts): session.json's cwd is normally the worktree for a
 * worktree agent, but comb has written it doubled
 * (<wt>/.claude/worktrees/<n>/.claude/worktrees/<n>), and older records hold
 * the repo root. So for a worktree agent whose cwd names
 * `.claude/worktrees/<name>`, the path up to its first mention, else cwd with
 * the worktree appended; then cwd itself. First that exists wins.
 */
export function agentWorkdir(
  s: Pick<AgentSession, "name" | "cwd" | "worktree">,
  exists: (p: string) => boolean = existsSync,
): string | null {
  if (!s.worktree) return exists(s.cwd) ? s.cwd : null;
  const seg = `${sep}.claude${sep}worktrees${sep}${s.name}`;
  const at = s.cwd.indexOf(seg);
  const named = at >= 0 && (s.cwd.length === at + seg.length || s.cwd[at + seg.length] === sep);
  const candidates = named
    ? [s.cwd.slice(0, at + seg.length), s.cwd]
    : [join(s.cwd, ".claude", "worktrees", s.name), s.cwd];
  return candidates.find((p) => exists(p)) ?? null;
}

/**
 * Whether a row has ended. Same rule as comb's isEnded: done or failed, or a
 * background row with no status (Claude's daemon retires an idle background
 * session but can leave its last state, with no status and no pid).
 */
export function isEnded(row: LiveRow): boolean {
  if (row.state === "done" || row.state === "failed") return true;
  return row.kind === "background" && !row.status;
}

/**
 * The live row for this agent, or null. Match on sessionId first. Fall back
 * to the name only when exactly one live row carries it, so a stray
 * same-named session never gets picked by guess.
 */
export function findLiveRow(rows: LiveRow[], s: AgentSession): LiveRow | null {
  const live = rows.filter((r) => !isEnded(r));
  const byId = live.find((r) => r.sessionId === s.sessionId);
  if (byId) return byId;
  const byName = live.filter((r) => r.name === s.name);
  return byName.length === 1 ? byName[0] : null;
}

/**
 * The argv that attaches. By id, because `claude attach` matches partial
 * names; the session name only for a row with no id.
 */
export function attachArgv(claude: string, row: LiveRow, s: AgentSession): string[] {
  return [claude, "attach", row.id ?? s.name];
}

export function endedMessage(s: AgentSession, dir: string): string {
  return [
    `${s.name} is not running: its session has ended.`,
    `A message wakes it with its history: ask Maya to send it one (agent_send to "${s.name}").`,
    `Or resume it yourself, then attach again:`,
    `  cd ${dir} && claude --bg --resume ${s.sessionId}`,
    `Only resume it if it is not running; a resume on a live session starts a second copy.`,
  ].join("\n");
}

export function unknownMessage(name: string, names: string[]): string {
  const list = names.length ? names.map((n) => `  ${n}`).join("\n") : "  (none)";
  return `hive attach: no comb agent named "${name}". Agents:\n${list}`;
}

export type AttachDeps = {
  env?: NodeJS.ProcessEnv;
  findClaude?: () => string;
  /** `claude agents --json` rows. */
  liveRows?: (claude: string) => LiveRow[];
  /** Runs argv in dir with the terminal inherited; returns the exit code. */
  spawn?: (argv: string[], dir: string) => number;
  exists?: (p: string) => boolean;
  out?: (line: string) => void;
};

function defaultFindClaude(): string {
  try {
    return execFileSync("which", ["claude"], { encoding: "utf-8" }).trim();
  } catch {
    // intentional: not on PATH; try the installer's location
    const fallback = join(homedir(), ".local", "bin", "claude");
    if (existsSync(fallback)) return fallback;
    throw new UsageError("hive attach: could not find the claude CLI.");
  }
}

function defaultLiveRows(claude: string): LiveRow[] {
  const stdout = execFileSync(claude, ["agents", "--json"], { encoding: "utf-8" });
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("claude agents --json did not return a list");
  return parsed as LiveRow[];
}

function defaultSpawn(argv: string[], dir: string): number {
  const result = Bun.spawnSync(argv, { cwd: dir, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return result.exitCode ?? 0;
}

/** Returns the exit code; the CLI exits with it. */
export async function runAttach(args: string[], deps: AttachDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.error(l));
  const exists = deps.exists ?? existsSync;
  const home = combHome(deps.env);

  const name = args[0];
  if (!name || args.length > 1 || name.startsWith("-")) {
    throw new UsageError("Usage: hive attach <agent-name>");
  }

  const session = readAgentSession(home, name);
  if (!session) {
    out(unknownMessage(name, listAgentNames(home)));
    return 1;
  }

  const dir = agentWorkdir(session, exists);
  if (!dir) {
    out(`hive attach: ${name}'s directory is gone (${session.cwd}).`);
    return 1;
  }

  const claude = (deps.findClaude ?? defaultFindClaude)();
  const row = findLiveRow((deps.liveRows ?? defaultLiveRows)(claude), session);
  if (!row) {
    out(endedMessage(session, dir));
    return 1;
  }

  return (deps.spawn ?? defaultSpawn)(attachArgv(claude, row, session), dir);
}

export async function attachCommand(args: string[]): Promise<void> {
  const code = await runAttach(args);
  if (code !== 0) process.exit(code);
}
