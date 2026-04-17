import { describe, test, expect } from "bun:test";

import { resolveHiveBin, HiveBinNotFoundError } from "../lib/dashboard/hive-bin";

describe("resolveHiveBin", () => {
  test("prefers HIVE_BIN when set and exists", () => {
    const bin = resolveHiveBin({
      env: { HIVE_BIN: "/opt/hive/bin/hive" },
      existsSync: (p) => p === "/opt/hive/bin/hive",
      which: () => "/usr/bin/hive",
      homedir: () => "/home/u",
    });
    expect(bin).toBe("/opt/hive/bin/hive");
  });

  test("ignores HIVE_BIN when file does not exist", () => {
    const bin = resolveHiveBin({
      env: { HIVE_BIN: "/nope" },
      existsSync: (p) => p === "/home/u/.hive/scripts/hive-bin",
      which: () => null,
      homedir: () => "/home/u",
    });
    expect(bin).toBe("/home/u/.hive/scripts/hive-bin");
  });

  test("falls through to ~/.hive/scripts/hive-bin", () => {
    const bin = resolveHiveBin({
      env: {},
      existsSync: (p) => p === "/home/u/.hive/scripts/hive-bin",
      which: () => null,
      homedir: () => "/home/u",
    });
    expect(bin).toBe("/home/u/.hive/scripts/hive-bin");
  });

  test("falls through to which(hive)", () => {
    const bin = resolveHiveBin({
      env: {},
      existsSync: () => false,
      which: () => "/usr/local/bin/hive",
      homedir: () => "/home/u",
    });
    expect(bin).toBe("/usr/local/bin/hive");
  });

  test("throws HiveBinNotFoundError when nothing resolves", () => {
    expect(() =>
      resolveHiveBin({
        env: {},
        existsSync: () => false,
        which: () => null,
        homedir: () => "/home/u",
      }),
    ).toThrow(HiveBinNotFoundError);
  });
});
