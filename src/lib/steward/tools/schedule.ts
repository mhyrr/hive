import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { Type } from "@mariozechner/pi-ai";

import { stringifyFrontmatter } from "../../frontmatter";
import type { HivePaths } from "../../paths";
import { getProjectPaths } from "../../paths";
import { listSchedules, nextCronOccurrence, cronMatches } from "../../schedules";

type ScheduleContext = {
  hivePaths: HivePaths;
  projectId: string;
};

export function createScheduleTools(ctx: ScheduleContext) {
  const projectPaths = getProjectPaths(ctx.hivePaths, ctx.projectId);

  return [
    {
      name: "create_schedule",
      description:
        "Create a recurring scheduled task. The supervisor evaluates schedules every tick and sends a nudge to the steward when they fire. Use standard 5-field cron syntax: minute hour day-of-month month day-of-week.",
      parameters: Type.Object({
        name: Type.String({
          description:
            "Schedule name (kebab-case, e.g. 'check-prs', 'morning-standup')",
        }),
        cron: Type.String({
          description:
            "5-field cron expression, e.g. '0 9 * * 1-5' for weekdays at 9am, '*/30 * * * *' for every 30 min",
        }),
        goal: Type.String({
          description:
            "What the steward should do when this fires. Written as an instruction.",
        }),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const name = String(args.name ?? "").trim().replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
        const cron = String(args.cron ?? "").trim();
        const goal = String(args.goal ?? "").trim();

        if (!name) throw new Error("name is required.");
        if (!cron) throw new Error("cron is required.");
        if (!goal) throw new Error("goal is required.");

        // Validate cron expression
        const testDate = new Date(2026, 0, 1, 0, 0);
        let valid = false;
        for (let i = 0; i < 525960; i++) { // one year of minutes
          testDate.setMinutes(testDate.getMinutes() + 1);
          if (cronMatches(cron, testDate)) { valid = true; break; }
        }
        if (!valid) throw new Error(`Invalid or unreachable cron expression: "${cron}"`);

        const dir = projectPaths.schedulesDir;
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

        const filePath = join(dir, `${name}.md`);
        if (existsSync(filePath)) {
          throw new Error(`Schedule "${name}" already exists. Use list_schedules to view existing schedules.`);
        }

        const now = new Date();
        const next = nextCronOccurrence(cron, now);

        const content = stringifyFrontmatter(
          {
            cron,
            enabled: "true",
            ...(next ? { "next-run": next.toISOString() } : {}),
          },
          goal,
        );

        await Bun.write(filePath, content);

        return [
          `Created schedule "${name}"`,
          `  cron: ${cron}`,
          `  next: ${next ? next.toISOString() : "(unknown)"}`,
          `  goal: ${goal.slice(0, 100)}${goal.length > 100 ? "..." : ""}`,
          `  file: ${filePath}`,
        ].join("\n");
      },
    },
    {
      name: "list_schedules",
      description: "List all scheduled tasks for the current project.",
      parameters: Type.Object({}),
      async execute() {
        const schedules = await listSchedules(projectPaths.schedulesDir);

        if (schedules.length === 0) {
          return "No schedules configured. Use create_schedule to add recurring tasks.";
        }

        const lines = schedules.map((s) => {
          const status = s.enabled ? "active" : "paused";
          const last = s.lastRun ? `last: ${s.lastRun}` : "never run";
          const next = s.nextRun ? `next: ${s.nextRun}` : "";
          return `- ${s.name} [${status}] (${s.cron}) ${last}${next ? ` | ${next}` : ""}\n  ${s.goal.slice(0, 120)}`;
        });

        return lines.join("\n\n");
      },
    },
    {
      name: "toggle_schedule",
      description: "Enable or disable a scheduled task.",
      parameters: Type.Object({
        name: Type.String({ description: "Schedule name" }),
        enabled: Type.Boolean({ description: "true to enable, false to disable" }),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const name = String(args.name ?? "").trim();
        const enabled = Boolean(args.enabled);

        if (!name) throw new Error("name is required.");

        const filePath = join(projectPaths.schedulesDir, `${name}.md`);
        if (!existsSync(filePath)) {
          throw new Error(`Schedule "${name}" not found.`);
        }

        const raw = await Bun.file(filePath).text();
        const { parseFrontmatter } = await import("../../frontmatter");
        const { attributes, body } = parseFrontmatter(raw);

        attributes.enabled = String(enabled);
        await Bun.write(filePath, stringifyFrontmatter(attributes, body));

        return `Schedule "${name}" ${enabled ? "enabled" : "disabled"}.`;
      },
    },
    {
      name: "delete_schedule",
      description: "Delete a scheduled task.",
      parameters: Type.Object({
        name: Type.String({ description: "Schedule name to delete" }),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const name = String(args.name ?? "").trim();
        if (!name) throw new Error("name is required.");

        const filePath = join(projectPaths.schedulesDir, `${name}.md`);
        if (!existsSync(filePath)) {
          throw new Error(`Schedule "${name}" not found.`);
        }

        const { unlinkSync } = await import("node:fs");
        unlinkSync(filePath);

        return `Schedule "${name}" deleted.`;
      },
    },
  ];
}
