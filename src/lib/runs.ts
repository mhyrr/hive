import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";
import { ensureDirectory, ProjectPaths } from "./paths";
import { parseScopeRoots } from "./project";
import { RuntimeName } from "./runtime";
import { now, toCompactTimestamp, toDateParts, toIsoTimestamp } from "./time";

export type RunStatus = "starting" | "active" | "exited" | "failed" | "cancelled";

export type RunRecord = {
  runId: string;
  projectId: string;
  agentId: string;
  status: RunStatus;
  runtime: RuntimeName;
  model: string | null;
  started: string;
  ended: string | null;
  exitCode: number | null;
  pid: number | null;
  promptPath: string;
  source: string;
  sourceMessage: string | null;
  taskId: string | null;
  scope: string[] | null;
  stopRequestedAt: string | null;
  stopRequestedBy: string | null;
  path: string;
};

export type RunResult = {
  runId: string;
  agentId: string;
  status: Extract<RunStatus, "exited" | "failed" | "cancelled">;
  exitCode: number | null;
  assignmentMessage: string | null;
  assignmentStatusAfterExit: string | null;
  assignmentResolvedByWorker: boolean;
  changedFiles: string[];
  gitSummaryLines: string[];
  finalVisibleOutput: string;
  ended: string;
  path: string;
};

type CreateRunInput = {
  projectId: string;
  projectPaths: ProjectPaths;
  agentId: string;
  runtime: RuntimeName;
  model: string | null;
  prompt: string;
  source: string;
  sourceMessage?: string | null;
  taskId?: string | null;
  scope?: string[] | null;
};

type FinalizeRunInput = {
  projectPaths: ProjectPaths;
  run: RunRecord;
  status: Extract<RunStatus, "exited" | "failed" | "cancelled">;
  exitCode: number | null;
};

type StoredRunPaths = {
  root: string;
  runFile: string;
  promptFile: string;
  resultFile: string;
  outputFile: string;
};

type PromptArtifact = {
  createdAt: Date;
  promptPath: string;
  runId: string;
};

function toNullableNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function renderRunBody(input: {
  source: string;
  status: RunStatus;
  exitCode?: number | null;
  scope?: string[] | null;
}): string {
  const lines = ["## Summary", `- source: ${input.source}`, `- status: ${input.status}`];

  if (input.exitCode !== undefined && input.exitCode !== null) {
    lines.push(`- exit-code: ${input.exitCode}`);
  }

  if (input.scope?.length) {
    lines.push(`- scope: ${input.scope.join(", ")}`);
  }

  return lines.join("\n");
}

function getRunPaths(
  projectPaths: ProjectPaths,
  agentId: string,
  runId: string,
  date: Date,
): StoredRunPaths {
  const { year, month } = toDateParts(date);
  const root = join(projectPaths.runsDir, year, month, runId);

  return {
    root,
    runFile: join(root, "run.md"),
    promptFile: join(root, "prompt.md"),
    resultFile: join(root, "result.md"),
    outputFile: join(root, "output.log"),
  };
}

function getArchivedRunPathFromPrompt(promptPath: string): string | null {
  if (!promptPath.endsWith("/prompt.md") && !promptPath.endsWith("\\prompt.md")) {
    return null;
  }

  return promptPath.replace(/prompt\.md$/, "run.md");
}

function toRunRecord(path: string, raw: string): RunRecord | null {
  const parsed = parseFrontmatter(raw);
  const attributes = parsed.attributes;
  const runId = attributes.run;
  const projectId = attributes.project;
  const agentId = attributes.agent;
  const status = attributes.status as RunStatus | undefined;
  const runtime = attributes.runtime as RuntimeName | undefined;
  const started = attributes.started;
  const promptPath = attributes.prompt;
  const source = attributes.source;

  if (
    !runId ||
    !projectId ||
    !agentId ||
    !status ||
    (runtime !== "codex" && runtime !== "claude") ||
    !started ||
    !promptPath ||
    !source
  ) {
    return null;
  }

  return {
    runId,
    projectId,
    agentId,
    status,
    runtime,
    model: attributes.model ?? null,
    started,
    ended: attributes.ended ?? null,
    exitCode: toNullableNumber(attributes["exit-code"]),
    pid: toNullableNumber(attributes.pid),
    promptPath,
    source,
    sourceMessage: attributes["source-message"] ?? null,
    taskId: attributes.task ?? null,
    scope: parseScopeRoots(attributes.scope),
    stopRequestedAt: attributes["stop-requested-at"] ?? null,
    stopRequestedBy: attributes["stop-requested-by"] ?? null,
    path,
  };
}

function toBoolean(value: string | undefined): boolean {
  return value === "true" || value === "yes";
}

function toLines(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split("|")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toRunResult(path: string, raw: string): RunResult | null {
  const parsed = parseFrontmatter(raw);
  const attributes = parsed.attributes;
  const runId = attributes.run;
  const agentId = attributes.agent;
  const status = attributes.status as Extract<RunStatus, "exited" | "failed" | "cancelled"> | undefined;
  const ended = attributes.ended;

  if (!runId || !agentId || !status || !ended) {
    return null;
  }

  return {
    runId,
    agentId,
    status,
    exitCode: toNullableNumber(attributes["exit-code"]),
    assignmentMessage: attributes["assignment-message"] ?? null,
    assignmentStatusAfterExit: attributes["assignment-status-after-exit"] ?? null,
    assignmentResolvedByWorker: toBoolean(attributes["assignment-resolved-by-worker"]),
    changedFiles: toLines(attributes["changed-files"]),
    gitSummaryLines: toLines(attributes["git-summary"]),
    finalVisibleOutput: parsed.body.trim(),
    ended,
    path,
  };
}

async function writeRunRecord(
  path: string,
  input: Omit<RunRecord, "path">,
): Promise<void> {
  const attributes: Record<string, string> = {
    run: input.runId,
    project: input.projectId,
    agent: input.agentId,
    status: input.status,
    runtime: input.runtime,
    started: input.started,
    prompt: input.promptPath,
    source: input.source,
  };

  if (input.model) {
    attributes.model = input.model;
  }

  if (input.sourceMessage) {
    attributes["source-message"] = input.sourceMessage;
  }

  if (input.taskId) {
    attributes.task = input.taskId;
  }

  if (input.scope?.length) {
    attributes.scope = input.scope.join(",");
  }

  if (input.stopRequestedAt) {
    attributes["stop-requested-at"] = input.stopRequestedAt;
  }

  if (input.stopRequestedBy) {
    attributes["stop-requested-by"] = input.stopRequestedBy;
  }

  if (input.ended) {
    attributes.ended = input.ended;
  }

  if (input.exitCode !== null) {
    attributes["exit-code"] = String(input.exitCode);
  }

  if (input.pid !== null) {
    attributes.pid = String(input.pid);
  }

  await Bun.write(
    path,
    stringifyFrontmatter(
      attributes,
      renderRunBody({
        source: input.source,
        status: input.status,
        exitCode: input.exitCode,
        scope: input.scope,
      }),
    ),
  );
}

export async function createRunPromptArtifact(
  projectPaths: ProjectPaths,
  agentId: string,
  prompt: string,
): Promise<PromptArtifact> {
  const createdAt = now();
  const baseRunId = `${toCompactTimestamp(createdAt)}-${agentId}`;
  let runId = baseRunId;
  let runPaths = getRunPaths(projectPaths, agentId, runId, createdAt);
  let counter = 2;

  while (await Bun.file(runPaths.promptFile).exists()) {
    runId = `${baseRunId}-${counter}`;
    runPaths = getRunPaths(projectPaths, agentId, runId, createdAt);
    counter += 1;
  }

  await ensureDirectory(projectPaths.runsActiveDir);
  await ensureDirectory(runPaths.root);
  await Bun.write(runPaths.promptFile, `${prompt.trim()}\n`);

  return {
    createdAt,
    promptPath: runPaths.promptFile,
    runId,
  };
}

export async function createRunDraft(input: CreateRunInput): Promise<RunRecord> {
  const artifact = await createRunPromptArtifact(
    input.projectPaths,
    input.agentId,
    input.prompt,
  );
  const runPaths = getRunPaths(
    input.projectPaths,
    input.agentId,
    artifact.runId,
    artifact.createdAt,
  );

  const record: RunRecord = {
    runId: artifact.runId,
    projectId: input.projectId,
    agentId: input.agentId,
    status: "starting",
    runtime: input.runtime,
    model: input.model,
    started: toIsoTimestamp(artifact.createdAt),
    ended: null,
    exitCode: null,
    pid: null,
    promptPath: artifact.promptPath,
    source: input.source,
    sourceMessage: input.sourceMessage ?? null,
    taskId: input.taskId ?? null,
    scope: input.scope ?? null,
    stopRequestedAt: null,
    stopRequestedBy: null,
    path: runPaths.runFile,
  };

  await writeRunRecord(runPaths.runFile, record);
  await Bun.write(runPaths.outputFile, "");

  return record;
}

export function getRunOutputPath(run: RunRecord): string {
  return join(run.path.replace(/run\.md$/, ""), "output.log");
}

export async function readRunOutputTail(
  run: RunRecord,
  limit = 8,
): Promise<string[]> {
  const path = getRunOutputPath(run);
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return [];
  }

  const text = await file.text();

  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-limit);
}

export async function markRunActive(
  projectPaths: ProjectPaths,
  run: RunRecord,
  pid: number | null,
): Promise<RunRecord> {
  const next: RunRecord = {
    ...run,
    status: "active",
    pid,
  };
  const activePath = join(projectPaths.runsActiveDir, `${run.agentId}.md`);

  await writeRunRecord(run.path, next);
  await writeRunRecord(activePath, next);

  return next;
}

export async function finalizeRun(input: FinalizeRunInput): Promise<RunRecord> {
  const endedAt = toIsoTimestamp();
  const next: RunRecord = {
    ...input.run,
    status: input.status,
    ended: endedAt,
    exitCode: input.exitCode,
    pid: null,
  };
  const activePath = join(input.projectPaths.runsActiveDir, `${input.run.agentId}.md`);

  await writeRunRecord(next.path, next);
  await rm(activePath, { force: true });

  return next;
}

export async function writeRunResult(
  run: RunRecord,
  input: {
    assignmentStatusAfterExit?: string | null;
    assignmentResolvedByWorker?: boolean;
    changedFiles?: string[];
    gitSummaryLines?: string[];
    finalVisibleOutput?: string;
  },
): Promise<RunResult> {
  const path = join(run.path.replace(/run\.md$/, ""), "result.md");
  const attributes: Record<string, string> = {
    run: run.runId,
    agent: run.agentId,
    status: run.status,
    ended: run.ended ?? toIsoTimestamp(),
  };

  if (run.exitCode !== null) {
    attributes["exit-code"] = String(run.exitCode);
  }

  if (run.sourceMessage) {
    attributes["assignment-message"] = run.sourceMessage;
  }

  if (input.assignmentStatusAfterExit) {
    attributes["assignment-status-after-exit"] = input.assignmentStatusAfterExit;
  }

  if (input.assignmentResolvedByWorker !== undefined) {
    attributes["assignment-resolved-by-worker"] = input.assignmentResolvedByWorker ? "true" : "false";
  }

  if (input.changedFiles?.length) {
    attributes["changed-files"] = input.changedFiles.join(" | ");
  }

  if (input.gitSummaryLines?.length) {
    attributes["git-summary"] = input.gitSummaryLines.join(" | ");
  }

  await Bun.write(
    path,
    stringifyFrontmatter(attributes, input.finalVisibleOutput?.trim() || "(no visible runtime output)"),
  );

  return toRunResult(path, await Bun.file(path).text())!;
}

export async function markRunStopRequested(
  run: RunRecord,
  actor: string,
): Promise<RunRecord> {
  const next: RunRecord = {
    ...run,
    stopRequestedAt: toIsoTimestamp(),
    stopRequestedBy: actor,
  };

  await writeRunRecord(next.path, next);

  return next;
}

export async function readRunRecord(path: string): Promise<RunRecord | null> {
  const file = Bun.file(path);

  if (!(await file.exists())) {
    return null;
  }

  return toRunRecord(path, await file.text());
}

async function hydrateActiveRunRecord(record: RunRecord | null): Promise<RunRecord | null> {
  if (!record) {
    return null;
  }

  const archivedPath = getArchivedRunPathFromPrompt(record.promptPath);

  if (!archivedPath) {
    return record;
  }

  const archived = await readRunRecord(archivedPath);

  if (!archived) {
    return record;
  }

  return {
    ...archived,
    status: record.status,
    pid: record.pid,
    ended: record.ended,
    exitCode: record.exitCode,
  };
}

export async function readActiveRun(
  projectPaths: ProjectPaths,
  agentId: string,
): Promise<RunRecord | null> {
  const path = join(projectPaths.runsActiveDir, `${agentId}.md`);
  return hydrateActiveRunRecord(await readRunRecord(path));
}

export async function listActiveRuns(projectPaths: ProjectPaths): Promise<RunRecord[]> {
  const entries = await readdir(projectPaths.runsActiveDir, { withFileTypes: true }).catch(() => []);
  const runs: RunRecord[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }

    const path = join(projectPaths.runsActiveDir, entry.name);
    const record = await hydrateActiveRunRecord(
      toRunRecord(path, await Bun.file(path).text()),
    );

    if (record) {
      runs.push(record);
    }
  }

  return runs.sort((left, right) => right.started.localeCompare(left.started));
}

async function listArchivedRuns(
  projectPaths: ProjectPaths,
  limit?: number,
): Promise<RunRecord[]> {
  const years = await readdir(projectPaths.runsDir, { withFileTypes: true }).catch(() => []);
  const runs: RunRecord[] = [];

  for (const yearEntry of years.sort((left, right) => right.name.localeCompare(left.name))) {
    if (!yearEntry.isDirectory() || yearEntry.name === "active") {
      continue;
    }

    const yearPath = join(projectPaths.runsDir, yearEntry.name);
    const months = await readdir(yearPath, { withFileTypes: true }).catch(() => []);

    for (const monthEntry of months.sort((left, right) => right.name.localeCompare(left.name))) {
      if (!monthEntry.isDirectory()) {
        continue;
      }

      const monthPath = join(yearPath, monthEntry.name);
      const runDirs = await readdir(monthPath, { withFileTypes: true }).catch(() => []);

      for (const runEntry of runDirs.sort((left, right) => right.name.localeCompare(left.name))) {
        if (!runEntry.isDirectory()) {
          continue;
        }

        const runPath = join(monthPath, runEntry.name, "run.md");
        const runFile = Bun.file(runPath);

        if (!(await runFile.exists())) {
          continue;
        }

        const record = toRunRecord(runPath, await runFile.text());

        if (record && record.status !== "active") {
          runs.push(record);
        }

        if (limit !== undefined && runs.length >= limit) {
          return runs;
        }
      }
    }
  }

  return runs;
}

export async function listAllRuns(projectPaths: ProjectPaths): Promise<RunRecord[]> {
  return listArchivedRuns(projectPaths);
}

export async function listRecentRuns(
  projectPaths: ProjectPaths,
  limit = 5,
): Promise<RunRecord[]> {
  return listArchivedRuns(projectPaths, limit);
}

export async function listRecentRunResults(
  projectPaths: ProjectPaths,
  limit = 5,
): Promise<RunResult[]> {
  const years = await readdir(projectPaths.runsDir, { withFileTypes: true }).catch(() => []);
  const results: RunResult[] = [];

  for (const yearEntry of years.sort((left, right) => right.name.localeCompare(left.name))) {
    if (!yearEntry.isDirectory() || yearEntry.name === "active") {
      continue;
    }

    const yearPath = join(projectPaths.runsDir, yearEntry.name);
    const months = await readdir(yearPath, { withFileTypes: true }).catch(() => []);

    for (const monthEntry of months.sort((left, right) => right.name.localeCompare(left.name))) {
      if (!monthEntry.isDirectory()) {
        continue;
      }

      const monthPath = join(yearPath, monthEntry.name);
      const runDirs = await readdir(monthPath, { withFileTypes: true }).catch(() => []);

      for (const runEntry of runDirs.sort((left, right) => right.name.localeCompare(left.name))) {
        if (!runEntry.isDirectory()) {
          continue;
        }

        const resultPath = join(monthPath, runEntry.name, "result.md");
        const resultFile = Bun.file(resultPath);

        if (!(await resultFile.exists())) {
          continue;
        }

        const result = toRunResult(resultPath, await resultFile.text());

        if (result) {
          results.push(result);
        }

        if (results.length >= limit) {
          return results;
        }
      }
    }
  }

  return results;
}
