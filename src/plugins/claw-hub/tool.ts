import { Type } from "@mariozechner/pi-ai";

import type { PersistentStewardTool } from "../../lib/steward/tools/index";
import type { PluginToolContext } from "../../lib/plugins/types";
import {
  ClawHubClient,
  HubNotFoundError,
  HubUnavailableError,
  resolveHubUrl,
} from "./client";
import { installSkill, listInstalledHubSkills } from "./install";

export function createHubTools(ctx: PluginToolContext): PersistentStewardTool[] {
  function makeClient(): ClawHubClient {
    return new ClawHubClient({ baseUrl: resolveHubUrl(ctx.globalConfig) });
  }

  return [
    {
      name: "hub_search",
      description:
        "Search the Claw Hub for agent skills. Returns skill summaries you can evaluate before installing. Use when you need a capability you don't have a skill for.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query — keywords describing the skill you need" }),
        tags: Type.Optional(Type.String({ description: "Comma-separated tags to filter by" })),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const query = String(args.query ?? "").trim();

        if (!query) {
          throw new Error("query is required.");
        }

        const tags = args.tags
          ? String(args.tags).split(",").map((t) => t.trim()).filter(Boolean)
          : undefined;

        const client = makeClient();

        try {
          const results = await client.search(query, tags);

          if (results.length === 0) {
            return `No skills found for "${query}". Try different keywords.`;
          }

          const lines = results.map(
            (s) =>
              `- ${s.id}: ${s.name} (v${s.version}) — ${s.description} [${s.tags.join(", ")}]`,
          );

          return [
            `Found ${results.length} skill(s):`,
            "",
            ...lines,
            "",
            "Use hub_install to install a skill by its ID.",
          ].join("\n");
        } catch (err) {
          if (err instanceof HubUnavailableError) {
            return `Hub unavailable — work with your currently installed skills. (${err.message})`;
          }

          throw err;
        }
      },
    },
    {
      name: "hub_install",
      description:
        "Install a skill from the Claw Hub by ID. Downloads the skill markdown to the hive skills directory so it's available in future sessions.",
      parameters: Type.Object({
        skill_id: Type.String({ description: "The skill ID to install (from hub_search results)" }),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const skillId = String(args.skill_id ?? "").trim();

        if (!skillId) {
          throw new Error("skill_id is required.");
        }

        // Check if already installed
        const installed = await listInstalledHubSkills(ctx.skillsDir);
        const existing = installed.find((s) => s.skillId === skillId);

        if (existing) {
          return `Skill "${skillId}" is already installed (v${existing.version}). Use hub_search to find other skills.`;
        }

        const client = makeClient();

        try {
          const detail = await client.info(skillId);
          const path = await installSkill(ctx.skillsDir, detail);

          return [
            `Installed "${detail.name}" (v${detail.version})`,
            `  → ${path}`,
            "",
            "The skill is now available. Re-read your skills to apply it.",
          ].join("\n");
        } catch (err) {
          if (err instanceof HubNotFoundError) {
            return `Skill not found: "${skillId}". Check the ID and try hub_search.`;
          }

          if (err instanceof HubUnavailableError) {
            return `Hub unreachable — try again later. (${err.message})`;
          }

          throw err;
        }
      },
    },
  ] as PersistentStewardTool[];
}
