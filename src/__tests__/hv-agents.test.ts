import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentDir, listAgents, startAgent, validateAgentName } from "../lib/hv-agents";
import { buildStartArgv, childEnv, parseBackgrounded, type LiveSession, type Run } from "../lib/hv-claude";

/**
 * A stand-in for the claude CLI. `--bg` "starts" a session and adds it to the
 * list that `agents --json` returns; every call is recorded.
 */
function fakeClaude(initial: LiveSession[] = []) {
  const sessions = [...initial];
  const calls: { argv: string[]; cwd: string; env: Record<string, string> }[] = [];
  let next = 0;
  let bgOutput: ((id: string, name: string) => { code: number; stdout: string; stderr: string }) | null = null;
  const run: Run = async (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd, env: opts.env });
    if (argv[1] === "agents") return { code: 0, stdout: JSON.stringify(sessions), stderr: "" };
    if (argv[1] === "--bg") {
      const name = argv[argv.indexOf("-n") + 1]!;
      const resumeAt = argv.indexOf("--resume");
      const id = resumeAt >= 0 ? argv[resumeAt + 1]!.slice(0, 8) : `abc${String(next++).padStart(5, "0")}`;
      if (bgOutput) return bgOutput(id, name);
      const sessionId = resumeAt >= 0 ? argv[resumeAt + 1]! : `${id}-0000-0000-0000-000000000000`;
      const at = sessions.findIndex((s) => s.sessionId === sessionId);
      if (at >= 0) sessions.splice(at, 1);
      sessions.push({ id, sessionId, name, cwd: opts.cwd, state: "working" });
      return { code: 0, stdout: `backgrounded · ${id} · ${name}\n`, stderr: "" };
    }
    throw new Error(`unexpected claude call: ${argv.join(" ")}`);
  };
  return { run, calls, sessions, failBg: (f: typeof bgOutput) => { bgOutput = f; } };
}

const noWait = async () => {};

describe("hv agents", () => {
  let root: string;
  let home: string;
  let repo: string;
  const saved = { hive: process.env.HIVE_HOME, key: process.env.ANTHROPIC_API_KEY };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "hv-agents-")));
    home = join(root, "hv");
    repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    // Identity reads ~/.hive; point it at an empty fixture so tests never read the real one.
    process.env.HIVE_HOME = join(root, "hive");
    await mkdir(process.env.HIVE_HOME, { recursive: true });
    process.env.HV_MCP_BIN = "/bin/hv-mcp-test";
  });

  afterEach(async () => {
    if (saved.hive === undefined) delete process.env.HIVE_HOME; else process.env.HIVE_HOME = saved.hive;
    if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.key;
    delete process.env.HV_MCP_BIN;
    await rm(root, { recursive: true, force: true });
  });

  test("a new agent gets a workspace, a session record and a log line", async () => {
    const claude = fakeClaude();
    const { session, restarted, dir } = await startAgent({
      name: "revrec", charter: "Own the revrec project.", cwd: repo, home,
      claudeBin: "claude", run: claude.run, wait: noWait,
    });

    expect(restarted).toBe(false);
    expect(dir).toBe(agentDir("revrec", home));
    expect(await readFile(join(dir, "charter.md"), "utf-8")).toBe("Own the revrec project.\n");
    for (const f of ["checklist.md", "log.md", "system-prompt.md", "mcp.json", "session.json"]) {
      expect(existsSync(join(dir, f))).toBe(true);
    }
    expect(existsSync(join(dir, "reports"))).toBe(true);
    expect(existsSync(join(dir, "memory"))).toBe(true);

    expect(session).toMatchObject({ name: "revrec", parent: "greg", cwd: repo, harness: "claude", permissionMode: "auto" });
    expect(JSON.parse(await readFile(join(dir, "session.json"), "utf-8")).sessionId).toBe(session.sessionId);
    expect(await readFile(join(dir, "log.md"), "utf-8")).toContain(`started by greg in ${repo} (session ${session.id})`);

    const prompt = await readFile(join(dir, "system-prompt.md"), "utf-8");
    expect(prompt).toContain('You are the hv agent "revrec"');
    expect(prompt).toContain("Your parent is Greg.");

    const mcp = JSON.parse(await readFile(join(dir, "mcp.json"), "utf-8"));
    expect(mcp.mcpServers.hv).toMatchObject({ command: "/bin/hv-mcp-test", env: { HV_AGENT: "revrec", HV_HOME: home } });
  });

  test("the session starts detached on the subscription, with identity in the prompt", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    const claude = fakeClaude();
    await startAgent({ name: "arete", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait });

    const bg = claude.calls.find((c) => c.argv[1] === "--bg")!;
    expect(bg.cwd).toBe(repo);
    expect(bg.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(bg.env.HIVE_IDENTITY_IN_PROMPT).toBe("1");
    const dir = agentDir("arete", home);
    expect(bg.argv).toEqual([
      "claude", "--bg", "--mcp-config", join(dir, "mcp.json"),
      "-n", "arete", "--permission-mode", "auto",
      "--append-system-prompt-file", join(dir, "system-prompt.md"),
      "Read your charter.md and checklist.md, then begin.",
    ]);
  });

  test("a child names its parent and how to reach it", async () => {
    const claude = fakeClaude();
    const { dir } = await startAgent({
      name: "rate-limiter", charter: "Build TK-142.", parent: "revrec", worktree: true, cwd: repo, home,
      claudeBin: "claude", run: claude.run, wait: noWait,
    });
    expect(await readFile(join(dir, "system-prompt.md"), "utf-8")).toContain('SendMessage to "revrec"');
    const bg = claude.calls.find((c) => c.argv[1] === "--bg")!;
    expect(bg.argv.slice(-3)).toEqual(["-w", "rate-limiter", "Read your charter.md and checklist.md, then begin."]);
  });

  test("a new agent needs a charter; an existing one refuses a new charter", async () => {
    const claude = fakeClaude();
    const base = { cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait };
    await expect(startAgent({ name: "writing", ...base })).rejects.toThrow("Give it a charter");
    await startAgent({ name: "writing", charter: "first", ...base });
    await expect(startAgent({ name: "writing", charter: "second", ...base })).rejects.toThrow("already exists");
    expect(await readFile(join(agentDir("writing", home), "charter.md"), "utf-8")).toBe("first\n");
  });

  test("a running session with the same name blocks the start", async () => {
    const claude = fakeClaude([{ id: "deadbeef", sessionId: "deadbeef-x", name: "hive", cwd: "/elsewhere", state: "working" }]);
    await expect(startAgent({
      name: "hive", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait,
    })).rejects.toThrow('A session named "hive" is already running');
    expect(existsSync(agentDir("hive", home))).toBe(false);
  });

  test("restart without a charter resumes the agent's own session", async () => {
    const claude = fakeClaude();
    const base = { home, claudeBin: "claude", run: claude.run, wait: noWait };
    const first = await startAgent({ name: "investing", charter: "c", cwd: repo, ...base });
    claude.sessions[0]!.state = "done";

    const second = await startAgent({ name: "investing", ...base });
    expect(second.restarted).toBe(true);
    const bg = claude.calls.filter((c) => c.argv[1] === "--bg").at(-1)!;
    expect(bg.cwd).toBe(repo);
    expect(bg.argv).toContain("--resume");
    expect(bg.argv[bg.argv.indexOf("--resume") + 1]).toBe(first.session.sessionId);
    expect(bg.argv.at(-1)).toContain("You were restarted from your workspace.");
    expect(await readFile(join(agentDir("investing", home), "log.md"), "utf-8")).toContain("resumed by greg");
  });

  test("an untrusted folder is reported plainly", async () => {
    const claude = fakeClaude();
    claude.failBg(() => ({ code: 1, stdout: "Workspace not trusted. Run `claude` in /x once ...\n", stderr: "" }));
    await expect(startAgent({
      name: "matreas", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait,
    })).rejects.toThrow("Claude has not trusted");
    // Nothing left behind, so the same start can be retried.
    expect(existsSync(agentDir("matreas", home))).toBe(false);
  });

  test("a session that fails at start is reported, not waited on", async () => {
    const claude = fakeClaude();
    claude.failBg((id, name) => {
      claude.sessions.push({ id, sessionId: `${id}-s`, name, cwd: repo, state: "failed" });
      return { code: 0, stdout: `backgrounded · ${id} · ${name}\n`, stderr: "" };
    });
    await expect(startAgent({
      name: "matreas", charter: "c", cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait,
    })).rejects.toThrow("failed at start");
    expect(claude.calls.filter((c) => c.argv[1] === "agents" && c.argv.includes("--all"))).toHaveLength(1);
    expect(existsSync(agentDir("matreas", home))).toBe(false);
  });

  test("the prompt never directly follows --mcp-config", () => {
    for (const extra of [{}, { worktree: true }, { resume: "sid" }]) {
      const argv = buildStartArgv("claude", {
        name: "a", cwd: "/r", systemPromptFile: "/s", mcpConfigFile: "/m", prompt: "p", permissionMode: "auto", ...extra,
      });
      expect(argv[argv.indexOf("--mcp-config") + 2]!.startsWith("-")).toBe(true);
      expect(argv.at(-1)).toBe("p");
    }
  });

  test("list shows live, finished and gone agents", async () => {
    const claude = fakeClaude();
    const base = { cwd: repo, home, claudeBin: "claude", run: claude.run, wait: noWait };
    await startAgent({ name: "alpha", charter: "c", ...base });
    await startAgent({ name: "beta", charter: "c", parent: "alpha", ...base });
    await writeFile(join(agentDir("beta", home), "reports", "2026-11-10-done.md"), "# Done\n");
    claude.sessions.splice(0, 1); // alpha died

    const rows = await listAgents({ home, claudeBin: "claude", run: claude.run });
    expect(rows.map((r) => [r.name, r.state, r.parent, r.reports])).toEqual([
      ["alpha", "gone", "greg", 0],
      ["beta", "working", "alpha", 1],
    ]);
    expect(rows[1]!.lastLog).toContain("started by alpha");
  });

  test("agent names are constrained", () => {
    expect(validateAgentName("rate-limiter")).toBe("rate-limiter");
    for (const bad of ["Maya", "1st", "a b", "../x", "greg", ""]) {
      expect(() => validateAgentName(bad)).toThrow();
    }
  });
});

describe("hv claude adapter", () => {
  test("parses the --bg confirmation line", () => {
    expect(parseBackgrounded("Starting background service…\nbackgrounded · 17e458d3 · hv-spike3\n")).toBe("17e458d3");
    expect(parseBackgrounded("Workspace not trusted.")).toBeNull();
  });

  test("child env drops the API key and marks identity as injected", () => {
    const env = childEnv({ ANTHROPIC_API_KEY: "k", PATH: "/bin", HIVE_IDENTITY_IN_PROMPT: undefined });
    expect(env).toEqual({ PATH: "/bin", HIVE_IDENTITY_IN_PROMPT: "1" });
  });

  test("resume wins over worktree", () => {
    const argv = buildStartArgv("claude", {
      name: "a", cwd: "/r", systemPromptFile: "/s", mcpConfigFile: "/m", prompt: "p",
      permissionMode: "auto", resume: "sid", worktree: true,
    });
    expect(argv).toContain("--resume");
    expect(argv).not.toContain("-w");
  });
});
