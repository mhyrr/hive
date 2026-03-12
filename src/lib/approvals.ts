import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { UsageError } from "./errors";
import { appendEvent } from "./events";
import { appendFeedEntry } from "./feed";
import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";
import { ensureDirectory, type HivePaths } from "./paths";
import { now, toCompactTimestamp, toIsoTimestamp } from "./time";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type ApprovalRequest = {
  id: string;
  status: ApprovalStatus;
  kind: string;
  project: string | null;
  requestedBy: string;
  resolvedBy: string | null;
  created: string;
  resolved: string | null;
  summary: string;
  note: string | null;
  path: string;
  body: string;
};

function normalizeApprovalKind(kind: string): string {
  const normalized = kind.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new UsageError("Approval kind must contain letters or numbers.");
  }

  return normalized;
}

function approvalPath(paths: HivePaths, status: "pending" | "resolved", id: string): string {
  return join(status === "pending" ? paths.approvalsPendingDir : paths.approvalsResolvedDir, `${id}.md`);
}

function toApprovalRequest(path: string, raw: string): ApprovalRequest | null {
  const parsed = parseFrontmatter(raw);
  const attrs = parsed.attributes;
  const id = attrs.id;
  const status = attrs.status as ApprovalStatus | undefined;
  const kind = attrs.kind;
  const created = attrs.created;
  const summary = attrs.summary;
  const requestedBy = attrs["requested-by"];

  if (!id || !status || !kind || !created || !summary || !requestedBy) {
    return null;
  }

  return {
    id,
    status,
    kind,
    project: attrs.project ?? null,
    requestedBy,
    resolvedBy: attrs["resolved-by"] ?? null,
    created,
    resolved: attrs.resolved ?? null,
    summary,
    note: attrs.note ?? null,
    path,
    body: parsed.body,
  };
}

async function readApproval(path: string): Promise<ApprovalRequest | null> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return null;
  }

  return toApprovalRequest(path, await file.text());
}

async function nextApprovalId(paths: HivePaths, kind: string): Promise<string> {
  const base = `${toCompactTimestamp(now())}-${normalizeApprovalKind(kind)}`;
  let candidate = base;
  let counter = 2;

  while (
    await Bun.file(approvalPath(paths, "pending", candidate)).exists() ||
    await Bun.file(approvalPath(paths, "resolved", candidate)).exists()
  ) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }

  return candidate;
}

function renderApprovalBody(input: { summary: string; note?: string | null }): string {
  const parts = [
    "## Summary",
    input.summary.trim(),
  ];

  if (input.note?.trim()) {
    parts.push("", "## Note", input.note.trim());
  }

  return parts.join("\n");
}

function toFrontmatter(input: {
  id: string;
  status: ApprovalStatus;
  kind: string;
  project: string | null;
  requestedBy: string;
  resolvedBy?: string | null;
  created: string;
  resolved?: string | null;
  summary: string;
  note?: string | null;
}): Record<string, string> {
  const attrs: Record<string, string> = {
    id: input.id,
    status: input.status,
    kind: normalizeApprovalKind(input.kind),
    "requested-by": input.requestedBy,
    created: input.created,
    summary: input.summary.trim(),
  };

  if (input.project) {
    attrs.project = input.project;
  }

  if (input.resolvedBy) {
    attrs["resolved-by"] = input.resolvedBy;
  }

  if (input.resolved) {
    attrs.resolved = input.resolved;
  }

  if (input.note?.trim()) {
    attrs.note = input.note.trim();
  }

  return attrs;
}

export async function createApprovalRequest(input: {
  paths: HivePaths;
  kind: string;
  summary: string;
  note?: string | null;
  project?: string | null;
  requestedBy?: string;
}): Promise<ApprovalRequest> {
  await ensureDirectory(input.paths.approvalsPendingDir);
  await ensureDirectory(input.paths.approvalsResolvedDir);

  const id = await nextApprovalId(input.paths, input.kind);
  const created = toIsoTimestamp();
  const path = approvalPath(input.paths, "pending", id);
  const attrs = toFrontmatter({
    id,
    status: "pending",
    kind: input.kind,
    project: input.project ?? null,
    requestedBy: input.requestedBy ?? "human",
    created,
    summary: input.summary,
    note: input.note ?? null,
  });
  const body = renderApprovalBody({
    summary: input.summary,
    note: input.note ?? null,
  });

  await Bun.write(path, stringifyFrontmatter(attrs, body));

  await appendFeedEntry(input.paths, {
    project: input.project ?? null,
    headline: `Approval requested: ${normalizeApprovalKind(input.kind)}`,
    details: [
      `id: ${id}`,
      `summary: ${input.summary.trim()}`,
    ],
  });

  await appendEvent({
    paths: input.paths,
    kind: "approval.requested",
    source: "approval",
    project: input.project ?? null,
    summary: input.summary,
    details: [
      `kind: ${normalizeApprovalKind(input.kind)}`,
      `requested-by: ${input.requestedBy ?? "human"}`,
      `id: ${id}`,
    ],
    data: {
      approvalId: id,
      approvalKind: normalizeApprovalKind(input.kind),
      requestedBy: input.requestedBy ?? "human",
    },
  });

  return (await readApproval(path))!;
}

export async function listApprovals(
  paths: HivePaths,
  status: "pending" | "resolved" = "pending",
): Promise<ApprovalRequest[]> {
  const dir = status === "pending" ? paths.approvalsPendingDir : paths.approvalsResolvedDir;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const approvals: ApprovalRequest[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const approval = await readApproval(join(dir, entry.name));

    if (approval) {
      approvals.push(approval);
    }
  }

  return approvals.sort((a, b) => b.created.localeCompare(a.created));
}

export async function getApproval(paths: HivePaths, id: string): Promise<ApprovalRequest | null> {
  return (
    await readApproval(approvalPath(paths, "pending", id)) ||
    await readApproval(approvalPath(paths, "resolved", id))
  );
}

export async function resolveApproval(input: {
  paths: HivePaths;
  id: string;
  status: "approved" | "rejected";
  resolvedBy?: string;
  note?: string | null;
}): Promise<ApprovalRequest> {
  const existing = await readApproval(approvalPath(input.paths, "pending", input.id));

  if (!existing) {
    throw new UsageError(`Approval not found or already resolved: ${input.id}`);
  }

  const resolved = toIsoTimestamp();
  const nextPath = approvalPath(input.paths, "resolved", input.id);
  const attrs = toFrontmatter({
    id: existing.id,
    status: input.status,
    kind: existing.kind,
    project: existing.project,
    requestedBy: existing.requestedBy,
    resolvedBy: input.resolvedBy ?? "human",
    created: existing.created,
    resolved,
    summary: existing.summary,
    note: input.note ?? existing.note,
  });
  const body = renderApprovalBody({
    summary: existing.summary,
    note: input.note ?? existing.note,
  });

  await Bun.write(existing.path, stringifyFrontmatter(attrs, body));
  await ensureDirectory(input.paths.approvalsResolvedDir);
  await rename(existing.path, nextPath);

  await appendFeedEntry(input.paths, {
    project: existing.project,
    headline: `Approval ${input.status}: ${existing.kind}`,
    details: [
      `id: ${existing.id}`,
      `summary: ${existing.summary}`,
      ...(input.note?.trim() ? [`note: ${input.note.trim()}`] : []),
    ],
  });

  await appendEvent({
    paths: input.paths,
    kind: "approval.resolved",
    source: "approval",
    project: existing.project,
    summary: existing.summary,
    details: [
      `kind: ${existing.kind}`,
      `status: ${input.status}`,
      `resolved-by: ${input.resolvedBy ?? "human"}`,
      `id: ${existing.id}`,
      ...(input.note?.trim() ? [`note: ${input.note.trim()}`] : []),
    ],
    data: {
      approvalId: existing.id,
      approvalKind: existing.kind,
      status: input.status,
      resolvedBy: input.resolvedBy ?? "human",
    },
  });

  return (await readApproval(nextPath))!;
}

export function formatApprovalList(
  approvals: ApprovalRequest[],
  status: "pending" | "resolved" = "pending",
): string {
  const title = status === "pending" ? "Pending approvals" : "Resolved approvals";

  if (approvals.length === 0) {
    return `# Approval Queue\n\n${title}: 0\n\n(none)`;
  }

  return [
    "# Approval Queue",
    "",
    `${title}: ${approvals.length}`,
    "",
    ...approvals.map((approval) =>
      `- ${approval.id} [${approval.kind}]${approval.project ? ` [${approval.project}]` : ""} ${approval.summary}`,
    ),
  ].join("\n");
}

export function formatApproval(approval: ApprovalRequest): string {
  const lines = [
    `Approval: ${approval.id}`,
    `Status: ${approval.status}`,
    `Kind: ${approval.kind}`,
    `Project: ${approval.project ?? "(none)"}`,
    `Requested by: ${approval.requestedBy}`,
    `Created: ${approval.created}`,
  ];

  if (approval.resolved) {
    lines.push(`Resolved: ${approval.resolved}`);
  }

  if (approval.resolvedBy) {
    lines.push(`Resolved by: ${approval.resolvedBy}`);
  }

  lines.push("", approval.body.trim() || approval.summary);

  return lines.join("\n");
}
