import { UsageError } from "../lib/errors";
import { ensureHiveScaffold } from "../lib/paths";
import { resolveProjectFromCwd } from "../lib/project";
import {
  createTicket,
  readTicket,
  updateTicket,
  addTicketNote,
  listTickets,
  getReadyTickets,
  getBlockedTickets,
  formatTicketRow,
  formatTicketDetail,
  sortTicketsForDisplay,
  type TicketType,
  type TicketPriority,
  type TicketStatus,
} from "../lib/ticket";

/**
 * Description column width to wrap into. Zero when output isn't a terminal, so
 * piped output stays one ticket per line for grep.
 */
function terminalWidth(): number {
  return process.stdout.isTTY ? (process.stdout.columns ?? 0) : 0;
}

/** Subcommands `hive tickets` forwards to `hive ticket` untouched. */
const TICKET_SUBCOMMANDS = new Set([
  "create", "list", "ls", "show", "start", "close", "reopen", "note",
  "dispatch", "ready", "blocked", "relink-epics", "release-claim", "help",
]);

function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (args[i + 1]?.startsWith("--")) {
        // Boolean flag (e.g. --all) — don't swallow the next flag as its value.
        flags[arg.slice(2)] = "";
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

/** Pull `--project <name>` / `-p <name>` out of argv before subcommand parsing. */
function splitProjectFlag(args: string[]): { project: string | null; rest: string[] } {
  let project: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" || args[i] === "-p") {
      project = args[++i] ?? null;
      continue;
    }
    rest.push(args[i]!);
  }
  return { project, rest };
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
  hive ticket dispatch <id>                Tag ticket for auto-dispatch
  hive ticket ready                        Show unblocked tickets
  hive ticket blocked                      Show dependency-blocked tickets
  hive ticket relink-epics                 Best-effort backfill of parent_epic on children
  hive ticket --project <name> ...         Specify project

  hive tickets                             Open tickets for this project`;

  const paths = await ensureHiveScaffold();

  const { project: projectOverride, rest: prefiltered } = splitProjectFlag(args);

  const projectId = projectOverride ?? resolveProjectFromCwd();

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
          console.log(formatTicketRow(t, terminalWidth()));
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

    case "dispatch": {
      const id = positional[0];
      if (!id) throw new UsageError("Ticket ID required.");
      const ticket = await readTicket(paths, projectId, id);
      if (!ticket) throw new UsageError(`Ticket not found: ${id}`);

      if (ticket.tags.includes("auto-dispatch")) {
        console.log(`${ticket.id} already tagged auto-dispatch`);
      } else {
        const updated = await updateTicket(paths, projectId, id, {
          tags: [...ticket.tags, "auto-dispatch"],
        });
        if (!updated) throw new UsageError(`Failed to update ticket: ${id}`);
        console.log(`Tagged ${updated.id} for auto-dispatch: ${updated.title}`);
      }
      break;
    }

    case "ready": {
      const tickets = await getReadyTickets(paths, projectId);
      if (tickets.length === 0) {
        console.log("No ready tickets.");
      } else {
        for (const t of tickets) console.log(formatTicketRow(t, terminalWidth()));
      }
      break;
    }

    case "blocked": {
      const tickets = await getBlockedTickets(paths, projectId);
      if (tickets.length === 0) {
        console.log("No blocked tickets.");
      } else {
        for (const t of tickets) console.log(formatTicketRow(t, terminalWidth()));
      }
      break;
    }

    case "relink-epics": {
      const all = await listTickets(paths, projectId);
      const epics = all.filter((t) => t.type === "epic");
      if (epics.length === 0) {
        console.log("No epics in this project.");
        break;
      }

      const PROXIMITY_MS = 2 * 60 * 1000; // ±2 minutes

      let linked = 0;
      let skipped = 0;
      for (const epic of epics) {
        const epicTime = Date.parse(epic.created);
        if (Number.isNaN(epicTime)) continue;
        const epicTags = new Set(epic.tags);

        for (const t of all) {
          if (t.id === epic.id) continue;
          if (t.type === "epic") continue;
          if (t.parentEpic) {
            // Don't overwrite an existing link, even ours.
            continue;
          }

          const tTime = Date.parse(t.created);
          if (Number.isNaN(tTime)) continue;
          if (Math.abs(tTime - epicTime) > PROXIMITY_MS) continue;

          // Require shared tag (or epic with no tags trusts proximity alone).
          const sharesTag =
            epicTags.size === 0 ||
            t.tags.some((tag) => epicTags.has(tag));
          if (!sharesTag) {
            skipped++;
            continue;
          }

          await updateTicket(paths, projectId, t.id, { parentEpic: epic.id });
          console.log(`Linked ${t.id} → ${epic.id} (${t.title})`);
          linked++;
        }
      }

      console.log(`\nLinked ${linked} ticket(s). Skipped ${skipped} time-proximate but tag-mismatched.`);
      break;
    }

    default:
      throw new UsageError(`Unknown subcommand: ${subcommand}\n\n${usage}`);
  }
}

/**
 * `hive tickets` — the zero-argument view. Open work for the project you're
 * standing in, in_progress first. "Open" means not closed, so in-progress
 * tickets show up too; --all widens to include closed. Anything that looks
 * like a `hive ticket` subcommand forwards there untouched.
 */
export async function ticketsCommand(args: string[]): Promise<void> {
  const usage = `Usage:
  hive tickets                      Open tickets (includes in-progress)
  hive tickets --all                Include closed
  hive tickets --status closed      Filter to one status
  hive tickets --type bug           Filter by type
  hive tickets --tags a,b           Filter by tag (any match)
  hive tickets --project <name>     Specify project

Subcommands forward to \`hive ticket\` — e.g. hive tickets show TK-001`;

  const { project: projectOverride, rest } = splitProjectFlag(args);

  const first = rest.find((a) => !a.startsWith("-"));
  if (first && TICKET_SUBCOMMANDS.has(first)) {
    return ticketCommand(args);
  }

  const { flags } = parseFlags(rest);
  if ("help" in flags || "h" in flags) {
    console.log(usage);
    return;
  }

  const paths = await ensureHiveScaffold();
  const projectId = projectOverride ?? resolveProjectFromCwd();
  if (!projectId) {
    throw new UsageError("No project found. Register one with: hive project add <name> <path>");
  }

  const status = flags.status as TicketStatus | undefined;
  const includeClosed = "all" in flags || status === "closed";

  const tickets = sortTicketsForDisplay(
    await listTickets(paths, projectId, {
      status,
      type: (flags.type as TicketType) ?? undefined,
      tags: flags.tags ? flags.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    }),
  ).filter((t) => includeClosed || t.status !== "closed");

  if (tickets.length === 0) {
    console.log(`${projectId} — no ${includeClosed || status ? "matching" : "open"} tickets.`);
    return;
  }

  const inProgress = tickets.filter((t) => t.status === "in_progress").length;
  const noun = includeClosed || status
    ? `ticket${tickets.length === 1 ? "" : "s"}`
    : "open";
  const suffix = inProgress > 0 && !status ? ` (${inProgress} in progress)` : "";

  console.log(`${projectId} — ${tickets.length} ${noun}${suffix}\n`);
  for (const t of tickets) console.log(formatTicketRow(t, terminalWidth()));
}
