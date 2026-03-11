import { listRuntimeAdapters } from "../lib/runtime";

export async function runtimesCommand(): Promise<string> {
  const adapters = listRuntimeAdapters();
  const lines: string[] = ["Available runtimes:", ""];

  for (const adapter of adapters) {
    const installed = await adapter.detectInstalled();
    const status = installed ? "installed" : "not found";
    const aliases = adapter.aliases.length
      ? `  (aliases: ${adapter.aliases.join(", ")})`
      : "";

    lines.push(`  ${adapter.name.padEnd(10)} ${status.padEnd(12)} ${adapter.command}${aliases}`);
  }

  return lines.join("\n");
}
