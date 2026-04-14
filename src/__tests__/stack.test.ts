import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  listSourceSkills,
  listSourceStacks,
  listSyncedSkills,
  rewriteSkillName,
  syncStack,
} from "../lib/stack";

// ---------------------------------------------------------------------------
// rewriteSkillName — pure function, can be tested without filesystem
// ---------------------------------------------------------------------------

describe("rewriteSkillName", () => {
  test("rewrites a simple name line", () => {
    const input = `---\nname: ecto-patterns\ndescription: "foo"\n---\n\nBody\n`;
    const result = rewriteSkillName(input, "elixir-ecto-patterns");
    expect(result).toContain("name: elixir-ecto-patterns");
    expect(result).not.toContain("name: ecto-patterns\n");
  });

  test("strips block-list keys (paths:) that break Claude Code's parser", () => {
    const input = `---\nname: liveview-patterns\neffort: medium\nuser-invocable: false\npaths:\n  - "**/*_live.ex"\n  - "**/*.sface"\n---\n\nBody\n`;
    const result = rewriteSkillName(input, "elixir-liveview-patterns");
    expect(result).toContain("name: elixir-liveview-patterns");
    expect(result).toContain("effort: medium");
    expect(result).toContain("user-invocable: false");
    expect(result).not.toContain("paths:");
    expect(result).not.toContain("_live.ex");
    expect(result).not.toContain(".sface");
  });

  test("strips block-list keys in any frontmatter position", () => {
    // Block before `name:` — ensure we don't accidentally keep trailing indented lines.
    const input = `---\npaths:\n  - "a"\n  - "b"\nname: x\ndescription: "y"\n---\n\nBody\n`;
    const result = rewriteSkillName(input, "stack-x");
    expect(result).toContain("name: stack-x");
    expect(result).toContain('description: "y"');
    expect(result).not.toContain("paths:");
    expect(result).not.toContain('- "a"');
  });

  test("preserves body", () => {
    const body = "# Heading\n\nSome **markdown** body.\n\n- bullet\n";
    const input = `---\nname: x\n---\n\n${body}`;
    const result = rewriteSkillName(input, "new-x");
    expect(result).toContain(body.trim());
  });

  test("returns input unchanged when no frontmatter", () => {
    const input = "# Just a heading\n\nno frontmatter here\n";
    expect(rewriteSkillName(input, "anything")).toBe(input);
  });

  test("returns input unchanged when frontmatter has no name key", () => {
    const input = `---\neffort: low\n---\n\nbody\n`;
    expect(rewriteSkillName(input, "anything")).toBe(input);
  });

  test("handles CRLF line endings", () => {
    const input = `---\r\nname: foo\r\n---\r\n\r\nBody\r\n`;
    const result = rewriteSkillName(input, "bar");
    expect(result).toContain("name: bar");
  });
});

// ---------------------------------------------------------------------------
// Filesystem-backed helpers — use isolated HIVE_HOME and HOME stubs
// ---------------------------------------------------------------------------

describe("stack filesystem operations", () => {
  let hiveHome: string;
  let fakeHome: string;
  let prevHiveHome: string | undefined;
  let prevHome: string;

  beforeEach(async () => {
    hiveHome = await mkdtemp(join(tmpdir(), "hive-stack-home-"));
    fakeHome = await mkdtemp(join(tmpdir(), "hive-stack-fakehome-"));
    prevHiveHome = process.env.HIVE_HOME;
    prevHome = process.env.HOME ?? homedir();
    process.env.HIVE_HOME = hiveHome;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    if (prevHiveHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = prevHiveHome;
    process.env.HOME = prevHome;
    await rm(hiveHome, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  async function seedSkill(stack: string, topic: string, skillMd: string, references: Record<string, string> = {}) {
    const skillDir = join(hiveHome, "stacks", stack, "skills", topic);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), skillMd);
    if (Object.keys(references).length > 0) {
      await mkdir(join(skillDir, "references"), { recursive: true });
      for (const [name, body] of Object.entries(references)) {
        await writeFile(join(skillDir, "references", name), body);
      }
    }
  }

  test("listSourceStacks returns directories", async () => {
    await mkdir(join(hiveHome, "stacks", "elixir", "skills"), { recursive: true });
    await mkdir(join(hiveHome, "stacks", "typescript", "skills"), { recursive: true });

    const stacks = await listSourceStacks();
    expect(stacks).toEqual(["elixir", "typescript"]);
  });

  test("listSourceSkills returns skill topic names", async () => {
    await seedSkill("elixir", "ecto-patterns", "---\nname: ecto-patterns\n---\n");
    await seedSkill("elixir", "idioms", "---\nname: idioms\n---\n");

    expect(await listSourceSkills("elixir")).toEqual(["ecto-patterns", "idioms"]);
  });

  test("syncStack copies skills, prefixes names, and rewrites frontmatter", async () => {
    await seedSkill(
      "elixir",
      "ecto-patterns",
      `---\nname: ecto-patterns\neffort: medium\n---\n\n# Body\n`,
      { "queries.md": "query content\n" },
    );

    const result = await syncStack("elixir");

    expect(result.copied).toEqual(["elixir-ecto-patterns"]);
    expect(result.removed).toEqual([]);

    const targetSkill = join(fakeHome, ".claude", "skills", "elixir-ecto-patterns", "SKILL.md");
    const targetRef = join(fakeHome, ".claude", "skills", "elixir-ecto-patterns", "references", "queries.md");

    expect(existsSync(targetSkill)).toBe(true);
    expect(existsSync(targetRef)).toBe(true);

    const body = await Bun.file(targetSkill).text();
    expect(body).toContain("name: elixir-ecto-patterns");
    expect(body).not.toContain("name: ecto-patterns\n");
    expect(body).toContain("effort: medium");
  });

  test("syncStack removes orphaned synced skills", async () => {
    // First sync: two skills
    await seedSkill("elixir", "a", "---\nname: a\n---\n");
    await seedSkill("elixir", "b", "---\nname: b\n---\n");
    await syncStack("elixir");

    expect(await listSyncedSkills("elixir")).toEqual(["a", "b"]);

    // Drop 'b' from source, re-sync
    await rm(join(hiveHome, "stacks", "elixir", "skills", "b"), { recursive: true, force: true });
    const result = await syncStack("elixir");

    expect(result.copied).toEqual(["elixir-a"]);
    expect(result.removed).toEqual(["elixir-b"]);
    expect(await listSyncedSkills("elixir")).toEqual(["a"]);
  });

  test("syncStack throws UsageError for unknown stack", async () => {
    expect(syncStack("ghost")).rejects.toThrow(/not found/);
  });

  test("listSyncedSkills ignores unrelated skill dirs", async () => {
    // Pre-populate an unrelated user skill
    const foreign = join(fakeHome, ".claude", "skills", "copywriting");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "SKILL.md"), "---\nname: copywriting\n---\n");

    await seedSkill("elixir", "idioms", "---\nname: idioms\n---\n");
    await syncStack("elixir");

    expect(await listSyncedSkills("elixir")).toEqual(["idioms"]);
    expect(existsSync(foreign)).toBe(true);
  });
});
