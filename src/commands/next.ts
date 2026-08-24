import { ensureHiveScaffold } from "../lib/paths";
import { checkNextAvailability, readNextSelection } from "../lib/next";

export async function nextCommand(): Promise<void> {
  const paths = await ensureHiveScaffold();
  const selection = await readNextSelection(paths);
  if (!selection) {
    console.log("No Act recommendation. Use `hive ticket ready` for the full inventory.");
    return;
  }

  const availability = await checkNextAvailability(paths, selection);
  const ticket = availability.ticket;
  console.log(`Next: ${selection.projectId}/${selection.ticketId}${ticket ? ` — ${ticket.title}` : ""}`);
  console.log(`Selected: ${selection.selectedAt} by ${selection.sourceWatch}`);
  console.log(`Ready: ${availability.available ? "yes" : `no — ${availability.reason}`}`);
  console.log("");
  console.log("Why:");
  console.log(selection.rationale);
}
