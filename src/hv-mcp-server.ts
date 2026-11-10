/**
 * hv-mcp: the v2-only MCP tools. hv passes it to each agent it starts with
 * --mcp-config, so it sits beside the shared `hive` server without touching
 * any global MCP registration. HV_AGENT names the agent whose session this
 * server belongs to; agents it starts are that agent's children.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { formatAgentList, GREG, listAgents, startAgent } from "./lib/hv-agents";

const self = process.env.HV_AGENT || GREG;

const server = new McpServer(
  { name: "hv", version: "0.1.0" },
  {
    instructions:
      "hv runs HIVE v2 agents: long-lived background sessions, each with a workspace under ~/.hv/agents/<name>/. " +
      "Start children with agent_start and check on them with agent_list. Message agents with the harness's SendMessage, by name.",
  },
);

server.registerTool("agent_start", {
  description:
    "Start a child hv agent: a long-lived background Claude Code session with its own workspace, " +
    "a charter, and you as its parent. Use it for a piece of work that should run on its own and can be " +
    "messaged later, not for a quick lookup (use your harness's sub-agents for that). " +
    "Give a charter for a new agent. Omit the charter to restart an existing agent from its workspace. " +
    "Set worktree when the agent will edit code, so it gets its own branch. " +
    "It reports back to you with SendMessage; reach it the same way, by name.",
  inputSchema: {
    name: z.string().describe("Lowercase name, e.g. 'rate-limiter'. Also its session name for SendMessage."),
    charter: z.string().optional().describe("What the agent is for, in prose: its scope and what done looks like."),
    prompt: z.string().optional().describe("First message. Defaults to reading its charter and beginning."),
    cwd: z.string().optional().describe("Directory to run in. Defaults to your own working directory."),
    worktree: z.boolean().optional().describe("Create a git worktree and branch for this agent."),
  },
}, async ({ name, charter, prompt, cwd, worktree }) => {
  try {
    const { session, restarted, dir } = await startAgent({ name, charter, prompt, cwd, worktree, parent: self });
    const verb = restarted ? "Restarted" : "Started";
    return {
      content: [{
        type: "text" as const,
        text: `${verb} ${session.name} (session ${session.id}) in ${session.cwd}.\nWorkspace: ${dir}\nMessage it with SendMessage to "${session.name}".`,
      }],
    };
  } catch (err) {
    return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
  }
});

server.registerTool("agent_list", {
  description:
    "List every hv agent: its parent, whether its session is alive (working, idle, done, or gone), " +
    "how many reports it has written, and its last log line. An agent that is gone without a report died.",
  inputSchema: {},
}, async () => {
  try {
    return { content: [{ type: "text" as const, text: formatAgentList(await listAgents()) }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }] };
  }
});

await server.connect(new StdioServerTransport());
