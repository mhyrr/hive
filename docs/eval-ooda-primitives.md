The three OODA primitives are a strong first cut: `anthropic-client.ts` has explicit timeout/error types, and both `orientation.ts` and `tactical-evaluator.ts` fail closed instead of crashing the loop.  
The biggest code smell is `parseOrientation` returning `null as unknown as OrientationSummary`, which bypasses TypeScript’s guarantees and can hide misuse at call sites.  
`tactical-evaluator.ts` does synchronous `appendFileSync` on every signal, which risks blocking the event loop during bursty watcher activity and undermines the “fast tactical loop” goal.  
`parseRouting` accepts `interrupt:` and `tactical_action:` without validating non-empty payloads, so malformed model output can produce meaningless commands instead of clean fallback behavior.  
`anthropic-client.ts` handles timeouts correctly, but it has no retry/backoff path and no special handling for 429/5xx classes, so transient provider issues can degrade evaluation quality quickly.  
Both parsers are regex-fragile and tightly coupled to exact output shape/casing, which means harmless formatting drift from the model will likely increase fallback frequency.  
What’s good is the continuity discipline: last-known orientation is preserved, evaluator fallback routes to log, and the system keeps running under model/API faults.  
Net: solid scaffolding and sane failure philosophy, but reliability under real load depends on tightening parse contracts and removing blocking I/O from the hot path.
