import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assembleIdentity, assembleHeartbeatIdentity } from "../lib/identity";

// ---------------------------------------------------------------------------
// Fixture: a self-contained ~/.hive scaffold + project so assembleIdentity
// has something to work with.
// ---------------------------------------------------------------------------

let tempHive: string;
let tempCwd: string;
let originalHiveHome: string | undefined;
let originalCwd: string;

async function seedHive(hiveDir: string, projectId: string, projectPath: string): Promise<void> {
  await mkdir(hiveDir, { recursive: true });

  // Soul stack — minimal but distinguishable per file
  await writeFile(join(hiveDir, "SOUL.md"), "# soul-marker\n");
  await writeFile(join(hiveDir, "IDENTITY.md"), "# identity-marker\n- Name: TestMaya\n");
  await writeFile(join(hiveDir, "SELF.md"), "# self-marker\n");
  await writeFile(join(hiveDir, "AGENTS.md"), "# agents-marker\n");
  await writeFile(join(hiveDir, "TRUST.md"), "# trust-marker\n");

  // Project registration
  const projDir = join(hiveDir, "projects", projectId);
  await mkdir(projDir, { recursive: true });
  await writeFile(join(projDir, "config.md"), `---\nname: ${projectId}\npath: ${projectPath}\n---\n`);

  // Project memory index
  const memDir = join(hiveDir, "memory", "projects", projectId);
  await mkdir(memDir, { recursive: true });
  await writeFile(join(memDir, "_index.md"), "# project-memory-marker\n");

  // Taste layer — principles.md is the only artifact in V1.
  const tasteDir = join(hiveDir, "taste");
  await mkdir(tasteDir, { recursive: true });
  await writeFile(join(tasteDir, "principles.md"), "# taste-principles-marker\n");

  // Swappable persona register (default: greg-dry).
  const personasDir = join(hiveDir, "personas");
  await mkdir(personasDir, { recursive: true });
  await writeFile(join(personasDir, "greg-dry.md"), "# persona-greg-dry-marker\n");
  await writeFile(join(personasDir, "skeptic.md"), "# persona-skeptic-marker\n");
}

beforeEach(async () => {
  tempHive = await mkdtemp(join(tmpdir(), "hive-identity-test-hive-"));
  tempCwd = await mkdtemp(join(tmpdir(), "hive-identity-test-proj-"));
  originalHiveHome = process.env.HIVE_HOME;
  originalCwd = process.cwd();
  process.env.HIVE_HOME = tempHive;
  await seedHive(tempHive, "testproj", tempCwd);
  process.chdir(tempCwd);
});

afterEach(async () => {
  process.chdir(originalCwd);
  if (originalHiveHome) process.env.HIVE_HOME = originalHiveHome;
  else delete process.env.HIVE_HOME;
  await rm(tempHive, { recursive: true, force: true });
  await rm(tempCwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// assembleIdentity — section presence + ordering
// ---------------------------------------------------------------------------

describe("assembleIdentity", () => {
  test("emits all four sections in canonical order", async () => {
    const out = await assembleIdentity();

    const markers = [
      "soul-marker",
      "identity-marker",
      "self-marker",
      "agents-marker",
      "trust-marker",
      "project-memory-marker",
      "taste-principles-marker",
    ];
    const positions = markers.map((m) => out.indexOf(m));
    for (const [i, m] of markers.entries()) {
      expect(positions[i], `section "${m}" should be present`).toBeGreaterThan(-1);
    }
    for (let i = 1; i < positions.length; i++) {
      expect(
        positions[i]!,
        `"${markers[i]}" should come after "${markers[i - 1]}"`,
      ).toBeGreaterThan(positions[i - 1]!);
    }
  });

  test("taste layer is the LAST section (loudest in system prompt)", async () => {
    const out = await assembleIdentity();
    const tasteIdx = out.indexOf("taste-principles-marker");
    // Nothing of substance after taste — only trailing whitespace allowed.
    const tail = out.slice(tasteIdx + "taste-principles-marker".length);
    expect(tail.trim()).toBe("");
  });

  test("loads only principles.md — no per-domain applications layer in V1", async () => {
    const out = await assembleIdentity();
    expect(out).toContain("taste-principles-marker");
  });

  test("persona slot is absent unless includePersona (dispatch/heartbeat stay neutral)", async () => {
    const out = await assembleIdentity();
    expect(out).not.toContain("persona-greg-dry-marker");
  });

  test("includePersona inserts the default register between IDENTITY and SELF", async () => {
    const out = await assembleIdentity({ includePersona: true });
    expect(out).toContain("persona-greg-dry-marker");
    const idIdx = out.indexOf("identity-marker");
    const personaIdx = out.indexOf("persona-greg-dry-marker");
    const selfIdx = out.indexOf("self-marker");
    expect(personaIdx).toBeGreaterThan(idIdx);
    expect(selfIdx).toBeGreaterThan(personaIdx);
  });

  test("explicit persona name overrides the default", async () => {
    const out = await assembleIdentity({ includePersona: true, persona: "skeptic" });
    expect(out).toContain("persona-skeptic-marker");
    expect(out).not.toContain("persona-greg-dry-marker");
  });

  test("unknown persona falls back to the default register", async () => {
    const out = await assembleIdentity({ includePersona: true, persona: "does-not-exist" });
    expect(out).toContain("persona-greg-dry-marker");
  });
});

// ---------------------------------------------------------------------------
// assembleHeartbeatIdentity — cache stability invariant (TK-024)
// ---------------------------------------------------------------------------

describe("assembleHeartbeatIdentity", () => {
  test("skips project memory for cache stability", async () => {
    const out = await assembleHeartbeatIdentity("testproj");
    expect(out).not.toContain("project-memory-marker");
    // Soul + taste still present
    expect(out).toContain("soul-marker");
    expect(out).toContain("taste-principles-marker");
  });

  test("byte-stable across invocations for the same project", async () => {
    const a = await assembleHeartbeatIdentity("testproj");
    const b = await assembleHeartbeatIdentity("testproj");
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Drift guard: the SessionStart hook (template) must produce byte-identical
// output to assembleIdentity(). This is the test that prevents the bash and
// TypeScript paths from drifting again — break this test if you change either.
// ---------------------------------------------------------------------------

describe("hook ↔ assembleIdentity parity", () => {
  test("template hook output equals assembleIdentity() output", async () => {
    const repoRoot = join(import.meta.dir, "..", "..");
    const hookPath = join(repoRoot, "templates", "hooks", "load-identity.sh");
    const hiveBin = join(repoRoot, "hive-bin");

    if (!existsSync(hiveBin)) {
      console.warn("hive-bin not found; skipping parity test. Run: bun build src/cli.ts --compile --outfile hive-bin");
      return;
    }

    // The hook resolves `hive` via PATH lookup. Point PATH at a tempdir
    // containing only our just-built binary so we know exactly which one runs.
    const binDir = await mkdtemp(join(tmpdir(), "hive-identity-test-bin-"));
    const { symlinkSync } = await import("node:fs");
    try {
      symlinkSync(hiveBin, join(binDir, "hive"));
    } catch { /* already linked */ }

    try {
      const hookResult = spawnSync("bash", [hookPath], {
        cwd: tempCwd,
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}`, HIVE_HOME: tempHive },
        encoding: "utf-8",
      });
      expect(hookResult.status).toBe(0);

      // The hook runs `hive identity emit`, an interactive path that includes
      // the persona slot — compare against the same.
      const direct = await assembleIdentity({ includePersona: true });
      expect(hookResult.stdout).toBe(direct);
    } finally {
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test("live ~/.claude/hooks/load-identity.sh matches the template", async () => {
    const realHome = process.env.HOME;
    if (!realHome) return;

    const livePath = join(realHome, ".claude", "hooks", "load-identity.sh");
    const repoRoot = join(import.meta.dir, "..", "..");
    const templatePath = join(repoRoot, "templates", "hooks", "load-identity.sh");

    if (!existsSync(livePath) || !existsSync(templatePath)) return;

    const liveContent = await readFile(livePath, "utf-8");
    const templateContent = await readFile(templatePath, "utf-8");
    expect(liveContent).toBe(templateContent);
  });

  test("on-disk template byte-equals embedded LOAD_IDENTITY_HOOK constant", async () => {
    const repoRoot = join(import.meta.dir, "..", "..");
    const templatePath = join(repoRoot, "templates", "hooks", "load-identity.sh");
    const { LOAD_IDENTITY_HOOK } = await import("../lib/identity-hook-template");
    const diskContent = await readFile(templatePath, "utf-8");
    expect(diskContent).toBe(LOAD_IDENTITY_HOOK);
  });
});
