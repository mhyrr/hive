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
//
// Prompt design notes (2026-05-09 revision after landscape survey):
// 1. Plan-then-emit: model produces <analysis> before the JSON. Anthropic's
//    orchestrator-workers cookbook + Plan-and-Solve (Wang 2023). Strip post-parse.
//    TK-136: the block asks for the decomposition PLAN, not a transcript of the
//    model's reasoning. Fable-class safety classifiers run a `reasoning_extraction`
//    refusal category, so "think out loud" / "show your reasoning" phrasing here
//    risks a decline (HTTP 200, stop_reason: "refusal"). Asking for a plan — a
//    conclusion with its constraints — carries the same plan-then-emit benefit
//    without sitting in that category.
// 2. One worked <example> anchoring the schema, depends syntax, imperative
//    titles. Anthropic prompt docs + Least-to-Most (Zhou).
// 3. Pre-emit self-check section. Cheaper than an orient retry.
// 4. Coverage-not-filtering on dedup: bias toward include + tag uncertain
//    children rather than asking the model to filter inline. Anthropic guidance
//    that filtering belongs downstream of generation.
//
// Deliberate non-adoptions:
// - DAG with explicit `depends:[]` (vs phases/ordered-list in Plandex/OpenHands)
//   — needed for independent execution.
// - No clarifying-questions affordance (vs Cline/OpenHands PLAN MODE) — the
//   decomposition is asynchronous; orient.abort covers "too vague."
// - No `Uses:` file list per child (Plandex) — defer until prompt context
//   carries a file index.
// ---------------------------------------------------------------------------

export const DECOMPOSE_SYSTEM_PROMPT = `You are HIVE's goal decomposer. You take a rough goal in natural language and produce a tightly-scoped epic plus 3-10 child tickets that an autonomous agent can pick up cold.

PROCESS
1. Read the project context: project memory index, taste principles, search hits against prior similar work, and the list of currently open tickets.
2. Decompose the goal into an epic + child tickets. Each child must be:
   - Self-contained — an agent picking it up cold knows what "done" looks like.
   - Sized for one focused session (< 2h of agent work).
   - Titled in imperative form ("Add session model", not "Session model").
3. Wire dependencies as a DAG. No cycles. A child can depend on another child via its ref placeholder. Independent branches can be executed in parallel.
4. On dedup: your job at this stage is COVERAGE, not filtering. If a child might overlap an open ticket, INCLUDE the child anyway and add the tag "possibly-covered"; cite the overlapping ticket(s) in that child's Notes section. A downstream step handles final dedup. The exception: if the entire goal is unambiguously covered by existing tickets, return a single child whose body explains the overlap.

OUTPUT — first an <analysis> block holding your decomposition plan in prose (the shape you chose, and the constraints that drove it), then a single <json> block. Nothing outside those two blocks.

Schema for the JSON:
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
      "body": "## Scope\\n…\\n\\n## Acceptance\\n- [ ] …\\n- [ ] …\\n\\n## Notes\\n(optional — memory citations or file pointers; tag 'possibly-covered' here if you cited an overlapping ticket above)"
    }
  ]
}

CONSTRAINTS
- 3-10 children. If the goal honestly produces 1-2, return them anyway; the writer handles that case.
- Refs are short placeholder IDs (C1, C2, …). The system maps them to TK-NNN at write time.
- Tags must be drawn from the project's existing tag distribution (visible in the index). Don't invent new tags unless the goal genuinely introduces new territory. Exception: "possibly-covered" is a reserved tag for the dedup case above.
- Children inherit the epic's domain. Don't decompose across unrelated domains.
- Body markdown lines use \\n for line breaks (this is JSON).
- Do NOT include the epic in children. Do NOT include placeholder children whose bodies say "TBD" — every ticket must be substantive enough to execute.

SELF-CHECK (do this in your <analysis> block before emitting the JSON)
- [ ] Every ref in any "depends" array exists as another child's ref.
- [ ] No child depends on itself.
- [ ] No cycles (you can mentally walk each chain to a leaf).
- [ ] Count is 3-10 (or 1-2 if that's honestly the right size).
- [ ] Every tag is drawn from the project's existing tag distribution (or is "possibly-covered").
- [ ] Every child title is imperative ("Add X", "Wire Y", "Fix Z").
- [ ] Every child body has a Scope and Acceptance section, with checkboxes in Acceptance.

EXAMPLE (illustrative — do not copy verbatim)

<example>
<input_goal>Add retry for transient nightly extraction failures.</input_goal>
<analysis>The goal is to stop a temporary provider failure from losing one project's nightly extraction. Project memory says projects are isolated during Pass B and retries are currently off. Natural decomposition: a pure retry policy, wire it around each project extraction, then record attempts in the nightly usage artifact. Three children, linear dependencies. No cycles; tags drawn from {nightly, memory}.</analysis>
<json>
{
  "epic": {
    "title": "Add retry for transient nightly extraction failures",
    "body": "## Goal\\nRetry transient Pass B failures without hiding structural errors.\\n\\n## Why\\nA temporary provider failure currently drops one project's candidates for the night.\\n\\n## Children\\n- C1 — retry-policy module\\n- C2 — wire into project extraction (depends on C1)\\n- C3 — usage artifact fields (depends on C2)",
    "tags": ["nightly", "memory"]
  },
  "children": [
    {
      "ref": "C1",
      "title": "Add retry-policy module",
      "type": "task",
      "tags": ["nightly"],
      "depends": [],
      "body": "## Scope\\nA pure module that decides retry vs abort given a failure signature. No side effects.\\n\\n## Acceptance\\n- [ ] Decision tree handles transient (timeout, ECONNREFUSED) vs structural (assertion, parse error) failures\\n- [ ] Returns {retry: bool, after_seconds, reason}\\n- [ ] Tested with 6+ failure-signature fixtures"
    },
    {
      "ref": "C2",
      "title": "Wire retry into project extraction",
      "type": "feature",
      "tags": ["nightly", "memory"],
      "depends": ["C1"],
      "body": "## Scope\\nCall the retry-policy module after each project extraction failure. Cap attempts and preserve project isolation.\\n\\n## Acceptance\\n- [ ] Transient failures retry within the cap\\n- [ ] Structural failures bypass retry and fail that project\\n- [ ] Other projects continue unaffected"
    },
    {
      "ref": "C3",
      "title": "Record extraction retry attempts",
      "type": "feature",
      "tags": ["nightly", "memory"],
      "depends": ["C2"],
      "body": "## Scope\\nRecord retry count and final reason in the nightly usage artifact.\\n\\n## Acceptance\\n- [ ] Each project reports its attempt count\\n- [ ] Final failure reason remains auditable\\n- [ ] Successful first attempts remain compact"
    }
  ]
}
</json>
</example>

Return your <analysis> block, then the <json> block. Nothing else.`;

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
