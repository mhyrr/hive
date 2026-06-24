import { describe, expect, test } from "bun:test";

import {
  parseTranscriptContent,
  type ParseContext,
  type TranscriptEvent,
} from "./transcript";

const claudeCtx: ParseContext = {
  sessionFile: "/Users/x/.claude/projects/-Users-x-work-proj/sess.jsonl",
  source: "claude",
  project: "proj",
};

const codexCtx: ParseContext = {
  sessionFile: "/Users/x/.codex/sessions/2026/06/23/rollout-sess.jsonl",
  source: "codex",
  project: "proj",
};

function jsonl(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join("\n");
}

function byKind(events: TranscriptEvent[], kind: string): TranscriptEvent[] {
  return events.filter((e) => e.kind === kind);
}

// ---------------------------------------------------------------------------
// Claude parser
// ---------------------------------------------------------------------------

describe("parseTranscriptContent — claude", () => {
  test("user prose → one message event with anchor + parentId", () => {
    const content = jsonl({
      parentUuid: null,
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-23T10:00:00.000Z",
      message: { role: "user", content: "no, use a foreign key instead" },
    });
    const events = parseTranscriptContent(content, claudeCtx);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe("message");
    expect(e.role).toBe("user");
    expect(e.text).toBe("no, use a foreign key instead");
    expect(e.anchor.id).toBe("u1");
    expect(e.anchor.line).toBe(1);
    expect(e.anchor.ts).toBe("2026-06-23T10:00:00.000Z");
    expect(e.parentId).toBeNull();
  });

  test("assistant array → thinking + text + tool_use as separate ordered events", () => {
    const content = jsonl({
      parentUuid: "u1",
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-06-23T10:00:05.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "The user wants a FK.", signature: "sig" },
          { type: "text", text: "Sure, switching to a foreign key." },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Edit",
            input: { file_path: "/x/schema.sql", old_string: "a", new_string: "b", replace_all: false },
          },
        ],
      },
    });
    const events = parseTranscriptContent(content, claudeCtx);
    expect(events.map((e) => e.kind)).toEqual(["thinking", "message", "tool_use"]);
    expect(events.every((e) => e.parentId === "u1")).toBe(true);

    const tool = byKind(events, "tool_use")[0]!;
    expect(tool.role).toBe("assistant");
    expect(tool.tool?.name).toBe("Edit");
    expect(tool.tool?.target).toBe("/x/schema.sql");
    expect(tool.anchor.id).toBe("toolu_1"); // stable, linkable to its tool_result
    expect(tool.text).toBe("");
  });

  test("empty thinking blocks are dropped as noise", () => {
    const content = jsonl({
      type: "assistant",
      uuid: "a1",
      parentUuid: null,
      timestamp: "t",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }] },
    });
    expect(parseTranscriptContent(content, claudeCtx)).toHaveLength(0);
  });

  test("tool_result on a user line → tool event linked by tool_use_id, isError surfaced", () => {
    const content = jsonl({
      parentUuid: "a1",
      type: "user",
      uuid: "u2",
      timestamp: "t",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "boom", is_error: true }],
      },
    });
    const events = parseTranscriptContent(content, claudeCtx);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe("tool_result");
    expect(e.role).toBe("tool");
    expect(e.tool?.isError).toBe(true);
    expect(e.anchor.id).toBe("toolu_1#result");
  });

  test("secrets in a Bash command are redacted in the tool summary", () => {
    const content = jsonl({
      type: "assistant",
      uuid: "a2",
      parentUuid: null,
      timestamp: "t",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_2",
            name: "Bash",
            input: { command: "export ANTHROPIC_API_KEY=sk-ant-abc123XYZ && echo hi", description: "x" },
          },
        ],
      },
    });
    const e = parseTranscriptContent(content, claudeCtx)[0]!;
    expect(e.tool?.summary).toContain("[REDACTED]");
    expect(e.tool?.summary).not.toContain("sk-ant-abc123XYZ");
  });

  test("command-scaffolding user text is skipped", () => {
    const content = jsonl({
      type: "user",
      uuid: "u3",
      parentUuid: null,
      timestamp: "t",
      message: { role: "user", content: "<command-name>/foo</command-name>" },
    });
    expect(parseTranscriptContent(content, claudeCtx)).toHaveLength(0);
  });

  test("line numbers track raw position across blank + malformed lines", () => {
    const good1 = JSON.stringify({ type: "user", uuid: "u1", parentUuid: null, timestamp: "t", message: { role: "user", content: "first" } });
    const good2 = JSON.stringify({ type: "user", uuid: "u2", parentUuid: null, timestamp: "t", message: { role: "user", content: "second" } });
    const content = [good1, "", "{ not json", good2].join("\n");
    const events = parseTranscriptContent(content, claudeCtx);
    expect(events).toHaveLength(2);
    expect(events[0]!.anchor.line).toBe(1);
    expect(events[1]!.anchor.line).toBe(4); // blank (2) + malformed (3) counted
  });
});

// ---------------------------------------------------------------------------
// Codex parser
// ---------------------------------------------------------------------------

describe("parseTranscriptContent — codex", () => {
  const meta = {
    type: "session_meta",
    timestamp: "2026-06-23T11:00:00.000Z",
    payload: { cwd: "/Users/x/work/proj", id: "sess1" },
  };
  const userMsg = {
    type: "response_item",
    timestamp: "2026-06-23T11:00:01.000Z",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "actually, revert that" }] },
  };
  const devMsg = {
    type: "response_item",
    timestamp: "2026-06-23T11:00:02.000Z",
    payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "collaboration mode" }] },
  };
  const call = {
    type: "response_item",
    timestamp: "2026-06-23T11:00:03.000Z",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: "call_1",
      arguments: JSON.stringify({ cmd: "git checkout -- file.sql", workdir: "/Users/x/work/proj" }),
    },
  };
  const callOut = {
    type: "response_item",
    timestamp: "2026-06-23T11:00:04.000Z",
    payload: { type: "function_call_output", call_id: "call_1", output: "Chunk\nProcess exited with code 1\nOutput:\nerror" },
  };

  test("session_meta + event noise produce no events", () => {
    expect(parseTranscriptContent(jsonl(meta), codexCtx)).toHaveLength(0);
  });

  test("developer role maps to system (not dropped, not user-filtered)", () => {
    const events = parseTranscriptContent(jsonl(devMsg), codexCtx);
    expect(events).toHaveLength(1);
    expect(events[0]!.role).toBe("system");
  });

  test("function_call parses JSON-string arguments → target + redacted summary", () => {
    const e = parseTranscriptContent(jsonl(call), codexCtx)[0]!;
    expect(e.kind).toBe("tool_use");
    expect(e.tool?.name).toBe("exec_command");
    expect(e.tool?.target).toBe("/Users/x/work/proj");
    expect(e.tool?.summary).toContain("git checkout");
    expect(e.anchor.id).toBe("call_1");
  });

  test("function_call_output flags non-zero exit as error", () => {
    const e = parseTranscriptContent(jsonl(callOut), codexCtx)[0]!;
    expect(e.kind).toBe("tool_result");
    expect(e.tool?.isError).toBe(true);
    expect(e.anchor.id).toBe("call_1#result");
  });

  test("parentId is reconstructed from event order (codex has no parent chain)", () => {
    const events = parseTranscriptContent(jsonl(meta, userMsg, devMsg, call, callOut), codexCtx);
    // meta → no event; so 4 events: user, dev, call, callOut
    expect(events).toHaveLength(4);
    const [user, dev, fcall, fout] = events;
    expect(user!.parentId).toBeNull();
    expect(dev!.parentId).toBe(user!.anchor.id);
    expect(fcall!.parentId).toBe(dev!.anchor.id);
    expect(fout!.parentId).toBe(fcall!.anchor.id);
  });
});
