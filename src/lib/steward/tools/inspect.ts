import { Type } from "@mariozechner/pi-ai";
import { type HivePaths, getProjectPaths } from "../../paths";
import { refreshProjectRuntimeState, readStewardDeltaHistory } from "../../state";
import { loadPromptMemoryContext } from "../../memory";
import { truncateToolOutput } from "./files";
import { renderDeltaHistory } from "../sections";

type InspectContext = {
  hivePaths: HivePaths;
  projectId: string;
};

export function createInspectionTools(ctx: InspectContext) {
  return [
    {
      name: "inspect_board",
      description:
        "Read the full BOARD.md content with all task details, blockers, decisions, and agent assignments. Use when you need detailed task information beyond the compact summary.",
      parameters: Type.Object({}),
      async execute() {
        const projectPaths = getProjectPaths(ctx.hivePaths, ctx.projectId);
        const content = await Bun.file(projectPaths.board).text().catch(() => "");

        if (!content.trim()) {
          return "(BOARD.md is empty or missing)";
        }

        return truncateToolOutput(content);
      },
    },
    {
      name: "inspect_messages",
      description:
        "List open messages with details. Optionally filter by type (assign, nudge, ask, decision, escalation) or by sender/recipient.",
      parameters: Type.Object({
        type: Type.Optional(Type.String({ description: "Filter by message type: assign, nudge, ask, decision, escalation" })),
        agent: Type.Optional(Type.String({ description: "Filter by sender or recipient agent ID" })),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const filterType = args.type ? String(args.type).trim() : null;
        const filterAgent = args.agent ? String(args.agent).trim() : null;
        const projectPaths = getProjectPaths(ctx.hivePaths, ctx.projectId);
        const state = await refreshProjectRuntimeState({
          hivePaths: ctx.hivePaths,
          projectId: ctx.projectId,
          projectPaths,
        });

        let items = state.openMessagesSummary.items;

        if (filterType) {
          items = items.filter((m) => m.type === filterType);
        }

        if (filterAgent) {
          items = items.filter((m) => m.from === filterAgent || m.to === filterAgent);
        }

        if (items.length === 0) {
          const filterDesc = [filterType, filterAgent].filter(Boolean).join(", ");
          return filterDesc
            ? `No open messages matching: ${filterDesc}`
            : "No open messages.";
        }

        const lines = items.map((m) =>
          `- ${m.filename} | ${m.type} | ${m.from} → ${m.to} | ${m.summary}`,
        );
        return truncateToolOutput(lines.join("\n"));
      },
    },
    {
      name: "inspect_memory",
      description:
        "Search project memory for knowledge, decisions, and entity information. Returns relevant memory entries matching the topic.",
      parameters: Type.Object({
        topic: Type.Optional(Type.String({ description: "Topic or keyword to search for in memory" })),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const topic = args.topic ? String(args.topic).trim() : null;
        const memoryContext = await loadPromptMemoryContext(ctx.hivePaths, ctx.projectId);

        const sections: string[] = [];

        if (memoryContext.globalKnowledgeDigest) {
          sections.push("## Global Knowledge", memoryContext.globalKnowledgeDigest);
        }

        if (memoryContext.recentDecisionsDigest) {
          sections.push("## Recent Decisions", memoryContext.recentDecisionsDigest);
        }

        if (memoryContext.projectEntityDigest) {
          sections.push("## Project Entities", memoryContext.projectEntityDigest);
        }

        const result = sections.join("\n\n");

        if (!result.trim()) {
          return "(no memory entries found)";
        }

        // If a topic was specified, include a note about grepping for more specific results.
        if (topic) {
          return truncateToolOutput(
            `Memory entries (search: "${topic}"):\n\n${result}\n\nFor more specific results, use grep on the memory directory.`,
          );
        }

        return truncateToolOutput(result);
      },
    },
    {
      name: "inspect_results",
      description:
        "View recent worker run results. Optionally filter by scope or agent ID to see results relevant to specific work areas.",
      parameters: Type.Object({
        scope: Type.Optional(Type.String({ description: "Filter results by scope path, e.g. 'src/auth'" })),
        agent: Type.Optional(Type.String({ description: "Filter by agent ID" })),
        limit: Type.Optional(Type.Number({ description: "Max results to return. Default: 5" })),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const filterScope = args.scope ? String(args.scope).trim() : null;
        const filterAgent = args.agent ? String(args.agent).trim() : null;
        const limit = args.limit ? Number(args.limit) : 5;
        const projectPaths = getProjectPaths(ctx.hivePaths, ctx.projectId);
        const state = await refreshProjectRuntimeState({
          hivePaths: ctx.hivePaths,
          projectId: ctx.projectId,
          projectPaths,
        });

        let items = state.recentResultsSummary.items;

        if (filterScope) {
          items = items.filter((r) =>
            r.changedFiles.some((f) => f.includes(filterScope)),
          );
        }

        if (filterAgent) {
          items = items.filter((r) => r.agentId.includes(filterAgent));
        }

        items = items.slice(0, limit);

        if (items.length === 0) {
          return "No recent run results matching the filter.";
        }

        const lines = items.map((r) => {
          const filesLabel = r.changedFiles.length > 0
            ? ` | files: ${r.changedFiles.slice(0, 5).join(", ")}`
            : "";
          return `- ${r.runId} (${r.agentId}) | ${r.status}${filesLabel}\n  ${r.summary || "(no output)"}`;
        });

        return truncateToolOutput(lines.join("\n"));
      },
    },
    {
      name: "inspect_history",
      description:
        "View delta history — what changed in the hive since a given revision. Shows board changes, messages, run completions, and other state transitions.",
      parameters: Type.Object({
        count: Type.Optional(Type.Number({ description: "Number of recent delta entries to return. Default: 8" })),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const count = args.count ? Number(args.count) : 8;
        const projectPaths = getProjectPaths(ctx.hivePaths, ctx.projectId);
        const packets = await readStewardDeltaHistory({
          projectPaths,
          sinceRevision: 0,
          limit: count,
        });

        if (packets.length === 0) {
          return "(no delta history available)";
        }

        const entries = packets.map((packet) => ({
          revision: packet.revision,
          changes: packet.changes.map((change) => change.summary),
        }));

        return truncateToolOutput(renderDeltaHistory(entries, 0));
      },
    },
  ];
}
