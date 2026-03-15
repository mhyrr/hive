import { getHivePaths } from "../lib/paths";
import {
  getConfiguredDirectAuthPolicy,
  listRuntimeAdapters,
  readRuntimeAccessPolicy,
  resolvePiRuntimeRoute,
} from "../lib/runtime";

function formatPiRoute(runtime: string, globalConfig: string): string {
  const route = resolvePiRuntimeRoute({
    globalConfig,
    runtime,
  });

  if (!route.provider) {
    return "not configured by default -> direct runtime fallback";
  }

  const sourceLabel =
    route.providerSource === "env"
      ? "env override"
      : route.providerSource === "config"
        ? "config"
        : "implicit";
  const providerLabel = route.provider ?? route.providerContext ?? "pi default";
  const modelLabel = route.model ? ` | model: ${route.model}` : "";
  const authLabel = route.authPolicy ? ` | auth: ${route.authPolicy}` : "";

  return `${sourceLabel} -> ${providerLabel}${modelLabel}${authLabel}`;
}

export async function runtimesCommand(): Promise<string> {
  const adapters = listRuntimeAdapters();
  const paths = getHivePaths();
  const globalConfig = await Bun.file(paths.config).text().catch(() => "");
  const policy = readRuntimeAccessPolicy(globalConfig);
  const lines: string[] = ["Available runtimes:", ""];

  for (const adapter of adapters) {
    const installed = await adapter.detectInstalled();
    const status = installed ? "installed" : "not found";
    const aliases = adapter.aliases.length
      ? `  (aliases: ${adapter.aliases.join(", ")})`
      : "";

    lines.push(`  ${adapter.name.padEnd(10)} ${status.padEnd(12)} ${adapter.command}${aliases}`);
    lines.push(`    direct auth: ${getConfiguredDirectAuthPolicy(adapter.name, globalConfig)}`);
    lines.push(`    pi route: ${formatPiRoute(adapter.name, globalConfig)}`);
    lines.push("");
  }

  lines.push("Current defaults:");
  lines.push(`  runtime: ${policy.defaultRuntime ?? "(unset)"}`);
  lines.push(`  model: ${policy.defaultModel ?? "(unset)"}`);
  lines.push(`  config: ${paths.config}`);

  return lines.join("\n");
}
