import {
  buildCognitiveRoutingSnapshot,
  renderCognitiveRoutingInspectionSnapshot,
} from "../lib/cognitive-routing";
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
  });

  return renderCognitiveRoutingInspectionSnapshot({
    snapshot,
    configPath: paths.config,
    skillsDir: paths.skillsDir,
  });
}
