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
  source: "human" | "system" | "model" | null;
  details: SessionTurnDetails | null;
};

export type SessionTurnDetails = {
  project: string | null;
  runId: string | null;
  runtime: string | null;
  model: string | null;
  authMode: "subscription" | "api" | "unknown" | null;
  durationMs: number | null;
  numTurns: number | null;
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  totalTokens: number | null;
  board: {
    taskCount: number;
    activeCount: number;
    doneCount: number;
    waitingCount: number;
    blockers: string[];
  } | null;
  messages: {
    openCount: number;
    pendingHumanMessages: number;
    pendingHumanReplies: number;
  } | null;
  runs: {
    activeCount: number;
  } | null;
  statusNotes?: string[] | null;
};

export type PendingSessionTurn = {
  projectId: string;
  content: string;
  ts: string;
};

export type SessionState = {
  currentProject: string;
  projectStates: Record<string, {
    lastRevisionSeen: number;
    lastRunId: string | null;
  }>;
  pendingTurns: PendingSessionTurn[];
  updatedAt: string;
};

type LegacySessionState = {
  project?: string;
  lastRevisionSeen?: number;
  lastRunId?: string | null;
  pendingTurns?: unknown;
  updatedAt?: string;
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

function normalizePendingSessionTurns(value: unknown): PendingSessionTurn[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const record = item as Record<string, unknown>;
      const projectId =
        typeof record.projectId === "string" && record.projectId.trim()
          ? record.projectId.trim()
          : null;
      const content =
        typeof record.content === "string" && record.content.trim()
          ? record.content.trim()
          : null;
      const ts =
        typeof record.ts === "string" && record.ts.trim()
          ? record.ts.trim()
          : toIsoTimestamp();

      if (!projectId || !content) {
        return null;
      }

      return {
        projectId,
        content,
        ts,
      };
    })
    .filter((item): item is PendingSessionTurn => Boolean(item))
    .sort((left, right) => left.ts.localeCompare(right.ts));
}

function normalizeSessionState(
  value: SessionState | LegacySessionState | null,
  fallbackProject = "default",
): SessionState {
  const currentProject =
    value && "currentProject" in value && typeof value.currentProject === "string" && value.currentProject.trim()
      ? value.currentProject
      : value && "project" in value && typeof value.project === "string" && value.project.trim()
        ? value.project
        : fallbackProject;

  if (value && "projectStates" in value && value.projectStates && typeof value.projectStates === "object") {
    return {
      currentProject,
      projectStates: Object.fromEntries(
        Object.entries(value.projectStates)
          .filter(([projectId]) => Boolean(projectId))
          .map(([projectId, projectState]) => [
            projectId,
            {
              lastRevisionSeen:
                typeof projectState?.lastRevisionSeen === "number" ? projectState.lastRevisionSeen : 0,
              lastRunId:
                typeof projectState?.lastRunId === "string" ? projectState.lastRunId : null,
            },
          ]),
      ),
      pendingTurns: normalizePendingSessionTurns(value.pendingTurns),
      updatedAt:
        typeof value.updatedAt === "string" && value.updatedAt.trim()
          ? value.updatedAt
          : toIsoTimestamp(),
    };
  }

  const legacy = value as LegacySessionState | null;

  return {
    currentProject,
    projectStates: {
      [currentProject]: {
        lastRevisionSeen: typeof legacy?.lastRevisionSeen === "number" ? legacy.lastRevisionSeen : 0,
        lastRunId: typeof legacy?.lastRunId === "string" ? legacy.lastRunId : null,
      },
    },
    pendingTurns: normalizePendingSessionTurns(legacy?.pendingTurns),
    updatedAt:
      typeof legacy?.updatedAt === "string" && legacy.updatedAt.trim()
        ? legacy.updatedAt
        : toIsoTimestamp(),
  };
}

function createInitialSessionState(project: string, updatedAt: string): SessionState {
  return {
    currentProject: project,
    projectStates: {
      [project]: {
        lastRevisionSeen: 0,
        lastRunId: null,
      },
    },
    pendingTurns: [],
    updatedAt,
  };
}

export function parseHistory(content: string): SessionTurn[] {
  const turns: SessionTurn[] = [];
  const regex = /^## (human|assistant)(?: \[(human|system|model)\])? \(([^)]+)\)\n/gm;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let lastRole: string | null = null;
  let lastSource: SessionTurn["source"] = null;
  let lastTs: string | null = null;

  while ((match = regex.exec(content)) !== null) {
    if (lastRole !== null && lastTs !== null) {
      const parsedTurn = parseTurnBody(content.slice(lastIndex, match.index).trim());
      turns.push({
        role: lastRole as "human" | "assistant",
        content: parsedTurn.content,
        ts: lastTs,
        source: lastSource,
        details: parsedTurn.details,
      });
    }
    lastRole = match[1];
    lastSource =
      (match[2] as SessionTurn["source"] | undefined) ??
      (match[1] === "human" ? "human" : null);
    lastTs = match[3];
    lastIndex = match.index + match[0].length;
  }

  // Capture the last turn
  if (lastRole !== null && lastTs !== null) {
    const parsedTurn = parseTurnBody(content.slice(lastIndex).trim());
    if (parsedTurn.content) {
      turns.push({
        role: lastRole as "human" | "assistant",
        content: parsedTurn.content,
        ts: lastTs,
        source: lastSource,
        details: parsedTurn.details,
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

  await Bun.write(
    join(sessionDir, "state.json"),
    `${JSON.stringify(createInitialSessionState(input.project, started), null, 2)}\n`,
  );

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
  source?: "human" | "system" | "model" | null;
  details?: SessionTurnDetails | null;
}): Promise<void> {
  const date = now();
  const timeStr = formatTimeOnly(date);
  const sessionDir = join(input.sessionsDir, input.sessionId);
  const historyPath = join(sessionDir, "history.md");

  // Append to history.md
  const historyFile = Bun.file(historyPath);
  const existing = (await historyFile.exists()) ? await historyFile.text() : "";
  const source = input.source ?? (input.role === "human" ? "human" : null);
  const sourceLabel = source && !(input.role === "human" && source === "human")
    ? ` [${source}]`
    : "";
  const detailsPrefix = input.details
    ? `<!-- turn-meta: ${JSON.stringify(input.details)} -->\n`
    : "";
  const appendText = `\n## ${input.role}${sourceLabel} (${timeStr})\n${detailsPrefix}${input.content}\n`;
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

function parseTurnBody(body: string): {
  content: string;
  details: SessionTurnDetails | null;
} {
  const metaMatch = body.match(/^<!-- turn-meta: (.+) -->\n?([\s\S]*)$/);

  if (!metaMatch) {
    return {
      content: body,
      details: null,
    };
  }

  try {
    const details = JSON.parse(metaMatch[1]!) as SessionTurnDetails;

    return {
      content: metaMatch[2]!.trim(),
      details,
    };
  } catch {
    return {
      content: body,
      details: null,
    };
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

export async function getSessionState(
  sessionsDir: string,
  sessionId: string,
): Promise<SessionState | null> {
  const stateFile = Bun.file(join(sessionsDir, sessionId, "state.json"));

  if (!(await stateFile.exists())) {
    return null;
  }

  try {
    return normalizeSessionState(await stateFile.json() as SessionState | LegacySessionState);
  } catch {
    return null;
  }
}

export async function writeSessionState(input: {
  sessionsDir: string;
  sessionId: string;
  state: SessionState;
}): Promise<void> {
  await Bun.write(
    join(input.sessionsDir, input.sessionId, "state.json"),
    `${JSON.stringify(input.state, null, 2)}\n`,
  );
}

export async function updateSessionState(input: {
  sessionsDir: string;
  sessionId: string;
  update: Partial<SessionState>;
}): Promise<SessionState> {
  const existing = normalizeSessionState(
    await getSessionState(input.sessionsDir, input.sessionId),
  );
  const next: SessionState = normalizeSessionState({
    ...existing,
    ...input.update,
    projectStates: {
      ...existing.projectStates,
      ...(input.update.projectStates ?? {}),
    },
    updatedAt: input.update.updatedAt ?? toIsoTimestamp(),
  }, existing.currentProject);

  await writeSessionState({
    sessionsDir: input.sessionsDir,
    sessionId: input.sessionId,
    state: next,
  });

  return next;
}

export async function updateSessionMeta(input: {
  sessionsDir: string;
  sessionId: string;
  project?: string;
  runtime?: string;
  model?: string | null;
  status?: SessionMeta["status"];
  lastActive?: string;
  turns?: number;
}): Promise<SessionMeta | null> {
  const meta = await getSession(input.sessionsDir, input.sessionId);

  if (!meta) {
    return null;
  }

  const next: SessionMeta = {
    ...meta,
    project: input.project ?? meta.project,
    runtime: input.runtime ?? meta.runtime,
    model: input.model !== undefined ? input.model : meta.model,
    status: input.status ?? meta.status,
    lastActive: input.lastActive ?? meta.lastActive,
    turns: input.turns ?? meta.turns,
  };

  await Bun.write(
    join(input.sessionsDir, input.sessionId, "meta.md"),
    stringifyFrontmatter(metaToAttributes(next), ""),
  );

  const active = await getActiveSession(input.sessionsDir);

  if (active?.sessionId === input.sessionId) {
    await Bun.write(
      join(input.sessionsDir, "active.md"),
      stringifyFrontmatter(
        {
          session: input.sessionId,
          project: next.project,
          runtime: next.runtime,
          started: next.started,
        },
        "",
      ),
    );
  }

  return next;
}

export function getProjectSessionState(
  state: SessionState | null,
  projectId: string,
): { lastRevisionSeen: number; lastRunId: string | null } {
  return state?.projectStates[projectId] ?? {
    lastRevisionSeen: 0,
    lastRunId: null,
  };
}

export function getPendingSessionTurns(
  state: SessionState | null,
  projectId?: string | null,
): PendingSessionTurn[] {
  const pending = state?.pendingTurns ?? [];

  if (!projectId) {
    return pending;
  }

  return pending.filter((item) => item.projectId === projectId);
}

export async function switchSessionProject(input: {
  sessionsDir: string;
  sessionId: string;
  projectId: string;
}): Promise<SessionState> {
  const existing = normalizeSessionState(
    await getSessionState(input.sessionsDir, input.sessionId),
    input.projectId,
  );

  const next = await updateSessionState({
    sessionsDir: input.sessionsDir,
    sessionId: input.sessionId,
    update: {
      currentProject: input.projectId,
      projectStates: {
        ...existing.projectStates,
        [input.projectId]: existing.projectStates[input.projectId] ?? {
          lastRevisionSeen: 0,
          lastRunId: null,
        },
      },
      updatedAt: toIsoTimestamp(),
    },
  });
  await updateSessionMeta({
    sessionsDir: input.sessionsDir,
    sessionId: input.sessionId,
    project: input.projectId,
  });

  return next;
}

export async function updateSessionProjectState(input: {
  sessionsDir: string;
  sessionId: string;
  projectId: string;
  lastRevisionSeen?: number;
  lastRunId?: string | null;
}): Promise<SessionState> {
  const existing = normalizeSessionState(
    await getSessionState(input.sessionsDir, input.sessionId),
    input.projectId,
  );
  const current = existing.projectStates[input.projectId] ?? {
    lastRevisionSeen: 0,
    lastRunId: null,
  };

  return updateSessionState({
    sessionsDir: input.sessionsDir,
    sessionId: input.sessionId,
    update: {
      projectStates: {
        [input.projectId]: {
          lastRevisionSeen: input.lastRevisionSeen ?? current.lastRevisionSeen,
          lastRunId:
            input.lastRunId !== undefined ? input.lastRunId : current.lastRunId,
        },
      },
      updatedAt: toIsoTimestamp(),
    },
  });
}

export async function enqueuePendingSessionTurn(input: {
  sessionsDir: string;
  sessionId: string;
  projectId: string;
  content: string;
  ts?: string;
}): Promise<SessionState> {
  const content = input.content.trim();

  if (!content) {
    return normalizeSessionState(
      await getSessionState(input.sessionsDir, input.sessionId),
      input.projectId,
    );
  }

  const existing = normalizeSessionState(
    await getSessionState(input.sessionsDir, input.sessionId),
    input.projectId,
  );
  const ts = input.ts ?? toIsoTimestamp();

  return updateSessionState({
    sessionsDir: input.sessionsDir,
    sessionId: input.sessionId,
    update: {
      pendingTurns: [
        ...existing.pendingTurns,
        {
          projectId: input.projectId,
          content,
          ts,
        },
      ],
      updatedAt: ts,
    },
  });
}

export async function takePendingSessionTurns(input: {
  sessionsDir: string;
  sessionId: string;
  projectId: string;
  limit?: number;
}): Promise<PendingSessionTurn[]> {
  const existing = normalizeSessionState(
    await getSessionState(input.sessionsDir, input.sessionId),
    input.projectId,
  );
  const matches = existing.pendingTurns.filter((item) => item.projectId === input.projectId);
  const limit = input.limit && input.limit > 0 ? input.limit : matches.length;
  const selected = matches.slice(0, limit);

  if (selected.length === 0) {
    return [];
  }

  const selectedCounts = new Map<string, number>();

  for (const item of selected) {
    const key = `${item.projectId}\u0000${item.ts}\u0000${item.content}`;
    selectedCounts.set(key, (selectedCounts.get(key) ?? 0) + 1);
  }

  const remaining = existing.pendingTurns.filter((item) => {
    const key = `${item.projectId}\u0000${item.ts}\u0000${item.content}`;
    const remainingCount = selectedCounts.get(key) ?? 0;

    if (remainingCount > 0) {
      selectedCounts.set(key, remainingCount - 1);
      return false;
    }

    return true;
  });

  await updateSessionState({
    sessionsDir: input.sessionsDir,
    sessionId: input.sessionId,
    update: {
      pendingTurns: remaining,
      updatedAt: toIsoTimestamp(),
    },
  });

  return selected;
}
