import { type Server, type ServerWebSocket } from "bun";
import { join } from "node:path";

import type { HivePaths } from "../lib/paths";

import { handleApi, handleOptions } from "./routes";
import { startWatcher } from "./watcher";

export type GatewayOptions = {
  port: number;
  hivePaths: HivePaths;
};

type GatewayState = {
  server: Server;
  clients: Set<ServerWebSocket<unknown>>;
  stopWatcher: () => void;
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function getMimeType(path: string): string {
  const ext = path.slice(path.lastIndexOf("."));
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

async function serveStatic(pathname: string): Promise<Response> {
  const staticDir = join(import.meta.dir, "static");
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(staticDir, safePath);

  // Prevent path traversal
  if (!filePath.startsWith(staticDir)) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders() });
  }

  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  }

  return new Response(file, {
    headers: {
      "Content-Type": getMimeType(filePath),
      ...corsHeaders(),
    },
  });
}

export function startGateway(options: GatewayOptions): GatewayState {
  const clients = new Set<ServerWebSocket<unknown>>();

  const broadcast = (event: { type: string; ts: string; project: string; data?: Record<string, unknown> }) => {
    const payload = JSON.stringify(event);
    for (const ws of clients) {
      try {
        ws.send(payload);
      } catch {
        clients.delete(ws);
      }
    }
  };

  const stopWatcher = startWatcher(
    {
      feed: options.hivePaths.feed,
      msgDir: options.hivePaths.msgDir,
      boardPath: "", // board is per-project, watcher is global
      runsActiveDir: "", // runs are per-project, watcher is global
    },
    broadcast,
  );

  const server = Bun.serve({
    port: options.port,
    fetch(req, server) {
      const url = new URL(req.url);

      // Handle CORS preflight
      if (req.method === "OPTIONS") {
        return handleOptions();
      }

      // WebSocket upgrade
      if (url.pathname === "/ws") {
        if (server.upgrade(req)) {
          return undefined;
        }
        return new Response("WebSocket upgrade failed", {
          status: 400,
          headers: corsHeaders(),
        });
      }

      // API routes
      if (url.pathname.startsWith("/api/")) {
        return handleApi(req, url, options);
      }

      // Static files
      return serveStatic(url.pathname);
    },
    websocket: {
      open(ws) {
        clients.add(ws);
        ws.send(JSON.stringify({
          type: "connected",
          ts: new Date().toISOString(),
          data: { message: "Connected to HIVE Gateway" },
        }));
      },
      close(ws) {
        clients.delete(ws);
      },
      message(ws, msg) {
        // Handle ping/pong keepalive
        if (msg === "ping") {
          ws.send("pong");
        }
      },
    },
  });

  return { server, clients, stopWatcher };
}

export function stopGateway(state: GatewayState): void {
  state.stopWatcher();
  for (const ws of state.clients) {
    try {
      ws.close(1000, "Gateway shutting down");
    } catch {
      // ignore
    }
  }
  state.clients.clear();
  state.server.stop(true);
}
