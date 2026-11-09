import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hvInitCommand } from "../commands/hv-init";
import { hiveOwnedReason } from "../lib/hv-guard";
import { ensureHvScaffold, getHvPaths, resolveHvHome } from "../lib/paths";

describe("hv home", () => {
  let root: string;
  const savedHvHome = process.env.HV_HOME;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "hv-home-")));
  });

  afterEach(async () => {
    if (savedHvHome === undefined) delete process.env.HV_HOME;
    else process.env.HV_HOME = savedHvHome;
    await rm(root, { recursive: true, force: true });
  });

  test("HV_HOME overrides the default home", () => {
    process.env.HV_HOME = join(root, "elsewhere");
    expect(resolveHvHome()).toBe(join(root, "elsewhere"));
    delete process.env.HV_HOME;
    expect(resolveHvHome().endsWith("/.hv")).toBe(true);
  });

  test("the scaffold creates the v2-only folders", async () => {
    const paths = await ensureHvScaffold(join(root, "hv"));
    expect(paths).toEqual(getHvPaths(join(root, "hv")));
    expect((await readdir(paths.home)).sort()).toEqual(["agents", "precedents", "queue"]);
  });

  test("hv init writes only under the hv home", async () => {
    process.env.HV_HOME = join(root, "hv");
    await hvInitCommand([]);
    expect((await readdir(root))).toEqual(["hv"]);
    expect(existsSync(join(root, "hv", "agents"))).toBe(true);
  });
});

describe("commands hive owns while hv runs beside it", () => {
  test.each([
    [["memory", "nightly"]],
    [["memory", "nightly", "--dry-run"]],
    [["memory", "apply"]],
    [["memory", "verify"]],
    [["dashboard", "build"]],
  ])("refuses %j", (args) => {
    expect(hiveOwnedReason(args)).not.toBeNull();
  });

  test.each([
    [["memory", "view"]],
    [["memory"]],
    [["dashboard", "serve"]],
    [["dashboard"]],
    [["ticket", "list"]],
    [[]],
  ])("allows %j", (args) => {
    expect(hiveOwnedReason(args)).toBeNull();
  });
});
