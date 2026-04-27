import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveHiveHome } from "./paths";

export type TastePaths = {
  root: string;
  principles: string;
};

export function getTastePaths(home: string = resolveHiveHome()): TastePaths {
  const root = join(home, "taste");
  return {
    root,
    principles: join(root, "principles.md"),
  };
}

/**
 * Build the taste layer prefix.
 *
 * Loads `~/.hive/taste/principles.md` if present (~500 tokens, cache-stable).
 * Returns null if the file is missing — the layer is optional, graceful
 * absence is the contract.
 *
 * V1 collapsed the original applications/exemplars/pending tree to just
 * principles.md. The verifier handles taste-as-lens during the nightly run;
 * domain-specific applications no longer need a session-time hook.
 */
export async function buildTasteLayer(): Promise<string | null> {
  const paths = getTastePaths();
  if (!existsSync(paths.principles)) return null;
  return (await Bun.file(paths.principles).text()).trim();
}

export function tasteIsConfigured(): boolean {
  return existsSync(getTastePaths().principles);
}
