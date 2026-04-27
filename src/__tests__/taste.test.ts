import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTasteLayer, getTastePaths, tasteIsConfigured } from "../lib/taste";

let originalHiveHome: string | undefined;
let sandbox: string;

beforeEach(async () => {
  originalHiveHome = process.env.HIVE_HOME;
  sandbox = await mkdtemp(join(tmpdir(), "hive-taste-test-"));
  process.env.HIVE_HOME = sandbox;
});

afterEach(async () => {
  if (originalHiveHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = originalHiveHome;
  await rm(sandbox, { recursive: true, force: true });
});

describe("getTastePaths", () => {
  test("derives root + principles path from HIVE_HOME", () => {
    const paths = getTastePaths();
    expect(paths.root).toBe(join(sandbox, "taste"));
    expect(paths.principles).toBe(join(sandbox, "taste", "principles.md"));
  });
});

describe("buildTasteLayer", () => {
  test("returns null when taste/ does not exist", async () => {
    const result = await buildTasteLayer();
    expect(result).toBeNull();
  });

  test("returns null when principles.md does not exist (taste/ exists)", async () => {
    await mkdir(join(sandbox, "taste"), { recursive: true });
    const result = await buildTasteLayer();
    expect(result).toBeNull();
  });

  test("returns principles content trimmed", async () => {
    await mkdir(join(sandbox, "taste"), { recursive: true });
    await writeFile(
      join(sandbox, "taste", "principles.md"),
      "\n\n# Principles\n\n### Iterate\nDo it now.\n\n",
    );
    const result = await buildTasteLayer();
    expect(result).not.toBeNull();
    expect(result?.startsWith("# Principles")).toBe(true);
    expect(result?.endsWith(".")).toBe(true);
  });

  test("output is byte-stable for the same input (cache discipline)", async () => {
    await mkdir(join(sandbox, "taste"), { recursive: true });
    await writeFile(
      join(sandbox, "taste", "principles.md"),
      "# Principles\n\n### Iterate\nDo it now.\n",
    );
    const a = await buildTasteLayer();
    const b = await buildTasteLayer();
    expect(a).toBe(b);
  });
});

describe("tasteIsConfigured", () => {
  test("false when principles.md missing", () => {
    expect(tasteIsConfigured()).toBe(false);
  });

  test("true when principles.md exists", async () => {
    await mkdir(join(sandbox, "taste"), { recursive: true });
    await writeFile(join(sandbox, "taste", "principles.md"), "# Principles\n");
    expect(tasteIsConfigured()).toBe(true);
  });
});
