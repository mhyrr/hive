import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  autoDetectStack,
  buildStackHint,
  clearStackBinding,
  installStack,
  listCannedStacks,
  listSourceSkills,
  listSourceStacks,
  listSyncedSkills,
  readStackBinding,
  resolveProjectStack,
  rewriteSkillName,
  STACK_NAME_RE,
  STACK_TRIGGERS,
  syncStack,
  writeStackBinding,
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

  test("preserves block-map keys (metadata: with nested scalar pairs)", () => {
    const input = `---\nname: typescript-pro\ndescription: "foo"\nlicense: MIT\nmetadata:\n  author: https://example.com\n  version: "1.1.0"\n  domain: language\n---\n\nBody\n`;
    const result = rewriteSkillName(input, "ts-typescript-pro");
    expect(result).toContain("name: ts-typescript-pro");
    expect(result).toContain("metadata:");
    expect(result).toContain("  author: https://example.com");
    expect(result).toContain('  version: "1.1.0"');
    expect(result).toContain("  domain: language");
    expect(result).toContain("license: MIT");
  });

  test("distinguishes block-list and block-map when both are present", () => {
    const input = `---\nname: x\npaths:\n  - "**/*.ts"\nmetadata:\n  version: "2"\n---\n\nBody\n`;
    const result = rewriteSkillName(input, "stack-x");
    expect(result).not.toContain("paths:");
    expect(result).not.toContain('- "**/*.ts"');
    expect(result).toContain("metadata:");
    expect(result).toContain('  version: "2"');
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

  // --- installStack (canned template → source tree) ---

  test("listCannedStacks reports templates shipped with the repo", async () => {
    const canned = await listCannedStacks();
    // The elixir stack is vendored into templates/stacks/elixir/.
    expect(canned).toContain("elixir");
  });

  test("installStack copies the elixir template into HIVE_HOME", async () => {
    const result = await installStack("elixir");
    expect(result.overwrote).toBe(false);
    expect(result.target).toBe(join(hiveHome, "stacks", "elixir"));

    const readme = join(result.target, "README.md");
    const skillsDir = join(result.target, "skills");
    expect(existsSync(readme)).toBe(true);
    expect(existsSync(skillsDir)).toBe(true);

    // All seven skill topics should land in source tree (pre-sync).
    const topics = (await listSourceSkills("elixir")).sort();
    expect(topics).toEqual([
      "ecto-patterns",
      "idioms",
      "liveview-patterns",
      "oban",
      "phoenix-contexts",
      "security",
      "testing",
    ]);
  });

  test("installStack refuses to overwrite without --force", async () => {
    await installStack("elixir");
    expect(installStack("elixir")).rejects.toThrow(/already installed/);
  });

  test("installStack with --force reinstalls cleanly", async () => {
    await installStack("elixir");

    // Simulate a stale user edit that should be wiped on --force.
    const stale = join(hiveHome, "stacks", "elixir", "skills", "stale-topic");
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, "SKILL.md"), "---\nname: stale\n---\n");

    const result = await installStack("elixir", { force: true });
    expect(result.overwrote).toBe(true);
    expect(existsSync(stale)).toBe(false);
  });

  test("installStack throws UsageError for unknown template", async () => {
    expect(installStack("no-such-stack")).rejects.toThrow(/No template for stack/);
  });

  // --- Stack binding + detection ---

  test("readStackBinding returns null when no binding file", () => {
    expect(readStackBinding("nonexistent-project")).toBeNull();
  });

  test("writeStackBinding + readStackBinding round-trip", async () => {
    const projectDir = join(hiveHome, "projects", "test-proj");
    await mkdir(projectDir, { recursive: true });
    await writeStackBinding("test-proj", "elixir");

    expect(readStackBinding("test-proj")).toBe("elixir");
  });

  test("writeStackBinding with 'none' reads back as 'none'", async () => {
    const projectDir = join(hiveHome, "projects", "test-proj");
    await mkdir(projectDir, { recursive: true });
    await writeStackBinding("test-proj", "none");

    expect(readStackBinding("test-proj")).toBe("none");
  });

  test("clearStackBinding removes the binding file", async () => {
    const projectDir = join(hiveHome, "projects", "test-proj");
    await mkdir(projectDir, { recursive: true });
    await writeStackBinding("test-proj", "elixir");

    expect(readStackBinding("test-proj")).toBe("elixir");
    await clearStackBinding("test-proj");
    expect(readStackBinding("test-proj")).toBeNull();
  });

  test("clearStackBinding is a no-op when no file exists", async () => {
    // Should not throw
    await clearStackBinding("no-such-project");
  });

  test("autoDetectStack finds mix.exs → elixir", async () => {
    const projRoot = join(fakeHome, "my-elixir-app");
    await mkdir(projRoot, { recursive: true });
    await writeFile(join(projRoot, "mix.exs"), "defmodule MyApp do\nend\n");

    expect(autoDetectStack(projRoot)).toBe("elixir");
  });

  test("autoDetectStack finds package.json → typescript", async () => {
    const projRoot = join(fakeHome, "my-ts-app");
    await mkdir(projRoot, { recursive: true });
    await writeFile(join(projRoot, "package.json"), "{}");

    expect(autoDetectStack(projRoot)).toBe("typescript");
  });

  test("autoDetectStack finds Cargo.toml → rust", async () => {
    const projRoot = join(fakeHome, "my-rust-app");
    await mkdir(projRoot, { recursive: true });
    await writeFile(join(projRoot, "Cargo.toml"), "[package]\nname = \"x\"\n");

    expect(autoDetectStack(projRoot)).toBe("rust");
  });

  test("autoDetectStack finds pyproject.toml → python", async () => {
    const projRoot = join(fakeHome, "my-py-app");
    await mkdir(projRoot, { recursive: true });
    await writeFile(join(projRoot, "pyproject.toml"), "[tool.poetry]\n");

    expect(autoDetectStack(projRoot)).toBe("python");
  });

  test("autoDetectStack returns null for empty dir", async () => {
    const projRoot = join(fakeHome, "plain-dir");
    await mkdir(projRoot, { recursive: true });

    expect(autoDetectStack(projRoot)).toBeNull();
  });

  test("autoDetectStack prefers mix.exs over package.json (first match wins)", async () => {
    const projRoot = join(fakeHome, "multi");
    await mkdir(projRoot, { recursive: true });
    await writeFile(join(projRoot, "mix.exs"), "");
    await writeFile(join(projRoot, "package.json"), "{}");

    expect(autoDetectStack(projRoot)).toBe("elixir");
  });

  test("resolveProjectStack uses binding over auto-detect", async () => {
    // Set up a project with config pointing to a dir with package.json
    const projDir = join(hiveHome, "projects", "bound-proj");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "config.md"),
      "---\nname: bound-proj\npath: /tmp/fake-proj\n---\n",
    );
    await writeStackBinding("bound-proj", "elixir");

    // Even though the project path might auto-detect differently,
    // the explicit binding wins
    expect(resolveProjectStack("bound-proj")).toBe("elixir");
  });

  test("resolveProjectStack returns null for 'none' binding", async () => {
    const projDir = join(hiveHome, "projects", "opted-out");
    await mkdir(projDir, { recursive: true });
    await writeStackBinding("opted-out", "none");

    expect(resolveProjectStack("opted-out")).toBeNull();
  });

  test("resolveProjectStack falls back to auto-detect", async () => {
    // Set up a project config pointing to a dir with mix.exs
    const projRoot = join(fakeHome, "elixir-proj");
    await mkdir(projRoot, { recursive: true });
    await writeFile(join(projRoot, "mix.exs"), "");

    const projDir = join(hiveHome, "projects", "auto-proj");
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "config.md"),
      `---\nname: auto-proj\npath: ${projRoot}\n---\n`,
    );

    // No binding file → should auto-detect elixir
    expect(resolveProjectStack("auto-proj")).toBe("elixir");
  });

  test("resolveProjectStack returns null when no config", () => {
    expect(resolveProjectStack("ghost-project")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildStackHint — pure function
// ---------------------------------------------------------------------------

describe("buildStackHint", () => {
  test("elixir hint names Phoenix/Ecto/LiveView/OTP/security as triggers", () => {
    const hint = buildStackHint("elixir");
    expect(hint).toBe(
      "Project stack: elixir. The elixir-* skills carry this project's domain canon for Phoenix contexts, Ecto, LiveView, OTP, or security patterns — load the matching skill when the work calls for it. If the Skill tool is unavailable (e.g. Codex, dispatch, or --agent mode), read it directly: ~/.claude/skills/elixir-*/SKILL.md",
    );
  });

  test("typescript hint names React/Next.js/types as triggers", () => {
    const hint = buildStackHint("typescript");
    expect(hint).toBe(
      "Project stack: typescript. The typescript-* skills carry this project's domain canon for React components, Next.js routing, or TypeScript types — load the matching skill when the work calls for it. If the Skill tool is unavailable (e.g. Codex, dispatch, or --agent mode), read it directly: ~/.claude/skills/typescript-*/SKILL.md",
    );
  });

  test("unknown stack falls back to generic-domain phrasing", () => {
    // Rust/python/etc. don't have named triggers yet — still point at the
    // skills, just without the specific surfaces.
    const hint = buildStackHint("rust");
    expect(hint).toBe(
      "Project stack: rust. The rust-* skills carry this project's domain canon — load the matching skill when the work calls for it. If the Skill tool is unavailable (e.g. Codex, dispatch, or --agent mode), read it directly: ~/.claude/skills/rust-*/SKILL.md",
    );
    // No named surfaces means no dangling "for ..." clause.
    expect(hint).not.toContain("canon for");
  });

  test("TK-134: every STACK_TRIGGERS phrase appears verbatim in its hint", () => {
    // The named surfaces are the information the hint carries — they tell the
    // model WHEN a skill is relevant. A future softening to "when the work has
    // domain weight" would quietly delete exactly this, so pin it directly
    // rather than relying on the full-string assertions above.
    for (const [stack, triggers] of Object.entries(STACK_TRIGGERS)) {
      expect(buildStackHint(stack, "claude")).toContain(triggers);
      expect(buildStackHint(stack, "codex")).toContain(triggers);
    }
  });

  test("hint drops the soft 'Prefer ... when they apply' wording", () => {
    // Regression guard: TK-042 replaced the soft preference with a direct
    // instruction. If this string reappears, the hint has drifted back.
    expect(buildStackHint("elixir")).not.toContain("Prefer");
    expect(buildStackHint("elixir")).not.toContain("when they apply");
  });

  test("TK-134: hint states a trigger condition, not a mandated procedure", () => {
    // The anti-pattern sentence was a rite, not information: it carried
    // nothing the named surfaces don't already carry, and it's the
    // always-do-X-before-Y shape that reads as ritual on newer models.
    for (const harness of ["claude", "codex", "pi"] as const) {
      for (const stack of ["elixir", "typescript", "rust"]) {
        const hint = buildStackHint(stack, harness);
        expect(hint).not.toContain("anti-pattern");
        expect(hint).not.toContain("Self-flagging");
        expect(hint).not.toContain("Before recommending");
      }
    }
  });

  test("hint is byte-stable across calls (TK-024 cache discipline)", () => {
    // The hint rides in the cache-stable prefix. Repeated calls must
    // produce identical output so the prompt prefix stays reachable.
    expect(buildStackHint("elixir")).toBe(buildStackHint("elixir"));
    expect(buildStackHint("typescript")).toBe(buildStackHint("typescript"));
    expect(buildStackHint("rust")).toBe(buildStackHint("rust"));
  });

  test("returns empty string for null", () => {
    expect(buildStackHint(null)).toBe("");
  });

  test("TK-114: codex harness emits a direct read-the-file instruction, no Skill tool mention", () => {
    // Codex has no Skill tool, so the Claude variant's "load the matching skill"
    // / "if the Skill tool is unavailable" framing is dead weight. Codex variant
    // names the file directly instead.
    const hint = buildStackHint("typescript", "codex");
    expect(hint).toBe(
      "Project stack: typescript. The typescript-* skills carry this project's domain canon for React components, Next.js routing, or TypeScript types — read the matching ~/.claude/skills/typescript-*/SKILL.md when the work calls for it.",
    );
    // No Skill tool conditional.
    expect(hint).not.toContain("Skill tool");
    expect(hint).not.toContain("load the matching");
  });

  test("TK-114: claude variant fallback explicitly names Codex as a no-Skill-tool environment", () => {
    // The claude-variant text is what dispatch/--agent mode sessions see, and
    // it's also a safety net for any path that emits claude-style text into a
    // Codex environment. Naming Codex in the fallback helps that case land.
    expect(buildStackHint("elixir")).toContain("e.g. Codex, dispatch, or --agent mode");
  });

  test("TK-114: codex variant is byte-stable", () => {
    expect(buildStackHint("typescript", "codex")).toBe(buildStackHint("typescript", "codex"));
    expect(buildStackHint("elixir", "codex")).toBe(buildStackHint("elixir", "codex"));
  });

  test("TK-114: claude (default) and codex variants diverge on every stack", () => {
    for (const stack of ["elixir", "typescript", "rust"]) {
      expect(buildStackHint(stack, "claude")).not.toBe(buildStackHint(stack, "codex"));
    }
  });

  test("TK-114: pi harness uses claude-style wording (Pi runs Claude inside)", () => {
    // Pi is a Claude-flavored harness; identity should match the claude default.
    expect(buildStackHint("typescript", "pi")).toBe(buildStackHint("typescript", "claude"));
  });
});

// ---------------------------------------------------------------------------
// STACK_NAME_RE
// ---------------------------------------------------------------------------

describe("STACK_NAME_RE", () => {
  test("accepts valid names", () => {
    expect(STACK_NAME_RE.test("elixir")).toBe(true);
    expect(STACK_NAME_RE.test("typescript")).toBe(true);
    expect(STACK_NAME_RE.test("my-stack")).toBe(true);
    expect(STACK_NAME_RE.test("a1")).toBe(true);
  });

  test("rejects invalid names", () => {
    expect(STACK_NAME_RE.test("")).toBe(false);
    expect(STACK_NAME_RE.test("1bad")).toBe(false);
    expect(STACK_NAME_RE.test("-bad")).toBe(false);
    expect(STACK_NAME_RE.test("Bad")).toBe(false);
    expect(STACK_NAME_RE.test("no spaces")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Identity injection — verify assembleIdentity/assembleHeartbeatIdentity
// include the stack hint when a project has a detectable stack.
// ---------------------------------------------------------------------------

import { assembleIdentity, assembleHeartbeatIdentity } from "../lib/identity";

describe("identity stack hint injection", () => {
  let hiveHome: string;
  let fakeHome: string;
  let prevHiveHome: string | undefined;
  let prevHome: string;
  let prevCwd: string;

  beforeEach(async () => {
    hiveHome = await mkdtemp(join(tmpdir(), "hive-id-hint-"));
    fakeHome = await mkdtemp(join(tmpdir(), "hive-id-fakehome-"));
    prevHiveHome = process.env.HIVE_HOME;
    prevHome = process.env.HOME ?? homedir();
    prevCwd = process.cwd();
    process.env.HIVE_HOME = hiveHome;
    process.env.HOME = fakeHome;
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    if (prevHiveHome === undefined) delete process.env.HIVE_HOME;
    else process.env.HIVE_HOME = prevHiveHome;
    process.env.HOME = prevHome;
    await rm(hiveHome, { recursive: true, force: true });
    await rm(fakeHome, { recursive: true, force: true });
  });

  async function seedProject(projectId: string, projectPath: string) {
    const projDir = join(hiveHome, "projects", projectId);
    await mkdir(projDir, { recursive: true });
    await writeFile(
      join(projDir, "config.md"),
      `---\nname: ${projectId}\npath: ${projectPath}\n---\n`,
    );
  }

  test("assembleIdentity includes stack hint when project has mix.exs", async () => {
    // Create a fake project root with mix.exs
    const projRoot = join(fakeHome, "my-elixir-app");
    await mkdir(projRoot, { recursive: true });
    await writeFile(join(projRoot, "mix.exs"), "defmodule X do\nend\n");

    // Register the project in HIVE
    await seedProject("elx", projRoot);

    // cd into the project so resolveProjectFromCwd finds it
    process.chdir(projRoot);

    const output = await assembleIdentity();
    // Bound to the builder, not a copy of its wording — this test's property is
    // "the hint lands in the identity," which shouldn't break on a reword.
    expect(output).toContain(buildStackHint("elixir"));
  });

  test("assembleIdentity omits hint when no stack detected", async () => {
    const projRoot = join(fakeHome, "plain-app");
    await mkdir(projRoot, { recursive: true });

    await seedProject("plain", projRoot);
    process.chdir(projRoot);

    const output = await assembleIdentity();
    expect(output).not.toContain("Project stack:");
  });

  test("assembleHeartbeatIdentity includes hint when projectId given", async () => {
    const projRoot = join(fakeHome, "hb-elixir");
    await mkdir(projRoot, { recursive: true });
    await writeFile(join(projRoot, "mix.exs"), "");

    await seedProject("hb-elx", projRoot);

    const output = await assembleHeartbeatIdentity("hb-elx");
    expect(output).toContain(buildStackHint("elixir"));
  });

  test("assembleHeartbeatIdentity omits hint when no projectId", async () => {
    const output = await assembleHeartbeatIdentity();
    expect(output).not.toContain("Project stack:");
  });

  test("assembleHeartbeatIdentity respects 'none' binding", async () => {
    const projRoot = join(fakeHome, "hb-none");
    await mkdir(projRoot, { recursive: true });
    await writeFile(join(projRoot, "mix.exs"), "");

    await seedProject("hb-none", projRoot);
    await writeStackBinding("hb-none", "none");

    const output = await assembleHeartbeatIdentity("hb-none");
    expect(output).not.toContain("Project stack:");
  });
});

