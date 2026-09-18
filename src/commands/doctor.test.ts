import { describe, expect, test } from "bun:test";

import { dashboardFreshness, parseElapsed } from "./doctor";

describe("parseElapsed", () => {
  test("reads every ps etime shape", () => {
    expect(parseElapsed("00:07")).toBe(7);
    expect(parseElapsed("31:08")).toBe(31 * 60 + 8);
    expect(parseElapsed("01:31:08")).toBe(3600 + 31 * 60 + 8);
    expect(parseElapsed("  34-02:03:04\n")).toBe(((34 * 24 + 2) * 60 + 3) * 60 + 4);
  });

  test("rejects output that is not an elapsed time", () => {
    expect(parseElapsed("")).toBeNull();
    expect(parseElapsed("ps: no such process")).toBeNull();
    expect(parseElapsed("12")).toBeNull();
  });
});

describe("dashboardFreshness", () => {
  const started = Date.parse("2026-08-15T14:49:22Z");

  test("warns when the binary was replaced after the dashboard started", () => {
    const check = dashboardFreshness(started, "/bin/hive", Date.parse("2026-08-28T15:00:00Z"));
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("launchctl kickstart -k gui/");
    expect(check.detail).toContain("/com.hive.dashboard");
  });

  test("passes when the dashboard started after the last install", () => {
    expect(dashboardFreshness(started, "/bin/hive", Date.parse("2026-08-01T00:00:00Z")).status).toBe("pass");
  });
});
