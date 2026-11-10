/**
 * hv agent workspaces (~/.hv/agents/<name>/) and the start path.
 *
 * The workspace is what lasts (D3): a session can be cleared or die, and a new
 * one starts from charter.md, checklist.md, memory/ and log.md. session.json
 * records the current harness session so the dashboard and parents can find it.
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { UsageError } from "./errors";
import { assembleIdentityForProject } from "./identity";
import { resolveProjectFromPath } from "./project";
import { ensureHvScaffold, resolveHvHome } from "./paths";
import {
  findClaudeBin,
  listLiveSessions,
  runProcess,
  startBackground,
  type LiveSession,
  type Run,
} from "./hv-claude";

/** Greg is the parent of agents he starts himself. He has no session. */
export const GREG = "greg";

export type AgentSession = {
  name: string;
  harness: "claude";
  id: string;
  sessionId: string;
  parent: string;
  project: string | null;
  cwd: string;
  worktree: boolean;
  permissionMode: string;
  startedAt: string;
};

const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;

export function validateAgentName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new UsageError(
      `Agent name "${name}" is not valid. Use lowercase letters, digits and dashes, starting with a letter (max 40).`,
    );
  }
  if (name === GREG) throw new UsageError(`"${GREG}" is reserved for Greg.`);
  return name;
}

export function agentDir(name: string, home: string = resolveHvHome()): string {
  return join(home, "agents", name);
}

const DEFAULT_CHECKLIST = `# Checklist

Each time you wake:

1. Read what arrived (a message, a child's report) and decide what it needs.
2. Check on your children with \`agent_list\`. A child that is gone without a
   report died; decide whether to restart it, replace it, or tell your parent.
3. Append to log.md what you did and why.
`;

async function createWorkspace(dir: string, name: string, charter: string): Promise<void> {
  await mkdir(join(dir, "reports"), { recursive: true });
  await mkdir(join(dir, "memory"), { recursive: true });
  await writeFile(join(dir, "charter.md"), charter.trim() + "\n", "utf-8");
  await writeFile(join(dir, "checklist.md"), DEFAULT_CHECKLIST, "utf-8");
  await writeFile(join(dir, "log.md"), `# Log: ${name}\n\n`, "utf-8");
}

/** The operating contract appended after HIVE identity. */
export function agentPreamble(a: { name: string; dir: string; parent: string }): string {
  const parentLine = a.parent === GREG
    ? `Your parent is Greg. He reads your reports/ and log.md on the hv dashboard and may message you directly. Put anything that needs him in a report.`
    : `Your parent is the agent "${a.parent}". Reach it with SendMessage to "${a.parent}" (ListAgents shows names). Tell it when you finish, are stuck, have a question, or have an idea.`;
  return `# HIVE v2 agent: ${a.name}

You are the hv agent "${a.name}", a long-lived background session. Your
workspace is ${a.dir}. Write only inside it and inside the repo you work in.

- charter.md: what you are for. Read it first. It is your scope; judge what fits.
- checklist.md: what to look at each time you wake.
- log.md: append one dated line or short entry for each thing you do, and why.
- memory/: your own notes. Keep what matters there, not in your context. Your
  session can be cleared, or restarted from this folder.
- reports/: when you finish a piece of work, write one file named
  YYYY-MM-DD-<slug>.md: what you did, the result, what is left. A session that
  ends without a report is treated as dead.

${parentLine}

When unsure, decide, get a second opinion, or go up to your parent with your
recommendation. To start a child agent for a piece of work, use the hv
\`agent_start\` tool; reach children with SendMessage by name. \`agent_list\`
shows every hv agent and whether its session is alive.

Code changes happen on your own branch or worktree. Never merge, never push.
External actions follow TRUST.md: ask through your parent.
`;
}

export function resolveHvMcpCommand(): { command: string; args: string[] } {
  if (process.env.HV_MCP_BIN) return { command: process.env.HV_MCP_BIN, args: [] };
  try {
    const bin = execSync("which hv-mcp", { encoding: "utf-8" }).trim();
    if (bin) return { command: bin, args: [] };
  } catch { /* intentional: not on PATH — try running from source */ }
  const source = join(import.meta.dir, "..", "hv-mcp-server.ts");
  if (existsSync(source)) return { command: "bun", args: [source] };
  throw new Error("Could not find hv-mcp. Build it: bun build src/hv-mcp-server.ts --compile --outfile hv-mcp");
}

async function writeMcpConfig(dir: string, name: string, home: string): Promise<string> {
  const { command, args } = resolveHvMcpCommand();
  const path = join(dir, "mcp.json");
  const config = {
    mcpServers: {
      hv: { type: "stdio", command, args, env: { HV_AGENT: name, HV_HOME: home } },
    },
  };
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return path;
}

export async function readAgentSession(name: string, home: string = resolveHvHome()): Promise<AgentSession | null> {
  const path = join(agentDir(name, home), "session.json");
  if (!existsSync(path)) return null;
  return JSON.parse(await readFile(path, "utf-8")) as AgentSession;
}

export type StartAgentOpts = {
  name: string;
  /** Required for a new agent. Omit to restart an existing one from its workspace. */
  charter?: string;
  parent?: string;
  cwd?: string;
  worktree?: boolean;
  prompt?: string;
  home?: string;
  permissionMode?: string;
  claudeBin?: string;
  run?: Run;
  wait?: (ms: number) => Promise<void>;
};

export type StartAgentResult = { session: AgentSession; restarted: boolean; dir: string };

export async function startAgent(opts: StartAgentOpts): Promise<StartAgentResult> {
  const name = validateAgentName(opts.name);
  const home = opts.home ?? resolveHvHome();
  await ensureHvScaffold(home);
  const dir = agentDir(name, home);
  const exists = existsSync(join(dir, "charter.md"));
  const parent = opts.parent ?? GREG;
  const run = opts.run ?? runProcess;
  const claude = opts.claudeBin ?? findClaudeBin();

  if (!exists && !opts.charter?.trim()) {
    throw new UsageError(`Agent "${name}" does not exist yet. Give it a charter.`);
  }
  if (exists && opts.charter?.trim()) {
    throw new UsageError(
      `Agent "${name}" already exists. Edit ${join(dir, "charter.md")} to change its charter, or start it again without one.`,
    );
  }

  const previous = exists ? await readAgentSession(name, home) : null;
  // A finished session stays listed as "done"; this agent's own one is the
  // session we are about to wake, so it is not a clash.
  const live = await listLiveSessions(claude, run);
  const clash = live.find(
    (s) => s.name === name && !(s.sessionId === previous?.sessionId && s.state === "done"),
  );
  if (clash) {
    throw new UsageError(
      `A session named "${name}" is already running (${clash.id}, ${clash.cwd}). Message it with SendMessage instead.`,
    );
  }

  const cwd = resolve(opts.cwd ?? previous?.cwd ?? process.cwd());
  if (!existsSync(cwd)) throw new UsageError(`Working directory does not exist: ${cwd}`);

  if (!exists) await createWorkspace(dir, name, opts.charter!);

  const project = resolveProjectFromPath(cwd);
  const identity = await assembleIdentityForProject(project);
  const systemPromptFile = join(dir, "system-prompt.md");
  await writeFile(systemPromptFile, `${identity}\n\n---\n\n${agentPreamble({ name, dir, parent })}`, "utf-8");
  const mcpConfigFile = await writeMcpConfig(dir, name, home);

  const prompt = opts.prompt?.trim() || (exists
    ? "You were restarted from your workspace. Read charter.md, checklist.md, memory/ and the end of log.md, then carry on."
    : "Read your charter.md and checklist.md, then begin.");
  const permissionMode = opts.permissionMode ?? process.env.HV_PERMISSION_MODE ?? "auto";

  // A previous session that died keeps its history; wake it rather than lose it.
  const resume = previous && previous.cwd === cwd ? previous.sessionId : undefined;
  let started;
  try {
    started = await startBackground(
      claude,
      { name, cwd, systemPromptFile, mcpConfigFile, prompt, permissionMode, resume, worktree: !resume && opts.worktree },
      run,
      opts.wait,
    );
  } catch (err) {
    // A new agent that never started leaves nothing behind, so the same
    // start can simply be retried.
    if (!exists) await rm(dir, { recursive: true, force: true });
    throw err;
  }

  const session: AgentSession = {
    name,
    harness: "claude",
    id: started.id,
    sessionId: started.sessionId,
    parent,
    project,
    cwd: started.cwd,
    worktree: previous?.worktree ?? !!opts.worktree,
    permissionMode,
    startedAt: new Date().toISOString(),
  };
  await writeFile(join(dir, "session.json"), JSON.stringify(session, null, 2) + "\n", "utf-8");
  const verb = exists ? (resume ? "resumed" : "restarted") : "started";
  await appendFile(
    join(dir, "log.md"),
    `- ${session.startedAt} ${verb} by ${parent} in ${session.cwd} (session ${session.id})\n`,
    "utf-8",
  );
  return { session, restarted: exists, dir };
}

export type AgentStatus = {
  name: string;
  parent: string | null;
  /** working / idle / blocked from the harness, or "gone" when the session is not live. */
  state: string;
  cwd: string | null;
  reports: number;
  lastLog: string | null;
};

export async function listAgents(opts: { home?: string; claudeBin?: string; run?: Run } = {}): Promise<AgentStatus[]> {
  const home = opts.home ?? resolveHvHome();
  const root = join(home, "agents");
  if (!existsSync(root)) return [];
  const names = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (names.length === 0) return [];

  const live = await listLiveSessions(opts.claudeBin ?? findClaudeBin(), opts.run ?? runProcess);
  const bySession = new Map<string, LiveSession>(live.map((s) => [s.sessionId, s]));

  const out: AgentStatus[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const session = await readAgentSession(name, home);
    const row = session ? bySession.get(session.sessionId) : undefined;
    const reportsDir = join(dir, "reports");
    const reports = existsSync(reportsDir) ? readdirSync(reportsDir).filter((f) => f.endsWith(".md")).length : 0;
    out.push({
      name,
      parent: session?.parent ?? null,
      state: row ? (row.state ?? row.status ?? "live") : "gone",
      cwd: session?.cwd ?? null,
      reports,
      lastLog: await lastLogLine(join(dir, "log.md")),
    });
  }
  return out;
}

async function lastLogLine(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const lines = (await readFile(path, "utf-8")).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return lines.at(-1) ?? null;
}

export function formatAgentList(rows: AgentStatus[]): string {
  if (rows.length === 0) return "No hv agents yet.";
  return rows
    .map((r) => {
      const head = `${r.name}  [${r.state}]  parent: ${r.parent ?? "?"}  reports: ${r.reports}`;
      return r.lastLog ? `${head}\n    ${r.lastLog}` : head;
    })
    .join("\n");
}
