// Watch model tier ladder (TK-138 budget note) — the ONE place watch tier
// aliases resolve to model IDs. Watch files carry aliases only; raw pins in
// watch frontmatter would rot the way TK-105/TK-121 pins rotted.
//
// Overrides, most specific first:
//   HIVE_WATCH_MODEL_<WATCH_NAME>  — one watch (name uppercased, [^A-Z0-9]→_)
//   HIVE_WATCH_MODEL_<TIER>        — every watch on that tier

import type { WatchTier } from "./watch";

const TIER_DEFAULTS: Record<WatchTier, string> = {
  fast: "claude-haiku-4-5",
  standard: "claude-sonnet-5",
  judgment: "claude-opus-4-8",
};

function envKey(suffix: string): string {
  return `HIVE_WATCH_MODEL_${suffix.toUpperCase().replace(/[^A-Z0-9]/gi, "_")}`;
}

export function resolveWatchModel(tier: WatchTier, watchName?: string): string {
  if (watchName) {
    const perWatch = process.env[envKey(watchName)];
    if (perWatch) return perWatch;
  }
  return process.env[envKey(tier)] || TIER_DEFAULTS[tier];
}
