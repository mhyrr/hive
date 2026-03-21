import type { PluginCommand } from "../../lib/plugins/types";
import {
  ClawHubClient,
  HubNotFoundError,
  HubUnavailableError,
  resolveHubUrl,
} from "./client";
import {
  installSkill,
  listInstalledHubSkills,
  removeSkill,
  type InstalledSkillMeta,
} from "./install";

export function createHubCommands(ctx: {
  skillsDir: string;
  globalConfig: string;
}): PluginCommand[] {
  function makeClient(): ClawHubClient {
    return new ClawHubClient({ baseUrl: resolveHubUrl(ctx.globalConfig) });
  }

  return [
    {
      name: "search",
      description: "Search for skills by keyword",
      async execute(args) {
        const query = args.join(" ").trim();

        if (!query) {
          return "Usage: hive hub search <query>";
        }

        const client = makeClient();

        try {
          const results = await client.search(query);

          if (results.length === 0) {
            return `No skills found for "${query}".`;
          }

          const lines = results.map(
            (s) => `  ${s.id}  ${s.name} (v${s.version}) — ${s.description}`,
          );

          return [`Found ${results.length} skill(s):`, "", ...lines].join("\n");
        } catch (err) {
          if (err instanceof HubUnavailableError) {
            return `Hub unavailable: ${err.message}`;
          }

          throw err;
        }
      },
    },
    {
      name: "install",
      description: "Install a skill from the hub",
      async execute(args) {
        const skillId = args[0]?.trim();

        if (!skillId) {
          return "Usage: hive hub install <skill-id>";
        }

        const client = makeClient();

        try {
          const detail = await client.info(skillId);
          const path = await installSkill(ctx.skillsDir, detail);

          return `Installed ${detail.name} (v${detail.version}) → ${path}`;
        } catch (err) {
          if (err instanceof HubNotFoundError) {
            return `Skill not found: ${skillId}`;
          }

          if (err instanceof HubUnavailableError) {
            return `Hub unavailable: ${err.message}`;
          }

          throw err;
        }
      },
    },
    {
      name: "list",
      description: "List available or installed skills",
      async execute(args) {
        const installed = args.includes("--installed");

        if (installed) {
          const skills = await listInstalledHubSkills(ctx.skillsDir);

          if (skills.length === 0) {
            return "No hub skills installed.";
          }

          const lines = skills.map(
            (s) => `  ${s.skillId}  v${s.version}  (installed ${s.installed})`,
          );

          return [`Installed hub skills:`, "", ...lines].join("\n");
        }

        const client = makeClient();
        const category = args[0]?.trim() || undefined;

        try {
          const results = await client.list(category);

          if (results.length === 0) {
            return "No skills available.";
          }

          const lines = results.map(
            (s) => `  ${s.id}  ${s.name} (v${s.version}) — ${s.description}`,
          );

          return [`Available skills:`, "", ...lines].join("\n");
        } catch (err) {
          if (err instanceof HubUnavailableError) {
            return `Hub unavailable: ${err.message}`;
          }

          throw err;
        }
      },
    },
    {
      name: "info",
      description: "Show details about a skill",
      async execute(args) {
        const skillId = args[0]?.trim();

        if (!skillId) {
          return "Usage: hive hub info <skill-id>";
        }

        const client = makeClient();

        try {
          const detail = await client.info(skillId);

          return [
            `${detail.name} (${detail.id})`,
            `  version: ${detail.version}`,
            `  author:  ${detail.author}`,
            `  tags:    ${detail.tags.join(", ") || "(none)"}`,
            "",
            detail.description,
          ].join("\n");
        } catch (err) {
          if (err instanceof HubNotFoundError) {
            return `Skill not found: ${skillId}`;
          }

          if (err instanceof HubUnavailableError) {
            return `Hub unavailable: ${err.message}`;
          }

          throw err;
        }
      },
    },
    {
      name: "remove",
      description: "Remove an installed hub skill",
      async execute(args) {
        const skillId = args[0]?.trim();

        if (!skillId) {
          return "Usage: hive hub remove <skill-id>";
        }

        const removed = await removeSkill(ctx.skillsDir, skillId);

        return removed
          ? `Removed skill: ${skillId}`
          : `Skill not found locally: ${skillId}`;
      },
    },
    {
      name: "sync",
      description: "Update all installed hub skills to latest versions",
      async execute() {
        const installed = await listInstalledHubSkills(ctx.skillsDir);

        if (installed.length === 0) {
          return "No hub skills installed. Nothing to sync.";
        }

        const client = makeClient();
        const results: string[] = [];

        for (const skill of installed) {
          try {
            const detail = await client.info(skill.skillId);

            if (detail.version === skill.version) {
              results.push(`  ${skill.skillId}  already up to date (v${skill.version})`);
            } else {
              await installSkill(ctx.skillsDir, detail);
              results.push(`  ${skill.skillId}  updated v${skill.version} → v${detail.version}`);
            }
          } catch (err) {
            if (err instanceof HubUnavailableError) {
              results.push(`  ${skill.skillId}  skipped (hub unavailable)`);
            } else {
              results.push(`  ${skill.skillId}  failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }

        return [`Sync complete:`, "", ...results].join("\n");
      },
    },
  ];
}
