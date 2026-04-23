/**
 * HIVE trust extension for Pi.
 *
 * Implements the TRUST.md action-class ladder:
 *   - internal-safe  → no-op pass through
 *   - code-safe      → block write/edit of protected paths; confirm session-switch
 *                      in a dirty repo
 *   - external-gated → prompt (or block in non-UI) on dangerous bash (rm -rf, sudo,
 *                      chmod 777), push/PR/deploy, hook-skipping flags;
 *                      confirm on session clear
 *   - forbidden      → hard block with loud reason: rm -rf / or $HOME,
 *                      force-push to main/master
 *
 * Patterns ported from pi-mono's in-tree safety examples
 * (permission-gate, protected-paths, confirm-destructive, dirty-repo-guard).
 * HIVE-specific additions: ~/.hive/memory and ~/.hive/projects are protected
 * against raw write/edit — those paths should only be mutated via HIVE MCP
 * tools (write_hive_memory, create_ticket, …) so BM25 indices and ticket
 * metadata stay coherent.
 *
 * Non-UI sessions (--print, RPC) block gated ops instead of prompting: there's
 * no safe default when we can't ask. Forbidden ops block in both modes.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const PROTECTED_PATH_SUBSTRINGS = [
  ".env",
  "/.git/",
  "/node_modules/",
  "/.ssh/",
  "/.aws/",
  "/.hive/memory/",
  "/.hive/projects/",
];

interface PatternRule {
  pattern: RegExp;
  reason: string;
}

const FORBIDDEN_PATTERNS: PatternRule[] = [
  { pattern: /^\s*rm\s+-rf\s+\/(\s|$)/, reason: "rm -rf / (filesystem root)" },
  { pattern: /^\s*rm\s+-rf\s+(~|\$HOME)(\s|\/|$)/, reason: "rm -rf on $HOME" },
  {
    pattern: /\bgit\s+push\s+(-f|--force|--force-with-lease)\s+\S+\s+(main|master)\b/i,
    reason: "force-push to main/master",
  },
];

const EXTERNAL_GATED_PATTERNS: PatternRule[] = [
  { pattern: /^\s*git\s+push(\s|$)/i, reason: "git push" },
  { pattern: /^\s*gh\s+(pr|issue)\s+(create|merge|close|review|comment)(\s|$)/i, reason: "gh PR/issue mutation" },
  { pattern: /^\s*(fly|flyctl)\s+deploy(\s|$)/i, reason: "fly.io deploy" },
  { pattern: /^\s*vercel\s+(deploy|--prod)(\s|$)/i, reason: "Vercel deploy" },
  { pattern: /^\s*gcloud\s+deploy(\s|$)/i, reason: "gcloud deploy" },
  { pattern: /^\s*kubectl\s+(apply|delete|create)(\s|$)/i, reason: "kubectl mutation" },
  { pattern: /^\s*(npm|pnpm|yarn)\s+publish(\s|$)/i, reason: "package publish" },
  { pattern: /\b--no-verify\b/i, reason: "skip git hooks (--no-verify)" },
  { pattern: /\b--no-gpg-sign\b/i, reason: "skip GPG signing" },
  { pattern: /\brm\s+(-rf?|--recursive)/i, reason: "recursive rm" },
  { pattern: /\bsudo\b/i, reason: "sudo" },
  { pattern: /\b(chmod|chown)\b.*\b777\b/i, reason: "chmod/chown 777" },
];

function classifyBash(command: string): { cls: "forbidden" | "external" | "ok"; reason: string } {
  for (const { pattern, reason } of FORBIDDEN_PATTERNS) {
    if (pattern.test(command)) return { cls: "forbidden", reason };
  }
  for (const { pattern, reason } of EXTERNAL_GATED_PATTERNS) {
    if (pattern.test(command)) return { cls: "external", reason };
  }
  return { cls: "ok", reason: "" };
}

async function dirtyRepoGate(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  action: string,
): Promise<{ cancel: boolean } | undefined> {
  const { stdout, code } = await pi.exec("git", ["status", "--porcelain"]);
  if (code !== 0) return;
  const changed = stdout.trim();
  if (!changed) return;
  if (!ctx.hasUI) return { cancel: true };
  const count = changed.split("\n").filter(Boolean).length;
  const choice = await ctx.ui.select(
    `${count} uncommitted file(s). ${action} anyway?`,
    ["Yes, proceed", "No, commit first"],
  );
  if (choice !== "Yes, proceed") {
    ctx.ui.notify("Commit your changes first", "warning");
    return { cancel: true };
  }
}

export default function hiveTrustExtension(pi: ExtensionAPI) {
  // --- code-safe: block write/edit of protected paths
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
    const input = event.input as { path?: string };
    const path = input.path ?? "";
    const hit = PROTECTED_PATH_SUBSTRINGS.find((p) => path.includes(p));
    if (hit) {
      const msg = `HIVE trust: blocked ${event.toolName} of protected path ${path} (${hit})`;
      if (ctx.hasUI) ctx.ui.notify(msg, "warning");
      return { block: true, reason: msg };
    }
    return undefined;
  });

  // --- external-gated + forbidden: classify bash commands
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = ((event.input as { command?: string }).command ?? "").trim();
    if (!command) return undefined;
    const { cls, reason } = classifyBash(command);
    if (cls === "ok") return undefined;
    if (cls === "forbidden") {
      const msg = `HIVE trust: forbidden (${reason})`;
      if (ctx.hasUI) ctx.ui.notify(`${msg}: ${command}`, "error");
      return { block: true, reason: msg };
    }
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `HIVE trust: external-gated action blocked — no UI for confirmation (${reason})`,
      };
    }
    const choice = await ctx.ui.select(
      `⚠️ External-gated action (${reason}):\n\n  ${command}\n\nAllow?`,
      ["Yes", "No"],
    );
    if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
    return undefined;
  });

  // --- code-safe: session switch/fork with a dirty repo needs confirmation
  pi.on("session_before_switch", async (event, ctx) => {
    return dirtyRepoGate(pi, ctx, event.reason === "new" ? "clear session" : "switch session");
  });
  pi.on("session_before_fork", async (_event, ctx) => {
    return dirtyRepoGate(pi, ctx, "fork session");
  });

  // --- external-gated: explicit confirm on session clear (in addition to dirty-repo check)
  pi.on("session_before_switch", async (event, ctx) => {
    if (!ctx.hasUI || event.reason !== "new") return;
    const confirmed = await ctx.ui.confirm("Clear session?", "This deletes all messages in the current session.");
    if (!confirmed) {
      ctx.ui.notify("Clear cancelled", "info");
      return { cancel: true };
    }
  });
}
