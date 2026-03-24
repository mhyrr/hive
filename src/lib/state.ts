import { createHash } from "node:crypto";

import { parseBoard } from "./board";
import { parseTaskStatus, parseTaskId, isRealBlocker } from "./board-parse";
import { digestBoard, digestMessages, digestRuns } from "./digest";
import { readJson, writeJson } from "./json";
import { firstLine, truncate } from "./text";
import { HiveMessage, listOpenProjectMessages } from "./messages";
import {
  ensureDirectory,
  getProjectPaths,
  HivePaths,
  ProjectPaths,
} from "./paths";
import {
  listActiveRuns,
  listRecentRunResults,
  RunRecord,
  RunResult,
} from "./runs";
import {
  getActiveSession,
  getSessionHistory,
  getSessionState,
  SessionMeta,
  SessionState,
  SessionTurn,
} from "./sessions";
import { now, toIsoTimestamp } from "./time";

type BoardTaskSummary = {
  id: string | null;
  status: string | null;
  summary: string;
};

type BoardAgentSummary = {
  id: string;
  descriptor: string;
  status: string;
  lastActive: string | null;
  blockedBy: string | null;
  note: string | null;
};

export type BoardSummary = {
  project: string;
  sourcePath: string;
  taskCount: number;
  activeCount: number;
  doneCount: number;
  waitingCount: number;
  blockers: string[];
  decisions: string[];
  tasks: BoardTaskSummary[];
  agents: BoardAgentSummary[];
  digest: string;
};

export type OpenMessageSummaryItem = {
  filename: string;
  path: string;
  type: string;
  from: string;
  to: string;
  task: string | null;
  launch: string | null;
  scope: string | null;
  ts: string | null;
  summary: string;
};

export type OpenMessagesSummary = {
  project: string;
  sourceDir: string;
  count: number;
  items: OpenMessageSummaryItem[];
  digest: string;
};

export type RecentResultSummaryItem = {
  runId: string;
  agentId: string;
  status: RunResult["status"];
  exitCode: number | null;
  runtime: string | null;
  model: string | null;
  ended: string;
  assignmentMessage: string | null;
  changedFiles: string[];
  gitSummaryLines: string[];
  summary: string;
  cognitiveOutcome: "success" | "partial" | "blocked" | "failed" | null;
  cognitiveModel: string | null;
  path: string;
};

export type RecentResultsSummary = {
  project: string;
  sourceDir: string;
  count: number;
  items: RecentResultSummaryItem[];
};

export type ActiveRunSummaryItem = {
  runId: string;
  agentId: string;
  status: RunRecord["status"];
  runtime: string;
  model: string | null;
  started: string;
  pid: number | null;
  taskId: string | null;
  scope: string[] | null;
  source: string;
  path: string;
};

export type ActiveRunsSummary = {
  project: string;
  sourceDir: string;
  count: number;
  items: ActiveRunSummaryItem[];
  digest: string;
};

export type HumanInboxSummaryItem = {
  filename: string;
  path: string;
  type: string;
  from: string;
  to: string;
  ts: string | null;
  needsHumanReply: boolean;
  summary: string;
};

export type HumanInboxSummary = {
  project: string;
  count: number;
  pendingHumanMessages: number;
  pendingHumanReplies: number;
  items: HumanInboxSummaryItem[];
};

type SessionContextTurn = {
  role: SessionTurn["role"];
  ts: string;
  content: string;
};

export type SessionContextSummary = {
  project: string;
  activeSession: {
    sessionId: string;
    runtime: string;
    model: string | null;
    started: string;
    lastActive: string;
    turns: number;
    currentProject: string;
    lastRevisionSeen: number;
    lastRunId: string | null;
  } | null;
  recentTurns: SessionContextTurn[];
  paths: {
    config: string;
    plan: string;
    board: string;
    log: string;
    memory: string;
    messagesDir: string;
    stateDir: string;
  };
};

export type ProjectStateFingerprints = {
  board: string;
  openMessages: string;
  recentResults: string;
  activeRuns: string;
  humanInbox: string;
  sessionContext: string;
};

export type ProjectStateRevision = {
  project: string;
  revision: number;
  updatedAt: string;
  fingerprint: string;
  fingerprints: ProjectStateFingerprints;
};

export type StewardDeltaChange = {
  type:
    | "board-change"
    | "human-message"
    | "message-opened"
    | "message-cleared"
    | "message-updated"
    | "worker-result"
    | "steward-result"
    | "run-started"
    | "run-finished"
    | "session-update";
  summary: string;
  agent?: string;
  task?: string;
  runId?: string;
  filename?: string;
  path?: string;
};

export type StewardDeltaPacket = {
  project: string;
  revision: number;
  ts: string;
  changes: StewardDeltaChange[];
};

export type ProjectRuntimeState = {
  projectId: string;
  boardText: string;
  openMessages: HiveMessage[];
  activeRuns: RunRecord[];
  recentResults: RunResult[];
  sessionMeta: SessionMeta | null;
  sessionState: SessionState | null;
  sessionTurns: SessionTurn[];
  boardSummary: BoardSummary;
  openMessagesSummary: OpenMessagesSummary;
  recentResultsSummary: RecentResultsSummary;
  activeRunsSummary: ActiveRunsSummary;
  humanInboxSummary: HumanInboxSummary;
  sessionContext: SessionContextSummary;
  revision: ProjectStateRevision;
  delta: StewardDeltaPacket;
  changed: boolean;
};

type SeenResultsState = {
  runIds: string[];
};

function hashJson(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

function summarizeBoard(projectId: string, boardPath: string, boardText: string): BoardSummary {
  const board = parseBoard(boardText);
  const taskStatuses = board.tasks.map((task) => parseTaskStatus(task));

  return {
    project: projectId,
    sourcePath: boardPath,
    taskCount: board.tasks.length,
    activeCount: taskStatuses.filter((status) => status === "active").length,
    doneCount: taskStatuses.filter((status) => status === "done").length,
    waitingCount: taskStatuses.filter((status) =>
      status === "queued" ||
      status === "pending" ||
      status === "waiting" ||
      status?.startsWith("waiting-"),
    ).length,
    blockers: board.blockers.filter((line) => line.trim() && isRealBlocker(line)).map((line) => truncate(line, 180)),
    decisions: board.decisions.slice(-5).map((line) => truncate(line, 180)),
    tasks: board.tasks.map((task) => ({
      id: parseTaskId(task),
      status: parseTaskStatus(task),
      summary: truncate(task, 220),
    })),
    agents: board.agents.map((agent) => ({
      id: agent.id,
      descriptor: agent.descriptor,
      status: agent.fields.status ?? "unknown",
      lastActive: agent.fields["last-active"] ?? null,
      blockedBy: agent.fields["blocked-by"] ?? null,
      note: agent.fields.note ?? null,
    })),
    digest: digestBoard(boardText),
  };
}

function summarizeOpenMessages(
  projectId: string,
  msgDir: string,
  openMessages: HiveMessage[],
): OpenMessagesSummary {
  const items = [...openMessages]
    .sort((left, right) => {
      const leftKey = left.attributes.ts ?? left.filename;
      const rightKey = right.attributes.ts ?? right.filename;

      return leftKey.localeCompare(rightKey);
    })
    .map((message) => ({
      filename: message.filename,
      path: message.path,
      type: message.attributes.type ?? "message",
      from: message.attributes.from ?? "?",
      to: message.attributes.to ?? "?",
      task: message.attributes.task ?? null,
      launch: message.attributes.launch ?? null,
      scope: message.attributes.scope ?? null,
      ts: message.attributes.ts ?? null,
      summary: firstLine(message.body),
    }));

  return {
    project: projectId,
    sourceDir: msgDir,
    count: items.length,
    items,
    digest: digestMessages(openMessages),
  };
}

function summarizeRecentResults(
  projectId: string,
  runsDir: string,
  recentResults: RunResult[],
): RecentResultsSummary {
  return {
    project: projectId,
    sourceDir: runsDir,
    count: recentResults.length,
    items: recentResults.map((result) => ({
      runId: result.runId,
      agentId: result.agentId,
      status: result.status,
      exitCode: result.exitCode,
      runtime: result.runtime,
      model: result.model,
      ended: result.ended,
      assignmentMessage: result.assignmentMessage,
      changedFiles: result.changedFiles,
      gitSummaryLines: result.gitSummaryLines,
      summary: truncate(result.cognitiveDigest?.summary || firstLine(result.finalVisibleOutput)),
      cognitiveOutcome: result.cognitiveDigest?.outcome ?? null,
      cognitiveModel: result.cognitiveDigest?.model ?? null,
      path: result.path,
    })),
  };
}

function summarizeActiveRuns(
  projectId: string,
  runsDir: string,
  activeRuns: RunRecord[],
): ActiveRunsSummary {
  return {
    project: projectId,
    sourceDir: runsDir,
    count: activeRuns.length,
    items: activeRuns.map((run) => ({
      runId: run.runId,
      agentId: run.agentId,
      status: run.status,
      runtime: run.runtime,
      model: run.model,
      started: run.started,
      pid: run.pid,
      taskId: run.taskId,
      scope: run.scope,
      source: run.source,
      path: run.path,
    })),
    digest: digestRuns(activeRuns),
  };
}

function summarizeHumanInbox(
  projectId: string,
  openMessages: HiveMessage[],
): HumanInboxSummary {
  const items = openMessages
    .filter((message) =>
      message.attributes.from === "human" ||
      message.attributes.to === "human" ||
      (message.attributes.type === "nudge" && message.attributes.to === "steward"),
    )
    .map((message) => ({
      filename: message.filename,
      path: message.path,
      type: message.attributes.type ?? "message",
      from: message.attributes.from ?? "?",
      to: message.attributes.to ?? "?",
      ts: message.attributes.ts ?? null,
      needsHumanReply:
        message.attributes.to === "human" ||
        (message.attributes.type === "question" && message.attributes.from !== "human"),
      summary: firstLine(message.body),
    }));

  return {
    project: projectId,
    count: items.length,
    pendingHumanMessages: items.filter((item) => item.from === "human").length,
    pendingHumanReplies: items.filter((item) => item.needsHumanReply).length,
    items,
  };
}

function summarizeSessionContext(input: {
  projectId: string;
  projectPaths: ProjectPaths;
  msgDir: string;
  sessionMeta: SessionMeta | null;
  sessionState: SessionState | null;
  sessionTurns: SessionTurn[];
}): SessionContextSummary {
  const projectState = input.sessionState?.projectStates[input.projectId] ?? null;

  return {
    project: input.projectId,
    activeSession: input.sessionMeta
      ? {
          sessionId: input.sessionMeta.sessionId,
          runtime: input.sessionMeta.runtime,
          model: input.sessionMeta.model,
          started: input.sessionMeta.started,
          lastActive: input.sessionMeta.lastActive,
          turns: input.sessionMeta.turns,
          currentProject: input.sessionState?.currentProject ?? input.sessionMeta.project,
          lastRevisionSeen: projectState?.lastRevisionSeen ?? 0,
          lastRunId: projectState?.lastRunId ?? null,
        }
      : null,
    recentTurns: input.sessionTurns.slice(-6).map((turn) => ({
      role: turn.role,
      ts: turn.ts,
      content: truncate(turn.content, 280),
    })),
    paths: {
      config: input.projectPaths.config,
      plan: input.projectPaths.plan,
      board: input.projectPaths.board,
      log: input.projectPaths.log,
      memory: input.projectPaths.memory,
      messagesDir: input.msgDir,
      stateDir: input.projectPaths.stateDir,
    },
  };
}

async function appendJsonLine(path: string, value: unknown): Promise<void> {
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : "";
  const prefix = existing && !existing.endsWith("\n") ? "\n" : "";

  await Bun.write(path, `${existing}${prefix}${JSON.stringify(value)}\n`);
}

async function ensureStateFiles(projectPaths: ProjectPaths): Promise<void> {
  await ensureDirectory(projectPaths.stateDir);
}

export async function readSeenResultRunIds(
  projectPaths: ProjectPaths,
): Promise<Set<string>> {
  const seen = await readJson<SeenResultsState>(projectPaths.stateSeenResults);

  if (!seen || !Array.isArray(seen.runIds)) {
    return new Set();
  }

  return new Set(seen.runIds.filter((runId): runId is string => typeof runId === "string"));
}

export async function markSeenResultRunIds(
  projectPaths: ProjectPaths,
  runIds: string[],
): Promise<void> {
  const normalized = runIds
    .map((runId) => runId.trim())
    .filter((runId) => runId.length > 0);

  if (normalized.length === 0) {
    return;
  }

  const seen = await readSeenResultRunIds(projectPaths);

  for (const runId of normalized) {
    seen.add(runId);
  }

  await writeJson(projectPaths.stateSeenResults, {
    runIds: [...seen],
  });
}

export async function readStewardDeltaHistory(input: {
  projectPaths: ProjectPaths;
  sinceRevision?: number;
  limit?: number;
}): Promise<StewardDeltaPacket[]> {
  const file = Bun.file(input.projectPaths.stateDeltaHistory);

  if (!(await file.exists())) {
    return [];
  }

  const raw = (await file.text()).trim();

  if (!raw) {
    return [];
  }

  const packets = raw
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as StewardDeltaPacket;
      } catch {
        return null;
      }
    })
    .filter((packet): packet is StewardDeltaPacket => Boolean(packet))
    .filter((packet) => packet.revision > (input.sinceRevision ?? 0));

  const limit = input.limit ?? 10;

  if (packets.length <= limit) {
    return packets;
  }

  return packets.slice(-limit);
}

function toFingerprintSet(input: {
  boardSummary: BoardSummary;
  openMessagesSummary: OpenMessagesSummary;
  recentResultsSummary: RecentResultsSummary;
  activeRunsSummary: ActiveRunsSummary;
  humanInboxSummary: HumanInboxSummary;
  sessionContext: SessionContextSummary;
}): ProjectStateFingerprints {
  return {
    board: hashJson(input.boardSummary),
    openMessages: hashJson(input.openMessagesSummary),
    recentResults: hashJson(input.recentResultsSummary),
    activeRuns: hashJson(input.activeRunsSummary),
    humanInbox: hashJson(input.humanInboxSummary),
    sessionContext: hashJson(input.sessionContext),
  };
}

function aggregateFingerprint(fingerprints: ProjectStateFingerprints): string {
  return hashJson(fingerprints);
}

function buildBoardChange(
  previousBoard: BoardSummary | null,
  currentBoard: BoardSummary,
): StewardDeltaChange[] {
  if (previousBoard && hashJson(previousBoard) === hashJson(currentBoard)) {
    return [];
  }

  return [
    {
      type: "board-change",
      summary: currentBoard.digest.split("\n")[0] ?? "Board summary changed.",
      path: currentBoard.sourcePath,
    },
  ];
}

function buildMessageChanges(
  previousMessages: OpenMessagesSummary | null,
  currentMessages: OpenMessagesSummary,
): StewardDeltaChange[] {
  const changes: StewardDeltaChange[] = [];
  const previousByFilename = new Map(
    (previousMessages?.items ?? []).map((item) => [item.filename, item]),
  );
  const currentByFilename = new Map(
    currentMessages.items.map((item) => [item.filename, item]),
  );

  for (const item of currentMessages.items) {
    const previous = previousByFilename.get(item.filename);

    if (!previous) {
      changes.push({
        type:
          item.from === "human" ||
          (item.type === "nudge" && item.to === "steward")
            ? "human-message"
            : "message-opened",
        summary: `${item.from} -> ${item.to}: ${item.summary}`,
        filename: item.filename,
        task: item.task ?? undefined,
        path: item.path,
      });
      continue;
    }

    if (hashJson(previous) !== hashJson(item)) {
      changes.push({
        type: "message-updated",
        summary: `${item.filename}: ${item.summary}`,
        filename: item.filename,
        task: item.task ?? undefined,
        path: item.path,
      });
    }
  }

  for (const item of previousMessages?.items ?? []) {
    if (currentByFilename.has(item.filename)) {
      continue;
    }

    changes.push({
      type: "message-cleared",
      summary: `${item.filename} is no longer open.`,
      filename: item.filename,
      task: item.task ?? undefined,
      path: item.path,
    });
  }

  return changes;
}

function buildResultChanges(
  previousResults: RecentResultsSummary | null,
  currentResults: RecentResultsSummary,
): StewardDeltaChange[] {
  const previousRunIds = new Set((previousResults?.items ?? []).map((item) => item.runId));

  return currentResults.items
    .filter((item) => !previousRunIds.has(item.runId))
    .map((item) => ({
      type: item.agentId === "steward" ? "steward-result" : "worker-result",
      summary: `${item.agentId}: ${item.summary || item.status}`,
      agent: item.agentId,
      runId: item.runId,
      filename: item.assignmentMessage ?? undefined,
      path: item.path,
    }));
}

function buildRunChanges(
  previousRuns: ActiveRunsSummary | null,
  currentRuns: ActiveRunsSummary,
): StewardDeltaChange[] {
  const changes: StewardDeltaChange[] = [];
  const previousByRunId = new Map((previousRuns?.items ?? []).map((item) => [item.runId, item]));
  const currentByRunId = new Map(currentRuns.items.map((item) => [item.runId, item]));

  for (const item of currentRuns.items) {
    if (previousByRunId.has(item.runId)) {
      continue;
    }

    changes.push({
      type: "run-started",
      summary: `${item.agentId} started${item.taskId ? ` on ${item.taskId}` : ""}.`,
      agent: item.agentId,
      task: item.taskId ?? undefined,
      runId: item.runId,
      path: item.path,
    });
  }

  for (const item of previousRuns?.items ?? []) {
    if (currentByRunId.has(item.runId)) {
      continue;
    }

    changes.push({
      type: "run-finished",
      summary: `${item.agentId} is no longer active${item.taskId ? ` on ${item.taskId}` : ""}.`,
      agent: item.agentId,
      task: item.taskId ?? undefined,
      runId: item.runId,
      path: item.path,
    });
  }

  return changes;
}

function buildSessionChanges(
  previousSession: SessionContextSummary | null,
  currentSession: SessionContextSummary,
): StewardDeltaChange[] {
  const previousFingerprint = previousSession ? hashJson(previousSession) : null;
  const currentFingerprint = hashJson(currentSession);

  if (previousFingerprint === currentFingerprint) {
    return [];
  }

  const sessionId = currentSession.activeSession?.sessionId;

  if (!sessionId) {
    return [];
  }

  return [
    {
      type: "session-update",
      summary: `Session ${sessionId} now has ${currentSession.recentTurns.length} recent turn(s).`,
      path: currentSession.paths.stateDir,
    },
  ];
}

function buildDeltaPacket(input: {
  projectId: string;
  revision: number;
  ts: string;
  previousBoard: BoardSummary | null;
  currentBoard: BoardSummary;
  previousMessages: OpenMessagesSummary | null;
  currentMessages: OpenMessagesSummary;
  previousResults: RecentResultsSummary | null;
  currentResults: RecentResultsSummary;
  previousRuns: ActiveRunsSummary | null;
  currentRuns: ActiveRunsSummary;
  previousSession: SessionContextSummary | null;
  currentSession: SessionContextSummary;
}): StewardDeltaPacket {
  const changes = [
    ...buildBoardChange(input.previousBoard, input.currentBoard),
    ...buildMessageChanges(input.previousMessages, input.currentMessages),
    ...buildResultChanges(input.previousResults, input.currentResults),
    ...buildRunChanges(input.previousRuns, input.currentRuns),
    ...buildSessionChanges(input.previousSession, input.currentSession),
  ];

  return {
    project: input.projectId,
    revision: input.revision,
    ts: input.ts,
    changes: changes.slice(0, 50),
  };
}

function sessionTouchesProject(
  sessionMeta: SessionMeta | null,
  sessionState: SessionState | null,
  projectId: string,
): boolean {
  if (!sessionMeta) {
    return false;
  }

  if (sessionState?.currentProject === projectId) {
    return true;
  }

  if (sessionState?.projectStates[projectId]) {
    return true;
  }

  return sessionMeta.project === projectId;
}

export async function refreshProjectRuntimeState(input: {
  hivePaths: HivePaths;
  projectId: string;
  projectPaths?: ProjectPaths;
}): Promise<ProjectRuntimeState> {
  const projectPaths = input.projectPaths ?? getProjectPaths(input.hivePaths, input.projectId);
  const timestamp = toIsoTimestamp(now());

  await ensureStateFiles(projectPaths);

  const [
    boardText,
    openMessages,
    activeRuns,
    recentResults,
    activeSession,
    activeSessionState,
    previousRevision,
    previousBoardSummary,
    previousOpenMessagesSummary,
    previousRecentResultsSummary,
    previousActiveRunsSummary,
    previousSessionContext,
    previousDelta,
  ] = await Promise.all([
    Bun.file(projectPaths.board).text().catch(() => ""),
    listOpenProjectMessages(input.hivePaths.msgDir, input.projectId),
    listActiveRuns(projectPaths),
    listRecentRunResults(projectPaths, 10),
    getActiveSession(input.hivePaths.sessionsDir),
    getActiveSession(input.hivePaths.sessionsDir).then((session) =>
      session ? getSessionState(input.hivePaths.sessionsDir, session.sessionId) : null,
    ),
    readJson<ProjectStateRevision>(projectPaths.stateRevision),
    readJson<BoardSummary>(projectPaths.stateBoardSummary),
    readJson<OpenMessagesSummary>(projectPaths.stateOpenMessages),
    readJson<RecentResultsSummary>(projectPaths.stateRecentResults),
    readJson<ActiveRunsSummary>(projectPaths.stateActiveRuns),
    readJson<SessionContextSummary>(projectPaths.stateSessionContext),
    readJson<StewardDeltaPacket>(projectPaths.stateStewardDelta),
  ]);

  const sessionMeta = sessionTouchesProject(activeSession, activeSessionState, input.projectId)
    ? activeSession
    : null;
  const sessionState = sessionMeta ? activeSessionState : null;
  const sessionTurns = sessionMeta
    ? await getSessionHistory(input.hivePaths.sessionsDir, sessionMeta.sessionId)
    : [];

  const boardSummary = summarizeBoard(input.projectId, projectPaths.board, boardText);
  const openMessagesSummary = summarizeOpenMessages(
    input.projectId,
    input.hivePaths.msgDir,
    openMessages,
  );
  const recentResultsSummary = summarizeRecentResults(
    input.projectId,
    projectPaths.runsDir,
    recentResults,
  );
  const activeRunsSummary = summarizeActiveRuns(
    input.projectId,
    projectPaths.runsDir,
    activeRuns,
  );
  const humanInboxSummary = summarizeHumanInbox(input.projectId, openMessages);
  const sessionContext = summarizeSessionContext({
    projectId: input.projectId,
    projectPaths,
    msgDir: input.hivePaths.msgDir,
    sessionMeta,
    sessionState,
    sessionTurns,
  });

  const fingerprints = toFingerprintSet({
    boardSummary,
    openMessagesSummary,
    recentResultsSummary,
    activeRunsSummary,
    humanInboxSummary,
    sessionContext,
  });
  const fingerprint = aggregateFingerprint(fingerprints);
  const changed = previousRevision?.fingerprint !== fingerprint;
  const revisionNumber = changed
    ? (previousRevision?.revision ?? 0) + 1
    : (previousRevision?.revision ?? 1);
  const updatedAt = changed ? timestamp : previousRevision?.updatedAt ?? timestamp;
  const revision: ProjectStateRevision = {
    project: input.projectId,
    revision: revisionNumber,
    updatedAt,
    fingerprint,
    fingerprints,
  };

  const delta = changed
    ? buildDeltaPacket({
        projectId: input.projectId,
        revision: revision.revision,
        ts: updatedAt,
        previousBoard: previousBoardSummary,
        currentBoard: boardSummary,
        previousMessages: previousOpenMessagesSummary,
        currentMessages: openMessagesSummary,
        previousResults: previousRecentResultsSummary,
        currentResults: recentResultsSummary,
        previousRuns: previousActiveRunsSummary,
        currentRuns: activeRunsSummary,
        previousSession: previousSessionContext,
        currentSession: sessionContext,
      })
    : previousDelta ?? {
        project: input.projectId,
        revision: revision.revision,
        ts: updatedAt,
        changes: [],
      };

  if (changed || !(await Bun.file(projectPaths.stateRevision).exists())) {
    await writeJson(projectPaths.stateBoardSummary, boardSummary);
    await writeJson(projectPaths.stateOpenMessages, openMessagesSummary);
    await writeJson(projectPaths.stateRecentResults, recentResultsSummary);
    await writeJson(projectPaths.stateActiveRuns, activeRunsSummary);
    await writeJson(projectPaths.stateHumanInbox, humanInboxSummary);
    await writeJson(projectPaths.stateSessionContext, sessionContext);
    await writeJson(projectPaths.stateRevision, revision);
    await writeJson(projectPaths.stateStewardDelta, delta);
    if (changed) {
      await appendJsonLine(projectPaths.stateDeltaHistory, delta);
    }
  } else {
    const requiredFiles = [
      projectPaths.stateBoardSummary,
      projectPaths.stateOpenMessages,
      projectPaths.stateRecentResults,
      projectPaths.stateActiveRuns,
      projectPaths.stateHumanInbox,
      projectPaths.stateSessionContext,
      projectPaths.stateStewardDelta,
      projectPaths.stateDeltaHistory,
    ];

    for (const path of requiredFiles) {
      if (!(await Bun.file(path).exists())) {
        if (path === projectPaths.stateBoardSummary) {
          await writeJson(path, boardSummary);
        } else if (path === projectPaths.stateOpenMessages) {
          await writeJson(path, openMessagesSummary);
        } else if (path === projectPaths.stateRecentResults) {
          await writeJson(path, recentResultsSummary);
        } else if (path === projectPaths.stateActiveRuns) {
          await writeJson(path, activeRunsSummary);
        } else if (path === projectPaths.stateHumanInbox) {
          await writeJson(path, humanInboxSummary);
        } else if (path === projectPaths.stateSessionContext) {
          await writeJson(path, sessionContext);
        } else if (path === projectPaths.stateDeltaHistory) {
          await appendJsonLine(path, delta);
        } else {
          await writeJson(path, delta);
        }
      }
    }
  }

  return {
    projectId: input.projectId,
    boardText,
    openMessages,
    activeRuns,
    recentResults,
    sessionMeta,
    sessionState,
    sessionTurns,
    boardSummary,
    openMessagesSummary,
    recentResultsSummary,
    activeRunsSummary,
    humanInboxSummary,
    sessionContext,
    revision,
    delta,
    changed,
  };
}
