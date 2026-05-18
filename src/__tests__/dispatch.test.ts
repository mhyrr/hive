import { describe, test, expect } from "bun:test";

import { buildExecutorMessage, buildRunWrapper } from "../commands/dispatch";

const baseOpts = {
  projectPath: "/Users/x/work/hive",
  timeoutMin: 30,
  claude: "/Users/x/.local/bin/claude",
  model: "claude-opus-4-6",
  identityPath: "/Users/x/.hive/runs/RUN-099/identity.md",
  hiveHome: "/Users/x/.hive",
  runId: "RUN-099",
  messagePath: "/Users/x/.hive/runs/RUN-099/message.txt",
  logPath: "/Users/x/.hive/runs/RUN-099/output.log",
  runDir: "/Users/x/.hive/runs/RUN-099",
  runsDir: "/Users/x/.hive/runs",
};

describe("buildRunWrapper", () => {
  test("does not invoke GNU coreutils `timeout`", () => {
    // RUN-016 broke because the wrapper called bare `timeout 1800 ...`,
    // which doesn't ship on macOS. Lock down the regression: there must be
    // no `timeout` command invocation at the start of any line.
    const script = buildRunWrapper(baseOpts);
    expect(script).not.toMatch(/^\s*timeout\s+\d/m);
  });

  test("uses portable bash watchdog with TIMEOUT_SEC and kill -0", () => {
    const script = buildRunWrapper(baseOpts);
    expect(script).toContain("TIMEOUT_SEC=1800");
    expect(script).toContain('kill -0 "$CLAUDE_PID"');
    expect(script).toContain('kill -TERM "$CLAUDE_PID"');
    expect(script).toContain('wait "$CLAUDE_PID"');
  });

  test("scales TIMEOUT_SEC by timeoutMin", () => {
    expect(buildRunWrapper({ ...baseOpts, timeoutMin: 5 })).toContain("TIMEOUT_SEC=300");
    expect(buildRunWrapper({ ...baseOpts, timeoutMin: 60 })).toContain("TIMEOUT_SEC=3600");
  });

  test("emits a bash shebang and strict mode", () => {
    const script = buildRunWrapper(baseOpts);
    expect(script.startsWith("#!/bin/bash\n")).toBe(true);
    expect(script).toContain("set -euo pipefail");
  });

  test("interpolates claude path, model, and run paths", () => {
    const script = buildRunWrapper(baseOpts);
    expect(script).toContain('"/Users/x/.local/bin/claude"');
    expect(script).toContain('--model "claude-opus-4-6"');
    expect(script).toContain('--append-system-prompt-file "/Users/x/.hive/runs/RUN-099/identity.md"');
    expect(script).toContain('--name "RUN-099"');
    expect(script).toContain('"$(cat "/Users/x/.hive/runs/RUN-099/message.txt")"');
    expect(script).toContain('> "/Users/x/.hive/runs/RUN-099/output.log" 2>&1 &');
  });

  test("guards worktree cleanup against in-flight sibling runs (TK-045)", () => {
    const script = buildRunWrapper(baseOpts);
    expect(script).toContain('for rd in "/Users/x/.hive/runs"/RUN-*/');
    expect(script).toContain('OTHER_RUNNING=0');
    expect(script).toContain('if [ "$OTHER_RUNNING" = "0" ]');
  });

  test("status is determined from plan.md evidence, not exit code", () => {
    const script = buildRunWrapper(baseOpts);
    expect(script).toContain('if [ -f "/Users/x/.hive/runs/RUN-099/plan.md" ]');
    expect(script).toContain('echo "complete" > "/Users/x/.hive/runs/RUN-099/status"');
    expect(script).toContain('echo "partial" > "/Users/x/.hive/runs/RUN-099/status"');
    expect(script).toContain('echo "blocked" > "/Users/x/.hive/runs/RUN-099/status"');
  });

  test("TK-041: trusts commits on a worktree branch before plan.md heuristics", () => {
    // The fix: if any .claude/worktrees/*/ has AHEAD>0 against main, status is
    // complete regardless of plan.md content. Covers the agent-rewrote-plan-as-
    // summary failure mode (RUN-007/013/014/051).
    const script = buildRunWrapper(baseOpts);
    expect(script).toContain('COMMITS_FOUND=0');
    expect(script).toContain('.claude/worktrees');
    expect(script).toContain('git -C "$wt" log "main..$WT_BRANCH"');
    // Commits branch fires before the all-checkboxes-ticked branch.
    const commitsIdx = script.indexOf('if [ "$COMMITS_FOUND" = "1" ]');
    const checkboxIdx = script.indexOf('[ "$UNCHECKED" = "0" ] && [ "$CHECKED" -gt "0" ]');
    expect(commitsIdx).toBeGreaterThan(-1);
    expect(checkboxIdx).toBeGreaterThan(commitsIdx);
  });

  test("TK-041: plan.md 'Status: complete' marker is honored when checkboxes are gone", () => {
    // Agents that rewrite plan.md into a summary often leave a 'Status: complete'
    // line behind (RUN-014, RUN-051). Treat that as evidence too.
    const script = buildRunWrapper(baseOpts);
    expect(script).toContain('PLAN_SAYS_COMPLETE=1');
    expect(script).toMatch(/grep -qiE '\^.*Status:.*\(complete\|done\|shipped\)/);
  });

  test("TK-081: emits ticket-revert function when --ticket flow is active", () => {
    const script = buildRunWrapper({
      ...baseOpts,
      ticketId: "TK-042",
      projectId: "hive",
      hiveBin: "/Users/x/.local/bin/hive",
    });
    expect(script).toContain('maybe_revert_ticket()');
    expect(script).toContain('"/Users/x/.local/bin/hive" ticket reopen "TK-042" --project "hive"');
    expect(script).toMatch(/case "\$TERMINAL_STATUS" in[\s\S]*partial\|failed\|blocked\|timed_out/);
    // Revert fires both after main status determination and after timed_out branch.
    const matches = script.match(/maybe_revert_ticket\b/g) ?? [];
    // 1 definition + at least 2 invocations.
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  test("TK-081: ticket-revert is a no-op stub when --ticket flow is inactive", () => {
    const script = buildRunWrapper(baseOpts); // no ticketId
    expect(script).toContain('maybe_revert_ticket() { :; }');
    expect(script).not.toContain('hive ticket reopen');
  });
});

const baseMessageOpts = {
  runDir: "/Users/x/.hive/runs/RUN-099",
  projectId: "hive",
  goalText: "Refactor the dispatch wrapper to use /goal",
  maxTurns: 20,
  useGoalCommand: true,
};

describe("buildExecutorMessage", () => {
  test("wraps the message in /goal when enabled", () => {
    const msg = buildExecutorMessage(baseMessageOpts);
    expect(msg.startsWith("/goal ")).toBe(true);
  });

  test("references the plan file in the success condition", () => {
    const msg = buildExecutorMessage(baseMessageOpts);
    expect(msg).toContain("/Users/x/.hive/runs/RUN-099/plan.md");
    expect(msg).toContain("marked [x]");
    expect(msg).toContain("committed");
  });

  test("includes the turn cap in the /goal stop clause", () => {
    expect(buildExecutorMessage(baseMessageOpts)).toContain("or stop after 20 turns");
    expect(buildExecutorMessage({ ...baseMessageOpts, maxTurns: 5 })).toContain("or stop after 5 turns");
  });

  test("preserves run dir, project, and goal text in the body", () => {
    const msg = buildExecutorMessage(baseMessageOpts);
    expect(msg).toContain("Run directory: /Users/x/.hive/runs/RUN-099");
    expect(msg).toContain("Plan file: /Users/x/.hive/runs/RUN-099/plan.md");
    expect(msg).toContain("Project: hive");
    expect(msg).toContain("Refactor the dispatch wrapper to use /goal");
  });

  test("omits the /goal prefix and stop clause when disabled", () => {
    const msg = buildExecutorMessage({ ...baseMessageOpts, useGoalCommand: false });
    expect(msg.startsWith("/goal")).toBe(false);
    expect(msg).not.toContain("or stop after");
    expect(msg).toContain("Goal:\nRefactor the dispatch wrapper to use /goal");
  });
});
