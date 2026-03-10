import { describe, expect, test } from "bun:test";

import { shouldSuppressRuntimeLine } from "../src/lib/runtime";

describe("runtime output filtering", () => {
  test("suppresses known codex rollout path noise", () => {
    expect(
      shouldSuppressRuntimeLine(
        "codex",
        "2026-03-10T14:10:38.725633Z ERROR codex_core::rollout::list: state db missing rollout path for thread 019cd57a-6aa2-77b2-a7a5-3977e3791bb6",
      ),
    ).toBeTrue();
  });

  test("suppresses benign codex no-server mcp startup line", () => {
    expect(shouldSuppressRuntimeLine("codex", "mcp startup: no servers")).toBeTrue();
  });

  test("suppresses known codex state-db discrepancy warnings", () => {
    expect(
      shouldSuppressRuntimeLine(
        "codex",
        "2026-03-10T15:26:20.145324Z  WARN codex_core::state_db: state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
      ),
    ).toBeTrue();
  });

  test("keeps ordinary runtime output visible", () => {
    expect(shouldSuppressRuntimeLine("codex", "OpenAI Codex v0.101.0 (research preview)")).toBeFalse();
    expect(shouldSuppressRuntimeLine("codex", "Review complete. No blocker in HIVE-004 itself.")).toBeFalse();
    expect(shouldSuppressRuntimeLine("claude", "mcp startup: no servers")).toBeFalse();
  });
});
