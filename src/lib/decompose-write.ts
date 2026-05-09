// Writer: translates a validated decompose proposal into actual tickets.
//
// Behavior:
//   - children.length === 1: no epic; the child is created as a standalone
//   - children.length === 2: no epic; both children created with deps wired
//   - children.length 3-10: epic first, then children in topological order
//
// The LLM emits placeholder refs (C1, C2, …). We map them to real TK-NNN
// IDs as we create tickets. Topological order ensures createTicket's
// "deps must exist" guard never fires.

import { join } from "node:path";

import type { HivePaths } from "./paths";
import {
  createTicket,
  ticketsDir,
  type TicketPriority,
} from "./ticket";
import type { Proposal } from "./decompose";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WriteShape = "epic-with-children" | "single-ticket" | "pair";

export type WriteResult = {
  shape: WriteShape;
  epicId: string | null;
  // ref placeholder → TK-NNN. Includes "EPIC" for the epic when present.
  refMap: Record<string, string>;
  childIds: string[];
  edges: Array<{ from: string; to: string }>;
};

export type DryRunResult = WriteResult & { dryRun: true };

export type WriteOptions = {
  priority?: TicketPriority;
  dryRun?: boolean;
};

// ---------------------------------------------------------------------------
// Topological sort over placeholder refs
// ---------------------------------------------------------------------------

export function topologicalOrder(proposal: Proposal): string[] {
  const refs = proposal.children.map((c) => c.ref);
  const incoming = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const r of refs) {
    incoming.set(r, 0);
    adj.set(r, []);
  }

  for (const c of proposal.children) {
    for (const dep of c.depends) {
      // dep -> c.ref is the edge: dep must exist before c
      adj.get(dep)?.push(c.ref);
      incoming.set(c.ref, (incoming.get(c.ref) ?? 0) + 1);
    }
  }

  const order: string[] = [];
  // Stable starting set: zero-incoming refs in the order they were defined.
  const ready = refs.filter((r) => (incoming.get(r) ?? 0) === 0);

  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const n of adj.get(next) ?? []) {
      incoming.set(n, (incoming.get(n) ?? 0) - 1);
      if ((incoming.get(n) ?? 0) === 0) ready.push(n);
    }
  }

  if (order.length !== refs.length) {
    // Validator should have caught a cycle; defensive.
    throw new Error(
      "Topological order failed — proposal contains a cycle that escaped validation.",
    );
  }
  return order;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export async function writeProposal(
  paths: HivePaths,
  projectId: string,
  proposal: Proposal,
  options: WriteOptions = {},
): Promise<WriteResult> {
  const priority = options.priority ?? 2;
  const order = topologicalOrder(proposal);
  const refMap: Record<string, string> = {};

  if (proposal.children.length === 0) {
    throw new Error("Cannot write a proposal with zero children.");
  }

  // Decide shape — single, pair, or epic+children.
  const shape: WriteShape =
    proposal.children.length === 1
      ? "single-ticket"
      : proposal.children.length === 2
      ? "pair"
      : "epic-with-children";

  if (options.dryRun) {
    return computeDryRun(proposal, order, shape, priority);
  }

  let epicId: string | null = null;

  if (shape === "epic-with-children") {
    const epicTicket = await createTicket(paths, projectId, {
      title: proposal.epic.title,
      body: renderEpicBody(proposal),
      type: "epic",
      priority,
      tags: proposal.epic.tags,
    });
    epicId = epicTicket.id;
    refMap["EPIC"] = epicId;
  }

  // Create children in topological order so depends references resolve.
  const childIds: string[] = [];
  for (const ref of order) {
    const child = proposal.children.find((c) => c.ref === ref)!;
    const realDeps = child.depends.map((d) => refMap[d]).filter(Boolean) as string[];
    const ticket = await createTicket(paths, projectId, {
      title: child.title,
      body: child.body,
      type: child.type,
      priority,
      tags: child.tags,
      depends: realDeps,
      parentEpic: epicId ?? undefined,
    });
    refMap[ref] = ticket.id;
    childIds.push(ticket.id);
  }

  const edges = collectEdges(proposal, refMap);

  // After all children exist, rewrite the epic body so its Children section
  // names real TK-NNN ids instead of the placeholder C1/C2 refs.
  if (epicId) {
    await substituteEpicBody(paths, projectId, epicId, proposal, refMap);
  }

  return { shape, epicId, refMap, childIds, edges };
}

// Read the epic ticket back, replace the placeholder-ref Children list with
// real TK-NNN ids, and write it back. Idempotent — running twice is a no-op.
async function substituteEpicBody(
  paths: HivePaths,
  projectId: string,
  epicId: string,
  proposal: Proposal,
  refMap: Record<string, string>,
): Promise<void> {
  const file = Bun.file(join(ticketsDir(paths, projectId), `${epicId}.md`));
  const raw = await file.text();

  // Build a fresh Children block with real ids.
  const childList = proposal.children
    .map((c) => {
      const realId = refMap[c.ref] ?? c.ref;
      const realDeps = c.depends
        .map((d) => refMap[d] ?? d)
        .join(", ");
      const depsStr = realDeps ? ` (depends on ${realDeps})` : "";
      return `- ${realId} — ${c.title}${depsStr}`;
    })
    .join("\n");

  // Replace whatever Children section exists, or append if missing.
  let body: string;
  const childrenHeaderRe = /(^|\n)## Children\s*\n[\s\S]*?(?=\n## |$)/;
  if (childrenHeaderRe.test(raw)) {
    body = raw.replace(
      childrenHeaderRe,
      (match, lead) => `${lead}## Children\n${childList}\n`,
    );
  } else {
    body = `${raw.trimEnd()}\n\n## Children\n${childList}\n`;
  }

  await Bun.write(file, body);
}

// ---------------------------------------------------------------------------
// Dry run — compute what would have been written, with synthetic IDs
// ---------------------------------------------------------------------------

function computeDryRun(
  proposal: Proposal,
  order: string[],
  shape: WriteShape,
  _priority: TicketPriority,
): DryRunResult {
  const refMap: Record<string, string> = {};
  let counter = 1;
  if (shape === "epic-with-children") {
    refMap["EPIC"] = `TK-DRY-${String(counter++).padStart(2, "0")}`;
  }
  const childIds: string[] = [];
  for (const ref of order) {
    const id = `TK-DRY-${String(counter++).padStart(2, "0")}`;
    refMap[ref] = id;
    childIds.push(id);
  }
  const edges = collectEdges(proposal, refMap);
  return {
    dryRun: true,
    shape,
    epicId: refMap["EPIC"] ?? null,
    refMap,
    childIds,
    edges,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderEpicBody(proposal: Proposal): string {
  const body = proposal.epic.body.trim();
  // If the LLM didn't include a Children section, append a plain list.
  if (/##\s+Children/i.test(body)) return body;
  const childList = proposal.children
    .map((c) => {
      const deps =
        c.depends.length > 0 ? ` (depends on ${c.depends.join(", ")})` : "";
      return `- ${c.ref} — ${c.title}${deps}`;
    })
    .join("\n");
  return `${body}\n\n## Children\n${childList}`;
}

function collectEdges(
  proposal: Proposal,
  refMap: Record<string, string>,
): Array<{ from: string; to: string }> {
  const edges: Array<{ from: string; to: string }> = [];
  for (const c of proposal.children) {
    const childId = refMap[c.ref];
    if (!childId) continue;
    for (const dep of c.depends) {
      const depId = refMap[dep];
      if (!depId) continue;
      edges.push({ from: depId, to: childId });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Render — human-readable tree of the result
// ---------------------------------------------------------------------------

export function renderWriteResult(result: WriteResult): string {
  const lines: string[] = [];
  if (result.shape === "epic-with-children" && result.epicId) {
    lines.push(`Epic: ${result.epicId}`);
    for (const childId of result.childIds) {
      const incoming = result.edges
        .filter((e) => e.to === childId)
        .map((e) => e.from);
      const dep = incoming.length > 0 ? `  (deps: ${incoming.join(", ")})` : "";
      lines.push(`  - ${childId}${dep}`);
    }
  } else if (result.shape === "single-ticket") {
    lines.push(`Single ticket: ${result.childIds[0]}`);
    lines.push(`(decomposed to one ticket — smaller than typical)`);
  } else {
    lines.push(`Pair:`);
    for (const childId of result.childIds) {
      const incoming = result.edges
        .filter((e) => e.to === childId)
        .map((e) => e.from);
      const dep = incoming.length > 0 ? `  (deps: ${incoming.join(", ")})` : "";
      lines.push(`  - ${childId}${dep}`);
    }
    lines.push(`(decomposed to two tickets — smaller than typical, no epic)`);
  }
  return lines.join("\n");
}
