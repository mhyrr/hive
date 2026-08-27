// `hive watch` — the control surface for standing-question watches (TK-138).
// All mutations go through frontmatter rewrite; no hand-editing files.

import { UsageError } from "../lib/errors";
import { readFile, writeFile } from "node:fs/promises";
import { setConfigValue } from "../lib/config";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { now as hiveNow } from "../lib/time";
import {
  AUTONOMY_LEVELS,
  SCOPE_KINDS,
  TIERS,
  VENUES,
  discoverWatches,
  findWatches,
  formatCadence,
  mutateWatches,
  parseCadence,
  rewriteWatchFrontmatter,
  type WatchDef,
} from "../lib/watch";
import { loadWatchState, freshEntry, usageSince, type WatchStateEntry } from "../lib/watch-state";
import { clampAutonomy, readAutonomyCeiling, runWatches } from "../lib/watch-run";

const USAGE = `Usage:
  hive watch list                     Discovered watches and their settings
  hive watch status                   Watches + last tick, outcome, 7d logged spend
  hive watch ceiling <level>          Set the global ceiling (observe, propose, or act)
  hive watch run --due                Run everything due (the launchd tick entrypoint)
  hive watch run <name> [...]         Force-run named watches (bypasses due-ness + delta gate)
  hive watch on <name>                Enable (fanned Act/Propose need project/name)
  hive watch off <name>               Disable (fanned Act/Propose need project/name)
  hive watch off --all                Hard stop: disable every watch
  hive watch set <name> k=v [...]     Update frontmatter (fanned Act/Propose need project/name)`;

async function requireWatches(paths: HivePaths, ref: string): Promise<WatchDef[]> {
  const { watches } = await discoverWatches(paths);
  const found = findWatches(watches, ref);
  if (found.length === 0) {
    const known = watches.map((w) => w.qualifiedName).join(", ") || "(none)";
    throw new UsageError(`No watch named "${ref}". Known: ${known}`);
  }
  return found;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function validateSetPair(key: string, value: string): void {
  switch (key) {
    case "cadence":
      if (!parseCadence(value)) throw new UsageError(`Invalid cadence "${value}" (want 2h, 45m, 1d, @nightly, @morning, or mon,thu)`);
      return;
    case "model":
      if (!(TIERS as string[]).includes(value)) throw new UsageError(`Invalid model tier "${value}" (want ${TIERS.join("|")})`);
      return;
    case "autonomy":
      if (!(AUTONOMY_LEVELS as string[]).includes(value)) throw new UsageError(`Invalid autonomy "${value}" (want ${AUTONOMY_LEVELS.join("|")})`);
      return;
    case "venue":
      if (!(VENUES as string[]).includes(value)) throw new UsageError(`Invalid venue "${value}" (want ${VENUES.join("|")})`);
      return;
    case "scope": {
      const kinds = value.split(",").map((s) => s.trim()).filter(Boolean);
      const bad = kinds.filter((k) => !(SCOPE_KINDS as string[]).includes(k));
      if (kinds.length === 0 || bad.length > 0) {
        throw new UsageError(`Invalid scope "${value}" (comma-separated from ${SCOPE_KINDS.join("|")})`);
      }
      return;
    }
    case "enabled":
      if (value !== "true" && value !== "false") throw new UsageError(`Invalid enabled "${value}" (want true|false)`);
      return;
    default:
      throw new UsageError(`Unknown key "${key}" (want cadence|model|autonomy|venue|scope|enabled)`);
  }
}

export async function watchCommand(args: string[]): Promise<void> {
  const paths = await ensureHiveScaffold();
  const [sub, ...rest] = args;

  switch (sub) {
    case "ceiling": {
      const level = rest[0];
      if (!level || rest.length !== 1 || !(AUTONOMY_LEVELS as readonly string[]).includes(level)) {
        throw new UsageError(`watch ceiling needs exactly one of: ${AUTONOMY_LEVELS.join("|")}.\n\n${USAGE}`);
      }
      const config = await readFile(paths.config, "utf-8").catch(() => "");
      await writeFile(paths.config, setConfigValue(config, "watches.max_autonomy", level), "utf-8");
      console.log(`Autonomy ceiling: ${level}`);
      return;
    }

    case "list": {
      const { watches, warnings } = await discoverWatches(paths);
      if (watches.length === 0) {
        console.log("No watches. Drop a markdown file in ~/.hive/watches/ (see docs/watches.md).");
      }
      for (const w of watches) {
        console.log(
          `${pad(w.qualifiedName, 24)} ${pad(formatCadence(w.cadence), 10)} ${pad(w.autonomy, 8)} ${pad(w.model, 9)} ${pad(w.venue, 9)} ${w.enabled ? "on " : "off"}  ${w.project ?? "(cross-project)"}`,
        );
      }
      for (const w of warnings) console.log(`! ${w}`);
      return;
    }

    case "status": {
      const { watches, warnings } = await discoverWatches(paths);
      const state = await loadWatchState(paths);
      const ceiling = readAutonomyCeiling(paths);
      const now = hiveNow();
      console.log(`Autonomy ceiling: ${ceiling} (watches.max_autonomy in ~/.hive/config.md)`);
      for (const w of watches) {
        const entry: WatchStateEntry = state.watches[w.qualifiedName] ?? freshEntry();
        const spend = usageSince(entry, now.getTime() - 7 * 86_400_000);
        const effective = clampAutonomy(w.autonomy, ceiling);
        const autonomyLabel = effective === w.autonomy ? w.autonomy : `${w.autonomy}→${effective}`;
        console.log(
          `${pad(w.qualifiedName, 24)} ${w.enabled ? "on " : "off"} ${pad(formatCadence(w.cadence), 10)} ${pad(autonomyLabel, 16)} ${pad(w.model, 9)} ` +
            `last: ${entry.lastRun ?? "never"} → ${entry.lastOutcome ?? "-"}` +
            (entry.lastError ? ` (${entry.lastError.slice(0, 60)})` : "") +
            `  7d: ${spend.calls} call(s), ${spend.inputTokens + spend.outputTokens} tok logged`,
        );
      }
      for (const w of warnings) console.log(`! ${w}`);
      return;
    }

    case "run": {
      const due = rest.includes("--due");
      const names = rest.filter((a) => a !== "--due");
      if (!due && names.length === 0) throw new UsageError(`watch run needs --due or watch name(s).\n\n${USAGE}`);
      if (due && names.length > 0) throw new UsageError("watch run takes --due OR names, not both.");
      if (!due) {
        for (const name of names) await requireWatches(paths, name); // fail fast on typos
      }
      const { reports, warnings } = await runWatches({
        paths,
        mode: due ? "due" : "named",
        names,
      });
      if (reports.length === 0) console.log("Nothing due.");
      for (const r of reports) {
        const line = `${pad(r.watch, 24)} ${r.outcome}` +
          (r.detail ? ` — ${r.detail}` : "") +
          (r.error ? ` — ${r.error.slice(0, 100)}` : "") +
          (r.artifactPath ? ` → ${r.artifactPath}` : "");
        console.log(line);
      }
      for (const w of warnings) console.log(`! ${w}`);
      return;
    }

    case "on":
    case "off": {
      const enabled = sub === "on";
      if (!enabled && rest[0] === "--all") {
        const { watches } = await discoverWatches(paths);
        const files = [...new Set(watches.map((w) => w.filePath))];
        for (const file of files) await rewriteWatchFrontmatter(file, { enabled: "false" });
        console.log(`Disabled ${watches.length} watch(es). Hard stop.`);
        return;
      }
      const ref = rest[0];
      if (!ref) throw new UsageError(`watch ${sub} needs a name.\n\n${USAGE}`);
      const matches = await requireWatches(paths, ref);
      const result = await mutateWatches(paths, ref, matches, { enabled: String(enabled) });
      const verb = enabled ? "enabled" : "disabled";
      if (result.createdOverride) {
        console.log(`${ref}: ${verb} (project override)`);
      } else {
        const label = matches.length === 1 ? matches[0]!.qualifiedName : `${ref} (${matches.length} projects)`;
        console.log(`${label}: ${verb}`);
      }
      return;
    }

    case "set": {
      const [ref, ...pairs] = rest;
      if (!ref || pairs.length === 0) throw new UsageError(`watch set needs a name and k=v pairs.\n\n${USAGE}`);
      const matches = await requireWatches(paths, ref);
      const updates: Record<string, string> = {};
      for (const pair of pairs) {
        const i = pair.indexOf("=");
        if (i <= 0) throw new UsageError(`Not a k=v pair: "${pair}"`);
        const key = pair.slice(0, i).trim();
        const value = pair.slice(i + 1).trim();
        validateSetPair(key, value);
        updates[key] = value;
      }
      const result = await mutateWatches(paths, ref, matches, updates);
      if (result.createdOverride) {
        console.log(`${ref}: ${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(", ")} (project override)`);
      } else {
        const label = matches.length === 1 ? matches[0]!.qualifiedName : `${ref} (${matches.length} projects)`;
        console.log(`${label}: ${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(", ")}`);
      }
      return;
    }

    default:
      throw new UsageError(sub ? `Unknown subcommand: ${sub}\n\n${USAGE}` : USAGE);
  }
}
