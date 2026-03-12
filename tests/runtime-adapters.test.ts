import { describe, expect, test } from "bun:test";

import {
  buildInteractiveLaunchSpec,
  buildLaunchSpec,
  getAdapter,
  listRuntimeAdapters,
  shouldSuppressRuntimeLine,
} from "../src/lib/runtime";

// --- Registry lookup ---

describe("runtime adapter registry", () => {
  test("lists all built-in adapters", () => {
    const adapters = listRuntimeAdapters();

    expect(adapters.length).toBe(3);
    expect(adapters.map((a) => a.name)).toEqual(["claude", "codex", "gemini"]);
  });

  test("looks up adapter by canonical name", () => {
    expect(getAdapter("claude")?.name).toBe("claude");
    expect(getAdapter("codex")?.name).toBe("codex");
    expect(getAdapter("gemini")?.name).toBe("gemini");
  });

  test("looks up adapter by alias", () => {
    expect(getAdapter("claude-code")?.name).toBe("claude");
    expect(getAdapter("openai")?.name).toBe("codex");
    expect(getAdapter("gemini-cli")?.name).toBe("gemini");
    expect(getAdapter("google")?.name).toBe("gemini");
  });

  test("lookup is case-insensitive", () => {
    expect(getAdapter("Claude")?.name).toBe("claude");
    expect(getAdapter("CODEX")?.name).toBe("codex");
    expect(getAdapter("Gemini-CLI")?.name).toBe("gemini");
  });

  test("returns null for unknown runtime", () => {
    expect(getAdapter("unknown")).toBeNull();
    expect(getAdapter("")).toBeNull();
    expect(getAdapter("gpt")).toBeNull();
  });
});

// --- Claude adapter arg building ---

describe("claude adapter", () => {
  const adapter = getAdapter("claude")!;

  test("builds launch args without model", () => {
    const args = adapter.buildLaunchArgs({
      model: null,
      repoPath: "/repo",
      hiveHome: "/hive",
      prompt: "do stuff",
    });

    expect(args).toEqual([
      "--print",
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--add-dir",
      "/hive",
      "do stuff",
    ]);
  });

  test("builds launch args with model", () => {
    const args = adapter.buildLaunchArgs({
      model: "opus",
      repoPath: "/repo",
      hiveHome: "/hive",
      prompt: "do stuff",
    });

    expect(args).toEqual([
      "--print",
      "--output-format",
      "json",
      "--permission-mode",
      "bypassPermissions",
      "--add-dir",
      "/hive",
      "--model",
      "opus",
      "do stuff",
    ]);
  });

  test("builds interactive args without model", () => {
    const args = adapter.buildInteractiveArgs({
      model: null,
      repoPath: "/repo",
      hiveHome: "/hive",
      systemPrompt: "You are helpful",
    });

    expect(args).toEqual([
      "--permission-mode",
      "bypassPermissions",
      "--add-dir",
      "/hive",
      "--system-prompt",
      "You are helpful",
    ]);
  });

  test("builds interactive args with model", () => {
    const args = adapter.buildInteractiveArgs({
      model: "sonnet",
      repoPath: "/repo",
      hiveHome: "/hive",
      systemPrompt: "You are helpful",
    });

    expect(args).toEqual([
      "--permission-mode",
      "bypassPermissions",
      "--add-dir",
      "/hive",
      "--model",
      "sonnet",
      "--system-prompt",
      "You are helpful",
    ]);
  });

  test("suppressLine always returns false", () => {
    expect(adapter.suppressLine("anything")).toBe(false);
    expect(adapter.suppressLine("mcp startup: no servers")).toBe(false);
  });
});

// --- Codex adapter arg building ---

describe("codex adapter", () => {
  const adapter = getAdapter("codex")!;

  test("builds launch args without model", () => {
    const args = adapter.buildLaunchArgs({
      model: null,
      repoPath: "/repo",
      hiveHome: "/hive",
      prompt: "do stuff",
    });

    expect(args).toEqual([
      "exec",
      "--full-auto",
      "-C",
      "/repo",
      "--add-dir",
      "/hive",
      "do stuff",
    ]);
  });

  test("builds launch args with model", () => {
    const args = adapter.buildLaunchArgs({
      model: "o3",
      repoPath: "/repo",
      hiveHome: "/hive",
      prompt: "do stuff",
    });

    expect(args).toEqual([
      "exec",
      "--full-auto",
      "-C",
      "/repo",
      "--add-dir",
      "/hive",
      "--model",
      "o3",
      "do stuff",
    ]);
  });

  test("builds interactive args without model", () => {
    const args = adapter.buildInteractiveArgs({
      model: null,
      repoPath: "/repo",
      hiveHome: "/hive",
      systemPrompt: "You are helpful",
    });

    expect(args).toEqual([
      "--full-auto",
      "-C",
      "/repo",
      "--add-dir",
      "/hive",
      "You are helpful",
    ]);
  });

  test("builds interactive args with model", () => {
    const args = adapter.buildInteractiveArgs({
      model: "o3",
      repoPath: "/repo",
      hiveHome: "/hive",
      systemPrompt: "You are helpful",
    });

    expect(args).toEqual([
      "--full-auto",
      "-C",
      "/repo",
      "--add-dir",
      "/hive",
      "--model",
      "o3",
      "You are helpful",
    ]);
  });

  test("suppressLine filters codex noise", () => {
    expect(adapter.suppressLine("mcp startup: no servers")).toBe(true);
    expect(
      adapter.suppressLine(
        "WARN codex_core::state_db: state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
      ),
    ).toBe(true);
    expect(
      adapter.suppressLine(
        "ERROR codex_core::rollout::list: state db missing rollout path for thread abc123",
      ),
    ).toBe(true);
  });

  test("suppressLine keeps normal codex output", () => {
    expect(adapter.suppressLine("OpenAI Codex v0.101.0 (research preview)")).toBe(false);
    expect(adapter.suppressLine("Review complete.")).toBe(false);
  });
});

// --- Gemini adapter arg building ---

describe("gemini adapter", () => {
  const adapter = getAdapter("gemini")!;

  test("builds launch args without model", () => {
    const args = adapter.buildLaunchArgs({
      model: null,
      repoPath: "/repo",
      hiveHome: "/hive",
      prompt: "do stuff",
    });

    expect(args).toEqual(["-C", "/repo", "do stuff"]);
  });

  test("builds launch args with model", () => {
    const args = adapter.buildLaunchArgs({
      model: "gemini-2.5-pro",
      repoPath: "/repo",
      hiveHome: "/hive",
      prompt: "do stuff",
    });

    expect(args).toEqual(["-C", "/repo", "--model", "gemini-2.5-pro", "do stuff"]);
  });

  test("builds interactive args without model", () => {
    const args = adapter.buildInteractiveArgs({
      model: null,
      repoPath: "/repo",
      hiveHome: "/hive",
      systemPrompt: "You are helpful",
    });

    expect(args).toEqual(["-C", "/repo"]);
  });

  test("builds interactive args with model", () => {
    const args = adapter.buildInteractiveArgs({
      model: "gemini-2.5-pro",
      repoPath: "/repo",
      hiveHome: "/hive",
      systemPrompt: "You are helpful",
    });

    expect(args).toEqual(["-C", "/repo", "--model", "gemini-2.5-pro"]);
  });

  test("suppressLine always returns false", () => {
    expect(adapter.suppressLine("anything")).toBe(false);
    expect(adapter.suppressLine("mcp startup: no servers")).toBe(false);
  });
});

// --- shouldSuppressRuntimeLine (public API) ---

describe("shouldSuppressRuntimeLine via adapter dispatch", () => {
  test("suppresses codex noise through public API", () => {
    expect(shouldSuppressRuntimeLine("codex", "mcp startup: no servers")).toBe(true);
    expect(
      shouldSuppressRuntimeLine(
        "codex",
        "2026-03-10T14:10:38.725633Z ERROR codex_core::rollout::list: state db missing rollout path for thread 019cd57a",
      ),
    ).toBe(true);
    expect(
      shouldSuppressRuntimeLine(
        "codex",
        "2026-03-10T15:26:20.145324Z  WARN codex_core::state_db: state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
      ),
    ).toBe(true);
  });

  test("does not suppress normal codex output", () => {
    expect(shouldSuppressRuntimeLine("codex", "OpenAI Codex v0.101.0")).toBe(false);
  });

  test("claude does not suppress anything", () => {
    expect(shouldSuppressRuntimeLine("claude", "mcp startup: no servers")).toBe(false);
    expect(shouldSuppressRuntimeLine("claude", "anything")).toBe(false);
  });

  test("gemini does not suppress anything", () => {
    expect(shouldSuppressRuntimeLine("gemini", "mcp startup: no servers")).toBe(false);
    expect(shouldSuppressRuntimeLine("gemini", "anything")).toBe(false);
  });

  test("unknown runtime does not suppress anything", () => {
    expect(shouldSuppressRuntimeLine("unknown", "mcp startup: no servers")).toBe(false);
  });

  test("empty lines are never suppressed", () => {
    expect(shouldSuppressRuntimeLine("codex", "")).toBe(false);
    expect(shouldSuppressRuntimeLine("codex", "  ")).toBe(false);
  });
});

// --- buildLaunchSpec backward compatibility ---

describe("buildLaunchSpec backward compatibility", () => {
  test("produces identical codex launch spec as before", () => {
    const spec = buildLaunchSpec({
      runtime: "codex",
      model: "o3",
      repoPath: "/my/repo",
      hiveHome: "/home/.hive",
      prompt: "Fix the bug",
    });

    expect(spec).toEqual({
      runtime: "codex",
      model: "o3",
      command: "codex",
      args: [
        "exec",
        "--full-auto",
        "-C",
        "/my/repo",
        "--add-dir",
        "/home/.hive",
        "--model",
        "o3",
        "Fix the bug",
      ],
    });
  });

  test("produces claude launch spec with json output format", () => {
    const spec = buildLaunchSpec({
      runtime: "claude",
      model: "opus",
      repoPath: "/my/repo",
      hiveHome: "/home/.hive",
      prompt: "Fix the bug",
    });

    expect(spec).toEqual({
      runtime: "claude",
      model: "opus",
      command: "claude",
      args: [
        "--print",
        "--output-format",
        "json",
        "--permission-mode",
        "bypassPermissions",
        "--add-dir",
        "/home/.hive",
        "--model",
        "opus",
        "Fix the bug",
      ],
    });
  });

  test("codex launch spec without model", () => {
    const spec = buildLaunchSpec({
      runtime: "codex",
      model: null,
      repoPath: "/repo",
      hiveHome: "/hive",
      prompt: "task",
    });

    expect(spec.args).not.toContain("--model");
  });

  test("claude launch spec without model", () => {
    const spec = buildLaunchSpec({
      runtime: "claude",
      model: null,
      repoPath: "/repo",
      hiveHome: "/hive",
      prompt: "task",
    });

    expect(spec.args).not.toContain("--model");
  });

  test("throws for unknown runtime", () => {
    expect(() =>
      buildLaunchSpec({
        runtime: "unknown",
        model: null,
        repoPath: "/repo",
        hiveHome: "/hive",
        prompt: "task",
      }),
    ).toThrow("Unknown runtime: unknown");
  });

  test("builds gemini launch spec", () => {
    const spec = buildLaunchSpec({
      runtime: "gemini",
      model: "gemini-2.5-pro",
      repoPath: "/my/repo",
      hiveHome: "/home/.hive",
      prompt: "Fix the bug",
    });

    expect(spec).toEqual({
      runtime: "gemini",
      model: "gemini-2.5-pro",
      command: "gemini",
      args: ["-C", "/my/repo", "--model", "gemini-2.5-pro", "Fix the bug"],
    });
  });
});

// --- buildInteractiveLaunchSpec backward compatibility ---

describe("buildInteractiveLaunchSpec backward compatibility", () => {
  test("produces identical codex interactive spec as before", () => {
    const spec = buildInteractiveLaunchSpec({
      runtime: "codex",
      model: "o3",
      repoPath: "/my/repo",
      hiveHome: "/home/.hive",
      systemPrompt: "You are a code reviewer",
    });

    expect(spec).toEqual({
      runtime: "codex",
      model: "o3",
      command: "codex",
      args: [
        "--full-auto",
        "-C",
        "/my/repo",
        "--add-dir",
        "/home/.hive",
        "--model",
        "o3",
        "You are a code reviewer",
      ],
    });
  });

  test("produces identical claude interactive spec as before", () => {
    const spec = buildInteractiveLaunchSpec({
      runtime: "claude",
      model: "opus",
      repoPath: "/my/repo",
      hiveHome: "/home/.hive",
      systemPrompt: "You are a code reviewer",
    });

    expect(spec).toEqual({
      runtime: "claude",
      model: "opus",
      command: "claude",
      args: [
        "--permission-mode",
        "bypassPermissions",
        "--add-dir",
        "/home/.hive",
        "--model",
        "opus",
        "--system-prompt",
        "You are a code reviewer",
      ],
    });
  });

  test("throws for unknown runtime", () => {
    expect(() =>
      buildInteractiveLaunchSpec({
        runtime: "unknown",
        model: null,
        repoPath: "/repo",
        hiveHome: "/hive",
        systemPrompt: "test",
      }),
    ).toThrow("Unknown runtime: unknown");
  });

  test("builds gemini interactive spec", () => {
    const spec = buildInteractiveLaunchSpec({
      runtime: "gemini",
      model: null,
      repoPath: "/my/repo",
      hiveHome: "/home/.hive",
      systemPrompt: "You are helpful",
    });

    expect(spec).toEqual({
      runtime: "gemini",
      model: null,
      command: "gemini",
      args: ["-C", "/my/repo"],
    });
  });
});
