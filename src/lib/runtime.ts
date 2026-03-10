import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { UsageError } from "./errors";
import { PlanAgent, TeamAgent } from "./project";

export type RuntimeName = "codex" | "claude";

export type LaunchSpec = {
  runtime: RuntimeName;
  model: string | null;
  command: string;
  args: string[];
};

export type LaunchResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  visibleOutput: string;
};

export type LaunchHandle = {
  pid: number | null;
  wait: () => Promise<LaunchResult>;
};

export type RuntimeHints = {
  runtime: RuntimeName;
  model: string | null;
};

type ResolveHintsInput = {
  globalConfig: string;
  teamAgent?: TeamAgent | null;
  planAgent?: PlanAgent | null;
  runtimeOverride?: string | null;
  modelOverride?: string | null;
};

function extractConfigValue(input: string, key: string): string | null {
  const match = input.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));

  return match ? match[1].trim() : null;
}

function extractBodyValue(input: string, key: string): string | null {
  const match = input.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));

  return match ? match[1].trim() : null;
}

function normalizeRuntimeName(value: string | null | undefined): RuntimeName | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  switch (normalized) {
    case "codex":
    case "openai":
      return "codex";
    case "claude":
    case "claude-code":
      return "claude";
    default:
      return null;
  }
}

function extractRuntimeFromDescriptor(descriptor: string): RuntimeName | null {
  const match = descriptor.match(/\bvia\s+([a-z0-9._-]+)\b/i);

  return normalizeRuntimeName(match ? match[1] : null);
}

function extractModelFromDescriptor(descriptor: string): string | null {
  const match = descriptor.match(/,\s*([^,]+?)\s+via\s+[a-z0-9._-]+\b/i);

  return match ? match[1].trim() : null;
}

function selectModel(
  globalConfig: string,
  teamAgent?: TeamAgent | null,
  planAgent?: PlanAgent | null,
  modelOverride?: string | null,
): string | null {
  if (modelOverride?.trim()) {
    return modelOverride.trim();
  }

  const planBodyModel = planAgent ? extractBodyValue(planAgent.body, "model") : null;
  const planDescriptorModel = planAgent ? extractModelFromDescriptor(planAgent.descriptor) : null;
  const teamDescriptorModel = teamAgent ? extractModelFromDescriptor(teamAgent.descriptor) : null;

  return (
    planBodyModel ??
    planDescriptorModel ??
    teamDescriptorModel ??
    extractConfigValue(globalConfig, "model")
  );
}

function selectRuntime(
  globalConfig: string,
  teamAgent?: TeamAgent | null,
  planAgent?: PlanAgent | null,
  runtimeOverride?: string | null,
): RuntimeName {
  const candidates = [
    runtimeOverride,
    planAgent ? extractBodyValue(planAgent.body, "runtime") : null,
    planAgent ? extractRuntimeFromDescriptor(planAgent.descriptor) : null,
    teamAgent ? extractRuntimeFromDescriptor(teamAgent.descriptor) : null,
    extractConfigValue(globalConfig, "runtime"),
  ];

  for (const candidate of candidates) {
    const runtime = normalizeRuntimeName(candidate);

    if (runtime) {
      return runtime;
    }
  }

  throw new UsageError(
    "Unsupported or missing runtime. Use `--runtime codex|claude` or set `runtime:` in ~/.hive/config.md or the project team descriptor.",
  );
}

export function resolveRuntimeHints(input: ResolveHintsInput): RuntimeHints {
  return {
    runtime: selectRuntime(
      input.globalConfig,
      input.teamAgent,
      input.planAgent,
      input.runtimeOverride,
    ),
    model: selectModel(
      input.globalConfig,
      input.teamAgent,
      input.planAgent,
      input.modelOverride,
    ),
  };
}

export function buildLaunchSpec(input: {
  runtime: RuntimeName;
  model: string | null;
  repoPath: string;
  hiveHome: string;
  prompt: string;
}): LaunchSpec {
  switch (input.runtime) {
    case "codex":
      return {
        runtime: input.runtime,
        model: input.model,
        command: "codex",
        args: [
          "exec",
          "--full-auto",
          "-C",
          input.repoPath,
          "--add-dir",
          input.hiveHome,
          ...(input.model ? ["--model", input.model] : []),
          input.prompt,
        ],
      };
    case "claude":
      return {
        runtime: input.runtime,
        model: input.model,
        command: "claude",
        args: [
          "--print",
          "--permission-mode",
          "bypassPermissions",
          "--add-dir",
          input.hiveHome,
          ...(input.model ? ["--model", input.model] : []),
          input.prompt,
        ],
      };
  }
}

export function renderLaunchPreview(spec: LaunchSpec): string {
  return [
    spec.command,
    ...spec.args.map((arg) => {
      if (arg.includes("\n") || arg.length > 120) {
        return "<PROMPT>";
      }

      return /\s/.test(arg) ? JSON.stringify(arg) : arg;
    }),
  ].join(" ");
}

export function shouldSuppressRuntimeLine(runtime: RuntimeName, line: string): boolean {
  const trimmed = line.trim();

  if (!trimmed) {
    return false;
  }

  if (runtime === "codex") {
    return (
      trimmed === "mcp startup: no servers" ||
      /WARN codex_core::state_db: state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back\b/.test(
        trimmed,
      ) ||
      /ERROR codex_core::rollout::list: state db missing rollout path for thread\b/.test(
        trimmed,
      )
    );
  }

  return false;
}

function createForwarder(
  runtime: RuntimeName,
  stream: NodeJS.WriteStream,
  onLine: (line: string) => void,
) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const flushLine = (line: string) => {
    if (!shouldSuppressRuntimeLine(runtime, line)) {
      stream.write(`${line}\n`);
      onLine(line);
    }
  };

  return {
    write(chunk: Buffer) {
      buffer += decoder.write(chunk);

      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        flushLine(line);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
      }
    },
    end() {
      buffer += decoder.end();

      if (buffer) {
        flushLine(buffer.replace(/\r$/, ""));
        buffer = "";
      }
    },
  };
}

export function startLaunchSpec(
  spec: LaunchSpec,
  repoPath: string,
): LaunchHandle {
  const child = spawn(spec.command, spec.args, {
    cwd: repoPath,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const visibleLines: string[] = [];
  const captureLine = (line: string) => {
    visibleLines.push(line);

    if (visibleLines.length > 40) {
      visibleLines.shift();
    }
  };
  const stdoutForwarder = createForwarder(spec.runtime, process.stdout, captureLine);
  const stderrForwarder = createForwarder(spec.runtime, process.stderr, captureLine);

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutForwarder.write(chunk);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    stderrForwarder.write(chunk);
  });

  return {
    pid: child.pid ?? null,
    wait: async () => {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (exitCode) => resolve(exitCode));
      });

      stdoutForwarder.end();
      stderrForwarder.end();

      return {
        code,
        signal: child.signalCode ?? null,
        visibleOutput: visibleLines.join("\n").trim(),
      };
    },
  };
}

export async function runLaunchSpec(
  spec: LaunchSpec,
  repoPath: string,
): Promise<LaunchResult> {
  return startLaunchSpec(spec, repoPath).wait();
}
