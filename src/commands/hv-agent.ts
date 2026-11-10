import { readFile } from "node:fs/promises";

import { UsageError } from "../lib/errors";
import { formatAgentList, listAgents, startAgent } from "../lib/hv-agents";

const usage = `Usage:
  hv agent start <name> --charter "<text>" [--cwd DIR] [--worktree] [--prompt "<text>"]
  hv agent start <name> --charter-file PATH [...]
  hv agent start <name>          Restart an existing agent from its workspace
  hv agent list                  Every agent, its state, reports and last log line`;

export async function hvAgentCommand(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    console.log(usage);
    return;
  }
  if (sub === "list") {
    console.log(formatAgentList(await listAgents()));
    return;
  }
  if (sub === "start") {
    const opts = await parseStart(rest);
    const { session, restarted, dir } = await startAgent(opts);
    console.log(`${restarted ? "Restarted" : "Started"} ${session.name} (session ${session.id}) in ${session.cwd}`);
    console.log(`Workspace: ${dir}`);
    console.log(`Watch it: claude attach ${session.id}`);
    return;
  }
  throw new UsageError(`Unknown subcommand: agent ${sub}\n\n${usage}`);
}

async function parseStart(args: string[]) {
  const name = args[0];
  if (!name || name.startsWith("-")) throw new UsageError(usage);
  const opts: { name: string; charter?: string; cwd?: string; worktree?: boolean; prompt?: string } = { name };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    const value = () => {
      const v = args[++i];
      if (v === undefined) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (flag === "--charter") opts.charter = value();
    else if (flag === "--charter-file") opts.charter = await readFile(value(), "utf-8");
    else if (flag === "--cwd") opts.cwd = value();
    else if (flag === "--prompt") opts.prompt = value();
    else if (flag === "--worktree") opts.worktree = true;
    else throw new UsageError(`Unknown flag: ${flag}\n\n${usage}`);
  }
  return opts;
}
