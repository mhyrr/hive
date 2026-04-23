/**
 * HIVE identity extension for Pi.
 *
 * Loads the identity stack from ~/.hive/ and injects it as the prefix
 * of Pi's system prompt. Mirrors what ~/.claude/hooks/load-identity.sh
 * does for Claude Code, minus the hook indirection.
 *
 * Read order (SOUL → IDENTITY → SELF → AGENTS → TRUST → OVERRIDES) is
 * deliberate: SOUL sets shared culture, IDENTITY is who the agent is,
 * SELF is who the user is, AGENTS covers operations, TRUST defines
 * action boundaries, OVERRIDES carries any last-mile carve-outs.
 *
 * The concatenated block is a stable SEG 1 cache segment. Pi's default
 * cache_control wraps the full system prompt into one ephemeral block
 * (verified in scripts/pi-verification/v1-cache — 99.7% hit rate on
 * second invocation). Explicit SEG 2/3 breakpoints are a future refinement.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const IDENTITY_FILES = [
  "SOUL.md",
  "IDENTITY.md",
  "SELF.md",
  "AGENTS.md",
  "TRUST.md",
  "OVERRIDES.md", // optional — skipped silently if absent
] as const;

const REQUIRED = new Set(["SOUL.md", "IDENTITY.md", "SELF.md", "AGENTS.md", "TRUST.md"]);

async function loadIdentity(dir: string): Promise<{ text: string; missing: string[] }> {
  const parts: string[] = [];
  const missing: string[] = [];

  for (const name of IDENTITY_FILES) {
    try {
      const content = await readFile(join(dir, name), "utf-8");
      parts.push(content.trim());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        if (REQUIRED.has(name)) missing.push(name);
        continue;
      }
      throw err;
    }
  }

  return { text: parts.join("\n\n---\n\n"), missing };
}

export default function hiveIdentityExtension(pi: ExtensionAPI) {
  const hiveDir = process.env.HIVE_DIR || join(homedir(), ".hive");
  let identityText = "";
  let loadError: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    try {
      const { text, missing } = await loadIdentity(hiveDir);
      if (missing.length > 0) {
        loadError = `HIVE identity: missing required files in ${hiveDir}: ${missing.join(", ")}`;
        ctx.ui.notify(loadError, "error");
        return;
      }
      identityText = text;
      ctx.ui.notify(`HIVE identity loaded from ${hiveDir} (${identityText.length} chars)`, "info");
    } catch (err) {
      loadError = `HIVE identity: ${err instanceof Error ? err.message : String(err)}`;
      ctx.ui.notify(loadError, "error");
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!identityText) return;
    return {
      systemPrompt: `${identityText}\n\n---\n\n${event.systemPrompt}`,
    };
  });
}
