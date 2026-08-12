import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectFromCwd } from "../lib/project";

let tempHive: string;
let tempRoot: string;
let originalHiveHome: string | undefined;
let originalCwd: string;

/** Register a project pointing at `path`, creating the directory too. */
async function register(projectId: string, path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  const projDir = join(tempHive, "projects", projectId);
  await mkdir(projDir, { recursive: true });
  await writeFile(join(projDir, "config.md"), `---\nname: ${projectId}\npath: ${path}\n---\n`);
  return path;
}

beforeEach(async () => {
  tempHive = await realpath(await mkdtemp(join(tmpdir(), "hive-resolve-hive-")));
  tempRoot = await realpath(await mkdtemp(join(tmpdir(), "hive-resolve-root-")));
  originalHiveHome = process.env.HIVE_HOME;
  originalCwd = process.cwd();
  process.env.HIVE_HOME = tempHive;
  await mkdir(join(tempHive, "projects"), { recursive: true });
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalHiveHome) process.env.HIVE_HOME = originalHiveHome;
  else delete process.env.HIVE_HOME;
  await rm(tempHive, { recursive: true, force: true });
  await rm(tempRoot, { recursive: true, force: true });
});

describe("resolveProjectFromCwd", () => {
  test("resolves the project owning cwd, and a subdirectory of it", async () => {
    const alpha = await register("alpha", join(tempRoot, "alpha"));
    await register("beta", join(tempRoot, "beta"));

    process.chdir(alpha);
    expect(resolveProjectFromCwd()).toBe("alpha");

    const nested = join(alpha, "src", "lib");
    await mkdir(nested, { recursive: true });
    process.chdir(nested);
    expect(resolveProjectFromCwd()).toBe("alpha");
  });

  test("returns null from an unregistered directory rather than guessing", async () => {
    // Regression: this used to return the first project directory
    // alphabetically, so memory writes and tickets from an unrelated
    // directory silently landed in someone else's project.
    await register("alpha", join(tempRoot, "alpha"));
    await register("beta", join(tempRoot, "beta"));

    const outside = join(tempRoot, "not-a-project");
    await mkdir(outside, { recursive: true });
    process.chdir(outside);

    expect(resolveProjectFromCwd()).toBeNull();
  });

  test("does not match a sibling that merely shares a name prefix", async () => {
    await register("hive", join(tempRoot, "hive"));
    const old = await register("hive-old", join(tempRoot, "hive-old"));

    process.chdir(old);
    expect(resolveProjectFromCwd()).toBe("hive-old");
  });

  test("prefers the deepest match when one project nests inside another", async () => {
    await register("monorepo", join(tempRoot, "mono"));
    const inner = await register("api", join(tempRoot, "mono", "packages", "api"));

    process.chdir(inner);
    expect(resolveProjectFromCwd()).toBe("api");

    process.chdir(join(tempRoot, "mono"));
    expect(resolveProjectFromCwd()).toBe("monorepo");
  });

  test("matches through a symlinked cwd", async () => {
    const real = await register("alpha", join(tempRoot, "alpha"));
    const link = join(tempRoot, "alpha-link");
    await symlink(real, link);

    process.chdir(link);
    expect(resolveProjectFromCwd()).toBe("alpha");
  });

  test("skips projects whose config is missing a path or unreadable", async () => {
    const projDir = join(tempHive, "projects", "broken");
    await mkdir(projDir, { recursive: true });
    await writeFile(join(projDir, "config.md"), `---\nname: broken\n---\n`);
    const alpha = await register("alpha", join(tempRoot, "alpha"));

    process.chdir(alpha);
    expect(resolveProjectFromCwd()).toBe("alpha");
  });
});
