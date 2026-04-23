import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { extractHarnessFlag, resolveHarness } from "../lib/harness";

describe("extractHarnessFlag", () => {
  test("no flag, no change", () => {
    const r = extractHarnessFlag(["dispatch", "do X"]);
    expect(r.forceClaudeCode).toBe(false);
    expect(r.remaining).toEqual(["dispatch", "do X"]);
  });

  test("-c at start", () => {
    const r = extractHarnessFlag(["-c", "dispatch", "do X"]);
    expect(r.forceClaudeCode).toBe(true);
    expect(r.remaining).toEqual(["dispatch", "do X"]);
  });

  test("-c mid-args", () => {
    const r = extractHarnessFlag(["dispatch", "-c", "do X"]);
    expect(r.forceClaudeCode).toBe(true);
    expect(r.remaining).toEqual(["dispatch", "do X"]);
  });

  test("--claude-code long form", () => {
    const r = extractHarnessFlag(["--claude-code", "doctor"]);
    expect(r.forceClaudeCode).toBe(true);
    expect(r.remaining).toEqual(["doctor"]);
  });

  test("does not match similar flags", () => {
    const r = extractHarnessFlag(["ticket", "create", "-c-like", "--claude-codex"]);
    expect(r.forceClaudeCode).toBe(false);
    expect(r.remaining).toEqual(["ticket", "create", "-c-like", "--claude-codex"]);
  });
});

describe("resolveHarness", () => {
  const original = process.env.HIVE_HARNESS;

  beforeEach(() => {
    delete process.env.HIVE_HARNESS;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.HIVE_HARNESS;
    else process.env.HIVE_HARNESS = original;
  });

  test("defaults to pi when unset", () => {
    expect(resolveHarness()).toBe("pi");
  });

  test("reads HIVE_HARNESS=claude-code", () => {
    process.env.HIVE_HARNESS = "claude-code";
    expect(resolveHarness()).toBe("claude-code");
  });

  test("reads HIVE_HARNESS=pi", () => {
    process.env.HIVE_HARNESS = "pi";
    expect(resolveHarness()).toBe("pi");
  });

  test("unknown value falls back to pi default", () => {
    process.env.HIVE_HARNESS = "gibberish";
    expect(resolveHarness()).toBe("pi");
  });
});
