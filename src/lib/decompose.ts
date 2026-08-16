// TK-036 — goal decomposition primitive.
//
// Turns a rough goal into an epic + 3-10 child tickets with a valid DAG.
// LLM-driven decompose, LLM-driven orient on failure, deterministic validate.
// The TK-036 ticket body remains the behavioral source for validation and
// recovery-loop decisions.

import type { TicketType, TicketPriority } from "./ticket";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProposalEpic = {
  title: string;
  body: string;
  tags: string[];
};

export type ProposalChild = {
  ref: string;          // placeholder ID emitted by the LLM (e.g. "CHILD-1")
  title: string;
  body: string;         // pre-rendered markdown (Scope/Acceptance/Notes)
  type: TicketType;
  tags: string[];
  depends: string[];    // placeholder refs into other children
};

export type Proposal = {
  epic: ProposalEpic;
  children: ProposalChild[];
};

export type ProposalFailure =
  | { kind: "json-parse"; message: string; rawSnippet: string }
  | { kind: "schema"; message: string }
  | { kind: "duplicate-ref"; ref: string }
  | { kind: "self-reference"; ref: string }
  | { kind: "missing-ref"; from: string; to: string }
  | { kind: "cycle"; path: string[] }
  | { kind: "count-too-high"; count: number; ceiling: number };

export type ValidationResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; failures: ProposalFailure[]; partial?: Proposal };

export type OrientDecision =
  | { decision: "retry-with-reframe"; reframe: string }
  | { decision: "accept-with-warn"; warning: string }
  | { decision: "abort"; reason: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const COUNT_CEILING = 10;
const VALID_TICKET_TYPES: ReadonlyArray<TicketType> = [
  "bug",
  "feature",
  "task",
  "epic",
  "chore",
];

// ---------------------------------------------------------------------------
// JSON parsing — tolerant of code-fenced output ("```json ... ```")
// ---------------------------------------------------------------------------

export function extractJson(raw: string): string {
  const trimmed = raw.trim();
  // <json>{...}</json> — the decompose prompt's preferred wrapper. Lets the
  // <analysis> block carry plan-then-emit reasoning without contaminating JSON.
  const tagMatch = trimmed.match(/<json>\s*([\s\S]*?)\s*<\/json>/i);
  if (tagMatch && tagMatch[1]) return tagMatch[1].trim();
  // Code-fenced: ```json\n{...}\n``` or ```\n{...}\n```
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenceMatch && fenceMatch[1]) return fenceMatch[1].trim();
  // Bare JSON object
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

export function parseProposal(raw: string): ValidationResult {
  const candidate = extractJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    return {
      ok: false,
      failures: [
        {
          kind: "json-parse",
          message: err instanceof Error ? err.message : String(err),
          rawSnippet: candidate.slice(0, 400),
        },
      ],
    };
  }

  return validateSchema(parsed);
}

// ---------------------------------------------------------------------------
// Schema validation — narrow `unknown` into Proposal
// ---------------------------------------------------------------------------

function validateSchema(input: unknown): ValidationResult {
  const failures: ProposalFailure[] = [];

  if (!input || typeof input !== "object") {
    return {
      ok: false,
      failures: [{ kind: "schema", message: "Top-level value must be an object." }],
    };
  }

  const obj = input as Record<string, unknown>;
  const epicRaw = obj.epic;
  const childrenRaw = obj.children;

  if (!epicRaw || typeof epicRaw !== "object") {
    failures.push({ kind: "schema", message: "Missing or non-object 'epic'." });
  }
  if (!Array.isArray(childrenRaw)) {
    failures.push({ kind: "schema", message: "Missing or non-array 'children'." });
  }
  if (failures.length > 0) return { ok: false, failures };

  const epic = epicRaw as Record<string, unknown>;
  const children = childrenRaw as unknown[];

  const epicTitle = typeof epic.title === "string" ? epic.title.trim() : "";
  const epicBody = typeof epic.body === "string" ? epic.body : "";
  const epicTags = Array.isArray(epic.tags)
    ? (epic.tags as unknown[]).filter((t): t is string => typeof t === "string")
    : [];

  if (!epicTitle) {
    failures.push({ kind: "schema", message: "epic.title is required." });
  }

  const proposalChildren: ProposalChild[] = [];
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (!c || typeof c !== "object") {
      failures.push({ kind: "schema", message: `children[${i}] is not an object.` });
      continue;
    }
    const obj = c as Record<string, unknown>;
    const ref = typeof obj.ref === "string" ? obj.ref.trim() : "";
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    const body = typeof obj.body === "string" ? obj.body : "";
    const typeRaw = typeof obj.type === "string" ? obj.type.trim() : "task";
    const type = (VALID_TICKET_TYPES as readonly string[]).includes(typeRaw)
      ? (typeRaw as TicketType)
      : "task";
    const tags = Array.isArray(obj.tags)
      ? (obj.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const depends = Array.isArray(obj.depends)
      ? (obj.depends as unknown[]).filter((d): d is string => typeof d === "string")
      : [];

    if (!ref) {
      failures.push({ kind: "schema", message: `children[${i}].ref is required.` });
      continue;
    }
    if (!title) {
      failures.push({ kind: "schema", message: `children[${i}].title is required.` });
      continue;
    }

    proposalChildren.push({ ref, title, body, type, tags, depends });
  }

  if (failures.length > 0) {
    return { ok: false, failures };
  }

  const proposal: Proposal = {
    epic: { title: epicTitle, body: epicBody, tags: epicTags },
    children: proposalChildren,
  };

  return validateGraph(proposal);
}

// ---------------------------------------------------------------------------
// Graph validation — refs unique, deps resolve, no cycles, count not absurd
// ---------------------------------------------------------------------------

export function validateGraph(proposal: Proposal): ValidationResult {
  const failures: ProposalFailure[] = [];

  // Duplicate refs
  const seen = new Set<string>();
  for (const c of proposal.children) {
    if (seen.has(c.ref)) {
      failures.push({ kind: "duplicate-ref", ref: c.ref });
    }
    seen.add(c.ref);
  }

  // Self-reference + missing-ref
  const refSet = new Set(proposal.children.map((c) => c.ref));
  for (const c of proposal.children) {
    for (const d of c.depends) {
      if (d === c.ref) {
        failures.push({ kind: "self-reference", ref: c.ref });
        continue;
      }
      if (!refSet.has(d)) {
        failures.push({ kind: "missing-ref", from: c.ref, to: d });
      }
    }
  }

  // Cycle detection — DFS w/ color marking
  const cycle = findCycle(proposal);
  if (cycle) {
    failures.push({ kind: "cycle", path: cycle });
  }

  // Ceiling check (floor handled in writer — 1-2 children just skip the epic)
  if (proposal.children.length > COUNT_CEILING) {
    failures.push({
      kind: "count-too-high",
      count: proposal.children.length,
      ceiling: COUNT_CEILING,
    });
  }

  if (failures.length > 0) {
    return { ok: false, failures, partial: proposal };
  }

  return { ok: true, proposal };
}

function findCycle(proposal: Proposal): string[] | null {
  const adj = new Map<string, string[]>();
  for (const c of proposal.children) {
    adj.set(
      c.ref,
      // Filter to known refs so missing-ref doesn't fake a cycle.
      c.depends.filter((d) => proposal.children.some((x) => x.ref === d)),
    );
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const c of proposal.children) color.set(c.ref, WHITE);

  const stack: string[] = [];

  function dfs(node: string): string[] | null {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const startIdx = stack.indexOf(next);
        return [...stack.slice(startIdx), next];
      }
      if (c === WHITE) {
        const found = dfs(next);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(node, BLACK);
    return null;
  }

  for (const c of proposal.children) {
    if ((color.get(c.ref) ?? WHITE) === WHITE) {
      const found = dfs(c.ref);
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Orient response parsing — Opus returns a JSON decision object.
// ---------------------------------------------------------------------------

export function parseOrientResponse(raw: string): OrientDecision | null {
  const candidate = extractJson(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // intentional: orient response isn't valid JSON — caller treats null as parse failure
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const decision = typeof obj.decision === "string" ? obj.decision.trim() : "";

  if (decision === "retry-with-reframe") {
    const reframe = typeof obj.reframe === "string" ? obj.reframe.trim() : "";
    if (!reframe) return null;
    return { decision, reframe };
  }
  if (decision === "accept-with-warn") {
    const warning = typeof obj.warning === "string" ? obj.warning.trim() : "";
    if (!warning) return null;
    return { decision, warning };
  }
  if (decision === "abort") {
    const reason = typeof obj.reason === "string" ? obj.reason.trim() : "";
    if (!reason) return null;
    return { decision, reason };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Failure → human-readable summary (used to brief the orient call)
// ---------------------------------------------------------------------------

export function describeFailures(failures: ProposalFailure[]): string {
  return failures
    .map((f) => {
      switch (f.kind) {
        case "json-parse":
          return `JSON parse failed: ${f.message}. First chars: ${f.rawSnippet}`;
        case "schema":
          return `Schema: ${f.message}`;
        case "duplicate-ref":
          return `Duplicate child ref: ${f.ref}`;
        case "self-reference":
          return `Child ${f.ref} depends on itself.`;
        case "missing-ref":
          return `Child ${f.from} depends on unknown ref ${f.to}.`;
        case "cycle":
          return `Dependency cycle: ${f.path.join(" -> ")}`;
        case "count-too-high":
          return `Too many children: ${f.count} (ceiling ${f.ceiling}).`;
      }
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Priority resolution — child default = epic priority, default P2.
// ---------------------------------------------------------------------------

export function resolvePriority(input?: TicketPriority | string | number): TicketPriority {
  if (input === undefined || input === null) return 2;
  if (typeof input === "number" && input >= 0 && input <= 3) {
    return input as TicketPriority;
  }
  const str = String(input).toLowerCase().trim();
  const map: Record<string, TicketPriority> = {
    critical: 0, high: 1, medium: 2, low: 3,
    "p0": 0, "p1": 1, "p2": 2, "p3": 3,
    "p0-critical": 0, "p1-high": 1, "p2-medium": 2, "p3-low": 3,
  };
  return map[str] ?? 2;
}
