# Prompt Minification — design

**Status:** proposal, 2026-08-23
**Scope:** the session-start injection (identity emit + CLAUDE.md + MCP tool docs)
**Touches:** `2026-08-16-context-layer-design.md` (same budget, other end of the pipe),
`docs/identity-injection.md` (what loads), TK-133/TK-134 (the manual slim-down this
mechanizes)

---

## 1. The analogy, taken seriously

The ask: JavaScript ships through a minifier — humans write readable source, the wire
carries the densest equivalent form. HIVE's session-start injection is hand-written
English shipped raw. Build the minifier: compress the injection to its most
token-efficient form while preserving semantic meaning, where *semantic preservation is
the measured invariant*, not a hope.

The analogy holds better than expected, in three specific ways:

1. **Source ≠ dist.** Nobody edits minified JS. The soul stack stays human-authored,
   readable, diffable English — the source of truth. Minification produces a build
   artifact. `hive identity emit` serves the artifact when it's fresh, the source when
   it isn't. Editing experience is untouched.
2. **Minification is the *last* optimization, not the first.** In JS, tree-shaking and
   dead-code elimination dwarf whitespace stripping. Same here: the research is
   unambiguous that *deleting and scoping instructions* beats *rewording them* (the
   published 90%+ CLAUDE.md reductions came from deletion and load-on-demand scoping,
   not compression). The compiler should do both, in that order.
3. **A minifier you can't trust is worthless.** Terser has semantics-preserving
   transforms and a test suite. Our equivalent is a fidelity gate: no compressed
   artifact ships without passing a measured semantic-preservation check against its
   source.

One place the analogy breaks, and it's load-bearing: **in JS, only the machine reads
the output. Here, the reader is also the thing being shaped by the *style* of the
text.** SOUL.md and the persona register don't just carry propositions — their register
*is* their function. A telegraphic rewrite of "Dry humor when it's natural. Forced
cleverness lands worse than no humor" preserves the claim and destroys the
demonstration. This forces a taxonomy (section 3) instead of one uniform pass.

---

## 2. What we inject today, and what it costs

Everything flows through `collectIdentityComponents` (`src/lib/identity.ts`), audited
by `hive context` (`src/lib/context-report.ts`). Post-slim baseline ~30KB (~7.5K
tokens) against a 40KB warn budget; pre-slim it ran ~63KB.

| Layer | Live size | Authored by | Nature |
| --- | --- | --- | --- |
| Soul stack (SOUL/IDENTITY/SELF/AGENTS/TRUST) | ~20KB | human | mixed: voice + policy + facts |
| Persona register (`personas/dry.md`) | ≤4KB | human | voice |
| Project memory `_index.md` | 4.2–6.9KB | machine (nightly `rebuildIndex`) | facts |
| Stack hint | ~0.2KB | machine | policy |
| Taste layer (`principles.md`) | ~2KB | human | policy |
| Project `CLAUDE.md` | ≤16KB | human | policy + facts |
| MCP tool descriptions (`mcp-server.ts`) | ~4KB across 14 tools | human, in code | tool docs |

Three observations the design hangs on:

- **About a third of the bytes are machine-generated.** Compressing generated text
  after generation is backwards — change the generator and the "compression" is free,
  deterministic, and lossless by construction.
- **The hand-authored remainder splits into voice and policy/facts**, and the research
  says these compress very differently (section 3).
- **Cost is context budget more than dollars.** Claude Code prompt-caches its prefix;
  warm turns pay 0.1x on the injection already. What caching can't refund is the
  window itself: ~7.5K tokens of standing preamble diluting attention every turn, and
  a bite out of the ~150–200-instruction adherence budget frontier models empirically
  carry. Minification's real payoff is attention, with cold-start cost and rate-limit
  headroom as side benefits. Corollary: the minifier must be **byte-deterministic** —
  a compressor that emits different output per run breaks the cache and costs more
  than it saves.

---

## 3. What the research says

Full trail in the references at the end. The findings that change the design:

**Token-deletion compressors (LLMLingua family) are wrong for instruction blocks.**
They're trained on transcripts and RAG documents, mangle exact strings (paths, flags,
tool names), and attention studies show instruction adherence is the first casualty of
aggressive compression — the original LLMLingua even hard-codes *protecting*
instructions and compressing only demonstrations. Where they shine — long retrieved
payloads at 2–5x — is a `search_memory` runtime concern, out of scope here.

**Format-level compression of constraints is nearly free.** A 2026 study across 11
models found ~71% token reduction on constraint encodings with no significant
compliance difference. Compliance tracked *which* rules were asked, not how verbosely.
Separately, "Telegraph English" — atomic fact lines, ~40 relational symbols — hits
~50% reduction at 99% key-fact retention and beats LLMLingua-2 at every matched ratio.
Telegraphic key:value / fact-line style is the sweet spot; full symbolic metalanguages
(SynthLang) are brittle and cost their savings back in decoder instructions.

**Two caveats that survive compression:** keep a one-line *why* on counterintuitive
rules (a model that doesn't know the reason "corrects" the rule — our own
"rm-then-cp — cdhash cache" line is the canonical example), and keep exact strings
verbatim (code spans are immutable to the compressor).

**Caveman-style is an output discipline, not an input one.** Its measured wins are
response-token reduction; input-side claims are anecdotal. Our SOUL.md already
mandates STE + Zinsser, which is why the stack sits at 30KB, not 63KB — the marginal
gain from telegraphing already-terse *voice* prose is small and the register cost is
real.

**Tokenizer mechanics:** Markdown headers/bullets are ~1–2 tokens — structure is
cheap, don't strip it, it aids navigation. Pretty-printed JSON is the expensive
format; terse Markdown or key:value lines win for rules. Article-stripping saves ~1
token per article — real, minor, and last in priority. Measure with Anthropic's
`count_tokens` endpoint, never a chars/4 estimate, when the gate decides
accept/reject.

**The LLM-as-compressor + eval-loop pattern (Style-Compress, EMNLP 2024) is the SOTA
for exactly our case:** strong model rewrites offline, candidates judged by downstream
fidelity, best kept. Nothing mature exists off-the-shelf with a fidelity guarantee —
the pieces (rewrite, QA probes, token counting) are all things HIVE already knows how
to run. This is greenfield worth owning, which also answers the "separate library?"
question: yes, eventually — see section 8.

---

## 4. Design: a compiler with a fidelity gate

### 4.1 Content classes, different transforms

Every injected component gets classified (front-matter key `minify:` in the source
file, defaulting by layer):

| Class | Components | Transform |
| --- | --- | --- |
| `generated` | `_index.md`, stack hint | none at compile time — fix the generator (4.4) |
| `policy` | AGENTS.md, TRUST.md, taste `principles.md`, CLAUDE.md (opt-in), MCP tool descriptions | LLM rewrite → telegraphic fact/rule lines, gated (4.3) |
| `facts` | SELF.md, the factual sections of IDENTITY.md | same as policy, highest expected ratio |
| `voice` | SOUL.md, persona register, character sections of IDENTITY.md | **exempt** from rewriting; dead-weight trim only (filler sentences, duplicated statements) with the same gate |

The `voice` exemption is a decision, not a hedge: the register of those files is the
mechanism by which they work, the fidelity gate below cannot measure register
transfer (QA probes check propositions), and an unmeasurable transform fails our own
"no compressed artifact without a passing gate" rule. If voice compression is ever
worth it, it needs behavioral evals (A/B sessions judged for voice), which is a
research project, not a build step. Cheap alternative that captures most of the win:
keep authoring voice files under STE discipline and let `hive context` budgets nag.

### 4.2 Source → dist mechanics

```
~/.hive/AGENTS.md                    (source, human edits)
~/.hive/build/AGENTS.min.md          (artifact)
~/.hive/build/manifest.json          (per-component: source hash, artifact hash,
                                      src/min token counts, gate scores, model, ts)
```

- `hive identity emit` consults the manifest: artifact fresh (source hash matches) →
  emit artifact; stale or missing → emit source. **A failed or missing compile never
  blocks or degrades a session** — same posture as the identity hook itself.
- Compile trigger: nightly **Pass M** in the orchestrator (after F/P, so the
  regenerated index and any soul edits are settled), plus `hive minify` for on-demand
  runs and `hive minify --check` for CI. Hash-gating means the steady-state nightly
  cost is zero — sources rarely change.
- Reuses `completeClaudeTextBounded` (`src/lib/claude.ts`) like Pass V; compiler model
  is Opus-class (it runs rarely; quality over cost), fidelity judges Sonnet-class.
- Determinism: artifacts are committed bytes, reproducible only on source change —
  re-minifying an unchanged source is a no-op by hash, so cache prefixes stay stable
  across sessions regardless of model nondeterminism at compile time.
- `emit` prepends one line to the artifact block:
  `Style note: sections below are compressed; telegraphic form is intentional.` —
  one sentence of decoder context, so terseness isn't read as a register instruction.
  (Whether this line matters is a Phase-1 eval question; drop it if not.)

### 4.3 The fidelity gate

The measured invariant the user asked for. Per component:

1. **Probe generation** (from *source*, cached alongside it): ~8–15 QA probes per
   component — factual ("what model does Watch Act default to?"), behavioral ("user
   says 'save a memory' — which tool?"), and negative ("is `git add -A` ever
   acceptable without an explicit request?"). Behavioral probes are the important
   ones for `policy` — they test that the rule still *fires*, not just that it's
   still stated.
2. **Blind answering:** fresh model instance answers probes given *only* the
   candidate artifact.
3. **Judging:** LLM judge scores each answer against the source-derived expected
   answer. Also mechanical checks, no LLM: every code-span string, path, tool name,
   and number in the source appears verbatim in the artifact (entity retention — the
   known blind spot of downstream-only evals).
4. **Accept/retry/reject:** all mechanical checks pass AND probe score ≥ threshold
   (start: 100% on behavioral/negative probes, ≥90% on factual) → accept. Otherwise
   retry once with the failures quoted in the compile prompt; still failing → reject,
   manifest records the failure, emit keeps serving source. A rejection is a report,
   not an error.
5. **Ratio floor:** artifact must be ≥25% smaller (real `count_tokens`, not bytes) or
   we keep the source — a compile that saves 8% isn't worth a second representation
   of the truth.

Gate artifacts (probes, answers, judgments) land in `~/.hive/memory/runs/{DATE}/`
next to the other nightly outputs, so a bad compile is diagnosable after the fact.

### 4.4 The generator fixes (no LLM, do first)

`rebuildIndex` (`src/lib/memory.ts`) renders prose scaffolding into every index:
banner blockquote, section headers with counts, `_(N more — use search_memory...)_`
trailers, full ISO timestamps on decisions and log lines. Deterministic changes:
date-only timestamps, `|`-delimited log lines, collapse the banner to one line, move
the "more exists" trailers into a single closing line. Estimated 15–25% off the
index at zero risk, plus the same pass over `buildStackHint` and the 14 MCP tool
descriptions in `mcp-server.ts` (several restate what the schema already encodes).
These are ordinary PRs against the generators — no new machinery — and they shrink
the *source*, which compounds with everything else.

### 4.5 What we are explicitly not doing

- **No LLMLingua/perplexity pruning** on the injection (wrong domain, breaks exact
  strings, hurts adherence first).
- **No symbolic metalanguage** (decoder tax, brittleness across model versions).
- **No runtime compression** — everything happens offline; session start stays a file
  read.
- **No voice rewriting** without a behavioral eval harness that doesn't exist yet.
- **No auto-deletion of rules.** The bigger lever than rewording is pruning
  instructions the model would follow anyway and scoping rarely-needed ones to
  load-on-demand — but *which* rules are dead is a judgment call. Pass M ends with a
  report ("these 4 rules restate harness defaults; these 6 fire only in Elixir
  projects — candidates for stack-scoping"), and a human deletes. Same admission
  philosophy as the verifier: the pipeline proposes, canon changes deliberately.

---

## 5. Measurement surface

`hive context` grows a compiled view: per-component `src → min` tokens, ratio, gate
score, staleness; totals for both. The existing budgets then check the *emitted*
number (min when fresh), and a new nag appears when an artifact is stale or rejected.
`--json` already exists for tracking over time; the manifest gives it the compile
dimension for free.

Success criteria for the feature itself:

- Emitted injection ≤60% of source tokens on `policy` + `facts` layers (research
  says ~50% is attainable at 99% fact retention).
- Zero gate regressions shipped (an artifact never serves while its gate fails).
- No measurable drift in session behavior — spot-check via the existing reflection
  loop: if reflections start surfacing "Maya ignored X" where X lives in a compiled
  layer, that's the alarm.

---

## 6. Phasing

**Phase 0 — generators + truth (no LLM, ~a day):** 4.4 generator slimming; real
`count_tokens` in `hive context` behind a flag (estimate stays the default, offline).
Ships value alone even if nothing else is built.

**Phase 1 — the compiler (the feature):** `src/lib/minify.ts` (classify, compile,
gate, manifest) + `hive minify` / `--check` + emit integration + Pass M wiring.
`policy` and `facts` classes only. AGENTS.md and TRUST.md first — highest
policy-density, easiest probes.

**Phase 2 — reach:** CLAUDE.md opt-in (it's repo content, so the artifact lives in
the repo: `.claude/claude.min.md` or equivalent, and the mechanism needs a
per-project story); MCP tool description pass; the scoping/dead-rule report from 4.5.

**Non-phase:** voice compression stays out until someone builds the behavioral eval
that could gate it.

---

## 7. Risks

- **Two representations of the truth.** Mitigated structurally: dist is
  hash-invalidated, never hand-edited, never wins over a fresh source, and `hive
  doctor` flags manifest drift like it flags hook drift.
- **The gate measures propositions, not effect.** True, and it's why voice is exempt.
  For policy, behavioral probes narrow the gap; the reflection loop is the backstop.
- **Compile-time model dependency.** Pass M inherits the nightly run's auth posture
  (subscription OAuth, fail loud). A failed compile costs nothing — source serves.
- **Anchoring the style note wrong.** If the one-line decoder note bleeds into output
  register, drop it and re-eval; the artifact must stand without apology.

## 8. Library extraction

The compiler core is deliberately HIVE-agnostic: `minify.ts` takes
`{content, class, immutableSpans}` and a model-call function, returns
`{artifact, gateReport}`. Paths, manifest, Pass M wiring, and emit integration stay
HIVE-side. If it proves out here, the core + fidelity harness lift into a standalone
package (`prompt-minify`?) with a CLI — the research found no mature tool doing
"compress an instruction block with a fidelity guarantee," so there's a real gap.
Decision deferred until Phase 1 has run against our own stack for a few weeks;
extracting before the gate design stabilizes would freeze the wrong interface.

---

## References

Compression methods: LLMLingua family (github.com/microsoft/LLMLingua;
arxiv.org/pdf/2403.12968; arxiv.org/abs/2310.06839), practical limits
(arxiv.org/abs/2604.02985), Style-Compress (arxiv.org/abs/2410.14042), information
preservation & entity retention (arxiv.org/abs/2503.19114), survey
(arxiv.org/abs/2410.12388).

Compressed instructions: compact constraint encoding, ~71% cut at equal compliance
(arxiv.org/abs/2604.07192); Telegraph English, ~50% at 99% retention
(arxiv.org/abs/2605.04426, arxiv.org/abs/2606.14875); constraint compliance degrades
before semantics (arxiv.org/pdf/2512.17920); attention shift under compression
(arxiv.org/pdf/2602.15856).

Format/token mechanics: wonderwhy-er.github.io/format-token-comparison;
jangwook.net/en/blog/en/llm-token-cost-data-format-experiment.

Caching: platform.claude.com/docs/en/build-with-claude/prompt-caching (0.1x reads,
1.25x/2x writes, strict prefix match, model-dependent minimum prefix).

Ecosystem: Caveman plugin coverage (betterstack.com/community/guides/ai/caveman-llm);
CLAUDE.md reduction case studies — deletion and scoping, not rewording
(maketocreate.com/claude-md-best-practices-the-complete-2026-guide).
