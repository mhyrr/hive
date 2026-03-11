import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { GatewayOptions } from "./server";

import { feedCommand } from "../commands/feed";
import { inboxCommand } from "../commands/inbox";
import { logCommand } from "../commands/log";
import { msgCommand, nudgeCommand } from "../commands/msg";
import { psCommand } from "../commands/ps";
import { sayCommand } from "../commands/say";
import { statusCommand } from "../commands/status";
import { getActiveProject, listProjects } from "../lib/paths";
import { runtimesCommand } from "../commands/runtimes";
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

type RouteHandler = (req: Request, url: URL, options: GatewayOptions) => Promise<Response>;

const getRoutes: Record<string, RouteHandler> = {
  "/api/status": async () => {
    try {
      const result = await statusCommand();
      return jsonOk(result);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/feed": async (_req, url) => {
    try {
      const count = url.searchParams.get("count") ?? "20";
      const result = await feedCommand([count]);
      return jsonOk(result);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/ps": async () => {
    try {
      const result = await psCommand();
      return jsonOk(result);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/projects": async (_req, _url, options) => {
    try {
      const projects = await listProjects(options.hivePaths);
      return jsonOk({ projects });
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/runtimes": async () => {
    try {
      const result = await runtimesCommand();
      return jsonOk(result);
    } catch (err) {
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/console/history": async (_req, _url, options) => {
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

  "/api/sessions": async (_req, _url, options) => {
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
  "/api/say": async (req) => {
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

  "/api/console/send": async (req, _url, options) => {
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

      // Record human turn
      await appendTurn({
        sessionsDir,
        sessionId: session.sessionId,
        role: "human",
        content: body.message,
      });

      // Get hive response
      try {
        const result = await sayCommand([body.message]);

        // Record assistant turn
        await appendTurn({
          sessionsDir,
          sessionId: session.sessionId,
          role: "assistant",
          content: result,
        });

        return jsonOk({ result, sessionId: session.sessionId });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : "Unknown error";
        await appendTurn({
          sessionsDir,
          sessionId: session.sessionId,
          role: "assistant",
          content: `Error: ${errorMsg}`,
        });
        return jsonError(500, errorMsg);
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        return jsonError(400, "Invalid JSON body");
      }
      return jsonError(500, err instanceof Error ? err.message : "Unknown error");
    }
  },

  "/api/console/new": async (_req, _url, options) => {
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

  "/api/nudge": async (req) => {
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

  "/api/msg": async (req) => {
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

  "/api/log": async (req) => {
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

export async function handleApi(req: Request, url: URL, options: GatewayOptions): Promise<Response> {
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
      return handler(req, url, options);
    }
  }

  if (req.method === "POST") {
    const handler = postRoutes[pathname];
    if (handler) {
      return handler(req, url, options);
    }
  }

  return jsonError(404, `Unknown API endpoint: ${req.method} ${pathname}`);
}
