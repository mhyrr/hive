import { UsageError } from "../lib/errors";
import { appendFeedEntry } from "../lib/feed";
import {
  closeMessage,
  createMessage,
  findMessage,
  resolveMessage,
} from "../lib/messages";
import { ensureHiveScaffold, getActiveProject } from "../lib/paths";

function parseMsgArgs(args: string[]): {
  type: string;
  from: string;
  to: string;
  body: string;
  attributes: Record<string, string>;
} {
  let type = "notify";
  const attributes: Record<string, string> = {};
  let cursor = 0;

  while (cursor < args.length && args[cursor]?.startsWith("--")) {
    const flag = args[cursor];
    const value = args[cursor + 1];

    if (!value) {
      throw new UsageError(
        "Usage: hive msg [--type <type>] [--task <task>] [--scope <scope>] [--launch <auto|manual>] <from> <to> <body>",
      );
    }

    if (flag === "--type") {
      type = value;
    } else if (flag === "--task") {
      attributes.task = value;
    } else if (flag === "--scope") {
      attributes.scope = value;
    } else if (flag === "--launch") {
      attributes.launch = value;
    } else {
      throw new UsageError(
        "Usage: hive msg [--type <type>] [--task <task>] [--scope <scope>] [--launch <auto|manual>] <from> <to> <body>",
      );
    }

    cursor += 2;
  }

  const from = args[cursor];
  const to = args[cursor + 1];
  const body = args.slice(cursor + 2).join(" ").trim();

  if (!from || !to || !body) {
    throw new UsageError(
      "Usage: hive msg [--type <type>] [--task <task>] [--scope <scope>] [--launch <auto|manual>] <from> <to> <body>",
    );
  }

  return { type, from, to, body, attributes };
}

export async function msgCommand(args: string[]): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "nudge": {
      const body = rest.join(" ").trim();

      if (!body) {
        throw new UsageError("Usage: hive msg nudge <message>");
      }

      const message = await createMessage(paths.msgDir, {
        from: "human",
        to: "steward",
        type: "nudge",
        project: activeProject,
        body,
      });
      await appendFeedEntry(paths, {
        project: activeProject,
        headline: `Human nudge`,
        details: [body.split("\n")[0]],
      });

      return `Created nudge ${message.filename}`;
    }
    case "show": {
      const reference = rest[0];

      if (!reference) {
        throw new UsageError("Usage: hive msg show <message>");
      }

      const message = await findMessage(paths.msgDir, reference, activeProject);

      if (!message) {
        throw new UsageError(`Unknown message: ${reference}`);
      }

      return message.raw;
    }
    case "resolve": {
      const [reference, actor, ...answerParts] = rest;
      const answer = answerParts.join(" ").trim();

      if (!reference || !actor || !answer) {
        throw new UsageError("Usage: hive msg resolve <message> <actor> <answer>");
      }

      const message = await resolveMessage(
        paths.msgDir,
        reference,
        actor,
        answer,
        activeProject,
      );

      if (!message) {
        throw new UsageError(`Unknown message: ${reference}`);
      }

      await appendFeedEntry(paths, {
        project: activeProject,
        headline: `Resolved message ${message.filename}`,
        details: [`actor: ${actor}`],
      });

      return `Resolved ${message.filename}`;
    }
    case "close": {
      const [reference, actor, ...noteParts] = rest;
      const note = noteParts.join(" ").trim();

      if (!reference || !actor) {
        throw new UsageError("Usage: hive msg close <message> <actor> [note]");
      }

      const message = await closeMessage(paths.msgDir, reference, actor, note, activeProject);

      if (!message) {
        throw new UsageError(`Unknown message: ${reference}`);
      }

      await appendFeedEntry(paths, {
        project: activeProject,
        headline: `Closed message ${message.filename}`,
        details: [`actor: ${actor}`],
      });

      return `Closed ${message.filename}`;
    }
    default:
      break;
  }

  const input = parseMsgArgs(args);
  const message = await createMessage(paths.msgDir, {
    ...input,
    project: activeProject,
  });
  const shouldFeed = new Set(["assign", "question", "nudge", "escalate", "handoff"]).has(
    input.type,
  );

  if (shouldFeed) {
    await appendFeedEntry(paths, {
      project: activeProject,
      headline: `${input.type}: ${input.from} -> ${input.to}`,
      details: [message.body.split("\n")[0]],
    });
  }

  return `Created ${input.type} message ${message.filename}`;
}

