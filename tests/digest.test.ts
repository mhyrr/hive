import { describe, expect, test } from "bun:test";

import {
  digestBoard,
  digestMessages,
  digestRuns,
  listSkills,
} from "../src/lib/digest";
import type { HiveMessage } from "../src/lib/messages";
import type { RunRecord } from "../src/lib/runs";

const liveBoard = await Bun.file(new URL("./fixtures/hive-live-board.md", import.meta.url)).text();

function makeMessage(overrides: Partial<HiveMessage> & { body: string }): HiveMessage {
  return {
    path: overrides.path ?? "/tmp/messages/test.md",
    filename: overrides.filename ?? "test.md",
    attributes: overrides.attributes ?? {},
    body: overrides.body,
    raw: overrides.raw ?? "",
  };
}

function makeRun(overrides: Partial<RunRecord>): RunRecord {
  return {
    runId: overrides.runId ?? "run-001",
    projectId: overrides.projectId ?? "proj",
    agentId: overrides.agentId ?? "alpha",
    status: overrides.status ?? "active",
    runtime: overrides.runtime ?? "claude",
    model: overrides.model ?? null,
    started: overrides.started ?? "2026-03-09T15:08:00Z",
    ended: overrides.ended ?? null,
    exitCode: overrides.exitCode ?? null,
    pid: overrides.pid ?? null,
    promptPath: overrides.promptPath ?? "/tmp/prompt.md",
    source: overrides.source ?? "steward",
    sourceMessage: overrides.sourceMessage ?? null,
    taskId: overrides.taskId ?? null,
    scope: overrides.scope ?? null,
    stopRequestedAt: overrides.stopRequestedAt ?? null,
    stopRequestedBy: overrides.stopRequestedBy ?? null,
    path: overrides.path ?? "/tmp/run.md",
  };
}

describe("digestBoard", () => {
  test("summarises the live pipe-delimited board format and includes agent state", () => {
    const result = digestBoard(liveBoard);

    expect(result).toContain("4 tasks:");
    expect(result).toContain("1 active");
    expect(result).toContain("2 done");
    expect(result).toContain("1 waiting/queued");
    expect(result).toContain("steward: active");
    expect(result).toContain("gamma: idle");
    expect(result).not.toContain("Blockers:");
  });

  test("summarises a board with tasks, agents, and no blockers", () => {
    const board = [
      "## Tasks",
      "- 001: Auth endpoint [alpha] [active] [14:52]",
      "- 002: DB migration [beta] [done] [14:30]",
      "- 003: Cache layer [queued]",
      "",
      "## Agents",
      "### alpha (worker)",
      "status: working on 001",
      "",
      "### beta (worker)",
      "status: idle",
      "",
      "## Blockers",
      "(none)",
      "",
      "## Decisions",
      "Use PostgreSQL for persistence",
    ].join("\n");

    const result = digestBoard(board);

    expect(result).toContain("3 tasks:");
    expect(result).toContain("1 active");
    expect(result).toContain("1 done");
    expect(result).toContain("1 waiting/queued");
    expect(result).toContain("alpha: working on 001");
    expect(result).toContain("beta: idle");
    expect(result).not.toContain("Blockers:");
  });

  test("handles an empty board", () => {
    const board = "";
    const result = digestBoard(board);

    expect(result).toBe("0 tasks: 0 active, 0 done, 0 waiting/queued");
  });

  test("handles a board with only headings and no content", () => {
    const board = [
      "## Tasks",
      "",
      "## Agents",
      "",
      "## Blockers",
      "",
      "## Decisions",
    ].join("\n");

    const result = digestBoard(board);

    expect(result).toBe("0 tasks: 0 active, 0 done, 0 waiting/queued");
  });

  test("includes blockers when present", () => {
    const board = [
      "## Tasks",
      "- 001: Auth endpoint [alpha] [active] [14:52]",
      "",
      "## Agents",
      "### alpha (worker)",
      "status: blocked",
      "",
      "## Blockers",
      "- alpha is waiting on API key from ops team",
      "- CI pipeline broken for staging",
      "",
      "## Decisions",
    ].join("\n");

    const result = digestBoard(board);

    expect(result).toContain("1 tasks:");
    expect(result).toContain("Blockers: 2");
    expect(result).toContain("- alpha is waiting on API key from ops team");
    expect(result).toContain("- CI pipeline broken for staging");
  });

  test("counts waiting tasks with [waiting] tag", () => {
    const board = [
      "## Tasks",
      "- 001: Task A [waiting-on-review]",
      "- 002: Task B [active]",
      "- 003: Task C [queued]",
      "- 004: Task D [waiting]",
    ].join("\n");

    const result = digestBoard(board);

    expect(result).toContain("4 tasks:");
    expect(result).toContain("1 active");
    expect(result).toContain("0 done");
    expect(result).toContain("3 waiting/queued");
  });

  test("agent with missing status shows unknown", () => {
    const board = [
      "## Tasks",
      "",
      "## Agents",
      "### gamma (worker)",
      "task: 005",
      "",
      "## Blockers",
      "## Decisions",
    ].join("\n");

    const result = digestBoard(board);

    expect(result).toContain("gamma: unknown");
  });

  test("does not count task detail lines as separate tasks", () => {
    const result = digestBoard(liveBoard);

    expect(result).not.toContain("8 tasks:");
  });
});

describe("digestMessages", () => {
  test("returns (none) for empty list", () => {
    expect(digestMessages([])).toBe("(none)");
  });

  test("formats a single message", () => {
    const messages: HiveMessage[] = [
      makeMessage({
        filename: "msg-001.md",
        attributes: {
          from: "steward",
          to: "alpha",
          type: "assign",
          status: "open",
          ts: "2026-03-09T15:00:00Z",
          project: "myproj",
        },
        body: "Implement the auth endpoint\nUse JWT tokens",
      }),
    ];

    const result = digestMessages(messages);

    expect(result).toBe(
      "- [assign] steward -> alpha: Implement the auth endpoint",
    );
  });

  test("formats multiple messages", () => {
    const messages: HiveMessage[] = [
      makeMessage({
        filename: "msg-001.md",
        attributes: {
          from: "steward",
          to: "alpha",
          type: "assign",
          status: "open",
          ts: "2026-03-09T15:00:00Z",
          project: "myproj",
        },
        body: "Implement the auth endpoint",
      }),
      makeMessage({
        filename: "msg-002.md",
        attributes: {
          from: "alpha",
          to: "steward",
          type: "question",
          status: "open",
          ts: "2026-03-09T15:05:00Z",
          project: "myproj",
        },
        body: "Which OAuth provider should I use?",
      }),
      makeMessage({
        filename: "msg-003.md",
        attributes: {
          from: "beta",
          to: "steward",
          type: "status",
          status: "open",
          ts: "2026-03-09T15:10:00Z",
          project: "myproj",
        },
        body: "DB migration complete",
      }),
    ];

    const result = digestMessages(messages);
    const lines = result.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      "- [assign] steward -> alpha: Implement the auth endpoint",
    );
    expect(lines[1]).toBe(
      "- [question] alpha -> steward: Which OAuth provider should I use?",
    );
    expect(lines[2]).toBe(
      "- [status] beta -> steward: DB migration complete",
    );
  });

  test("uses defaults for missing attributes", () => {
    const messages: HiveMessage[] = [
      makeMessage({
        filename: "msg-bare.md",
        attributes: {},
        body: "Something happened",
      }),
    ];

    const result = digestMessages(messages);

    expect(result).toBe("- [msg] ? -> ?: Something happened");
  });

  test("uses first line of body only", () => {
    const messages: HiveMessage[] = [
      makeMessage({
        filename: "msg-multi.md",
        attributes: { from: "a", to: "b", type: "note" },
        body: "First line\nSecond line\nThird line",
      }),
    ];

    const result = digestMessages(messages);

    expect(result).toBe("- [note] a -> b: First line");
  });
});

describe("digestRuns", () => {
  test("returns (none) for empty list", () => {
    expect(digestRuns([])).toBe("(none)");
  });

  test("formats active runs", () => {
    const runs: RunRecord[] = [
      makeRun({
        agentId: "alpha",
        status: "active",
        runtime: "claude",
        model: "opus-4",
        started: "2026-03-09T15:08:00Z",
        pid: 12345,
      }),
      makeRun({
        agentId: "beta",
        status: "active",
        runtime: "codex",
        model: null,
        started: "2026-03-09T14:30:00Z",
        pid: 67890,
      }),
    ];

    const result = digestRuns(runs);
    const lines = result.split("\n");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("- alpha: active since 15:08 (claude, opus-4)");
    expect(lines[1]).toBe("- beta: active since 14:30 (codex)");
  });

  test("omits model when null", () => {
    const runs: RunRecord[] = [
      makeRun({
        agentId: "gamma",
        status: "active",
        runtime: "claude",
        model: null,
        started: "2026-03-09T09:15:00Z",
      }),
    ];

    const result = digestRuns(runs);

    expect(result).toBe("- gamma: active since 09:15 (claude)");
  });

  test("includes model when present", () => {
    const runs: RunRecord[] = [
      makeRun({
        agentId: "delta",
        status: "starting",
        runtime: "claude",
        model: "sonnet-4",
        started: "2026-03-09T22:45:00Z",
      }),
    ];

    const result = digestRuns(runs);

    expect(result).toBe("- delta: starting since 22:45 (claude, sonnet-4)");
  });

  test("handles exited status", () => {
    const runs: RunRecord[] = [
      makeRun({
        agentId: "alpha",
        status: "exited",
        runtime: "claude",
        model: "opus-4",
        started: "2026-03-09T12:00:00Z",
      }),
    ];

    const result = digestRuns(runs);

    expect(result).toBe("- alpha: exited since 12:00 (claude, opus-4)");
  });
});

describe("listSkills", () => {
  test("returns (none) for empty skill list", () => {
    expect(listSkills("/tmp/skills", [])).toBe("(none)");
  });

  test("lists skills with paths", () => {
    const result = listSkills("/hive/skills", ["deploy", "review", "test"]);
    const lines = result.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("- deploy (/hive/skills/deploy.md)");
    expect(lines[1]).toBe("- review (/hive/skills/review.md)");
    expect(lines[2]).toBe("- test (/hive/skills/test.md)");
  });

  test("lists a single skill", () => {
    const result = listSkills("/skills", ["debug"]);

    expect(result).toBe("- debug (/skills/debug.md)");
  });
});
