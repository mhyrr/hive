# Implementation Plan: Cognitive Accumulation Layer

Three concrete builds that move HIVE from identity/memory/council into
genuine cognitive accumulation. Each is independently shippable.

Nightly job infrastructure is built separately — not in scope here.

---

## Build 1: Dialectic Council (multi-round adversarial)

### The Idea

The existing council is convergent: same prompt, independent analysis,
chair synthesizes. The dialectic is divergent: models are assigned camps,
argue positions as strongly as possible, and — critically — **see each
other's arguments and refine across multiple rounds**.

This is a real dialectic, not parallel one-shots. Each round, every model
receives what the others argued and gets to sharpen, concede, or pivot.

### Round Structure

**Round 1**: Each model argues its assigned camp position. No visibility
into other models' arguments. Pure independent advocacy.

**Round 2**: Each model receives ALL other models' Round 1 responses.
Prompt: "Here is what the other side argued. Refine your position.
Address their strongest points. Concede where you must. Sharpen where
you can."

**Round 3** (default final): Each model receives ALL Round 2 responses.
Prompt: "This is the final round. Make your strongest case, incorporating
everything you've learned from the debate. Where has your position
genuinely improved? Where has the other side made points you can't
dismiss?"

Rounds are configurable (default 3, min 1, max 5). Round 1 is parallel
across models. Rounds 2+ are parallel within each round but sequential
between rounds.

### Camp Assignment

Models are assigned to camps round-robin. If models > camps, extras
become **skeptics** — they poke holes in all positions without
advocating for any. Skeptics participate in all rounds with visibility
into all arguments.

### System Prompts

**Round 1 (advocate):**
```
You are arguing for the following position in a structured dialectic:

Position: {camp.position}

Make the STRONGEST possible case. This is not about balance — it is
about rigor. Find every supporting argument. Anticipate
counterarguments and preempt them.

You are not performing a character. You are doing the intellectual
work of finding the best version of this argument.

The question: {question}
Context: {context}
```

**Round 2+ (advocate):**
```
You are in round {n} of a dialectic arguing for: {camp.position}

Here is what was argued in the previous round:

{formatted previous round positions}

Refine your position. Address the strongest points made against you.
Concede where denial would undermine your credibility. Sharpen where
the other side was weak.

Do not repeat your previous arguments verbatim. Evolve them.
```

**Round 1 (skeptic):**
```
You are the skeptic in a structured dialectic. You do not advocate
for any position. You pressure-test each one.

For each position, identify:
- The strongest counterargument they haven't addressed
- The assumption most likely to be wrong
- The failure mode they're underweighting

The question: {question}
Context: {context}
Positions being argued: {list of camps}
```

**Round 2+ (skeptic):**
```
You are the skeptic in round {n}. Here is what was argued:

{formatted previous round positions}

Update your analysis. Which positions got stronger? Which got weaker?
What are they still not addressing?
```

**Chair synthesis (after all rounds):**
```
You chaired a {rounds}-round dialectic. Synthesize:

**Evolution:** How did positions change across rounds? What was
conceded? What hardened?

**Strongest surviving argument from each camp:** After multiple
rounds of pressure, what still stands?

**Exposed weaknesses:** Where did a position fail to hold up even
with its own advocate refining it across rounds?

**Emerged insights:** What surfaced that wasn't in the original
framing?

**Your judgment:** Given the strongest battle-tested versions of all
arguments, what do you recommend — and why?

Do not split the difference. Take a position.
```

### Implementation

**Modified files:**

`src/lib/council.ts`:
- New types: `Camp`, `DialecticInput`, `DialecticAssignment`,
  `DialecticRound`, `DialecticResult`
- `assignCamps(members, camps)` → assignment array
- `buildDialecticPrompt(assignment, round, previousRounds)` → per-member
  per-round system prompt
- `conveneDialectic(input)` → sequential rounds, parallel within each
  round. Returns all rounds' positions plus timing.
- `formatDialecticResultsForSteward(result)` → chair synthesis prompt
  with full round history

`src/mcp-server.ts`:
- Extend `convene_council` with `mode: "standard" | "analyst" | "dialectic"`
- When dialectic: require `camps` array, accept optional `rounds` (default 3)
- Route to `conveneDialectic`

`src/commands/council.ts`:
- `--mode dialectic` flag
- `--camps` flag (JSON array)
- `--rounds` flag (default 3)

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
  camp?: Camp;
};

type DialecticRound = {
  roundNumber: number;
  positions: DialecticPosition[];
  durationMs: number;
};

type DialecticPosition = CouncilPosition & {
  role: "advocate" | "skeptic";
  campName?: string;
  roundNumber: number;
};

type DialecticResult = {
  question: string;
  camps: Camp[];
  rounds: DialecticRound[];
  totalDurationMs: number;
};
```

### Estimated Scope

~250 lines in council.ts, ~50 in MCP server, ~40 in CLI. Plus tests.

---

## Build 2: Taste Framework

### The Idea

Taste is distinct from memory. Memory says "what happened." Taste says
"how things should be done here." It's a compact, curated set of
preferences — not principles, instances.

**Critical refinement:** Taste needs a clear heuristic for what taste
*means*, and that heuristic is discovered through conversation with the
user, not automated analysis. Some taste is easily stated ("we prefer
composition over inheritance"). Some requires interactive refinement
("why did you reject that PR approach? what was wrong with it exactly?").

### Discovery Protocol

Taste starts as a **structured conversation**, not a batch job. The
system needs an interactive discovery mode:

1. **Seed questions**: The system asks the user targeted questions to
   surface taste. Not open-ended — structured around categories:
   - "When you review code, what makes you request changes vs. approve?"
   - "Show me a PR you thought was well-done. What made it good?"
   - "Show me a PR that frustrated you. What was wrong?"
   - "What architectural patterns do you reach for? What do you avoid?"
   - "When two approaches are both correct, what makes you prefer one?"

2. **Propose and react**: The system analyzes codebase patterns and
   proposes taste entries. The user confirms, refines, or rejects.
   - "I notice the codebase avoids class hierarchies. Is that intentional?"
   - "Error messages seem to be user-facing throughout. Is that a rule?"
   - "PRs in this repo average 150 lines. Is small-PR preference explicit?"

3. **Refine over time**: As work happens, the system occasionally asks
   "does this still match your taste?" or proposes refinements based on
   observed drift.

This discovery process IS the product for taste. The nightly review job
(if any) is secondary — it evaluates the day's work against established
taste, but it can't *discover* taste without the human in the loop.

### What Taste Entries Look Like

Brief, specific, actionable. Not principles — instances.

```markdown
# Taste: <project>

## Code Style
- Error messages are user-facing. "Failed to connect" →
  "Unable to reach the server — check your internet connection."
- Simple loops over functional chains. map/filter doesn't match the grain.
- Explicit over clever. Verbose-but-clear beats elegant-but-dense.

## Architecture
- Composition over inheritance. Always.
- Files over databases for anything that benefits from inspectability.
- No abstraction until the third instance.

## Review Norms
- PRs under 400 lines. Split anything larger.
- PR description explains *why*, not just *what*.

## Naming
- Boolean variables: is/has/should prefix.
- Config keys: kebab-case.
```

### Storage

`~/.hive/memory/projects/<project>-taste.md`

Designed to be compact and always-loaded. Target: under 100 entries,
each 1-2 lines. Categories are not fixed but should resist sprawl — merge
before creating new categories.

### Why Separate from Memory

Memory is append-only and unbounded. Taste is **maintained** — entries
get refined, consolidated, and retired. A memory fact from March is still
a fact in June. A taste entry from March might be refined three times by
June as preferences evolve.

### Implementation

**New files:**
- `src/lib/taste.ts` — Read/write/update taste files. Category-based
  structure. Entry operations: add, refine, remove, move between
  categories.
- `src/programs/taste-discovery.md` — Prompt template for the interactive
  discovery session.

**Modified files:**
- `src/lib/paths.ts` — Add `tastePath(projectId)` helper.
- `src/mcp-server.ts` — Add `read_hive_taste` tool.
- `src/cli.ts` + new `src/commands/taste.ts` — `hive taste view`,
  `hive taste discover` (interactive session).
- `.claude/hooks/load-identity.sh` — Append taste to session context.

### Estimated Scope

~200 lines for taste.ts, ~40 for CLI, ~25 for MCP tool, ~200 for
discovery prompt. Plus tests.

---

## Build 3: Heuristic Extraction (Autoresearch Ratchet)

### The Idea

Apply Karpathy's autoresearch pattern to judgment extraction. The key
insight: autoresearch works because it has a **precise, mechanical
metric** — val_bpb goes up or down. Council consensus is NOT the right
metric. It's vibes, not measurement.

The hard problem: **what is the number?**

### Finding the Metric

A heuristic is: "When [situation], prefer [action] because [evidence]."

The testable claim is: *in past instances of [situation], did [action]
correlate with better outcomes?*

**Candidate metric: historical hit rate.**

For a proposed heuristic, the extraction loop:

1. Identifies all historical instances of [situation] in the project's
   git history, PR history, and memory.
2. For each instance, checks: was [action] taken?
3. For each instance, checks: what was the outcome? (PR merged cleanly?
   Reverted? Required follow-up fixes? Review requested changes?)
4. Computes: hit rate = (instances where action taken AND good outcome)
   / (total instances of situation).

A heuristic with hit rate > threshold (e.g. 0.7) is promoted. Below
threshold, discarded. Insufficient instances (< 3), stays provisional.

**Example:**
- Proposed: "When touching the API layer, pre-check error handling at
  boundaries."
- Scan: 12 PRs touched the API layer in the last 3 months.
- 8 of them included error handling changes → 5 merged cleanly, 3
  required minor revisions.
- 4 of them did NOT include error handling → 1 merged cleanly, 3 got
  review comments specifically about error handling.
- Hit rate: error handling present correlates with clean merge 62% vs
  25%. Signal is strong. Promote.

This is genuinely mechanical. The number goes up or down.

### The Ratchet Loop

Like autoresearch: propose → test → keep/revert → repeat.

**Each iteration:**

1. **Propose**: Agent scans recent memory, git log, PR activity for
   a recurring pattern. Formulates a candidate heuristic.

2. **Test**: Query historical data for instances of the situation.
   Compute hit rate. This is the equivalent of running train.py and
   checking val_bpb.

3. **Keep or revert**: If hit rate > threshold and instances >= minimum,
   promote to Active. If hit rate <= threshold, discard. If insufficient
   instances, mark Provisional.

4. **Repeat**: Continue until iteration cap or no more novel candidates.

**The ratchet**: Heuristics only enter Active if the number clears the
bar. The active set monotonically improves in evidence quality.

### What Needs to Be True

This approach requires structured access to project history:
- Git log with file-level diffs (available via `git log`)
- PR review data (available if GitHub MCP is configured)
- Existing memory entries (available)

The extraction agent needs to be able to query these programmatically,
not just read raw text. This might mean a small set of helper functions
for the program.md to call:
- `findCommitsTouching(pathPattern, dateRange)` → commit list
- `findPRsWithReviewComments(dateRange)` → PR list with outcomes
- `findRevertedCommits(dateRange)` → commits that were later reverted

### Storage

Same as before: `~/.hive/memory/projects/<project>-heuristics.md`
with Active / Provisional / Retired sections. Each entry includes
hit rate and instance count.

```markdown
## Active
- [2026-03-30] When touching API layer, pre-check error handling at
  boundaries. (hit-rate: 0.72, instances: 12, sources: PR #31-#47)

## Provisional
- [2026-03-30] When modifying test fixtures, run the full suite not
  just related tests. (instances: 2, pending: need 3+)

## Retired
- [2026-03-28] When... (retired: hit-rate dropped to 0.4 after 8 new
  instances)
```

### Open Questions

- **Is hit rate the right metric, or is there a better one?** Hit rate
  measures correlation, not causation. A heuristic could have high hit
  rate because good developers do it naturally, not because it causes
  good outcomes. But correlation is still useful for prediction.

- **How do we define "good outcome" mechanically?** PR merged without
  revision requests? No revert within 7 days? No related bug filed?
  Need to pick one or two signals and commit.

- **What's the minimum history needed?** A project with 2 weeks of
  history might not have enough instances for any heuristic to clear
  the bar. Need a minimum project age or activity level.

This build needs the most design iteration. The program.md prompt and
the historical query helpers are the hard parts. The storage and
lifecycle management are straightforward.

### Estimated Scope

~300 lines for heuristics.ts (storage + lifecycle), ~200 lines for
historical query helpers, ~50 for CLI, ~30 for MCP tool, ~250 for
program.md. Plus tests. Most complex of the three builds.

---

## Build Order

**Build 1 first (Dialectic Council).** Clearest spec, extends existing
code, immediately useful. Ships in one session.

**Build 2 second (Taste Framework).** New file structure, interactive
discovery protocol. Depends on having a working council for the chair
to use during taste discovery sessions.

**Build 3 third (Heuristic Extraction).** Most complex, needs design
iteration on the metric. Benefits from taste being established (some
heuristics are taste-adjacent and should route to taste instead).

---

## What This Does NOT Do

- No nightly job infrastructure (built separately)
- No production monitoring integration
- No relationship modeling (needs more GitHub integration)
- No commitment tracking (needs conversation parsing)
- No automatic injection into code generation prompts (these artifacts
  inform human/steward judgment, not model system prompts — yet)
