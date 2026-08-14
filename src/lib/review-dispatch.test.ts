import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

import { buildReviewRunWrapper } from "./review-dispatch";

describe("review-only Act wrapper", () => {
  const wrapper = buildReviewRunWrapper({
    claude: "/usr/local/bin/claude",
    hive: "/usr/local/bin/hive",
    model: "claude-opus-test",
    timeoutMin: 60,
    workspacePath: "/tmp/RUN-042/workspace",
    runDir: "/tmp/RUN-042",
    runId: "RUN-042",
    projectId: "alpha",
    ticketId: "TK-007",
    baseSha: "abc123",
    identityPath: "/tmp/RUN-042/identity.md",
    agentsPath: "/tmp/RUN-042/agents.json",
    messagePath: "/tmp/RUN-042/message.txt",
    logPath: "/tmp/RUN-042/output.log",
  });

  test("runs only in the explicit workspace and never merges, pushes, or cleans it", () => {
    expect(wrapper).toContain('cd "/tmp/RUN-042/workspace"');
    expect(wrapper).toContain('--add-dir "/tmp/RUN-042"');
    expect(wrapper).toContain("GIT_CONFIG_KEY_0=core.hooksPath");
    expect(wrapper).toContain('GIT_CONFIG_VALUE_0="/tmp/RUN-042/hooks"');
    expect(wrapper).toContain('git rev-list --count "abc123..HEAD"');
    expect(wrapper).not.toContain("git merge");
    expect(wrapper).not.toContain("git push");
    expect(wrapper).not.toContain("worktree remove");
    expect(wrapper).not.toContain(".claude/worktrees");
  });

  test("marks committed, completed work ready for review and owner-guards failure release", () => {
    expect(wrapper).toContain("STATUS=review_ready");
    expect(wrapper).toContain('ticket release-claim "TK-007" --project "alpha" --run "RUN-042"');
    expect(wrapper).not.toContain("ticket close");
    expect(wrapper).not.toContain("ticket reopen");
  });

  test("loads detached OAuth and prevents sleep", () => {
    expect(wrapper).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(wrapper).toContain("caffeinate -ims");
    expect(wrapper).toContain("unset ANTHROPIC_API_KEY");
  });

  test("is valid bash", () => {
    const result = spawnSync("/bin/bash", ["-n"], { input: wrapper, encoding: "utf-8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
