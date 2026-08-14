import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collectWatchDetailPage, renderWatchDetailDocument } from "./watch-detail-page";
import { ensureHiveScaffold, getProjectPaths, type HivePaths } from "../paths";
import { parseWatchFile } from "../watch";
import { writeInvocationLog } from "../watch-log";

const ANCHOR = new Date("2026-08-13T10:00:00Z");
const PROPOSE_FILE =
  "---\nname: propose\ncadence: @nightly\nscope: runs\nmodel: judgment\nvenue: briefing\nautonomy: act\n---\n\nWhat should we propose?";

describe("watch detail page", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    paths = await ensureHiveScaffold(await mkdtemp(join(tmpdir(), "hive-watchdetail-")));
    process.env.HIVE_FIXED_NOW = ANCHOR.toISOString();
  });

  afterEach(() => {
    delete process.env.HIVE_FIXED_NOW;
  });

  async function logCall(name: string, at: Date, over: Partial<Parameters<typeof writeInvocationLog>[0]> = {}) {
    const { watch } = parseWatchFile(PROPOSE_FILE, join(paths.watchesDir, `${name}.md`), null);
    await writeInvocationLog({
      paths,
      watch: { ...watch!, name, qualifiedName: name },
      now: at,
      modelId: "claude-opus-4-8",
      autonomy: "propose",
      reasons: ["runs: new activity in nightly runs"],
      systemPrompt: "You are a HIVE watch — Watch: propose.",
      userContent: "# Watch digest: propose\nActivity interval: previous tick → current tick.\n\n## Nightly runs in interval\n...",
      output: "Proposal 1 — ship the dispute queue.",
      outcome: "surfaced",
      durationMs: 60_019,
      ...over,
    });
  }

  test("unknown watch collects as null", async () => {
    expect(await collectWatchDetailPage(paths, "nope")).toBeNull();
  });

  test("spec, live prompt, and clamped autonomy", async () => {
    await writeFile(paths.config, "# Hive Config\n\nwatches.max_autonomy: observe\n");
    await writeFile(join(paths.watchesDir, "propose.md"), PROPOSE_FILE);

    const data = await collectWatchDetailPage(paths, "propose");
    expect(data).not.toBeNull();
    expect(data!.effectiveAutonomy).toBe("observe"); // act → ceiling
    expect(data!.modelId).toBeTruthy();
    // The system prompt is built by the runner's own builder, so it can't drift.
    expect(data!.systemPrompt).toContain("Watch: propose");
    expect(data!.systemPrompt).toContain("OBSERVE");

    const html = renderWatchDetailDocument(data!);
    expect(html).toContain("Prompt as it fires now");
    expect(html).toContain("What should we propose?");
    expect(html).toContain("act → observe");
    expect(html).toContain("previous settled tick");
    expect(html).toContain("No model calls logged yet");
  });

  test("invocation history replays the exact prompts that were sent", async () => {
    await writeFile(join(paths.watchesDir, "propose.md"), PROPOSE_FILE);
    await logCall("propose", new Date(ANCHOR.getTime() - 4 * 3_600_000));
    await logCall("propose", new Date(ANCHOR.getTime() - 28 * 3_600_000), {
      output: "Yesterday's proposal.",
    });

    const data = await collectWatchDetailPage(paths, "propose");
    expect(data!.invocations.length).toBe(2);
    expect(data!.invocations[0]!.at > data!.invocations[1]!.at).toBe(true);

    const html = renderWatchDetailDocument(data!);
    expect(html).toContain("Watch digest: propose"); // the digest actually sent
    expect(html).toContain("woke on: runs: new activity in nightly runs");
    expect(html).toContain("ship the dispute queue");
    expect(html).toContain("Yesterday&#39;s proposal.");
    expect(html).toContain("System prompt sent");
  });

  test("an oversized digest is capped with a pointer to the file on disk", async () => {
    await writeFile(join(paths.watchesDir, "propose.md"), PROPOSE_FILE);
    await logCall("propose", ANCHOR, { userContent: "x".repeat(60_000) });

    const html = renderWatchDetailDocument((await collectWatchDetailPage(paths, "propose"))!);
    expect(html).toContain("truncated at 40,000 of 60,000 chars");
    expect(html).toContain("full text:");
  });

  test("a project-scoped watch resolves by qualified name", async () => {
    const projWatches = getProjectPaths(paths, "alpha").watchesDir;
    await mkdir(projWatches, { recursive: true });
    await writeFile(join(projWatches, "ready.md"), "---\ncadence: 2h\nscope: tickets\n---\n\nWhich tickets are ready?");

    expect(await collectWatchDetailPage(paths, "alpha/ready")).not.toBeNull();
    const html = renderWatchDetailDocument((await collectWatchDetailPage(paths, "alpha/ready"))!);
    expect(html).toContain("alpha/ready");
    expect(html).toContain("Which tickets are ready?");
  });
});
