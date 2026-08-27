import { ensureHiveScaffold } from "../lib/paths";
import { checkNextAvailability, readNextBoard } from "../lib/next";

export async function nextCommand(): Promise<void> {
  const paths = await ensureHiveScaffold();
  const board = await readNextBoard(paths);
  if (board.selections.length === 0) {
    console.log("No Act recommendations. Use `hive ticket ready` for the full inventory.");
    return;
  }

  console.log("Next:");
  for (const selection of board.selections) {
    const availability = await checkNextAvailability(paths, selection);
    const ticket = availability.ticket;
    const ready = availability.available ? "ready" : `no — ${availability.reason}`;
    const title = ticket ? `  ${ticket.title}` : "";
    console.log(`${selection.projectId}  ${selection.ticketId}  ${ready}${title}`);
    console.log(`  selected ${selection.selectedAt} by ${selection.sourceWatch}`);
    console.log("  Why:");
    for (const line of selection.rationale.split("\n")) {
      console.log(`  ${line}`);
    }
  }
}
