// Static asset resolution for the Gateway web UI.
//
// In dev mode (bun run bin/hive.ts), import.meta.dir is src/gateway/
// and static/ exists as a subdirectory.
//
// In compiled mode (./hive), import.meta.dir is the binary's directory.
// We search known relative paths from the binary to find the static dir.

import { join } from "node:path";
import { existsSync } from "node:fs";

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

function findStaticDir(): string | null {
  const candidates = [
    // Dev mode: import.meta.dir is src/gateway/
    join(import.meta.dir, "static"),
    // Compiled binary in project root: ./hive
    join(import.meta.dir, "src", "gateway", "static"),
    // Compiled binary run via PATH but cwd is project root
    join(process.cwd(), "src", "gateway", "static"),
  ];

  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) {
      return dir;
    }
  }
  return null;
}

const staticDir = findStaticDir();

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function serveStaticAsset(pathname: string): Promise<Response> {
  if (!staticDir) {
    return new Response("Static files not found. Run from the project root or dev mode.", {
      status: 500,
      headers: corsHeaders,
    });
  }

  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(staticDir, safePath);

  // Prevent path traversal
  if (!filePath.startsWith(staticDir)) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }

  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }

  return new Response(file, {
    headers: {
      "Content-Type": getMimeType(filePath),
      ...corsHeaders,
    },
  });
}
