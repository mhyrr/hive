import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureHiveScaffold, type HivePaths } from "./paths";
import {
  latestInvocations,
  parseInvocationLog,
  readInvocations,
  writeInvocationLog,
} from "./watch-log";
import type { WatchDef } from "./watch";

function watchDef(qualifiedName: string): WatchDef {
  const [a, b] = qualifiedName.split("/");
  return {
    name: b ?? a!,
    qualifiedName,
    cadence: { type: "nightly" },
    scope: ["runs"],
    model: "judgment",
    venue: "briefing",
    autonomy: "propose",
    enabled: true,
    project: b ? a! : null,
    question: "What should we propose?",
    filePath: `/tmp/${qualifiedName}.md`,
    fanned: false,
  };
}

async function write(paths: HivePaths, name: string, at: string, over: Partial<Parameters<typeof writeInvocationLog>[0]> = {}) {
  await writeInvocationLog({
    paths,
    watch: watchDef(name),
    now: new Date(at),
    modelId: "claude-opus-4-8",
    autonomy: "propose",
    reasons: ["runs: new activity"],
    systemPrompt: "You are a HIVE watch",
    userContent: "# Watch digest\n\n## Nightly runs\nstuff",
    output: "Proposal 1 — ship it.",
    outcome: "surfaced",
    durationMs: 1234,
    ...over,
  });
}

describe("watch invocation log", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    paths = await ensureHiveScaffold(await mkdtemp(join(tmpdir(), "hive-watchlog-")));
  });

  test("round-trips the exact prompts, meta, and output", async () => {
    await write(paths, "propose", "2026-08-13T06:18:31Z");

    const { invocations, warnings } = await readInvocations(paths, { watch: "propose" });
    expect(warnings).toEqual([]);
    expect(invocations.length).toBe(1);
    expect(invocations[0]).toMatchObject({
      watch: "propose",
      at: "2026-08-13T06:18:31Z",
      date: "2026-08-13",
      model: "claude-opus-4-8",
      autonomy: "propose",
      outcome: "surfaced",
      durationMs: 1234,
      reasons: ["runs: new activity"],
      systemPrompt: "You are a HIVE watch",
      userContent: "# Watch digest\n\n## Nightly runs\nstuff",
      output: "Proposal 1 — ship it.",
      error: null,
    });
  });

  test("a digest carrying its own '## Output' heading does not shift the section boundary", async () => {
    // The digest is verbatim project text — it routinely contains markdown
    // headings, including ones that collide with the log's own section names.
    await write(paths, "propose", "2026-08-13T06:18:31Z", {
      userContent: "# digest\n\n## Output\nan artifact quoted from a run\n\n## System prompt\nquoted too",
      output: "The real output.",
    });

    const { invocations } = await readInvocations(paths, { watch: "propose" });
    expect(invocations[0]!.output).toBe("The real output.");
    expect(invocations[0]!.userContent).toContain("an artifact quoted from a run");
  });

  test("an errored call logs the error, not an output", async () => {
    await write(paths, "observe", "2026-08-13T10:47:07Z", {
      output: null,
      error: "ConnectionRefused",
      outcome: "error",
      durationMs: null,
    });

    const { invocations } = await readInvocations(paths, { watch: "observe" });
    expect(invocations[0]!.output).toBeNull();
    expect(invocations[0]!.error).toBe("ConnectionRefused");
    expect(invocations[0]!.durationMs).toBeNull();
  });

  test("reads newest first, filters by watch, and honors the limit", async () => {
    await write(paths, "propose", "2026-08-11T06:00:00Z");
    await write(paths, "propose", "2026-08-12T06:00:00Z");
    await write(paths, "propose", "2026-08-13T06:00:00Z");
    await write(paths, "observe", "2026-08-13T10:00:00Z");

    const all = await readInvocations(paths, { limit: 10 });
    expect(all.invocations.map((i) => i.at)).toEqual([
      "2026-08-13T10:00:00Z",
      "2026-08-13T06:00:00Z",
      "2026-08-12T06:00:00Z",
      "2026-08-11T06:00:00Z",
    ]);

    const proposals = await readInvocations(paths, { watch: "propose", limit: 2 });
    expect(proposals.invocations.map((i) => i.at)).toEqual([
      "2026-08-13T06:00:00Z",
      "2026-08-12T06:00:00Z",
    ]);
  });

  test("project-scoped names round-trip through the filename encoding", async () => {
    await write(paths, "alpha/ready", "2026-08-13T06:00:00Z");
    const { invocations } = await readInvocations(paths, { watch: "alpha/ready" });
    expect(invocations.length).toBe(1);
    expect(invocations[0]!.watch).toBe("alpha/ready");
  });

  test("latestInvocations answers one file per watch", async () => {
    await write(paths, "propose", "2026-08-11T06:00:00Z", { output: "old" });
    await write(paths, "propose", "2026-08-13T06:00:00Z", { output: "new" });
    await write(paths, "observe", "2026-08-12T10:00:00Z", { output: "observation memo" });

    const { byWatch } = await latestInvocations(paths, ["propose", "observe", "never-ran"]);
    expect(byWatch.get("propose")!.output).toBe("new");
    expect(byWatch.get("observe")!.output).toBe("observation memo");
    expect(byWatch.has("never-ran")).toBe(false);
  });

  test("a malformed log file warns instead of throwing", async () => {
    await Bun.write(
      join(paths.watchesDir, "log", "2026-08-13", "propose-20260813-060000Z.md"),
      "---\nwatch: propose\n---\n\nno sections here",
    );
    const { invocations, warnings } = await readInvocations(paths, { watch: "propose" });
    expect(invocations).toEqual([]);
    expect(warnings[0]).toContain("unparseable invocation log");
  });

  test("parse returns null when the headers are missing", () => {
    expect(parseInvocationLog("---\nwatch: propose\n---\n\nbody", { path: "p", date: "2026-08-13" })).toBeNull();
  });

  test("renamed cycles retain their historical invocation logs", async () => {
    await write(paths, "bets", "2026-08-12T06:00:00Z", { output: "historical proposal" });
    await write(paths, "muse", "2026-08-12T10:00:00Z", { output: "historical observation" });

    expect((await readInvocations(paths, { watch: "propose" })).invocations[0]).toMatchObject({
      watch: "propose",
      output: "historical proposal",
    });
    expect((await readInvocations(paths, { watch: "observe" })).invocations[0]).toMatchObject({
      watch: "observe",
      output: "historical observation",
    });
  });
});
