import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { UsageError } from "../lib/errors";
import { parseFrontmatter } from "../lib/frontmatter";
import { ensureDirectory, getHivePaths } from "../lib/paths";
import { readTicket, formatTicketDetail } from "../lib/ticket";
import { assembleIdentity } from "../lib/identity";
import { resolveProjectFromCwd } from "../lib/project";

async function nextRunId(runsDir: string): Promise<string> {
  const entries = await readdir(runsDir).catch(() => []);
  const ids = entries
    .filter((e) => e.startsWith("RUN-"))
    .map((e) => parseInt(e.replace("RUN-", ""), 10))
    .filter((n) => !isNaN(n));
  const next = ids.length > 0 ? Math.max(...ids) + 1 : 1;
  return `RUN-${String(next).padStart(3, "0")}`;
}


export interface RunWrapperOpts {
  projectPath: string;
  timeoutMin: number;
  claude: string;
  model: string;
  identityPath: string;
  hiveHome: string;
  runId: string;
  messagePath: string;
  logPath: string;
  runDir: string;
  runsDir: string;
}

export function buildRunWrapper(opts: RunWrapperOpts): string {
  const {
    projectPath,
    timeoutMin,
    claude,
    model,
    identityPath,
    hiveHome,
    runId,
    messagePath,
    logPath,
    runDir,
    runsDir,
  } = opts;
  return `#!/bin/bash
set -euo pipefail

# Unset API key to force subscription OAuth
unset ANTHROPIC_API_KEY

cd "${projectPath}"

# Portable timeout: background claude + watchdog. Avoids GNU coreutils
# timeout(1), which isn't on macOS by default.
TIMEOUT_SEC=${timeoutMin * 60}

"${claude}" \\
  --model "${model}" \\
  --append-system-prompt-file "${identityPath}" \\
  --add-dir "${hiveHome}" \\
  --agent maya-executor \\
  --permission-mode bypassPermissions \\
  --worktree \\
  --name "${runId}" \\
  "$(cat "${messagePath}")" \\
  > "${logPath}" 2>&1 &
CLAUDE_PID=$!

(
  sleep "$TIMEOUT_SEC"
  if kill -0 "$CLAUDE_PID" 2>/dev/null; then
    touch "${runDir}/.timed_out"
    kill -TERM "$CLAUDE_PID" 2>/dev/null
    sleep 5
    kill -KILL "$CLAUDE_PID" 2>/dev/null || true
  fi
) &
WATCHDOG_PID=$!

EXIT_CODE=0
wait "$CLAUDE_PID" || EXIT_CODE=$?

kill "$WATCHDOG_PID" 2>/dev/null || true
wait "$WATCHDOG_PID" 2>/dev/null || true

if [ -f "${runDir}/.timed_out" ]; then
  echo "timed_out" > "${runDir}/status"
  osascript -e "display notification \\"Run ${runId} timed out after ${timeoutMin}m\\" with title \\"HIVE\\" sound name \\"Glass\\"" 2>/dev/null || true
  exit 0
fi

# Determine status from evidence of work, not exit code
# Claude can exit non-zero even when all work completed (context exhaustion, etc.)
if [ -f "${runDir}/plan.md" ]; then
  CHECKED=$(grep -c '\\- \\[x\\]' "${runDir}/plan.md" 2>/dev/null || echo "0")
  UNCHECKED=$(grep -c '\\- \\[ \\]' "${runDir}/plan.md" 2>/dev/null || echo "0")
  if [ "$UNCHECKED" = "0" ] && [ "$CHECKED" -gt "0" ]; then
    echo "complete" > "${runDir}/status"
  elif grep -q "blocked" "${runDir}/plan.md" 2>/dev/null; then
    echo "blocked" > "${runDir}/status"
  elif [ "$CHECKED" -gt "0" ]; then
    echo "partial" > "${runDir}/status"
  else
    echo "failed" > "${runDir}/status"
  fi
else
  # No plan file — check if there are commits on the worktree branch
  COMMITS=$(git log main..HEAD --oneline 2>/dev/null | wc -l | tr -d ' ')
  if [ "$COMMITS" -gt "0" ] || [ "$EXIT_CODE" = "0" ]; then
    echo "complete" > "${runDir}/status"
  else
    echo "failed" > "${runDir}/status"
  fi
fi

# Clean up worktree if claude left one behind.
# TK-045: Skip cleanup entirely if any other run is still active — a sibling
# run's worktree can be transiently AHEAD=0 with clean diff (e.g. right after
# a ff-only merge from main) and our prune would delete its live working dir.
OTHER_RUNNING=0
for rd in "${runsDir}"/RUN-*/; do
  [ -d "$rd" ] || continue
  [ "$rd" = "${runDir}/" ] && continue
  ST=$(cat "$rd/status" 2>/dev/null || echo "")
  if [ "$ST" = "running" ]; then
    OTHER_RUNNING=1
    break
  fi
done

if [ "$OTHER_RUNNING" = "0" ]; then
  cd "${projectPath}"
  for wt in .claude/worktrees/*/; do
    if [ -d "$wt" ]; then
      # Check if worktree has unmerged changes
      BRANCH=$(git -C "$wt" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
      if [ -n "$BRANCH" ]; then
        DIFF=$(git -C "$wt" diff --stat HEAD 2>/dev/null || echo "")
        AHEAD=$(git log "main..$BRANCH" --oneline 2>/dev/null | wc -l | tr -d ' ')
        if [ "$AHEAD" = "0" ] && [ -z "$DIFF" ]; then
          # No changes — safe to remove
          git worktree remove "$wt" 2>/dev/null || true
        fi
        # If there are commits, leave the worktree for review
      fi
    fi
  done
fi

# Notify
STATUS=$(cat "${runDir}/status")
osascript -e "display notification \\"Run ${runId} \$STATUS\\" with title \\"HIVE\\" sound name \\"Glass\\"" 2>/dev/null || true
`;
}

function findClaude(): string {
  try {
    return require("child_process").execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    const fallback = join(process.env.HOME || "", ".local", "bin", "claude");
    if (existsSync(fallback)) return fallback;
    throw new UsageError("Could not find claude CLI. Is it installed?");
  }
}

export async function dispatchCommand(args: string[]): Promise<void> {
  const usage = `Usage: hive dispatch "<goal>" [--project <name>] [--ticket <id>]
       hive dispatch --ticket TK-007
       hive dispatch --plan <path-to-plan.md>`;

  if (args.length === 0) throw new UsageError(usage);

  const paths = getHivePaths();

  // Parse flags
  let goal = "";
  let projectId = "";
  let ticketId = "";
  let planPath = "";
  let timeoutMin = 30;
  // Pin dispatch to Opus 4.6. Same reasoning as heartbeat — 4.7's literal
  // instruction-following and fewer-subagents bias hurt judgment-heavy
  // autonomous work. Override via --model or HIVE_DISPATCH_MODEL env.
  let model = process.env.HIVE_DISPATCH_MODEL || "claude-opus-4-6";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) {
      projectId = args[++i]!;
    } else if (args[i] === "--ticket" && args[i + 1]) {
      ticketId = args[++i]!;
    } else if (args[i] === "--plan" && args[i + 1]) {
      planPath = resolve(args[++i]!);
    } else if (args[i] === "--timeout" && args[i + 1]) {
      timeoutMin = parseInt(args[++i]!, 10);
      if (isNaN(timeoutMin) || timeoutMin < 1) timeoutMin = 30;
    } else if (args[i] === "--model" && args[i + 1]) {
      model = args[++i]!;
    } else if (!args[i]!.startsWith("--")) {
      goal = args[i]!;
    }
  }

  if (!projectId) {
    projectId = resolveProjectFromCwd() ?? "";
  }

  if (!projectId) {
    throw new UsageError("No project found. Use --project or run from a project directory.");
  }

  // Build goal text
  let goalText = goal;

  if (ticketId) {
    const ticket = await readTicket(paths, projectId, ticketId);
    if (!ticket) throw new UsageError(`Ticket not found: ${ticketId}`);
    goalText = `Implement ticket ${ticket.id}: ${ticket.title}\n\n${formatTicketDetail(ticket)}`;
    if (goal) goalText = `${goal}\n\nTicket context:\n${formatTicketDetail(ticket)}`;
  }

  if (planPath) {
    if (!existsSync(planPath)) throw new UsageError(`Plan file not found: ${planPath}`);
    const planContent = await Bun.file(planPath).text();
    goalText = goalText
      ? `${goalText}\n\nPlan:\n${planContent}`
      : `Execute this plan:\n\n${planContent}`;
  }

  if (!goalText || !goalText.trim()) {
    throw new UsageError("No goal specified. Provide a goal string, --ticket, or --plan.");
  }
  const trimmedGoal = goalText.trim();
  if (trimmedGoal === "<goal>") {
    throw new UsageError("Goal is the literal placeholder '<goal>'. Substitute a real goal before dispatching.");
  }
  if (trimmedGoal.length < 10) {
    throw new UsageError(`Goal is too short (${trimmedGoal.length} chars). Provide a descriptive goal.`);
  }

  // Create run directory
  const runId = await nextRunId(paths.runsDir);
  const runDir = join(paths.runsDir, runId);
  await ensureDirectory(runDir);

  // Get project path for working directory
  const projectConfigPath = join(paths.projectsDir, projectId, "config.md");
  let projectPath = process.cwd();
  try {
    const raw = await Bun.file(projectConfigPath).text();
    const parsed = parseFrontmatter(raw);
    projectPath = (parsed.attributes?.path as string) ?? process.cwd();
  } catch { /* use cwd */ }

  // Write run metadata
  await Bun.write(join(runDir, "goal.md"), `# Goal\n\n${goalText}\n\n---\nProject: ${projectId}\nDispatched: ${new Date().toISOString()}\n`);
  await Bun.write(join(runDir, "status"), "running");

  // Find claude and assemble identity
  const claude = findClaude();
  const identity = await assembleIdentity();
  const identityPath = join(runDir, "identity.md");
  await Bun.write(identityPath, identity);

  // Build the message for the executor. TK-039: write to a file and cat it in
  // the wrapper — embedding the message as a bash string literal causes `set -u`
  // to abort on any `${...}` token in the goal text (common in ticket bodies
  // with shell snippets). Command substitution from a file side-steps expansion.
  const message = `Your run directory is: ${runDir}\nWrite your plan to: ${runDir}/plan.md\nProject: ${projectId}\n\nGoal:\n${goalText}`;
  const messagePath = join(runDir, "message.txt");
  await Bun.write(messagePath, message);

  // Write a wrapper script that runs claude with identity, then handles cleanup
  const wrapperPath = join(runDir, "run.sh");
  const logPath = join(runDir, "output.log");
  const hiveHome = join(process.env.HOME || "", ".hive");
  await Bun.write(wrapperPath, buildRunWrapper({
    projectPath,
    timeoutMin,
    claude,
    model,
    identityPath,
    hiveHome,
    runId,
    messagePath,
    logPath,
    runDir,
    runsDir: paths.runsDir,
  }));
  const { chmod } = await import("node:fs/promises");
  await chmod(wrapperPath, 0o755);

  // Launch the wrapper in background
  const child = spawn("/bin/bash", [wrapperPath], {
    cwd: projectPath,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ANTHROPIC_API_KEY: undefined },
  });

  child.unref();
  await Bun.write(join(runDir, "pid"), String(child.pid));

  console.log(`Dispatched ${runId} (${projectId})`);
  console.log(`  Goal: ${goalText.split("\n")[0]!.slice(0, 80)}`);
  console.log(`  Log:  ${logPath}`);
  console.log(`  PID:  ${child.pid}`);
}
