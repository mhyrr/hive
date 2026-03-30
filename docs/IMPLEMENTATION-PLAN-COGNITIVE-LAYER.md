# Implementation Plan: Cognitive Accumulation Layer

Three concrete builds that move HIVE from identity/memory/council into
genuine cognitive accumulation. Each is independently shippable.

---

## Build 1: Heuristic Extraction (Autoresearch Pattern)

### The Idea

Apply Karpathy's [autoresearch](https://github.com/karpathy/autoresearch)
ratchet pattern to judgment extraction. Autoresearch's core loop is:
modify → evaluate → keep/revert → repeat, with a single metric (val_bpb)
as the ratchet. We adapt this for heuristics: propose → validate via
council → keep/discard → repeat.

The "metric" isn't a loss number — it's council consensus. A heuristic is
kept if multiple models agree the evidence supports it. Discarded if not.

### What a Heuristic Looks Like

```
When [situation], prefer [action] because [evidence].
Confidence: high | medium | low
Sources: [list of specific observations]
```

Examples:
- "When tests pass but latency benchmarks regress, investigate DB queries
  before declaring the change safe. Confidence: high. Sources: incidents
  on 2026-03-12, 2026-03-19, PR #47 revert."
- "When opening PRs that touch the API layer, pre-check error handling at
  boundaries — reviewer Alice consistently requests this. Confidence:
  medium. Sources: PR #31, #38, #42 reviews."

### Storage

New file per project: `~/.hive/memory/projects/<project>-heuristics.md`

Separate from the main memory file because:
1. Heuristics have different lifecycle (confidence, validation, decay)
2. They need to be loadable independently (injected into session context)
3. The main memory file is already structured with four sections; bolting
   on a fundamentally different entry type would compromise it

Structure:

```markdown
# Heuristics: <project>

## Active
- [2026-03-30] When [situation], prefer [action] because [evidence]. (confidence: high, sources: 3)
- [2026-03-29] When [situation], prefer [action] because [evidence]. (confidence: medium, sources: 2)

## Provisional
- [2026-03-30] When [situation], prefer [action] because [evidence]. (sources: 1, pending validation)

## Retired
- [2026-03-28] When [situation]... (retired: contradicted by [evidence])
```

### The Nightly Loop (program.md Pattern)

A `program.md`-style prompt that drives the extraction. This runs as a
scheduled Claude Code task (or the HIVE `schedule` skill).

**Input context assembled for each iteration:**
1. Project memory (facts, conventions, decisions)
2. Existing heuristics (active + provisional)
3. Recent git log (last 24h of commits, diffs, PR activity)
4. Recent session reflections

**Each iteration:**

1. **Propose**: The agent scans the input context for recurring patterns,
   near-misses, post-mortems, review feedback. Proposes 1-3 candidate
   heuristics in the canonical format.

2. **Validate via council**: Each candidate is sent to `convene_council`
   with the question: "Given the following evidence, is this heuristic
   well-supported, specific enough to be actionable, and not redundant
   with existing heuristics? Evidence: [sources]. Proposed heuristic:
   [text]. Existing heuristics: [list]."

3. **Keep or discard**: If the council reaches consensus (all models agree
   it's well-supported), promote to Active. If majority agrees but with
   caveats, add to Provisional. If no consensus, discard with a note in
   the iteration log.

4. **Repeat**: Scan for more candidates until the agent runs out of
   novel patterns or hits a configured iteration cap (default: 10
   iterations per nightly run).

**The ratchet**: Heuristics only promote if they pass council validation.
The set monotonically improves in quality (bad heuristics get discarded,
good ones accumulate). Provisional heuristics get re-validated in future
runs as more evidence appears.

### Implementation: Files to Create/Modify

**New files:**
- `src/lib/heuristics.ts` — CRUD for heuristic files (read, append,
  promote, retire, validate structure). Mirrors `memory.ts` patterns:
  write queue, structural validation, entry validation.
- `src/programs/heuristic-extraction.md` — The program.md-style prompt
  for the nightly job. Human-editable. Defines the loop, the council
  validation criteria, the keep/discard logic.

**Modified files:**
- `src/lib/paths.ts` — Add `heuristicsPath(projectId)` helper.
- `src/mcp-server.ts` — Add `read_hive_heuristics` tool (so the session
  hook can inject active heuristics into context).
- `src/cli.ts` + new `src/commands/heuristics.ts` — `hive heuristics
  view`, `hive heuristics extract` (runs one extraction iteration
  manually), `hive heuristics validate <id>` (re-validates a provisional
  heuristic via council).
- `.claude/hooks/load-identity.sh` — Append active heuristics to session
  context alongside memory.

### Types

```typescript
type HeuristicStatus = "active" | "provisional" | "retired";

type Heuristic = {
  id: string;           // short hash or sequential
  date: string;         // ISO date
  situation: string;    // "When..."
  action: string;       // "prefer..."
  evidence: string;     // "because..."
  confidence: "high" | "medium" | "low";
  sources: string[];    // specific observations
  status: HeuristicStatus;
  retiredReason?: string;
};

type HeuristicExtractionResult = {
  proposed: Heuristic[];
  promoted: Heuristic[];
  discarded: { heuristic: Heuristic; reason: string }[];
  iterationsRun: number;
};
```

### Estimated Scope

~300 lines for `heuristics.ts`, ~50 lines for the CLI command, ~30 lines
for the MCP tool, ~200 lines for the program.md prompt. Plus tests.

---

## Build 2: Taste Framework

### The Idea

Taste is distinct from memory. Memory says "what happened." Taste says
"how things should be done here." It's a compact, curated set of
preferences that the system consults when making or evaluating changes.

A nightly job reviews the day's work (diffs, reviews, conversations)
against the existing taste structure. It looks for:
- Entries that need nuance added
- New patterns not yet captured
- Entries that are stale or contradicted

### What Taste Entries Look Like

Each entry is brief, specific, and actionable. Not principles — instances.

```
## Code Style
- Error messages are user-facing, not developer-facing. "Failed to connect"
  → "Unable to reach the server — check your internet connection."
- Simple loops over functional chains. map/filter is technically equivalent
  but doesn't match the codebase grain.
- Explicit over clever. Prefer verbose-but-clear over elegant-but-dense.

## Architecture
- Composition over inheritance. Deep hierarchies have burned the team before.
- Files over databases for anything that benefits from inspectability.
- No abstraction until the third instance. Three similar lines > premature helper.

## Review Norms
- PRs over 400 lines get pushback regardless of quality. Split them.
- Always explain *why* in the PR description, not just *what*.

## Naming
- Boolean variables: is/has/should prefix. No bare adjectives.
- Config keys: kebab-case. Never snake_case or camelCase.
```

### Storage

New file per project: `~/.hive/memory/projects/<project>-taste.md`

This file is designed to be **compact and always-loaded**. It doesn't grow
unboundedly like memory. Target: under 100 entries, each 1-2 lines. If it
gets larger, the nightly job should consolidate redundant entries.

Structure:

```markdown
# Taste: <project>

## Code Style
(entries)

## Architecture
(entries)

## Review Norms
(entries)

## Naming
(entries)

## Error Handling
(entries)

## Testing
(entries)
```

Categories are not fixed — the nightly job can propose new categories if
a cluster of entries doesn't fit existing ones. But it should merge before
creating, to resist sprawl.

### The Nightly Job

**Input context:**
1. Current taste file
2. Day's git diffs (commits in last 24h)
3. Day's PR review comments (if available via MCP)
4. Day's session reflections
5. Day's new memory entries

**The job does three things:**

1. **Evaluate existing entries**: For each taste entry, check if today's
   work confirms it, contradicts it, or suggests a refinement. Flag
   contradictions for human review. Apply refinements directly.

2. **Propose new entries**: Scan the day's work for patterns not yet
   captured. A new taste entry must be:
   - Specific (not "write good code")
   - Evidenced (at least 2 instances in recent work)
   - Distinct from existing entries (not a restatement)

3. **Consolidate**: If the file has grown past the target size, merge
   redundant entries and remove stale ones.

**Unlike heuristics, taste doesn't use the council for validation.**
Taste is about pattern recognition in the existing codebase, not
multi-perspective analysis. A single model reviewing diffs against the
taste file is sufficient. The council is for contested questions; taste
is for observed patterns.

### Implementation: Files to Create/Modify

**New files:**
- `src/lib/taste.ts` — Read/write/update taste files. Structured by
  category. Entry-level operations (add, refine, remove, move between
  categories).
- `src/programs/taste-review.md` — The nightly review prompt.

**Modified files:**
- `src/lib/paths.ts` — Add `tastePath(projectId)` helper.
- `src/mcp-server.ts` — Add `read_hive_taste` tool.
- `src/cli.ts` + new `src/commands/taste.ts` — `hive taste view`,
  `hive taste review` (manual trigger).
- `.claude/hooks/load-identity.sh` — Append taste to session context.

### Why Taste is Separate from Memory

Memory is append-only and unbounded. Each entry is independent. The
question is "what do we know?"

Taste is curated and bounded. Entries relate to each other (an
architecture taste entry might contextualize a code style entry). The
question is "what do we prefer?" Taste entries get *refined* over time,
not just accumulated. A memory fact from March is still a fact in June.
A taste entry from March might be refined three times by June as the
team's preferences evolve.

The nightly review job is what makes this distinction operational. Memory
gets appended. Taste gets *maintained*.

### Estimated Scope

~200 lines for `taste.ts`, ~40 lines for CLI, ~25 lines for MCP tool,
~150 lines for the review prompt. Plus tests.

---

## Build 3: Dialectic Council

### The Idea

The current council mode is **convergent**: all models get the same prompt,
give independent analysis, the chair synthesizes agreement/disagreement.
This is good for questions with a likely right answer.

The dialectic mode is **divergent**: models are assigned specific positions
("camps") and must argue them as strongly as possible. The goal is not
consensus but *stress-testing* — finding the strongest version of each
argument so the chair can make an informed judgment.

This is adversarial by design. Not hostile — rigorous. Each model is told:
"Your job is to make the strongest possible case for position X. Find
every supporting argument. Anticipate and preempt counterarguments.
Concede only what you must."

### When to Use Which Mode

| Mode | Use When |
|---|---|
| Standard council | You want independent analysis. "What's the best approach?" |
| Analyst council | You want structured analytical thinking. "What are the risks?" |
| Dialectic council | You want stress-tested arguments. "Should we rewrite or refactor?" |

The dialectic mode is specifically valuable when:
- The question has 2-3 genuinely defensible positions
- The team is leaning one way and wants the counterargument pressure-tested
- A decision is high-stakes and irreversible
- You suspect confirmation bias in the existing analysis

### How It Works

**Input:**
```typescript
type DialecticInput = {
  question: string;
  camps: Camp[];       // 2-4 positions to argue
  context?: string;    // shared background
};

type Camp = {
  name: string;        // "rewrite", "refactor", "hybrid"
  position: string;    // 1-2 sentence summary of the position
  brief?: string;      // optional additional context for this camp
};
```

**Assignment:** Models are assigned to camps round-robin. If there are
3 models and 2 camps, two models argue one side and one argues the other.
If there are 4 models and 3 camps, one model argues each camp and the
fourth acts as a **skeptic** (assigned to poke holes in all positions
without advocating for any).

**System prompt per camp:**

```
You are arguing for the following position in a structured dialectic:

Position: [camp.position]

Your job is to make the STRONGEST possible case for this position.
This is not about balance — it is about rigor. Find every supporting
argument. Anticipate counterarguments and preempt them. Concede points
only when denial would undermine your credibility.

You are not performing a character. You are doing the intellectual work
of finding the best version of this argument. If the position has genuine
weaknesses, acknowledge them briefly and explain why the position is
still the best option despite them.

The question: [question]
Context: [context]
```

**Skeptic prompt (if extra model):**

```
You are the skeptic in a structured dialectic. Your job is to find the
weakest points in ALL positions being argued. You do not advocate for
any position. You pressure-test each one.

For each position, identify:
- The strongest counterargument they haven't addressed
- The assumption most likely to be wrong
- The failure mode they're underweighting

The question: [question]
Context: [context]
Positions being argued: [list of camps]
```

**Chair synthesis prompt (different from standard council):**

```
You just chaired a dialectic. Models argued assigned positions as
strongly as possible. Synthesize:

**Strongest argument from each camp:** What was the single most
compelling point each side made?

**Exposed weaknesses:** Where did a position fail to hold up under
its own advocacy? (If even the model arguing FOR it had to concede
significant ground, that's signal.)

**Emerged insights:** What new considerations surfaced that weren't
in the original framing?

**Your judgment:** Given the strongest versions of all arguments,
what do you actually recommend — and why?

Do not split the difference. Take a position.
```

### Implementation: Files to Create/Modify

**Modified files:**

`src/lib/council.ts`:
- Add `Camp` and `DialecticInput` types
- Add `buildDialecticMemberPrompt(camp: Camp)` — generates the
  camp-specific system prompt
- Add `buildSkepticPrompt(camps: Camp[])` — generates the skeptic prompt
- Add `assignCamps(members: CouncilMember[], camps: Camp[])` — returns
  `Array<{ member: CouncilMember, camp: Camp | "skeptic" }>`
- Add `conveneDialectic(input: DialecticInput & { members, globalConfig })`
  — parallel dispatch like `conveneCouncil` but with per-member prompts
- Add `formatDialecticResultsForSteward(result)` — different synthesis
  prompt than standard council

`src/mcp-server.ts`:
- Extend `convene_council` tool with optional `mode` parameter:
  `"standard" | "analyst" | "dialectic"`
- When `mode === "dialectic"`, require `camps` parameter (array of
  `{ name, position, brief? }`)
- Route to `conveneDialectic` instead of `conveneCouncil`

`src/commands/council.ts`:
- Add `--mode dialectic` flag
- Add `--camps` flag (JSON string or interactive)
- Example: `hive council --mode dialectic --camps '[{"name":"rewrite","position":"Full rewrite of the auth system"},{"name":"refactor","position":"Incremental refactoring over 3 sprints"}]' "Should we rewrite or refactor the auth system?"`

### Types

```typescript
type Camp = {
  name: string;
  position: string;
  brief?: string;
};

type DialecticAssignment = {
  member: CouncilMember;
  role: "advocate" | "skeptic";
  camp?: Camp;  // present when role === "advocate"
};

type DialecticPosition = CouncilPosition & {
  role: "advocate" | "skeptic";
  campName?: string;
};

type DialecticResult = {
  question: string;
  camps: Camp[];
  positions: DialecticPosition[];
  durationMs: number;
};
```

### Estimated Scope

~150 lines added to `council.ts`, ~40 lines added to MCP server,
~30 lines added to CLI command. Plus tests for prompt generation,
camp assignment, and formatting.

---

## Build Order

**Build 3 first (Dialectic Council).** Smallest scope, modifies existing
code, immediately useful, validates the council extension pattern. Can
ship in one session. Also needed by Build 1 (heuristic validation uses
standard council, but dialectic mode would strengthen validation for
contested heuristics).

**Build 2 second (Taste Framework).** Creates the new file structure and
nightly review pattern. Independent of the council — taste review uses
a single model, not the council. Establishes the "curated artifact that
gets maintained, not just appended" pattern that distinguishes taste
from memory.

**Build 1 third (Heuristic Extraction).** The most complex. Depends on
council working well (Build 3), benefits from taste being established
(Build 2 — some heuristics are taste-adjacent and should be routed to
taste instead). The autoresearch-style loop is the most novel thing here
and will need iteration to get the prompts right.

---

## Nightly Job Infrastructure

Both Build 1 and Build 2 need a way to run as nightly scheduled jobs.
Two options:

**Option A: Claude Code `schedule` skill.** Use the existing `/schedule`
skill to create cron-triggered remote agents. The program.md prompts
become the agent instructions. This is zero new infrastructure — it
rides Claude Code's scheduling.

**Option B: `hive dream`-style command.** Add `hive extract` and
`hive taste-review` commands that can be run manually or via system
cron / launchd. These would invoke the council and write results
directly, without needing a full Claude Code session.

**Recommendation: Option A for v1.** It's simpler, uses existing
infrastructure, and keeps HIVE focused on being a Claude Code
integration layer rather than a standalone daemon. If scheduling
proves unreliable, fall back to Option B.

---

## What This Does NOT Do

- No production monitoring integration (yet). Initiative/noticing from
  the research doc is deferred — it requires external data sources that
  vary per project.
- No relationship modeling (yet). People models need PR review data at
  scale, which means tighter GitHub integration than we have today.
- No commitment tracking (yet). Requires conversation parsing that's
  hard to do well outside the session that generated the conversation.
- No automatic taste or heuristic injection into code generation. These
  artifacts inform the *human and steward's judgment*, not the model's
  system prompt (yet). That's a later integration.

---

## Success Criteria

### Dialectic Council
1. `hive council --mode dialectic` works from CLI
2. `convene_council` MCP tool accepts `mode: "dialectic"` with camps
3. Models argue assigned positions, not independent analysis
4. Chair synthesis identifies strongest arguments and takes a position
5. Skeptic role assigned when models > camps

### Taste Framework
1. `~/.hive/memory/projects/<project>-taste.md` exists and is loadable
2. Taste is injected into session context via hook
3. `hive taste view` shows current taste
4. Nightly review prompt can add, refine, and consolidate entries
5. File stays under 100 entries after multiple review cycles

### Heuristic Extraction
1. `~/.hive/memory/projects/<project>-heuristics.md` exists with
   active/provisional/retired sections
2. Extraction loop proposes, validates via council, keeps or discards
3. Heuristics are injected into session context via hook
4. `hive heuristics view` shows active heuristics
5. At least 3 genuine heuristics extracted after first nightly run on
   a project with >2 weeks of history
