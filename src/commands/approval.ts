import { UsageError } from "../lib/errors";
import { createApprovalRequest, formatApproval, formatApprovalList, getApproval, listApprovals, resolveApproval } from "../lib/approvals";
import { ensureHiveScaffold, getActiveProject } from "../lib/paths";

export async function approvalCommand(args: string[]): Promise<string> {
  const paths = await ensureHiveScaffold();
  const [action, ...rest] = args;

  if (!action) {
    return formatApprovalList(await listApprovals(paths, "pending"));
  }

  if (action === "resolved") {
    return formatApprovalList(await listApprovals(paths, "resolved"), "resolved");
  }

  if (action === "show") {
    const [id] = rest;

    if (!id) {
      throw new UsageError("Usage: hive approval show <id>");
    }

    const approval = await getApproval(paths, id);

    if (!approval) {
      throw new UsageError(`Approval not found: ${id}`);
    }

    return formatApproval(approval);
  }

  if (action === "request") {
    const [kind, ...summaryParts] = rest;
    const summary = summaryParts.join(" ").trim();

    if (!kind || !summary) {
      throw new UsageError("Usage: hive approval request <kind> <summary>");
    }

    const approval = await createApprovalRequest({
      paths,
      kind,
      summary,
      project: await getActiveProject(paths),
      requestedBy: "human",
    });

    return `Created approval request ${approval.id}
Kind: ${approval.kind}
Project: ${approval.project ?? "(none)"}
Summary: ${approval.summary}`;
  }

  if (action === "approve" || action === "reject") {
    const [id, ...noteParts] = rest;

    if (!id) {
      throw new UsageError(`Usage: hive approval ${action} <id> [note]`);
    }

    const approval = await resolveApproval({
      paths,
      id,
      status: action === "approve" ? "approved" : "rejected",
      resolvedBy: "human",
      note: noteParts.join(" ").trim() || null,
    });

    return `${action === "approve" ? "Approved" : "Rejected"} ${approval.id}: ${approval.summary}`;
  }

  throw new UsageError(
    "Unknown approval action. Use: request, show, approve, reject, resolved",
  );
}
