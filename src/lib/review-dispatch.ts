import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { assembleIdentity } from "./identity";
import { extractRepoPath } from "./project";
import type { HivePaths } from "./paths";
import {
  addTicketNote,
  claimTicketForDispatch,
  listTickets,
  readTicket,
  releaseTicketDispatchClaim,
} from "./ticket";
import { toIsoTimestamp } from "./time";

export interface ReviewDispatchRequest {
  paths: HivePaths;
  projectId: string;
  ticketId: string;
  sourceWatch: string;
  model?: string;
  timeoutMin?: number;
}

export interface ReviewDispatchResult {
  runId: string;
  projectId: string;
  ticketId: string;
  branch: string;
  workspacePath: string;
}

export interface ReviewRunMetadata extends ReviewDispatchResult {
  sourceWatch: string;
  baseSha: string;
  completionMode: "review";
  createdAt: string;
}

const REVIEW_AGENT = {
  "maya-review-executor": {
    description: "Completes one ticket on an isolated local branch for human review.",
    prompt: `Complete the ticket in the goal message. Plan, build, verify, and commit the result.
Write and maintain the plan file named in the goal. Stop on ambiguity instead of redesigning the ticket.
All work stays in the current isolated feature branch. Never merge into main. Never push. Never close or reopen the ticket. Never remove the workspace. Human review is the landing step.
Run the repository's required checks. For web work, verify the real flow in the browser and clean up the browser and dev server afterward.
Stop when the work is verified, committed, and ready for review, or when a real blocker is documented.`,
    tools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "Skill"],
    model: "inherit",
  },
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function executable(name: "claude" | "hive"): string {
  const env = name === "hive" ? process.env.HIVE_BIN : process.env.CLAUDE_BIN;
  if (env && existsSync(env)) return env;
  try {
    return execFileSync("which", [name], { encoding: "utf-8" }).trim();
  } catch {
    const fallback = join(process.env.HOME || "", ".local", "bin", name);
    if (existsSync(fallback)) return fallback;
    throw new Error(`Could not find ${name} CLI`);
  }
}

async function acquireDispatchLock(paths: HivePaths): Promise<() => Promise<void>> {
  const path = join(paths.runsDir, ".review-dispatch.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: toIsoTimestamp() }));
      await handle.close();
      return async () => { await unlink(path).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = await readFile(path, "utf-8").then((raw) => JSON.parse(raw) as { pid?: number }).catch(() => ({}));
      if (typeof owner.pid === "number") {
        try {
          process.kill(owner.pid, 0);
          throw new Error(`Another review dispatch is preparing work (pid ${owner.pid})`);
        } catch (probe) {
          if (probe instanceof Error && probe.message.startsWith("Another review dispatch")) throw probe;
        }
      }
      await unlink(path).catch(() => undefined);
    }
  }
  throw new Error("Could not acquire review-dispatch lock");
}

async function allocateRun(paths: HivePaths): Promise<{ runId: string; runDir: string }> {
  const names = await readdir(paths.runsDir).catch(() => []);
  let next = Math.max(0, ...names.map((name) => /^RUN-(\d+)$/.exec(name)?.[1]).filter(Boolean).map(Number)) + 1;
  for (;;) {
    const runId = `RUN-${String(next).padStart(3, "0")}`;
    const runDir = join(paths.runsDir, runId);
    try {
      await mkdir(runDir);
      return { runId, runDir };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      next++;
    }
  }
}

async function validateTicket(paths: HivePaths, projectId: string, ticketId: string): Promise<void> {
  const ticket = await readTicket(paths, projectId, ticketId);
  if (!ticket) throw new Error(`Ticket not found: ${projectId}/${ticketId}`);
  if (ticket.status !== "open" || ticket.dispatchRun) throw new Error(`Ticket is no longer available: ${projectId}/${ticket.id}`);
  if (ticket.type === "epic" || ticket.priority === 0 || ticket.tags.includes("needs-greg") || !ticket.body.trim()) {
    throw new Error(`Ticket no longer passes Act eligibility: ${projectId}/${ticket.id}`);
  }
  const all = new Map((await listTickets(paths, projectId)).map((item) => [item.id, item]));
  if (ticket.depends.some((id) => all.get(id)?.status !== "closed")) {
    throw new Error(`Ticket is dependency-blocked: ${projectId}/${ticket.id}`);
  }
}

export function buildReviewRunWrapper(input: {
  claude: string;
  hive: string;
  model: string;
  timeoutMin: number;
  workspacePath: string;
  runDir: string;
  runId: string;
  projectId: string;
  ticketId: string;
  baseSha: string;
  identityPath: string;
  agentsPath: string;
  messagePath: string;
  logPath: string;
}): string {
  const timeoutSec = input.timeoutMin * 60;
  return `#!/bin/bash
set -euo pipefail
unset ANTHROPIC_API_KEY

OAUTH_TOKEN_FILE="\${HIVE_OAUTH_TOKEN_FILE:-$HOME/.hive/.oauth-token}"
if [ -s "$OAUTH_TOKEN_FILE" ]; then
  export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$OAUTH_TOKEN_FILE")"
fi

cd "${input.workspacePath}"
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=core.hooksPath
export GIT_CONFIG_VALUE_0="${input.runDir}/hooks"
RUNNER=("${input.claude}")
if command -v caffeinate >/dev/null 2>&1; then RUNNER=(caffeinate -ims "${input.claude}"); fi

"\${RUNNER[@]}" \
  --model "${input.model}" \
  --append-system-prompt-file "${input.identityPath}" \
  --add-dir "${input.runDir}" \
  --agents "$(cat "${input.agentsPath}")" \
  --agent maya-review-executor \
  --permission-mode bypassPermissions \
  --name "${input.runId}" \
  "$(cat "${input.messagePath}")" \
  > "${input.logPath}" 2>&1 &
CLAUDE_PID=$!

(
  sleep "${timeoutSec}"
  if kill -0 "$CLAUDE_PID" 2>/dev/null; then
    touch "${input.runDir}/.timed_out"
    kill -TERM "$CLAUDE_PID" 2>/dev/null || true
    sleep 5
    kill -KILL "$CLAUDE_PID" 2>/dev/null || true
  fi
) &
WATCHDOG_PID=$!
wait "$CLAUDE_PID" || true
kill "$WATCHDOG_PID" 2>/dev/null || true
wait "$WATCHDOG_PID" 2>/dev/null || true

STATUS=failed
if [ -f "${input.runDir}/.timed_out" ]; then
  STATUS=timed_out
else
  COMMITS=$(git rev-list --count "${input.baseSha}..HEAD" 2>/dev/null || echo 0)
  CHECKED=$(grep -c '\- \[x\]' "${input.runDir}/plan.md" 2>/dev/null || true)
  UNCHECKED=$(grep -c '\- \[ \]' "${input.runDir}/plan.md" 2>/dev/null || true)
  CHECKED=\${CHECKED:-0}
  UNCHECKED=\${UNCHECKED:-0}
  if grep -qiE '^[[:space:]]*\**Status:?\**[[:space:]]*(complete|done|ready)' "${input.runDir}/plan.md" 2>/dev/null; then PLAN_READY=1; else PLAN_READY=0; fi
  if grep -qi 'blocked' "${input.runDir}/plan.md" 2>/dev/null; then PLAN_BLOCKED=1; else PLAN_BLOCKED=0; fi
  if [ "$COMMITS" -gt 0 ] && [ "$UNCHECKED" = "0" ] && { [ "$CHECKED" -gt 0 ] || [ "$PLAN_READY" = "1" ]; }; then
    STATUS=review_ready
  elif [ "$PLAN_BLOCKED" = "1" ]; then
    STATUS=blocked
  elif [ "$COMMITS" -gt 0 ] || [ "$CHECKED" -gt 0 ]; then
    STATUS=partial
  fi
fi

echo "$STATUS" > "${input.runDir}/status"
if [ "$STATUS" != "review_ready" ]; then
  "${input.hive}" ticket release-claim "${input.ticketId}" --project "${input.projectId}" --run "${input.runId}" >/dev/null 2>&1 || true
fi
`;
}

export async function dispatchTicketForReview(request: ReviewDispatchRequest): Promise<ReviewDispatchResult> {
  const releaseLock = await acquireDispatchLock(request.paths);
  let claimed = false;
  let runId = "";
  let runDir = "";
  try {
    await validateTicket(request.paths, request.projectId, request.ticketId);
    const config = await Bun.file(join(request.paths.projectsDir, request.projectId, "config.md")).text();
    const projectPath = extractRepoPath(config);
    if (!projectPath || !existsSync(projectPath)) throw new Error(`Project path unavailable: ${request.projectId}`);
    const baseSha = git(projectPath, ["rev-parse", "--verify", "main^{commit}"]);
    const allocated = await allocateRun(request.paths);
    runId = allocated.runId;
    runDir = allocated.runDir;
    const branch = `hive/act/${request.projectId}-${request.ticketId.toLowerCase()}-${runId.toLowerCase()}`;
    const workspacePath = join(allocated.runDir, "workspace");
    const metadata: ReviewRunMetadata = {
      runId,
      projectId: request.projectId,
      ticketId: request.ticketId,
      branch,
      workspacePath,
      sourceWatch: request.sourceWatch,
      baseSha,
      completionMode: "review",
      createdAt: toIsoTimestamp(),
    };
    await writeFile(join(allocated.runDir, "run.json"), JSON.stringify(metadata, null, 2) + "\n");
    const ticket = await claimTicketForDispatch(request.paths, request.projectId, request.ticketId, runId, branch);
    claimed = true;
    git(projectPath, ["worktree", "add", "-b", branch, workspacePath, baseSha]);

    await writeFile(join(allocated.runDir, "goal.md"), `# Goal\n\nImplement ${request.projectId}/${ticket.id}: ${ticket.title}\n\n${ticket.body}\n\n---\nProject: ${request.projectId}\nTicket: ${ticket.id}\nMode: review\n`);
    await writeFile(join(allocated.runDir, "status"), "running");

    const identityPath = join(allocated.runDir, "identity.md");
    const agentsPath = join(allocated.runDir, "agents.json");
    const hooksDir = join(allocated.runDir, "hooks");
    const messagePath = join(allocated.runDir, "message.txt");
    const logPath = join(allocated.runDir, "output.log");
    await writeFile(identityPath, await assembleIdentity());
    await writeFile(agentsPath, JSON.stringify(REVIEW_AGENT));
    await mkdir(hooksDir);
    for (const hook of ["pre-push", "pre-merge-commit"]) {
      const path = join(hooksDir, hook);
      await writeFile(path, "#!/bin/bash\necho 'Act review runs may not push or merge.' >&2\nexit 1\n");
      await chmod(path, 0o755);
    }
    await writeFile(messagePath, `/goal The ticket is complete when every checklist item in ${allocated.runDir}/plan.md is [x], required checks pass, and all changes are committed on the current branch for human review. Never merge or push. (or stop after 20 turns)\n\nRun directory: ${allocated.runDir}\nPlan file: ${allocated.runDir}/plan.md\nProject: ${request.projectId}\nTicket: ${ticket.id}\n\n${ticket.title}\n\n${ticket.body}`);

    const wrapperPath = join(allocated.runDir, "run.sh");
    await writeFile(wrapperPath, buildReviewRunWrapper({
      claude: executable("claude"),
      hive: executable("hive"),
      model: request.model ?? process.env.HIVE_DISPATCH_MODEL ?? "claude-opus-4-6",
      timeoutMin: request.timeoutMin ?? 60,
      workspacePath,
      runDir: allocated.runDir,
      runId,
      projectId: request.projectId,
      ticketId: ticket.id,
      baseSha,
      identityPath,
      agentsPath,
      messagePath,
      logPath,
    }));
    await chmod(wrapperPath, 0o755);

    const child = spawn("/bin/bash", [wrapperPath], { cwd: workspacePath, detached: true, stdio: "ignore", env: { ...process.env, ANTHROPIC_API_KEY: undefined } });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    await writeFile(join(allocated.runDir, "pid"), String(child.pid));
    await addTicketNote(request.paths, request.projectId, ticket.id, `${runId} dispatched by watch:${request.sourceWatch} to review branch \`${branch}\`. It will not merge or push.`, "watch:act");
    return { runId, projectId: request.projectId, ticketId: ticket.id, branch, workspacePath };
  } catch (error) {
    if (claimed && runId) await releaseTicketDispatchClaim(request.paths, request.projectId, request.ticketId, runId);
    if (runDir) {
      const message = error instanceof Error ? error.message : String(error);
      await writeFile(join(runDir, "status"), "failed").catch(() => undefined);
      await writeFile(join(runDir, "error.txt"), message + "\n").catch(() => undefined);
    }
    throw error;
  } finally {
    await releaseLock();
  }
}
