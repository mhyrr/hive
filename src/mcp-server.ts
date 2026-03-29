import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { extractConfigValue } from "./lib/config";

import {
  conveneCouncil,
  formatCouncilResultsForSteward,
  resolveCouncilMembers,
} from "./lib/council";
import { parseModelPool } from "./lib/project";
import { getHivePaths, listProjects, resolveHiveHome } from "./lib/paths";
import {
  readProjectMemorySnapshot,
  readProjectMemorySection,
  appendProjectMemory,
  type MemorySection,
} from "./lib/memory";
import { parseFrontmatter } from "./lib/frontmatter";

function resolveProjectFromCwd(paths: ReturnType<typeof getHivePaths>): string | null {
  const cwd = process.cwd();
  const projectsDir = paths.projectsDir;

  if (!existsSync(projectsDir)) return null;

  const projects = readdirSync(projectsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  // Try to match cwd against project paths from config files
  for (const projectId of projects) {
    try {
      const configPath = join(projectsDir, projectId, "config.md");
      const raw = Bun.file(configPath).textSync?.() ?? "";
      const parsed = parseFrontmatter(raw);
      const projectPath = parsed.attributes?.path as string | undefined;
      if (projectPath && cwd.startsWith(projectPath)) return projectId;
    } catch {
      // skip
    }
  }

  // Fallback: match project name in cwd
  return projects.find((p) => cwd.toLowerCase().includes(p.toLowerCase())) ?? projects[0] ?? null;
}

const server = new McpServer(
  { name: "hive", version: "2.0.0" },
  {
    instructions: "HIVE provides persistent identity, project memory, and multi-model council capabilities. Use convene_council for important decisions. Use read/write_hive_memory to accumulate project intelligence.",
  },
);

// Tool 1: Multi-model council
server.registerTool("convene_council", {
  description:
    "Send a question to multiple AI models in parallel and collect their independent positions. " +
    "Use for architecture decisions, tradeoff analysis, risk assessment, or any question where " +
    "multiple perspectives add value. You act as chair — synthesize the results.",
  inputSchema: {
    question: z.string().describe("The question to ask all council members. Be specific and give enough context."),
    models: z.array(z.string()).optional().describe("Model pool names to consult (e.g. ['opus', 'sonnet', 'gpt54']). Defaults to all configured models."),
    context: z.string().optional().describe("Additional context to include in the prompt to each model."),
  },
}, async ({ question, models: modelNames, context }) => {
  const paths = getHivePaths();
  const globalConfig = await Bun.file(paths.config).text().catch(() => "");
  const pool = parseModelPool(globalConfig);
  const defaultModels = extractConfigValue(globalConfig, "council-default");
  const names = modelNames
    ?? (defaultModels ? defaultModels.split(",").map((m) => m.trim()).filter(Boolean) : null)
    ?? pool.map((e) => e.name);

  const { members, errors } = resolveCouncilMembers(globalConfig, names);

  if (members.length < 2) {
    return {
      content: [{ type: "text" as const, text: `Could not resolve enough council members (need 2+, got ${members.length}). ${errors.join(" ")} Available: ${pool.map((e) => e.name).join(", ")}` }],
      isError: true,
    };
  }

  const fullQuestion = context ? `${context}\n\n${question}` : question;
  const result = await conveneCouncil({ question: fullQuestion, members, globalConfig, persona: null });

  let output = formatCouncilResultsForSteward(result);
  const failed = result.positions.filter((p) => p.error);
  if (failed.length > 0) {
    output += `\n\n**Failed members:** ${failed.map((p) => `${p.modelName}: ${p.error}`).join("; ")}`;
  }

  return { content: [{ type: "text" as const, text: output }] };
});

// Tool 2: Read project memory
server.registerTool("read_hive_memory", {
  description: "Read accumulated project intelligence — facts, conventions, decisions, and open questions.",
  inputSchema: {
    project: z.string().optional().describe("Project name. Defaults to project matching current directory."),
    section: z.enum(["all", "facts", "conventions", "decisions", "questions"]).optional().describe("Which section to read. Defaults to 'all'."),
  },
}, async ({ project, section }) => {
  const paths = getHivePaths();
  const projectId = project ?? resolveProjectFromCwd(paths);

  if (!projectId) {
    return {
      content: [{ type: "text" as const, text: "No project found. Register one with: hive project add <name> <path>" }],
      isError: true,
    };
  }

  const snapshot = await readProjectMemorySnapshot(paths, projectId);
  const output = readProjectMemorySection(snapshot, section ?? "all");

  return { content: [{ type: "text" as const, text: `# Project Memory: ${projectId}\n\n${output}` }] };
});

// Tool 3: Write project memory
server.registerTool("write_hive_memory", {
  description: "Record a new fact, convention, decision, or open question in project memory. Use proactively when you learn something durable about the project.",
  inputSchema: {
    project: z.string().optional().describe("Project name. Defaults to project matching current directory."),
    type: z.enum(["fact", "convention", "decision", "question"]).describe("What kind of memory to record."),
    content: z.string().describe("The text to record."),
  },
}, async ({ project, type, content }) => {
  const paths = getHivePaths();
  const projectId = project ?? resolveProjectFromCwd(paths);

  if (!projectId) {
    return {
      content: [{ type: "text" as const, text: "No project found. Register one with: hive project add <name> <path>" }],
      isError: true,
    };
  }

  await appendProjectMemory(paths, projectId, type as MemorySection, content);

  return { content: [{ type: "text" as const, text: `Recorded ${type} in ${projectId} memory.` }] };
});

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
