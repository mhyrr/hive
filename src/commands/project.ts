import { existsSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";

import { UsageError } from "../lib/errors";
import { ensureDirectory, ensureHiveScaffold, getHivePaths } from "../lib/paths";
import { normalizeProjectName, resolveProjectFromCwd } from "../lib/project";
import { ensureProjectMemoryFile } from "../lib/memory";
import { parseFrontmatter } from "../lib/frontmatter";
import {
  scanRepo,
  emitBootstrapCandidates,
  formatScanReport,
  inferConventions,
  formatInferenceReport,
} from "../lib/bootstrap";

export async function projectCommand(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (subcommand === "bootstrap") {
    return bootstrapCommand(args.slice(1));
  }

  if (subcommand === "add") {
    return addCommand(args.slice(1));
  }

  throw new UsageError(
    "Usage: hive project add <name> <path> [--bootstrap]\n       hive project bootstrap [<name>]",
  );
}

async function addCommand(args: string[]): Promise<void> {
  if (args.length < 2) {
    throw new UsageError("Usage: hive project add <name> <path> [--bootstrap]");
  }

  const rawName = args[0]!;
  const rawPath = args[1]!;
  const doBootstrap = args.includes("--bootstrap");
  const projectId = normalizeProjectName(rawName);
  const repoPath = resolve(rawPath);

  if (!existsSync(repoPath)) {
    throw new UsageError(`Path does not exist: ${repoPath}`);
  }

  const paths = await ensureHiveScaffold();

  // Create project directory and config
  const projectDir = join(paths.projectsDir, projectId);
  await ensureDirectory(projectDir);
  await Bun.write(
    join(projectDir, "config.md"),
    `---\nname: ${projectId}\npath: ${repoPath}\n---\n`,
  );

  // Create memory file
  await ensureProjectMemoryFile(paths, projectId);

  // Write HEARTBEAT.md from template if missing
  const heartbeatPath = join(projectDir, "HEARTBEAT.md");
  if (!existsSync(heartbeatPath)) {
    const templatePath = join(dirname(import.meta.dir), "..", "templates", "heartbeat", "HEARTBEAT.md");
    let content = await Bun.file(templatePath).text();
    content = content.replaceAll("{{projectName}}", projectId);
    await Bun.write(heartbeatPath, content);
  }

  const { getIdentityName } = await import("../lib/identity");
  const name = getIdentityName();
  console.log(`Project '${projectId}' registered at ${repoPath}`);
  console.log(`Memory: ~/.hive/memory/projects/${projectId}/knowledge.md`);
  console.log(`Heartbeat: ~/.hive/projects/${projectId}/HEARTBEAT.md`);
  console.log();
  console.log(`Use \`hive\` from ${repoPath} to start a ${name} session with project context.`);

  if (doBootstrap) {
    const doInfer = args.includes("--infer");
    console.log();
    await runBootstrap(projectId, repoPath, { infer: doInfer });
  }
}

async function bootstrapCommand(args: string[]): Promise<void> {
  const doInfer = args.includes("--infer");
  const dryRun = args.includes("--dry-run");
  const positionalArgs = args.filter(a => !a.startsWith("--"));

  // Resolve project: explicit name or from CWD
  let projectId = positionalArgs[0] || null;
  let repoPath: string | null = null;

  if (!projectId) {
    projectId = resolveProjectFromCwd();
    if (!projectId) {
      throw new UsageError(
        "Could not detect project from current directory.\n" +
        "Run from a registered project directory, or specify: hive project bootstrap <name>",
      );
    }
  }

  // Look up the repo path from the project config
  const paths = getHivePaths();
  const configPath = join(paths.projectsDir, projectId, "config.md");
  if (!existsSync(configPath)) {
    throw new UsageError(
      `Project '${projectId}' is not registered. Run: hive project add ${projectId} <path>`,
    );
  }

  const configContent = readFileSync(configPath, "utf-8");
  const parsed = parseFrontmatter(configContent);
  repoPath = (parsed.attributes?.path as string) ?? null;

  if (!repoPath || !existsSync(repoPath)) {
    throw new UsageError(
      `Project '${projectId}' has no valid repo path. Re-register with: hive project add ${projectId} <path>`,
    );
  }

  await runBootstrap(projectId, repoPath, { infer: doInfer, dryRun });
}

async function runBootstrap(
  projectId: string,
  repoPath: string,
  options: { infer?: boolean; dryRun?: boolean } = {},
): Promise<void> {
  const startTime = Date.now();

  console.log(`Scanning ${repoPath}...`);
  const scan = scanRepo(repoPath);
  const scanMs = Date.now() - startTime;

  // Print scan report
  console.log();
  console.log(formatScanReport(scan));
  console.log();

  // Emit mechanical scan candidates
  const paths = await ensureHiveScaffold();
  const result = await emitBootstrapCandidates(paths, projectId, scan);
  const totalMs = Date.now() - startTime;

  if (result.written > 0) {
    console.log(`Wrote ${result.written} candidate(s) to candidates.md (${result.skipped} skipped as duplicates).`);
    console.log(`These will be reviewed by the nightly verifier (Pass V) for admission to knowledge.md.`);
  } else if (result.skipped > 0) {
    console.log(`All ${result.skipped} facts already exist — nothing new to write.`);
  } else {
    console.log("No facts could be derived from this repo.");
  }

  console.log(`Mechanical scan done in ${totalMs}ms (scan: ${scanMs}ms).`);

  // Phase 2: LLM inference (opt-in)
  if (options.infer) {
    console.log();
    console.log("Running inference pass (single LLM call)...");

    const inferResult = await inferConventions(repoPath, scan, paths, projectId, {
      dryRun: options.dryRun,
    });

    console.log();
    console.log(formatInferenceReport(inferResult.inference, inferResult));
  }
}
