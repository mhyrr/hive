import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  actionDispatch,
  actionDispatchKill,
  actionIdentityPropose,
  actionInboxAck,
  actionMemoryPromote,
  actionOverrideStatus,
  actionReflectionDismiss,
  actionTicketClose,
  actionTicketCreate,
  actionTicketDispatchRun,
  actionTicketNote,
  actionTicketReopen,
  actionTicketStart,
  actionTicketTagDispatch,
  hashEntry,
} from "../lib/dashboard/actions";
import { ensureHiveScaffold, getHivePaths } from "../lib/paths";
import { mkdir, writeFile } from "node:fs/promises";

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

  test("tag-dispatch vs dispatch-run go to different commands", () => {
    // `hive ticket dispatch <id>` — tags the ticket
    expect(actionTicketTagDispatch({ id: "TK-007" }).argv)
      .toEqual(["ticket", "dispatch", "TK-007"]);
    // `hive dispatch --ticket <id>` — actually dispatches a run
    expect(actionTicketDispatchRun({ id: "TK-007" }).argv)
      .toEqual(["dispatch", "--ticket", "TK-007"]);
  });
});

describe("dispatch and kill", () => {
  test("dispatch with just goal", () => {
    expect(actionDispatch({ goal: "Fix it" }).argv).toEqual(["dispatch", "Fix it"]);
  });
  test("dispatch with project", () => {
    expect(actionDispatch({ goal: "Fix it", project: "hive" }).argv)
      .toEqual(["dispatch", "Fix it", "--project", "hive"]);
  });
  test("dispatch rejects empty goal", () => {
    expect(() => actionDispatch({ goal: "" })).toThrow(/goal/);
  });
  test("kill validates run id", () => {
    expect(actionDispatchKill({ runId: "RUN-009" }).argv).toEqual(["kill", "RUN-009"]);
    expect(() => actionDispatchKill({ runId: "9" })).toThrow(/run id/);
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

describe("actionOverrideStatus", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hive-action-"));
    await ensureHiveScaffold(home);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("writes a whitelisted status", async () => {
    const paths = getHivePaths(home);
    const runDir = join(paths.runsDir, "RUN-001");
    await mkdir(runDir, { recursive: true });

    const { path } = await actionOverrideStatus(paths, { runId: "RUN-001", status: "complete" });
    const contents = await readFile(path, "utf-8");
    expect(contents.trim()).toBe("complete");
  });

  test("rejects non-allowlisted status", async () => {
    const paths = getHivePaths(home);
    await expect(
      actionOverrideStatus(paths, { runId: "RUN-001", status: "pwned" }),
    ).rejects.toThrow(/invalid override status/);
  });

  test("rejects invalid run id", async () => {
    const paths = getHivePaths(home);
    await expect(
      actionOverrideStatus(paths, { runId: "../../etc", status: "complete" }),
    ).rejects.toThrow(/invalid run id/);
  });

  test("rejects run that does not exist", async () => {
    const paths = getHivePaths(home);
    await expect(
      actionOverrideStatus(paths, { runId: "RUN-999", status: "complete" }),
    ).rejects.toThrow(/run not found/);
  });
});

describe("actionInboxAck", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "hive-ack-"));
    await ensureHiveScaffold(home);
    await mkdir(join(home, "projects", "hive"), { recursive: true });
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("writes entry hash to inbox-ack.json", async () => {
    const paths = getHivePaths(home);
    const { path, hash } = await actionInboxAck(paths, { project: "hive", entry: "some news" });
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    expect(parsed).toEqual([hash]);
    expect(hash).toHaveLength(16);
  });

  test("de-duplicates repeat acks", async () => {
    const paths = getHivePaths(home);
    const { path } = await actionInboxAck(paths, { project: "hive", entry: "same" });
    await actionInboxAck(paths, { project: "hive", entry: "same" });
    const parsed = JSON.parse(await readFile(path, "utf-8"));
    expect(parsed).toHaveLength(1);
  });

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
