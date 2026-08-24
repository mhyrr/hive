# Session load and MCP posture — review

**Status:** resolved 2026-08-23 — Forks 1+2 approved as amended in §9; implemented on `claude/hive-prompt-minification-6y4v6c`.
**Date:** 2026-08-23
**Author:** Maya (with Greg)
**Aiming docs:** `docs/identity-injection.md`, `docs/specs/2026-08-16-context-layer-design.md`, `docs/specs/2026-08-12-cursor-cli-harness.md`
**Measured against:** live `~/.hive` emit, `src/mcp-server.ts` descriptions, this Cursor session (`hive -a`)

---

## 0. What this is

A design review of two things Greg is continually worried about:

1. What identity files we inject into every harness session, and the
   cognitive overhead of that load.
2. How hard we push the HIVE MCP tools — liturgy ("use these before you
   think") vs catalog ("these exist; reach when you need answers about
   this project").

No changes landed with this document. The 2026-08-16 context-layer design
asked for the right ~3,000 tokens at the moment of work. This review asks
a prior question: what is already in the room before that moment, and
what ritual the tools impose on top of it.

---

## 1. The finding

The identity stack is within budget. The MCP tools are not "here if you
need them."

Three tools — `search_memory`, `search_taste`, `write_hive_memory` — are
session liturgy. Ticket tools are catalog. Council is gated. Memory,
taste, and write are framed as a tax you pay before you're allowed to
think.

The overhead is instruction density and duplication, not bytes.

---

## 2. What actually loads

HIVE's own emit, measured live on 2026-08-23 from the files
`assembleIdentity()` concatenates (`src/lib/identity.ts`). Budgets are
`CONTEXT_BUDGETS` in `src/lib/context-report.ts`. Token estimate is
bytes/4, same convention as the index generator.

| Piece | Bytes | Budget | Status |
| --- | --- | --- | --- |
| SOUL.md | 4,166 | soul stack 24K | |
| IDENTITY.md | 2,887 | | |
| SELF.md | 2,425 | | |
| AGENTS.md (`~/.hive`) | 7,084 | | fattest soul file |
| TRUST.md | 524 | | |
| **Soul stack** | **17,086** | **24K** | ok |
| persona `dry.md` | 1,658 | 4K | ok |
| taste `principles.md` | 5,378 | 4K | **over** |
| hive `_index.md` | 6,453 | 8K | ok |
| **Emit total** | **~31K** | **40K** | ok |

Pre-slim emit ran ~63K (TK-133/TK-134). Post-slim baseline was ~30K. The
emit has not drifted back. `hive context` already watches this.

AGENTS.md is 7.1K of procedure, not identity. SOUL + IDENTITY + SELF +
TRUST together are ~10K. The ops manual is the expensive soul file.

Taste `principles.md` is the only layer over its own budget. Last =
loudest (`identity.ts` emit order), so the overage sits in the slot that
wins interpretation ties.

---

## 3. What this Cursor session stacked on top

The ~31K emit is not what a `hive -a` session actually sees. This session
loaded:

1. **The full emit as the first user message.**
   `buildCursorLaunchArgs` (`src/lib/cursor-wire.ts:231-235`) prepends
   identity to the positional initial prompt, then appends "this is
   context, not a task." Cursor has no `--system-prompt` /
   `--append-system-prompt`. The prefix stays in conversation history
   for the whole session. Claude appends system; Codex writes
   `~/.codex/AGENTS.md`; Cursor pays for identity as turn 1 forever.
   Documented as the only verified launch-time path in
   `docs/specs/2026-08-12-cursor-cli-harness.md` §1.

2. **Repo `CLAUDE.md` + repo `AGENTS.md` as always-on workspace rules**
   (~5.2K + ~5.1K). They are near-clones of each other. One line has
   already drifted:

   - `AGENTS.md`: "HIVE MCP tools (loaded eagerly via `alwaysLoad: true`…)"
   - `CLAUDE.md`: "HIVE MCP tools (deferred behind ToolSearch…)"

   The 2026-08-20 decision dropped `alwaysLoad` in Claude Code. Repo
   `AGENTS.md` did not get the memo. Cursor loads both files.

3. **Superpowers `using-superpowers` via `hooks_context`.** The
   2026-08-04 decision muted the plugin's SessionStart hook in the
   Claude plugin cache (`exit 0` before it emits). Cursor does not honor
   that patch. The skill still tells the model to invoke skills before
   any response, including clarifying questions.

A `hive -a` session in this repo therefore gets the identity stack, then
a second copy of the ops manual, then a third voice telling the model to
perform a skill ritual before it speaks. That is the cognitive load. The
~31K emit is the least of it.

Cursor/Codex/Pi also have no ToolSearch. They load full HIVE tool
schemas at session start regardless of the Claude alwaysLoad experiment.

---

## 4. MCP: catalog vs ritual

Description character counts from `src/mcp-server.ts` (2026-08-23):

| Tool | Chars | Shape |
| --- | --- | --- |
| `list_tickets` | 74 | catalog |
| `add_ticket_note` | 93 | catalog |
| `show_ticket` | 104 | catalog |
| `update_ticket` | 158 | catalog |
| `hive_status` | 167 | catalog |
| `create_ticket` | 173 | catalog |
| `add_project` | 240 | catalog |
| `convene_council` | 404 | gated — earned the length |
| `read_hive_memory` | 339 | routes to search |
| `reflect_session` | 369 | end-of-session |
| `bootstrap_infer_conventions` | 384 | occasional |
| `decompose_goal` | 451 | occasional |
| `search_taste` | 661 | sermon |
| `search_memory` | 687 | sermon |
| `write_hive_memory` | 712 | sermon |
| **All descriptions** | **5,016** | |
| `server.instructions` | 304 | another "use these" pass |

The ticket tools say what they are. The three memory/taste tools say
when you are a bad agent if you have not reached yet.

`search_memory` opens with "Use BEFORE recommending in a domain you've
worked in, BEFORE proposing a pattern, or WHEN something feels familiar."
`search_taste` opens with "Reach for it when you START a type of work."
`write_hive_memory` opens with "Use immediately when you learn something
durable… Don't batch… Reach for it freely."

Then four other surfaces teach the same ritual:

1. **AGENTS.md MCP Tool Policy** (`~/.hive/AGENTS.md`, also
   `templates/AGENTS.md`): before recommending → `search_memory`; before
   a distinct piece of work → `search_taste`; when you learn something
   durable → `write_hive_memory` immediately; cheap reads silent;
   council needs a yes.
2. **The index itself.** Every truncated entry ends `search_memory for
   the rest` (`src/lib/memory.ts` index builder). The session-start
   summary is a sales pitch for the tool that replaces it.
3. **Dispatch doctrine** (AGENTS Model Economy): every substantive
   dispatch carries `read_hive_memory` and
   `search_taste(IMPLEMENTATION)` before coding.
4. **Canon that says do not throttle.** 2026-06-12: `search_memory` and
   `write_hive_memory` stay eager — "HIVE noise was narration, not
   frequency." Taste fact (TK-132): `search_taste` lives alongside
   `search_memory` as a cheap, eager tool — "do not throttle it."

2026-08-20 dropped `alwaysLoad` because AGENTS.md already named every
tool, so eager schemas (~17.5K across 15 tools) were waste. True for
Claude Code. Incomplete diagnosis: **the naming is the push.** Cursor
and Codex still eat full schemas *and* the policy.

---

## 5. This session as receipt

Greg asked for a design review and "don't change anything."

The policy made the first move a `search_memory` plus two `search_taste`
calls, before a take was allowed. The hits were real (alwaysLoad
experiment, single-owner docs, "don't throttle memory"). They were not
necessary to *start* answering. The index already had the alwaysLoad
decision in the teaser.

2026-06-12 said don't throttle memory/taste because narration, not
frequency, was the noise. That was about not adding a gate in front of a
useful tool. It got implemented as mandatory prefetch. Those are
different.

The intended posture — "these exist; use them when you need answers
about this project" — is the ticket-tool posture. Memory should match
that. Taste even more so: one or two approved units per category,
fetched as a blessing at the start of a *kind* of work, not as a cover
charge for every question.

Related prior: the 2026-08-16 context-layer design found 79
`search_taste` calls with 0 hits until units were admitted that
afternoon. The read path worked; the store was empty. Forcing the call
before every kind of work, when most categories still return nothing or
one fuzzy unit, is ceremony with a low yield.

---

## 6. Forks

They compose. Do not implement until Greg picks.

### Fork 1 — Tool descriptions become labels

One sentence of *what it is*. When-to-use lives in one place or nowhere.
`search_memory` should read like `list_tickets`, not like a SessionStart
hook.

Caveat: usage will drop some. That is the experiment 2026-08-20 already
wanted; it measured schemas instead of copy.

### Fork 2 — AGENTS MCP policy becomes four lines

Search when the index is insufficient. Write when you learned something
the code will not record. Tickets when work outlives the session.
Council needs a yes.

Kill "before a distinct piece of work" and "before recommending." The
dispatch briefing that forces `search_taste(IMPLEMENTATION)` before
coding is the same bug in a smaller font.

### Fork 3 — Split who-we-are from how-we-operate

Always-load: SOUL, IDENTITY, persona, SELF, TRUST (~10K).

On-demand or much shorter: AGENTS (inbox + modes + a pointer), model
economy, git, verification.

Taste `principles.md` is already over budget and last = loudest — a
separate trim, not bundled with the MCP copy edit.

Single-owner already exists as DESIGN taste: each concept has one owning
file; non-owners keep only their delta. Repo `AGENTS.md` vs `CLAUDE.md`
is the same principle unapplied. They should be one file or a stub.
Right now they are a drift factory, and Cursor loads both.

### Cursor-specific (independent of 1–3)

Stuffing identity into the positional user prompt is the worst of the
four harnesses. A Cursor rule with `alwaysApply: true` and **no**
`description` key is the known-good injection — memory already records
that a `description` field demotes the rule to agent-requestable
(Cursor staff; Desktop 3.6 fix announced, CLI unconfirmed). The 2026-08-19
canary rejected a per-launch plugin rule; a user-scope always-apply rule
is a different surface and would need its own canary before the prepend
comes out.

Repo `AGENTS.md` should stop claiming `alwaysLoad: true` regardless.
That line is already false.

---

## 7. What I would pick

Forks 1 and 2 together. Descriptions become labels; AGENTS policy
becomes four lines. One owner for when-to-use, or none.

Fork 3 is the larger identity-stack question and should not ride a copy
edit. Taste over-budget is a trim, not a redesign.

Cursor injection is a harness bug with a known workaround and a failed
canary behind it. Separate ticket, own canary, do not fold into the
MCP-copy pass.

The actual question, answered: we are pushing three tools too hard. The
rest of the server is fine. Council is the one that *should* be loud,
and it is. Bytes are under control. Ritual is not.

---

## 8. Resolution — 2026-08-23

Greg approved Forks 1 and 2, amended by the context-audit skill
(`templates/skills/context-audit/`):

- **Fork 1 amended: contracts, not labels.** Tool descriptions fail by
  saying too little, not too much. The rewrite cut the steering ("Use
  BEFORE recommending") and kept contract facts: what the tool searches,
  its defaults, what it does not return. Some descriptions stayed long.
  The defect was content class, not byte count.
- **Fork 2 amended: ownership, not a line count.** Per-tool "use when"
  lives in each tool's description. AGENTS.md keeps only cross-tool
  policy: the council gate, announce-the-expensive, and the "save a
  memory" disambiguation.
- **Fork 3 deferred** until the cuts land and `hive context` is
  re-measured.
- **New, outside the forks:** the register signal failed under long
  synthesis replies. Fix: the persona register now emits LAST
  (`identity.ts`), taking the loudest slot from taste, and the register
  file ends with a close-out check. The principles.md trim waits on
  Greg's values call. Cursor injection stays a separate ticket.

Changed: `src/lib/identity.ts`, `src/mcp-server.ts` (three descriptions
plus `server.instructions`), `~/.hive/AGENTS.md`, `~/.hive/personas/dry.md`,
`templates/AGENTS.md`, `templates/personas/dry.md`, and the stale
alwaysLoad line in repo `AGENTS.md` / `CLAUDE.md`.

## 9. Sources

- Live sizes: `wc -c` on `~/.hive/{SOUL,IDENTITY,SELF,AGENTS,TRUST}.md`,
  `~/.hive/personas/dry.md`, `~/.hive/taste/principles.md`,
  `~/.hive/memory/projects/hive/_index.md`, repo `CLAUDE.md` / `AGENTS.md`
- Budgets: `src/lib/context-report.ts` `CONTEXT_BUDGETS`
- Emit order: `src/lib/identity.ts` `collectIdentityComponents`
- Cursor prepend: `src/lib/cursor-wire.ts` `buildCursorLaunchArgs`
- Tool copy: `src/mcp-server.ts` `registerTool` descriptions
- Policy: `~/.hive/AGENTS.md` § MCP Tool Policy; `templates/AGENTS.md` same
- alwaysLoad drop: hive knowledge, 2026-08-20 decision
- Don't-throttle: hive knowledge, 2026-06-12 model-economy decision
- Superpowers mute: hive knowledge, 2026-08-04 decision
- Cursor rule `description` gotcha: hive knowledge, Cursor identity fact
- Context-layer prior: `docs/specs/2026-08-16-context-layer-design.md` §2
