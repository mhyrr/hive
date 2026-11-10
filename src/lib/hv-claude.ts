/**
 * Claude Code adapter for hv agents: start a background session, list live
 * ones. Messages are not here: Claude agents use the harness's SendMessage
 * (D6). Flags verified against Claude Code 2.1.322; see the spike results in
 * docs/specs/2026-11-07-hive-v2-design.md.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Run = (
  argv: string[],
  opts: { cwd: string; env: Record<string, string> },
) => Promise<RunResult>;

export const runProcess: Run = async (argv, opts) => {
  const proc = Bun.spawn(argv, { cwd: opts.cwd, env: opts.env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

export function findClaudeBin(): string {
  if (process.env.HV_CLAUDE_BIN) return process.env.HV_CLAUDE_BIN;
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    // intentional: not on PATH — try the installer's default location
    const fallback = join(process.env.HOME || "", ".local", "bin", "claude");
    if (existsSync(fallback)) return fallback;
    throw new Error("Could not find the claude CLI. Is it installed?");
  }
}

/** One row of `claude agents --json`. Only the fields hv reads. */
export type LiveSession = {
  id: string;
  sessionId: string;
  name: string;
  cwd: string;
  state?: string;
  status?: string;
  pid?: number;
};

/** Live sessions, or with `all` also finished and failed ones. */
export async function listLiveSessions(
  claude: string,
  run: Run = runProcess,
  all = false,
): Promise<LiveSession[]> {
  const argv = [claude, "agents", "--json", ...(all ? ["--all"] : [])];
  const res = await run(argv, { cwd: process.cwd(), env: childEnv() });
  if (res.code !== 0) {
    throw new Error(`claude agents --json failed (exit ${res.code}): ${res.stderr.trim() || res.stdout.trim()}`);
  }
  const parsed = JSON.parse(res.stdout) as unknown;
  if (!Array.isArray(parsed)) throw new Error("claude agents --json did not return a list");
  return parsed as LiveSession[];
}

/**
 * Environment for a detached agent. Subscription OAuth only (D12): an API key
 * in the environment would silently switch billing. Identity arrives through
 * the system prompt, so the SessionStart hook must not emit it again.
 */
export function childEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && k !== "ANTHROPIC_API_KEY") env[k] = v;
  }
  env.HIVE_IDENTITY_IN_PROMPT = "1";
  return env;
}

export type StartSpec = {
  name: string;
  cwd: string;
  systemPromptFile: string;
  mcpConfigFile: string;
  prompt: string;
  permissionMode: string;
  /** Session ID to resume instead of starting fresh. */
  resume?: string;
  /** Ask Claude to make a git worktree (named after the agent). */
  worktree?: boolean;
};

export function buildStartArgv(claude: string, spec: StartSpec): string[] {
  // --mcp-config takes a list and would swallow the prompt as a second config
  // file, so a single-value flag must always follow it.
  const argv = [
    claude, "--bg",
    "--mcp-config", spec.mcpConfigFile,
    "-n", spec.name,
    "--permission-mode", spec.permissionMode,
    "--append-system-prompt-file", spec.systemPromptFile,
  ];
  if (spec.resume) argv.push("--resume", spec.resume);
  else if (spec.worktree) argv.push("-w", spec.name);
  argv.push(spec.prompt);
  return argv;
}

/** Parses `backgrounded · 17e458d3 · hv-spike3`. */
export function parseBackgrounded(stdout: string): string | null {
  const m = stdout.match(/backgrounded\s*·\s*([0-9a-f]{6,})\s*·/);
  return m ? m[1]! : null;
}

export type Started = { id: string; sessionId: string; cwd: string };

export async function startBackground(
  claude: string,
  spec: StartSpec,
  run: Run = runProcess,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Started> {
  const res = await run(buildStartArgv(claude, spec), { cwd: spec.cwd, env: childEnv() });
  const out = `${res.stdout}\n${res.stderr}`;
  if (/not trusted/i.test(out)) {
    throw new Error(
      `Claude has not trusted ${spec.cwd}. Open claude there once and accept the trust prompt, then start the agent again.`,
    );
  }
  const id = parseBackgrounded(out);
  if (res.code !== 0 || !id) {
    throw new Error(`claude --bg failed (exit ${res.code}): ${out.trim()}`);
  }
  // The session shows up in `claude agents` a moment after --bg returns. A
  // session that dies at once only appears under --all, as "failed".
  for (let attempt = 0; attempt < 20; attempt++) {
    const row = (await listLiveSessions(claude, run, true)).find((s) => s.id === id);
    if (row?.state === "failed") {
      throw new Error(`Session ${id} failed at start. Inspect it with: claude agents --all`);
    }
    if (row) return { id, sessionId: row.sessionId, cwd: row.cwd };
    await wait(500);
  }
  throw new Error(`Session ${id} started but never appeared in claude agents --json.`);
}
