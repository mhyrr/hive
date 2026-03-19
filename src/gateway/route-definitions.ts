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
import { parseStructuredFeedEntries } from "../lib/feed";
import { getActiveProject, getProjectPaths, listProjects } from "../lib/paths";
import {
  getRunOutputPath,
  listActiveRuns,
  readRunOutputTail,
} from "../lib/runs";
import {
  appendTurn,
  getActiveSession,
  getSession,
  getSessionHistory,
  listSessions,
} from "../lib/sessions";
import {
  DEFAULT_MAX_PARALLEL,
  DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
  isProcessAlive,
} from "../lib/supervisor";
import { continueConsoleWorkflow as continueStewardConsoleWorkflow } from "../lib/steward/workflow";
import type { GatewayBroadcast, GatewayOptions } from "./server";
import {
  createGatewaySession,
  createStewardWorkflowCallbacks,
  getSessionProjectFocus,
  resolveGatewayProjectFocus,
  resolveSessionTurnTarget,
  scheduleProjectRuntimeRefresh,
} from "./console";
import {
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

  "/api/cognition": async (_req, _url, options, _broadcast) => {
    try {
      const globalConfig = await readGatewayGlobalConfig(options);
      const sessionsDir = join(options.hivePaths.home, "sessions");
      const activeSession = await getActiveSession(sessionsDir);
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
      const usage = currentProject && currentProject !== "default"
        ? await refreshProjectCognitiveUsageSnapshot({
            hivePaths: options.hivePaths,
            projectId: currentProject,
            globalConfig,
          })
        : null;

      return jsonOk({
        policy: snapshot.policy,
        activeSession: snapshot.activeSession,
        activeLane: snapshot.activeLane,
        activeExecution: snapshot.activeExecution,
        defaultLane: snapshot.defaultLane,
        defaultExecution: snapshot.defaultExecution,
        tier1: snapshot.tier1,
        localModels: snapshot.localModels,
        usage,
        rendered: renderCognitiveRoutingInspectionSnapshot({
          snapshot,
          usage,
          configPath: options.hivePaths.config,
          skillsDir: options.hivePaths.skillsDir,
        }),
      });
    } catch (err) {
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

      scheduleProjectRuntimeRefresh({
        hivePaths: options.hivePaths,
        projectId: session.project,
      });

      return jsonOk({ sessionId: session.sessionId, project: session.project });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/supervisor/restart": async (_req, _url, options, _broadcast) => {
    try {
      const activeProject = await getActiveProject(options.hivePaths);
      if (!activeProject) {
        return jsonError(400, "No active project");
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
        intervalSeconds: DEFAULT_SUPERVISOR_INTERVAL_SECONDS,
        maxParallel: DEFAULT_MAX_PARALLEL,
      });

      return jsonOk({
        message: `Supervisor restarted (pid ${state.pid ?? "unknown"})`,
        pid: state.pid,
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
