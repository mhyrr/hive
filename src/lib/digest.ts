import { parseBoard } from "./board";
import { HiveMessage } from "./messages";
import { RunRecord } from "./runs";

function parseTaskStatus(task: string): string | null {
  const trimmed = task.trim();

  if (!trimmed.startsWith("- ")) {
    return null;
  }

  const pipeSegments = trimmed
    .slice(2)
    .split("|")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (pipeSegments.length >= 3) {
    return pipeSegments[2].toLowerCase();
  }

  const legacyMatch = trimmed.match(/\[([^\]]+)\]/g)?.map((segment) =>
    segment.slice(1, -1).trim().toLowerCase(),
  );

  if (!legacyMatch) {
    return null;
  }

  return legacyMatch.find((segment) =>
    ["active", "done", "queued", "waiting", "pending"].some(
      (status) => segment === status || segment.startsWith(`${status}-`),
    ),
  ) ?? null;
}

function isRealBlocker(line: string): boolean {
  return !/^-?\s*\(?none(?: yet)?\)?$/i.test(line.trim());
}

export function digestBoard(boardText: string): string {
  const board = parseBoard(boardText);
  const taskCount = board.tasks.length;
  const statuses = board.tasks.map((task) => parseTaskStatus(task));
  const activeCount = statuses.filter((status) => status === "active").length;
  const doneCount = statuses.filter((status) => status === "done").length;
  const waitingCount = statuses.filter((status) =>
    status === "pending" ||
    status === "queued" ||
    status === "waiting" ||
    status?.startsWith("waiting-"),
  ).length;
  const blockerLines = board.blockers.filter(
    (blocker) => blocker.trim().length > 0 && isRealBlocker(blocker),
  );

  const lines: string[] = [
    `${taskCount} tasks: ${activeCount} active, ${doneCount} done, ${waitingCount} waiting/queued`,
  ];

  if (board.agents.length > 0) {
    for (const agent of board.agents) {
      lines.push(`  ${agent.id}: ${agent.fields.status ?? "unknown"}`);
    }
  }

  if (blockerLines.length > 0) {
    lines.push(`Blockers: ${blockerLines.length}`);

    for (const b of blockerLines) {
      lines.push(`  ${b.trim()}`);
    }
  }

  return lines.join("\n");
}

export function digestMessages(messages: HiveMessage[]): string {
  if (messages.length === 0) {
    return "(none)";
  }

  return messages
    .map((m) => {
      const firstLine = m.body.split("\n")[0] ?? "";
      return `- [${m.attributes.type ?? "msg"}] ${m.attributes.from ?? "?"} -> ${m.attributes.to ?? "?"}: ${firstLine}`;
    })
    .join("\n");
}

export function digestRuns(runs: RunRecord[]): string {
  if (runs.length === 0) {
    return "(none)";
  }

  return runs
    .map((run) => {
      const time = run.started?.slice(11, 16) ?? "?";
      return `- ${run.agentId}: ${run.status} since ${time} (${run.runtime}${run.model ? `, ${run.model}` : ""})`;
    })
    .join("\n");
}

export function listSkills(skillsDir: string, skillNames: string[]): string {
  if (skillNames.length === 0) {
    return "(none)";
  }

  return skillNames
    .map((name) => `- ${name} (${skillsDir}/${name}.md)`)
    .join("\n");
}
