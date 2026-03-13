# Plan: Template Overhaul

## Goal
Fix infrastructure bugs, upgrade templates to match live quality, and trim
token budget across the HIVE personality stack. Every `hive init` should
produce a system that works out of the box — no dead files, no stale
defaults, no personal content leaking into new installs.

## Phases

### Phase 1 — Infrastructure Bugs (P1)
Mechanical fixes. Low risk, high confidence. Can parallelize.

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 1.1 | SOUL.md duplicate paragraph ("We respect each other's scope" appears twice, lines ~86-89 and ~97-99) | Delete the second occurrence (lines 97-99) | `templates/SOUL.md` |
| 1.2 | TRUST.md installed but never loaded into any agent prompt | Add TRUST.md to prompt assembly in orchestrator.ts, prompt.ts, chat.ts, console.ts — include it after AGENTS.md as `Read trust policy: {path}` | `src/lib/orchestrator.ts`, `src/commands/prompt.ts`, `src/commands/chat.ts`, `src/commands/console.ts` |
| 1.3 | Skills directory exists in templates but autonomous-ops.md contradicts AGENTS.md on BOARD.md ownership | Fix autonomous-ops.md: remove "Update BOARD.md with new tasks" — replace with "Request board changes via msg/ to the steward" | `templates/skills/autonomous-ops.md` |
| 1.4 | PLAN.md template says check `~/.hive/msg/` (raw path); AGENTS.md correctly says `hive inbox <agent>` | Update PLAN.md template rules section to reference `hive inbox` | `templates/PLAN.md` |
| 1.5 | "Greg" hardcoded 4x in steward.md template | Replace with `{{userName}}` placeholder; update paths.ts/templates.ts to pass user name from SELF.md or default to "the user" | `templates/personas/steward.md`, `src/lib/templates.ts`, `src/lib/paths.ts` |
| 1.6 | Alpha/beta/gamma hardcoded in persona cross-references | Replace with generic references ("the reviewer", "the craftsman", "another agent") or use `{{agentNames}}` | `templates/personas/craftsman.md`, `templates/personas/critic.md` |

**Agents:** alpha + beta in parallel. ~30 min each.
**Verify:** `bun run build` passes. Diff every template change. Run `hive init` in a temp dir and confirm no "Greg", no duplicate paragraphs, no stale paths.

---

### Phase 2 — Template Quality (P2)
Upgrade templates so a fresh `hive init` produces the same quality as the
live system. Moderate effort, high impact.

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 2.1 | SELF.md ships personal content (Greg's reading list, project names, stack preferences) | Replace with a scaffolded template: section headers + placeholder prompts ("Your role:", "Your stack:", "Your intellectual context:", "Your preferences:") | `templates/SELF.md` |
| 2.2 | config.md defaults to `runtime: ollama` / `model: local-small` | Default to `runtime: claude` / `model: claude-sonnet-4-6`. Add comments documenting valid runtime/model options | `templates/config.md` |
| 2.3 | PLAN.md template is skeletal — no format guidance | Add a commented example showing the `### agentId` section format that `findPlanAgent` actually parses, plus a sample task row | `templates/PLAN.md` |
| 2.4 | LOG.md has no format guidance | Add a commented example entry showing the `hive log` output format | `templates/LOG.md` |
| 2.5 | BOARD.md template has no format guidance | Add a commented example showing pipe-delimited task rows in `## Tasks` | `templates/BOARD.md` |
| 2.6 | AGENTS.md doesn't name the available skills | Add a "## Available Skills" section listing `state-efficient-ops` and `autonomous-ops` with one-line descriptions | `templates/AGENTS.md` |
| 2.7 | Personas lack deliverable specs — say what roles think about but not where output goes | Add a "## Deliverables" section to each persona specifying output format, destination file/message, and available tools | `templates/personas/*.md` |
| 2.8 | project-config.md has placeholder instructions as content | Replace instructional text with actual commented-out example config | `templates/project-config.md` |
| 2.9 | No assignment message example anywhere | Add a complete assignment message example to AGENTS.md showing `task:`, `launch:`, `scope:` frontmatter | `templates/AGENTS.md` |
| 2.10 | Default team omits architect and scout | Add architect and scout to the default agent team in project-config.md (commented out with note: "uncomment to activate") | `templates/project-config.md` |

**Agents:** alpha on 2.1-2.5, beta on 2.6-2.10. gamma reviews both.
**Verify:** Fresh `hive init` produces usable templates. An agent reading PLAN.md or BOARD.md for the first time knows the format without guessing.

---

### Phase 3 — Token Trimming (P3)
Requires taste. The goal: SOUL.md ≤ 800 tokens. Total personality stack
overhead (SOUL + IDENTITY + persona) ≤ 2,000 tokens per agent prompt.

| # | Issue | Fix | Files |
|---|-------|-----|-------|
| 3.1 | SOUL.md is ~1,800 tokens and does three jobs (culture + philosophy + coordination) | Split: keep "Who We Are", "Core Truths", and "Our Standard" in SOUL.md (~800 tokens). Move "How We Work Together" and "Our Discipline" content to AGENTS.md (where it belongs — those are operational protocols, not culture). Delete "Vibe" (31 words, zero behavioral impact). Compress "How We Think" from six mini-essays to six one-liners. | `templates/SOUL.md`, `templates/AGENTS.md` |
| 3.2 | IDENTITY.md mostly duplicates SOUL.md | Trim to: "What I Am" (2 sentences), "What I Optimize For" (4 bullets), "How The Stack Fits" (file map — the only unique value). Cut "What I'm Not" and "Continuity" sections. Target: ≤ 300 tokens. | `templates/IDENTITY.md` |
| 3.3 | Persona "Working With the Team" sections are symmetric filler | Cut or compress to 2-3 lines max per persona. Only keep content that's genuinely asymmetric (e.g., how the critic gives feedback differently than how others receive it). | `templates/personas/*.md` |
| 3.4 | Skill frontmatter (`name`, `scope`, `description`) is dead metadata never parsed | Remove YAML frontmatter from skill templates. If we want metadata later, parse it in code first. | `templates/skills/*.md` |
| 3.5 | `renderProjectMemoryTemplate` is hardcoded in TypeScript | Extract to `templates/project-memory.md` to match the pattern of every other template | `src/lib/templates.ts`, new: `templates/project-memory.md` |
| 3.6 | state-efficient-ops.md claims `hive status` is "cheaper" than reading BOARD.md (it's not) | Fix the claim. `hive status` reads the same data. Reframe as "prefer `hive status` for formatted overview; read BOARD.md directly when you need to parse task state" | `templates/skills/state-efficient-ops.md` |

**Agents:** alpha on 3.1-3.2 (the big SOUL/IDENTITY compression — needs taste), beta on 3.3-3.6 (mechanical). gamma reviews the SOUL compression specifically since it's the highest-risk change.
**Verify:** Token-count SOUL.md (target ≤ 800). Token-count full prompt assembly for a worker agent (target ≤ 2,000 for personality stack). Confirm no meaning was lost — the compressed versions should still produce the same agent behavior.

---

## Sequencing

```
Phase 1 (bugs)     ──→ Phase 2 (quality)     ──→ Phase 3 (trimming)
  alpha: 1.1-1.4        alpha: 2.1-2.5            alpha: 3.1-3.2
  beta:  1.5-1.6        beta:  2.6-2.10           beta:  3.3-3.6
                         gamma: review both         gamma: review SOUL
```

Phase 1 first because some Phase 2 work (AGENTS.md additions) depends on
the contradiction fixes landing first. Phase 3 last because trimming is
easier after the content is correct.

## Rules
- Read BOARD.md before starting work.
- Check ~/.hive/msg/ between major steps.
- Post all deliverables and status changes via msg/.
- Append decisions and learnings to LOG.md.
- Treat `~/.hive/projects/hive/BOARD.md` as the live source of truth.
- Every template change must be tested with a fresh `hive init` in /tmp.
- No change to live `~/.hive/` files — only to `templates/` and `src/`.
  The user's live config is their own; we fix the source of truth.

## Success Criteria
1. `hive init` in an empty dir produces a working system with no dead references
2. No personal content (names, reading lists, project names) in any template
3. SOUL.md ≤ 800 tokens
4. Full personality stack (SOUL + IDENTITY + persona) ≤ 2,000 tokens
5. Zero contradictions between AGENTS.md, skills, and PLAN.md
6. TRUST.md is loaded into agent prompts
7. All templates include format examples where agents need to produce structured output
