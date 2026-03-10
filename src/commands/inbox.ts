import { UsageError } from "../lib/errors";
import { listOpenProjectMessages } from "../lib/messages";
import { ensureHiveScaffold, getActiveProject } from "../lib/paths";

function formatInbox(messages: Awaited<ReturnType<typeof listOpenProjectMessages>>): string {
  if (messages.length === 0) {
    return "No open messages.";
  }

  return messages
    .map((message) => {
      const preview = message.body.split("\n")[0];

      return [
        `- ${message.filename}`,
        `  ${message.attributes.type ?? "notify"} | ${message.attributes.from ?? "?"} -> ${message.attributes.to ?? "?"} | ${message.attributes.ts ?? ""}`,
        `  ${preview}`,
      ].join("\n");
    })
    .join("\n\n");
}

export async function inboxCommand(args: string[]): Promise<string> {
  const agentId = args[0] ?? null;
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const messages = (await listOpenProjectMessages(paths.msgDir, activeProject)).filter(
    (message) => !agentId || message.attributes.to === agentId,
  );

  return [
    `Project: ${activeProject}`,
    agentId ? `Inbox: ${agentId}` : "Inbox: all open project messages",
    formatInbox(messages),
  ].join("\n\n");
}
