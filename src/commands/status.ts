import { section } from "../lib/format";
import { reconcileGatewayState, type GatewayStateRecord } from "../lib/gateway-state";
import { listActiveGoals } from "../lib/goals";
import { listOpenProjectMessages } from "../lib/messages";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import { hasPersistentStewardSession } from "../lib/persistent-steward";
import { extractRepoPath } from "../lib/project";
import {
  reconcileDetachedSupervisorState,
  type DetachedSupervisorState,
} from "../lib/detached-supervisor";
import { refreshProjectRuntimeState } from "../lib/state";

function formatMessages(messages: Awaited<ReturnType<typeof listOpenProjectMessages>>): string {
  if (messages.length === 0) {
    return "(none)";
  }

  return messages
    .map((message) => {
      const preview = message.body.split("\n")[0];

      return [
        `- ${message.filename}`,
        `  ${message.attributes.type ?? "notify"} | ${message.attributes.from ?? "?"} -> ${message.attributes.to ?? "?"} | ${message.attributes.ts ?? ""}`,
        `  ${preview}`,
      ].join("\n");
    })
    .join("\n\n");
}

function formatGatewayLine(state: GatewayStateRecord | null): string {
  if (!state) {
    return "gateway: not running";
  }

  const parts = [`gateway: ${state.status}`];

  if (state.pid) {
    parts.push(`pid ${state.pid}`);
  }

  if (state.port) {
    parts.push(`port ${state.port}`);
  }

  if (state.url) {
    parts.push(state.url);
  }

  return parts.join(" | ");
}

function formatSupervisorLine(input: {
  gatewayState: GatewayStateRecord | null;
  supervisorState: DetachedSupervisorState | null;
}): string {
  const gatewaySupervisorKnown =
    input.gatewayState?.supervisorPid != null ||
    input.gatewayState?.supervisorStatus != null ||
    input.gatewayState?.supervisorProject != null;

  if (gatewaySupervisorKnown) {
    const parts = [`supervisor: ${input.gatewayState?.supervisorStatus ?? "unknown"}`];

    if (input.gatewayState?.supervisorPid) {
      parts.push(`pid ${input.gatewayState.supervisorPid}`);
    }

    if (
      input.supervisorState &&
      input.supervisorState.projectId === input.gatewayState?.supervisorProject
    ) {
      parts.push(`mode ${input.supervisorState.mode}`);
    }

    if (input.gatewayState?.supervisorProject) {
      parts.push(`project ${input.gatewayState.supervisorProject}`);
    }

    return parts.join(" | ");
  }

  if (!input.supervisorState) {
    return "supervisor: not running";
  }

  const parts = [`supervisor: ${input.supervisorState.status}`];

  if (input.supervisorState.pid) {
    parts.push(`pid ${input.supervisorState.pid}`);
  }

  parts.push(`mode ${input.supervisorState.mode}`);
  parts.push(`project ${input.supervisorState.projectId}`);

  return parts.join(" | ");
}

export async function statusCommand(): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);
  const gatewayState = await reconcileGatewayState(paths.home);
  const persistentStewardActive = hasPersistentStewardSession(paths.home);

  let supervisorState: DetachedSupervisorState | null = null;

  if (activeProject) {
    supervisorState = await reconcileDetachedSupervisorState(getProjectPaths(paths, activeProject));
  }

  const runtimeSection = section(
    "Runtime",
    [
      `active project: ${activeProject ?? "none"}`,
      formatGatewayLine(gatewayState),
      formatSupervisorLine({ gatewayState, supervisorState }),
      `persistent steward: ${persistentStewardActive ? "alive" : "offline"}`,
    ].join("\n"),
  );

  if (!activeProject) {
    return [runtimeSection, "Project: none"].join("\n\n");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const configText = await Bun.file(projectPaths.config).text();
  const repoPath = extractRepoPath(configText) ?? "(unknown)";
  const state = await refreshProjectRuntimeState({
    hivePaths: paths,
    projectId: activeProject,
    projectPaths,
  });

  const activeGoals = await listActiveGoals(projectPaths.goalsDir);
  const goalSection =
    activeGoals.length > 0
      ? section(
          "Active Goals",
          activeGoals.map((g) => `- ${g.id} [${g.status}] ${g.description}`).join("\n"),
        )
      : null;

  return [
    runtimeSection,
    `Project: ${activeProject}`,
    `Repo path: ${repoPath}`,
    section("BOARD.md", state.boardText),
    section("Open Messages", formatMessages(state.openMessages)),
    goalSection,
  ]
    .filter(Boolean)
    .join("\n\n");
}
