import { mkdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { Type } from "@mariozechner/pi-ai";

export type StewardExecutionContext = {
  hiveHome: string;
  repoPath: string;
  allowedRoots: string[];
};

function isWithinRoot(path: string, root: string): boolean {
  const relation = relative(root, path);

  return relation === "" || (!relation.startsWith("..") && relation !== "");
}

export function createStewardExecutionContext(input: {
  hiveHome: string;
  repoPath: string;
}): StewardExecutionContext {
  return {
    hiveHome: input.hiveHome,
    repoPath: input.repoPath,
    allowedRoots: [...new Set([resolve(input.repoPath), resolve(input.hiveHome)])],
  };
}

export function resolveStewardPath(
  execution: StewardExecutionContext,
  requestedPath: string,
  cwd = execution.repoPath,
): string {
  const trimmed = requestedPath.trim();

  if (!trimmed) {
    throw new Error("A non-empty path is required.");
  }

  const candidate = resolve(cwd, trimmed);

  if (!execution.allowedRoots.some((root) => isWithinRoot(candidate, root))) {
    throw new Error(`Path escapes the steward workspace: ${candidate}`);
  }

  return candidate;
}

function normalizeMultilineText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export function truncateToolOutput(value: string, maxChars = 12_000): string {
  const normalized = normalizeMultilineText(value);

  if (!normalized) {
    return "(empty)";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  const headLength = Math.max(200, Math.floor((maxChars - 40) / 2));
  const tailLength = Math.max(120, maxChars - headLength - 40);

  return [
    normalized.slice(0, headLength).trimEnd(),
    "",
    "[... steward tool output truncated ...]",
    "",
    normalized.slice(-tailLength).trimStart(),
  ].join("\n");
}

function countMatches(text: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  let count = 0;
  let cursor = 0;

  while (true) {
    const matchIndex = text.indexOf(needle, cursor);

    if (matchIndex === -1) {
      return count;
    }

    count += 1;
    cursor = matchIndex + needle.length;
  }
}

export function createFileTools(execution: StewardExecutionContext) {
  return [
    {
      name: "read",
      description: "Read a file from the repo or HIVE home. Use absolute paths when possible.",
      parameters: Type.Object({
        path: Type.String(),
        startLine: Type.Optional(Type.Integer({ minimum: 1 })),
        endLine: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const path = resolveStewardPath(execution, String(args.path ?? ""));
        const file = Bun.file(path);

        if (!(await file.exists())) {
          throw new Error(`File not found: ${path}`);
        }

        const text = (await file.text()).replace(/\r\n/g, "\n");
        const lines = text.split("\n");
        const startLine = Math.min(lines.length || 1, Math.max(1, Number(args.startLine ?? 1)));
        const defaultEnd = Math.min(lines.length || startLine, startLine + 199);
        const endLine = Math.min(
          lines.length || startLine,
          Math.max(startLine, Number(args.endLine ?? defaultEnd)),
        );
        const selected = lines
          .slice(startLine - 1, endLine)
          .map((line, index) => `${startLine + index}| ${line}`);

        return truncateToolOutput(
          [`path: ${path}`, `lines: ${startLine}-${endLine} of ${lines.length}`, "", selected.join("\n")].join("\n"),
        );
      },
    },
    {
      name: "write",
      description: "Write a full file in the repo or HIVE home. This overwrites existing content.",
      parameters: Type.Object({
        path: Type.String(),
        content: Type.String(),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const path = resolveStewardPath(execution, String(args.path ?? ""));
        const content = String(args.content ?? "");

        await mkdir(dirname(path), { recursive: true });
        await Bun.write(path, content);

        return `Wrote ${content.length} bytes to ${path}.`;
      },
    },
    {
      name: "edit",
      description: "Edit an existing file by replacing exact text. Set replaceAll true only when every match should change.",
      parameters: Type.Object({
        path: Type.String(),
        oldText: Type.String(),
        newText: Type.String(),
        replaceAll: Type.Optional(Type.Boolean()),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const path = resolveStewardPath(execution, String(args.path ?? ""));
        const oldText = String(args.oldText ?? "");
        const newText = String(args.newText ?? "");
        const replaceAll = args.replaceAll === true;
        const file = Bun.file(path);

        if (!(await file.exists())) {
          throw new Error(`File not found: ${path}`);
        }

        if (!oldText) {
          throw new Error("edit requires a non-empty oldText.");
        }

        const current = await file.text();
        const matches = countMatches(current, oldText);

        if (matches === 0) {
          throw new Error(`oldText was not found in ${path}.`);
        }

        if (matches > 1 && !replaceAll) {
          throw new Error(
            `oldText matched ${matches} times in ${path}. Set replaceAll: true or provide a more specific snippet.`,
          );
        }

        const next = replaceAll
          ? current.split(oldText).join(newText)
          : current.replace(oldText, newText);

        await Bun.write(path, next);

        return `Edited ${path} (${replaceAll ? `${matches} replacements` : "1 replacement"}).`;
      },
    },
  ];
}
