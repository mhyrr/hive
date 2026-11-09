import { ensureHvScaffold } from "../lib/paths";

/** Creates ~/.hv and nothing else. `hive init` owns hooks, MCP entries and launchd. */
export async function hvInitCommand(_args: string[]): Promise<void> {
  const paths = await ensureHvScaffold();
  console.log(`hv is ready: ${paths.home}`);
  console.log("Nothing outside that folder changed.");
}
