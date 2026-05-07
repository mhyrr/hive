import { describe, test, expect } from "bun:test";

import { buildRunWrapper } from "../commands/dispatch";

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
});
