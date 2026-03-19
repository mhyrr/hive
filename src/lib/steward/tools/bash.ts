import { spawn } from "node:child_process";

import { Type } from "@mariozechner/pi-ai";

import { resolveStewardPath, truncateToolOutput, type StewardExecutionContext } from "./files";

export async function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
}> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timeoutKiller: ReturnType<typeof setTimeout> | null = null;
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      env: {
        ...process.env,
        HIVE_HOME: process.env.HIVE_HOME ?? undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    const cleanup = () => {
      if (timeoutKiller) {
        clearTimeout(timeoutKiller);
      }
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      fn();
    };

    const requestKill = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Ignore process cleanup failures.
      }

      timeoutKiller = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Ignore process cleanup failures.
        }
      }, 150);
    };

    const onAbort = () => {
      aborted = true;
      requestKill();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      requestKill();
    }, input.timeoutMs);

    input.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", (error) => {
      finish(() => {
        rejectPromise(error);
      });
    });

    child.once("close", (code) => {
      finish(() => {
        if (aborted) {
          rejectPromise(new Error("The steward command was aborted."));
          return;
        }

        if (timedOut) {
          rejectPromise(new Error(`The steward command timed out after ${input.timeoutMs}ms.`));
          return;
        }

        resolvePromise({
          stdout,
          stderr,
          exitCode: code,
        });
      });
    });
  });
}

export function createBashTool(execution: StewardExecutionContext, maxTimeoutMs = 20_000) {
  return {
    name: "bash",
    description: "Run a shell command from the repo or HIVE home when reading or editing files alone is not enough.",
    parameters: Type.Object({
      command: Type.String(),
      cwd: Type.Optional(Type.String()),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: maxTimeoutMs })),
    }),
    async execute(_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) {
      const command = String(args.command ?? "").trim();

      if (!command) {
        throw new Error("bash requires a non-empty command.");
      }

      const cwd = args.cwd
        ? resolveStewardPath(execution, String(args.cwd), execution.repoPath)
        : execution.repoPath;
      const result = await runCommand({
        command: "/bin/sh",
        args: ["-lc", command],
        cwd,
        timeoutMs: Number(args.timeoutMs ?? maxTimeoutMs),
        signal,
      });

      return truncateToolOutput(
        [
          `cwd: ${cwd}`,
          `exit: ${result.exitCode ?? "unknown"}`,
          result.stdout.trim() ? `stdout:\n${result.stdout.trimEnd()}` : "",
          result.stderr.trim() ? `stderr:\n${result.stderr.trimEnd()}` : "",
        ].filter(Boolean).join("\n\n"),
      );
    },
  };
}
