import { UsageError } from "../lib/errors";
import {
  buildStackHint,
  clearStackBinding,
  initStack,
  installStack,
  listCannedStacks,
  listSourceSkills,
  listSourceStacks,
  listSyncedSkills,
  readStackBinding,
  resolveProjectStack,
  stackSourceDir,
  STACK_NAME_RE,
  syncStack,
  writeStackBinding,
} from "../lib/stack";

const USAGE = `Usage:
  hive stack list                  List installed + canned stacks
  hive stack install <name>        Install a canned stack template to ~/.hive/stacks/
    --force                        Overwrite existing installation
  hive stack sync <name>           Copy stack skills into ~/.claude/skills/<name>-*
  hive stack init <name>           Scaffold an empty stack source tree
  hive stack bind <project> <stack>  Bind a project to a stack
    <stack> = stack name | "auto" | "clear" | "unbind" | "none"`;

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function runList(): Promise<void> {
  const installed = await listSourceStacks();
  const canned = await listCannedStacks();
  const installedSet = new Set(installed);
  const notInstalled = canned.filter((name) => !installedSet.has(name));

  if (installed.length === 0 && canned.length === 0) {
    console.log("No stacks available. (This HIVE build ships no canned templates.)");
    return;
  }

  if (installed.length > 0) {
    console.log("Installed:");
    for (const stack of installed) {
      const source = await listSourceSkills(stack);
      const synced = await listSyncedSkills(stack);
      let status: string;
      if (source.length === 0) status = "empty";
      else if (synced.length === 0) status = "not synced";
      else if (arraysEqual(source, synced)) status = "synced";
      else status = "drift";

      const cannedTag = canned.includes(stack) ? " [canned]" : "";
      console.log(`  ${stack}  (${source.length} skills, ${status})${cannedTag}`);
      console.log(`    source: ${stackSourceDir(stack)}`);
      if (source.length > 0) {
        console.log(`    skills: ${source.join(", ")}`);
      }
    }
  }

  if (notInstalled.length > 0) {
    if (installed.length > 0) console.log();
    console.log("Canned templates (not installed):");
    for (const stack of notInstalled) {
      console.log(`  ${stack}  →  hive stack install ${stack}`);
    }
  }
}

async function runInstall(args: string[]): Promise<void> {
  let force = false;
  let name: string | undefined;

  for (const arg of args) {
    if (arg === "--force" || arg === "-f") force = true;
    else if (!name) name = arg;
    else throw new UsageError(`Unexpected argument: ${arg}`);
  }

  if (!name) throw new UsageError("Usage: hive stack install <name> [--force]");

  const result = await installStack(name, { force });
  const verb = result.overwrote ? "Reinstalled" : "Installed";
  console.log(`${verb} stack '${name}' at ${result.target}`);
  console.log(`  from: ${result.source}`);
  console.log(`Next:   hive stack sync ${name}`);
}

async function runInit(name: string | undefined): Promise<void> {
  if (!name) throw new UsageError("Usage: hive stack init <name>");
  const target = await initStack(name);
  console.log(`Initialized stack '${name}' at ${target}`);
  console.log(`Add skills under skills/<topic>/SKILL.md, then run: hive stack sync ${name}`);
}

async function runSync(name: string | undefined): Promise<void> {
  if (!name) throw new UsageError("Usage: hive stack sync <name>");
  const result = await syncStack(name);

  console.log(`Synced stack '${name}' → ${result.target}`);
  if (result.copied.length > 0) {
    console.log(`  copied: ${result.copied.join(", ")}`);
  }
  if (result.removed.length > 0) {
    console.log(`  removed (orphans): ${result.removed.join(", ")}`);
  }
  if (result.copied.length === 0 && result.removed.length === 0) {
    console.log("  (no skills in source)");
  }
  console.log("Skills take effect on next Claude Code session.");
}

async function runBind(args: string[]): Promise<void> {
  const project = args[0];
  const stack = args[1];

  if (!project || !stack) {
    throw new UsageError("Usage: hive stack bind <project> <stack>\n  <stack> = stack name | auto | clear | unbind | none");
  }

  // "auto", "clear", "unbind" → remove the binding file (revert to auto-detect)
  if (stack === "auto" || stack === "clear" || stack === "unbind") {
    await clearStackBinding(project);
    const detected = resolveProjectStack(project);
    if (detected) {
      console.log(`Cleared stack binding for '${project}'. Auto-detected: ${detected}`);
    } else {
      console.log(`Cleared stack binding for '${project}'. No stack auto-detected.`);
    }
    return;
  }

  // "none" → write opt-out marker
  if (stack === "none") {
    await writeStackBinding(project, "none");
    console.log(`Stack disabled for '${project}'. No stack skills will be hinted.`);
    return;
  }

  // Validate stack name
  if (!STACK_NAME_RE.test(stack)) {
    throw new UsageError(
      `Invalid stack name '${stack}'. Use lowercase letters, digits, and hyphens; start with a letter.`,
    );
  }

  await writeStackBinding(project, stack);
  console.log(`Bound project '${project}' to stack '${stack}'.`);
  // Preview uses the same builder as the session-start injection so the
  // echoed text can't drift from what actually lands in the prompt.
  console.log(`Session hint: "${buildStackHint(stack)}"`);
}

export async function stackCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub) throw new UsageError(USAGE);

  switch (sub) {
    case "list":
      await runList();
      return;
    case "install":
      await runInstall(args.slice(1));
      return;
    case "init":
      await runInit(args[1]);
      return;
    case "sync":
      await runSync(args[1]);
      return;
    case "bind":
      await runBind(args.slice(1));
      return;
    default:
      throw new UsageError(`Unknown subcommand: ${sub}\n\n${USAGE}`);
  }
}
