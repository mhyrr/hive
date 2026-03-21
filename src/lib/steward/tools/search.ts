import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import { Type } from "@mariozechner/pi-ai";

import { runCommand } from "./bash";
import { resolveStewardPath, truncateToolOutput, type StewardExecutionContext } from "./files";

async function renderDirectoryTree(input: {
  rootPath: string;
  depth: number;
  includeHidden: boolean;
  maxEntries: number;
}): Promise<string> {
  const lines: string[] = [];
  let emitted = 0;

  const walk = async (currentPath: string, currentDepth: number, prefix: string): Promise<void> => {
    if (emitted >= input.maxEntries || currentDepth < 0) {
      return;
    }

    let entries = await readdir(currentPath, { withFileTypes: true });
    entries = entries
      .filter((entry) => input.includeHidden || !entry.name.startsWith("."))
      .sort((left, right) => {
        if (left.isDirectory() && !right.isDirectory()) {
          return -1;
        }

        if (!left.isDirectory() && right.isDirectory()) {
          return 1;
        }

        return left.name.localeCompare(right.name);
      });

    for (const entry of entries) {
      if (emitted >= input.maxEntries) {
        lines.push(`${prefix}…`);
        return;
      }

      emitted += 1;
      lines.push(`${prefix}${entry.isDirectory() ? `${entry.name}/` : entry.name}`);

      if (entry.isDirectory() && currentDepth > 0) {
        await walk(join(currentPath, entry.name), currentDepth - 1, `${prefix}  `);
      }
    }
  };

  try {
    await readdir(input.rootPath);
  } catch {
    return input.rootPath;
  }

  await walk(input.rootPath, input.depth, "");
  return lines.length > 0 ? lines.join("\n") : "(empty)";
}

async function runNameSearch(input: {
  rootPath: string;
  query: string;
  type: "file" | "dir" | "any";
  maxResults: number;
}): Promise<string[]> {
  const matches: string[] = [];
  const normalizedQuery = input.query.trim().toLowerCase();

  const walk = async (currentPath: string): Promise<void> => {
    if (matches.length >= input.maxResults) {
      return;
    }

    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
      if (matches.length >= input.maxResults) {
        return;
      }

      if (entry.name.startsWith(".")) {
        continue;
      }

      const nextPath = join(currentPath, entry.name);
      const kind =
        entry.isDirectory()
          ? "dir"
          : entry.isFile()
            ? "file"
            : "any";
      const relativePath = relative(input.rootPath, nextPath) || entry.name;
      const matchesKind = input.type === "any" || input.type === kind;
      const matchesQuery =
        !normalizedQuery ||
        relativePath.toLowerCase().includes(normalizedQuery) ||
        entry.name.toLowerCase().includes(normalizedQuery);

      if (matchesKind && matchesQuery) {
        matches.push(relativePath);
      }

      if (entry.isDirectory()) {
        await walk(nextPath);
      }
    }
  };

  await walk(input.rootPath);
  return matches;
}

export function createSearchTools(execution: StewardExecutionContext, maxTimeoutMs = 20_000) {
  return [
    {
      name: "ls",
      description: "List files or directories beneath a path.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
        depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
        includeHidden: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const path = resolveStewardPath(execution, String(args.path ?? execution.repoPath));
        const tree = await renderDirectoryTree({
          rootPath: path,
          depth: Number(args.depth ?? 2),
          includeHidden: args.includeHidden === true,
          maxEntries: 160,
        });

        return truncateToolOutput([`path: ${path}`, "", tree].join("\n"));
      },
    },
    {
      name: "find",
      description: "Find files or directories by name substring.",
      parameters: Type.Object({
        path: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
        type: Type.Optional(Type.Union([
          Type.Literal("file"),
          Type.Literal("dir"),
          Type.Literal("any"),
        ])),
        maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const path = resolveStewardPath(execution, String(args.path ?? execution.repoPath));
        const matches = await runNameSearch({
          rootPath: path,
          query: typeof args.query === "string" ? args.query : "",
          type:
            args.type === "file" || args.type === "dir" || args.type === "any"
              ? args.type
              : "any",
          maxResults: Number(args.maxResults ?? 40),
        });

        return truncateToolOutput(
          [`path: ${path}`, "", matches.length > 0 ? matches.join("\n") : "(no matches)"].join("\n"),
        );
      },
    },
    {
      name: "grep",
      description: "Search file contents with ripgrep. Use this before broad reads when you only need a few facts.",
      parameters: Type.Object({
        pattern: Type.String(),
        path: Type.Optional(Type.String()),
        contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
        maxMatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>, signal?: AbortSignal) {
        const pattern = String(args.pattern ?? "").trim();

        if (!pattern) {
          throw new Error("grep requires a non-empty pattern.");
        }

        const path = resolveStewardPath(execution, String(args.path ?? execution.repoPath));
        const result = await runCommand({
          command: "rg",
          args: [
            "-n",
            "--hidden",
            "--no-heading",
            "--color",
            "never",
            "-C",
            String(Number(args.contextLines ?? 1)),
            "--max-count",
            String(Number(args.maxMatches ?? 40)),
            pattern,
            path,
          ],
          cwd: execution.repoPath,
          timeoutMs: maxTimeoutMs,
          signal,
        }).catch(async (error) => {
          if (!(error instanceof Error) || !/ENOENT/i.test(error.message)) {
            throw error;
          }

          return runCommand({
            command: "grep",
            args: ["-R", "-n", pattern, path],
            cwd: execution.repoPath,
            timeoutMs: maxTimeoutMs,
            signal,
          });
        });

        if (result.exitCode === 1 && !result.stdout.trim()) {
          return "(no matches)";
        }

        return truncateToolOutput(result.stdout || result.stderr || `(exit ${result.exitCode ?? "unknown"})`);
      },
    },
  ];
}
