# Context Assembly Cost — Problem Statement

**Status:** Parked. Revisit after prompt caching / token efficiency pass is complete.

## Problem

Every steward turn calls `loadStewardContext()`, which performs 11+ parallel file reads and assembles ~25 fields of context (soul, identity, self, board digest, messages digest, runs digest, results digest, inbox digest, memory hotset, knowledge, decisions, entities, routing policy, etc.).

This full context surface is loaded regardless of the complexity of the human's request. A simple "what's the status?" pays the same context assembly cost as "plan and execute a multi-worker refactoring."

`refreshProjectRuntimeState()` rebuilds all summaries (board, messages, runs, inbox) from raw files every turn, even when nothing has changed.

## Why it matters

- Context assembly is in the critical path of every interaction
- Larger context windows = more tokens = higher latency + cost
- As memory and state grow, this cost scales linearly
- The steward prompt becomes a kitchen sink rather than a focused briefing

## Desired end state

- Tiered context loading: simple queries get minimal context, complex work gets full context
- Change-aware state refresh: skip rebuilding summaries when underlying files haven't changed
- Prompt caching leveraged so unchanged context sections hit cache, not re-tokenization
- A pre-classifier (cheap/deterministic) could signal context requirements before the steward LLM wakes

## Relationship to other tensions

This interacts with the "steward does too much" problem. If routing decisions move out of the steward LLM and into a deterministic layer, the deterministic layer can also decide *what context the steward needs* for a given turn, making context assembly targeted rather than exhaustive.

## Constraints

- Must not break warm-session delta mode (already a partial solution)
- Must not sacrifice context quality for speed — the steward should never be under-informed for complex tasks
- Prompt caching strategy (in progress) may resolve a large portion of the token cost; evaluate that first before adding structural complexity
