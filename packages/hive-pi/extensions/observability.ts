/**
 * HIVE observability extension for Pi.
 *
 * Each Pi session gets a mirror directory at `~/.hive/runs/<runId>/`:
 *   - session.jsonl  symlink → Pi's native session JSONL
 *   - meta.json      { runId, sessionId, cwd, startedAt, endedAt? }
 *
 * Pi already writes structured session logs to ~/.pi/agent/sessions/.
 * We don't duplicate them — the symlink is the integration point. If Pi's
 * session schema evolves, `hive ps` / `hive tail` parsers adapt; the log
 * itself stays canonical. Spec §4.7.
 *
 * Note: `ctx.sessionManager.getSessionFile()` returns undefined until Pi
 * persists the first session entry. We therefore subscribe to both
 * `session_start` (mkdir + meta.json, attempt symlink) and `message_end`
 * (idempotent symlink retry once the file exists).
 *
 * RunId format `PI-<compactTs>-<sid8>` uses a distinct prefix from
 * dispatch's `RUN-NNN` so existing `hive ps` filters don't mix the two.
 *
 * Loaded as the canonical source. The runtime copy embedded into the
 * compiled hive binary lives in src/cli.ts's writePiExtensionTempFile().
 * Keep the two in sync — Step 7 consolidates.
 */

import { mkdir, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const HIVE_DIR = process.env.HIVE_DIR || join(homedir(), ".hive");

interface RunMeta {
  runId: string;
  sessionId: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
}

function compactTimestamp(d: Date = new Date()): string {
  // 20260423T184500Z
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function makeRunId(sessionId: string): string {
  return `PI-${compactTimestamp()}-${sessionId.slice(0, 8)}`;
}

export default function hiveObservabilityExtension(pi: ExtensionAPI) {
  let runDir: string | undefined;
  let meta: RunMeta | undefined;
  let symlinkDone = false;

  async function ensureRunDir(sessionId: string, cwd: string): Promise<void> {
    if (runDir) return;
    const runId = makeRunId(sessionId);
    runDir = join(HIVE_DIR, "runs", runId);
    await mkdir(runDir, { recursive: true });
    meta = { runId, sessionId, cwd, startedAt: new Date().toISOString() };
    await writeFile(join(runDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
  }

  async function ensureSymlink(sessionFile: string): Promise<void> {
    if (symlinkDone || !runDir) return;
    try {
      await symlink(sessionFile, join(runDir, "session.jsonl"));
      symlinkDone = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        symlinkDone = true;
        return;
      }
      throw err;
    }
  }

  async function finalizeMeta(): Promise<void> {
    if (!runDir || !meta) return;
    meta.endedAt = new Date().toISOString();
    await writeFile(join(runDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const cwd = ctx.sessionManager.getCwd();
      await ensureRunDir(sessionId, cwd);
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) await ensureSymlink(sessionFile);
    } catch (err) {
      ctx.ui.notify(
        `HIVE observability: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  });

  pi.on("message_end", async (_event, ctx) => {
    if (symlinkDone) return;
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) await ensureSymlink(sessionFile);
    } catch {
      // transient; next message retries
    }
  });

  pi.on("session_shutdown", async () => {
    try {
      await finalizeMeta();
    } catch {
      // best-effort; meta.json without endedAt still readable
    }
  });
}
