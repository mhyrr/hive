import { UsageError } from "../lib/errors";
import { ensureHiveScaffold, listProjects } from "../lib/paths";
import {
  createTicket,
  readTicket,
  updateTicket,
  addTicketNote,
  listTickets,
  getReadyTickets,
  getBlockedTickets,
  formatTicketSummary,
  formatTicketDetail,
  type TicketType,
  type TicketPriority,
  type TicketStatus,
} from "../lib/ticket";

function resolveProjectFromCwd(projects: string[]): string | null {
  const cwd = process.cwd();
  return projects.find((p) => cwd.toLowerCase().includes(p.toLowerCase())) ?? projects[0] ?? null;
}

function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        flags[arg.slice(2)] = args[++i] ?? "";
      }
    } else if (arg.startsWith("-") && arg.length === 2) {
      flags[arg.slice(1)] = args[++i] ?? "";
    } else {
      positional.push(arg);
    }
  }

  return { flags, positional };
}

export async function ticketCommand(args: string[]): Promise<void> {
  const usage = `Usage:
  hive ticket create <title> [--type task] [--priority 2] [--tags a,b] [--ref url] [--depends TK-001]
  hive ticket list [--status open] [--type task] [--tags a,b]
  hive ticket show <id>
  hive ticket start <id>
  hive ticket close <id>
  hive ticket reopen <id>
  hive ticket note <id> <text>
  hive ticket ready                        Show unblocked tickets
  hive ticket blocked                      Show dependency-blocked tickets
  hive ticket --project <name> ...         Specify project`;

  const paths = await ensureHiveScaffold();

  // Extract --project flag before other parsing
  let projectOverride: string | null = null;
  const prefiltered: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" || args[i] === "-p") {
      projectOverride = args[++i] ?? null;
      continue;
    }
    prefiltered.push(args[i]!);
  }

  const projects = await listProjects(paths.projectsDir);
  const projectId = projectOverride ?? resolveProjectFromCwd(projects);

  if (!projectId) {
    throw new UsageError("No project found. Register one with: hive project add <name> <path>");
  }

  const subcommand = prefiltered[0];

  if (!subcommand || subcommand === "help") {
    console.log(usage);
    return;
  }

  const { flags, positional } = parseFlags(prefiltered.slice(1));

  switch (subcommand) {
    case "create": {
      const title = positional.join(" ").trim();
      if (!title) throw new UsageError("Title required.\n\n" + usage);

      let ticket;
      try {
        ticket = await createTicket(paths, projectId, {
          title,
          type: (flags.type as TicketType) ?? undefined,
          priority: flags.priority !== undefined ? (Number(flags.priority) as TicketPriority) : undefined,
          tags: flags.tags ? flags.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
          ref: flags.ref ?? undefined,
          depends: flags.depends ? flags.depends.split(",").map((d) => d.trim()).filter(Boolean) : undefined,
        });
      } catch (err) {
        throw new UsageError(err instanceof Error ? err.message : String(err));
      }
      console.log(`Created ${ticket.id}: ${ticket.title}`);
      break;
    }

    case "list":
    case "ls": {
      const tickets = await listTickets(paths, projectId, {
        status: (flags.status as TicketStatus) ?? undefined,
        type: (flags.type as TicketType) ?? undefined,
        tags: flags.tags ? flags.tags.split(",").map((t) => t.trim()) : undefined,
      });

      if (tickets.length === 0) {
        console.log("No tickets found.");
      } else {
        for (const t of tickets) {
          console.log(formatTicketSummary(t));
        }
      }
      break;
    }

    case "show": {
      const id = positional[0];
      if (!id) throw new UsageError("Ticket ID required.");
      const ticket = await readTicket(paths, projectId, id);
      if (!ticket) throw new UsageError(`Ticket not found: ${id}`);
      console.log(formatTicketDetail(ticket));
      break;
    }

    case "start": {
      const id = positional[0];
      if (!id) throw new UsageError("Ticket ID required.");
      const ticket = await updateTicket(paths, projectId, id, { status: "in_progress" });
      if (!ticket) throw new UsageError(`Ticket not found: ${id}`);
      console.log(`Started ${ticket.id}: ${ticket.title}`);
      break;
    }

    case "close": {
      const id = positional[0];
      if (!id) throw new UsageError("Ticket ID required.");
      const ticket = await updateTicket(paths, projectId, id, { status: "closed" });
      if (!ticket) throw new UsageError(`Ticket not found: ${id}`);
      console.log(`Closed ${ticket.id}: ${ticket.title}`);
      break;
    }

    case "reopen": {
      const id = positional[0];
      if (!id) throw new UsageError("Ticket ID required.");
      const ticket = await updateTicket(paths, projectId, id, { status: "open" });
      if (!ticket) throw new UsageError(`Ticket not found: ${id}`);
      console.log(`Reopened ${ticket.id}: ${ticket.title}`);
      break;
    }

    case "note": {
      const id = positional[0];
      if (!id) throw new UsageError("Ticket ID required.");
      const text = positional.slice(1).join(" ").trim();
      if (!text) throw new UsageError("Note text required.");
      const ticket = await addTicketNote(paths, projectId, id, text);
      if (!ticket) throw new UsageError(`Ticket not found: ${id}`);
      console.log(`Added note to ${ticket.id}`);
      break;
    }

    case "ready": {
      const tickets = await getReadyTickets(paths, projectId);
      if (tickets.length === 0) {
        console.log("No ready tickets.");
      } else {
        for (const t of tickets) console.log(formatTicketSummary(t));
      }
      break;
    }

    case "blocked": {
      const tickets = await getBlockedTickets(paths, projectId);
      if (tickets.length === 0) {
        console.log("No blocked tickets.");
      } else {
        for (const t of tickets) console.log(formatTicketSummary(t));
      }
      break;
    }

    default:
      throw new UsageError(`Unknown subcommand: ${subcommand}\n\n${usage}`);
  }
}
