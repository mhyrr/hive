// Prompt assembly for goal decomposition (TK-036).
//
// Three concerns, kept separate:
//   1. gatherContext()          — reads memory/principles/tickets from disk
//   2. buildDecomposePrompt()   — system + user for the initial Opus call
//   3. buildOrientPrompt()      — system + user for the orient call on failure
//
// Pure prompt assembly is testable; the context gather is the thin I/O wrapper.

import { existsSync } from "node:fs";

import type { HivePaths } from "./paths";
import {
  indexPath,
  searchMemory,
  type SearchResult,
} from "./memory";
import { buildTasteLayer } from "./taste";
import { listTickets, type Ticket } from "./ticket";
import {
  describeFailures,
  type ProposalFailure,
} from "./decompose";

// ---------------------------------------------------------------------------
// Context bundle
// ---------------------------------------------------------------------------

export type DecomposeContext = {
  projectId: string;
  goal: string;
  indexMd: string;          // _index.md, may be empty
  principlesMd: string;     // taste layer, may be empty
  searchHits: SearchResult[];
  openTickets: Pick<Ticket, "id" | "title" | "tags" | "type">[];
};

const SEARCH_HIT_CAP = 15;

export async function gatherDecomposeContext(
  paths: HivePaths,
  projectId: string,
  goal: string,
): Promise<DecomposeContext> {
  const indexMd = await readIfExists(indexPath(paths, projectId));

  // Principles file is HIVE-wide, not per-project.
  const principlesMd = (await buildTasteLayer()) ?? "";

  // BM25 against the goal text. logDays:0 keeps the corpus to compiled knowledge.
  const searchHits = (
    await searchMemory(paths, projectId, goal, { logDays: 0 })
  ).slice(0, SEARCH_HIT_CAP);

  // Open tickets — titles + tags only. No bodies.
  const open = await listTickets(paths, projectId, { status: "open" });
  const openTickets = open.map((t) => ({
    id: t.id,
    title: t.title,
    tags: t.tags,
    type: t.type,
  }));

  return { projectId, goal, indexMd, principlesMd, searchHits, openTickets };
}

async function readIfExists(file: string): Promise<string> {
  if (!existsSync(file)) return "";
  return (await Bun.file(file).text()).trim();
}

// ---------------------------------------------------------------------------
// Decompose prompt — initial pass
// ---------------------------------------------------------------------------

export const DECOMPOSE_SYSTEM_PROMPT = `You are HIVE's goal decomposer. You take a rough goal in natural language and produce a tightly-scoped epic plus 3-10 child tickets that an autonomous agent can pick up cold.

PROCESS
1. Read the project context: project memory index, taste principles, search hits against prior similar work, and the list of currently open tickets.
2. Check for overlap with open tickets. If the goal is FULLY covered by existing tickets, produce a single child ticket whose body cites the existing tickets — or if the entire goal is covered, return a proposal with one note-style child explaining the overlap.
3. Decompose the gap (or the full goal if nothing overlaps) into an epic + child tickets. Each child must be:
   - Self-contained — an agent picking it up cold knows what "done" looks like.
   - Sized for one focused session (< 2h of agent work).
   - Titled in imperative form ("Add session model", not "Session model").
4. Wire dependencies as a DAG. No cycles. A child can depend on another child via its ref placeholder. Independent branches are dispatchable in parallel.

OUTPUT — JSON only. No prose, no code fences. Schema:
{
  "epic": {
    "title": "…",
    "body": "## Goal\\n…\\n\\n## Why\\n…\\n\\n## Children\\n- C1 — …\\n- C2 — … (depends on C1)",
    "tags": ["tag1", "tag2"]
  },
  "children": [
    {
      "ref": "C1",
      "title": "…",
      "type": "task" | "feature" | "bug" | "chore",
      "tags": ["…"],
      "depends": [],
      "body": "## Scope\\n…\\n\\n## Acceptance\\n- [ ] …\\n- [ ] …\\n\\n## Notes\\n(optional — memory citations or file pointers)"
    }
  ]
}

CONSTRAINTS
- 3-10 children. If the goal honestly produces 1-2, return them anyway; the writer handles that case.
- Refs are short placeholder IDs (C1, C2, …). The system maps them to TK-NNN at write time.
- Tags must be drawn from the project's existing tag distribution (visible in the index). Don't invent new tags unless the goal genuinely introduces new territory.
- Children inherit the epic's domain. Don't decompose across unrelated domains.
- Body markdown lines use \\n for line breaks (this is JSON).
- Do NOT include the epic in children. Do NOT include placeholder children whose bodies say "TBD" — every ticket must be substantive enough to dispatch.

Return ONLY the JSON object. No commentary.`;

export function buildDecomposeUserMessage(ctx: DecomposeContext): string {
  const sections: string[] = [];

  sections.push(`# Goal\n${ctx.goal.trim()}`);

  sections.push(`# Project: ${ctx.projectId}`);

  if (ctx.indexMd) {
    sections.push(`# Project Memory Index\n${ctx.indexMd}`);
  } else {
    sections.push(
      `# Project Memory Index\n(empty — project has no compiled memory yet)`,
    );
  }

  if (ctx.principlesMd) {
    sections.push(`# Taste Principles (the lens)\n${ctx.principlesMd}`);
  }

  if (ctx.searchHits.length > 0) {
    sections.push(
      `# Memory hits for this goal (BM25 ranked)\n` +
        ctx.searchHits
          .map((h) => {
            const tags = h.tags.length > 0 ? ` [${h.tags.join(", ")}]` : "";
            const sec = h.section ? `[${h.section}] ` : "";
            return `- ${sec}${h.entry}${tags}`;
          })
          .join("\n"),
    );
  } else {
    sections.push(`# Memory hits for this goal\n(no direct hits)`);
  }

  if (ctx.openTickets.length > 0) {
    sections.push(
      `# Open tickets in this project (titles + tags, no bodies)\n` +
        ctx.openTickets
          .map((t) => {
            const tagStr = t.tags.length > 0 ? ` [${t.tags.join(", ")}]` : "";
            return `- ${t.id} (${t.type}): ${t.title}${tagStr}`;
          })
          .join("\n") +
        `\n\nIf the goal overlaps with any of these, your epic.body should explicitly cite them and the children should cover only the gap.`,
    );
  } else {
    sections.push(`# Open tickets in this project\n(none)`);
  }

  sections.push(`# Now decompose. Return ONLY valid JSON.`);

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Orient prompt — runs after a failed attempt
// ---------------------------------------------------------------------------

export const ORIENT_SYSTEM_PROMPT = `You are the orient step in HIVE's goal-decomposition OODA loop. The decomposer just produced output that failed validation. Your job: read the failure, classify it, and pick ONE of three levers.

LEVERS
1. retry-with-reframe — most common. The decomposer made a recoverable mistake (cycle, missing dep, schema slip, count too high, etc.). Write a SHORT targeted reframe that a retry will append to the prompt. Reframe should name the specific problem and the specific correction — not a generic "try again."
2. accept-with-warn — the output is technically off-spec but usable. Examples: count is 1-2 children (smaller than typical but the decomposition is fine), the body's Notes section is missing on some children, etc. Surface a one-line warning the operator should see.
3. abort — the failure is structural and not recoverable. Examples: the model returned non-JSON garbage twice in a row, the goal is too vague to decompose at all (\\"do everything better\\"), or the model is refusing the task. Abort with a one-line reason.

Choose the cheapest correct lever. Reframes are best when the model wrote something close to right but missed a structural rule. Accept-with-warn is for off-spec but useful output. Abort is when retrying won't help.

OUTPUT — JSON only. One of:
{ "decision": "retry-with-reframe", "reframe": "<short, targeted, names the specific fix>" }
{ "decision": "accept-with-warn", "warning": "<one line for the operator>" }
{ "decision": "abort", "reason": "<one line>" }

Return ONLY the JSON object. No commentary.`;

export function buildOrientUserMessage(input: {
  goal: string;
  attempt: number;
  maxAttempts: number;
  failures: ProposalFailure[];
  rawOutput: string;
  priorReframes: string[];
}): string {
  const sections: string[] = [];
  sections.push(`# Goal\n${input.goal.trim()}`);
  sections.push(`# Attempt: ${input.attempt} of ${input.maxAttempts}`);

  sections.push(`# Validation failures\n${describeFailures(input.failures)}`);

  if (input.priorReframes.length > 0) {
    sections.push(
      `# Reframes already tried (don't repeat — escalate if same kind of failure recurs)\n` +
        input.priorReframes.map((r, i) => `${i + 1}. ${r}`).join("\n"),
    );
  }

  // Cap raw output to keep token use reasonable.
  const capped = input.rawOutput.length > 3000
    ? input.rawOutput.slice(0, 3000) + "\n…[truncated]"
    : input.rawOutput;
  sections.push(`# Decomposer's raw output\n${capped}`);

  sections.push(`# Pick a lever. Return ONLY valid JSON.`);

  return sections.join("\n\n");
}
