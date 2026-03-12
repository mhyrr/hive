import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { appendLogEntry } from "../lib/log";
import { digestBoard, digestMessages, listSkills } from "../lib/digest";
import { listOpenProjectMessages } from "../lib/messages";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import { extractRepoPath } from "../lib/project";
import {
  createRunDraft,
  createRunPromptArtifact,
  finalizeRun,
  markRunActive,
  readActiveRun,
} from "../lib/runs";
import {
  buildInteractiveLaunchSpec,
  renderLaunchPreview,
  resolveRuntimeHints,
  startInteractiveSession,
} from "../lib/runtime";
import { UsageError } from "../lib/errors";
import { appendFeedEntry } from "../lib/feed";
import { refreshProjectRuntimeState } from "../lib/state";

type ConsoleOptions = {
  runtimeOverride: string | null;
  modelOverride: string | null;
  dryRun: boolean;
};

function parseOptions(args: string[]): ConsoleOptions {
  let runtimeOverride: string | null = null;
  let modelOverride: string | null = null;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--runtime") {
      runtimeOverride = args[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--model") {
      modelOverride = args[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new UsageError("Usage: hive console [--runtime <runtime>] [--model <model>] [--dry-run]");
  }

  return {
    runtimeOverride,
    modelOverride,
    dryRun,
  };
}

async function listAvailableSkills(skillsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(skillsDir);
    return entries
      .filter((e) => e.endsWith(".md"))
      .map((e) => e.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

function buildConsolePrompt(input: {
  projectId: string;
  repoPath: string;
  hiveHome: string;
  pathsSoul: string;
  pathsSelf: string;
  pathsAgents: string;
  pathsConfig: string;
  pathsFeed: string;
  knowledgePath: string;
  decisionsPath: string;
  projectConfigPath: string;
  planPath: string;
  boardPath: string;
  logPath: string;
  projectMemoryPath: string;
  projectMemory: string;
  messagesDir: string;
  skillsDir: string;
  availableSkillNames: string[];
  soul: string;
  board: string;
  openMessages: Awaited<ReturnType<typeof listOpenProjectMessages>>;
}): string {
  const essentialSkills = ["state-efficient-ops", "autonomous-ops"];
  const essentialSkillPaths = essentialSkills
    .filter((name) => input.availableSkillNames.includes(name))
    .map((name) => `${input.skillsDir}/${name}.md`);

  return `# HIVE Mind

You are the hive. Not a tool the human uses — the intelligence that manages a team of agents and talks to the human as a peer.

The human talks to you. You manage everything else. When they say "build the auth flow," you decompose it, assign it, track it, and keep them informed. When they say "that approach is wrong, use Joken," you record the decision, redirect the agents, and confirm. You don't explain what commands to run. You run them.

## Your Soul
${input.soul}

## Before Your First Action
Read these skills — they define how you think:
${essentialSkillPaths.map((p) => `- ${p}`).join("\n") || "- (none)"}

Read operational protocols: ${input.pathsAgents}
Read your user's preferences: ${input.pathsSelf}

## How You Operate

### You Take Initiative
When the human states a preference → record it: \`hive memory convention "..."\`
When a technical decision is made → record it: \`hive memory decision "..."\`
When you learn a fact about the project → record it: \`hive memory fact "..."\`
When work needs to split → update BOARD.md, create assignment messages, let the supervisor launch agents
When work needs review → assign a critic agent
When an agent is stuck → nudge it or reassign the work
When something significant happens → log it to feed

You don't announce these actions to the human. You just do them. They'll see the results in the feed if it matters.

### You Manage the Team
- Update BOARD.md directly — you own it
- Send assignment messages with \`hive msg --type assign orchestrator <agent> <body>\` including \`task:\`, \`launch: auto\`, and \`scope:\` frontmatter
- Check agent progress: \`hive ps\`, \`hive inbox <agent>\`, read their LOG.md entries
- Resolve handled messages: \`hive msg resolve <message> orchestrator <answer>\`
- When creating or redirecting work, update PLAN.md too

### You Talk to the Human Like a Peer
- Answer directly. No hedging, no "I'd be happy to."
- Surface decisions, not status. "Auth will use Joken — lighter for API-only" beats "I'm reading the auth module."
- When you need a human call, frame it crisply: options, trade-offs, your recommendation
- Between turns, agents may have changed state. Re-read live files before answering questions about current status.

## Your Nervous System
These are extensions of you — use them without explanation:

State: \`hive status\` · \`hive ps\` · \`hive feed 5\` · \`hive ask\`
Memory: \`hive memory\` · \`hive memory decision|convention|fact|question "..."\`
Messages: \`hive msg\` · \`hive inbox <agent>\` · \`hive msg resolve|close ...\`
Agents: \`hive launch <agent>\` · \`hive stop <agent>\` · \`hive prompt <agent>\`
Logging: \`hive log "..."\`

The authoritative hive files are not in the repo root. Use absolute paths.

## Identity
project: ${input.projectId}
repo: ${input.repoPath}
hive-home: ${input.hiveHome}

## Files
SOUL.md: ${input.pathsSoul}
SELF.md: ${input.pathsSelf}
AGENTS.md: ${input.pathsAgents}
config: ${input.pathsConfig}
feed: ${input.pathsFeed}
knowledge: ${input.knowledgePath}
decisions: ${input.decisionsPath}
project-config: ${input.projectConfigPath}
PLAN.md: ${input.planPath}
BOARD.md: ${input.boardPath}
LOG.md: ${input.logPath}
project-memory: ${input.projectMemoryPath}
messages-dir: ${input.messagesDir}
skills-dir: ${input.skillsDir}

## Current State

### Board
${digestBoard(input.board)}

### Project Memory
${input.projectMemory}

### Open Messages
${digestMessages(input.openMessages)}`;
}

export async function consoleCommand(args: string[]): Promise<string> {
  const options = parseOptions(args);
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const soul = await Bun.file(paths.soul).text();
  const globalConfig = await Bun.file(paths.config).text();
  const projectConfig = await Bun.file(projectPaths.config).text();
  const repoPath = extractRepoPath(projectConfig);

  if (!repoPath) {
    throw new UsageError("Project config is missing `path:` in the repo section.");
  }

  const existingConsole = await readActiveRun(projectPaths, "console");
  if (existingConsole) {
    throw new UsageError(
      `A console session is already active (${existingConsole.runId}). Use \`hive ps\` to inspect it.`,
    );
  }

  const state = await refreshProjectRuntimeState({
    hivePaths: paths,
    projectId: activeProject,
    projectPaths,
  });
  const availableSkillNames = await listAvailableSkills(paths.skillsDir);

  let projectMemory = "(none yet)";

  try {
    const memoryFile = Bun.file(projectPaths.memory);

    if (await memoryFile.exists()) {
      const content = (await memoryFile.text()).trim();

      if (content) {
        projectMemory = content;
      }
    }
  } catch {
    // leave as default
  }

  const prompt = buildConsolePrompt({
    projectId: activeProject,
    repoPath,
    hiveHome: paths.home,
    pathsSoul: paths.soul,
    pathsSelf: paths.self,
    pathsAgents: paths.agents,
    pathsConfig: paths.config,
    pathsFeed: paths.feed,
    knowledgePath: join(paths.memoryDir, "knowledge.md"),
    decisionsPath: join(paths.memoryDir, "decisions.md"),
    projectConfigPath: projectPaths.config,
    planPath: projectPaths.plan,
    boardPath: projectPaths.board,
    logPath: projectPaths.log,
    projectMemoryPath: projectPaths.memory,
    projectMemory,
    messagesDir: paths.msgDir,
    skillsDir: paths.skillsDir,
    availableSkillNames,
    soul: soul.trim(),
    board: state.boardText.trim(),
    openMessages: state.openMessages,
  });

  const hints = resolveRuntimeHints({
    globalConfig,
    runtimeOverride: options.runtimeOverride,
    modelOverride: options.modelOverride,
  });

  const spec = buildInteractiveLaunchSpec({
    runtime: hints.runtime,
    model: hints.model,
    repoPath,
    hiveHome: paths.home,
    systemPrompt: prompt,
  });

  if (options.dryRun) {
    const artifact = await createRunPromptArtifact(projectPaths, "console", prompt);
    return `Console dry run
Project: ${activeProject}
Runtime: ${spec.runtime}
Model: ${spec.model ?? "(default)"}
Prompt: ${artifact.promptPath}
Command: ${renderLaunchPreview(spec)}`;
  }

  let run = await createRunDraft({
    projectId: activeProject,
    projectPaths,
    agentId: "console",
    runtime: spec.runtime,
    model: spec.model,
    prompt,
    source: "console",
  });

  await appendLogEntry(projectPaths.log, "human → hive console", "Interactive session started");
  await appendFeedEntry(paths, {
    project: activeProject,
    headline: `Console session started`,
    details: [`runtime: ${spec.runtime}`, `model: ${spec.model ?? "(default)"}`],
  });

  const handle = startInteractiveSession(spec, repoPath);
  run = await markRunActive(projectPaths, run, handle.pid);
  const result = await handle.wait();

  const stopRequested = (await Bun.file(run.path).text()).includes("stop-requested-at:");

  await finalizeRun({
    projectPaths,
    run,
    status: stopRequested
      ? "cancelled"
      : result.signal || (result.code !== null && result.code !== 0)
        ? "failed"
        : "exited",
    exitCode: result.code,
  });

  await appendFeedEntry(paths, {
    project: activeProject,
    headline: `Console session ended`,
    details: [
      `runtime: ${spec.runtime}`,
      `exit: ${result.code ?? "unknown"}${result.signal ? ` | signal: ${result.signal}` : ""}`,
    ],
  });

  if (result.signal) {
    throw new UsageError(`Console runtime exited due to ${result.signal}`);
  }

  if (result.code !== null && result.code !== 0) {
    throw new UsageError(`Console runtime exited with status ${result.code}`);
  }

  return `Hive console session completed via ${spec.runtime}${spec.model ? ` (${spec.model})` : ""}`;
}
