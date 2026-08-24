import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

let scratch: string;

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "hive-cursor-launch-")));
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("Cursor CLI launch", () => {
  test("approves HIVE first, prepends identity, preserves flags, and propagates persona", async () => {
    const project = join(scratch, "project");
    const hiveHome = join(scratch, "hive-home");
    const fakeHome = join(scratch, "user-home");
    const fakeCursor = join(scratch, "cursor-agent");
    const logPath = join(scratch, "cursor-calls.jsonl");
    await mkdir(project, { recursive: true });
    await mkdir(join(hiveHome, "projects", "fixture"), { recursive: true });
    await mkdir(join(hiveHome, "memory", "projects", "fixture"), { recursive: true });
    await mkdir(join(hiveHome, "personas"), { recursive: true });
    await mkdir(join(hiveHome, "taste"), { recursive: true });
    await mkdir(fakeHome, { recursive: true });

    for (const [name, marker] of [
      ["SOUL.md", "soul-marker"],
      ["IDENTITY.md", "identity-marker"],
      ["SELF.md", "self-marker"],
      ["AGENTS.md", "agents-marker"],
      ["TRUST.md", "trust-marker"],
    ] as const) {
      await writeFile(join(hiveHome, name), `# ${marker}\n`);
    }
    await writeFile(join(hiveHome, "personas", "skeptic.md"), "# persona-skeptic-marker\n");
    await writeFile(join(hiveHome, "taste", "principles.md"), "# taste-marker\n");
    await writeFile(
      join(hiveHome, "projects", "fixture", "config.md"),
      `---\nname: fixture\npath: ${project}\n---\n`,
    );
    await writeFile(
      join(hiveHome, "memory", "projects", "fixture", "_index.md"),
      "# memory-marker\n",
    );

    await writeFile(
      fakeCursor,
      [
        "#!/usr/bin/env bun",
        'import { appendFileSync } from "node:fs";',
        "appendFileSync(process.env.CURSOR_TEST_LOG!, JSON.stringify({",
        "  args: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "  persona: process.env.HIVE_PERSONA ?? null,",
        '}) + "\\n");',
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    await chmod(fakeCursor, 0o755);

    const repoRoot = join(import.meta.dir, "..", "..");
    const result = spawnSync(
      process.execPath,
      [
        join(repoRoot, "src", "cli.ts"),
        "-a",
        "--persona", "skeptic",
        "--mode", "ask",
        "--print",
        "fix auth",
      ],
      {
        cwd: project,
        env: {
          ...process.env,
          HOME: fakeHome,
          HIVE_HOME: hiveHome,
          HIVE_CURSOR_BIN: fakeCursor,
          CURSOR_TEST_LOG: logPath,
        },
        encoding: "utf-8",
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const calls = (await readFile(logPath, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string; persona: string | null });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args).toEqual(["mcp", "enable", "hive"]);
    expect(calls[0]!.cwd).toBe(project);

    const launch = calls[1]!;
    expect(launch.args.slice(0, 6)).toEqual([
      "--trust", "--add-dir", join(fakeHome, ".hive"), "--mode", "ask", "--print",
    ]);
    expect(launch.args).toHaveLength(7);
    expect(launch.args[6]).toContain("identity-marker");
    expect(launch.args[6]).toContain("persona-skeptic-marker");
    expect(launch.args[6]).toContain("memory-marker");
    expect(launch.args[6]).toContain("User request:\nfix auth");
    expect(launch.args).not.toContain("--plugin-dir");
    expect(launch.cwd).toBe(project);
    expect(launch.persona).toBe("skeptic");
  });
});
