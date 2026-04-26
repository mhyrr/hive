import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildTasteLayer,
  getTastePaths,
  listTasteDomains,
  TASTE_DOMAIN_RE,
  tasteApplicationPath,
  tasteIsConfigured,
} from "../lib/taste";

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

describe("TASTE_DOMAIN_RE", () => {
  test("accepts valid domain shapes", () => {
    expect(TASTE_DOMAIN_RE.test("prose")).toBe(true);
    expect(TASTE_DOMAIN_RE.test("ui-design")).toBe(true);
    expect(TASTE_DOMAIN_RE.test("a")).toBe(true);
    expect(TASTE_DOMAIN_RE.test("c0de")).toBe(true);
  });

  test("rejects invalid shapes", () => {
    expect(TASTE_DOMAIN_RE.test("")).toBe(false);
    expect(TASTE_DOMAIN_RE.test("Prose")).toBe(false);          // capital
    expect(TASTE_DOMAIN_RE.test("1prose")).toBe(false);         // leading digit
    expect(TASTE_DOMAIN_RE.test("-prose")).toBe(false);         // leading hyphen
    expect(TASTE_DOMAIN_RE.test("prose/code")).toBe(false);     // slash
    expect(TASTE_DOMAIN_RE.test("prose.md")).toBe(false);       // dot
    expect(TASTE_DOMAIN_RE.test("../escape")).toBe(false);      // path traversal
  });
});

describe("getTastePaths", () => {
  test("derives paths from HIVE_HOME", () => {
    const paths = getTastePaths();
    expect(paths.root).toBe(join(sandbox, "taste"));
    expect(paths.principles).toBe(join(sandbox, "taste", "principles.md"));
    expect(paths.applicationsDir).toBe(join(sandbox, "taste", "applications"));
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

  test("returns principles content with no domain hint", async () => {
    await mkdir(join(sandbox, "taste"), { recursive: true });
    await writeFile(join(sandbox, "taste", "principles.md"), "# Principles\n\n### Iterate\nDo it now.\n");
    const result = await buildTasteLayer();
    expect(result).not.toBeNull();
    expect(result).toContain("# Principles");
    expect(result).toContain("### Iterate");
  });

  test("returns principles only when domain hint provided but application missing", async () => {
    await mkdir(join(sandbox, "taste"), { recursive: true });
    await writeFile(join(sandbox, "taste", "principles.md"), "# Principles\n");
    const result = await buildTasteLayer("prose");
    expect(result).not.toBeNull();
    expect(result).toContain("# Principles");
    expect(result).not.toContain("---");  // no application separator
  });

  test("includes application content when domain hint matches existing file", async () => {
    await mkdir(join(sandbox, "taste", "applications"), { recursive: true });
    await writeFile(join(sandbox, "taste", "principles.md"), "# Principles\n");
    await writeFile(join(sandbox, "taste", "applications", "prose.md"), "# Applications: prose\n\n### Iterate\nLand the paragraph.\n");
    const result = await buildTasteLayer("prose");
    expect(result).not.toBeNull();
    expect(result).toContain("# Principles");
    expect(result).toContain("# Applications: prose");
    expect(result).toContain("---");  // separator between principles and application
  });

  test("rejects invalid domain hint silently (loads principles only)", async () => {
    await mkdir(join(sandbox, "taste", "applications"), { recursive: true });
    await writeFile(join(sandbox, "taste", "principles.md"), "# Principles\n");
    await writeFile(join(sandbox, "taste", "applications", "prose.md"), "# Applications: prose\n");
    // Path-traversal attempt — must NOT load applications/../passwd or similar
    const result = await buildTasteLayer("../escape");
    expect(result).not.toBeNull();
    expect(result).toContain("# Principles");
    expect(result).not.toContain("# Applications");
  });

  test("treats null and undefined hint identically", async () => {
    await mkdir(join(sandbox, "taste"), { recursive: true });
    await writeFile(join(sandbox, "taste", "principles.md"), "# Principles\n");
    const a = await buildTasteLayer(null);
    const b = await buildTasteLayer(undefined);
    expect(a).toBe(b);
  });

  test("output is byte-stable for the same inputs (cache discipline)", async () => {
    await mkdir(join(sandbox, "taste", "applications"), { recursive: true });
    await writeFile(join(sandbox, "taste", "principles.md"), "# Principles\n\n### Iterate\nDo it now.\n");
    await writeFile(join(sandbox, "taste", "applications", "prose.md"), "# Applications: prose\n");
    const a = await buildTasteLayer("prose");
    const b = await buildTasteLayer("prose");
    expect(a).toBe(b);
  });
});

describe("listTasteDomains", () => {
  test("returns empty when applications dir missing", async () => {
    const result = await listTasteDomains();
    expect(result).toEqual([]);
  });

  test("returns sorted markdown domains, drops non-md", async () => {
    await mkdir(join(sandbox, "taste", "applications"), { recursive: true });
    await writeFile(join(sandbox, "taste", "applications", "prose.md"), "");
    await writeFile(join(sandbox, "taste", "applications", "ux.md"), "");
    await writeFile(join(sandbox, "taste", "applications", "code.md"), "");
    await writeFile(join(sandbox, "taste", "applications", "README"), "");  // not .md
    const result = await listTasteDomains();
    expect(result).toEqual(["code", "prose", "ux"]);
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

describe("tasteApplicationPath", () => {
  test("composes path for a given domain", () => {
    expect(tasteApplicationPath("prose")).toBe(join(sandbox, "taste", "applications", "prose.md"));
    expect(tasteApplicationPath("ux")).toBe(join(sandbox, "taste", "applications", "ux.md"));
  });
});
