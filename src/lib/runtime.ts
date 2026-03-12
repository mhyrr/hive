import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";

import { UsageError } from "./errors";
import { PlanAgent, TeamAgent } from "./project";

// --- Runtime Adapter Interface ---

export type RuntimeMetadata = {
  costUsd: number | null;
  durationMs: number | null;
  durationApiMs: number | null;
  numTurns: number | null;
  sessionId: string | null;
};

export type ParsedOutput = {
  text: string;
  metadata: RuntimeMetadata | null;
};

export type RuntimeAdapter = {
  name: string;
  aliases: string[];
  command: string;
  buildLaunchArgs: (input: {
    model: string | null;
    repoPath: string;
    hiveHome: string;
    prompt: string;
  }) => string[];
  buildInteractiveArgs: (input: {
    model: string | null;
    repoPath: string;
    hiveHome: string;
    systemPrompt: string;
  }) => string[];
  suppressLine: (line: string) => boolean;
  detectInstalled: () => Promise<boolean>;
  parseOutput?: (rawStdout: string) => ParsedOutput;
};

// --- Built-in Adapters ---

const claudeAdapter: RuntimeAdapter = {
  name: "claude",
  aliases: ["claude-code"],
  command: "claude",
  buildLaunchArgs: ({ model, hiveHome, prompt }) => [
    "--print",
    "--output-format",
    "json",
    "--permission-mode",
    "bypassPermissions",
    "--add-dir",
    hiveHome,
    ...(model ? ["--model", model] : []),
    prompt,
  ],
  buildInteractiveArgs: ({ model, hiveHome, systemPrompt }) => [
    "--permission-mode",
    "bypassPermissions",
    "--add-dir",
    hiveHome,
    ...(model ? ["--model", model] : []),
    "--system-prompt",
    systemPrompt,
  ],
  suppressLine: () => false,
  detectInstalled: () => commandExists("claude"),
  parseOutput: (rawStdout: string) => {
    const trimmed = rawStdout.trim();

    // Try to parse the last non-empty line as JSON (Claude --print --output-format json)
    const lines = trimmed.split("\n");
    let jsonStr = trimmed;

    // If there are multiple lines, try the last line first (JSON is usually on one line)
    if (lines.length > 1) {
      const lastLine = lines[lines.length - 1]!.trim();

      if (lastLine.startsWith("{")) {
        jsonStr = lastLine;
      }
    }

    try {
      const data = JSON.parse(jsonStr);

      return {
        text: typeof data.result === "string" ? data.result : trimmed,
        metadata: {
          costUsd:
            typeof data.cost_usd === "number"
              ? data.cost_usd
              : typeof data.total_cost_usd === "number"
                ? data.total_cost_usd
                : null,
          durationMs: typeof data.duration_ms === "number" ? data.duration_ms : null,
          durationApiMs: typeof data.duration_api_ms === "number" ? data.duration_api_ms : null,
          numTurns: typeof data.num_turns === "number" ? data.num_turns : null,
          sessionId: typeof data.session_id === "string" ? data.session_id : null,
        },
      };
    } catch {
      return { text: trimmed, metadata: null };
    }
  },
};

const codexAdapter: RuntimeAdapter = {
  name: "codex",
  aliases: ["openai"],
  command: "codex",
  buildLaunchArgs: ({ model, repoPath, hiveHome, prompt }) => [
    "exec",
    "--full-auto",
    "-C",
    repoPath,
    "--add-dir",
    hiveHome,
    ...(model ? ["--model", model] : []),
    prompt,
  ],
  buildInteractiveArgs: ({ model, repoPath, hiveHome, systemPrompt }) => [
    "--full-auto",
    "-C",
    repoPath,
    "--add-dir",
    hiveHome,
    ...(model ? ["--model", model] : []),
    systemPrompt,
  ],
  suppressLine: (line: string) => {
    const trimmed = line.trim();

    if (!trimmed) {
      return false;
    }

    return (
      trimmed === "mcp startup: no servers" ||
      /WARN codex_core::state_db: state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back\b/.test(
        trimmed,
      ) ||
      /ERROR codex_core::rollout::list: state db missing rollout path for thread\b/.test(
        trimmed,
      )
    );
  },
  detectInstalled: () => commandExists("codex"),
};

const geminiAdapter: RuntimeAdapter = {
  name: "gemini",
  aliases: ["gemini-cli", "google"],
  command: "gemini",
  buildLaunchArgs: ({ model, repoPath, prompt }) => [
    "-C",
    repoPath,
    ...(model ? ["--model", model] : []),
    prompt,
  ],
  buildInteractiveArgs: ({ model, repoPath }) => [
    "-C",
    repoPath,
    ...(model ? ["--model", model] : []),
  ],
  suppressLine: () => false,
  detectInstalled: () => commandExists("gemini"),
};

// --- Registry ---

const builtinAdapters: RuntimeAdapter[] = [claudeAdapter, codexAdapter, geminiAdapter];

function buildRegistry(adapters: RuntimeAdapter[]): Map<string, RuntimeAdapter> {
  const map = new Map<string, RuntimeAdapter>();

  for (const adapter of adapters) {
    map.set(adapter.name, adapter);

    for (const alias of adapter.aliases) {
      map.set(alias, adapter);
    }
  }

  return map;
}

const registry = buildRegistry(builtinAdapters);

// --- Public Registry API ---

export function getAdapter(name: string): RuntimeAdapter | null {
  return registry.get(name.trim().toLowerCase()) ?? null;
}

export function listRuntimeAdapters(): RuntimeAdapter[] {
  return [...builtinAdapters];
}

// --- Utility ---

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", cmd], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await proc.exited;

    return code === 0;
  } catch {
    return false;
  }
}

// --- Types (backward compatible) ---

export type RuntimeName = string;

export type LaunchSpec = {
  runtime: string;
  model: string | null;
  command: string;
  args: string[];
};

export type LaunchResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  visibleOutput: string;
  metadata: RuntimeMetadata | null;
};

export type InteractiveResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type InteractiveHandle = {
  pid: number | null;
  wait: () => Promise<InteractiveResult>;
};

export type LaunchHandle = {
  pid: number | null;
  wait: () => Promise<LaunchResult>;
};

type LaunchHandleOptions = {
  outputPath?: string | null;
  quiet?: boolean;
};

export type RuntimeHints = {
  runtime: string;
  model: string | null;
};

type ResolveHintsInput = {
  globalConfig: string;
  teamAgent?: TeamAgent | null;
  planAgent?: PlanAgent | null;
  runtimeOverride?: string | null;
  modelOverride?: string | null;
};

// --- Config / Descriptor Helpers ---

function extractConfigValue(input: string, key: string): string | null {
  const match = input.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));

  return match ? match[1].trim() : null;
}

function extractBodyValue(input: string, key: string): string | null {
  const match = input.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));

  return match ? match[1].trim() : null;
}

function normalizeRuntimeName(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const adapter = getAdapter(value);

  return adapter ? adapter.name : null;
}

function extractRuntimeFromDescriptor(descriptor: string): string | null {
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
): string {
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

  const available = builtinAdapters.map((a) => a.name).join("|");

  throw new UsageError(
    `Unsupported or missing runtime. Use \`--runtime ${available}\` or set \`runtime:\` in ~/.hive/config.md or the project team descriptor.`,
  );
}

// --- Public API ---

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

export async function validateRuntimeInstalled(runtime: string): Promise<void> {
  const adapter = getAdapter(runtime);

  if (!adapter) {
    throw new UsageError(`Unknown runtime: ${runtime}`);
  }

  const installed = await adapter.detectInstalled();

  if (!installed) {
    throw new UsageError(
      `Runtime '${runtime}' is not installed (command '${adapter.command}' not found). Run \`hive runtimes\` to see available runtimes.`,
    );
  }
}

export function buildLaunchSpec(input: {
  runtime: string;
  model: string | null;
  repoPath: string;
  hiveHome: string;
  prompt: string;
}): LaunchSpec {
  const adapter = getAdapter(input.runtime);

  if (!adapter) {
    throw new UsageError(`Unknown runtime: ${input.runtime}`);
  }

  return {
    runtime: adapter.name,
    model: input.model,
    command: adapter.command,
    args: adapter.buildLaunchArgs({
      model: input.model,
      repoPath: input.repoPath,
      hiveHome: input.hiveHome,
      prompt: input.prompt,
    }),
  };
}

export function buildInteractiveLaunchSpec(input: {
  runtime: string;
  model: string | null;
  repoPath: string;
  hiveHome: string;
  systemPrompt: string;
}): LaunchSpec {
  const adapter = getAdapter(input.runtime);

  if (!adapter) {
    throw new UsageError(`Unknown runtime: ${input.runtime}`);
  }

  return {
    runtime: adapter.name,
    model: input.model,
    command: adapter.command,
    args: adapter.buildInteractiveArgs({
      model: input.model,
      repoPath: input.repoPath,
      hiveHome: input.hiveHome,
      systemPrompt: input.systemPrompt,
    }),
  };
}

export function startInteractiveSession(
  spec: LaunchSpec,
  repoPath: string,
): InteractiveHandle {
  const child = spawn(spec.command, spec.args, {
    stdio: "inherit",
    cwd: repoPath,
    env: cleanEnvForRuntime(),
  });

  return {
    pid: child.pid ?? null,
    wait: () =>
      new Promise((resolve) => {
        child.on("exit", (code, signal) => resolve({ code, signal }));
        child.on("error", () => resolve({ code: 1, signal: null }));
      }),
  };
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

export function shouldSuppressRuntimeLine(runtime: string, line: string): boolean {
  const trimmed = line.trim();

  if (!trimmed) {
    return false;
  }

  const adapter = getAdapter(runtime);

  if (!adapter) {
    return false;
  }

  return adapter.suppressLine(trimmed);
}

function createForwarder(
  runtime: string,
  stream: NodeJS.WriteStream | null,
  onLine: (line: string) => void,
) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";

  const flushLine = (line: string) => {
    if (!shouldSuppressRuntimeLine(runtime, line)) {
      stream?.write(`${line}\n`);
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

function cleanEnvForRuntime(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Prevent nested-session detection in Claude Code
  delete env.CLAUDECODE;
  // Strip API key so Claude Code uses subscription auth (OAuth) instead of API credits
  delete env.ANTHROPIC_API_KEY;
  return env;
}

export function startLaunchSpec(
  spec: LaunchSpec,
  repoPath: string,
  options: LaunchHandleOptions = {},
): LaunchHandle {
  const adapter = getAdapter(spec.runtime);
  const hasJsonOutput = !!adapter?.parseOutput;
  const child = spawn(spec.command, spec.args, {
    cwd: repoPath,
    stdio: ["inherit", "pipe", "pipe"],
    env: cleanEnvForRuntime(),
  });
  const visibleLines: string[] = [];
  const stdoutLines: string[] = [];
  const outputStream = options.outputPath
    ? createWriteStream(options.outputPath, { flags: "a" })
    : null;
  const captureLine = (line: string) => {
    visibleLines.push(line);

    if (visibleLines.length > 40) {
      visibleLines.shift();
    }

    outputStream?.write(`${line}\n`);
  };
  const captureStdoutLine = (line: string) => {
    stdoutLines.push(line);
    captureLine(line);
  };
  // Suppress live stdout forwarding for JSON-output adapters (raw JSON isn't useful in terminal)
  const suppressLive = options.quiet || hasJsonOutput;
  const stdoutForwarder = createForwarder(spec.runtime, suppressLive ? null : process.stdout, captureStdoutLine);
  const stderrForwarder = createForwarder(spec.runtime, suppressLive ? null : process.stderr, captureLine);

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
      outputStream?.end();

      if (adapter?.parseOutput) {
        const rawStdout = stdoutLines.join("\n").trim();
        const parsed = adapter.parseOutput(rawStdout);

        return {
          code,
          signal: child.signalCode ?? null,
          visibleOutput: parsed.text,
          metadata: parsed.metadata,
        };
      }

      return {
        code,
        signal: child.signalCode ?? null,
        visibleOutput: visibleLines.join("\n").trim(),
        metadata: null,
      };
    },
  };
}

export async function runLaunchSpec(
  spec: LaunchSpec,
  repoPath: string,
  options?: LaunchHandleOptions,
): Promise<LaunchResult> {
  return startLaunchSpec(spec, repoPath, options).wait();
}
