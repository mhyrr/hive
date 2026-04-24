import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { extractHarnessFlag, resolveHarness } from "../lib/harness";

describe("extractHarnessFlag", () => {
  test("no flag, no change", () => {
    const r = extractHarnessFlag(["dispatch", "do X"]);
    expect(r.forcePi).toBe(false);
    expect(r.remaining).toEqual(["dispatch", "do X"]);
  });

  test("-3 at start", () => {
    const r = extractHarnessFlag(["-3", "dispatch", "do X"]);
    expect(r.forcePi).toBe(true);
    expect(r.remaining).toEqual(["dispatch", "do X"]);
  });

  test("-3 mid-args", () => {
    const r = extractHarnessFlag(["dispatch", "-3", "do X"]);
    expect(r.forcePi).toBe(true);
    expect(r.remaining).toEqual(["dispatch", "do X"]);
  });

  test("--pi long form", () => {
    const r = extractHarnessFlag(["--pi", "doctor"]);
    expect(r.forcePi).toBe(true);
    expect(r.remaining).toEqual(["doctor"]);
  });

  test("does not match similar flags", () => {
    const r = extractHarnessFlag(["ticket", "create", "-3-like", "--pix"]);
    expect(r.forcePi).toBe(false);
    expect(r.remaining).toEqual(["ticket", "create", "-3-like", "--pix"]);
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

  test("defaults to claude-code when unset", () => {
    expect(resolveHarness()).toBe("claude-code");
  });

  test("reads HIVE_HARNESS=claude-code", () => {
    process.env.HIVE_HARNESS = "claude-code";
    expect(resolveHarness()).toBe("claude-code");
  });

  test("reads HIVE_HARNESS=pi", () => {
    process.env.HIVE_HARNESS = "pi";
    expect(resolveHarness()).toBe("pi");
  });

  test("unknown value falls back to claude-code default", () => {
    process.env.HIVE_HARNESS = "gibberish";
    expect(resolveHarness()).toBe("claude-code");
  });
});
