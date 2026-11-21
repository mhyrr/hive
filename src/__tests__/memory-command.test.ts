import { describe, test, expect, spyOn } from "bun:test";

import { memoryCommand, parseSearchArgs } from "../commands/memory";
import { tasteCommand } from "../commands/taste";
import { UsageError } from "../lib/errors";

async function captureLog(fn: () => Promise<void>): Promise<string> {
  const spy = spyOn(console, "log").mockImplementation(() => {});
  try {
    await fn();
    return spy.mock.calls.map((c) => c.join(" ")).join("\n");
  } finally {
    spy.mockRestore();
  }
}

describe("parseSearchArgs", () => {
  test("a bare query has no cap override and keeps logs out", () => {
    expect(parseSearchArgs(["verifier", "model"])).toEqual({ query: "verifier model", includeLogs: false });
  });

  // The bug this guards: before TK-150 the flags fell through into the query,
  // so `--top-k 20` searched for the literal tokens "--top-k" and "20".
  test("--top-k and --logs are flags, not query words, wherever they sit", () => {
    expect(parseSearchArgs(["--top-k", "25", "when", "did", "--logs", "we", "change"])).toEqual({
      query: "when did we change",
      topK: 25,
      includeLogs: true,
    });
  });

  test("--top-k rejects a missing, zero, or fractional value", () => {
    expect(() => parseSearchArgs(["q", "--top-k"])).toThrow(UsageError);
    expect(() => parseSearchArgs(["q", "--top-k", "0"])).toThrow(UsageError);
    expect(() => parseSearchArgs(["q", "--top-k", "2.5"])).toThrow(UsageError);
  });

  test("flags with no query words is still an empty query", () => {
    expect(() => parseSearchArgs(["--logs"])).toThrow(/No search query/);
  });
});

describe("help text", () => {
  test("hive memory --help shows the search flags", async () => {
    const out = await captureLog(() => memoryCommand(["--help"]));
    expect(out).toContain("hive memory search <query> [--top-k N] [--logs]");
  });

  test("hive taste --help lists every operator subcommand", async () => {
    const out = await captureLog(() => tasteCommand(["--help"]));
    for (const sub of ["status", "review", "reject", "admit", "relink", "consolidate", "extract"]) {
      expect(out).toContain(`hive taste ${sub}`);
    }
  });
});
