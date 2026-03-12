import { UsageError } from "../lib/errors";
import { appendEvent, formatEventList, listRecentEvents, type EventScope, type EventSeverity } from "../lib/events";
import { appendFeedEntry } from "../lib/feed";
import { createMessage } from "../lib/messages";
import { ensureHiveScaffold, getActiveProject } from "../lib/paths";

function parseLimit(input: string | undefined): number {
  if (!input) {
    return 20;
  }

  const value = Number(input);

  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError("Usage: hive events [count] [--scope internal|external]");
  }

  return value;
}

function parseScope(input: string | undefined): EventScope {
  if (input === "internal" || input === "external") {
    return input;
  }

  throw new UsageError("Usage: hive events [count] [--scope internal|external]");
}

function parseSeverity(input: string | undefined): EventSeverity {
  if (input === "info" || input === "warning" || input === "error") {
    return input;
  }

  throw new UsageError(
    "Usage: hive events record <internal|external> <kind> [--source <source>] [--project <project>] [--severity info|warning|error] [--detail <text>] [--route] <summary>",
  );
}

function parseRecordArgs(args: string[]): {
  scope: EventScope;
  kind: string;
  source: string;
  project: string | null;
  severity: EventSeverity;
  details: string[];
  route: boolean;
  summary: string;
} {
  const scope = parseScope(args[0]);
  const kind = args[1]?.trim();

  if (!kind) {
    throw new UsageError(
      "Usage: hive events record <internal|external> <kind> [--source <source>] [--project <project>] [--severity info|warning|error] [--detail <text>] [--route] <summary>",
    );
  }

  let source = "manual";
  let project: string | null = null;
  let severity: EventSeverity = "info";
  const details: string[] = [];
  let route = false;
  const summaryParts: string[] = [];

  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--source") {
      source = args[index + 1]?.trim() || "";
      index += 1;
      continue;
    }

    if (arg === "--project") {
      project = args[index + 1]?.trim() || null;
      index += 1;
      continue;
    }

    if (arg === "--severity") {
      severity = parseSeverity(args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === "--detail") {
      const detail = args[index + 1]?.trim();

      if (!detail) {
        throw new UsageError(
          "Usage: hive events record <internal|external> <kind> [--source <source>] [--project <project>] [--severity info|warning|error] [--detail <text>] [--route] <summary>",
        );
      }

      details.push(detail);
      index += 1;
      continue;
    }

    if (arg === "--route") {
      route = true;
      continue;
    }

    summaryParts.push(arg);
  }

  const summary = summaryParts.join(" ").trim();

  if (!summary || !source) {
    throw new UsageError(
      "Usage: hive events record <internal|external> <kind> [--source <source>] [--project <project>] [--severity info|warning|error] [--detail <text>] [--route] <summary>",
    );
  }

  return {
    scope,
    kind,
    source,
    project,
    severity,
    details,
    route,
    summary,
  };
}

export async function eventsCommand(args: string[]): Promise<string> {
  if (args[0] === "record") {
    const paths = await ensureHiveScaffold();
    const activeProject = await getActiveProject(paths);
    const parsed = parseRecordArgs(args.slice(1));
    const project = parsed.project ?? activeProject;
    const event = await appendEvent({
      paths,
      scope: parsed.scope,
      kind: parsed.kind,
      source: parsed.source,
      project,
      severity: parsed.severity,
      summary: parsed.summary,
      details: parsed.details,
      data: {
        routed: parsed.route,
      },
    });

    if (parsed.scope === "external" || parsed.severity !== "info") {
      await appendFeedEntry(paths, {
        project,
        headline: `${parsed.scope === "external" ? "External" : "Internal"} event: ${event.kind}`,
        details: [
          `source: ${parsed.source}`,
          `severity: ${parsed.severity}`,
          parsed.summary,
        ],
      });
    }

    let routedMessage = "";

    if (parsed.route) {
      if (!project) {
        throw new UsageError("Routing an event requires a project. Set one with `hive work <project>` or pass `--project`.");
      }

      const message = await createMessage(paths.msgDir, {
        from: parsed.source,
        to: "orchestrator",
        type: parsed.severity === "error" ? "escalate" : "notify",
        project,
        body: [
          `event: ${event.kind}`,
          `severity: ${parsed.severity}`,
          `summary: ${parsed.summary}`,
          ...parsed.details.map((detail) => `detail: ${detail}`),
        ].join("\n"),
      });

      await appendFeedEntry(paths, {
        project,
        headline: `Event routed: ${event.kind}`,
        details: [`message: ${message.filename}`],
      });
      await appendEvent({
        paths,
        kind: "event.routed",
        source: "events",
        project,
        summary: parsed.summary,
        details: [
          `event: ${event.kind}`,
          `message: ${message.filename}`,
        ],
        data: {
          eventId: event.id,
          message: message.filename,
        },
      });

      routedMessage = `\nMessage: ${message.filename}`;
    }

    return `Recorded ${parsed.scope} event ${event.id}
Kind: ${event.kind}
Source: ${event.source}
Severity: ${event.severity}
Project: ${event.project ?? "(none)"}${routedMessage}`;
  }

  let scope: EventScope | "all" = "all";
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--scope") {
      scope = parseScope(args[index + 1]);
      index += 1;
      continue;
    }

    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new UsageError("Usage: hive events [count] [--scope internal|external]");
  }

  const paths = await ensureHiveScaffold();
  const limit = parseLimit(positional[0]);
  const events = await listRecentEvents({ paths, scope, limit });

  return formatEventList(events, scope);
}
