import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  actionIdentityPropose,
  actionMemoryPromote,
  actionReflectionDismiss,
  actionTicketClose,
  actionTicketCreate,
  actionTicketNote,
  actionTicketReopen,
  actionTicketStart,
  hashEntry,
} from "../lib/dashboard/actions";
import { ensureHiveScaffold, getHivePaths } from "../lib/paths";
// ---------------------------------------------------------------------------
// Pure argv builders
// ---------------------------------------------------------------------------

describe("actionTicketCreate", () => {
  test("builds argv with required fields", () => {
    expect(
      actionTicketCreate({ project: "hive", title: "New widget" }).argv,
    ).toEqual(["ticket", "create", "New widget", "--project", "hive"]);
  });

  test("threads type/priority/tags/depends", () => {
    expect(
      actionTicketCreate({
        project: "hive",
        title: "Big",
        type: "feature",
        priority: 1,
        tags: ["ux", "v3"],
        depends: ["TK-001", "TK-002"],
      }).argv,
    ).toEqual([
      "ticket", "create", "Big",
      "--project", "hive",
      "--type", "feature",
      "--priority", "1",
      "--tags", "ux,v3",
      "--depends", "TK-001,TK-002",
    ]);
  });

  test("rejects missing project", () => {
    expect(() => actionTicketCreate({ project: "", title: "x" } as any)).toThrow(/project/);
  });

  test("rejects missing title", () => {
    expect(() => actionTicketCreate({ project: "hive", title: "" })).toThrow(/title/);
  });
});

describe("ticket lifecycle builders", () => {
  test("start/close/reopen", () => {
    expect(actionTicketStart({ id: "TK-007" }).argv).toEqual(["ticket", "start", "TK-007"]);
    expect(actionTicketClose({ id: "TK-007", project: "hive" }).argv)
      .toEqual(["ticket", "close", "TK-007", "--project", "hive"]);
    expect(actionTicketReopen({ id: "TK-007" }).argv).toEqual(["ticket", "reopen", "TK-007"]);
  });

  test("reject non-TK ids", () => {
    expect(() => actionTicketClose({ id: "nope" })).toThrow(/invalid ticket id/);
    expect(() => actionTicketStart({ id: "" })).toThrow(/invalid ticket id/);
  });

  test("ticket note requires text", () => {
    expect(actionTicketNote({ id: "TK-007", note: "hi" }).argv)
      .toEqual(["ticket", "note", "TK-007", "hi"]);
    expect(() => actionTicketNote({ id: "TK-007", note: "   " })).toThrow(/note/);
  });

});

describe("memory promote", () => {
  test("each valid kind round-trips", () => {
    for (const kind of ["fact", "convention", "decision", "question"] as const) {
      expect(
        actionMemoryPromote({ kind, project: "hive", text: "Thing learned" }).argv,
      ).toEqual(["memory", kind, "Thing learned", "--project", "hive"]);
    }
  });
  test("rejects bogus kinds", () => {
    expect(() => actionMemoryPromote({ kind: "rumor" as any, project: "hive", text: "x" }))
      .toThrow(/invalid memory kind/);
  });
});

// ---------------------------------------------------------------------------
// Direct-file actions
// ---------------------------------------------------------------------------

describe("hashEntry", () => {
  test("hash uses trimmed input so whitespace doesn't split", () => {
    expect(hashEntry("foo")).toBe(hashEntry("  foo\n"));
  });
});

describe("actionIdentityPropose", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hive-ident-"));
    await ensureHiveScaffold(home);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("writes proposal file with slug", async () => {
    const paths = getHivePaths(home);
    const { path, slug } = await actionIdentityPropose(paths, {
      text: "Never ship on Friday!!!",
      now: new Date("2026-04-17T00:00:00Z"),
    });
    expect(slug).toBe("never-ship-on-friday");
    expect(path).toContain("identity-proposals/2026-04-17-never-ship-on-friday.md");

    const body = await readFile(path, "utf-8");
    expect(body).toContain("proposed: 2026-04-17T00:00:00.000Z");
    expect(body).toContain("approved: false");
    expect(body).toContain("Never ship on Friday");
  });

  test("falls back when text has no slug-friendly chars", async () => {
    const paths = getHivePaths(home);
    const { slug } = await actionIdentityPropose(paths, {
      text: "!!!",
      now: new Date("2026-04-17T00:00:00Z"),
    });
    expect(slug).toBe("proposal");
  });

  test("truncates slug at 40 chars", async () => {
    const paths = getHivePaths(home);
    const { slug } = await actionIdentityPropose(paths, {
      text: "a ".repeat(60),
      now: new Date("2026-04-17T00:00:00Z"),
    });
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});

describe("actionReflectionDismiss", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hive-refl-"));
    await ensureHiveScaffold(home);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("writes and de-dupes hashes", async () => {
    const paths = getHivePaths(home);
    const a = await actionReflectionDismiss(paths, { reflection: "x" });
    const b = await actionReflectionDismiss(paths, { reflection: "x" });
    expect(a.hash).toBe(b.hash);
    const stored = JSON.parse(await readFile(a.path, "utf-8"));
    expect(stored).toEqual([a.hash]);
  });
});
