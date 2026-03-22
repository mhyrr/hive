Lessons from Building Claude Code: Seeing like an Agent 
One of the hardest parts of building an agent harness is constructing its action space.
Claude acts through Tool Calling, but there are a number of ways tools can be constructed in the Claude API with primitives like bash, skills and recently code execution (read more about programmatic tool calling on the Claude API in @RLanceMartin's new article).
Given all these options, how do you design the tools of your agent? Do you need just one tool like code execution or bash? What if you had 50 tools, one for each use case your agent might run into?
To put myself in the mind of the model I like to imagine being given a difficult math problem. What tools would you want in order to solve it? It would depend on your own skills!
Paper would be the minimum, but you’d be limited by manual calculations. A calculator would be better, but you would need to know how to operate the more advanced options. The fastest and most powerful option would be a computer, but you would have to know how to use it to write and execute code.
This is a useful framework for designing your agent. You want to give it tools that are shaped to its own abilities. But how do you know what those abilities are? You pay attention, read its outputs, experiment. You learn to see like an agent. 
Here are some lessons we’ve learned from paying attention to Claude while building Claude Code.
Improving Elicitation & the AskUserQuestion tool
When building the AskUserQuestion tool, our goal was to improve Claude’s ability to ask questions (often called elicitation). 
While Claude could just ask questions in plain text, we found answering those questions felt like they took an unnecessary amount of time. How could we lower this friction and increase the bandwidth of communication between the user and Claude?
Attempt #1 - Editing the ExitPlanTool
The first thing we tried was adding a parameter to the ExitPlanTool to have an array of questions alongside the plan. This was the easiest thing to implement, but it confused Claude because we were simultaneously asking for a plan and a set of questions about the plan. What if the user’s answers conflicted with what the plan said? Would Claude need to call the ExitPlanTool twice? We needed another approach.
(you can read more about why we made an ExitPlanTool in our post on prompt caching)
Attempt #2 - Changing Output Format
Next we tried modifying Claude’s output instructions to serve a slightly modified markdown format that it could use to ask questions. For example, we could ask it to output a list of bullet point questions with alternatives in brackets. We could then parse and format that question as UI for the user.
While this was the most general change we could make and Claude even seemed to be okay at outputting this, it was not guaranteed. Claude would append extra sentences, omit options, or use a different format altogether.
Attempt #3 - The AskUserQuestion Tool
Finally, we landed on creating a tool that Claude could call at any point, but it was particularly prompted to do so during plan mode. When the tool triggered we would show a modal to display the questions and block the agent's loop until the user answered.
This tool allowed us to prompt Claude for a structured output and it helped us ensure that Claude gave the user multiple options. It also gave users ways to compose this functionality, for example calling it in the Agent SDK or using referring to it in skills.
Most importantly, Claude seemed to like calling this tool and we found its outputs worked well. Even the best designed tool doesn’t work if Claude doesn’t understand how to call it.
Is this the final form of elicitation in Claude Code? We’re not sure. As you’ll see in the next example, what works for one model may not be the best for another.
Updating with Capabilities - Tasks & Todos
When we first launched Claude Code, we realized that the model needed a Todo list to keep it on track. Todos could be written at the start and checked off as the model did work. To do this we gave Claude the TodoWrite tool, which would write or update Todos and display them to the user.
But even then we often saw Claude forgetting what it had to do. To adapt, we inserted system reminders every 5 turns that reminded Claude of its goal.
But as models improved, they not only did not need to be reminded of the Todo List but could find it limiting. Being sent reminders of the todo list made Claude think that it had to stick to the list instead of modifying it. We also saw Opus 4.5 also get much better at using subagents, but how could subagents coordinate on a shared Todo List?
Seeing this, we replaced TodoWrite with the Task Tool (read more on Tasks here). Whereas Todos were about keeping the model on track, Tasks were more about helping agents communicate with each other. Tasks could include dependencies, share updates across subagents and the model could alter and delete them.
As model capabilities increase, the tools that your models once needed might now be constraining them. It’s important to constantly revisit previous assumptions on what tools are needed. This is also why it's useful to stick to a small set of models to support that have a fairly similar capabilities profile.
Designing a Search Interface 
A particularly important set of tools for Claude are the search tools that can be used to build its own context.
When Claude Code first came out, we used a RAG vector database to find context for Claude. While RAG was powerful and fast it required indexing and setup and could be fragile across a host of different environments. More importantly, Claude was given this context instead of finding the context itself.
But if Claude could search on the web, why not search your codebase? By giving Claude a Grep tool, we could let it search for files and build context itself.
This is a pattern we’ve seen as Claude gets smarter, it becomes increasingly good at building its context if it’s given the right tools.  
When we introduced Agent Skills we formalized the idea of progressive disclosure, which allows agents to incrementally discover relevant context through exploration.
Claude could read skill files and those files could then reference other files that the model could read recursively. In fact, a common use of skills is to add more search capabilities to Claude like giving it instructions on how to use an API or query a database.
Over the course of a year Claude went from not really being able to build its own context, to being able to do nested search across several layers of files to find the exact context it needed.
Progressive disclosure is now a common technique we use to add new functionality without adding a tool.
Progressive Disclosure - The Claude Code Guide Agent
Claude Code currently has ~20 tools, and we are constantly asking ourselves if we need all of them. The bar to add a new tool is high, because this gives the model one more option to think about.
For example, we noticed that Claude did not know enough about how to use Claude Code. If you asked it how to add a MCP or what a slash command did, it would not be able to reply.
We could have put all of this information in the system prompt, but given that users rarely asked about this, it would have added context rot and interfered with Claude Code’s main job: writing code.
Instead, we tried a form of progressive disclosure. We gave Claude a link to its docs which it could then load to search for more information. This worked but we found that Claude would load a lot of results into context to find the right answer when really all you needed was the answer. 
So we built the Claude Code Guide subagent which Claude is prompted to call when you ask about itself, the subagent has extensive instructions on how to search docs well and what to return.
While this isn’t perfect, Claude can still get confused when you ask it about how to set itself up, it is much better than it used to be! We were able to add things to Claude's action space without adding a tool.
An Art, not a Science
If you were hoping for a set of rigid rules on how to build your tools, unfortunately that is not this guide. Designing the tools for your models is as much an art as it is a science. It depends heavily on the model you're using, the goal of the agent and the environment it’s operating in.
Experiment often, read your outputs, try new things. See like an agent.

Lessons from Building Claude Code: Prompt Caching Is Everything 
It is often said in engineering that "Cache Rules Everything Around Me", and the same rule holds for agents.
Long running agentic products like Claude Code are made feasible by prompt caching which allows us to reuse computation from previous roundtrips and significantly decrease latency and cost. 
What is prompt caching, how does it work and how do you implement it technically? Read more in @RLanceMartin's piece on prompt caching and our new auto-caching launch.
At Claude Code, we build our entire harness around prompt caching. A high prompt cache hit rate decreases costs and helps us create more generous rate limits for our subscription plans, so we run alerts on our prompt cache hit rate and declare SEVs if they're too low.
These are the (often unintuitive) lessons we've learned from optimizing prompt caching at scale.
Lay Out Your Prompt for Caching
Prompt caching works by prefix matching — the API caches everything from the start of the request up to each cache_control breakpoint. This means the order you put things in matters enormously, you want as many of your requests to share a prefix as possible.
The best way to do this is static content first, dynamic content last. For Claude Code this looks like:
Static system prompt & Tools (globally cached)
Claude.MD (cached within a project)
Session context (cached within a session)
Conversation messages  
This way we maximize how many sessions share cache hits.
But this can be surprisingly fragile! Examples of reasons we’ve broken this ordering before include: putting an in-depth timestamp in the static system prompt, shuffling tool order definitions non-deterministically, updating parameters of tools (e.g. what agents the AgentTool can call), etc.
Use Messages for Updates
There may be times when the information you put in your prompt becomes out of date, for example if you have the time or if the user changes a file. It may be tempting to update the prompt, but that would result in a cache miss and could end up being quite expensive for the user.
Consider if you can pass in this information via messages in the next turn instead. In Claude Code, we add a <system-reminder> tag in the next user message or tool result with the updated information for the model (e.g. it is now Wednesday), which helps preserve the cache.
Don't change Models Mid-Session
Prompt caches are unique to models and this can make the math of prompt caching quite unintuitive.
If you're 100k tokens into a conversation with Opus and want to ask a question that is fairly easy to answer, it would actually be more expensive to switch to Haiku than to have Opus answer, because we would need to rebuild the prompt cache for Haiku.
If you need to switch models, the best way to do it is with subagents, where Opus would prepare a "handoff" message to another model on the task that it needs done. We do this often with the Explore agents in Claude Code which use Haiku.
Never Add or Remove Tools Mid-Session
Changing the tool set in the middle of a conversation is one of the most common ways people break prompt caching. It seems intuitive — you should only give the model tools you think it needs right now. But because tools are part of the cached prefix, adding or removing a tool invalidates the cache for the entire conversation.
Plan Mode — Design Around the Cache
Plan mode is a great example of designing features around caching constraints. The intuitive approach would be: when the user enters plan mode, swap out the tool set to only include read-only tools. But that would break the cache.
Instead, we keep all tools in the request at all times and use EnterPlanMode and ExitPlanMode as tools themselves. When the user toggles plan mode on, the agent gets a system message explaining that it's in plan mode and what the instructions are — explore the codebase, don't edit files, call ExitPlanMode when the plan is complete. The tool definitions never change.
This has a bonus benefit: because EnterPlanMode is a tool the model can call itself, it can autonomously enter plan mode when it detects a hard problem, without any cache break.
Tool Search — Defer Instead of Remove
The same principle applies to our tool search feature. Claude Code can have dozens of MCP tools loaded, and including all of them in every request would be expensive. But removing them mid-conversation would break the cache.
Our solution: defer_loading. Instead of removing tools, we send lightweight stubs — just the tool name, with defer_loading: true — that the model can "discover" via a ToolSearch tool when needed. The full tool schemas are only loaded when the model selects them. This keeps the cached prefix stable: the same stubs are always present in the same order.
Luckily you can use the tool search tool through our API to simplify this.
Forking Context — Compaction
Compaction is what happens when you run out of the context window. We summarize the conversation so far and continue a new session with that summary.
Surprisingly, compaction has many edge cases with prompt caching that can be unintuitive.
In particular, when we compact we need to send the entire conversation to the model to generate a summary. If this is a separate API call with a different system prompt and no tools (which is the simple implementation), the cached prefix from the main conversation doesn't match at all. You pay full price for all those input tokens, drastically increasing the cost for the user.
The Solution — Cache-Safe Forking
When we run compaction, we use the exact same system prompt, user context, system context, and tool definitions as the parent conversation. We prepend the parent's conversation messages, then append the compaction prompt as a new user message at the end.
From the API's perspective, this request looks nearly identical to the parent's last request — same prefix, same tools, same history — so the cached prefix is reused. The only new tokens are the compaction prompt itself.
This does mean however that we need to save a "compaction buffer" so that we have enough room in the context window to include the compact message and the summary output tokens.
Compaction is tricky but luckily, you don't need to learn these lessons yourself — based on our learnings from Claude Code we built compaction directly into the API, so you can apply these patterns in your own applications.
Lessons Learned
Prompt caching is a prefix match. Any change anywhere in the prefix invalidates everything after it. Design your entire system around this constraint. Get the ordering right and most of the caching works for free.
Use messages instead of system prompt changes. You may be tempted to edit the system prompt to do things like entering plan mode, changing the date, etc. but it would actually be better to insert these into messages during the conversation.
Don't change tools or models mid-conversation. Use tools to model state transitions (like plan mode) rather than changing the tool set. Defer tool loading instead of removing tools.
Monitor your cache hit rate like you monitor uptime. We alert on cache breaks and treat them as incidents. A few percentage points of cache miss rate can dramatically affect cost and latency.
Fork operations need to share the parent's prefix. If you need to run a side computation (compaction, summarization, skill execution), use identical cache-safe parameters so you get cache hits on the parent's prefix.
Claude Code is built around prompt caching from day one, you should do the same if you’re building an agent.