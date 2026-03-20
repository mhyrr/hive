import { UsageError } from "../lib/errors";
import { appendLogEntry } from "../lib/log";
import { enqueueGoalForOrchestrator } from "../lib/steward/prompts";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
  type HivePaths,
} from "../lib/paths";
import { refreshProjectRuntimeState } from "../lib/state";
import {
  runPersistentStewardTurn,
  type PersistentStewardTurnResult,
} from "../lib/persistent-steward";
import { resolveRuntimeHints } from "../lib/runtime";
import {
  createSession,
  getActiveSession,
} from "../lib/sessions";
import { ensureGatewayRunning } from "./gateway";

type SayOptions = {
  runtimeOverride: string | null;
  modelOverride: string | null;
  message: string;
};

function parseOptions(args: string[]): SayOptions {
  let runtimeOverride: string | null = null;
  let modelOverride: string | null = null;
  const messageParts: string[] = [];

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

    messageParts.push(arg);
  }

  const message = messageParts.join(" ").trim();

  return {
    runtimeOverride,
    modelOverride,
    message,
  };
}

export async function sendGoalToProject(input: {
  projectId: string;
  message: string;
  paths?: HivePaths;
}): Promise<string> {
  const message = input.message.trim();

  if (!message) {
    throw new UsageError('Usage: hive say <message>\nExample: hive say "build the auth system"');
  }

  const paths = input.paths ?? await ensureHiveScaffold();
  const projectPaths = getProjectPaths(paths, input.projectId);

  await enqueueGoalForOrchestrator(paths, projectPaths, input.projectId, message);

  let supervisorNote: string;

  try {
    const state = await ensureGatewayRunning();

    supervisorNote = `Gateway active (gateway pid ${state.pid ?? "unknown"}, supervisor pid ${state.supervisorPid ?? "unknown"})`;
    await appendLogEntry(
      projectPaths.log,
      "human -> hive say",
      `Ensured managed gateway pid ${state.pid ?? "unknown"} supervisor ${state.supervisorPid ?? "unknown"}`,
    );
  } catch {
    supervisorNote = "Gateway not started (start manually with `hive start`)";
  }

  await refreshProjectRuntimeState({
    hivePaths: paths,
    projectId: input.projectId,
    projectPaths,
  });

  return [
    `Sent: ${message}`,
    supervisorNote,
  ].join("\n");
}

export async function sayCommand(
  args: string[],
  options?: { onOutput?: (content: string) => void },
): Promise<string> {
  const parsed = parseOptions(args);
  const message = parsed.message;

  if (!message) {
    throw new UsageError(
      'Usage: hive say [--runtime <runtime>] [--model <model>] <message>\nExample: hive say "build the auth system"',
    );
  }

  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const globalConfig = await Bun.file(paths.config).text().catch(() => "");
  const hints = resolveRuntimeHints({
    globalConfig,
    runtimeOverride: parsed.runtimeOverride,
    modelOverride: parsed.modelOverride,
  });

  // Ensure gateway and supervisor are running
  let supervisorNote = "";

  try {
    const state = await ensureGatewayRunning();
    supervisorNote = `Gateway active (pid ${state.pid ?? "unknown"})`;
  } catch {
    supervisorNote = "Gateway not started (start manually with `hive start`)";
  }

  // Enqueue the goal so the orchestrator picks it up
  await enqueueGoalForOrchestrator(paths, projectPaths, activeProject, message);

  await appendLogEntry(projectPaths.log, "human -> hive say", message);

  // Get or create a session for the persistent steward
  let session = await getActiveSession(paths.sessionsDir);

  if (!session) {
    session = await createSession({
      sessionsDir: paths.sessionsDir,
      project: activeProject,
      runtime: hints.runtime,
      model: hints.model,
      systemPrompt: "",
    });
  }

  // Run a persistent steward turn and collect the response.
  // When called from CLI, stream to stdout. When called from the gateway
  // API, the caller passes onOutput to collect text without stdout.
  let collectedOutput = "";
  const emitOutput = options?.onOutput ?? ((content: string) => process.stdout.write(content));

  const result: PersistentStewardTurnResult = await runPersistentStewardTurn({
    hivePaths: paths,
    projectId: activeProject,
    sessionId: session.sessionId,
    humanMessage: message,
    onOutput: (content: string) => {
      collectedOutput += content;
      emitOutput(content);
    },
  });

  if (result.mode === "fallback") {
    // Persistent steward unavailable — fall back to the goal-enqueue path
    return [
      `Sent: ${message}`,
      supervisorNote,
      `(Steward session not available: ${result.reason})`,
    ].join("\n");
  }

  // The steward responded via the persistent session.
  // Always return the collected text so API callers get the full response.
  const reply = collectedOutput.trim() || result.finalVisibleOutput?.trim() || "";

  if (!reply) {
    return [
      `Sent: ${message}`,
      supervisorNote,
    ].join("\n");
  }

  return reply;
}
