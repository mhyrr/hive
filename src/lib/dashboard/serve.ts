/**
 * HIVE dashboard server.
 *
 * Bun.serve bound to 127.0.0.1 only. No framework, no middleware.
 *
 * Routes:
 *   GET  /                      → full interactive dashboard
 *   GET  /archive/:date         → frozen HTML snapshot for a day
 *   GET  /fragment/:name        → one section, fresh data, for optimistic swap
 *   POST /action/:kind/:verb    → run an action, return { ok, message }
 *
 * Security posture: localhost-only server + Origin check for POSTs.
 * Action handlers either shell out to the `hive` CLI via argv
 * (never a shell string) or perform small file writes through
 * allowlisted helpers in actions.ts. No evals, no shell interpolation.
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

import type { HivePaths } from "../paths";
import {
  actionTicketCreate,
  actionTicketStart,
  actionTicketClose,
  actionTicketReopen,
  actionTicketNote,
  actionTicketTagDispatch,
  actionTicketDispatchRun,
  actionDispatch,
  actionDispatchKill,
  actionMemoryPromote,
  actionOverrideStatus,
  actionInboxAck,
  actionIdentityPropose,
  actionReflectionDismiss,
  type ArgvBuild,
} from "./actions";
import { resolveHiveBin, HiveBinNotFoundError } from "./hive-bin";
import { renderDashboard, renderTicketsPageDocument } from "./render";
import { collectDashboardData, collectTicketsPage } from "./collect";
import {
  archivePathForDate,
  isValidArchiveDate,
} from "./archive";
import {
  renderFragment,
  isValidFragmentName,
} from "./fragments";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export type ServeOptions = {
  paths: HivePaths;
  port?: number;
  /**
   * For tests: inject a fake CLI runner so we don't actually spawn `hive`.
   * Must mirror the `runCli` signature.
   */
  runCli?: CliRunner;
};

export const DEFAULT_PORT = 7777;

/** Start a Bun server. Returns the server instance for lifecycle control. */
export function startDashboardServer(opts: ServeOptions): {
  server: ReturnType<typeof Bun.serve>;
  port: number;
} {
  const port = opts.port ?? Number(process.env.HIVE_DASHBOARD_PORT ?? DEFAULT_PORT);
  const runCli = opts.runCli ?? defaultCliRunner;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req) {
      return handleRequest(req, { paths: opts.paths, runCli, port: server.port });
    },
  });

  return { server, port: server.port };
}

// ---------------------------------------------------------------------------
// Request handling — exposed for tests
// ---------------------------------------------------------------------------

export type RequestCtx = {
  paths: HivePaths;
  runCli: CliRunner;
  port: number;
};

export async function handleRequest(req: Request, rctx: RequestCtx): Promise<Response> {
  const url = new URL(req.url);

  // Origin check applies to every mutating request.
  if (req.method === "POST") {
    const origin = req.headers.get("origin");
    if (!isAllowedOrigin(origin, rctx.port)) {
      return json({ ok: false, error: "forbidden origin" }, 403);
    }
  }

  try {
    if (req.method === "GET" && url.pathname === "/") {
      return serveRoot(rctx);
    }
    if (req.method === "GET" && url.pathname === "/tickets") {
      return serveTicketsPage(rctx);
    }
    if (req.method === "GET" && url.pathname.startsWith("/archive/")) {
      return serveArchive(rctx, url.pathname.slice("/archive/".length));
    }
    if (req.method === "GET" && url.pathname.startsWith("/fragment/")) {
      return serveFragmentRoute(rctx, url.pathname.slice("/fragment/".length));
    }
    if (req.method === "POST" && url.pathname.startsWith("/action/")) {
      return serveAction(rctx, url.pathname.slice("/action/".length), req);
    }
    return new Response("not found", { status: 404 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: message }, 500);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function serveRoot(rctx: RequestCtx): Promise<Response> {
  const data = await collectDashboardData(rctx.paths);
  const html = renderDashboard(data, { interactive: true });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function serveTicketsPage(rctx: RequestCtx): Promise<Response> {
  const data = await collectTicketsPage(rctx.paths);
  const html = renderTicketsPageDocument(data, { interactive: true });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function serveArchive(rctx: RequestCtx, date: string): Promise<Response> {
  if (!isValidArchiveDate(date)) {
    return new Response("bad request", { status: 400 });
  }
  const path = archivePathForDate(rctx.paths, date);
  if (!existsSync(path)) {
    return new Response("not found", { status: 404 });
  }
  const html = await readFile(path, "utf-8");
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function serveFragmentRoute(rctx: RequestCtx, name: string): Promise<Response> {
  if (!isValidFragmentName(name)) {
    return json({ ok: false, error: "unknown fragment" }, 404);
  }
  const html = await renderFragment(rctx.paths, name);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function serveAction(rctx: RequestCtx, rest: string, req: Request): Promise<Response> {
  const body = await safeReadJson(req);
  if (body == null) {
    return json({ ok: false, error: "malformed body" }, 400);
  }

  try {
    const result = await dispatchAction(rctx, rest, body);
    return json({ ok: true, ...result });
  } catch (err: unknown) {
    if (err instanceof UnknownActionError) {
      return json({ ok: false, error: err.message }, 404);
    }
    if (err instanceof BadInputError) {
      return json({ ok: false, error: err.message }, 400);
    }
    if (err instanceof HiveBinNotFoundError) {
      return json({ ok: false, error: err.message }, 500);
    }
    const message = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: message }, 500);
  }
}

/**
 * Dispatch a single action. Split out so tests can target it directly.
 */
export async function dispatchAction(
  rctx: RequestCtx,
  path: string,
  body: any,
): Promise<{ message: string; refreshedSection?: string; stdout?: string }> {
  const safe = (): any => body ?? {};
  switch (path) {
    // ----- CLI-backed ticket actions -----
    case "ticket/create": {
      const build = wrap(() => actionTicketCreate(safe()));
      await runCliOrFail(rctx, build);
      return { message: "ticket created", refreshedSection: "tickets" };
    }
    case "ticket/start": {
      const build = wrap(() => actionTicketStart(safe()));
      await runCliOrFail(rctx, build);
      return { message: `${body.id} started`, refreshedSection: "tickets" };
    }
    case "ticket/close": {
      const build = wrap(() => actionTicketClose(safe()));
      await runCliOrFail(rctx, build);
      return { message: `${body.id} closed`, refreshedSection: "tickets" };
    }
    case "ticket/reopen": {
      const build = wrap(() => actionTicketReopen(safe()));
      await runCliOrFail(rctx, build);
      return { message: `${body.id} reopened`, refreshedSection: "tickets" };
    }
    case "ticket/note": {
      const build = wrap(() => actionTicketNote(safe()));
      await runCliOrFail(rctx, build);
      return { message: `note added to ${body.id}`, refreshedSection: "tickets" };
    }
    case "ticket/tag-dispatch": {
      const build = wrap(() => actionTicketTagDispatch(safe()));
      await runCliOrFail(rctx, build);
      return { message: `${body.id} tagged auto-dispatch`, refreshedSection: "tickets" };
    }
    case "ticket/dispatch-run": {
      const build = wrap(() => actionTicketDispatchRun(safe()));
      await runCliOrFail(rctx, build);
      return { message: `dispatched ${body.id}`, refreshedSection: "runs" };
    }
    // ----- CLI-backed dispatch/memory -----
    case "dispatch": {
      const build = wrap(() => actionDispatch(safe()));
      await runCliOrFail(rctx, build);
      return { message: "dispatched", refreshedSection: "runs" };
    }
    case "dispatch/kill": {
      const build = wrap(() => actionDispatchKill(safe()));
      await runCliOrFail(rctx, build);
      return { message: `killed ${body.runId}`, refreshedSection: "runs" };
    }
    case "memory/promote": {
      const build = wrap(() => actionMemoryPromote(safe()));
      await runCliOrFail(rctx, build);
      return { message: "promoted to memory" };
    }
    // ----- Direct-file actions -----
    case "dispatch/override-status": {
      await wrapAsync(() => actionOverrideStatus(rctx.paths, safe()));
      return { message: `${body.runId} → ${body.status}`, refreshedSection: "runs" };
    }
    case "inbox/ack": {
      await wrapAsync(() => actionInboxAck(rctx.paths, safe()));
      return { message: `acknowledged`, refreshedSection: "inboxes" };
    }
    case "identity/propose": {
      const { path } = await wrapAsync(() =>
        actionIdentityPropose(rctx.paths, safe()),
      );
      return { message: `proposal filed at ${path}` };
    }
    case "reflection/dismiss": {
      await wrapAsync(() => actionReflectionDismiss(rctx.paths, safe()));
      return { message: "reflection hidden" };
    }
  }
  throw new UnknownActionError(`unknown action: ${path}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isAllowedOrigin(origin: string | null, port: number): boolean {
  if (!origin) return false;
  const expected = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ];
  return expected.includes(origin);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function safeReadJson(req: Request): Promise<any | null> {
  try {
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
}

class UnknownActionError extends Error {
  constructor(m: string) { super(m); this.name = "UnknownActionError"; }
}
class BadInputError extends Error {
  constructor(m: string) { super(m); this.name = "BadInputError"; }
}

function wrap(fn: () => ArgvBuild): ArgvBuild {
  try {
    return fn();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BadInputError(message);
  }
}

async function wrapAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BadInputError(message);
  }
}

async function runCliOrFail(rctx: RequestCtx, build: ArgvBuild): Promise<void> {
  const result = await rctx.runCli(build.argv);
  if (result.exitCode !== 0) {
    throw new Error(
      `hive CLI exited ${result.exitCode}${result.stderr ? `: ${result.stderr.trim()}` : ""}`,
    );
  }
}

// ---------------------------------------------------------------------------
// CLI runner — isolated so tests can inject
// ---------------------------------------------------------------------------

export type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type CliRunner = (argv: string[]) => Promise<CliResult>;

/**
 * Default: spawn the `hive` binary as argv. Never constructs a shell
 * string, so user-controlled input can't break out of the argv layer.
 */
const defaultCliRunner: CliRunner = async (argv) => {
  const bin = resolveHiveBin();

  return await new Promise<CliResult>((resolve) => {
    const child = spawn(bin, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b) => { stdout += b.toString("utf-8"); });
    child.stderr?.on("data", (b) => { stderr += b.toString("utf-8"); });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    child.on("error", (err) => {
      resolve({ exitCode: -1, stdout, stderr: stderr + String(err) });
    });
  });
};

export const __test = { runCliOrFail, wrap, wrapAsync };
