import { UsageError } from "../lib/errors";
import { formatEventList, listRecentEvents, type EventScope } from "../lib/events";
import { ensureHiveScaffold } from "../lib/paths";

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

export async function eventsCommand(args: string[]): Promise<string> {
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
