# Skill: Cognitive Resource Routing

Optimize for expected answer quality per unit of latency and cost.
Escalate only when extra cognition is likely to change the answer.

## The Core Question

Before you read more files, launch workers, or wait on parallel work, ask:

Will extra depth materially improve the answer?

- If no: answer directly from compact state, deterministic checks, or your current understanding.
- If maybe: do targeted inspection. Read only the files or results most likely to change the answer.
- If yes: fan out intentionally, then synthesize.

## Routing Modes

### 1. Direct Answer

Use when:
- the question is clear
- the stakes are routine
- extra perspectives are unlikely to change the answer
- compact state or recent worker output already covers the need

Default shape:
- depth: steward only
- fan-out: none
- parallelism: 1

Examples:
- simple status checks
- straightforward directives
- short explanations grounded in recent state
- answers already covered by fresh worker output

### 2. Targeted Inspection

Use when:
- one or two missing facts could change the answer
- you need to verify state before replying
- deeper reads matter more than extra perspectives

Default shape:
- depth: targeted file reads, run inspection, or one scoped worker
- fan-out: at most one worker by default
- parallelism: keep it serial unless the checks are obviously independent

Examples:
- inspect a plan section before answering
- verify whether a worker actually changed the relevant file
- check recent run output before deciding whether to reassign work

### 3. Plural Synthesis

Use when:
- ambiguity is real
- the answer depends on meaningful trade-offs
- the stakes are high enough that a weak answer is expensive
- different specialist perspectives are likely to change the result

Default shape:
- depth: gather distinct perspectives, then synthesize in the steward
- fan-out: 2 perspectives by default, 3 only when clearly justified
- parallelism: parallelize only when scopes are independent and synthesis quality justifies the wait

Examples:
- architecture decisions
- major implementation plans
- review plus counter-review
- high-leverage user asks where critique materially improves the output

## Runtime Lane Rules

- Claude sessions have an implicit Pi route and should stay on the Pi/Anthropic OAuth lane unless policy explicitly says otherwise.
- Codex and Gemini default to direct CLI-backed lanes unless `pi-provider-<runtime>` explicitly routes them through Pi.
- Do not assume Pi for Codex or Gemini just because Pi exists.
- Reuse fresh worker output before launching more workers.
- Prefer the cheapest cognition that is still likely to change the answer.

## Fan-Out Discipline

- Start with one strong reason to fan out, not a vague feeling.
- Prefer distinct perspectives over redundant ones.
- A generative angle plus a critical angle is usually the best first pair.
- Do not parallelize workers that will contend on the same files or task boundary.
- If the added perspectives are unlikely to change the conclusion, stop escalating.
