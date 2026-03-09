import { UsageError } from "../lib/errors";
import { createMessage } from "../lib/messages";
import { ensureHiveScaffold, getActiveProject } from "../lib/paths";

function parseMsgArgs(args: string[]): {
  type: string;
  from: string;
  to: string;
  body: string;
} {
  let type = "notify";
  let cursor = 0;

  if (args[0] === "--type") {
    if (!args[1]) {
      throw new UsageError("Usage: hive msg [--type <type>] <from> <to> <body>");
    }

    type = args[1];
    cursor = 2;
  }

  const from = args[cursor];
  const to = args[cursor + 1];
  const body = args.slice(cursor + 2).join(" ").trim();

  if (!from || !to || !body) {
    throw new UsageError("Usage: hive msg [--type <type>] <from> <to> <body>");
  }

  return { type, from, to, body };
}

export async function msgCommand(args: string[]): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const input = parseMsgArgs(args);
  const message = await createMessage(paths.msgDir, {
    ...input,
    project: activeProject,
  });

  return `Created ${input.type} message ${message.filename}`;
}

export async function nudgeCommand(args: string[]): Promise<string> {
  const body = args.join(" ").trim();

  if (!body) {
    throw new UsageError("Usage: hive nudge <message>");
  }

  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const message = await createMessage(paths.msgDir, {
    from: "human",
    to: "orchestrator",
    type: "nudge",
    project: activeProject,
    body,
  });

  return `Created nudge ${message.filename}`;
}
