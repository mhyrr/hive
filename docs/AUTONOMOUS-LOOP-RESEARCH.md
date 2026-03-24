# Autonomous Loop Research

Two naming corrections matter here. First, **OpenClaw and OpenHands are different systems**. Second, I could not find an official OpenClaw or OpenHands document that names a built-in control primitive the "Ralph loop." The official OpenClaw docs describe sessions, heartbeats, cron jobs, compaction, and queues. "Ralph loop" shows up instead in community scripts and HIVE's own notes as an **external relaunch wrapper** around disposable coding-agent runs. That part is inference from community usage, not vendor docs. Sources: [OpenClaw home](https://docs.openclaw.ai/), [OpenClaw agent loop](https://docs.openclaw.ai/concepts/agent-loop), [community OpenCode Ralph loop gist](https://gist.github.com/fripSide/a722305eaad1b8e0c8c53cbb161193ed), [community Ralph bash gist](https://gist.github.com/fredflint/d2f44e494d9231c317b8545e7630d106).

## OpenClaw / OpenHands

**OpenClaw.** Documented OpenClaw is a long-lived, session-oriented gateway. A run enters through `agent` / `agent.wait`, gets serialized per session lane, assembles context, invokes the embedded Pi runtime, streams events, and ends on success, error, or timeout. The gateway is the source of truth for session state. Sessions persist as history plus metadata; compaction summarizes old context into JSONL history; memory lives in Markdown; and OpenClaw can do a pre-compaction "memory flush" turn to push durable notes to disk. Sources: [agent loop](https://docs.openclaw.ai/concepts/agent-loop), [session management](https://docs.openclaw.ai/concepts/session), [memory](https://docs.openclaw.ai/concepts/memory), [compaction](https://docs.openclaw.ai/concepts/compaction), [queue](https://docs.openclaw.ai/queue).

Goal state between iterations is therefore **session state plus workspace files**, not a fresh-prompt reconstruction. Next iterations are triggered by inbound messages, heartbeats, cron jobs, or system events. Heartbeats matter because they run agent turns, but OpenClaw adds cost controls: isolated sessions, lightweight context, active hours, cheaper models, and skipping empty `HEARTBEAT.md`. Sources: [heartbeat](https://docs.openclaw.ai/gateway/heartbeat), [cron jobs](https://docs.openclaw.ai/automation/cron-jobs), [cron vs heartbeat](https://docs.openclaw.ai/automation/cron-vs-heartbeat).

**Done vs stuck in OpenClaw is only partly explicit.** Documented "done" means the agent stops requesting tools and emits a final reply, or `agent.wait` returns `ok`; for heartbeats, `HEARTBEAT_OK` is a mechanical no-op. What the docs do **not** provide is a first-class coding-task completion oracle. "Stuck" is mostly operational: timeouts, queue waits, compaction retries, and diagnostics such as `session.stuck`, not a semantic deadlock test. My read: OpenClaw is strong on **session continuity**, weaker on **task-level termination semantics**. Sources: [agent loop](https://docs.openclaw.ai/concepts/agent-loop), [heartbeat](https://docs.openclaw.ai/gateway/heartbeat), [logging/diagnostics](https://docs.openclaw.ai/logging).

**Known failure modes in OpenClaw.** The docs warn about DM-context leakage if multiple people share the default `dmScope: "main"`, prompt-cost blowups from full-session heartbeats, and the need for serialization/compaction. A persistent head agent without hard isolation and cost controls becomes expensive and leaky fast. Sources: [session management](https://docs.openclaw.ai/concepts/session), [heartbeat](https://docs.openclaw.ai/gateway/heartbeat), [queue](https://docs.openclaw.ai/queue).

**OpenHands.** OpenHands' public SDK docs are much closer to a coding-agent loop. The core abstraction is a `Conversation` that manages lifecycle, state, events, persistence, execution status, tools, and local or remote workspaces. `ConversationState.create()` can create or resume from persistence, and CLI docs say conversation history is stored locally and can be resumed from disk. The architecture doc is explicit that conversation state includes an event log, execution status, max iterations, persistence directory, blocked actions/messages, workspace, and optional stuck detection. Sources: [OpenHands conversation architecture](https://docs.openhands.dev/sdk/arch/conversation), [conversation API](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.conversation), [resume conversations](https://docs.openhands.dev/openhands/usage/cli/resume).

OpenHands is much clearer than OpenClaw about **done vs stuck**. It has terminal execution statuses including `FINISHED`, `ERROR`, and `STUCK`, and its stuck detector is enabled by default. The detector catches five failure patterns, including repeating loops, agent monologues, ping-pong cycles, and repeated context-window errors. OpenHands also documents a concrete automation failure mode: some models emit a `MessageEvent` and wait for human input instead of `FinishAction`, so one-off wrappers need to auto-respond or the run ends early. Sources: [stuck detector](https://docs.openhands.dev/sdk/guides/agent-stuck-detector), [SDK FAQ](https://docs.openhands.dev/sdk/faq).

OpenHands also shows real operational fragility in public issues: conversation creation can succeed while agent-session startup or remote runtime readiness fails. That is a different failure mode from "bad reasoning": the loop is fine, but the containerized runtime becomes the bottleneck. Sources: [issue #7627](https://github.com/All-Hands-AI/OpenHands/issues/7627), [issue #9127](https://github.com/All-Hands-AI/OpenHands/issues/9127), [issue #8705](https://github.com/All-Hands-AI/OpenHands/issues/8705).

## SWE-agent

SWE-agent is the cleanest documented example of a **task-bounded autonomous loop**. The goal is represented as a problem statement plus a trajectory through a sandboxed repo. The main loop repeatedly calls `step()` until `step_output.done`, saving trajectory data after every step. The newer `RetryAgent` wraps this in an attempt-selection loop: after a submission, a retry loop can decide whether to launch another attempt, then choose the best attempt at the end. This is materially different from OpenClaw/OpenHands conversation continuity; SWE-agent treats each attempt as a bounded run against a problem instance. Sources: [SWE-agent paper](https://arxiv.org/abs/2405.15793), [agent class docs](https://swe-agent.com/latest/reference/agent/).

SWE-agent's context strategy is explicit. It uses trajectories plus configurable history processors. The canonical one, `LastNObservations`, elides all but the last `n` observations; the original paper used `n=5`. Partial results are not just side effects in the filesystem; they are written into the trajectory and reused by the agent and retry loop. Sources: [history processors](https://swe-agent.com/1.0/reference/history_processor_config/), [config docs](https://swe-agent.com/latest/config/config/).

Termination and cost governance are mechanical. `submit` is the main completion action. If errors occur, SWE-agent attempts autosubmission by extracting the patch anyway. Model-side requeries are capped, per-instance and total cost limits exist, and API-call retry settings are configurable. Known failure modes are formatting errors, blocked actions, bash syntax errors, and context loss from aggressive history elision. Sources: [agent config](https://swe-agent.com/1.0/reference/agent_config/), [model config](https://swe-agent.com/latest/reference/model_config/), [mini-swe-agent README](https://github.com/SWE-agent/mini-swe-agent).

## Other Notable Systems

**Claude computer use.** Anthropic documents the loop plainly: Claude emits `tool_use`, the host executes it, returns `tool_result`, and the loop repeats until Claude stops calling tools or a `max_iterations` cap is hit. Goal state lives in the message list plus tool results. Failure modes are equally explicit: prompt injection, UI brittleness, screenshot-token cost, and infinite-loop risk without iteration caps. Sources: [computer use docs](https://docs.anthropic.com/en/docs/build-with-claude/computer-use), [launch post](https://www.anthropic.com/news/3-5-models-and-computer-use).

**Devin.** Public architecture detail is still thin. Cognition's public site exposes product updates and post titles such as "Agent Trace: Capturing the Context Graph of Code," "Closing the Agent Loop: Devin Autofixes Review Comments," and "How Cognition Uses Devin to Build Devin," which strongly suggests an internal architecture built around persistent task sessions, traceable code context, and post-review replanning. But I could not verify the underlying control loop, termination logic, or retry policy from accessible primary docs. That is an open question, not a conclusion. Source: [Cognition homepage/blog index](https://cognition.ai/).

**AutoGPT and BabyAGI.** Their lasting contribution was making explicit goal and task state unavoidable. The archived BabyAGI README is blunt: it runs an **infinite loop** that executes a task, stores the result, creates new tasks, and reprioritizes the list against a top-level objective. That got durable task state right and termination/cost control wrong. AutoGPT has since evolved into a broader agent platform, but its repo still frames the mission as "continuous AI agents" plus benchmarking. Sources: [BabyAGI archive](https://github.com/yoheinakajima/babyagi_archive), [AutoGPT](https://github.com/Significant-Gravitas/AutoGPT), [AutoGPT Benchmarks archive](https://github.com/Significant-Gravitas/Auto-GPT-Benchmarks).

## Common Patterns

Successful autonomous loops share five traits:

- **Durable state lives outside the context window.** OpenClaw uses sessions plus Markdown memory; OpenHands uses persisted conversation state and event logs; SWE-agent uses trajectories; BabyAGI used a task list plus vector memory.
- **Termination is mechanical, not vibes-based.** `FinishAction`, `submit`, `HEARTBEAT_OK`, execution statuses, iteration caps.
- **Partial results are first-class inputs to the next turn.** Tool results, trajectories, event logs, compaction summaries, evidence logs.
- **Compression is built in.** Compaction, condensers, history processors, or linear truncated histories.
- **Costs are governed with hard edges.** Max iterations, max requeries, timeout, cheaper models for maintenance turns, or isolated sessions.

## Common Failure Modes

- **No explicit done test.** The loop keeps "working" because nothing says it is finished.
- **Stall without detection.** Repeating the same command or same delegation with no new evidence.
- **Hidden state in live shells or prompts.** Restart the agent and it no longer knows what it was doing.
- **Runtime fragility.** Sandboxes, containers, WebSockets, and browsers fail independently of reasoning quality.
- **Background loops become cost leaks.** Heartbeats, continuous mode, or infinite task queues quietly burn tokens all night.

## Key Insights for HIVE

- **Make `goals/<id>.md` the canonical loop state.** Not just a plan. Store current understanding, evidence, discarded hypotheses, and next action. That is the HIVE equivalent of OpenHands persistence plus SWE-agent trajectories.
- **Separate three terminal states:** `resolved`, `stuck`, and `needs-human`. OpenHands is right that "stuck" must be first-class; SWE-agent is right that completion needs an explicit action.
- **Use a stall detector, not just an iteration cap.** Detect repeated worker scopes, repeated command families, or two cycles with no new evidence. Iteration caps alone are too blunt.
- **Keep workers disposable; keep continuity in files.** The community "Ralph loop" idea is useful here even if it is not an official OpenClaw primitive: fresh workers are fine if the steward can reconstruct state from disk.
- **Compaction should rewrite understanding, not just summarize chat.** HIVE should preserve the best current model of the problem, not a lossy transcript digest.

## Open Questions

- I found no official OpenClaw/OpenHands documentation for a named "Ralph loop." If the architect has a specific upstream repo in mind, it should be identified directly.
- Devin almost certainly has richer internal loop machinery than the public materials reveal, but I could not verify its planner/replanner boundary from primary sources.
- OpenClaw is a strong model for a persistent head agent, but it is not obviously the best direct model for coding-task completion logic.
- OpenHands has better explicit stuck/finish semantics than OpenClaw, but the publicly accessible docs still scatter the full production loop across SDK, CLI, and issue threads.
