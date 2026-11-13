import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentWorkdir,
  findLiveRow,
  isEnded,
  listAgentNames,
  readAgentSession,
  runAttach,
  type AgentSession,
  type LiveRow,
} from "../commands/attach";
import { UsageError } from "../lib/errors";

let home: string;
let repo: string;

function addAgent(name: string, fields: Partial<AgentSession> & Record<string, unknown> = {}): AgentSession {
  const session = {
    name,
    harness: "claude",
    id: `id-${name}`,
    sessionId: `sess-${name}`,
    parent: "maya",
    cwd: repo,
    worktree: false,
    ...fields,
  };
  mkdirSync(join(home, "agents", name), { recursive: true });
  writeFileSync(join(home, "agents", name, "session.json"), JSON.stringify(session));
  return session as AgentSession;
}

const liveRow = (s: AgentSession, extra: Partial<LiveRow> = {}): LiveRow => ({
  id: s.id,
  sessionId: s.sessionId,
  name: s.name,
  kind: "background",
  state: "working",
  status: "busy",
  ...extra,
});

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hive-attach-")));
  home = join(root, "comb");
  repo = join(root, "repo");
  mkdirSync(join(home, "agents"), { recursive: true });
  mkdirSync(repo, { recursive: true });
});

afterEach(() => {
  rmSync(join(home, ".."), { recursive: true, force: true });
});

describe("agentWorkdir", () => {
  const wt = "/r/.claude/worktrees/a";
  const has = (...paths: string[]) => (p: string) => paths.includes(p);

  test("plain agent: cwd when it exists, else null", () => {
    expect(agentWorkdir({ name: "a", cwd: "/r", worktree: false }, has("/r"))).toBe("/r");
    expect(agentWorkdir({ name: "a", cwd: "/r", worktree: false }, has())).toBeNull();
  });

  test("worktree agent whose cwd is the worktree", () => {
    expect(agentWorkdir({ name: "a", cwd: wt, worktree: true }, has(wt))).toBe(wt);
  });

  test("doubled worktree path is cut at the first mention", () => {
    const doubled = `${wt}/.claude/worktrees/a`;
    expect(agentWorkdir({ name: "a", cwd: doubled, worktree: true }, has(wt, doubled))).toBe(wt);
  });

  test("cwd at the repo root gets the worktree appended", () => {
    expect(agentWorkdir({ name: "a", cwd: "/r", worktree: true }, has(wt, "/r"))).toBe(wt);
    expect(agentWorkdir({ name: "a", cwd: "/r", worktree: true }, has("/r"))).toBe("/r");
  });

  test("a longer name sharing the prefix is not a match", () => {
    const cwd = "/r/.claude/worktrees/ab";
    expect(agentWorkdir({ name: "a", cwd, worktree: true }, has(cwd))).toBe(cwd);
  });
});

describe("findLiveRow", () => {
  const s: AgentSession = { name: "a", id: "i1", sessionId: "s1", cwd: "/r", worktree: false };

  test("matches by sessionId", () => {
    const row = { id: "i1", sessionId: "s1", name: "other", kind: "background", status: "idle" };
    expect(findLiveRow([row], s)).toEqual(row);
  });

  test("falls back to a unique name match (a woken session has a new id)", () => {
    const row = { id: "i2", sessionId: "s2", name: "a", kind: "background", status: "idle" };
    expect(findLiveRow([row], s)).toEqual(row);
  });

  test("two live rows with the name: no guess", () => {
    const rows = [
      { id: "i2", sessionId: "s2", name: "a", kind: "background", status: "idle" },
      { id: "i3", sessionId: "s3", name: "a", kind: "background", status: "idle" },
    ];
    expect(findLiveRow(rows, s)).toBeNull();
  });

  test("ended rows do not count", () => {
    expect(isEnded({ id: "i1", sessionId: "s1", state: "done" })).toBe(true);
    expect(isEnded({ id: "i1", sessionId: "s1", kind: "background", state: "blocked" })).toBe(true);
    expect(isEnded({ id: "i1", sessionId: "s1", kind: "interactive", status: "idle" })).toBe(false);
    expect(findLiveRow([{ id: "i1", sessionId: "s1", kind: "background", state: "blocked" }], s)).toBeNull();
  });
});

describe("session files", () => {
  test("lists only workspaces with a session.json, sorted", () => {
    addAgent("zeta");
    addAgent("alpha");
    mkdirSync(join(home, "agents", "empty"));
    expect(listAgentNames(home)).toEqual(["alpha", "zeta"]);
  });

  test("a name that is not a plain directory name is never read", () => {
    addAgent("alpha");
    expect(readAgentSession(home, "../agents/alpha")).toBeNull();
    expect(readAgentSession(home, "..")).toBeNull();
  });

  test("broken session.json is a usage error, not a crash", () => {
    mkdirSync(join(home, "agents", "bad"));
    writeFileSync(join(home, "agents", "bad", "session.json"), "{");
    expect(() => readAgentSession(home, "bad")).toThrow(UsageError);
  });
});

describe("runAttach", () => {
  function deps(rows: LiveRow[]) {
    const lines: string[] = [];
    const spawned: { argv: string[]; dir: string }[] = [];
    return {
      lines,
      spawned,
      d: {
        env: { COMB_HOME: home },
        findClaude: () => "/bin/claude",
        liveRows: () => rows,
        spawn: (argv: string[], dir: string) => {
          spawned.push({ argv, dir });
          return 0;
        },
        out: (l: string) => lines.push(l),
      },
    };
  }

  test("live worktree agent: claude attach <id> in the worktree", async () => {
    const wt = join(repo, ".claude", "worktrees", "rev");
    mkdirSync(wt, { recursive: true });
    const s = addAgent("rev", { cwd: join(wt, ".claude", "worktrees", "rev"), worktree: true });
    const { d, spawned, lines } = deps([liveRow(s)]);
    expect(await runAttach(["rev"], d)).toBe(0);
    expect(spawned).toEqual([{ argv: ["/bin/claude", "attach", "id-rev"], dir: wt }]);
    expect(lines).toEqual([]);
  });

  test("a matched row with no id attaches by name", async () => {
    const s = addAgent("rev");
    const { d, spawned } = deps([{ sessionId: s.sessionId, kind: "interactive", status: "idle" }]);
    expect(await runAttach(["rev"], d)).toBe(0);
    expect(spawned[0].argv).toEqual(["/bin/claude", "attach", "rev"]);
  });

  test("unknown name: says so and lists agents, spawns nothing", async () => {
    addAgent("maya");
    addAgent("rev");
    const { d, spawned, lines } = deps([]);
    expect(await runAttach(["nope"], d)).toBe(1);
    expect(spawned).toEqual([]);
    expect(lines.join("\n")).toContain('no comb agent named "nope"');
    expect(lines.join("\n")).toContain("  maya\n  rev");
  });

  test("ended session: explains how to wake it, never resumes", async () => {
    const s = addAgent("rev");
    const { d, spawned, lines } = deps([liveRow(s, { state: "done", status: undefined })]);
    expect(await runAttach(["rev"], d)).toBe(1);
    expect(spawned).toEqual([]);
    const text = lines.join("\n");
    expect(text).toContain("rev is not running");
    expect(text).toContain(`cd ${repo} && claude --bg --resume sess-rev`);
  });

  test("missing directory is reported", async () => {
    addAgent("rev", { cwd: join(repo, "gone") });
    const { d, spawned, lines } = deps([]);
    expect(await runAttach(["rev"], d)).toBe(1);
    expect(spawned).toEqual([]);
    expect(lines[0]).toContain("directory is gone");
  });

  test("no name or extra words is a usage error", async () => {
    const { d } = deps([]);
    await expect(runAttach([], d)).rejects.toThrow(UsageError);
    await expect(runAttach(["a", "b"], d)).rejects.toThrow(UsageError);
    await expect(runAttach(["--help"], d)).rejects.toThrow(UsageError);
  });
});
