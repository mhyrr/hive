import { afterEach, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureGitContentFingerprint,
  captureGitStatusSnapshot,
  diffGitStatusSnapshots,
} from "../src/lib/git";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();

    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

async function createRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hive-git-"));
  tempDirs.push(dir);

  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "tracked.ts"), "export const value = 1;\n");

  execSync("git init", { cwd: dir, stdio: "ignore" });
  execSync('git config user.email "hive@example.com"', { cwd: dir, stdio: "ignore" });
  execSync('git config user.name "HIVE Tests"', { cwd: dir, stdio: "ignore" });
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });

  return dir;
}

describe("git content fingerprints", () => {
  test("detects content changes for already-dirty tracked and untracked files", async () => {
    const repo = await createRepo();
    const trackedPath = join(repo, "src", "tracked.ts");
    const untrackedPath = join(repo, "notes.md");

    await writeFile(trackedPath, "export const value = 2;\n");
    await writeFile(untrackedPath, "draft one\n");

    const beforeStatus = captureGitStatusSnapshot(repo);
    const beforeFingerprint = captureGitContentFingerprint(repo, beforeStatus);

    await writeFile(trackedPath, "export const value = 3;\n");
    await writeFile(untrackedPath, "draft two\n");

    const afterStatus = captureGitStatusSnapshot(repo);
    const afterFingerprint = captureGitContentFingerprint(repo, afterStatus);
    const delta = diffGitStatusSnapshots(beforeStatus, afterStatus, {
      beforeFingerprint,
      afterFingerprint,
    });

    expect(beforeStatus).toEqual(afterStatus);
    expect(delta.available).toBeTrue();
    expect(delta.changedFiles).toEqual(["notes.md", "src/tracked.ts"]);
    expect(delta.summaryLines).toEqual(["?? notes.md", "M src/tracked.ts"]);
  });
});
