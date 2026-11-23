import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addCandidates,
  approveCandidate,
  candidatesPath,
  declineCandidate,
  extractInboxCandidates,
  insertIntoSection,
  listPendingCandidates,
  upsertPendingSection,
} from "../lib/identity-candidates";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { inboxCommand } from "../commands/inbox";
import { identityCommand } from "../commands/identity";

async function freshHome(): Promise<HivePaths> {
  return ensureHiveScaffold(await mkdtemp(join(tmpdir(), "hive-idcand-")));
}

const input = (text: string, target: "IDENTITY.md" | "SELF.md" = "IDENTITY.md") => ({
  target,
  text,
  date: "2026-11-14",
  project: "alpha",
  source: "test",
});

describe("pending store", () => {
  test("a re-proposal of pending text is not a second candidate", async () => {
    const paths = await freshHome();
    expect(await addCandidates(paths, [input("Spot-check reports")])).toHaveLength(1);
    expect(await addCandidates(paths, [input("Spot-check reports")])).toHaveLength(0);
    // Same text for a different file is a different candidate.
    expect(await addCandidates(paths, [input("Spot-check reports", "SELF.md")])).toHaveLength(1);
    expect(await listPendingCandidates(paths)).toHaveLength(2);
  });

  test("a corrupt store fails loudly instead of being overwritten", async () => {
    const paths = await freshHome();
    await writeFile(candidatesPath(paths), "{ not json");
    await expect(addCandidates(paths, [input("x")])).rejects.toThrow();
    expect(await Bun.file(candidatesPath(paths)).text()).toBe("{ not json");
  });

  test("an unknown or ambiguous id changes nothing", async () => {
    const paths = await freshHome();
    await addCandidates(paths, [input("one"), input("two")]);
    await expect(declineCandidate(paths, "zzzz")).rejects.toThrow(/No pending/);
    await expect(approveCandidate(paths, "")).rejects.toThrow(/matches 2/);
    expect(await listPendingCandidates(paths)).toHaveLength(2);
  });

  test("approve with --text applies the edited wording and logs the original", async () => {
    const paths = await freshHome();
    await writeFile(paths.self, "# Self\n\n## Working Patterns\n- Ships early.\n\n## Continuity\nGrows.\n");
    const [c] = await addCandidates(paths, [input("Greg likes long briefs", "SELF.md")]);
    const r = await approveCandidate(paths, c!.id.slice(0, 4), { text: "Greg likes short briefs" });
    expect(r.appliedTo).toBe(paths.self);
    expect(await Bun.file(paths.self).text()).toBe(
      "# Self\n\n## Working Patterns\n- Ships early.\n- Greg likes short briefs\n\n## Continuity\nGrows.\n",
    );
    const log = await Bun.file(join(paths.home, "identity-candidates.log")).text();
    expect(log).toContain('"action":"approved"');
    expect(log).toContain("edited from: Greg likes long briefs");
  });
});

describe("insertIntoSection", () => {
  test("appends at the end of the file when the heading is missing", () => {
    expect(insertIntoSection("# Identity\n\nBody.\n", "## Things You've Learned", "New")).toBe(
      "# Identity\n\nBody.\n\n- New\n",
    );
  });

  test("appends to a section that is the last in the file", () => {
    expect(insertIntoSection("# I\n\n## Things You've Learned\n- a\n", "## Things You've Learned", "b")).toBe(
      "# I\n\n## Things You've Learned\n- a\n- b\n",
    );
  });
});

describe("extractInboxCandidates", () => {
  test("keeps findings, takes candidate bullets, and joins wrapped lines", () => {
    const body = [
      "- finding one",
      "",
      "## 2026-11-21T07:06:19Z — Session learnings — candidates for promotion",
      "",
      "Target: `SELF.md` (About Greg). These passed the dedupe gate; review before applying.",
      "",
      "- (2026-11-21) Greg wants research,",
      "  not questions.",
      "",
      "---",
      "",
      "- finding two",
    ].join("\n");
    const r = extractInboxCandidates(body);
    expect(r.candidates).toEqual([
      { target: "SELF.md", text: "Greg wants research, not questions.", date: "2026-11-21" },
    ]);
    expect(r.remaining).toBe("- finding one\n\n\n- finding two");
  });

  test("leaves a candidates heading without a Target line in place", () => {
    const body = "## x — candidates for promotion\n\n- something else\n";
    const r = extractInboxCandidates(body);
    expect(r.candidates).toEqual([]);
    expect(r.remaining).toContain("something else");
  });
});

describe("upsertPendingSection", () => {
  test("replaces the section in place and removes it when nothing is pending", async () => {
    const paths = await freshHome();
    const [c] = await addCandidates(paths, [input("Spot-check reports")]);
    const briefing = "# HIVE\n\n## Headline\nQuiet.\n\n## Canon size\n- ok\n";
    const once = upsertPendingSection(briefing, [c!]);
    expect(upsertPendingSection(once, [c!])).toBe(once);
    expect(once).toContain("## Canon size\n- ok");
    expect(once.match(/## Identity candidates/g)).toHaveLength(1);
    expect(upsertPendingSection(once, [])).toBe(briefing);
  });
});

describe("commands", () => {
  let paths: HivePaths;
  const priorHome = process.env.HIVE_HOME;
  let output: string[];
  const priorLog = console.log;

  beforeEach(async () => {
    paths = await freshHome();
    process.env.HIVE_HOME = paths.home;
    output = [];
    console.log = (...args: unknown[]) => output.push(args.join(" "));
  });

  afterEach(() => {
    console.log = priorLog;
    if (priorHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = priorHome;
  });

  test("hive inbox clear keeps identity candidates pending", async () => {
    const inbox = join(paths.projectsDir, "alpha", "inbox.md");
    await Bun.write(
      inbox,
      "# Inbox: alpha\n\n- finding\n\n## t — Session learnings — candidates for promotion\n\nTarget: `IDENTITY.md` (About Maya).\n\n- (2026-11-14) Check scope first.\n\n---\n",
    );
    await inboxCommand(["clear", "--project", "alpha"]);
    expect(await Bun.file(inbox).text()).toBe("# Inbox: alpha\n\n");
    expect((await listPendingCandidates(paths)).map((c) => c.text)).toEqual(["Check scope first."]);
    expect(output.join("\n")).toContain("1 identity candidate(s) kept as pending");
  });

  test("hive identity propose, candidates, decline", async () => {
    await identityCommand(["propose", "--target", "IDENTITY.md", "--project", "writing", "Check", "scope", "first."]);
    const [c] = await listPendingCandidates(paths);
    expect(c).toMatchObject({ text: "Check scope first.", project: "writing", source: "cli" });

    await identityCommand(["candidates"]);
    expect(output.join("\n")).toContain(`\`${c!.id}\` → IDENTITY.md`);

    await identityCommand(["decline", c!.id, "--reason", "covered"]);
    expect(await listPendingCandidates(paths)).toEqual([]);
    await expect(identityCommand(["approve", c!.id])).rejects.toThrow(/No pending/);
  });
});
