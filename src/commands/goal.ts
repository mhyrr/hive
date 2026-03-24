import { bold, section } from "../lib/format";
import {
  appendEvidence,
  createGoal,
  listGoals,
  readGoal,
  updateGoalStatus,
  type GoalStatus,
} from "../lib/goals";
import { UsageError } from "../lib/errors";
import { ensureHiveScaffold, getActiveProject, getProjectPaths } from "../lib/paths";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export async function goalCommand(args: string[]): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const goalsDir = projectPaths.goalsDir;
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "add": {
      const description = rest.join(" ");
      if (!description) throw new UsageError("Usage: hive goal add <description>");
      const goal = await createGoal(goalsDir, description);
      return `Created goal ${goal.id}`;
    }

    case "list": {
      const goals = await listGoals(goalsDir);
      if (goals.length === 0) return "No goals.";
      const rows = goals.map((g) => `${g.id}  [${g.status}]  ${truncate(g.description, 60)}`);
      return section("Goals", rows.join("\n"));
    }

    case "update": {
      const [id, status] = rest;
      if (!id || !status)
        throw new UsageError(
          "Usage: hive goal update <id> <active|resolved|stuck|needs-human>",
        );
      const validStatuses: GoalStatus[] = ["active", "resolved", "stuck", "needs-human"];
      if (!validStatuses.includes(status as GoalStatus)) {
        throw new UsageError(`Status must be one of: ${validStatuses.join(", ")}`);
      }
      await updateGoalStatus(goalsDir, id, status as GoalStatus);
      return `Updated ${id} → ${status}`;
    }

    case "evidence": {
      const [id, ...findingParts] = rest;
      const finding = findingParts.join(" ");
      if (!id || !finding)
        throw new UsageError("Usage: hive goal evidence <id> <finding>");
      await appendEvidence(goalsDir, id, finding);
      return `Evidence appended to ${id}`;
    }

    case "show": {
      const [id] = rest;
      if (!id) throw new UsageError("Usage: hive goal show <id>");
      const goal = await readGoal(goalsDir, id);
      if (!goal) return `Goal not found: ${id}`;

      const evidenceText =
        goal.evidence.length > 0
          ? goal.evidence.map((e) => `  - ${e}`).join("\n")
          : "  (none)";

      return [
        bold(goal.id),
        `Status:  ${goal.status}`,
        `Created: ${goal.createdAt}`,
        `Updated: ${goal.updatedAt}`,
        `\n${section("Description", goal.description)}`,
        `\n${section("Plan", goal.plan || "(none)")}`,
        `\n${section("Evidence", evidenceText)}`,
      ].join("\n");
    }

    default:
      throw new UsageError("Usage: hive goal <add|list|update|evidence|show>");
  }
}
