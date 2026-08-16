import { describe, expect, test } from "bun:test";

import { emptyInbox, parseInbox } from "./inbox";

describe("parseInbox", () => {
  test("treats the canonical header-only file as empty", () => {
    expect(parseInbox(emptyInbox("hive"), "hive")).toEqual({
      kind: "empty",
      body: "",
      byteLength: 0,
    });
  });

  test("ignores legacy Pass F tombstones", () => {
    const raw = [
      "# Inbox: hive",
      "",
      "_Truncated by Pass F at 2026-08-14T02:00:00.000Z_",
      "",
    ].join("\n");

    expect(parseInbox(raw, "hive").kind).toBe("empty");
  });

  test("ignores HIVE machine markers but keeps findings", () => {
    const parsed = parseInbox(
      "# Inbox: hive\n\n<!-- hive:last-write 2026-08-15 -->\n\n- a real finding\n",
      "hive",
    );

    expect(parsed).toEqual({
      kind: "content",
      body: "- a real finding",
      byteLength: 16,
    });
  });

  test("escapes project ids when stripping the header", () => {
    const parsed = parseInbox("# Inbox: hive.test\n\nFinding\n", "hive.test");
    expect(parsed.body).toBe("Finding");
  });
});
