import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

import { getHivePaths, listProjects } from "./paths";
import { parseFrontmatter } from "./frontmatter";

interface SessionMeta {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
  kind: string;
  entrypoint: string;
  name: string;
}

interface ExtractedExchange {
  role: "user" | "assistant";
  text: string;
}

interface SessionSummary {
  sessionId: string;
  name: string;
  project: string;
  projectPath: string;
  durationEstimate: string;
  exchanges: ExtractedExchange[];
}

// Patterns to redact from extracted text
const REDACT_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_-]+/g,
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /Bearer [a-zA-Z0-9_.-]+/g,
  /ANTHROPIC_API_KEY=[^\s"']+/g,
  /AIza[a-zA-Z0-9_-]{30,}/g, // Google API keys
  /ghp_[a-zA-Z0-9]{36,}/g, // GitHub PATs
  /npm_[a-zA-Z0-9]{36,}/g, // npm tokens
];

function redact(text: string): string {
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

function encodeProjectPath(p: string): string {
  return p.replace(/\//g, "-");
}

/**
 * Find all session transcripts modified in the last N hours.
 */
function findRecentSessions(hoursAgo: number = 24): Map<string, string[]> {
  const claudeDir = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeDir)) return new Map();

  const cutoff = Date.now() - hoursAgo * 60 * 60 * 1000;
  const result = new Map<string, string[]>();

  const projectDirs = readdirSync(claudeDir, { withFileTypes: true })
    .filter((e) => e.isDirectory());

  for (const dir of projectDirs) {
    const projectDir = join(claudeDir, dir.name);
    const jsonlFiles = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(projectDir, f))
      .filter((f) => {
        try {
          return statSync(f).mtimeMs > cutoff;
        } catch {
          return false;
        }
      });

    if (jsonlFiles.length > 0) {
      result.set(dir.name, jsonlFiles);
    }
  }

  return result;
}

/**
 * Map a Claude projects directory name (e.g. "-Users-mhyrr-work-hive") to
 * a HIVE project name, if registered.
 */
async function resolveProjectName(encodedPath: string): Promise<string> {
  const paths = getHivePaths();
  const projects = await listProjects(paths.projectsDir);

  for (const projectId of projects) {
    try {
      const configPath = join(paths.projectsDir, projectId, "config.md");
      const raw = readFileSync(configPath, "utf-8");
      const parsed = parseFrontmatter(raw);
      const projectPath = parsed.attributes?.path as string | undefined;
      if (projectPath && encodeProjectPath(projectPath) === encodedPath) {
        return projectId;
      }
    } catch { /* skip */ }
  }

  // Fall back to the encoded path, cleaned up
  return encodedPath.replace(/^-Users-[^-]+-/, "").replace(/-/g, "/");
}

/**
 * Extract user and assistant text from a session JSONL file.
 * Skips: tool_use, tool_result, thinking, system, file-history-snapshot, progress, queue-operation
 */
function extractExchanges(jsonlPath: string): ExtractedExchange[] {
  const exchanges: ExtractedExchange[] = [];

  let content: string;
  try {
    content = readFileSync(jsonlPath, "utf-8");
  } catch {
    return [];
  }

  const lines = content.split("\n").filter((l) => l.trim());

  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    const type = obj.type;
    if (type !== "user" && type !== "assistant") continue;

    const role = obj.message?.role as "user" | "assistant" | undefined;
    if (!role) continue;

    const msgContent = obj.message?.content;
    if (!msgContent) continue;

    let text = "";

    if (typeof msgContent === "string") {
      text = msgContent;
    } else if (Array.isArray(msgContent)) {
      // Extract only text blocks, skip tool_use, tool_result, thinking
      const textParts: string[] = [];
      for (const block of msgContent) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        }
      }
      text = textParts.join("\n");
    }

    if (!text.trim()) continue;

    // Skip tool results that show up as user messages
    if (role === "user" && text.startsWith("<tool_result>")) continue;
    // Skip system reminders embedded in user messages
    if (role === "user" && text.startsWith("<system-reminder>") && !text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()) continue;
    // Skip local command scaffolding (slash commands, their expansions)
    if (role === "user" && text.startsWith("<command-name>")) continue;
    if (role === "user" && text.startsWith("<command-message>")) continue;
    if (role === "user" && text.startsWith("<local-command-")) continue;
    // Skip skill expansions (long injected prompts like /ultra, /brainstorm)
    if (role === "user" && text.startsWith("**ultrathink**")) continue;
    if (role === "user" && text.startsWith("<EXTREMELY_IMPORTANT>")) continue;
    // Strip system-reminder tags from messages that also contain real content
    if (role === "user") {
      text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
      if (!text) continue;
    }

    exchanges.push({ role, text: redact(text.trim()) });
  }

  return exchanges;
}

/**
 * Estimate session duration from first and last message timestamps.
 */
function estimateDuration(jsonlPath: string): string {
  let content: string;
  try {
    content = readFileSync(jsonlPath, "utf-8");
  } catch {
    return "unknown";
  }

  const lines = content.split("\n").filter((l) => l.trim());
  let firstTs = "";
  let lastTs = "";

  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj.timestamp) {
        if (!firstTs) firstTs = obj.timestamp;
        lastTs = obj.timestamp;
      }
    } catch {
      continue;
    }
  }

  if (!firstTs || !lastTs) return "unknown";

  const start = new Date(firstTs).getTime();
  const end = new Date(lastTs).getTime();
  const mins = Math.round((end - start) / 60000);

  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainder = mins % 60;
  return `${hours}h${remainder > 0 ? remainder + "m" : ""}`;
}

/**
 * Format a session's exchanges into readable markdown.
 * Truncates long messages and limits total output.
 */
function formatSession(summary: SessionSummary, maxChars: number = 8000): string {
  const header = `## ${summary.project} (${summary.sessionId.slice(0, 8)}) — "${summary.name}" — ${summary.durationEstimate}`;
  const lines: string[] = [header, "### Key exchanges"];

  let totalChars = header.length;

  for (const ex of summary.exchanges) {
    const label = ex.role === "user" ? "Greg" : "Maya";
    // Truncate individual messages
    const text = ex.text.length > 500 ? ex.text.slice(0, 500) + "..." : ex.text;
    const line = `- **${label}:** ${text.replace(/\n/g, " ")}`;

    totalChars += line.length;
    if (totalChars > maxChars) {
      lines.push("- *(truncated — session too long for full extraction)*");
      break;
    }

    lines.push(line);
  }

  return lines.join("\n");
}

/**
 * Main entry point: extract sessions from last 24h, write condensed markdown.
 */
export async function extractDailySessions(hoursAgo: number = 24): Promise<string> {
  const recentByProject = findRecentSessions(hoursAgo);

  if (recentByProject.size === 0) {
    return "No sessions found in the last 24 hours.";
  }

  const date = new Date().toISOString().slice(0, 10);
  const sections: string[] = [`# Sessions — ${date}\n`];
  let totalSize = 0;
  const maxTotalSize = 50000; // 50KB target

  for (const [encodedPath, jsonlFiles] of recentByProject) {
    const projectName = await resolveProjectName(encodedPath);

    // Sort by modification time, most recent first
    const sorted = jsonlFiles.sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });

    for (const file of sorted) {
      if (totalSize > maxTotalSize) break;

      const sessionId = basename(file, ".jsonl");
      const exchanges = extractExchanges(file);

      // Skip trivial sessions (< 3 exchanges)
      if (exchanges.length < 3) continue;

      const summary: SessionSummary = {
        sessionId,
        name: sessionId.slice(0, 8),
        project: projectName,
        projectPath: encodedPath,
        durationEstimate: estimateDuration(file),
        exchanges,
      };

      // Try to get session name from index files
      const sessionsDir = join(homedir(), ".claude", "sessions");
      if (existsSync(sessionsDir)) {
        const indexFiles = readdirSync(sessionsDir).filter((f) => f.endsWith(".json"));
        for (const idx of indexFiles) {
          try {
            const meta: SessionMeta = JSON.parse(readFileSync(join(sessionsDir, idx), "utf-8"));
            if (meta.sessionId === sessionId) {
              summary.name = meta.name || sessionId.slice(0, 8);
              break;
            }
          } catch { /* skip */ }
        }
      }

      const formatted = formatSession(summary);
      totalSize += formatted.length;
      sections.push(formatted);
    }
  }

  return sections.join("\n\n");
}

/**
 * Write the condensed sessions file to the daily directory.
 */
export async function writeDailySessions(hoursAgo: number = 24): Promise<string> {
  const paths = getHivePaths();
  const date = new Date().toISOString().slice(0, 10);
  const outputPath = join(paths.memoryDailyDir, `sessions-${date}.md`);

  const content = await extractDailySessions(hoursAgo);
  await Bun.write(outputPath, content);

  return outputPath;
}
