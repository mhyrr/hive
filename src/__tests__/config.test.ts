import { describe, test, expect } from "bun:test";

import { extractConfigValue, extractConfigValueAlias, parsePositiveInt, setConfigValue } from "../lib/config";
import { parseModelPool, normalizeProjectName } from "../lib/project";

// ---------------------------------------------------------------------------
// extractConfigValue
// ---------------------------------------------------------------------------

describe("extractConfigValue", () => {
  const config = `key1: value1
key2: value2
key-with-spaces:   padded  `;

  test("finds existing key", () => {
    expect(extractConfigValue(config, "key1")).toBe("value1");
  });

  test("returns null for missing key", () => {
    expect(extractConfigValue(config, "nonexistent")).toBeNull();
  });

  test("trims whitespace from value", () => {
    expect(extractConfigValue(config, "key-with-spaces")).toBe("padded");
  });
});

describe("extractConfigValueAlias", () => {
  const config = `ollama-base-url: http://localhost:11434`;

  test("finds first matching alias", () => {
    expect(extractConfigValueAlias(config, ["ollama_base_url", "ollama-base-url"])).toBe("http://localhost:11434");
  });

  test("returns null when no alias matches", () => {
    expect(extractConfigValueAlias(config, ["missing1", "missing2"])).toBeNull();
  });
});

describe("setConfigValue", () => {
  test("replaces a dotted key without disturbing nearby config", () => {
    const config = "runtime: claude\n\nwatches.max_autonomy: propose\nmodel: opus\n";
    expect(setConfigValue(config, "watches.max_autonomy", "act")).toBe(
      "runtime: claude\n\nwatches.max_autonomy: act\nmodel: opus\n",
    );
  });

  test("appends a missing key with one blank line", () => {
    expect(setConfigValue("runtime: claude\n", "watches.max_autonomy", "act")).toBe(
      "runtime: claude\n\nwatches.max_autonomy: act\n",
    );
  });
});

// ---------------------------------------------------------------------------
// parsePositiveInt
// ---------------------------------------------------------------------------

describe("parsePositiveInt", () => {
  test("parses valid positive integer", () => {
    expect(parsePositiveInt("5")).toBe(5);
  });

  test("returns null for zero", () => {
    expect(parsePositiveInt("0")).toBeNull();
  });

  test("returns null for negative", () => {
    expect(parsePositiveInt("-1")).toBeNull();
  });

  test("returns null for non-numeric", () => {
    expect(parsePositiveInt("abc")).toBeNull();
  });

  test("returns null for null/undefined", () => {
    expect(parsePositiveInt(null)).toBeNull();
    expect(parsePositiveInt(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseModelPool
// ---------------------------------------------------------------------------

describe("parseModelPool", () => {
  test("parses valid model pool", () => {
    const config = `## Model Pool
- opus: claude, claude-opus-4-6, frontier deep work
- sonnet: claude, claude-sonnet-4-6, general workhorse`;

    const pool = parseModelPool(config);
    expect(pool.length).toBe(2);
    expect(pool[0]!.name).toBe("opus");
    expect(pool[0]!.runtime).toBe("claude");
    expect(pool[0]!.model).toBe("claude-opus-4-6");
  });

  test("returns empty for no pool section", () => {
    expect(parseModelPool("no pool here")).toEqual([]);
  });

  test("skips malformed lines", () => {
    const config = `## Model Pool
- opus: claude, claude-opus-4-6, frontier deep work
- badline
not a bullet`;

    const pool = parseModelPool(config);
    expect(pool.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// normalizeProjectName
// ---------------------------------------------------------------------------

describe("normalizeProjectName", () => {
  test("lowercases and replaces spaces", () => {
    expect(normalizeProjectName("My Project")).toBe("my-project");
  });

  test("handles already normalized names", () => {
    expect(normalizeProjectName("my-project")).toBe("my-project");
  });
});
