/**
 * The normalized transcript layer — the format-agnostic foundation for taste
 * extraction (design §2). Both harness parsers emit `TranscriptEvent[]`;
 * everything downstream reads events and nothing downstream knows what a
 * `.jsonl` looks like.
 *
 * This *widens* the substrate that `sessions.ts` already discovers and
 * redacts — it does not migrate the fact pipeline. `sessions.ts` keeps owning
 * session discovery, project resolution, and secret redaction; this module
 * owns the richer per-line parse that keeps the four things the lossy
 * `ExtractedExchange` projection throws away: adjacency/order, timestamps,
 * stable anchors, and tool/thinking events.
 */
import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";

import {
  extractTextFromContent,
  findRecentSessions,
  readCodexCwd,
  redact,
  resolveProjectName,
  shouldSkipUserText,
  type RecentSessionBundle,
  type SessionSource,
} from "./sessions";

// ---------------------------------------------------------------------------
// The normalized model (design §2.2)
// ---------------------------------------------------------------------------

export type EventKind =
  | "message" // user/assistant prose
  | "thinking" // assistant reasoning block
  | "tool_use" // an edit/write/bash/etc. the assistant invoked
  | "tool_result" // its result (incl. errors, diffs)
  | "meta"; // session_meta, summaries, command scaffolding

export type EventRole = "user" | "assistant" | "tool" | "system";

export interface EventAnchor {
  /** Provenance + the immutable-evidence key. */
  sessionFile: string;
  /** Claude uuid (or block-suffixed); Codex "<file>#L<line>" or call_id. */
  id: string;
  /** 1-based ordinal within the file. Always available. */
  line: number;
  /** ISO-8601 if present, else null. */
  ts: string | null;
}

export interface ToolInfo {
  /** "Edit" | "Write" | "Bash" | "exec_command" | "apply_patch" | ... */
  name: string;
  /** File path or working dir, for redo/rewrite detection. */
  target?: string;
  /** Short, redacted; not the full payload. */
  summary: string;
  /** Set on tool_result events whose tool failed. */
  isError?: boolean;
}

export interface TranscriptEvent {
  anchor: EventAnchor;
  /** Claude parentUuid; Codex = prior event id (reconstructed). */
  parentId: string | null;
  source: SessionSource;
  /** Resolved HIVE project (reuses sessions.ts). May be a synthesized path. */
  project: string;
  role: EventRole;
  kind: EventKind;
  /** Present when kind = tool_use / tool_result. */
  tool?: ToolInfo;
  /** Redacted, normalized; "" for pure tool events. */
  text: string;
}

export interface ParseContext {
  sessionFile: string;
  source: SessionSource;
  project: string;
}

export type TranscriptParser = (
  obj: any,
  ctx: ParseContext,
  lineNo: number,
) => TranscriptEvent[];

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const MAX_SUMMARY = 280;

function truncate(s: string, max = MAX_SUMMARY): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Strip <system-reminder> blocks from user prose, as extractExchanges does. */
function cleanUserText(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
}

// ---------------------------------------------------------------------------
// Claude parser
// ---------------------------------------------------------------------------

function claudeTarget(name: string, input: any): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.notebook_path === "string") return input.notebook_path;
  if (typeof input.path === "string") return input.path;
  return undefined;
}

function claudeToolSummary(name: string, input: any, target?: string): string {
  if (name === "Bash" && input && typeof input.command === "string") {
    return truncate(`Bash: ${input.command}`);
  }
  if (target) return truncate(`${name} ${target}`);
  if (input && typeof input === "object") {
    return truncate(`${name}: ${JSON.stringify(input)}`);
  }
  return name;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "string") parts.push(block);
      else if (block && typeof block === "object") {
        const t = (block as { text?: unknown }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    return parts.join("\n");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return content == null ? "" : String(content);
}

export const parseClaudeTranscript: TranscriptParser = (obj, ctx, lineNo) => {
  const type = obj?.type;
  if (type !== "user" && type !== "assistant") return []; // meta lines dropped in phase 1

  const baseId: string =
    typeof obj.uuid === "string" && obj.uuid
      ? obj.uuid
      : `${ctx.sessionFile}#L${lineNo}`;
  const parentId: string | null =
    typeof obj.parentUuid === "string" ? obj.parentUuid : null;
  const ts: string | null = typeof obj.timestamp === "string" ? obj.timestamp : null;
  const msgRole = obj.message?.role;
  const content = obj.message?.content;

  const anchor = (idSuffix: string): EventAnchor => ({
    sessionFile: ctx.sessionFile,
    id: idSuffix ? `${baseId}#${idSuffix}` : baseId,
    line: lineNo,
    ts,
  });

  // Content is either a raw string (always prose) or an array of typed blocks.
  if (typeof content === "string") {
    const role: EventRole = msgRole === "assistant" ? "assistant" : "user";
    let text = content;
    if (role === "user") {
      if (shouldSkipUserText(text)) return [];
      text = cleanUserText(text);
    }
    if (!text.trim()) return [];
    return [
      {
        anchor: anchor(""),
        parentId,
        source: ctx.source,
        project: ctx.project,
        role,
        kind: "message",
        text: redact(text.trim()),
      },
    ];
  }

  if (!Array.isArray(content)) return [];

  const events: TranscriptEvent[] = [];
  let blockIdx = 0;
  for (const block of content) {
    blockIdx++;
    if (!block || typeof block !== "object") continue;
    const btype = (block as { type?: unknown }).type;

    if (btype === "text") {
      const raw = (block as { text?: unknown }).text;
      if (typeof raw !== "string" || !raw.trim()) continue;
      const role: EventRole = msgRole === "assistant" ? "assistant" : "user";
      let text = raw;
      if (role === "user") {
        if (shouldSkipUserText(text)) continue;
        text = cleanUserText(text);
      }
      if (!text.trim()) continue;
      events.push({
        anchor: anchor(content.length > 1 ? `b${blockIdx}` : ""),
        parentId,
        source: ctx.source,
        project: ctx.project,
        role,
        kind: "message",
        text: redact(text.trim()),
      });
    } else if (btype === "thinking") {
      const raw = (block as { thinking?: unknown }).thinking;
      if (typeof raw !== "string" || !raw.trim()) continue; // empty thinking = noise
      events.push({
        anchor: anchor(`think${blockIdx}`),
        parentId,
        source: ctx.source,
        project: ctx.project,
        role: "assistant",
        kind: "thinking",
        text: redact(raw.trim()),
      });
    } else if (btype === "tool_use") {
      const name = String((block as { name?: unknown }).name ?? "tool");
      const input = (block as { input?: unknown }).input;
      const toolId = (block as { id?: unknown }).id;
      const target = claudeTarget(name, input);
      events.push({
        anchor: {
          sessionFile: ctx.sessionFile,
          id: typeof toolId === "string" && toolId ? toolId : `${baseId}#u${blockIdx}`,
          line: lineNo,
          ts,
        },
        parentId,
        source: ctx.source,
        project: ctx.project,
        role: "assistant",
        kind: "tool_use",
        tool: {
          name,
          target: target ? redact(target) : undefined,
          summary: redact(claudeToolSummary(name, input, target)),
        },
        text: "",
      });
    } else if (btype === "tool_result") {
      const refId = (block as { tool_use_id?: unknown }).tool_use_id;
      const isError = (block as { is_error?: unknown }).is_error === true;
      const summary = truncate(stringifyContent((block as { content?: unknown }).content));
      events.push({
        anchor: {
          sessionFile: ctx.sessionFile,
          id:
            typeof refId === "string" && refId
              ? `${refId}#result`
              : `${baseId}#r${blockIdx}`,
          line: lineNo,
          ts,
        },
        parentId,
        source: ctx.source,
        project: ctx.project,
        role: "tool",
        kind: "tool_result",
        tool: { name: "result", summary: redact(summary), isError },
        text: "",
      });
    }
  }
  return events;
};

// ---------------------------------------------------------------------------
// Codex parser
// ---------------------------------------------------------------------------

function codexArgs(raw: unknown): any {
  // Codex function_call.arguments is a JSON-ENCODED STRING, not an object.
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return { _raw: raw };
    }
  }
  return raw && typeof raw === "object" ? raw : {};
}

function codexCommandText(args: any): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  if (typeof args.cmd === "string") return args.cmd;
  if (typeof args.command === "string") return args.command;
  if (Array.isArray(args.command)) return args.command.join(" ");
  if (typeof args.input === "string") return args.input;
  return undefined;
}

function codexExitNonZero(output: string): boolean {
  const m = output.match(/exited with code (\d+)/i);
  return m ? m[1] !== "0" : false;
}

export const parseCodexTranscript: TranscriptParser = (obj, ctx, lineNo) => {
  if (obj?.type !== "response_item") return []; // session_meta / event_msg / turn_context dropped
  const payload = obj.payload;
  if (!payload || typeof payload !== "object") return [];
  const ts: string | null = typeof obj.timestamp === "string" ? obj.timestamp : null;
  const id = `${ctx.sessionFile}#L${lineNo}`;
  const ptype = payload.type;

  const base = {
    parentId: null as string | null, // reconstructed from order at the content level
    source: ctx.source,
    project: ctx.project,
  };

  if (ptype === "message") {
    const role = payload.role;
    let text = extractTextFromContent(payload.content);
    if (!text.trim()) return [];
    let eventRole: EventRole;
    if (role === "assistant") {
      eventRole = "assistant";
    } else if (role === "user") {
      if (shouldSkipUserText(text)) return [];
      text = cleanUserText(text);
      if (!text.trim()) return [];
      eventRole = "user";
    } else {
      // 'developer' (AGENTS.md / permissions / collaboration-mode) → system context
      eventRole = "system";
    }
    return [
      {
        anchor: { sessionFile: ctx.sessionFile, id, line: lineNo, ts },
        ...base,
        role: eventRole,
        kind: "message",
        text: redact(text.trim()),
      },
    ];
  }

  if (ptype === "function_call") {
    const name = String(payload.name ?? "tool");
    const callId = typeof payload.call_id === "string" ? payload.call_id : id;
    const args = codexArgs(payload.arguments);
    const cmd = codexCommandText(args);
    const target =
      typeof args.workdir === "string"
        ? args.workdir
        : typeof args.path === "string"
          ? args.path
          : typeof args.file_path === "string"
            ? args.file_path
            : undefined;
    const summary = cmd ? `${name}: ${cmd}` : `${name}: ${JSON.stringify(args)}`;
    return [
      {
        anchor: { sessionFile: ctx.sessionFile, id: callId, line: lineNo, ts },
        ...base,
        role: "assistant",
        kind: "tool_use",
        tool: {
          name,
          target: target ? redact(target) : undefined,
          summary: redact(truncate(summary)),
        },
        text: "",
      },
    ];
  }

  if (ptype === "function_call_output") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : id;
    const output = typeof payload.output === "string" ? payload.output : stringifyContent(payload.output);
    return [
      {
        anchor: { sessionFile: ctx.sessionFile, id: `${callId}#result`, line: lineNo, ts },
        ...base,
        role: "tool",
        kind: "tool_result",
        tool: { name: "result", summary: redact(truncate(output)), isError: codexExitNonZero(output) },
        text: "",
      },
    ];
  }

  // reasoning (encrypted, no plaintext) and other response items: nothing to analyze.
  return [];
};

// ---------------------------------------------------------------------------
// Parser registry — the not-locked-in guarantee (design §2.3)
// ---------------------------------------------------------------------------

export const PARSERS: Record<SessionSource, TranscriptParser> = {
  claude: parseClaudeTranscript,
  codex: parseCodexTranscript,
};

/**
 * Parse one transcript's raw content into ordered events. Accepts content (not
 * a path) so it is unit-testable with inline fixtures. Line numbers are 1-based
 * over the RAW lines (blanks counted) so anchors are stable across re-runs.
 */
export function parseTranscriptContent(
  content: string,
  ctx: ParseContext,
): TranscriptEvent[] {
  const parser = PARSERS[ctx.source];
  if (!parser) return [];
  const rawLines = content.split("\n");
  const events: TranscriptEvent[] = [];
  let lastId: string | null = null;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line || !line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // skip malformed JSONL lines
    }
    let lineEvents: TranscriptEvent[];
    try {
      lineEvents = parser(obj, ctx, i + 1);
    } catch {
      continue; // a single bad line never kills the parse
    }
    for (const ev of lineEvents) {
      // Codex has no parent chain; reconstruct linear adjacency by order.
      if (ev.parentId == null && ctx.source === "codex") ev.parentId = lastId;
      events.push(ev);
      lastId = ev.anchor.id;
    }
  }
  return events;
}

export function parseTranscriptFile(file: string, ctx: ParseContext): TranscriptEvent[] {
  let content: string;
  try {
    content = readFileSync(file, "utf-8");
  } catch {
    return [];
  }
  return parseTranscriptContent(content, ctx);
}

// ---------------------------------------------------------------------------
// Window-free loading (design §2.5) — powers `hive taste extract`
// ---------------------------------------------------------------------------

export interface LoadTranscriptOptions {
  /** Explicit JSONL paths. Takes precedence over the date/window modes. */
  files?: string[];
  /** ISO date (inclusive lower bound on file mtime). */
  since?: string;
  /** ISO date (inclusive upper bound on file mtime). */
  until?: string;
  /** Nightly default when no files/since given. */
  hoursWindow?: number;
  /** Filter to one resolved HIVE project. */
  project?: string;
  /** Injectable clock for tests. */
  now?: Date;
}

export interface LoadedTranscript {
  sessionFile: string;
  source: SessionSource;
  project: string;
  events: TranscriptEvent[];
}

function inferSourceFromPath(file: string): SessionSource | null {
  if (file.includes("/.codex/")) return "codex";
  if (file.includes("/.claude/")) return "claude";
  return null;
}

function inferSourceFromContent(file: string): SessionSource {
  try {
    const firstLine = readFileSync(file, "utf-8").split("\n").find((l) => l.trim());
    if (firstLine) {
      const obj = JSON.parse(firstLine);
      // Codex records carry a `payload` and no `uuid`; Claude lines carry a
      // top-level `uuid` and no `payload`. Keying on this (rather than a fixed
      // record-type set) avoids silently misclassifying a Codex file that
      // happens to lead with event_msg/turn_context.
      if (obj?.payload && obj.uuid === undefined) {
        return "codex";
      }
    }
  } catch {
    // fall through
  }
  return "claude";
}

/** Build a single-file bundle so explicit paths resolve to a project. */
async function resolveFile(file: string): Promise<ParseContext> {
  const source = inferSourceFromPath(file) ?? inferSourceFromContent(file);
  let locator: string;
  if (source === "codex") {
    locator = readCodexCwd(file) ?? dirname(file);
  } else {
    locator = basename(dirname(file)); // the encoded project dir name
  }
  const bundle: RecentSessionBundle = { source, locator, files: [file] };
  const project = await resolveProjectName(bundle);
  return { sessionFile: file, source, project };
}

function mtimeMs(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Discover + parse transcripts into per-session event streams, decoupled from
 * the nightly 24h clock. Three modes (checked in order): explicit `files`, a
 * `since`/`until` date range, or an `hoursWindow` (default 24).
 */
export async function loadTranscripts(
  opts: LoadTranscriptOptions = {},
): Promise<LoadedTranscript[]> {
  const now = opts.now ?? new Date();
  const contexts: ParseContext[] = [];

  if (opts.files && opts.files.length > 0) {
    for (const file of opts.files) contexts.push(await resolveFile(file));
  } else {
    const sinceMs = opts.since ? new Date(opts.since).getTime() : null;
    const untilMs = opts.until ? new Date(opts.until).getTime() : null;
    // Scan back far enough to cover `since`; default to the requested window.
    const hoursAgo = sinceMs
      ? Math.max(1, Math.ceil((now.getTime() - sinceMs) / 3_600_000))
      : (opts.hoursWindow ?? 24);
    const bundles = findRecentSessions(hoursAgo, now);
    for (const bundle of bundles) {
      const project = await resolveProjectName(bundle);
      for (const file of bundle.files) {
        const mt = mtimeMs(file);
        if (sinceMs != null && (mt == null || mt < sinceMs)) continue;
        if (untilMs != null && (mt == null || mt > untilMs)) continue;
        contexts.push({ sessionFile: file, source: bundle.source, project });
      }
    }
  }

  const wanted = opts.project;
  const out: LoadedTranscript[] = [];
  for (const ctx of contexts) {
    if (wanted && ctx.project !== wanted) continue;
    const events = parseTranscriptFile(ctx.sessionFile, ctx);
    if (events.length === 0) continue;
    out.push({ sessionFile: ctx.sessionFile, source: ctx.source, project: ctx.project, events });
  }
  return out;
}

/** Flatten loaded transcripts into a single ordered event array. */
export async function loadTranscriptEvents(
  opts: LoadTranscriptOptions = {},
): Promise<TranscriptEvent[]> {
  const loaded = await loadTranscripts(opts);
  return loaded.flatMap((t) => t.events);
}
