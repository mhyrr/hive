import { describe, test, expect } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { buildConditionReport } from "../lib/condition";
import { ensureHiveScaffold } from "../lib/paths";

function git(repo: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hive-git-"));
  git(dir, "init", "-q", "-b", "main");
  // Local config so commits succeed in CI/sandbox without global identity.
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test");
  return dir;
}

async function freshHomeWithRepo(projectId: string, repoPath: string): Promise<{
  home: string;
  paths: ReturnType<typeof ensureHiveScaffold> extends Promise<infer T> ? T : never;
}> {
  const home = await mkdtemp(join(tmpdir(), "hive-cond-git-"));
  const paths = await ensureHiveScaffold(home);
  await mkdir(join(paths.projectsDir, projectId), { recursive: true });
  await writeFile(
    join(paths.projectsDir, projectId, "config.md"),
    `---\nname: ${projectId}\npath: ${repoPath}\n---\n`,
  );
  return { home, paths };
}

describe("buildConditionReport — git numstat against a real repo", () => {
  test("counts commits, insertions, deletions, files within window", async () => {
    const repo = await makeRepo();

    // commit 1: 5 insertions (+ initial file)
    await writeFile(join(repo, "alpha.txt"), "a\nb\nc\nd\ne\n");
    git(repo, "add", "alpha.txt");
    git(repo, "commit", "-q", "-m", "feat: add alpha");

    // commit 2: 2 insertions, 1 deletion
    await writeFile(join(repo, "alpha.txt"), "a\nb\nc\nd\nE\nf\nG\n");
    git(repo, "add", "alpha.txt");
    git(repo, "commit", "-q", "-m", "fix: tweak alpha");

    // commit 3: another file (3 insertions)
    await writeFile(join(repo, "bravo.txt"), "x\ny\nz\n");
    git(repo, "add", "bravo.txt");
    git(repo, "commit", "-q", "-m", "feat: add bravo");

    const { paths } = await freshHomeWithRepo("alpha", repo);
    const report = await buildConditionReport(paths);

    const project = report.projects.find((p) => p.projectName === "alpha");
    expect(project).toBeTruthy();
    const g = project!.git;
    expect(g.available).toBe(true);
    expect(g.commits).toBe(3);
    expect(g.subjects).toEqual([
      "feat: add bravo",
      "fix: tweak alpha",
      "feat: add alpha",
    ]);
    // alpha.txt: +5 (initial), then +3/-1 (e→E plus f, G); bravo.txt: +3.
    // Totals: +11, -1, 2 files.
    expect(g.insertions).toBe(11);
    expect(g.deletions).toBe(1);
    expect(g.filesChanged).toBe(2);
  });

  test("trivial detection turns OFF when commits land in window", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "x.txt"), "hello\n");
    git(repo, "add", "x.txt");
    git(repo, "commit", "-q", "-m", "init");

    const { paths } = await freshHomeWithRepo("alpha", repo);
    const report = await buildConditionReport(paths);
    expect(report.trivial).toBe(false);
    expect(report.totals.commitCount).toBe(1);
  });

  test("commits older than the window are excluded", async () => {
    const repo = await makeRepo();
    await writeFile(join(repo, "x.txt"), "hello\n");
    git(repo, "add", "x.txt");
    // GIT_COMMITTER_DATE + GIT_AUTHOR_DATE land the commit 30 days back.
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const r = spawnSync(
      "git",
      ["-C", repo, "commit", "-q", "-m", "ancient"],
      {
        encoding: "utf-8",
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: oldDate,
          GIT_COMMITTER_DATE: oldDate,
        },
      },
    );
    expect(r.status).toBe(0);

    const { paths } = await freshHomeWithRepo("alpha", repo);
    const report = await buildConditionReport(paths);
    const project = report.projects.find((p) => p.projectName === "alpha");
    expect(project?.git.commits).toBe(0);
  });

  test("non-existent repo path → available=false, no crash", async () => {
    const { paths } = await freshHomeWithRepo("alpha", "/tmp/definitely/not/a/repo");
    const report = await buildConditionReport(paths);
    const project = report.projects.find((p) => p.projectName === "alpha");
    expect(project?.git.available).toBe(false);
    expect(project?.git.commits).toBe(0);
  });
});
