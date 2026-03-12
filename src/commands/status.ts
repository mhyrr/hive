import { section } from "../lib/format";
import { listOpenProjectMessages } from "../lib/messages";
import {
  ensureHiveScaffold,
  getActiveProject,
  getProjectPaths,
} from "../lib/paths";
import { extractRepoPath } from "../lib/project";
import { UsageError } from "../lib/errors";
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

export async function statusCommand(): Promise<string> {
  const paths = await ensureHiveScaffold();
  const activeProject = await getActiveProject(paths);

  if (!activeProject) {
    throw new UsageError("No active project. Run `hive work <project>` first.");
  }

  const projectPaths = getProjectPaths(paths, activeProject);
  const configText = await Bun.file(projectPaths.config).text();
  const repoPath = extractRepoPath(configText) ?? "(unknown)";
  const state = await refreshProjectRuntimeState({
    hivePaths: paths,
    projectId: activeProject,
    projectPaths,
  });

  return [
    `Project: ${activeProject}`,
    `Repo path: ${repoPath}`,
    section("BOARD.md", state.boardText),
    section("Open Messages", formatMessages(state.openMessages)),
  ].join("\n\n");
}
