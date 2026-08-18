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

/**
 * The apex principle headings, in file order — the CLOSED ENUM a taste unit may
 * ladder up to.
 *
 * Before this existed, `ladders_up_to` was free text and TC invented rungs: 8 of
 * 26 distinct targets in the store named principles that do not exist
 * ("Conservation of complexity", "Iterate", "Leave the workspace as clean as you
 * found it"). That is why 86 of 90 candidates came back `instantiates` and
 * `tension` never fired once — a model that can mint a principle on demand never
 * has to report that nothing fits, and never has to report a conflict.
 *
 * Headings are `### ` at the top level of principles.md. A heading is matched
 * verbatim, so renaming a principle orphans its units by design: they resurface
 * as uncovered and get re-laddered on the next pass rather than silently
 * pointing at a rung that moved.
 */
export function parsePrincipleHeadings(principlesText: string | null): string[] {
  if (!principlesText) return [];
  const out: string[] = [];
  for (const line of principlesText.split("\n")) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}
