type GitStatusSnapshot = Record<string, string>;

type GitDelta = {
  available: boolean;
  changedFiles: string[];
  summaryLines: string[];
};

function decode(output?: Uint8Array): string {
  return new TextDecoder().decode(output ?? new Uint8Array()).trim();
}

function normalizeStatus(status: string): string {
  return status.trim() || "??";
}

function extractPathFromPorcelain(line: string): string | null {
  const payload = line.slice(3).trim();

  if (!payload) {
    return null;
  }

  if (payload.includes(" -> ")) {
    return payload.split(" -> ").at(-1)?.trim() ?? null;
  }

  return payload;
}

function parseStatusSnapshot(output: string): GitStatusSnapshot {
  const snapshot: GitStatusSnapshot = {};

  for (const line of output.split("\n")) {
    const trimmed = line.trimEnd();

    if (!trimmed) {
      continue;
    }

    const path = extractPathFromPorcelain(trimmed);

    if (!path) {
      continue;
    }

    snapshot[path] = normalizeStatus(trimmed.slice(0, 2));
  }

  return snapshot;
}

function listChangedFiles(
  before: GitStatusSnapshot,
  after: GitStatusSnapshot,
): string[] {
  const paths = new Set<string>([...Object.keys(before), ...Object.keys(after)]);

  return [...paths]
    .filter((path) => before[path] !== after[path])
    .sort((left, right) => left.localeCompare(right));
}

export function captureGitStatusSnapshot(repoPath: string): GitStatusSnapshot | null {
  const result = Bun.spawnSync({
    cmd: ["git", "-C", repoPath, "status", "--porcelain=v1", "--untracked-files=all"],
    stderr: "pipe",
    stdout: "pipe",
  });

  if (result.exitCode !== 0) {
    return null;
  }

  return parseStatusSnapshot(decode(result.stdout));
}

export type VerifyCommandResult = {
  passed: boolean;
  exitCode: number | null;
  output: string;
};

export function runVerifyCommand(repoPath: string, command: string): VerifyCommandResult {
  const result = Bun.spawnSync({
    cmd: ["sh", "-c", command],
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const stdout = decode(result.stdout);
  const stderr = decode(result.stderr);
  const output = [stdout, stderr].filter(Boolean).join("\n");

  return {
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    output: output.length > 2000 ? output.slice(-2000) : output,
  };
}

export function revertWorkerChanges(repoPath: string): { reverted: boolean; summary: string } {
  // Discard all unstaged and staged changes, remove untracked files
  const resetResult = Bun.spawnSync({
    cmd: ["git", "-C", repoPath, "reset", "--hard", "HEAD"],
    stdout: "pipe",
    stderr: "pipe",
  });

  if (resetResult.exitCode !== 0) {
    return {
      reverted: false,
      summary: `git reset --hard failed: ${decode(resetResult.stderr)}`,
    };
  }

  const cleanResult = Bun.spawnSync({
    cmd: ["git", "-C", repoPath, "clean", "-fd"],
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    reverted: true,
    summary: cleanResult.exitCode === 0
      ? "reverted to HEAD (reset --hard + clean -fd)"
      : `reset succeeded but clean failed: ${decode(cleanResult.stderr)}`,
  };
}

export function diffGitStatusSnapshots(
  before: GitStatusSnapshot | null,
  after: GitStatusSnapshot | null,
): GitDelta {
  if (!before || !after) {
    return {
      available: false,
      changedFiles: [],
      summaryLines: ["git status unavailable"],
    };
  }

  const changedFiles = listChangedFiles(before, after);

  if (changedFiles.length === 0) {
    return {
      available: true,
      changedFiles,
      summaryLines: ["no git status delta detected"],
    };
  }

  return {
    available: true,
    changedFiles,
    summaryLines: changedFiles.map((path) => `${after[path] ?? "--"} ${path}`),
  };
}
