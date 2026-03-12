import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli";

type TestContext = {
  root: string;
  repo: string;
  hiveHome: string;
};

let context: TestContext;

async function setupContext(): Promise<TestContext> {
  const root = await mkdtemp(join(tmpdir(), "hive-approval-"));
  const repo = join(root, "repo");
  const hiveHome = join(root, ".hive");

  await mkdir(repo, { recursive: true });

  process.env.HIVE_HOME = hiveHome;
  process.env.HIVE_FIXED_NOW = "2026-03-09T15:08:00Z";

  return { root, repo, hiveHome };
}

async function initAndAddProject(): Promise<void> {
  await runCli(["init"]);
  await runCli(["project", "add", "TestProject", context.repo]);
}

beforeEach(async () => {
  context = await setupContext();
});

afterEach(async () => {
  delete process.env.HIVE_HOME;
  delete process.env.HIVE_FIXED_NOW;
  await rm(context.root, { recursive: true, force: true });
});

describe("hive approval", () => {
  test("shows empty approval queue by default", async () => {
    await initAndAddProject();

    const output = await runCli(["approval"]);

    expect(output).toContain("# Approval Queue");
    expect(output).toContain("Pending approvals: 0");
  });

  test("request creates a pending approval and logs it to the feed", async () => {
    await initAndAddProject();

    const output = await runCli([
      "approval",
      "request",
      "deploy",
      "Promote",
      "the",
      "staging",
      "build",
      "after",
      "review",
    ]);

    expect(output).toContain("Created approval request 20260309-150800Z-deploy");
    expect(output).toContain("Kind: deploy");
    expect(output).toContain("Project: testproject");

    const queue = await runCli(["approval"]);
    expect(queue).toContain("20260309-150800Z-deploy");
    expect(queue).toContain("Promote the staging build after review");

    const feed = await runCli(["feed", "5"]);
    expect(feed).toContain("Approval requested: deploy");
    expect(feed).toContain("summary: Promote the staging build after review");
  });

  test("approve resolves the request and moves it out of the pending queue", async () => {
    await initAndAddProject();

    await runCli([
      "approval",
      "request",
      "publish",
      "Publish",
      "the",
      "release",
      "notes",
    ]);

    const output = await runCli([
      "approval",
      "approve",
      "20260309-150800Z-publish",
      "Looks",
      "good",
    ]);

    expect(output).toBe("Approved 20260309-150800Z-publish: Publish the release notes");

    const pending = await runCli(["approval"]);
    const resolved = await runCli(["approval", "resolved"]);
    const detail = await runCli(["approval", "show", "20260309-150800Z-publish"]);

    expect(pending).toContain("Pending approvals: 0");
    expect(resolved).toContain("Resolved approvals: 1");
    expect(resolved).toContain("20260309-150800Z-publish");
    expect(detail).toContain("Status: approved");
    expect(detail).toContain("Resolved by: human");
    expect(detail).toContain("Looks good");
  });

  test("reject updates status and preserves the request in resolved history", async () => {
    await initAndAddProject();

    await runCli([
      "approval",
      "request",
      "email",
      "Send",
      "the",
      "customer",
      "update",
    ]);

    const output = await runCli([
      "approval",
      "reject",
      "20260309-150800Z-email",
      "Needs",
      "a",
      "rewrite",
    ]);

    expect(output).toBe("Rejected 20260309-150800Z-email: Send the customer update");

    const detail = await runCli(["approval", "show", "20260309-150800Z-email"]);
    expect(detail).toContain("Status: rejected");
    expect(detail).toContain("Needs a rewrite");
  });
});
