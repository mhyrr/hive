import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { feedCommand } from "../commands/feed";
import { inboxCommand } from "../commands/inbox";
import { logCommand } from "../commands/log";
import { msgCommand, nudgeCommand } from "../commands/msg";
import { psCommand } from "../commands/ps";
import { sayCommand } from "../commands/say";
import { statusCommand } from "../commands/status";
import { runtimesCommand } from "../commands/runtimes";
import {
  buildCognitiveRoutingSnapshot,
  renderCognitiveRoutingInspectionSnapshot,
} from "../lib/cognitive-routing";
import { refreshProjectCognitiveUsageSnapshot } from "../lib/cognitive-usage";
import { reconcileDetachedSupervisorState, startDetachedSupervisor } from "../lib/detached-supervisor";
import { UsageError } from "../lib/errors";
import { appendFeedEntry, parseStructuredFeedEntries } from "../lib/feed";
import { appendLogEntry } from "../lib/log";
import { getActiveProject, getProjectPaths, listProjects } from "../lib/paths";
import {
  getRunOutputPath,
  listActiveRuns,
  markRunStopRequested,
  readRunOutputTail,
  reconcileActiveConsoleRun,
} from "../lib/runs";
import {
  appendTurn,
  getActiveSession,
  getSession,
  getSessionHistory,
  listSessions,
  switchSessionProject,
} from "../lib/sessions";
import {
  DEFAULT_MAX_PARALLEL,
  DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
  isProcessAlive,
} from "../lib/supervisor";
import { abortPersistentStewardTurn, isPersistentStewardTurnActive } from "../lib/steward/turn";
import { continueConsoleWorkflow as continueStewardConsoleWorkflow } from "../lib/steward/workflow";
import {
  restartManagedGatewaySupervisor,
  type GatewayBroadcast,
  type GatewayOptions,
} from "./server";
import {
  createGatewaySession,
  createStewardWorkflowCallbacks,
  getSessionProjectFocus,
  primeGatewayPersistentStewardSession,
  resolveGatewayProjectFocus,
  resolveSessionTurnTarget,
  scheduleProjectRuntimeRefresh,
} from "./console";
import {
  buildGatewayProjectCognitionSnapshot,
  buildGatewayLiveSnapshot,
  buildGatewayQueueSnapshot,
  buildGatewayTimeline,
  readTextTail,
} from "./snapshots";

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonOk(data: string | object): Response {
  const body = typeof data === "string" ? { result: data } : data;
  return new Response(JSON.stringify(body), {
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(),
    },
  });
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") {
    return null;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function buildOpenInvocation(input: {
  path: string;
  line?: number | null;
}): { command: string; args: string[]; strategy: "default-app" | "editor-cli" } {
  const normalizedPath = input.path.trim();
  const line = input.line ?? null;
  const explicitCommand = process.env.HIVE_OPEN_COMMAND?.trim();

  if (explicitCommand) {
    return {
      command: explicitCommand,
      args: line ? [`${normalizedPath}:${line}`] : [normalizedPath],
      strategy: "editor-cli",
    };
  }

  const explicitEditorCli = process.env.HIVE_EDITOR_CLI?.trim();

  if (explicitEditorCli) {
    return {
      command: explicitEditorCli,
      args: line ? ["--goto", `${normalizedPath}:${line}`] : [normalizedPath],
      strategy: "editor-cli",
    };
  }

  if (process.platform === "darwin") {
    return {
      command: "open",
      args: [normalizedPath],
      strategy: "default-app",
    };
  }

  if (process.platform === "linux") {
    return {
      command: "xdg-open",
      args: [normalizedPath],
      strategy: "default-app",
    };
  }

  if (process.platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", "", normalizedPath],
      strategy: "default-app",
    };
  }

  throw new UsageError(`Unsupported platform for opening files: ${process.platform}`);
}

async function openLocalPath(input: {
  path: string;
  line?: number | null;
}): Promise<{ strategy: "default-app" | "editor-cli" }> {
  const normalizedPath = input.path.trim();

  if (!normalizedPath) {
    throw new UsageError("Missing path");
  }

  if (!normalizedPath.startsWith("/")) {
    throw new UsageError("Path must be absolute");
  }

  const file = Bun.file(normalizedPath);

  if (!(await file.exists())) {
    throw new UsageError(`File not found: ${normalizedPath}`);
  }

  const invocation = buildOpenInvocation({
    path: normalizedPath,
    line: input.line ?? null,
  });

  Bun.spawn([invocation.command, ...invocation.args], {
    stdio: ["ignore", "ignore", "ignore"],
  });

  return {
    strategy: invocation.strategy,
  };
}

export function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

async function readGatewayGlobalConfig(options: GatewayOptions): Promise<string> {
  return Bun.file(options.hivePaths.config).text().catch(() => "");
}

async function ensureGatewayWakeSession(input: {
  options: GatewayOptions;
  requestedProject?: string | null;
}): Promise<{
  sessionId: string;
  projectId: string;
}> {
  const sessionsDir = join(input.options.hivePaths.home, "sessions");
  await mkdir(sessionsDir, { recursive: true });

  let session = await getActiveSession(sessionsDir);
  const fallbackProject =
    input.requestedProject?.trim() ||
    (await getActiveProject(input.options.hivePaths)) ||
    "default";

  if (!session) {
    session = await createGatewaySession({
      options: input.options,
      project: fallbackProject,
    });
  }

  let projectId = await getSessionProjectFocus({
    sessionsDir,
    sessionId: session.sessionId,
    fallbackProject: session.project,
  });

  if (input.requestedProject?.trim() && input.requestedProject !== projectId) {
    await switchSessionProject({
      sessionsDir,
      sessionId: session.sessionId,
      projectId: input.requestedProject,
    });
    projectId = input.requestedProject;
  }

  void primeGatewayPersistentStewardSession({
    options: input.options,
    sessionId: session.sessionId,
  }).catch(() => {
    // Warm the persistent steward session without blocking request handling.
  });

  return {
    sessionId: session.sessionId,
    projectId,
  };
}

type RouteHandler = (
  req: Request,
  url: URL,
  options: GatewayOptions,
  broadcast: GatewayBroadcast,
) => Promise<Response>;

const getRoutes: Record<string, RouteHandler> = {
  "/api/status": async (_req, _url, _options, _broadcast) => {
    try {
      const result = await statusCommand();
      return jsonOk(result);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/feed": async (_req, url, _options, _broadcast) => {
    try {
      const count = url.searchParams.get("count") ?? "20";
      const result = await feedCommand([count]);
      return jsonOk({ result, entries: parseStructuredFeedEntries(result) });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/live": async (_req, url, options, _broadcast) => {
    try {
      const projectId = await resolveGatewayProjectFocus({
        options,
        requestedProject: url.searchParams.get("project"),
      });
      const snapshot = await buildGatewayLiveSnapshot({
        options,
        projectId,
      });
      return jsonOk(snapshot);
    } catch (err) {
      if (err instanceof UsageError) {
        return jsonError(400, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/queue": async (_req, url, options, _broadcast) => {
    try {
      const projectId = await resolveGatewayProjectFocus({
        options,
        requestedProject: url.searchParams.get("project"),
      });
      const queue = await buildGatewayQueueSnapshot({
        options,
        projectId,
      });
      return jsonOk(queue);
    } catch (err) {
      if (err instanceof UsageError) {
        return jsonError(400, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/timeline": async (_req, url, options, _broadcast) => {
    try {
      const rawCount = url.searchParams.get("count") ?? "40";
      const count = Number(rawCount);

      if (!Number.isInteger(count) || count <= 0) {
        return jsonError(400, "Invalid count");
      }

      const projectId = await resolveGatewayProjectFocus({
        options,
        requestedProject: url.searchParams.get("project"),
      });
      const timeline = await buildGatewayTimeline({
        options,
        projectId,
        count,
      });
      return jsonOk(timeline);
    } catch (err) {
      if (err instanceof UsageError) {
        return jsonError(400, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/file": async (_req, url, _options, _broadcast) => {
    const requestedPath = url.searchParams.get("path")?.trim() ?? "";

    if (!requestedPath) {
      return jsonError(400, "Missing path");
    }

    if (!requestedPath.startsWith("/")) {
      return jsonError(400, "Path must be absolute");
    }

    const normalizedPath = requestedPath.split("#")[0] ?? requestedPath;
    const file = Bun.file(normalizedPath);

    if (!(await file.exists())) {
      return jsonError(404, `File not found: ${normalizedPath}`);
    }

    return new Response(await file.text(), {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        ...corsHeaders(),
      },
    });
  },

  "/api/ps": async (_req, _url, _options, _broadcast) => {
    try {
      const result = await psCommand();
      return jsonOk(result);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/projects": async (_req, _url, options, _broadcast) => {
    try {
      const projects = await listProjects(options.hivePaths);
      return jsonOk({ projects });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/process-logs": async (_req, url, options, _broadcast) => {
    try {
      const projectId = await resolveGatewayProjectFocus({
        options,
        requestedProject: url.searchParams.get("project"),
      });

      if (!projectId || projectId === "default") {
        return jsonOk({
          project: null,
          supervisor: null,
          runs: [],
        });
      }

      const projectPaths = getProjectPaths(options.hivePaths, projectId);
      const requestedRunId = url.searchParams.get("run")?.trim() || null;
      const requestedLineCount = toPositiveInteger(url.searchParams.get("lines"));
      const tailLimit = Math.min(Math.max(requestedLineCount ?? (requestedRunId ? 240 : 40), 20), 400);
      const [supervisor, activeRuns] = await Promise.all([
        reconcileDetachedSupervisorState(projectPaths),
        listActiveRuns(projectPaths),
      ]);

      const supervisorPayload = supervisor
        ? {
            status: supervisor.status,
            pid: supervisor.pid,
            logPath: supervisor.logPath,
            tail: await readTextTail(
              supervisor.logPath,
              requestedRunId === "supervisor" ? tailLimit : 50,
            ),
          }
        : null;

      const runs = await Promise.all(
        activeRuns.map(async (run) => {
          const isFocusedRun = requestedRunId !== null && requestedRunId === run.runId;

          return {
            runId: run.runId,
            agentId: run.agentId,
            status: run.status,
            runtime: run.runtime,
            model: run.model,
            started: run.started,
            pid: run.pid,
            outputPath: getRunOutputPath(run),
            tail: await readRunOutputTail(run, isFocusedRun ? tailLimit : 40),
          };
        }),
      );

      return jsonOk({
        project: projectId,
        selectedRunId: requestedRunId,
        supervisor: supervisorPayload,
        runs,
      });
    } catch (err) {
      if (err instanceof UsageError) {
        return jsonError(400, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/runtimes": async (_req, _url, _options, _broadcast) => {
    try {
      const result = await runtimesCommand();
      return jsonOk(result);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/cognition": async (_req, url, options, _broadcast) => {
    try {
      const globalConfig = await readGatewayGlobalConfig(options);
      const sessionsDir = join(options.hivePaths.home, "sessions");
      const activeSession = await getActiveSession(sessionsDir);
      const requestedProject = await resolveGatewayProjectFocus({
        options,
        requestedProject: url.searchParams.get("project"),
      });
      const currentProject = activeSession
        ? await getSessionProjectFocus({
            sessionsDir,
            sessionId: activeSession.sessionId,
            fallbackProject: activeSession.project,
          })
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
      const usage = requestedProject && requestedProject !== "default"
        ? await refreshProjectCognitiveUsageSnapshot({
            hivePaths: options.hivePaths,
            projectId: requestedProject,
            globalConfig,
          })
        : null;
      const compiled = await buildGatewayProjectCognitionSnapshot({
        options,
        projectId: requestedProject,
      });

      return jsonOk({
        project: requestedProject,
        policy: snapshot.policy,
        activeSession: snapshot.activeSession,
        activeLane: snapshot.activeLane,
        activeExecution: snapshot.activeExecution,
        defaultLane: snapshot.defaultLane,
        defaultExecution: snapshot.defaultExecution,
        tier1: snapshot.tier1,
        localModels: snapshot.localModels,
        usage,
        compiled,
        rendered: renderCognitiveRoutingInspectionSnapshot({
          snapshot,
          usage,
          configPath: options.hivePaths.config,
          skillsDir: options.hivePaths.skillsDir,
        }),
      });
    } catch (err) {
      if (err instanceof UsageError) {
        return jsonError(400, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/console/history": async (_req, _url, options, _broadcast) => {
    try {
      const sessionsDir = join(options.hivePaths.home, "sessions");
      const session = await getActiveSession(sessionsDir);
      if (!session) {
        return jsonOk({ turns: [], sessionId: null, project: null });
      }
      void primeGatewayPersistentStewardSession({
        options,
        sessionId: session.sessionId,
      }).catch(() => {
        // Session priming is best-effort for startup races.
      });
      const turns = await getSessionHistory(sessionsDir, session.sessionId);
      const project = await getSessionProjectFocus({
        sessionsDir,
        sessionId: session.sessionId,
        fallbackProject: session.project,
      });
      return jsonOk({ turns, sessionId: session.sessionId, project });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/sessions": async (_req, _url, options, _broadcast) => {
    try {
      const sessionsDir = join(options.hivePaths.home, "sessions");
      const sessions = await listSessions(sessionsDir);
      const enrichedSessions = await Promise.all(
        sessions.map(async (session) => ({
          ...session,
          currentProject: await getSessionProjectFocus({
            sessionsDir,
            sessionId: session.sessionId,
            fallbackProject: session.project,
          }),
        })),
      );
      return jsonOk({ sessions: enrichedSessions });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },
};

const postRoutes: Record<string, RouteHandler> = {
  "/api/say": async (req, _url, _options, _broadcast) => {
    try {
      const body = await req.json() as { message?: string };
      if (!body.message) {
        return jsonError(400, "Missing 'message' field in request body");
      }
      const result = await sayCommand([body.message]);
      return jsonOk(result);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/console/send": async (req, _url, options, broadcast) => {
    try {
      const body = await req.json() as { message?: string };
      if (!body.message) {
        return jsonError(400, "Missing 'message' field");
      }

      const sessionsDir = join(options.hivePaths.home, "sessions");
      await mkdir(sessionsDir, { recursive: true });

      let session = await getActiveSession(sessionsDir);
      if (!session) {
        const activeProject = await getActiveProject(options.hivePaths);
        session = await createGatewaySession({
          options,
          project: activeProject || "default",
        });
      }
      void primeGatewayPersistentStewardSession({
        options,
        sessionId: session.sessionId,
      }).catch(() => {
        // Warm the persistent steward session without blocking request handling.
      });

      const target = await resolveSessionTurnTarget({
        options,
        sessionId: session.sessionId,
        sessionProject: session.project,
        rawMessage: body.message,
      });

      await appendTurn({
        sessionsDir,
        sessionId: session.sessionId,
        role: "human",
        content: body.message,
        source: "human",
      });

      if (!target.continueWorkflow) {
        const result = target.result ?? "Command completed.";
        await appendTurn({
          sessionsDir,
          sessionId: session.sessionId,
          role: "assistant",
          content: result,
          source: target.resultSource ?? "system",
        });

        scheduleProjectRuntimeRefresh({
          hivePaths: options.hivePaths,
          projectId: target.projectId,
        });

        return jsonOk({
          result,
          resultSource: target.resultSource ?? "system",
          sessionId: session.sessionId,
          project: target.projectId,
        });
      }

      scheduleProjectRuntimeRefresh({
        hivePaths: options.hivePaths,
        projectId: target.projectId,
      });

      void continueStewardConsoleWorkflow({
        hivePaths: options.hivePaths,
        callbacks: createStewardWorkflowCallbacks({
          options,
          broadcast,
          sessionId: session.sessionId,
        }),
        sessionId: session.sessionId,
        project: target.projectId,
        message: target.message || body.message,
      }).catch(() => {
        // Keep the request path fast; background session updates are best-effort.
      });

      return jsonOk({
        accepted: true,
        sessionId: session.sessionId,
        project: target.projectId,
      });
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/console/new": async (_req, _url, options, _broadcast) => {
    try {
      const sessionsDir = join(options.hivePaths.home, "sessions");
      await mkdir(sessionsDir, { recursive: true });
      const activeProject = await getActiveProject(options.hivePaths);
      const session = await createGatewaySession({
        options,
        project: activeProject || "default",
      });
      void primeGatewayPersistentStewardSession({
        options,
        sessionId: session.sessionId,
      }).catch(() => {
        // Warm the persistent steward session without blocking request handling.
      });

      scheduleProjectRuntimeRefresh({
        hivePaths: options.hivePaths,
        projectId: session.project,
      });

      return jsonOk({ sessionId: session.sessionId, project: session.project });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/steward/wake": async (req, _url, options, broadcast) => {
    try {
      const body = await req.json() as { message?: string; project?: string };
      const message = body.message?.trim();

      if (!message) {
        return jsonError(400, "Missing 'message' field");
      }

      const targetProject =
        body.project?.trim() ||
        (await getActiveProject(options.hivePaths)) ||
        "default";
      const target = await ensureGatewayWakeSession({
        options,
        requestedProject: targetProject,
      });
      const sessionsDir = join(options.hivePaths.home, "sessions");

      await appendTurn({
        sessionsDir,
        sessionId: target.sessionId,
        role: "human",
        content: message,
        source: "system",
      });

      scheduleProjectRuntimeRefresh({
        hivePaths: options.hivePaths,
        projectId: target.projectId,
      });

      void continueStewardConsoleWorkflow({
        hivePaths: options.hivePaths,
        callbacks: createStewardWorkflowCallbacks({
          options,
          broadcast,
          sessionId: target.sessionId,
        }),
        sessionId: target.sessionId,
        project: target.projectId,
        message,
        origin: "system-wake",
      }).catch(() => {
        // Keep the wake path non-blocking; the periodic supervisor pass can retry if needed.
      });

      return jsonOk({
        accepted: true,
        sessionId: target.sessionId,
        project: target.projectId,
      });
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }

      if (err instanceof UsageError) {
        return jsonError(400, err.message);
      }

      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/supervisor/restart": async (req, _url, options, _broadcast) => {
    try {
      let intervalSeconds = DEFAULT_SUPERVISOR_INTERVAL_SECONDS;
      let maxParallel = DEFAULT_MAX_PARALLEL;
      const rawBody = await req.text();

      if (rawBody.trim()) {
        let body: { intervalSeconds?: unknown; maxParallel?: unknown };

        try {
          body = JSON.parse(rawBody) as { intervalSeconds?: unknown; maxParallel?: unknown };
        } catch {
          return jsonError(400, "Invalid JSON body");
        }

        intervalSeconds =
          toPositiveInteger(body.intervalSeconds) ?? DEFAULT_SUPERVISOR_INTERVAL_SECONDS;
        maxParallel = toPositiveInteger(body.maxParallel) ?? DEFAULT_MAX_PARALLEL;
      }

      const activeProject = await getActiveProject(options.hivePaths);
      if (!activeProject) {
        return jsonError(400, "No active project");
      }
      const managed = await restartManagedGatewaySupervisor({
        hivePaths: options.hivePaths,
        projectId: activeProject,
        intervalSeconds,
        maxParallel,
      });

      if (managed) {
        return jsonOk({
          message: `Supervisor restarted (pid ${managed.pid ?? "unknown"})`,
          pid: managed.pid,
        });
      }

      const projectPaths = getProjectPaths(options.hivePaths, activeProject);
      const existing = await reconcileDetachedSupervisorState(projectPaths);
      if (existing?.status === "active" && existing.pid && isProcessAlive(existing.pid)) {
        try {
          process.kill(existing.pid, "SIGTERM");
          await Bun.sleep(1_000);
          if (isProcessAlive(existing.pid)) {
            process.kill(existing.pid, "SIGKILL");
          }
        } catch {
          // process already dead
        }
      }

      const state = await startDetachedSupervisor({
        projectPaths,
        projectId: activeProject,
        intervalSeconds,
        maxParallel,
      });

      return jsonOk({
        message: `Supervisor restarted (pid ${state.pid ?? "unknown"})`,
        pid: state.pid,
      });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/stop": async (req, _url, options, _broadcast) => {
    try {
      const body = await req.json() as { target?: string };
      const target = body.target?.trim();

      if (!target) {
        return jsonError(400, "Missing 'target' field (agent ID or run ID)");
      }

      const activeProject = await getActiveProject(options.hivePaths);
      if (!activeProject) {
        return jsonError(400, "No active project");
      }

      const projectPaths = getProjectPaths(options.hivePaths, activeProject);

      // Handle steward/console abort
      if (target === "steward" || target === "console") {
        const sessionsDir = join(options.hivePaths.home, "sessions");
        const session = await getActiveSession(sessionsDir);
        if (session && isPersistentStewardTurnActive({ hivePaths: options.hivePaths, sessionId: session.sessionId })) {
          const aborted = await abortPersistentStewardTurn({ hivePaths: options.hivePaths, sessionId: session.sessionId });
          if (aborted) {
            return jsonOk({ ok: true, message: `Aborted active steward turn for session ${session.sessionId}` });
          }
        }
        // Fall through to try matching a run
      }

      await reconcileActiveConsoleRun(projectPaths);
      const activeRuns = await listActiveRuns(projectPaths);

      const matches = activeRuns.filter(
        (run) =>
          run.agentId === target ||
          run.runId === target ||
          run.runId.startsWith(target),
      );

      if (matches.length !== 1) {
        return jsonOk({ ok: false, error: `No unique active run matched '${target}'. Found ${matches.length} matches.` });
      }

      const run = matches[0]!;

      if (!run.pid) {
        return jsonOk({ ok: false, error: `Run ${run.runId} does not have a live pid to stop.` });
      }

      if (run.source === "console") {
        return jsonOk({ ok: false, error: `Console session is interactive — exit from within the session. (${run.runId})` });
      }

      await markRunStopRequested(run, "human");
      process.kill(run.pid, "SIGTERM");

      await appendFeedEntry(options.hivePaths, {
        project: activeProject,
        headline: `Stop requested for ${run.agentId}`,
        details: [`run: ${run.runId}`, `pid: ${run.pid}`],
      });
      await appendLogEntry(
        projectPaths.log,
        "human → gateway stop",
        `Requested stop for ${run.agentId} (${run.runId}) pid ${run.pid}`,
      );

      return jsonOk({ ok: true, message: `Signaled ${run.agentId} (${run.runId}) pid ${run.pid}` });
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/stop-all": async (_req, _url, options, _broadcast) => {
    try {
      const activeProject = await getActiveProject(options.hivePaths);
      if (!activeProject) {
        return jsonError(400, "No active project");
      }

      const projectPaths = getProjectPaths(options.hivePaths, activeProject);

      // Abort persistent steward turn if active
      const sessionsDir = join(options.hivePaths.home, "sessions");
      const session = await getActiveSession(sessionsDir);
      let stewardAborted = false;
      if (session && isPersistentStewardTurnActive({ hivePaths: options.hivePaths, sessionId: session.sessionId })) {
        stewardAborted = await abortPersistentStewardTurn({ hivePaths: options.hivePaths, sessionId: session.sessionId });
      }

      await reconcileActiveConsoleRun(projectPaths);
      const activeRuns = await listActiveRuns(projectPaths);

      const results: Array<{ agentId: string; runId: string; ok: boolean; message: string }> = [];

      for (const run of activeRuns) {
        if (!run.pid || run.source === "console") {
          results.push({ agentId: run.agentId, runId: run.runId, ok: false, message: "Skipped (console or no pid)" });
          continue;
        }

        try {
          await markRunStopRequested(run, "human");
          process.kill(run.pid, "SIGTERM");
          results.push({ agentId: run.agentId, runId: run.runId, ok: true, message: `Signaled pid ${run.pid}` });
        } catch (stopErr) {
          results.push({ agentId: run.agentId, runId: run.runId, ok: false, message: stopErr instanceof Error ? stopErr.message : "Unknown error" });
        }
      }

      const stoppedCount = results.filter((r) => r.ok).length;

      if (stoppedCount > 0 || stewardAborted) {
        await appendFeedEntry(options.hivePaths, {
          project: activeProject,
          headline: `Emergency stop: ${stoppedCount} agent(s) signaled${stewardAborted ? ", steward aborted" : ""}`,
          details: results.map((r) => `${r.agentId}: ${r.message}`),
        });
        await appendLogEntry(
          projectPaths.log,
          "human → gateway stop-all",
          `Emergency stop: ${stoppedCount} agent(s) signaled${stewardAborted ? ", steward aborted" : ""}`,
        );
      }

      return jsonOk({
        ok: true,
        message: `Stopped ${stoppedCount} agent(s)${stewardAborted ? ", aborted steward" : ""}`,
        results,
        stewardAborted,
      });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/nudge": async (req, _url, _options, _broadcast) => {
    try {
      const body = await req.json() as { message?: string };
      if (!body.message) {
        return jsonError(400, "Missing 'message' field in request body");
      }
      const result = await nudgeCommand([body.message]);
      return jsonOk(result);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/msg": async (req, _url, _options, _broadcast) => {
    try {
      const body = await req.json() as { type?: string; from?: string; to?: string; body?: string };
      if (!body.from || !body.to || !body.body) {
        return jsonError(400, "Missing required fields: 'from', 'to', 'body'");
      }
      const args: string[] = [];
      if (body.type) {
        args.push("--type", body.type);
      }
      args.push(body.from, body.to, body.body);
      const result = await msgCommand(args);
      return jsonOk(result);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/log": async (req, _url, _options, _broadcast) => {
    try {
      const body = await req.json() as { message?: string };
      if (!body.message) {
        return jsonError(400, "Missing 'message' field in request body");
      }
      const result = await logCommand([body.message]);
      return jsonOk(result);
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/open": async (req, _url, _options, _broadcast) => {
    try {
      const body = await req.json() as { path?: string; line?: number | string | null };
      const path = body.path?.trim();

      if (!path) {
        return jsonError(400, "Missing 'path' field");
      }

      const result = await openLocalPath({
        path,
        line: toPositiveInteger(body.line),
      });

      return jsonOk({
        ok: true,
        strategy: result.strategy,
      });
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      if (err instanceof UsageError) {
        return jsonError(400, err.message);
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },
};

function matchInboxRoute(pathname: string): string | null {
  const match = pathname.match(/^\/api\/inbox(?:\/([^/]+))?$/);
  if (!match) return null;
  return match[1] ?? "";
}

function matchSessionsRoute(pathname: string): string | null {
  const match = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (!match) return null;
  return match[1];
}

export async function handleApi(
  req: Request,
  url: URL,
  options: GatewayOptions,
  broadcast: GatewayBroadcast,
): Promise<Response> {
  const pathname = url.pathname;

  if (req.method === "GET") {
    const inboxAgent = matchInboxRoute(pathname);
    if (inboxAgent !== null) {
      try {
        const args = inboxAgent ? [inboxAgent] : [];
        const result = await inboxCommand(args);
        return jsonOk(result);
      } catch (err) {
        return jsonError(500, err instanceof Error ? err.message : "Unknown error");
      }
    }

    const sessionId = matchSessionsRoute(pathname);
    if (sessionId !== null) {
      try {
        const sessionsDir = join(options.hivePaths.home, "sessions");
        const session = await getSession(sessionsDir, sessionId);
        if (!session) {
          return jsonError(404, `Session not found: ${sessionId}`);
        }
        const turns = await getSessionHistory(sessionsDir, sessionId);
        const currentProject = await getSessionProjectFocus({
          sessionsDir,
          sessionId,
          fallbackProject: session.project,
        });
        return jsonOk({
          session: {
            ...session,
            currentProject,
          },
          turns,
        });
      } catch (err) {
        return jsonError(500, err instanceof Error ? err.message : "Unknown error");
      }
    }

    const handler = getRoutes[pathname];
    if (handler) {
      return handler(req, url, options, broadcast);
    }
  }

  if (req.method === "POST") {
    const handler = postRoutes[pathname];
    if (handler) {
      return handler(req, url, options, broadcast);
    }
  }

  return jsonError(404, `Unknown API endpoint: ${req.method} ${pathname}`);
}
