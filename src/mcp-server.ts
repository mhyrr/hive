import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

import { extractConfigValue } from "./lib/config";

import {
  conveneCouncil,
  conveneDialectic,
  formatCouncilResultsForSteward,
  formatDialecticResultsForSteward,
  resolveCouncilMembers,
  clampRounds,
} from "./lib/council";
import { parseModelPool, resolveProjectFromCwd } from "./lib/project";
import { getHivePaths, listProjects, resolveHiveHome } from "./lib/paths";
import {
  readProjectMemorySnapshot,
  readProjectMemorySection,
  appendProjectMemory,
  appendToLog,
  searchMemory,
  formatSearchResults,
  rebuildIndex,
  supersedeEntry,
  type MemorySection,
} from "./lib/memory";
import { parseFrontmatter } from "./lib/frontmatter";
import {
  readHeartbeatConfig,
  writeHeartbeatConfig,
  defaultConfig,
} from "./lib/heartbeat";
import {
  createTicket,
  readTicket,
  updateTicket,
  addTicketNote,
  listTickets,
  formatTicketSummary,
  formatTicketDetail,
  type TicketStatus,
  type TicketType,
  type TicketPriority,
} from "./lib/ticket";


const server = new McpServer(
  { name: "hive", version: "2.0.0" },
  {
    instructions: "HIVE provides persistent identity, project memory, multi-model council, and per-project ticket tracking. Use convene_council for important decisions. Use read/write_hive_memory to accumulate project intelligence. Use create_ticket/list_tickets/show_ticket/update_ticket/add_ticket_note for task tracking.",
  },
);

// Tool 1: Multi-model council
server.registerTool("convene_council", {
  description:
    "Send a question to multiple AI models in parallel and collect their independent positions. " +
    "Use for architecture decisions, tradeoff analysis, risk assessment, or any question where " +
    "multiple perspectives add value. You act as chair — synthesize the results. " +
    "Mode 'dialectic' assigns models to argue specific camps across multiple rounds.",
  inputSchema: {
    question: z.string().describe("The question to ask all council members. Be specific and give enough context."),
    models: z.array(z.string()).optional().describe("Model pool names to consult (e.g. ['opus', 'sonnet', 'gpt54']). Defaults to all configured models."),
    context: z.string().optional().describe("Additional context to include in the prompt to each model."),
    persona: z.enum(["default", "analyst"]).optional().describe("Council member persona for standard mode. 'analyst' adds structured analytical framing."),
    mode: z.enum(["standard", "analyst", "dialectic"]).optional().describe("Council mode. 'standard' for independent analysis, 'analyst' for structured analysis, 'dialectic' for adversarial multi-round debate."),
    camps: z.array(z.object({
      name: z.string().describe("Short name for this camp (e.g. 'rewrite', 'refactor')."),
      position: z.string().describe("The position this camp argues for."),
      brief: z.string().optional().describe("Optional additional context for this camp's advocate."),
    })).optional().describe("Required for dialectic mode. The positions to argue. Each model is assigned a camp."),
    rounds: z.number().optional().describe("Number of dialectic rounds (default 3, min 1, max 5). Models see each other's arguments between rounds."),
  },
}, async ({ question, models: modelNames, context, persona, mode, camps, rounds }) => {
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

  // Dialectic mode
  if (mode === "dialectic") {
    if (!camps || camps.length < 2) {
      return {
        content: [{ type: "text" as const, text: "Dialectic mode requires at least 2 camps." }],
        isError: true,
      };
    }

    const result = await conveneDialectic({
      question: fullQuestion,
      camps,
      members,
      globalConfig,
      rounds: clampRounds(rounds),
    });

    let output = formatDialecticResultsForSteward(result);
    const allPositions = result.rounds.flatMap((r) => r.positions);
    const failed = allPositions.filter((p) => p.error);
    if (failed.length > 0) {
      output += `\n\n**Failed members:** ${failed.map((p) => `${p.modelName} (round ${p.roundNumber}): ${p.error}`).join("; ")}`;
    }

    return { content: [{ type: "text" as const, text: output }] };
  }

  // Standard or analyst mode
  const resolvedPersona = (mode === "analyst" || persona === "analyst") ? "analyst" : null;
  const result = await conveneCouncil({ question: fullQuestion, members, globalConfig, persona: resolvedPersona });

  let output = formatCouncilResultsForSteward(result);
  const failed = result.positions.filter((p) => p.error);
  if (failed.length > 0) {
    output += `\n\n**Failed members:** ${failed.map((p) => `${p.modelName}: ${p.error}`).join("; ")}`;
  }

  return { content: [{ type: "text" as const, text: output }] };
});

// Tool 2: Read project memory
server.registerTool("read_hive_memory", {
  description:
    "Read accumulated project intelligence — facts, conventions, decisions, and open questions. " +
    "For targeted lookups, prefer search_memory instead. " +
    "Set source to 'index' for a lightweight summary (loaded at session start).",
  inputSchema: {
    project: z.string().optional().describe("Project name. Defaults to project matching current directory."),
    section: z.enum(["all", "facts", "conventions", "decisions", "questions"]).optional().describe("Which section to read. Defaults to 'all'."),
    source: z.enum(["knowledge", "index"]).optional().describe("Read from full knowledge file or lightweight index. Default 'knowledge'."),
    include_superseded: z.boolean().optional().describe("Include superseded (replaced) entries. Default true."),
  },
}, async ({ project, section, source, include_superseded }) => {
  const paths = getHivePaths();
  const projectId = project ?? resolveProjectFromCwd();

  if (!projectId) {
    return {
      content: [{ type: "text" as const, text: "No project found. Register one with: hive project add <name> <path>" }],
      isError: true,
    };
  }

  if (source === "index") {
    const { indexPath: getIndexPath } = await import("./lib/memory");
    const iPath = getIndexPath(paths, projectId);
    try {
      const content = await Bun.file(iPath).text();
      return { content: [{ type: "text" as const, text: content }] };
    } catch {
      // No index yet — rebuild it
      const content = await rebuildIndex(paths, projectId);
      return { content: [{ type: "text" as const, text: content }] };
    }
  }

  const snapshot = await readProjectMemorySnapshot(paths, projectId);
  const output = readProjectMemorySection(snapshot, section ?? "all", include_superseded ?? true);

  return { content: [{ type: "text" as const, text: `# Project Memory: ${projectId}\n\n${output}` }] };
});

// Tool 3: Write project memory
server.registerTool("write_hive_memory", {
  description: "Record a new fact, convention, decision, or open question in project memory. Use proactively when you learn something durable about the project. Tags help with search — use them to categorize entries by topic.",
  inputSchema: {
    project: z.string().optional().describe("Project name. Defaults to project matching current directory."),
    type: z.enum(["fact", "convention", "decision", "question"]).describe("What kind of memory to record."),
    content: z.string().describe("The text to record."),
    tags: z.array(z.string()).optional().describe("Topic tags for this entry (e.g. ['auth', 'security']). Lowercase, short."),
    supersedes: z.string().optional().describe("If this replaces an existing entry, provide the text of the old entry. The old entry will be marked as superseded."),
  },
}, async ({ project, type, content, tags, supersedes }) => {
  const paths = getHivePaths();
  const projectId = project ?? resolveProjectFromCwd();

  if (!projectId) {
    return {
      content: [{ type: "text" as const, text: "No project found. Register one with: hive project add <name> <path>" }],
      isError: true,
    };
  }

  if (supersedes) {
    await supersedeEntry(paths, projectId, type as MemorySection, supersedes, content, tags ?? []);
  } else {
    await appendProjectMemory(paths, projectId, type as MemorySection, content, tags ?? []);
  }

  return { content: [{ type: "text" as const, text: `Recorded ${type} in ${projectId} memory.` }] };
});

// Tool 4: Batch reflect session learnings
server.registerTool("reflect_session", {
  description:
    "Batch-write session learnings to project memory. Writes to both the session log (raw capture) " +
    "and knowledge file (compiled intelligence). Rebuilds the index afterward. " +
    "Use at end of a substantive session to record durable facts, conventions, decisions, or open questions.",
  inputSchema: {
    project: z.string().optional().describe("Project name. Defaults to project matching current directory."),
    learnings: z.array(z.object({
      type: z.enum(["fact", "convention", "decision", "question"]).describe("What kind of memory to record."),
      content: z.string().describe("The text to record."),
      tags: z.array(z.string()).optional().describe("Topic tags (e.g. ['auth', 'api']). Lowercase."),
    })).describe("Array of learnings to record."),
  },
}, async ({ project, learnings }) => {
  const paths = getHivePaths();
  const projectId = project ?? resolveProjectFromCwd();

  if (!projectId) {
    return {
      content: [{ type: "text" as const, text: "No project found. Register one with: hive project add <name> <path>" }],
      isError: true,
    };
  }

  if (!learnings || learnings.length === 0) {
    return { content: [{ type: "text" as const, text: "No learnings provided. Nothing to record." }] };
  }

  const counts: Record<string, number> = {};
  const errors: string[] = [];

  // Write to session log (raw capture)
  try {
    await appendToLog(paths, projectId, learnings.map((l) => ({ type: l.type as MemorySection, content: l.content })));
  } catch (err) {
    errors.push(`log: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Write to knowledge (compiled)
  for (const item of learnings) {
    try {
      await appendProjectMemory(paths, projectId, item.type as MemorySection, item.content, item.tags ?? []);
      counts[item.type] = (counts[item.type] ?? 0) + 1;
    } catch (err) {
      errors.push(`${item.type}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Rebuild index
  try {
    await rebuildIndex(paths, projectId);
  } catch (err) {
    errors.push(`index: ${err instanceof Error ? err.message : String(err)}`);
  }

  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}(s)`).join(", ");
  let text = `Recorded ${summary} in ${projectId} memory (knowledge + log). Index rebuilt.`;
  if (errors.length > 0) {
    text += `\n\nSkipped ${errors.length} invalid entries:\n${errors.map(e => `- ${e}`).join("\n")}`;
  }

  return { content: [{ type: "text" as const, text }] };
});

// Tool 5: Search project memory
server.registerTool("search_memory", {
  description:
    "Search across all layers of project memory — knowledge (compiled facts, conventions, decisions) " +
    "and session logs (raw daily capture). Results are ranked by BM25 relevance combined with entry " +
    "strength (entries recalled more often rank higher). Searching also strengthens recalled entries, " +
    "so frequently useful knowledge persists longer. " +
    "Use this to answer questions like 'what do we know about auth?' or 'what decisions have we made about the API?'. " +
    "Prefer this over read_hive_memory when looking for something specific.",
  inputSchema: {
    project: z.string().optional().describe("Project name. Defaults to project matching current directory."),
    query: z.string().describe("Search query — matches against entry text and tags."),
    tag: z.string().optional().describe("Filter to entries with this tag."),
    section: z.enum(["fact", "convention", "decision", "question"]).optional().describe("Limit search to this section of knowledge."),
    include_superseded: z.boolean().optional().describe("Include superseded (replaced) entries. Default false."),
    log_days: z.number().optional().describe("How many days of log history to search. Default 14."),
  },
}, async ({ project, query, tag, section, include_superseded, log_days }) => {
  const paths = getHivePaths();
  const projectId = project ?? resolveProjectFromCwd();

  if (!projectId) {
    return {
      content: [{ type: "text" as const, text: "No project found. Register one with: hive project add <name> <path>" }],
      isError: true,
    };
  }

  const results = await searchMemory(paths, projectId, query, {
    tag: tag ?? undefined,
    section: (section as MemorySection) ?? undefined,
    includeSuperseded: include_superseded ?? false,
    logDays: log_days ?? 14,
  });

  const formatted = formatSearchResults(results, query);
  return { content: [{ type: "text" as const, text: formatted }] };
});

// Tool 6: Create a ticket
server.registerTool("create_ticket", {
  description:
    "Create a new ticket in the project's ticket tracker. " +
    "Use for tracking bugs, features, tasks, epics, or chores. " +
    "Tickets are stored as markdown files and support dependencies.",
  inputSchema: {
    project: z.string().optional().describe("Project name. Defaults to project matching current directory."),
    title: z.string().describe("Ticket title — concise, imperative form."),
    body: z.string().optional().describe("Ticket description or details."),
    type: z.enum(["bug", "feature", "task", "epic", "chore"]).optional().describe("Ticket type. Defaults to 'task'."),
    priority: z.number().min(0).max(3).optional().describe("Priority 0-3 (0=critical, 3=low). Defaults to 2."),
    tags: z.array(z.string()).optional().describe("Tags for categorization."),
    ref: z.string().optional().describe("External reference (GitHub issue URL, etc.)."),
    depends: z.array(z.string()).optional().describe("Ticket IDs this depends on (e.g. ['TK-001']). Must exist."),
  },
}, async ({ project, title, body, type, priority, tags, ref, depends }) => {
  const paths = getHivePaths();
  const projectId = project ?? resolveProjectFromCwd();

  if (!projectId) {
    return {
      content: [{ type: "text" as const, text: "No project found. Register one with: hive project add <name> <path>" }],
      isError: true,
    };
  }

  const ticket = await createTicket(paths, projectId, {
    title,
    body: body ?? undefined,
    type: (type as TicketType) ?? undefined,
    priority: priority !== undefined ? (priority as TicketPriority) : undefined,
    tags: tags ?? undefined,
    ref: ref ?? undefined,
    depends: depends ?? undefined,
  });

  return { content: [{ type: "text" as const, text: `Created ${ticket.id}: ${ticket.title}\n\n${formatTicketDetail(ticket)}` }] };
});

// Tool 6: List tickets
server.registerTool("list_tickets", {
  description:
    "List tickets in the project, optionally filtered by status, type, or tags.",
  inputSchema: {
    project: z.string().optional().describe("Project name. Defaults to project matching current directory."),
    status: z.enum(["open", "in_progress", "closed"]).optional().describe("Filter by status."),
    type: z.enum(["bug", "feature", "task", "epic", "chore"]).optional().describe("Filter by type."),
    tags: z.array(z.string()).optional().describe("Filter by tags (matches any)."),
  },
}, async ({ project, status, type, tags }) => {
  const paths = getHivePaths();
  const projectId = project ?? resolveProjectFromCwd();

  if (!projectId) {
    return {
      content: [{ type: "text" as const, text: "No project found. Register one with: hive project add <name> <path>" }],
      isError: true,
    };
  }

  const tickets = await listTickets(paths, projectId, {
    status: (status as TicketStatus) ?? undefined,
    type: (type as TicketType) ?? undefined,
    tags: tags ?? undefined,
  });

  if (tickets.length === 0) {
    return { content: [{ type: "text" as const, text: "No tickets found." }] };
  }

  const output = tickets.map(formatTicketSummary).join("\n");
  return { content: [{ type: "text" as const, text: `${tickets.length} ticket(s):\n\n${output}` }] };
});

// Tool 7: Show ticket detail
server.registerTool("show_ticket", {
  description: "Show full details of a ticket including notes. Supports partial ID matching (e.g. '1' matches 'TK-001').",
  inputSchema: {
    project: z.string().optional().describe("Project name. Defaults to project matching current directory."),
    id: z.string().describe("Ticket ID (e.g. 'TK-001' or just '1')."),
  },
}, async ({ project, id }) => {
  const paths = getHivePaths();
  const projectId = project ?? resolveProjectFromCwd();

  if (!projectId) {
    return {
      content: [{ type: "text" as const, text: "No project found. Register one with: hive project add <name> <path>" }],
      isError: true,
    };
  }

  const ticket = await readTicket(paths, projectId, id);
  if (!ticket) {
    return { content: [{ type: "text" as const, text: `Ticket not found: ${id}` }], isError: true };
  }

  return { content: [{ type: "text" as const, text: formatTicketDetail(ticket) }] };
});

// Tool 8: Update ticket
server.registerTool("update_ticket", {
  description:
    "Update a ticket's status, title, type, priority, tags, or dependencies. " +
    "Use for starting work (in_progress), closing, reopening, or modifying ticket metadata.",
  inputSchema: {
    project: z.string().optional().describe("Project name. Defaults to project matching current directory."),
    id: z.string().describe("Ticket ID (e.g. 'TK-001' or just '1')."),
    status: z.enum(["open", "in_progress", "closed"]).optional().describe("New status."),
    title: z.string().optional().describe("New title."),
    type: z.enum(["bug", "feature", "task", "epic", "chore"]).optional().describe("New type."),
    priority: z.number().min(0).max(3).optional().describe("New priority (0-3)."),
    tags: z.array(z.string()).optional().describe("Replace tags."),
    ref: z.string().optional().describe("Update external reference."),
    depends: z.array(z.string()).optional().describe("Replace dependency list."),
  },
}, async ({ project, id, status, title, type, priority, tags, ref, depends }) => {
  const paths = getHivePaths();
  const projectId = project ?? resolveProjectFromCwd();

  if (!projectId) {
    return {
      content: [{ type: "text" as const, text: "No project found. Register one with: hive project add <name> <path>" }],
      isError: true,
    };
  }

  const ticket = await updateTicket(paths, projectId, id, {
    status: (status as TicketStatus) ?? undefined,
    title: title ?? undefined,
    type: (type as TicketType) ?? undefined,
    priority: priority !== undefined ? (priority as TicketPriority) : undefined,
    tags: tags ?? undefined,
    ref: ref ?? undefined,
    depends: depends ?? undefined,
  });

  if (!ticket) {
    return { content: [{ type: "text" as const, text: `Ticket not found: ${id}` }], isError: true };
  }

  return { content: [{ type: "text" as const, text: `Updated ${ticket.id}: ${ticket.title}\n\n${formatTicketDetail(ticket)}` }] };
});

// Tool 9: Add note to ticket
server.registerTool("add_ticket_note", {
  description: "Add a timestamped note to an existing ticket. Use for progress updates, findings, or context.",
  inputSchema: {
    project: z.string().optional().describe("Project name. Defaults to project matching current directory."),
    id: z.string().describe("Ticket ID (e.g. 'TK-001' or just '1')."),
    note: z.string().describe("The note text to add."),
    actor: z.string().optional().describe("Who is adding the note (e.g. 'maya', 'greg'). Shown in the note heading."),
  },
}, async ({ project, id, note, actor }) => {
  const paths = getHivePaths();
  const projectId = project ?? resolveProjectFromCwd();

  if (!projectId) {
    return {
      content: [{ type: "text" as const, text: "No project found. Register one with: hive project add <name> <path>" }],
      isError: true,
    };
  }

  const ticket = await addTicketNote(paths, projectId, id, note, actor ?? undefined);
  if (!ticket) {
    return { content: [{ type: "text" as const, text: `Ticket not found: ${id}` }], isError: true };
  }

  return { content: [{ type: "text" as const, text: `Added note to ${ticket.id}: ${ticket.title}` }] };
});

// Tool 10: Add project
server.registerTool("add_project", {
  description:
    "Register a project with HIVE. Creates project config and memory file in ~/.hive/. " +
    "After this, the project is included in nightly scans, morning briefings, and memory is scoped to it. " +
    "Use the current working directory if no path is provided.",
  inputSchema: {
    name: z.string().describe("Project name (lowercase, alphanumeric + hyphens)."),
    path: z.string().optional().describe("Absolute path to the project. Defaults to current working directory."),
  },
}, async ({ name, path: projectPath }) => {
  const { normalizeProjectName } = await import("./lib/project");
  const { ensureProjectMemoryDir } = await import("./lib/memory");

  const paths = getHivePaths();
  const projectId = normalizeProjectName(name);
  const repoPath = projectPath ?? process.cwd();

  if (!existsSync(repoPath)) {
    return { content: [{ type: "text" as const, text: `Path does not exist: ${repoPath}` }], isError: true };
  }

  const { ensureDirectory } = await import("./lib/paths");
  const projectDir = join(paths.projectsDir, projectId);
  await ensureDirectory(projectDir);
  await Bun.write(
    join(projectDir, "config.md"),
    `---\nname: ${projectId}\npath: ${repoPath}\n---\n`,
  );

  await ensureProjectMemoryDir(paths, projectId);

  // Write HEARTBEAT.md from template if missing
  const heartbeatPath = join(projectDir, "HEARTBEAT.md");
  if (!existsSync(heartbeatPath)) {
    const templatePath = join(dirname(import.meta.dir), "templates", "heartbeat", "HEARTBEAT.md");
    try {
      let content = await Bun.file(templatePath).text();
      content = content.replaceAll("{{projectName}}", projectId);
      await Bun.write(heartbeatPath, content);
    } catch {
      // Template may not exist in all installations — non-fatal
    }
  }

  return {
    content: [{ type: "text" as const, text: `Registered project '${projectId}' at ${repoPath}\nMemory: ~/.hive/memory/projects/${projectId}/\nHeartbeat: ~/.hive/projects/${projectId}/HEARTBEAT.md\n\nUse \`hive\` from ${repoPath} to start a session with project context.` }],
  };
});

// Tool 11: Hive status overview
server.registerTool("hive_status", {
  description:
    "Full HIVE system status — identity, projects, tickets, scheduled jobs, recent memory, installed agents. " +
    "Use as a dashboard to understand the current state of the hive.",
  inputSchema: {},
}, async () => {
  const paths = getHivePaths();
  const home = process.env.HOME || "";
  const lines: string[] = [];

  // Identity
  try {
    const identity = await Bun.file(paths.identity).text();
    const nameMatch = identity.match(/^-\s*Name:\s*(.+)$/m);
    const roleMatch = identity.match(/^-\s*Role:\s*(.+)$/m);
    const emojiMatch = identity.match(/^-\s*Emoji:\s*(.+)$/m);
    const name = nameMatch?.[1]?.trim() ?? "Unknown";
    const role = roleMatch?.[1]?.trim() ?? "Unknown";
    const emoji = emojiMatch?.[1]?.trim() ?? "";
    lines.push(`## Identity`);
    lines.push(`I'm **${name}**, ${role} ${emoji}`);

    const selfFile = await Bun.file(paths.self).text();
    const serveMatch = selfFile.match(/^##\s*Who I Serve\s*\n(.+)/m);
    if (serveMatch) lines.push(`Serving: ${serveMatch[1].trim()}`);
  } catch {
    lines.push(`## Identity\nCould not read identity files.`);
  }

  lines.push("");

  // Projects
  const projects = await listProjects(paths.projectsDir);
  lines.push(`## Projects (${projects.length})`);

  for (const projectId of projects) {
    const configPath = join(paths.projectsDir, projectId, "config.md");
    let projectPath = "unknown";
    try {
      const raw = await Bun.file(configPath).text();
      const parsed = parseFrontmatter(raw);
      projectPath = (parsed.attributes?.path as string) ?? "unknown";
    } catch { /* skip */ }

    // Count open tickets
    const tickets = await listTickets(paths, projectId, { status: "open" as TicketStatus });
    const inProgress = await listTickets(paths, projectId, { status: "in_progress" as TicketStatus });
    const ticketInfo = [];
    if (tickets.length > 0) ticketInfo.push(`${tickets.length} open`);
    if (inProgress.length > 0) ticketInfo.push(`${inProgress.length} in progress`);
    const ticketStr = ticketInfo.length > 0 ? ` — ${ticketInfo.join(", ")}` : "";

    lines.push(`- **${projectId}** \`${projectPath}\`${ticketStr}`);
  }

  lines.push("");

  // Open tickets across all projects (top 10 by priority)
  const allTickets: Array<{ project: string; ticket: Awaited<ReturnType<typeof listTickets>>[0] }> = [];
  for (const projectId of projects) {
    const open = await listTickets(paths, projectId, { status: "open" as TicketStatus });
    const inProg = await listTickets(paths, projectId, { status: "in_progress" as TicketStatus });
    for (const t of [...inProg, ...open]) {
      allTickets.push({ project: projectId, ticket: t });
    }
  }
  allTickets.sort((a, b) => a.ticket.priority - b.ticket.priority);

  if (allTickets.length > 0) {
    lines.push(`## Active Tickets (${allTickets.length})`);
    for (const { project, ticket } of allTickets.slice(0, 10)) {
      const status = ticket.status === "in_progress" ? "🔵" : "⚪";
      lines.push(`${status} ${ticket.id} P${ticket.priority} [${project}] ${ticket.title}`);
    }
    if (allTickets.length > 10) lines.push(`  ... and ${allTickets.length - 10} more`);
    lines.push("");
  }

  // Scheduled jobs
  lines.push(`## Scheduled Jobs`);
  const launchAgentsDir = join(home, "Library", "LaunchAgents");
  const hivePlists = ["com.hive.morning.plist", "com.hive.nightly.plist", "com.hive.sync.plist"];
  for (const plist of hivePlists) {
    const installed = existsSync(join(launchAgentsDir, plist));
    const label = plist.replace(".plist", "");
    lines.push(`- **${label}**: ${installed ? "installed" : "not installed"}`);
  }

  // Active runs
  const runsDir = join(paths.home, "runs");
  try {
    const runEntries = readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith("RUN-"))
      .map((e) => e.name)
      .sort()
      .reverse()
      .slice(0, 5);

    const activeRuns: string[] = [];
    for (const runId of runEntries) {
      try {
        const status = await Bun.file(join(runsDir, runId, "status")).text().then((s) => s.trim());
        const goalRaw = await Bun.file(join(runsDir, runId, "goal.md")).text();
        const goalLine = goalRaw.split("\n").find((l) => l.trim() && !l.startsWith("#") && !l.startsWith("---"))?.trim().slice(0, 60) ?? "";
        const icon = status === "running" ? "🔵" : status === "complete" ? "✅" : status === "failed" ? "❌" : status === "blocked" ? "🟡" : "⚪";
        activeRuns.push(`${icon} ${runId} ${status} — ${goalLine}`);
      } catch { /* skip */ }
    }

    if (activeRuns.length > 0) {
      lines.push(`## Dispatch Runs`);
      for (const r of activeRuns) lines.push(`- ${r}`);
      lines.push("");
    }
  } catch { /* no runs dir yet */ }

  // Latest briefing
  const briefingsDir = join(paths.home, "briefings");
  try {
    const briefings = readdirSync(briefingsDir).filter((f) => f.endsWith(".md")).sort();
    if (briefings.length > 0) {
      lines.push(`- **Latest briefing**: ${briefings[briefings.length - 1]!.replace(".md", "")}`);
    }
  } catch { /* no briefings yet */ }

  // Last nightly run
  const nightlyLog = join(paths.home, "logs", "nightly.log");
  try {
    const log = await Bun.file(nightlyLog).text();
    const lastRun = log.match(/=== HIVE nightly: (\S+ \S+) ===/g);
    if (lastRun && lastRun.length > 0) {
      const last = lastRun[lastRun.length - 1]!;
      const dateMatch = last.match(/(\S+ \S+)/);
      lines.push(`- **Last nightly run**: ${dateMatch?.[1] ?? "unknown"}`);
    } else {
      lines.push(`- **Last nightly run**: never`);
    }
  } catch {
    lines.push(`- **Last nightly run**: no log found`);
  }

  lines.push("");

  // Agents
  const agentsDir = join(home, ".claude", "agents");
  lines.push(`## Agents`);
  try {
    const agentFiles = readdirSync(agentsDir).filter((f) => f.startsWith("maya-") && f.endsWith(".md"));
    for (const file of agentFiles) {
      const content = await Bun.file(join(agentsDir, file)).text();
      const descMatch = content.match(/^description:\s*(.+)$/m);
      const name = file.replace(".md", "");
      lines.push(`- **${name}**: ${descMatch?.[1]?.trim() ?? "no description"}`);
    }
  } catch {
    lines.push("- No agents installed");
  }

  lines.push("");

  // Recent memory (last 5 decisions across all projects)
  lines.push(`## Recent Memory`);
  for (const projectId of projects) {
    try {
      const snapshot = await readProjectMemorySnapshot(paths, projectId);
      const decisions = readProjectMemorySection(snapshot, "decisions", false);
      const decisionLines = decisions.split("\n").filter((l) => l.startsWith("- ")).slice(-3);
      if (decisionLines.length > 0) {
        lines.push(`**${projectId}** (recent decisions):`);
        for (const d of decisionLines) lines.push(d);
      }
    } catch { /* skip */ }
  }

  return { content: [{ type: "text" as const, text: lines.join("\n") }] };
});

// Heartbeat management
server.tool(
  "manage_heartbeat",
  "Enable or disable the periodic heartbeat for a project. The heartbeat wakes up every N minutes, checks project health (git status, tickets, dispatch runs), and surfaces anything that needs attention.",
  {
    action: z.enum(["enable", "disable", "status"]).describe("Enable, disable, or check heartbeat status"),
    project: z.string().optional().describe("Project name. Defaults to project matching current directory."),
    interval_minutes: z.number().optional().describe("Heartbeat interval in minutes (default 30, min 5). Only used with 'enable'."),
  },
  async ({ action, project, interval_minutes }) => {
    const paths = getHivePaths();
    const projectId = project || resolveProjectFromCwd();
    if (!projectId) {
      return { content: [{ type: "text" as const, text: "No project found. Specify a project name." }] };
    }

    const projectDir = join(paths.projectsDir, projectId);
    if (!existsSync(projectDir)) {
      return { content: [{ type: "text" as const, text: `Project not found: ${projectId}` }] };
    }

    if (action === "status") {
      const config = readHeartbeatConfig(projectDir);
      if (!config) {
        return { content: [{ type: "text" as const, text: `No heartbeat configured for ${projectId}. Use action "enable" to set one up.` }] };
      }
      const enabled = config.enabled ? "enabled" : "disabled";
      const lastTick = config.lastTick
        ? `${Math.round((Date.now() - new Date(config.lastTick).getTime()) / 60000)}m ago`
        : "never";
      const session = config.sessionId ? `${config.sessionId.slice(0, 8)}...` : "none";
      return { content: [{ type: "text" as const, text: `Heartbeat for ${projectId}: ${enabled}, interval ${config.intervalMinutes}m, session ${session}, last tick ${lastTick}, ${config.tickCount} ticks, ${config.consecutiveFailures} failures, last result: ${config.lastResult || "n/a"}` }] };
    }

    if (action === "enable") {
      const interval = (interval_minutes && interval_minutes >= 5) ? interval_minutes : 30;
      const existing = readHeartbeatConfig(projectDir);
      const config = existing ?? defaultConfig(interval);
      config.enabled = true;
      config.intervalMinutes = interval;
      await writeHeartbeatConfig(projectDir, config);

      // Write HEARTBEAT.md template if missing
      const ordersPath = join(projectDir, "HEARTBEAT.md");
      if (!existsSync(ordersPath)) {
        const templateDir = join(import.meta.dir, "..", "templates", "heartbeat");
        try {
          let template = await Bun.file(join(templateDir, "HEARTBEAT.md")).text();
          template = template.replaceAll("{{projectName}}", projectId);
          await Bun.write(ordersPath, template);
        } catch { /* template missing — user can create manually */ }
      }

      return { content: [{ type: "text" as const, text: `Heartbeat enabled for ${projectId} (every ${interval}m). Standing orders at ~/.hive/projects/${projectId}/HEARTBEAT.md. Run \`hive heartbeat tick\` to test or wait for launchd.` }] };
    }

    if (action === "disable") {
      const config = readHeartbeatConfig(projectDir);
      if (!config) {
        return { content: [{ type: "text" as const, text: `No heartbeat configured for ${projectId}.` }] };
      }
      config.enabled = false;
      await writeHeartbeatConfig(projectDir, config);
      return { content: [{ type: "text" as const, text: `Heartbeat disabled for ${projectId}.` }] };
    }

    return { content: [{ type: "text" as const, text: `Unknown action: ${action}` }] };
  }
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
