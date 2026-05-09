import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { resolveHarness } from "../lib/harness";

describe("resolveHarness", () => {
  const originalHarness = process.env.HIVE_HARNESS;
  const originalMode = process.env.HIVE_CLAUDE_MODE;

  beforeEach(() => {
    delete process.env.HIVE_HARNESS;
    delete process.env.HIVE_CLAUDE_MODE;
  });

  afterEach(() => {
    if (originalHarness === undefined) delete process.env.HIVE_HARNESS;
    else process.env.HIVE_HARNESS = originalHarness;
    if (originalMode === undefined) delete process.env.HIVE_CLAUDE_MODE;
    else process.env.HIVE_CLAUDE_MODE = originalMode;
  });

  test("defaults to claude-code with no flag and no env", () => {
    const r = resolveHarness(["hello"]);
    expect(r.harness).toBe("claude-code");
    expect(r.claudeMode).toBe("append");
    expect(r.remainingArgs).toEqual(["hello"]);
  });

  test("-x selects codex", () => {
    const r = resolveHarness(["-x", "fix the auth bug"]);
    expect(r.harness).toBe("codex");
    expect(r.remainingArgs).toEqual(["fix the auth bug"]);
  });

  test("--codex selects codex", () => {
    const r = resolveHarness(["--codex", "fix the bug"]);
    expect(r.harness).toBe("codex");
    expect(r.remainingArgs).toEqual(["fix the bug"]);
  });

  test("-3 selects pi", () => {
    const r = resolveHarness(["-3", "think this through"]);
    expect(r.harness).toBe("pi");
    expect(r.remainingArgs).toEqual(["think this through"]);
  });

  test("--pi selects pi", () => {
    const r = resolveHarness(["--pi", "think this through"]);
    expect(r.harness).toBe("pi");
    expect(r.remainingArgs).toEqual(["think this through"]);
  });

  test("HIVE_HARNESS=codex sets codex as default", () => {
    process.env.HIVE_HARNESS = "codex";
    const r = resolveHarness(["hello"]);
    expect(r.harness).toBe("codex");
    expect(r.remainingArgs).toEqual(["hello"]);
  });

  test("HIVE_HARNESS=pi sets pi as default", () => {
    process.env.HIVE_HARNESS = "pi";
    const r = resolveHarness(["hello"]);
    expect(r.harness).toBe("pi");
    expect(r.remainingArgs).toEqual(["hello"]);
  });

  test("--claude overrides HIVE_HARNESS=codex", () => {
    process.env.HIVE_HARNESS = "codex";
    const r = resolveHarness(["--claude", "hello"]);
    expect(r.harness).toBe("claude-code");
    expect(r.remainingArgs).toEqual(["hello"]);
  });

  test("--claude-code is an alias for --claude", () => {
    process.env.HIVE_HARNESS = "codex";
    const r = resolveHarness(["--claude-code", "hello"]);
    expect(r.harness).toBe("claude-code");
    expect(r.remainingArgs).toEqual(["hello"]);
  });

  test("harness flag is stripped from remaining args", () => {
    const r = resolveHarness(["--agent", "maya-coder", "-x", "do thing"]);
    expect(r.harness).toBe("codex");
    expect(r.remainingArgs).toEqual(["--agent", "maya-coder", "do thing"]);
  });

  test("-x position-independent (last wins for harness)", () => {
    const r = resolveHarness(["a", "-x", "b", "--claude", "c"]);
    expect(r.harness).toBe("claude-code");
    expect(r.remainingArgs).toEqual(["a", "b", "c"]);
  });

  test("-3 position-independent (last wins for harness)", () => {
    const r = resolveHarness(["a", "-3", "b", "-x", "c"]);
    expect(r.harness).toBe("codex");
    expect(r.remainingArgs).toEqual(["a", "b", "c"]);
  });

  test("unknown HIVE_HARNESS value falls back to claude-code", () => {
    process.env.HIVE_HARNESS = "nonsense";
    const r = resolveHarness(["hello"]);
    expect(r.harness).toBe("claude-code");
    expect(r.remainingArgs).toEqual(["hello"]);
  });

  test("empty args, no flags, no env → claude-code", () => {
    const r = resolveHarness([]);
    expect(r.harness).toBe("claude-code");
    expect(r.claudeMode).toBe("append");
    expect(r.remainingArgs).toEqual([]);
  });

  describe("claude mode flags", () => {
    test("--owned selects owned mode and is stripped", () => {
      const r = resolveHarness(["--owned", "hello"]);
      expect(r.harness).toBe("claude-code");
      expect(r.claudeMode).toBe("owned");
      expect(r.remainingArgs).toEqual(["hello"]);
    });

    test("--bare selects bare mode and is stripped", () => {
      const r = resolveHarness(["--bare", "hello"]);
      expect(r.harness).toBe("claude-code");
      expect(r.claudeMode).toBe("bare");
      expect(r.remainingArgs).toEqual(["hello"]);
    });

    test("HIVE_CLAUDE_MODE=owned sets owned mode", () => {
      process.env.HIVE_CLAUDE_MODE = "owned";
      const r = resolveHarness(["hello"]);
      expect(r.claudeMode).toBe("owned");
      expect(r.remainingArgs).toEqual(["hello"]);
    });

    test("HIVE_CLAUDE_MODE=bare sets bare mode", () => {
      process.env.HIVE_CLAUDE_MODE = "bare";
      const r = resolveHarness(["hello"]);
      expect(r.claudeMode).toBe("bare");
      expect(r.remainingArgs).toEqual(["hello"]);
    });

    test("--bare arg overrides HIVE_CLAUDE_MODE=owned", () => {
      process.env.HIVE_CLAUDE_MODE = "owned";
      const r = resolveHarness(["--bare", "hello"]);
      expect(r.claudeMode).toBe("bare");
    });

    test("mode flag composes with harness flag", () => {
      const r = resolveHarness(["--owned", "--agent", "maya-coder", "hello"]);
      expect(r.harness).toBe("claude-code");
      expect(r.claudeMode).toBe("owned");
      expect(r.remainingArgs).toEqual(["--agent", "maya-coder", "hello"]);
    });

    test("--bare with -3 still routes pi (mode flagged but ignored downstream)", () => {
      const r = resolveHarness(["--bare", "-3", "hello"]);
      expect(r.harness).toBe("pi");
      expect(r.claudeMode).toBe("bare");
      expect(r.remainingArgs).toEqual(["hello"]);
    });
  });
});
