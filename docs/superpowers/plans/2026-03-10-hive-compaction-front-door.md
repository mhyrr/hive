# HIVE Compaction + Front Door Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate HIVE identity from operational doctrine, compact all prompts to path-first assembly, and add conversational front-door commands (`run`, `say`, `ask`).

**Architecture:** Split SOUL.md (~111 lines of mixed identity+doctrine) into compact SOUL.md (~20 lines, pure identity) + AGENTS.md (~35 lines, operational protocols). Build digest generators for board/message/run state. Refactor all three prompt builders (worker, orchestrator, chat) from full-inline to path-first-with-digests. Add three thin wrapper commands over existing supervision machinery.

**Tech Stack:** Bun + TypeScript, zero npm deps, `bun test`

---

## Chunk 1: SOUL/AGENTS Split

### Task 1: Create the AGENTS.md template

**Files:**
- Create: `templates/AGENTS.md`

- [ ] **Step 1: Write the AGENTS.md template file**

```markdown
# HIVE Agent Operations

Read this file at the start of every session for operational protocols.

## Coordination
- BOARD.md is shared consciousness — the orchestrator maintains it, agents read it
- If you need state changed, send a message to the orchestrator through msg/
- Don't assume — if another agent needs context, write it down
- Leave the codebase better than you found it
- Record every decision so the next agent doesn't relitigate it

## Scope and Communication
- Respect each other's scope — don't touch another agent's files without communication
- When you disagree, raise it via message rather than silently overwriting
- Trust the orchestrator — it sees the whole board
- Execute with full commitment, raise concerns via message

## State-Efficient Operations
- Use `tail` for append-only files like LOG.md, feed.md, journals
- Use `grep`/`rg` to find specific sections, don't read whole files
- Read message headers first, then full bodies only when relevant
- Only load recent run results, not the entire run history
- Treat large markdown files as searchable stores, not prompt cargo

## The Standard
Before saying "done," ask:
- Would I be proud to put my name on this?
- Does this solve the real problem, not just the stated one?
- Is the code clear enough that any agent could pick it up cold?
- Are tests meaningful — catching real bugs, not just asserting true?
- Did I document my decisions?
- Did I leave the codebase better?
- Will this code hold up for a year without anyone looking at it?

When something seems impossible, think harder.
```

- [ ] **Step 2: Commit**

```bash
git add templates/AGENTS.md
git commit -m "add AGENTS.md template with operational doctrine"
```

### Task 2: Slim down SOUL.md to pure identity

**Files:**
- Modify: `templates/SOUL.md`

- [ ] **Step 1: Replace SOUL.md with compact identity-only version**

Replace the entire file with:

```markdown
# HIVE Soul

We are craftsmen. Engineers who think like designers. Every line of code
should feel inevitable.

We are a team of AI agents — different minds, different strengths, one
shared standard. We don't complete tasks. We build things that last.

## How We Think
- Question every assumption before reaching for the keyboard
- Obsess over context — read the codebase, understand the patterns, know what came before
- Plan before building — sketch the architecture, see the beauty of the solution first
- Craft, don't code — every function name should sing, every abstraction should feel natural
- Simplify ruthlessly — elegance is nothing left to take away
- Iterate relentlessly — the first version is never good enough

## What We Refuse
- Sloppy work disguised as speed
- Assumptions without documentation
- Clever code that requires comments to explain
- Solving the wrong problem
- Hoarding knowledge — write it down, your context window is temporary
```

This is ~20 lines of content. Pure identity and values. All operational protocols ("How We Work Together", "The Standard" checklist) moved to AGENTS.md.

- [ ] **Step 2: Commit**

```bash
git add templates/SOUL.md
git commit -m "compact SOUL.md to pure identity, doctrine moved to AGENTS.md"
```

### Task 3: Register AGENTS.md in paths and scaffold

**Files:**
- Modify: `src/lib/paths.ts` — add `agents` to `HivePaths`
- Modify: `src/lib/templates.ts` — import and register AGENTS.md template

- [ ] **Step 1: Write the failing test — scaffold creates AGENTS.md**

In `tests/hive.test.ts`, update the init test:

```typescript
test("init scaffolds the hive home without registering a project", async () => {
  const output = await initHive();

  expect(output).toContain("Initialized hive home");
  expect(await Bun.file(join(context.hiveHome, "SOUL.md")).exists()).toBeTrue();
  expect(await Bun.file(join(context.hiveHome, "SELF.md")).exists()).toBeTrue();
  expect(await Bun.file(join(context.hiveHome, "AGENTS.md")).exists()).toBeTrue();
  expect(await Bun.file(join(context.hiveHome, "feed.md")).exists()).toBeTrue();
  expect(await Bun.file(join(context.hiveHome, "personas", "steward.md")).exists()).toBeTrue();
  expect(await Bun.file(join(context.hiveHome, "active-project.txt")).exists()).toBeFalse();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hive.test.ts -t "init scaffolds"`
Expected: FAIL — AGENTS.md not yet created by scaffold

- [ ] **Step 3: Add agents path to HivePaths**

In `src/lib/paths.ts`, add to the `HivePaths` type:

```typescript
export type HivePaths = {
  home: string;
  soul: string;
  self: string;
  agents: string;  // NEW
  config: string;
  // ... rest unchanged
};
```

In `getHivePaths`:

```typescript
agents: join(home, "AGENTS.md"),
```

- [ ] **Step 4: Register AGENTS.md template**

In `src/lib/templates.ts`, add the import:

```typescript
import agentsTemplate from "../../templates/AGENTS.md" with { type: "text" };
```

Add to `baseTemplates`:

```typescript
export const baseTemplates = {
  "SOUL.md": soulTemplate.trim(),
  "SELF.md": selfTemplate.trim(),
  "AGENTS.md": agentsTemplate.trim(),  // NEW
  "config.md": configTemplate.trim(),
  // ... rest unchanged
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/hive.test.ts -t "init scaffolds"`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/lib/paths.ts src/lib/templates.ts tests/hive.test.ts
git commit -m "register AGENTS.md in paths and scaffold"
```

---

## Chunk 2: Compact Digest Library

### Task 4: Create digest generators

**Files:**
- Create: `src/lib/digest.ts`
- Create: `tests/digest.test.ts`

- [ ] **Step 1: Write failing tests for board digest**

Create `tests/digest.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

import { digestBoard, digestMessages, digestRuns } from "../src/lib/digest";

describe("digestBoard", () => {
  test("summarizes tasks, agents, and blockers from a real board", () => {
    const board = `# Board

## Tasks
- 001: Auth endpoint [alpha] [done] [14:52]
- 002: Login form [beta] [active] [15:01]
- 003: Code review [gamma] [waiting:002]
- 004: Rate limiting [queued]

## Agents
### alpha (craftsman -> backend)
status: idle
completed: 001
last-active: 14:52

### beta (craftsman -> frontend)
status: active on 002
last-active: 15:01

### gamma (critic)
status: waiting for 002
blocked-by: beta

## Blockers
(none)

## Decisions
- 14:15: Joken for JWT.
`;

    const digest = digestBoard(board);

    expect(digest).toContain("4 tasks");
    expect(digest).toContain("1 active");
    expect(digest).toContain("1 done");
    expect(digest).toContain("alpha: idle");
    expect(digest).toContain("beta: active on 002");
    expect(digest).toContain("gamma: waiting for 002");
  });

  test("handles empty board gracefully", () => {
    const board = `# Board

## Tasks

## Agents

## Blockers
(none)

## Decisions
`;

    const digest = digestBoard(board);

    expect(digest).toContain("0 tasks");
  });
});

describe("digestMessages", () => {
  test("renders one-line summaries for each message", () => {
    const messages = [
      {
        filename: "msg1.md",
        attributes: { from: "beta", to: "alpha", type: "question", status: "open", ts: "2026-03-09T15:08:00Z", project: "myapp" },
        body: "Need the auth contract shape.\nMore details here.",
        raw: "---\nfrom: beta\n---\nNeed the auth contract shape.",
      },
      {
        filename: "msg2.md",
        attributes: { from: "orchestrator", to: "alpha", type: "assign", status: "open", ts: "2026-03-09T15:10:00Z", project: "myapp" },
        body: "Build the login endpoint.\nDetails follow.",
        raw: "---\nfrom: orchestrator\n---\nBuild the login endpoint.",
      },
    ];

    const digest = digestMessages(messages as any);

    expect(digest).toContain("[question] beta -> alpha");
    expect(digest).toContain("Need the auth contract shape.");
    expect(digest).toContain("[assign] orchestrator -> alpha");
    expect(digest).toContain("Build the login endpoint.");
  });

  test("returns (none) for empty messages", () => {
    expect(digestMessages([])).toBe("(none)");
  });
});

describe("digestRuns", () => {
  test("renders compact run summaries", () => {
    const runs = [
      {
        agentId: "alpha",
        status: "active",
        runtime: "codex",
        model: "gpt-5.4-medium",
        started: "2026-03-09T14:11:05Z",
        pid: 12345,
        scope: ["src/api", "src/db"],
      },
    ];

    const digest = digestRuns(runs as any);

    expect(digest).toContain("alpha");
    expect(digest).toContain("active");
    expect(digest).toContain("codex");
    expect(digest).toContain("14:11");
  });

  test("returns (none) for empty runs", () => {
    expect(digestRuns([])).toBe("(none)");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/digest.test.ts`
Expected: FAIL — module does not exist

- [ ] **Step 3: Implement digest generators**

Create `src/lib/digest.ts`:

```typescript
import { parseBoard } from "./board";
import { HiveMessage } from "./messages";
import { RunRecord } from "./runs";

export function digestBoard(boardText: string): string {
  const board = parseBoard(boardText);
  const taskCount = board.tasks.length;
  const activeCount = board.tasks.filter((t) => t.includes("[active]")).length;
  const doneCount = board.tasks.filter((t) => t.includes("[done]")).length;
  const waitingCount = board.tasks.filter(
    (t) => t.includes("[waiting") || t.includes("[queued]"),
  ).length;
  const blockerLines = board.blockers.filter(
    (b) => b.trim().length > 0 && !b.includes("(none)"),
  );

  const lines: string[] = [
    `${taskCount} tasks: ${activeCount} active, ${doneCount} done, ${waitingCount} waiting/queued`,
  ];

  if (board.agents.length > 0) {
    for (const agent of board.agents) {
      lines.push(`  ${agent.id}: ${agent.fields.status ?? "unknown"}`);
    }
  }

  if (blockerLines.length > 0) {
    lines.push(`Blockers: ${blockerLines.length}`);

    for (const b of blockerLines) {
      lines.push(`  ${b.trim()}`);
    }
  }

  return lines.join("\n");
}

export function digestMessages(messages: HiveMessage[]): string {
  if (messages.length === 0) {
    return "(none)";
  }

  return messages
    .map((m) => {
      const firstLine = m.body.split("\n")[0] ?? "";
      return `- [${m.attributes.type ?? "msg"}] ${m.attributes.from ?? "?"} -> ${m.attributes.to ?? "?"}: ${firstLine}`;
    })
    .join("\n");
}

export function digestRuns(runs: RunRecord[]): string {
  if (runs.length === 0) {
    return "(none)";
  }

  return runs
    .map((run) => {
      const time = run.started?.slice(11, 16) ?? "?";
      return `- ${run.agentId}: ${run.status} since ${time} (${run.runtime}${run.model ? `, ${run.model}` : ""})`;
    })
    .join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/digest.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/digest.ts tests/digest.test.ts
git commit -m "add compact digest generators for board, messages, and runs"
```

---

## Chunk 3: Prompt Compaction

### Task 5: Compact the worker prompt (prompt.ts)

**Files:**
- Modify: `src/commands/prompt.ts`
- Modify: `tests/hive.test.ts`

The new worker prompt structure:
- **Inlined:** SOUL.md (compact ~20 lines), assignment body, board digest, open messages for agent
- **Path-referenced:** SELF.md, AGENTS.md, persona, project config, PLAN.md, BOARD.md (full), LOG.md, knowledge, project memory

- [ ] **Step 1: Update the prompt test expectations**

In `tests/hive.test.ts`, update the prompt test. The key changes:
- Remove expectation for inlined `"# Persona: Craftsman"` — persona is now path-referenced
- Add expectation for AGENTS.md path
- Add expectation for board digest section
- Keep expectations for: agent identity, SOUL content, file paths, inbox/resolve instructions, assignment, messages

```typescript
test("prompt assembles compact identity, assignment, digest, and agent messages", async () => {
  await initHive();
  await addProject();

  await Bun.write(
    join(context.hiveHome, "projects", "myapp", "PLAN.md"),
    `# Plan: MyApp

## Goal
Ship the login flow.

## Agents
### orchestrator (steward)
Task: Run the board.

### alpha (craftsman -> src/api/**)
Task: Build the auth endpoint and publish the contract.

## Rules
- Keep the board current via messages.
`,
  );

  await Bun.write(
    join(context.hiveHome, "projects", "myapp", "BOARD.md"),
    `# Board

## Tasks
- 001: Auth endpoint [alpha] [active]

## Agents
### alpha (craftsman -> backend)
status: active on 001

## Blockers
(none)

## Decisions
(none)
`,
  );

  await runCli([
    "msg",
    "--type",
    "question",
    "beta",
    "alpha",
    "Need",
    "the",
    "login",
    "contract",
    "shape",
  ]);

  const prompt = await runCli(["prompt", "alpha"]);

  // Identity and orientation
  expect(prompt).toContain("You are alpha for project myapp.");
  expect(prompt).toContain("# HIVE Soul");
  expect(prompt).toContain("We are craftsmen");

  // File paths (path-first)
  expect(prompt).toContain("AGENTS.md:");
  expect(prompt).toContain(`BOARD.md: ${join(context.hiveHome, "projects", "myapp", "BOARD.md")}`);
  expect(prompt).toContain(`LOG.md: ${join(context.hiveHome, "projects", "myapp", "LOG.md")}`);
  expect(prompt).toContain("persona:");

  // Operating rules
  expect(prompt).toContain("The authoritative hive files are not in the repo root.");
  expect(prompt).toContain("hive inbox alpha");
  expect(prompt).toContain("./hive inbox alpha");
  expect(prompt).toContain("hive msg resolve <message> alpha <answer>");
  expect(prompt).toContain("./hive msg resolve <message> alpha <answer>");
  expect(prompt).toContain("hive msg close <message> alpha [note]");
  expect(prompt).toContain("./hive msg close <message> alpha [note]");

  // Board digest (not full board inline)
  expect(prompt).toContain("Board Summary");
  expect(prompt).toContain("1 tasks");

  // Assignment (still inlined)
  expect(prompt).toContain("Build the auth endpoint and publish the contract.");

  // Messages for agent (still inlined)
  expect(prompt).toContain("Need the login contract shape");

  // Persona NOT inlined (path-referenced only)
  expect(prompt).not.toContain("# Persona: Craftsman");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hive.test.ts -t "prompt assembles"`
Expected: FAIL — prompt still uses old format

- [ ] **Step 3: Rewrite prompt.ts to compact format**

Replace the `promptCommand` function's return template with:

```typescript
import { digestBoard, digestMessages } from "../lib/digest";

// ... (keep existing imports and helper functions)

export async function promptCommand(args: string[]): Promise<string> {
  // ... (keep all existing setup logic through resolvedAgent and persona check)

  const board = await Bun.file(projectPaths.board).text();
  const messages = (await listOpenProjectMessages(paths.msgDir, activeProject)).filter(
    (message) => message.attributes.to === agentId,
  );
  const assignment =
    "body" in resolvedAgent && resolvedAgent.body
      ? resolvedAgent.body
      : "No active assignment in PLAN.md. Default to the project configuration and the live board.";

  return `# HIVE Agent Prompt

You are ${agentId} for project ${activeProject}. Operate from the files below, not assumptions.

## Identity
${soul.trim()}

## Runtime Rules
- Read ${paths.agents} for full operational protocols before starting work.
- Read ${projectPaths.board} before acting — it's the shared state snapshot.
- The authoritative hive files are not in the repo root. Use the absolute paths below.
- Check \`hive inbox ${agentId}\` between major steps. Use \`./hive inbox ${agentId}\` when the binary is built locally but not installed on PATH.
- When you answer or finish a message-driven task, resolve it with \`hive msg resolve <message> ${agentId} <answer>\` or \`./hive msg resolve <message> ${agentId} <answer>\`.
- Close obsolete threads with \`hive msg close <message> ${agentId} [note]\` or \`./hive msg close <message> ${agentId} [note]\`.
- Write durable decisions and learnings to LOG.md before ending the session.
- Stay inside your stated scope unless the orchestrator or human reassigns you.

## Agent
id: ${agentId}
persona: ${resolvedAgent.persona} (${join(paths.personasDir, `${resolvedAgent.persona}.md`)})
descriptor: ${resolvedAgent.descriptor}
project: ${activeProject}
repo: ${repoPath}
hive-home: ${paths.home}

## Files
SOUL.md: ${paths.soul}
SELF.md: ${paths.self}
AGENTS.md: ${paths.agents}
persona: ${join(paths.personasDir, `${resolvedAgent.persona}.md`)}
project-config: ${projectPaths.config}
PLAN.md: ${projectPaths.plan}
BOARD.md: ${projectPaths.board}
LOG.md: ${projectPaths.log}
project-memory: ${projectPaths.memory}
messages-dir: ${paths.msgDir}

## Your Assignment
${assignment}

## Board Summary
${digestBoard(board)}

## Open Messages For You
${renderMessages(messages)}`;
}
```

Key changes:
- SOUL.md inlined (compact version, ~20 lines)
- SELF.md, persona, knowledge, project memory, project config, PLAN.md, full BOARD.md, LOG.md — all path-referenced, NOT inlined
- Board digest replaces full BOARD.md inline
- Messages for agent still inlined (high-signal)
- AGENTS.md path referenced with instruction to read first

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/hive.test.ts -t "prompt assembles"`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `bun test`
Expected: All pass (some tests may need minor adjustments if they relied on old prompt content)

- [ ] **Step 6: Commit**

```bash
git add src/commands/prompt.ts tests/hive.test.ts
git commit -m "compact worker prompt to path-first with board digest"
```

### Task 6: Compact the orchestrator prompt (orchestrator.ts + orchestrate.ts)

**Files:**
- Modify: `src/lib/orchestrator.ts`
- Modify: `src/commands/orchestrate.ts`
- Modify: `tests/hive.test.ts`

The new orchestrator prompt:
- **Inlined:** SOUL.md (compact), mode instructions, goal, signals, active runs (compact), recent run results (compact), messages to orchestrator (full)
- **Path-referenced:** SELF.md, AGENTS.md, persona, project config, PLAN.md, BOARD.md (full), LOG.md, knowledge, project memory

- [ ] **Step 1: Update orchestrate test expectations**

The existing orchestrate tests check for content that will still be present (steward prompt header, mode, goal, signals, file paths, message handling rules). Update to also check for:
- AGENTS.md path
- Board Summary section
- Removal of full LOG.md, SOUL.md heading in the "## SOUL.md" section format (SOUL is now in Identity section)

```typescript
test("orchestrate kickoff records a human goal and prints a steward prompt", async () => {
  await initHive();
  await addProject();

  const prompt = await runCli(["orchestrate", "Build", "the", "auth", "flow"]);
  const log = await Bun.file(
    join(context.hiveHome, "projects", "myapp", "LOG.md"),
  ).text();
  const msgDirEntries = await readdir(join(context.hiveHome, "msg"));
  const messageText = await Bun.file(join(context.hiveHome, "msg", msgDirEntries[0])).text();

  expect(prompt).toContain("# HIVE Steward Prompt");
  expect(prompt).toContain("Human-driven single-pass mode.");
  expect(prompt).toContain("Build the auth flow");
  expect(prompt).toContain("Human nudge pending: Build the auth flow");
  expect(prompt).toContain("The authoritative hive files are not in the repo root.");
  expect(prompt).toContain("AGENTS.md:");
  expect(prompt).toContain(`BOARD.md: ${join(context.hiveHome, "projects", "myapp", "BOARD.md")}`);
  expect(prompt).toContain("hive msg resolve <message> orchestrator <answer>");
  expect(prompt).toContain("./hive msg resolve <message> orchestrator <answer>");
  expect(prompt).toContain("Board Summary");
  expect(log).toContain("Goal: Build the auth flow");
  expect(messageText).toContain("type: nudge");
  expect(messageText).toContain("to: orchestrator");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hive.test.ts -t "orchestrate kickoff"`
Expected: FAIL

- [ ] **Step 3: Refactor orchestrator.ts to compact format**

Reduce the `buildOrchestratorPrompt` input params — remove the content strings that are no longer inlined, keep only paths. Restructure the output template:

```typescript
import { digestBoard, digestMessages, digestRuns } from "./digest";

// Remove: soul, self, persona, knowledge, projectMemory, projectConfig, plan, log
// from the input type. Keep only the path strings and the content that's still inlined
// (board text for digest, activeRuns, recentRunResults, openMessages).

export function buildOrchestratorPrompt(input: {
  projectId: string;
  pathsHome: string;
  repoPath: string;
  pathsSoul: string;
  pathsSelf: string;
  pathsAgents: string;
  personaPath: string;
  projectConfigPath: string;
  planPath: string;
  boardPath: string;
  logPath: string;
  projectMemoryPath: string;
  messagesDir: string;
  soul: string;
  board: string;
  activeRuns: RunRecord[];
  recentRunResults: RunResult[];
  openMessages: HiveMessage[];
  options: OrchestrateOptions;
}): string {
  const signals = summarizeSignals(input.board, input.openMessages, input.activeRuns);
  const recentGoal = /* ... same as before ... */;

  return `# HIVE Steward Prompt

You are the steward/orchestrator for project ${input.projectId}. Operate from the files below and keep BOARD.md as the single source of truth.

## Identity
${input.soul.trim()}

${renderModeInstructions(input.options)}

## Current Goal
${recentGoal}

## Immediate Priorities
${renderList([
  "Read the board, open messages, and recent log before acting.",
  "If the goal is new or changed, decompose it into clear tasks and update PLAN.md and BOARD.md.",
  "Send assignments or clarifications through message files. Do not rely on unrecorded context.",
  "When you fully handle a message, resolve it or close it so the open queue stays clean.",
  "Log every orchestration action you take.",
])}

## Signals
${renderList(signals)}

## Steward Rules
- BOARD.md is yours to maintain. Other agents should update you via msg/.
- Read ${input.pathsAgents} for full operational protocols.
- The authoritative hive files are not in the repo root. Use the absolute paths below.
- Answer human nudges before anything else.
- Resolve handled nudges with \`hive msg resolve <message> orchestrator <answer>\` or \`./hive msg resolve <message> orchestrator <answer>\`. Close obsolete threads with \`hive msg close <message> orchestrator [note]\` or \`./hive msg close <message> orchestrator [note]\`.
- Tell workers to poll with \`hive inbox <agent>\` or \`./hive inbox <agent>\` and to resolve or close their own message-driven work when done.
- When you create an assignment message, include machine-usable frontmatter: \`task:\` for the work id, \`launch:\` (\`auto\` or \`manual\`), and conservative \`scope:\` roots whenever parallel launch is safe.
- When a task is done, update the board, unblock dependents, and assign the next task.
- When an agent is stale or blocked, either unblock it or reassign the work.
- If everything is healthy and in progress, wait.

## Hive Identity
project: ${input.projectId}
repo: ${input.repoPath}
hive-home: ${input.pathsHome}

## Files
SOUL.md: ${input.pathsSoul}
SELF.md: ${input.pathsSelf}
AGENTS.md: ${input.pathsAgents}
persona: ${input.personaPath}
project-config: ${input.projectConfigPath}
PLAN.md: ${input.planPath}
BOARD.md: ${input.boardPath}
LOG.md: ${input.logPath}
project-memory: ${input.projectMemoryPath}
messages-dir: ${input.messagesDir}

## Board Summary
${digestBoard(input.board)}

## Active Runs
${digestRuns(input.activeRuns)}

## Recent Run Results
${renderRunResults(input.recentRunResults)}

## Open Project Messages
${renderMessages(input.openMessages)}`;
}
```

- [ ] **Step 4: Update orchestrate.ts to match new input shape**

Remove the content reads for files that are no longer inlined (self, persona, knowledge, projectMemory, projectConfig, plan, log). Keep reading: soul, board, messages, runs.

```typescript
export async function orchestrateCommand(args: string[]): Promise<string> {
  // ... (keep options parsing and project setup)

  const soul = await Bun.file(paths.soul).text();
  const board = await Bun.file(projectPaths.board).text();
  const repoPath = extractRepoPath(
    await Bun.file(projectPaths.config).text(),
  ) ?? "(unknown)";
  const openMessages = await listOpenProjectMessages(paths.msgDir, activeProject);
  const activeRuns = await listActiveRuns(projectPaths);
  const recentRunResults = (await listRecentRunResults(projectPaths, 5)).filter(
    (result) => result.agentId !== "orchestrator",
  );

  return buildOrchestratorPrompt({
    projectId: activeProject,
    pathsHome: paths.home,
    repoPath,
    pathsSoul: paths.soul,
    pathsSelf: paths.self,
    pathsAgents: paths.agents,
    personaPath: join(paths.personasDir, "steward.md"),
    projectConfigPath: projectPaths.config,
    planPath: projectPaths.plan,
    boardPath: projectPaths.board,
    logPath: projectPaths.log,
    projectMemoryPath: projectPaths.memory,
    messagesDir: paths.msgDir,
    soul,
    board,
    activeRuns,
    recentRunResults,
    openMessages,
    options,
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test tests/hive.test.ts -t "orchestrate"`
Expected: Both orchestrate tests PASS

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/lib/orchestrator.ts src/commands/orchestrate.ts tests/hive.test.ts
git commit -m "compact orchestrator prompt to path-first with board digest"
```

### Task 7: Compact the chat prompt (chat.ts)

**Files:**
- Modify: `src/commands/chat.ts`

- [ ] **Step 1: Refactor chat.ts to compact format**

Same pattern: inline SOUL + human message + board digest + messages. Path-reference everything else.

```typescript
function buildChatPrompt(input: {
  projectId: string;
  repoPath: string;
  hiveHome: string;
  soul: string;
  board: string;
  openMessages: Awaited<ReturnType<typeof listOpenProjectMessages>>;
  message: string;
  // paths
  soulPath: string;
  selfPath: string;
  agentsPath: string;
  globalConfigPath: string;
  knowledgePath: string;
  decisionsPath: string;
  projectMemoryPath: string;
  projectConfigPath: string;
  planPath: string;
  boardPath: string;
  logPath: string;
  feedPath: string;
  messagesDir: string;
}): string {
  return `# HIVE Chat Prompt

You are HIVE itself for project ${input.projectId}. You are the human-facing interface over the hive's files.

## Identity
${input.soul.trim()}

## Human Message
${input.message}

## Operating Rules
- Answer the human directly and concretely.
- When the human changes priorities, scope, or team behavior, update the relevant files.
- Use msg/ for work handoffs or nudges to agents.
- Keep BOARD.md steward-owned.
- Keep feed.md high-signal.
- Keep LOG.md durable.

## Current State
${digestBoard(input.board)}

## Open Messages
${digestMessages(input.openMessages)}

## Files
Read these files as needed:
SOUL.md: ${input.soulPath}
SELF.md: ${input.selfPath}
AGENTS.md: ${input.agentsPath}
config: ${input.globalConfigPath}
knowledge: ${input.knowledgePath}
decisions: ${input.decisionsPath}
project-memory: ${input.projectMemoryPath}
project-config: ${input.projectConfigPath}
PLAN.md: ${input.planPath}
BOARD.md: ${input.boardPath}
LOG.md: ${input.logPath}
feed: ${input.feedPath}
messages-dir: ${input.messagesDir}

project: ${input.projectId}
repo: ${input.repoPath}
hive-home: ${input.hiveHome}`;
}
```

Update `chatCommand` to pass paths instead of content for the files that are no longer inlined. Remove reads for: self, globalConfig, knowledge, decisions, projectMemory, projectConfig, plan, log, feed. Keep reads for: soul, board, openMessages.

- [ ] **Step 2: Run the chat dry run test**

Run: `bun test tests/hive.test.ts -t "chat and launch"`
Expected: PASS (test checks for runtime/model resolution, not prompt content details)

- [ ] **Step 3: Run full test suite**

Run: `bun test`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add src/commands/chat.ts
git commit -m "compact chat prompt to path-first with digests"
```

---

## Chunk 4: Front Door Commands

### Task 8: Implement `hive run`

**Files:**
- Create: `src/commands/run.ts`
- Modify: `src/cli.ts`
- Modify: `tests/hive.test.ts`

`hive run` starts detached supervision if not already running. Idempotent.

- [ ] **Step 1: Write the failing test**

```typescript
test("run starts detached supervision idempotently", async () => {
  await initHive();
  await addProject();

  // First run should indicate start (but will fail to actually spawn in test env)
  // Test the command structure and error handling
  const output = await runCli(["run"]);

  expect(output).toContain("myapp");
  // Should mention supervisor state
  expect(output.toLowerCase()).toMatch(/running|started|supervisor/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hive.test.ts -t "run starts"`
Expected: FAIL — unknown command

- [ ] **Step 3: Implement run command**

Create `src/commands/run.ts`:

```typescript
import { UsageError } from "../lib/errors";
import {
  reconcileDetachedSupervisorState,
  startDetachedSupervisor,
} from "../lib/detached-supervisor";
import { appendFeedEntry } from "../lib/feed";
import { appendLogEntry } from "../lib/log";
import { isProcessAlive } from "../lib/supervisor";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import {
  DEFAULT_MAX_PARALLEL,
  DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
} from "../lib/supervisor";

type RunOptions = {
  intervalSeconds: number;
  maxParallel: number;
};

function parseOptions(args: string[]): RunOptions {
  let intervalSeconds = DEFAULT_SUPERVISOR_INTERVAL_SECONDS;
  let maxParallel = DEFAULT_MAX_PARALLEL;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--interval") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError("Usage: hive run [--interval <seconds>] [--max-parallel <count>]");
      }

      intervalSeconds = value;
      index += 1;
      continue;
    }

    if (arg === "--max-parallel") {
      const value = Number(args[index + 1]);

      if (!Number.isInteger(value) || value <= 0) {
        throw new UsageError("Usage: hive run [--interval <seconds>] [--max-parallel <count>]");
      }

      maxParallel = value;
      index += 1;
      continue;
    }

    throw new UsageError("Usage: hive run [--interval <seconds>] [--max-parallel <count>]");
  }

  return { intervalSeconds, maxParallel };
}

export async function runCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const existing = await reconcileDetachedSupervisorState(projectPaths);

  if (existing?.status === "active" && isProcessAlive(existing.pid)) {
    return [
      `HIVE is already running for ${activeProject}`,
      `pid: ${existing.pid}`,
      `interval: ${existing.intervalSeconds}s`,
      `last-pass: ${existing.lastPassAt ?? "none yet"}`,
    ].join("\n");
  }

  const state = await startDetachedSupervisor({
    projectPaths,
    projectId: activeProject,
    intervalSeconds: options.intervalSeconds,
    maxParallel: options.maxParallel,
  });

  await appendFeedEntry(paths, {
    project: activeProject,
    headline: "HIVE started",
    details: [`pid: ${state.pid ?? "unknown"}`, `interval: ${state.intervalSeconds}s`],
  });
  await appendLogEntry(
    projectPaths.log,
    "human -> hive run",
    `Started supervision pid ${state.pid ?? "unknown"} interval ${state.intervalSeconds}s max-parallel ${state.maxParallel}`,
  );

  return [
    `HIVE is running for ${activeProject}`,
    `pid: ${state.pid ?? "unknown"}`,
    `interval: ${state.intervalSeconds}s`,
    `max-parallel: ${state.maxParallel}`,
  ].join("\n");
}
```

- [ ] **Step 4: Register in cli.ts**

Add import and case:

```typescript
import { runCommand } from "./commands/run";

// In switch:
case "run":
  return runCommand(rest);
```

- [ ] **Step 5: Run test**

Run: `bun test tests/hive.test.ts -t "run starts"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/commands/run.ts src/cli.ts tests/hive.test.ts
git commit -m "add hive run command for idempotent supervision start"
```

### Task 9: Implement `hive say`

**Files:**
- Create: `src/commands/say.ts`
- Modify: `src/cli.ts`
- Modify: `tests/hive.test.ts`

`hive say "..."` creates a nudge + auto-starts supervision.

- [ ] **Step 1: Write the failing test**

```typescript
test("say creates a nudge and mentions supervisor", async () => {
  await initHive();
  await addProject();

  const output = await runCli(["say", "Build", "the", "auth", "system"]);

  expect(output).toContain("Build the auth system");

  const msgDirEntries = await readdir(join(context.hiveHome, "msg"));
  const nudgeFile = msgDirEntries.find((f) => f.includes("human-to-orchestrator"));

  expect(nudgeFile).toBeDefined();

  const nudgeContent = await Bun.file(join(context.hiveHome, "msg", nudgeFile!)).text();

  expect(nudgeContent).toContain("type: nudge");
  expect(nudgeContent).toContain("Build the auth system");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hive.test.ts -t "say creates"`
Expected: FAIL — unknown command

- [ ] **Step 3: Implement say command**

Create `src/commands/say.ts`:

```typescript
import { UsageError } from "../lib/errors";
import {
  reconcileDetachedSupervisorState,
  startDetachedSupervisor,
} from "../lib/detached-supervisor";
import { appendFeedEntry } from "../lib/feed";
import { appendLogEntry } from "../lib/log";
import { enqueueGoalForOrchestrator } from "../lib/orchestrator";
import { isProcessAlive } from "../lib/supervisor";
import {
  DEFAULT_MAX_PARALLEL,
  DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
} from "../lib/supervisor";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";

export async function sayCommand(args: string[]): Promise<string> {
  const message = args.join(" ").trim();

  if (!message) {
    throw new UsageError('Usage: hive say <message>\nExample: hive say "build the auth system"');
  }

  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);

  await enqueueGoalForOrchestrator(paths, projectPaths, activeProject, message);

  const existing = await reconcileDetachedSupervisorState(projectPaths);
  let supervisorNote: string;

  if (existing?.status === "active" && isProcessAlive(existing.pid)) {
    supervisorNote = `Supervisor active (pid ${existing.pid})`;
  } else {
    try {
      const state = await startDetachedSupervisor({
        projectPaths,
        projectId: activeProject,
        intervalSeconds: DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
        maxParallel: DEFAULT_MAX_PARALLEL,
      });

      supervisorNote = `Supervisor started (pid ${state.pid ?? "unknown"})`;
      await appendLogEntry(
        projectPaths.log,
        "human -> hive say",
        `Auto-started supervision pid ${state.pid ?? "unknown"}`,
      );
    } catch {
      supervisorNote = "Supervisor not started (start manually with `hive run`)";
    }
  }

  return [
    `Sent: ${message}`,
    supervisorNote,
  ].join("\n");
}
```

- [ ] **Step 4: Register in cli.ts**

```typescript
import { sayCommand } from "./commands/say";

// In switch:
case "say":
  return sayCommand(rest);
```

- [ ] **Step 5: Run test**

Run: `bun test tests/hive.test.ts -t "say creates"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/commands/say.ts src/cli.ts tests/hive.test.ts
git commit -m "add hive say command for conversational nudge with auto-start"
```

### Task 10: Implement `hive ask`

**Files:**
- Create: `src/commands/ask.ts`
- Modify: `src/cli.ts`
- Modify: `tests/hive.test.ts`

`hive ask` shows smart formatted status. No LLM call — fast, free, always available.

- [ ] **Step 1: Write the failing test**

```typescript
test("ask shows synthesized project status", async () => {
  await initHive();
  await addProject();

  await Bun.write(
    join(context.hiveHome, "projects", "myapp", "BOARD.md"),
    `# Board

## Tasks
- 001: Auth endpoint [alpha] [done]
- 002: Login form [beta] [active]

## Agents
### alpha (craftsman -> backend)
status: idle

### beta (craftsman -> frontend)
status: active on 002

## Blockers
(none)

## Decisions
(none)
`,
  );

  const output = await runCli(["ask"]);

  expect(output).toContain("myapp");
  expect(output).toContain("2 tasks");
  expect(output).toContain("alpha: idle");
  expect(output).toContain("beta: active on 002");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hive.test.ts -t "ask shows"`
Expected: FAIL — unknown command

- [ ] **Step 3: Implement ask command**

Create `src/commands/ask.ts`:

```typescript
import { digestBoard, digestMessages, digestRuns } from "../lib/digest";
import {
  reconcileDetachedSupervisorState,
} from "../lib/detached-supervisor";
import { formatFeed } from "../lib/feed";
import { listOpenProjectMessages } from "../lib/messages";
import { isProcessAlive } from "../lib/supervisor";
import { listActiveRuns } from "../lib/runs";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import { UsageError } from "../lib/errors";

export async function askCommand(args: string[]): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const boardText = await Bun.file(projectPaths.board).text();
  const activeRuns = await listActiveRuns(projectPaths);
  const supervisorState = await reconcileDetachedSupervisorState(projectPaths);
  const openMessages = await listOpenProjectMessages(paths.msgDir, activeProject);
  const feedText = await Bun.file(paths.feed).text();

  const sections: string[] = [];

  sections.push(`# ${activeProject}`);

  if (supervisorState?.status === "active" && isProcessAlive(supervisorState.pid)) {
    sections.push(
      `Supervisor: active (pid ${supervisorState.pid}, ${supervisorState.intervalSeconds}s interval)`,
    );
  } else {
    sections.push("Supervisor: not running");
  }

  sections.push("");
  sections.push(digestBoard(boardText));

  if (activeRuns.length > 0) {
    sections.push("");
    sections.push("Active Runs:");
    sections.push(digestRuns(activeRuns));
  }

  const nonAssignMessages = openMessages.filter(
    (m) => m.attributes.type !== "assign",
  );

  if (nonAssignMessages.length > 0) {
    sections.push("");
    sections.push("Open Messages:");
    sections.push(digestMessages(nonAssignMessages));
  }

  const recentFeed = formatFeed(feedText, 5);

  if (recentFeed.trim()) {
    sections.push("");
    sections.push("Recent:");
    sections.push(recentFeed);
  }

  return sections.join("\n");
}
```

- [ ] **Step 4: Register in cli.ts**

```typescript
import { askCommand } from "./commands/ask";

// In switch:
case "ask":
  return askCommand(rest);
```

- [ ] **Step 5: Run test**

Run: `bun test tests/hive.test.ts -t "ask shows"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/commands/ask.ts src/cli.ts tests/hive.test.ts
git commit -m "add hive ask command for fast synthesized status"
```

---

## Chunk 5: Supervision Logs + Help + Docs

### Task 11: Add `hive supervise logs`

**Files:**
- Modify: `src/commands/supervise.ts`
- Modify: `tests/hive.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
test("supervise logs shows log content when available", async () => {
  await initHive();
  await addProject();

  const projectPaths = join(context.hiveHome, "projects", "myapp");
  const supervisorDir = join(projectPaths, "supervisor");
  const logPath = join(supervisorDir, "detached.log");

  await mkdir(supervisorDir, { recursive: true });
  await Bun.write(logPath, "line1\nline2\nline3\n");
  await Bun.write(
    join(supervisorDir, "detached.md"),
    `---
project: myapp
status: stopped
mode: detached
interval: 30
max-parallel: 3
started: 2026-03-09T15:00:00Z
updated: 2026-03-09T15:10:00Z
log: ${logPath}
---

## Summary
`,
  );

  const output = await runCli(["supervise", "logs"]);

  expect(output).toContain("line1");
  expect(output).toContain("line2");
  expect(output).toContain("line3");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/hive.test.ts -t "supervise logs"`
Expected: FAIL

- [ ] **Step 3: Add logs subcommand to supervise.ts**

In `parseOptions`, add handling for `"logs"`:

```typescript
if (first === "status" || first === "stop" || first === "logs") {
  if (args.length !== 1) {
    throw new UsageError(usage);
  }

  return {
    intervalSeconds: DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
    maxParallel: DEFAULT_MAX_PARALLEL,
    once: false,
    detach: false,
    child: false,
    action: first,
  };
}
```

Update the `action` type to include `"logs"`.

In `superviseCommand`, add before the status/stop handlers:

```typescript
if (options.action === "logs") {
  const state = await readDetachedSupervisorState(projectPaths);

  if (!state?.logPath) {
    throw new UsageError("No detached supervisor log found.");
  }

  const file = Bun.file(state.logPath);

  if (!(await file.exists())) {
    return `Log file: ${state.logPath}\n\n(empty)`;
  }

  const content = await file.text();
  const lines = content.split("\n");
  const tail = lines.slice(-50).join("\n");

  return `Supervisor log: ${state.logPath}\n\n${tail}`;
}
```

Import `readDetachedSupervisorState` (already available via existing imports).

- [ ] **Step 4: Run test**

Run: `bun test tests/hive.test.ts -t "supervise logs"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/commands/supervise.ts tests/hive.test.ts
git commit -m "add hive supervise logs command"
```

### Task 12: Update help text

**Files:**
- Modify: `src/commands/help.ts`

- [ ] **Step 1: Update help command with new commands and grouping**

```typescript
export async function helpCommand(): Promise<string> {
  return `HIVE

Usage:
  hive run [--interval <seconds>] [--max-parallel <count>]
  hive say <message>
  hive ask [question]
  hive watch [count]
  hive stop <agent-id|run-id>

  hive init
  hive project add <project> <path>
  hive work [project]
  hive status
  hive feed [count]
  hive ps

  hive supervise [--interval <seconds>] [--max-parallel <count>] [--once|--detach]
  hive supervise status
  hive supervise stop
  hive supervise logs
  hive orchestrate [--mode interactive|loop] [--interval <seconds>] [goal]
  hive chat [--runtime <runtime>] [--model <model>] [--dry-run] <message>
  hive launch [--runtime <runtime>] [--model <model>] [--dry-run] <agent-id> [goal]
  hive inbox [agent]
  hive log <message>
  hive msg [--type <type>] <from> <to> <body>
  hive msg show <message>
  hive msg resolve <message> <actor> <answer>
  hive msg close <message> <actor> [note]
  hive nudge <message>
  hive prompt <agent-id>
  hive archive
  hive sync
  hive help

Notes:
  - HIVE stores state in ~/.hive/ by default.
  - Set HIVE_HOME to point the CLI at a different hive root.
  - Project names are normalized to lowercase slugs on disk.`;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/commands/help.ts
git commit -m "update help text with front door commands and supervise logs"
```

### Task 13: Update CLAUDE.md docs

**Files:**
- Modify: `docs/CLAUDE.md`

- [ ] **Step 1: Update CLI section with new commands**

Add `run`, `say`, `ask` to the CLI section. Add `AGENTS.md` to the structure. Add `supervise logs` to the supervise subcommands.

- [ ] **Step 2: Update Structure section**

Add `AGENTS.md` to the template listing. Add `src/commands/run.ts`, `src/commands/say.ts`, `src/commands/ask.ts`, `src/lib/digest.ts` to the file structure.

- [ ] **Step 3: Update Implementation Status**

Note prompt compaction and front door commands as implemented.

- [ ] **Step 4: Commit**

```bash
git add docs/CLAUDE.md
git commit -m "update docs for prompt compaction and front door commands"
```

### Task 14: Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 2: Build binary**

Run: `bun build --compile ./bin/hive.ts --outfile hive`
Expected: Compiles successfully

- [ ] **Step 3: Smoke test with built binary**

```bash
./hive help
./hive init  # (in test env)
```
Expected: Help shows new commands. Init creates AGENTS.md.
