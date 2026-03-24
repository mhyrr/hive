import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type GitStatusSnapshot = Record<string, string>;

type GitDelta = {
  available: boolean;
  changedFiles: string[];
  summaryLines: string[];
};

function decode(output?: Uint8Array): string {
  return new TextDecoder().decode(output ?? new Uint8Array());
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

const DEFAULT_VERIFY_TIMEOUT_MS = 60_000;

export function runVerifyCommand(
  repoPath: string,
  command: string,
  timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): VerifyCommandResult {
  const result = Bun.spawnSync({
    cmd: ["sh", "-c", command],
    cwd: repoPath,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
    timeout: timeoutMs,
  });

  const stdout = decode(result.stdout).trim();
  const stderr = decode(result.stderr).trim();
  const output = [stdout, stderr].filter(Boolean).join("\n");

  return {
    passed: result.exitCode === 0,
    exitCode: result.exitCode,
    output: output.length > 2000 ? output.slice(-2000) : output,
  };
}

export function revertWorkerChanges(
  repoPath: string,
  scope: string[] | null,
): { reverted: boolean; summary: string } {
  if (!scope || scope.length === 0) {
    return {
      reverted: false,
      summary: "no scope declared — refusing to revert entire repository",
    };
  }

  // Restore tracked files within scope to HEAD (may fail if no tracked files match, which is OK)
  const checkoutResult = Bun.spawnSync({
    cmd: ["git", "-C", repoPath, "checkout", "HEAD", "--", ...scope],
    stdout: "pipe",
    stderr: "pipe",
  });

  // Remove untracked files within scope
  const cleanResult = Bun.spawnSync({
    cmd: ["git", "-C", repoPath, "clean", "-fd", "--", ...scope],
    stdout: "pipe",
    stderr: "pipe",
  });

  const checkoutOk = checkoutResult.exitCode === 0;
  const cleanOk = cleanResult.exitCode === 0;

  if (!checkoutOk && !cleanOk) {
    return {
      reverted: false,
      summary: `both checkout and clean failed for ${scope.join(", ")}: ${decode(checkoutResult.stderr).trim()} / ${decode(cleanResult.stderr).trim()}`,
    };
  }

  const parts: string[] = [];

  if (checkoutOk) {
    parts.push("checkout");
  }

  if (cleanOk) {
    parts.push("clean");
  }

  return {
    reverted: true,
    summary: `reverted scoped paths (${parts.join(" + ")}): ${scope.join(", ")}`,
  };
}

export function captureGitContentFingerprint(
  repoPath: string,
  snapshot: GitStatusSnapshot | null = captureGitStatusSnapshot(repoPath),
): Record<string, string> {
  const fingerprint: Record<string, string> = {};

  if (!snapshot) {
    return fingerprint;
  }

  for (const file of Object.keys(snapshot).sort((left, right) => left.localeCompare(right))) {
    try {
      fingerprint[file] = createHash("sha1")
        .update(readFileSync(join(repoPath, file)))
        .digest("hex");
    } catch {
      // The path may no longer exist (delete/rename race) by the time we read it.
    }
  }

  return fingerprint;
}

export function diffGitStatusSnapshots(
  before: GitStatusSnapshot | null,
  after: GitStatusSnapshot | null,
  options?: {
    beforeFingerprint?: Record<string, string>;
    afterFingerprint?: Record<string, string>;
  },
): GitDelta {
  if (!before || !after) {
    return {
      available: false,
      changedFiles: [],
      summaryLines: ["git status unavailable"],
    };
  }

  const statusChanged = listChangedFiles(before, after);

  // Also detect content changes in already-dirty files via fingerprint comparison
  let contentChanged: string[] = [];
  if (options?.beforeFingerprint && options?.afterFingerprint) {
    const allPaths = new Set([
      ...Object.keys(options.beforeFingerprint),
      ...Object.keys(options.afterFingerprint),
    ]);
    contentChanged = [...allPaths].filter(
      (path) =>
        !statusChanged.includes(path) &&
        options.beforeFingerprint![path] !== options.afterFingerprint![path],
    );
  }

  const changedFiles = [...new Set([...statusChanged, ...contentChanged])].sort(
    (a, b) => a.localeCompare(b),
  );

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
