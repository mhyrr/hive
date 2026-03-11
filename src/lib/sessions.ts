import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";
import { now, toIsoTimestamp } from "./time";

export type SessionMeta = {
  sessionId: string;
  project: string;
  runtime: string;
  model: string | null;
  started: string;
  turns: number;
  lastActive: string;
  status: "active" | "archived";
};

export type SessionTurn = {
  role: "human" | "assistant";
  content: string;
  ts: string;
};

function generateSessionId(date: Date = now()): string {
  const iso = toIsoTimestamp(date);
  // YYYYMMDD-HHmmssZ from 2026-03-11T14:11:05Z
  return iso
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .replace(/Z$/, "Z");
}

function formatTimeOnly(date: Date = now()): string {
  const h = String(date.getUTCHours()).padStart(2, "0");
  const m = String(date.getUTCMinutes()).padStart(2, "0");
  const s = String(date.getUTCSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function metaToAttributes(meta: SessionMeta): Record<string, string> {
  const attrs: Record<string, string> = {
    session: meta.sessionId,
    project: meta.project,
    runtime: meta.runtime,
  };
  if (meta.model) {
    attrs.model = meta.model;
  }
  attrs.started = meta.started;
  attrs.turns = String(meta.turns);
  attrs["last-active"] = meta.lastActive;
  attrs.status = meta.status;
  return attrs;
}

function attributesToMeta(attrs: Record<string, string>): SessionMeta {
  return {
    sessionId: attrs.session ?? "",
    project: attrs.project ?? "default",
    runtime: attrs.runtime ?? "claude",
    model: attrs.model || null,
    started: attrs.started ?? "",
    turns: parseInt(attrs.turns ?? "0", 10),
    lastActive: attrs["last-active"] ?? attrs.started ?? "",
    status: (attrs.status as "active" | "archived") ?? "active",
  };
}

export function parseHistory(content: string): SessionTurn[] {
  const turns: SessionTurn[] = [];
  const regex = /^## (human|assistant) \(([^)]+)\)\n/gm;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let lastRole: string | null = null;
  let lastTs: string | null = null;

  while ((match = regex.exec(content)) !== null) {
    if (lastRole !== null && lastTs !== null) {
      const body = content.slice(lastIndex, match.index).trim();
      turns.push({
        role: lastRole as "human" | "assistant",
        content: body,
        ts: lastTs,
      });
    }
    lastRole = match[1];
    lastTs = match[2];
    lastIndex = match.index + match[0].length;
  }

  // Capture the last turn
  if (lastRole !== null && lastTs !== null) {
    const body = content.slice(lastIndex).trim();
    if (body) {
      turns.push({
        role: lastRole as "human" | "assistant",
        content: body,
        ts: lastTs,
      });
    }
  }

  return turns;
}

export async function createSession(input: {
  sessionsDir: string;
  project: string;
  runtime: string;
  model: string | null;
  systemPrompt: string;
}): Promise<SessionMeta> {
  const date = now();
  const sessionId = generateSessionId(date);
  const started = toIsoTimestamp(date);
  const sessionDir = join(input.sessionsDir, sessionId);

  await mkdir(sessionDir, { recursive: true });

  const meta: SessionMeta = {
    sessionId,
    project: input.project,
    runtime: input.runtime,
    model: input.model,
    started,
    turns: 0,
    lastActive: started,
    status: "active",
  };

  // Write meta.md
  await Bun.write(
    join(sessionDir, "meta.md"),
    stringifyFrontmatter(metaToAttributes(meta), ""),
  );

  // Write history.md
  await Bun.write(
    join(sessionDir, "history.md"),
    `# Session ${sessionId}\n`,
  );

  // Write prompt.md
  await Bun.write(join(sessionDir, "prompt.md"), `${input.systemPrompt}\n`);

  // Update active.md pointer
  await Bun.write(
    join(input.sessionsDir, "active.md"),
    stringifyFrontmatter(
      {
        session: sessionId,
        project: input.project,
        runtime: input.runtime,
        started,
      },
      "",
    ),
  );

  return meta;
}

export async function getActiveSession(
  sessionsDir: string,
): Promise<SessionMeta | null> {
  const activeFile = Bun.file(join(sessionsDir, "active.md"));

  if (!(await activeFile.exists())) {
    return null;
  }

  const content = await activeFile.text();
  const { attributes } = parseFrontmatter(content);
  const sessionId = attributes.session;

  if (!sessionId) {
    return null;
  }

  return getSession(sessionsDir, sessionId);
}

export async function listSessions(
  sessionsDir: string,
): Promise<SessionMeta[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;

  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sessions: SessionMeta[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const meta = await getSession(sessionsDir, entry.name);

    if (meta) {
      sessions.push(meta);
    }
  }

  return sessions.sort((a, b) => b.started.localeCompare(a.started));
}

export async function getSession(
  sessionsDir: string,
  sessionId: string,
): Promise<SessionMeta | null> {
  const metaFile = Bun.file(join(sessionsDir, sessionId, "meta.md"));

  if (!(await metaFile.exists())) {
    return null;
  }

  const content = await metaFile.text();
  const { attributes } = parseFrontmatter(content);

  return attributesToMeta(attributes);
}

export async function getSessionHistory(
  sessionsDir: string,
  sessionId: string,
): Promise<SessionTurn[]> {
  const historyFile = Bun.file(
    join(sessionsDir, sessionId, "history.md"),
  );

  if (!(await historyFile.exists())) {
    return [];
  }

  const content = await historyFile.text();

  return parseHistory(content);
}

export async function appendTurn(input: {
  sessionsDir: string;
  sessionId: string;
  role: "human" | "assistant";
  content: string;
}): Promise<void> {
  const date = now();
  const timeStr = formatTimeOnly(date);
  const sessionDir = join(input.sessionsDir, input.sessionId);
  const historyPath = join(sessionDir, "history.md");

  // Append to history.md
  const historyFile = Bun.file(historyPath);
  const existing = (await historyFile.exists()) ? await historyFile.text() : "";
  const appendText = `\n## ${input.role} (${timeStr})\n${input.content}\n`;
  await Bun.write(historyPath, existing + appendText);

  // Update meta.md: increment turns, update last-active
  const metaPath = join(sessionDir, "meta.md");
  const metaFile = Bun.file(metaPath);

  if (await metaFile.exists()) {
    const metaContent = await metaFile.text();
    const { attributes } = parseFrontmatter(metaContent);
    const currentTurns = parseInt(attributes.turns ?? "0", 10);
    attributes.turns = String(currentTurns + 1);
    attributes["last-active"] = toIsoTimestamp(date);
    await Bun.write(metaPath, stringifyFrontmatter(attributes, ""));
  }
}

export async function getSessionPrompt(
  sessionsDir: string,
  sessionId: string,
): Promise<string> {
  const promptFile = Bun.file(
    join(sessionsDir, sessionId, "prompt.md"),
  );

  if (!(await promptFile.exists())) {
    return "";
  }

  return (await promptFile.text()).trim();
}
