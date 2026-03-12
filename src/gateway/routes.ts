import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { GatewayBroadcast, GatewayOptions } from "./server";

import { feedCommand } from "../commands/feed";
import { inboxCommand } from "../commands/inbox";
import { logCommand } from "../commands/log";
import { msgCommand, nudgeCommand } from "../commands/msg";
import { psCommand } from "../commands/ps";
import { sayCommand, sendGoalToProject } from "../commands/say";
import { statusCommand } from "../commands/status";
import { listOpenProjectMessages } from "../lib/messages";
import { getActiveProject, getProjectPaths, listProjects } from "../lib/paths";
import { runtimesCommand } from "../commands/runtimes";
import { getRunOutputPath, listActiveRuns, listRecentRunResults, type RunRecord } from "../lib/runs";
import {
  reconcileDetachedSupervisorState,
  startDetachedSupervisor,
} from "../lib/detached-supervisor";
import { isProcessAlive, DEFAULT_MAX_PARALLEL, DEFAULT_SUPERVISOR_INTERVAL_SECONDS } from "../lib/supervisor";
import {
  createSession,
  getActiveSession,
  getSessionHistory,
  listSessions,
  getSession,
  appendTurn,
} from "../lib/sessions";

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

export function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

async function appendSessionTurnAndBroadcast(input: {
  options: GatewayOptions;
  broadcast: GatewayBroadcast;
  sessionId: string;
  project: string;
  role: "human" | "assistant";
  content: string;
}): Promise<void> {
  const sessionsDir = join(input.options.hivePaths.home, "sessions");

  await appendTurn({
    sessionsDir,
    sessionId: input.sessionId,
    role: input.role,
    content: input.content,
  });

  input.broadcast({
    type: "session-message",
    ts: new Date().toISOString(),
    project: input.project,
    data: {
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
    },
  });
}

function buildImmediateConsoleAck(message: string): string {
  const firstLine = message.trim().split("\n")[0] ?? "";

  return `Heard. I'm on it.\n\nFirst step: check the live board, active runs, and open messages, then decide whether this needs direct guidance, a board change, or new assignments.\n\nFocus: ${firstLine}`;
}

function joinNaturalList(items: string[]): string {
  if (items.length === 0) {
    return "";
  }

  if (items.length === 1) {
    return items[0]!;
  }

  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }

  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

async function readRunOutputUpdate(
  run: RunRecord,
  seenLength: number,
): Promise<{ nextLength: number; content: string | null }> {
  const file = Bun.file(getRunOutputPath(run));

  if (!(await file.exists())) {
    return {
      nextLength: seenLength,
      content: null,
    };
  }

  const raw = (await file.text()).replace(/\r\n/g, "\n");

  if (raw.length <= seenLength) {
    return {
      nextLength: raw.length,
      content: null,
    };
  }

  const delta = raw.slice(seenLength).trim();

  return {
    nextLength: raw.length,
    content: delta || null,
  };
}

async function continueConsoleWorkflow(input: {
  options: GatewayOptions;
  broadcast: GatewayBroadcast;
  sessionId: string;
  project: string;
  message: string;
}): Promise<void> {
  const firedAt = new Date().toISOString();

  try {
    const sayResult = await sendGoalToProject({
      projectId: input.project,
      message: input.message,
      paths: input.options.hivePaths,
    });
    const supervisorLine =
      sayResult.split("\n").find((line) => /Supervisor/i.test(line)) ??
      "Supervisor state updated.";

    await appendSessionTurnAndBroadcast({
      options: input.options,
      broadcast: input.broadcast,
      sessionId: input.sessionId,
      project: input.project,
      role: "assistant",
      content: `${supervisorLine}\n\nI'm reviewing the current state and I'll keep this session updated as work gets assigned or completed.`,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    await appendSessionTurnAndBroadcast({
      options: input.options,
      broadcast: input.broadcast,
      sessionId: input.sessionId,
      project: input.project,
      role: "assistant",
      content: `I couldn't hand this off cleanly: ${errorMessage}`,
    });
    return;
  }

  if (!input.project || input.project === "default") {
    return;
  }

  const projectPaths = getProjectPaths(input.options.hivePaths, input.project);
  const announcedAssignmentFiles = new Set<string>();
  const announcedWorkerRuns = new Set<string>();
  const outputOffsets = new Map<string, number>();
  let announcedOrchestratorRun = false;
  let streamedOrchestratorOutput = "";
  const deadline = Date.now() + 180_000;

  while (Date.now() < deadline) {
    const [activeRuns, openMessages, recentResults] = await Promise.all([
      listActiveRuns(projectPaths),
      listOpenProjectMessages(input.options.hivePaths.msgDir, input.project),
      listRecentRunResults(projectPaths, 10),
    ]);

    const orchestratorRun = activeRuns.find(
      (run) => run.agentId === "orchestrator" && run.started >= firedAt,
    );

    if (orchestratorRun && !announcedOrchestratorRun) {
      announcedOrchestratorRun = true;
      await appendSessionTurnAndBroadcast({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        role: "assistant",
        content: "I'm actively assessing the board, open messages, and recent run results now.",
      });
    }

    for (const run of activeRuns.filter((entry) => entry.started >= firedAt)) {
      const seenLength = outputOffsets.get(run.runId) ?? 0;
      const update = await readRunOutputUpdate(run, seenLength);
      outputOffsets.set(run.runId, update.nextLength);

      if (!update.content) {
        continue;
      }

      if (run.agentId === "orchestrator") {
        streamedOrchestratorOutput = streamedOrchestratorOutput
          ? `${streamedOrchestratorOutput}\n${update.content.trim()}`
          : update.content.trim();
        await appendSessionTurnAndBroadcast({
          options: input.options,
          broadcast: input.broadcast,
          sessionId: input.sessionId,
          project: input.project,
          role: "assistant",
          content: update.content.trim(),
        });
        continue;
      }

      const label = run.taskId ? `${run.agentId} (${run.taskId})` : run.agentId;
      await appendSessionTurnAndBroadcast({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        role: "assistant",
        content: `[${label}] ${update.content.trim()}`,
      });
    }

    const freshAssignments = openMessages.filter(
      (message) =>
        message.attributes.type === "assign" &&
        (message.attributes.ts ?? "") >= firedAt &&
        !announcedAssignmentFiles.has(message.filename),
    );

    if (freshAssignments.length > 0) {
      for (const message of freshAssignments) {
        announcedAssignmentFiles.add(message.filename);
      }

      const recipients = [
        ...new Set(freshAssignments.map((message) => message.attributes.to ?? "unknown")),
      ];
      const tasks = [
        ...new Set(
          freshAssignments
            .map((message) => message.attributes.task)
            .filter((task): task is string => Boolean(task)),
        ),
      ];
      const taskSummary = tasks.length > 0 ? ` for ${joinNaturalList(tasks)}` : "";

      await appendSessionTurnAndBroadcast({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        role: "assistant",
        content: `I handed work to ${joinNaturalList(recipients)}${taskSummary}.`,
      });
    }

    const freshWorkerRuns = activeRuns.filter(
      (run) =>
        run.agentId !== "orchestrator" &&
        run.agentId !== "console" &&
        run.started >= firedAt &&
        !announcedWorkerRuns.has(run.runId),
    );

    if (freshWorkerRuns.length > 0) {
      for (const run of freshWorkerRuns) {
        announcedWorkerRuns.add(run.runId);
      }

      const workers = freshWorkerRuns.map((run) =>
        run.taskId ? `${run.agentId} on ${run.taskId}` : run.agentId,
      );

      await appendSessionTurnAndBroadcast({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        role: "assistant",
        content: `Active now: ${joinNaturalList(workers)}.`,
      });
    }

    const finalResult = recentResults.find(
      (result) =>
        result.agentId === "orchestrator" &&
        result.ended >= firedAt &&
        result.finalVisibleOutput.trim().length > 0,
    );

    if (finalResult) {
      const finalOutput = finalResult.finalVisibleOutput.trim();

      if (!finalOutput || finalOutput === streamedOrchestratorOutput) {
        return;
      }

      await appendSessionTurnAndBroadcast({
        options: input.options,
        broadcast: input.broadcast,
        sessionId: input.sessionId,
        project: input.project,
        role: "assistant",
        content: finalOutput,
      });
      return;
    }

    await Bun.sleep(1_000);
  }

  await appendSessionTurnAndBroadcast({
    options: input.options,
    broadcast: input.broadcast,
    sessionId: input.sessionId,
    project: input.project,
    role: "assistant",
    content: "This is still in motion. I’ll keep the board moving, and the next orchestration result will land here when it’s ready.",
  });
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
      return jsonOk(result);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
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

  "/api/runtimes": async (_req, _url, _options, _broadcast) => {
    try {
      const result = await runtimesCommand();
      return jsonOk(result);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/console/history": async (_req, _url, options, _broadcast) => {
    try {
      const sessionsDir = join(options.hivePaths.home, "sessions");
      const session = await getActiveSession(sessionsDir);
      if (!session) {
        return jsonOk({ turns: [], sessionId: null });
      }
      const turns = await getSessionHistory(sessionsDir, session.sessionId);
      return jsonOk({ turns, sessionId: session.sessionId });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/sessions": async (_req, _url, options, _broadcast) => {
    try {
      const sessionsDir = join(options.hivePaths.home, "sessions");
      const sessions = await listSessions(sessionsDir);
      return jsonOk({ sessions });
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
        session = await createSession({
          sessionsDir,
          project: activeProject || "default",
          runtime: "claude",
          model: null,
          systemPrompt: "HIVE console session",
        });
      }

      await appendTurn({
        sessionsDir,
        sessionId: session.sessionId,
        role: "human",
        content: body.message,
      });

      const result = buildImmediateConsoleAck(body.message);

      await appendTurn({
        sessionsDir,
        sessionId: session.sessionId,
        role: "assistant",
        content: result,
      });

      void continueConsoleWorkflow({
        options,
        broadcast,
        sessionId: session.sessionId,
        project: session.project,
        message: body.message,
      }).catch(() => {
        // Keep the request path fast; background session updates are best-effort.
      });

      return jsonOk({ result, sessionId: session.sessionId });
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
      const session = await createSession({
        sessionsDir,
        project: activeProject || "default",
        runtime: "claude",
        model: null,
        systemPrompt: "HIVE console session",
      });
      return jsonOk({ sessionId: session.sessionId });
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

      // Kill existing supervisor if alive
      const existing = await reconcileDetachedSupervisorState(projectPaths);
      if (existing?.status === "active" && existing.pid && isProcessAlive(existing.pid)) {
        try {
          process.kill(existing.pid, "SIGTERM");
          // Brief wait for graceful shutdown
          await Bun.sleep(1_000);
          if (isProcessAlive(existing.pid)) {
            process.kill(existing.pid, "SIGKILL");
          }
        } catch {
          // process already dead
        }
      }

      // Start fresh
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
    // Check inbox route with optional agent param
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

    // Check sessions/:id route
    const sessionId = matchSessionsRoute(pathname);
    if (sessionId !== null) {
      try {
        const sessionsDir = join(options.hivePaths.home, "sessions");
        const session = await getSession(sessionsDir, sessionId);
        if (!session) {
          return jsonError(404, `Session not found: ${sessionId}`);
        }
        const turns = await getSessionHistory(sessionsDir, sessionId);
        return jsonOk({ session, turns });
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
