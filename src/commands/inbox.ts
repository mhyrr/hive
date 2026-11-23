import { ensureHiveScaffold, getProjectPaths } from "../lib/paths";
import { UsageError } from "../lib/errors";
import { resolveProjectFromCwd } from "../lib/project";
import { emptyInbox, parseInbox } from "../lib/inbox";
import { rescueInboxCandidates } from "../lib/identity-candidates";

export async function inboxCommand(args: string[]): Promise<void> {
  const usage = `Usage:
  hive inbox                    Show inbox for current project
  hive inbox clear              Clear inbox after review
  hive inbox --project <name>   Specify project`;

  const paths = await ensureHiveScaffold();
  let projectId: string | null = null;
  let subcommand: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--project" || arg === "-p") {
      projectId = args[++i] ?? "";
    } else {
      subcommand = arg;
    }
  }

  projectId ??= resolveProjectFromCwd();
  if (!projectId) {
    throw new UsageError("No project found. Register one with: hive project add <name> <path>");
  }

  const pp = getProjectPaths(paths, projectId);
  const file = Bun.file(pp.inbox);

  if (subcommand === "clear") {
    // TK-157: identity candidates wait for Greg's answer, so a clear moves
    // them to the pending store instead of dropping them.
    let rescued = 0;
    if (await file.exists()) {
      const parsed = parseInbox(await file.text(), projectId);
      rescued = (await rescueInboxCandidates(paths, projectId, parsed.body)).rescued;
    }
    await Bun.write(pp.inbox, emptyInbox(projectId));
    console.log(`Inbox cleared for ${projectId}.`);
    if (rescued > 0) {
      console.log(`${rescued} identity candidate(s) kept as pending. See: hive identity candidates`);
    }
    return;
  }

  if (subcommand && subcommand !== "show") {
    throw new UsageError(`Unknown subcommand: ${subcommand}\n\n${usage}`);
  }

  if (!(await file.exists())) {
    console.log(`No inbox for ${projectId}.`);
    return;
  }

  const content = await file.text();
  const parsed = parseInbox(content, projectId);
  if (parsed.kind === "empty") {
    console.log(`Inbox empty for ${projectId}.`);
    return;
  }

  console.log(parsed.body);
}
