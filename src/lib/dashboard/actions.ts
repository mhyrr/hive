/**
 * Dashboard action handlers.
 *
 * Two shapes live here:
 *   1. Pure argv builders for "CLI actions" — functions that take typed
 *      request data and return `{ argv }`. The server serialises each
 *      into a `Bun.spawn([bin, ...argv])` call. Tests assert on argv.
 *   2. Direct-file actions for things the CLI does not do yet
 *      (override-status, inbox-ack, identity-propose, reflection-dismiss).
 *      These take `{ paths, ... }` and perform small file writes. Tests
 *      assert on the resulting filesystem state.
 *
 * Split both kinds into a single module so the server's dispatch table
 * has one import. Never construct a shell string; argv is argv.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { HivePaths } from "../paths";

// ---------------------------------------------------------------------------
// CLI argv builders — pure functions, no I/O
// ---------------------------------------------------------------------------

export type ArgvBuild = { argv: string[] };

export function actionTicketCreate(input: {
  project: string;
  title: string;
  type?: string;      // task | feature | bug | epic | chore
  priority?: number;  // 0..3
  tags?: string[];
  body?: string;
  depends?: string[];
}): ArgvBuild {
  if (!input.project) throw new Error("project is required");
  if (!input.title) throw new Error("title is required");

  const argv = ["ticket", "create", input.title];
  argv.push("--project", input.project);
  if (input.type) argv.push("--type", input.type);
  if (typeof input.priority === "number") argv.push("--priority", String(input.priority));
  if (input.tags?.length) argv.push("--tags", input.tags.join(","));
  if (input.depends?.length) argv.push("--depends", input.depends.join(","));
  // --body is not a first-class flag in `hive ticket create`; the
  // dashboard prefills body via the follow-up `ticket note` call if needed.
  return { argv };
}

export function actionTicketStart(input: { id: string; project?: string }): ArgvBuild {
  requireTicketId(input.id);
  const argv = ["ticket", "start", input.id];
  if (input.project) argv.push("--project", input.project);
  return { argv };
}

export function actionTicketClose(input: { id: string; project?: string }): ArgvBuild {
  requireTicketId(input.id);
  const argv = ["ticket", "close", input.id];
  if (input.project) argv.push("--project", input.project);
  return { argv };
}

export function actionTicketReopen(input: { id: string; project?: string }): ArgvBuild {
  requireTicketId(input.id);
  const argv = ["ticket", "reopen", input.id];
  if (input.project) argv.push("--project", input.project);
  return { argv };
}

export function actionTicketNote(input: {
  id: string;
  note: string;
  project?: string;
}): ArgvBuild {
  requireTicketId(input.id);
  if (!input.note?.trim()) throw new Error("note text is required");
  const argv = ["ticket", "note", input.id, input.note];
  if (input.project) argv.push("--project", input.project);
  return { argv };
}

/** Tag a ticket for auto-dispatch (the `hive ticket dispatch <id>` command). */
export function actionTicketTagDispatch(input: { id: string; project?: string }): ArgvBuild {
  requireTicketId(input.id);
  const argv = ["ticket", "dispatch", input.id];
  if (input.project) argv.push("--project", input.project);
  return { argv };
}

/** Actually dispatch a run for a ticket (the `hive dispatch --ticket <id>` command). */
export function actionTicketDispatchRun(input: { id: string; project?: string }): ArgvBuild {
  requireTicketId(input.id);
  const argv = ["dispatch", "--ticket", input.id];
  if (input.project) argv.push("--project", input.project);
  return { argv };
}

export function actionDispatch(input: { goal: string; project?: string }): ArgvBuild {
  if (!input.goal?.trim()) throw new Error("goal is required");
  const argv = ["dispatch", input.goal];
  if (input.project) argv.push("--project", input.project);
  return { argv };
}

export function actionDispatchKill(input: { runId: string }): ArgvBuild {
  if (!/^RUN-\d+$/.test(input.runId)) throw new Error(`invalid run id: ${input.runId}`);
  return { argv: ["kill", input.runId] };
}

export function actionMemoryPromote(input: {
  kind: "fact" | "convention" | "decision" | "question";
  project: string;
  text: string;
}): ArgvBuild {
  if (!input.project) throw new Error("project is required");
  if (!input.text?.trim()) throw new Error("text is required");
  if (!["fact", "convention", "decision", "question"].includes(input.kind)) {
    throw new Error(`invalid memory kind: ${input.kind}`);
  }
  return { argv: ["memory", input.kind, input.text, "--project", input.project] };
}

// ---------------------------------------------------------------------------
// Direct-file actions — small file writes, no CLI spawn
// ---------------------------------------------------------------------------

const ALLOWED_OVERRIDE_STATUSES = new Set(["complete", "partial", "failed"]);

/**
 * Workaround for TK-041 (dispatch status false-negatives). Writes a
 * terminal status directly to `~/.hive/runs/<runId>/status`. Only
 * accepts statuses from an allowlist so a typo can't permanently
 * corrupt the status file.
 */
export async function actionOverrideStatus(
  paths: HivePaths,
  input: { runId: string; status: string },
): Promise<{ path: string }> {
  if (!/^RUN-\d+$/.test(input.runId)) throw new Error(`invalid run id: ${input.runId}`);
  if (!ALLOWED_OVERRIDE_STATUSES.has(input.status)) {
    throw new Error(`invalid override status: ${input.status}`);
  }
  const statusPath = join(paths.runsDir, input.runId, "status");
  if (!existsSync(dirname(statusPath))) {
    throw new Error(`run not found: ${input.runId}`);
  }
  await writeFile(statusPath, `${input.status}\n`, "utf-8");
  return { path: statusPath };
}

/**
 * Hide an inbox entry for this user. The dashboard hashes the entry
 * body (SHA256, first 16 hex chars) and stores the hash in
 * `~/.hive/projects/<p>/inbox-ack.json` — an array of hashes. The
 * renderer consults this list and drops matching entries.
 *
 * Using a hash (not the full text) keeps the file small and avoids
 * storing user text twice.
 */
export async function actionInboxAck(
  paths: HivePaths,
  input: { project: string; entry: string },
): Promise<{ path: string; hash: string }> {
  if (!input.project?.trim()) throw new Error("project is required");
  if (!input.entry?.trim()) throw new Error("entry text is required");

  const hash = hashEntry(input.entry);
  const ackPath = join(paths.projectsDir, input.project, "inbox-ack.json");
  const existing = await readJsonArray(ackPath);
  if (!existing.includes(hash)) existing.push(hash);
  await mkdir(dirname(ackPath), { recursive: true });
  await writeFile(ackPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  return { path: ackPath, hash };
}

/**
 * File an identity proposal. The dashboard NEVER writes SOUL.md /
 * SELF.md directly — it writes a proposal under
 * `~/.hive/identity-proposals/YYYY-MM-DD-<slug>.md` for a separate
 * terminal review pass.
 */
export async function actionIdentityPropose(
  paths: HivePaths,
  input: { text: string; source?: string; now?: Date },
): Promise<{ path: string; slug: string }> {
  if (!input.text?.trim()) throw new Error("proposal text is required");

  const now = input.now ?? new Date();
  const date = now.toISOString().slice(0, 10);
  const slug = slugify(input.text).slice(0, 40).replace(/-+$/, "") || "proposal";
  const proposalsDir = join(paths.home, "identity-proposals");
  const path = join(proposalsDir, `${date}-${slug}.md`);

  const body = [
    `---`,
    `proposed: ${now.toISOString()}`,
    `source: ${JSON.stringify(input.source ?? "dashboard")}`,
    `approved: false`,
    `---`,
    ``,
    input.text.trim(),
    ``,
  ].join("\n");

  await mkdir(proposalsDir, { recursive: true });
  await writeFile(path, body, "utf-8");
  return { path, slug };
}

/**
 * Hide a reflection from the dashboard. Appends the reflection's hash
 * to `~/.hive/reflections/_dismissed.json`. The dashboard filters the
 * reflections list against this set on render.
 */
export async function actionReflectionDismiss(
  paths: HivePaths,
  input: { reflection: string },
): Promise<{ path: string; hash: string }> {
  if (!input.reflection?.trim()) throw new Error("reflection text is required");
  const hash = hashEntry(input.reflection);
  const dismissPath = join(paths.reflectionsDir, "_dismissed.json");
  const existing = await readJsonArray(dismissPath);
  if (!existing.includes(hash)) existing.push(hash);
  await mkdir(dirname(dismissPath), { recursive: true });
  await writeFile(dismissPath, JSON.stringify(existing, null, 2) + "\n", "utf-8");
  return { path: dismissPath, hash };
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function requireTicketId(id: string | undefined | null): void {
  if (!id || !/^TK-\d+$/.test(id)) {
    throw new Error(`invalid ticket id: ${String(id)}`);
  }
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function hashEntry(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
}

async function readJsonArray(path: string): Promise<string[]> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}
