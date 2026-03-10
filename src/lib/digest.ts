import { parseBoard } from "./board";
import { HiveMessage } from "./messages";
import { RunRecord } from "./runs";

export function digestBoard(boardText: string): string {
  const board = parseBoard(boardText);
  const taskCount = board.tasks.length;
  const activeCount = board.tasks.filter((t) => t.includes("[active]")).length;
  const doneCount = board.tasks.filter((t) => t.includes("[done]")).length;
  const waitingCount = board.tasks.filter(
    (t) => t.includes("[waiting") || t.includes("[queued]"),
  ).length;
  const blockerLines = board.blockers.filter(
    (b) => b.trim().length > 0 && !b.includes("(none)"),
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
