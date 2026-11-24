import { UsageError } from "../lib/errors";
import { assembleIdentity } from "../lib/identity";
import {
  addCandidates,
  approveCandidate,
  declineCandidate,
  isIdentityTarget,
  listPendingCandidates,
  pendingCandidateLines,
} from "../lib/identity-candidates";
import { ensureHiveScaffold } from "../lib/paths";
import { toDateLabel } from "../lib/time";
import type { Harness } from "../lib/stack";

const VALID_HARNESSES: ReadonlySet<Harness> = new Set(["claude", "codex", "pi", "cursor"]);

export async function identityCommand(args: string[]): Promise<void> {
  const usage = `Usage:
  hive identity emit [--harness claude|codex|pi|cursor] [--persona <name>]
      Print the canonical identity prefix to stdout. Used by the SessionStart
      hook so every interactive harness shares one source
      of truth. --harness only affects stack-hint wording (Codex has no Skill
      tool, so it gets a direct "read the file" variant). Defaults to claude.
      --persona selects the swappable register from ~/.hive/personas/<name>.md
      (falls back to HIVE_PERSONA env, then dry). emit is an interactive
      path, so it always includes the persona slot.

  hive identity candidates
      List identity candidates waiting on an answer. Pass P files them; each
      stays pending until it is approved or declined (TK-157).
  hive identity approve <id> [--text "edited wording"]
      Append the candidate to its target file (IDENTITY.md or SELF.md), then
      drop it from the pending list. --text applies your wording instead.
  hive identity decline <id> [--reason "why"]
      Drop the candidate. The answer is logged in identity-candidates.log.
  hive identity propose --target IDENTITY.md|SELF.md [--project <name>] "<text>"
      File a candidate by hand, for example one recovered from git.`;

  const subcommand = args[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    console.log(usage);
    return;
  }

  if (subcommand === "candidates" || subcommand === "approve" || subcommand === "decline" || subcommand === "propose") {
    await candidatesSubcommand(subcommand, args.slice(1), usage);
    return;
  }

  if (subcommand !== "emit") {
    throw new UsageError(`Unknown subcommand: ${subcommand}\n\n${usage}`);
  }

  let harness: Harness | undefined;
  let persona: string | undefined;
  const rest = args.slice(1);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--harness" && rest[i + 1]) {
      const value = rest[++i]!;
      if (!VALID_HARNESSES.has(value as Harness)) {
        throw new UsageError(`Unknown harness '${value}'. Valid: claude, codex, pi, cursor.`);
      }
      harness = value as Harness;
    } else if (arg === "--persona" && rest[i + 1]) {
      persona = rest[++i]!;
    } else if (arg.startsWith("--persona=")) {
      persona = arg.slice("--persona=".length);
    } else {
      throw new UsageError(`Unknown flag: ${arg}\n\n${usage}`);
    }
  }

  const content = await assembleIdentity({ harness, includePersona: true, persona });
  process.stdout.write(content);
}

function takeFlag(rest: string[], flag: string): string | undefined {
  const i = rest.indexOf(flag);
  if (i === -1) return undefined;
  const value = rest[i + 1];
  if (value === undefined) throw new UsageError(`${flag} needs a value.`);
  rest.splice(i, 2);
  return value;
}

async function candidatesSubcommand(subcommand: string, args: string[], usage: string): Promise<void> {
  const paths = await ensureHiveScaffold();
  const rest = [...args];

  if (subcommand === "candidates") {
    const pending = await listPendingCandidates(paths);
    if (pending.length === 0) {
      console.log("No identity candidates pending.");
      return;
    }
    console.log(pendingCandidateLines(pending).join("\n"));
    return;
  }

  if (subcommand === "propose") {
    const target = takeFlag(rest, "--target");
    const project = takeFlag(rest, "--project") ?? null;
    const text = rest.join(" ").trim();
    if (!target || !isIdentityTarget(target)) {
      throw new UsageError(`propose needs --target IDENTITY.md or --target SELF.md.\n\n${usage}`);
    }
    if (!text) throw new UsageError(`propose needs the candidate text.\n\n${usage}`);
    const added = await addCandidates(paths, [
      { target, text, date: toDateLabel(), project, source: "cli" },
    ]);
    if (added.length === 0) {
      console.log("Already pending.");
      return;
    }
    console.log(`Pending ${added[0]!.id} → ${target}.`);
    return;
  }

  const appliedText = subcommand === "approve" ? takeFlag(rest, "--text") : undefined;
  const reason = subcommand === "decline" ? takeFlag(rest, "--reason") : undefined;
  const id = rest[0];
  if (!id || rest.length > 1) {
    throw new UsageError(`${subcommand} needs exactly one candidate id.\n\n${usage}`);
  }

  try {
    if (subcommand === "approve") {
      const r = await approveCandidate(paths, id, { text: appliedText });
      console.log(`Approved ${r.candidate.id}. Appended to ${r.appliedTo}.`);
    } else {
      const r = await declineCandidate(paths, id, { reason });
      console.log(`Declined ${r.candidate.id}. Logged in identity-candidates.log.`);
    }
  } catch (err) {
    if (err instanceof Error && /^No pending|matches \d+ candidates/.test(err.message)) {
      throw new UsageError(err.message);
    }
    throw err;
  }
}
