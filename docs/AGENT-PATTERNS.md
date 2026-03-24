# Agent Architecture Patterns

Lessons from building Claude Code, applied to Hive.

**Sources:**
- "Seeing Like an Agent" — tool design, elicitation, progressive disclosure (@trq212)
- "Prompt Caching Is Everything" — prefix ordering, cache-safe state transitions (@trq212)
- "Your Agent Should Use a File System" — file state, memory as files, subagent patterns (@trq212)
- Claude Agent SDK documentation — sessions, hooks, subagents, skills

## What Hive Already Does Well

These patterns from the articles are core to Hive's architecture:

**File system as state.** `~/.hive/` is the durable substrate. Markdown + JSON state files. Everything on disk, all processes stateless. Kill anything, restart, resume. This is exactly what the articles advocate: "The file system is an elegant way of representing state that your agent could read into context & allowing it to verify its work."

**Agentic search over RAG.** The steward has grep, find, and read tools. It builds its own context by searching rather than having context pre-loaded via vector embeddings. "By giving Claude a Grep tool, we could let it search for files and build context itself."

**Multi-agent coordination via files.** Workers write results to files. The steward reads and synthesizes. Assignment messages in `msg/` trigger worker launches via file watchers. This matches the "deep research pattern" — subagents write findings to the file system, orchestrator reads across them.

**Memory as searchable files.** The `memory/` directory stores knowledge, decisions, entities, and journal entries as markdown and JSON. The steward can search and read them on demand.

**Event-driven handoffs.** File watchers fire ~200ms after state changes. No polling loops. Assignment → worker launch → result → steward notification, all mediated by the file system.

## Multi-Model Caching

Hive is multi-model (Claude, Codex, Gemini, Ollama) and routes through the Pi-Agent SDK. All system prompts, tools, and messages flow through a unified interface:

```
agent.setSystemPrompt(text)   // identical across providers
agent.setTools(tools)          // provider-agnostic Tool objects
agent.prompt(message)          // unified interface
```

Prompt caching works **automatically** on all major providers via prefix matching:
- Anthropic: automatic prefix caching on all API requests
- OpenAI: automatic prefix caching (since late 2024)
- Gemini: context caching

Hive doesn't need provider-specific cache control. **Stable prefix = free cache hits on every provider.** The optimization is structural: order content so the prefix stays stable, use messages for updates instead of prompt mutations, never change tools mid-session.

## Pattern 1: Prompt Structure for Caching

**Principle:** "We build our entire harness around prompt caching. We run alerts on cache hit rate and declare SEVs if they're too low."

### The ordering rule

Static content first, dynamic content last. Every request should share as long a prefix as possible with previous requests.

```
Layer 1 (globally stable):  System prompt — soul, identity, self, tools
Layer 2 (session-stable):   Cognitive routing policy, model pool, session prompt
Layer 3 (turn-dynamic):     State updates, notifications, human message
```

Layers 1-2 are set once via `agent.setSystemPrompt()` and `agent.setTools()`. Layer 3 arrives as conversation messages via `agent.prompt()`.

### Messages for updates, not prompt mutations

When context changes (new revision, worker completion, board update), don't rebuild the system prompt. Send the update as a message in the conversation. Claude Code uses `<system-reminder>` tags in user messages for this.

Hive's equivalent: the bootstrap message is sent once. Subsequent turns send lightweight refresh messages with only what changed (delta history, notifications, compact state diff).

### Never change tools mid-session

Tools are part of the cached prefix. Adding or removing a tool invalidates the cache for the entire conversation. Keep the tool set stable. Use the tool *definitions* to model state transitions rather than swapping tools in and out.

Hive already does this correctly — `buildPersistentStewardTools()` is called once per handle creation.

### Cache-safe forking

When you need to fork context (compaction, summarization), reuse the parent's exact prefix. Same system prompt, same tools, same conversation history prefix. Only the final message differs.

## Pattern 2: Progressive Disclosure

**Principle:** "Claude went from not being able to build its own context, to being able to do nested search across several layers of files to find the exact context it needed."

### The problem with context dumps

Loading all context into every prompt creates:
- **Context rot:** stable information crowds out the current task
- **Token waste:** paying for context the model doesn't need this turn
- **Attention dilution:** important signals buried in routine state

### The solution: inspection tools

Instead of pushing all state into the prompt, give the agent tools to pull what it needs:

```
inspect_board()       — full board with task details
inspect_messages()    — open messages, optionally filtered
inspect_memory()      — search project memory by topic
inspect_results()     — recent run results by scope
inspect_history()     — delta history entries
```

Bootstrap with a compact summary (project, 3-line status, counts of open items, pointers to tools). The steward reads deeper only when the current task requires it.

### Progressive disclosure is cache-friendly

These inspection tools are added to the tool set once and never change. The compact bootstrap message is smaller and more stable than a full context dump. Both properties improve cache hit rates.

## Pattern 3: Structured Elicitation

**Principle:** The AskUserQuestion tool was the "sweet spot" between freeform markdown (messy, unreliable formatting) and rigid parameters (plan already formed, questions come too late).

### Why a dedicated tool

Freeform questions in prose are:
- Hard to parse programmatically
- Easy for the model to forget to ask
- Lacking clear UI affordance for the human

A structured `ask_human` tool provides:
- Named parameters (question, options, context)
- Gateway renders as decision cards with clickable options
- Non-blocking mode for low-priority questions
- The model "likes calling it" — critical for adoption

### Blocking vs non-blocking

Some decisions gate further work (which approach? which model?). Others are informational (FYI, preference noted). The `blocking` parameter lets the steward continue working while the human considers non-urgent questions.

## Pattern 4: Tasks Over Todos

**Principle:** "Whereas Todos were about keeping the model on track, Tasks were more about helping agents communicate with each other."

### From flat lists to dependency graphs

Flat task lists constrain advanced models. They can't express:
- Task 3 depends on Task 1 and Task 2
- Worker A needs Worker B's output before starting
- This blocker gates three downstream tasks

Dependencies in BOARD.md enable the supervisor to automatically sequence work — launching tasks only when their prerequisites are satisfied.

### Cross-agent visibility

Workers should see relevant sibling task statuses. "I'm working on task-3, which depends on task-1 (completed) and task-2 (in progress)." This context helps workers make better decisions about scope and urgency.

## Design Principles

Distilled from the articles and our experience:

1. **Tools shaped to abilities.** Don't give 50 tools or 1 tool. Find the sweet spot matching the model's capabilities. "You want to give it tools that are shaped to its own abilities."

2. **Experiment and observe.** "Designing the tools for your models is as much an art as it is a science. Experiment often, read your outputs, try new things."

3. **Revisit assumptions.** "As model capabilities increase, the tools that your models once needed might now be constraining them." What worked for Sonnet 3.5 may not be right for Opus 4.6.

4. **File system is the API.** Files for state, files for communication, files for memory. The file system is inspectable, durable, and composable.

5. **Cache as architecture.** Prompt caching isn't an optimization to bolt on — it's a constraint that shapes system design. Static first, messages for updates, stable tool sets.

6. **Let agents find context.** Don't dump context. Give agents search tools and let them build their own understanding. This scales better and produces more relevant context.

7. **Monitor like production.** "Monitor your cache hit rate like you monitor uptime." If it breaks, treat it as an incident.
