import {
  buildCognitiveRoutingSnapshot,
  renderCognitiveRoutingInspectionSnapshot,
} from "../lib/cognitive-routing";
import { refreshProjectCognitiveUsageSnapshot } from "../lib/cognitive-usage";
import { ensureHiveScaffold } from "../lib/paths";
import { getActiveSession, getSessionState } from "../lib/sessions";

export async function cognitionCommand(): Promise<string> {
  const paths = await ensureHiveScaffold();
  const globalConfig = await Bun.file(paths.config).text().catch(() => "");
  const activeSession = await getActiveSession(paths.sessionsDir);
  const currentProject = activeSession
    ? (await getSessionState(paths.sessionsDir, activeSession.sessionId))?.currentProject ??
      activeSession.project
    : null;
  const snapshot = await buildCognitiveRoutingSnapshot({
    globalConfig,
    session: activeSession
      ? {
          sessionId: activeSession.sessionId,
          project: currentProject ?? activeSession.project,
          runtime: activeSession.runtime,
          model: activeSession.model,
        }
      : null,
    persistentStewardEnabled: process.env.HIVE_ENABLE_PERSISTENT_STEWARD !== "0",
  });
  const usage = currentProject && currentProject !== "default"
    ? await refreshProjectCognitiveUsageSnapshot({
        hivePaths: paths,
        projectId: currentProject,
        globalConfig,
      })
    : null;

  return renderCognitiveRoutingInspectionSnapshot({
    snapshot,
    usage,
    configPath: paths.config,
    skillsDir: paths.skillsDir,
  });
}
