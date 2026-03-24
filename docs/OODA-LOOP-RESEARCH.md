# OODA Loop Research

Focused follow-up to [AUTONOMOUS-LOOP-RESEARCH](./AUTONOMOUS-LOOP-RESEARCH.md). That earlier doc covered persistence, termination, and loop mechanics broadly. This one narrows to Greg's frame: event-driven observation, cheap positional evaluation, interrupts, nested fast/slow loops, and orientation as a distinct artifact.

## Bottom Line

- **Interruptible runtimes are real, but usually cooperative.** OpenHands, AutoGen, and LangGraph all expose pause/cancel/interrupt surfaces. In practice those surfaces trigger at message, tool, graph-node, or step boundaries, not inside a live model completion.
- **Cheap evaluation passes exist, but mostly as routers/selectors.** AutoGen's `SelectorGroupChat`, RouteLLM, and NVIDIA's LLo11yPop show real "evaluate the local position, then choose the next move" behavior. Public coding-agent frameworks do **not** yet standardize this as the front door before every significant decision.
- **Explicit OODA language is uncommon in mainstream coding agents.** I found it mostly in robotics, RL, and operational automation systems, not in LangGraph/OpenHands/SWE-agent-style developer agents.
- **Nested loops are credible when they buy different tempo, cost, or state representations.** Magentic-One is the clearest public LLM example. Without that separation, the extra loop is mostly ceremony.
- **Observation and orientation are usually collapsed in coding-agent frameworks.** Systems that explicitly model OODA separate them. Most coding-agent frameworks expose event/history/state, then leave interpretation mixed into one prompt or one state object.

## 1. Interrupt / Preemption Patterns

| System | What is implemented | What it proves | What it does not prove |
| --- | --- | --- | --- |
| [OpenHands](https://docs.openhands.dev/sdk/guides/convo-send-message-while-running) | A running conversation can accept new user messages because the runtime is event-driven. [`pause()`](https://docs.openhands.dev/sdk/guides/convo-pause-and-resume) is explicit, and the docs say it takes effect at the **next iteration** between agent steps. The conversation object also exposes `run()`, `pause()`, and `send_message()` in the [API](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.conversation). | Strong public evidence for live intervention while work is in flight. | Not arbitrary preemption of a model's inner reasoning. Control lands between steps. |
| [AutoGen](https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/index.html) | Core is explicitly event-driven. AgentChat exposes [termination conditions](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/tutorial/termination.html) such as `ExternalTermination`, `TimeoutTermination`, and `HandoffTermination`, checked after each agent response. Core also has a [CancellationToken](https://microsoft.github.io/autogen/stable/_modules/autogen_core/_cancellation_token.html) for cancelling pending async work, and [intervention handlers](https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/cookbook/tool-use-with-intervention.html) that can intercept tool calls before execution. | Real framework-level preemption hooks at response and tool boundaries. | Not a documented always-on evaluator that semantically interrupts any running task the moment conditions change. |
| [LangGraph](https://docs.langchain.com/oss/python/langgraph/interrupts) | `interrupt()` pauses graph execution, persists state through the checkpointer, and resumes via `Command(resume=...)`. The docs explicitly call these **dynamic interrupts** that can be conditional. | Durable pause/resume is first-class. | The pause happens where graph logic calls `interrupt()`. This is workflow interruption, not ambient preemption. |
| [SWE-agent](https://swe-agent.com/latest/reference/agent/) | The main loop keeps stepping until `step_output.done`, saves trajectory after each step, and can wrap execution in a retry loop that decides whether to attempt again. | Useful negative case: strong coding results do not require a first-class interrupt system. | No public evidence of mid-task interruption based on changed external conditions. Replanning happens on the next step or next attempt. |

**Read:** real systems support **cooperative preemption at loop boundaries**. Greg's stronger form, "the position changed, stop now and re-evaluate," is only partially grounded. HIVE can do it, but the implementation will look more like worker/process interruption plus preserved state than pausing a model's thought mid-sentence.

## 2. Cheap Evaluation Passes

| System | Cheap evaluation pattern | Evidence quality | Limits |
| --- | --- | --- | --- |
| [AutoGen SelectorGroupChat](https://microsoft.github.io/autogen/dev/user-guide/agentchat-user-guide/selector-group-chat.html) | A separate model call selects the next speaker from conversation context and agent descriptions. The team itself has its own `model_client`, and the docs note that smaller models need a simpler selector prompt. | Strong evidence for a distinct routing/evaluation pass inside a real agent framework. | Narrow scope: speaker selection, not full positional evaluation of the task. The docs do not claim this happens before every important move. |
| [RouteLLM](https://github.com/lm-sys/RouteLLM) | A lightweight router decides whether a request goes to a weak or strong model based on cost threshold and router judgment. The repo recommends the lightweight `mf` router as a strong default. | Strong evidence that cheap-first routing is operationally useful. | Not an agent runtime. It proves the economic logic of a cheap evaluator, not the whole live-loop architecture. |
| [NVIDIA LLo11yPop](https://developer.nvidia.com/blog/optimizing-data-center-performance-with-ai-agents-and-the-ooda-loop-strategy/) | The orchestrator includes a classification step to choose the right analyst agent, and the write-up explicitly recommends small focused models for simpler domains and larger models where broader planning is needed. | Real system using model-tiering inside an OODA-flavored architecture. | Ops automation, not a coding agent. The evaluation pass is domain-specific, not a general coding controller. |
| [Magentic-One](https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/magentic-one.html) | The Orchestrator repeatedly updates Task and Progress Ledgers, checks for progress, and replans when stalled. | Good evidence for evaluation-before-next-action. | Public docs do **not** make "cheap" the story. Default configs use GPT-4o broadly; the docs even suggest stronger models like `o1-preview` for the outer loop. |

**Read:** the pieces exist, but the exact thing Greg wants is still unusual. I found real precedents for **cheap routing** and for **repeated evaluation**, but not a mainstream coding-agent framework that publicly says: "before every significant move, run a cheap positional evaluator distinct from the main reasoner."

## 3. OODA in Agent Literature

### Explicit OODA systems do exist

- [NVIDIA LLo11yPop](https://developer.nvidia.com/blog/optimizing-data-center-performance-with-ai-agents-and-the-ooda-loop-strategy/) is the clearest modern example. The supervisor agent explicitly operates in an OODA loop:
  - observe telemetry
  - orient by selecting the right analyst agents
  - decide what to do
  - act by invoking the chosen response
- [micROS](https://pmc.ncbi.nlm.nih.gov/articles/PMC5124045/) uses OODA as a system architecture in collective robotics. The mapping is explicit:
  - observation -> collective perception
  - orientation -> collective cognition
  - decision -> collective game
  - action -> collective dynamics
- [OODA loop for learning open-world novelty problems](https://yonsei.elsevierpure.com/en/publications/ooda-loop-for-learning-open-world-novelty-problems/) is direct academic evidence that OODA is still an active framework for adaptive agents in dynamic environments. The orient stage is treated as distinct from raw observation and tied to novelty handling.

### Where OODA is not showing up

I did **not** find LangGraph, OpenHands, AutoGen, or SWE-agent publicly framing their core architecture in Boyd's language. They implement adjacent pieces, but they usually name them as:

- events
- checkpoints
- termination conditions
- planners
- ledgers
- trajectories

That matters because Greg's proposal is not "copy what everyone else is doing." It is closer to **synthesizing patterns that are already real in other domains** and applying them to coding agents.

## 4. Nested Loop Architectures

### Strongest positive evidence: Magentic-One

[Magentic-One](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/) is the cleanest public LLM example of a nested loop architecture:

- the **outer loop** updates the Task Ledger: facts, guesses, and plan
- the **inner loop** updates the Progress Ledger: current progress, assignments, and whether the team is stalled
- when the inner loop stalls, control returns to the outer loop for replanning

This is not just aesthetic architecture. It exists in a system Microsoft publicly claims is competitive across multi-agent benchmarks. That is real evidence that fast/slow control loops can work.

### Secondary evidence: NVIDIA's hierarchy

NVIDIA's LLo11yPop is not described as "tactical loop plus strategic loop" in the same words, but functionally it is close:

- fast specialized analyst/query agents
- slower supervisory selection and action
- model choice varies by subtask

That is enough to count as a real multi-timescale design, even if it is not marketed as nested loops.

### Where the evidence is thin

The public ecosystem does **not** yet show a clean causal proof that "nested loops themselves" are the thing producing better outcomes. What we have is mostly system-level evidence:

- Magentic-One performs well and uses nested ledgers.
- OpenHands and SWE-agent produce useful work with much simpler loops plus persistence, retries, and stuck detection.

So the honest read is:

- nested loops are **credible**
- nested loops are **not yet doctrine**
- if both loops use nearly the same model, context, and cost profile, the second loop is probably complexity theater

### Practical rule

Nested loops seem to earn their keep only when at least one of these is true:

- the loops run at clearly different tempos
- the loops operate on different state representations
- the loops have meaningfully different cost profiles

That rule fits Greg's architecture. If HIVE actually gives the tactical loop a cheap evaluator plus a compact orientation cache, the split is justified. If both loops become "ask the big model again," it is not.

## 5. Orientation vs. Observation Separation

### Explicit separation exists, but mostly outside coding agents

- In [NVIDIA LLo11yPop](https://developer.nvidia.com/blog/optimizing-data-center-performance-with-ai-agents-and-the-ooda-loop-strategy/), **observation** is telemetry from the observability system; **orientation** is choosing which agents and analyses are relevant.
- In [micROS](https://pmc.ncbi.nlm.nih.gov/articles/PMC5124045/), observation/perception and orientation/cognition are different architectural modules.
- In [OODA novelty-learning work](https://yonsei.elsevierpure.com/en/publications/ooda-loop-for-learning-open-world-novelty-problems/), raw observation is distinct from the orient stage that frames the problem for adaptation.

### Coding-agent frameworks mostly collapse the split

This part is an inference from the public docs I found, not a vendor claim.

- [OpenHands conversation architecture](https://docs.openhands.dev/sdk/arch/conversation) centers on conversation state, event stream, execution status, persistence, tools, and workspace. I did not find a distinct "orientation" artifact maintained separately from observations.
- [AutoGen](https://microsoft.github.io/autogen/dev/user-guide/core-user-guide/index.html) centers on messages, events, agents, and termination/control hooks. `SelectorGroupChat` chooses from current context; it does not rely on a separate cached orientation layer.
- [SWE-agent](https://swe-agent.com/latest/reference/agent/) centers on trajectory, history processors, and step/retry loops. Again: useful state, but not a distinct observe-vs-orient split.

### Closest LLM-native approximation: Magentic-One's ledgers

Magentic-One gets closest to Greg's idea without calling it OODA:

- Task Ledger = "what matters, what we think, what we plan" -> orientation-like
- Progress Ledger / worker outputs = "what just happened" -> observation/progress-like

That is the nearest public precedent I found for an orientation artifact in an LLM agent system.

## Where Greg's Frame Fits Reality

### Strong support

- **Event-driven observation:** real and well supported.
- **Boundary-level interrupts:** real and well supported.
- **Orientation as a separate interpretive layer:** strongly supported by explicit OODA systems, weakly supported by coding frameworks.
- **Fast/slow nested control loops:** credible, with Magentic-One as the best public LLM precedent.

### Thin evidence or direct mismatch

- **Cheap positional evaluation before every significant decision:** adjacent precedent exists, but public coding-agent frameworks do not show this as standard practice.
- **Decisions emerging from evaluation rather than planning:** public systems still lean heavily on explicit plans, ledgers, or trajectories.
- **Mid-action semantic interruption:** public systems usually interrupt at process, tool, response, or step boundaries, not inside continuous reasoning.

## Implications for HIVE

If HIVE builds Greg's architecture, it is not copying a settled industry pattern. It is combining pieces that already exist separately:

1. **Event-driven runtime control** from OpenHands, AutoGen, and LangGraph.
2. **Cheap front-door evaluation** from SelectorGroupChat, RouteLLM, and NVIDIA's model-tiered routing.
3. **Orientation / multi-timescale control** from Magentic-One and explicit OODA systems.

That is promising, but the honest claim is narrower:

- the interrupt layer is well grounded
- the nested-loop layer is plausible and partly grounded
- the cheap positional evaluator before every meaningful move is still the most novel part

My read: Greg's frame is directionally right, but the public ecosystem does **not** yet offer a clean reference implementation of the whole thing. The closest truth is that the components are real in isolation, and the open question is whether they can be stitched together without turning into expensive ceremony.
