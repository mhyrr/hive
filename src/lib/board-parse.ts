export function parseTaskStatus(task: string): string | null {
  const trimmed = task.trim();

  if (!trimmed.startsWith("- ")) {
    return null;
  }

  const pipeSegments = trimmed
    .slice(2)
    .split("|")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (pipeSegments.length >= 3) {
    return pipeSegments[2]!.toLowerCase();
  }

  const bracketStatuses = trimmed.match(/\[([^\]]+)\]/g)?.map((segment) =>
    segment.slice(1, -1).trim().toLowerCase(),
  );

  if (!bracketStatuses) {
    return null;
  }

  return (
    bracketStatuses.find((segment) =>
      ["active", "done", "queued", "waiting", "pending"].some(
        (status) => segment === status || segment.startsWith(`${status}-`),
      ),
    ) ?? null
  );
}

export function parseTaskId(task: string): string | null {
  const trimmed = task.trim().replace(/^- /, "");
  const match = trimmed.match(/^([A-Za-z0-9._-]+)\s*[:|]/);

  return match?.[1] ?? null;
}

export function isRealBlocker(line: string): boolean {
  return !/^-?\s*\(?none(?: yet)?\)?$/i.test(line.trim());
}
