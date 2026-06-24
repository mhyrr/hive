import { describe, expect, test } from "bun:test";

import { segmentWindows } from "./taste-segment";
import { parseTranscriptContent, type ParseContext } from "./transcript";

const ctx: ParseContext = {
  sessionFile: "/Users/x/.claude/projects/-Users-x-work-proj/sess.jsonl",
  source: "claude",
  project: "proj",
};

let uuid = 0;
function userLine(text: string) {
  return { type: "user", uuid: `u${uuid++}`, parentUuid: null, timestamp: "t", message: { role: "user", content: text } };
}
function assistantEdit(file: string, text = "ok") {
  return {
    type: "assistant",
    uuid: `a${uuid++}`,
    parentUuid: null,
    timestamp: "t",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        { type: "tool_use", id: `tu${uuid++}`, name: "Edit", input: { file_path: file, old_string: "x", new_string: "y" } },
      ],
    },
  };
}
function assistantBash(cmd: string) {
  return {
    type: "assistant",
    uuid: `a${uuid++}`,
    parentUuid: null,
    timestamp: "t",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: `tu${uuid++}`, name: "Bash", input: { command: cmd, description: "d" } }],
    },
  };
}
function jsonl(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join("\n");
}

describe("segmentWindows", () => {
  test("opening prompt with no reaction yields no windows", () => {
    const content = jsonl(userLine("build me a SQL schema for users"), assistantEdit("/x/schema.sql"));
    const events = parseTranscriptContent(content, ctx);
    expect(segmentWindows(events)).toHaveLength(0);
  });

  test("a correction + its self-correction edit merge into one cued window", () => {
    const content = jsonl(
      userLine("build me a schema"),
      assistantEdit("/x/schema.sql"),
      userLine("no, use a foreign key instead"),
      assistantEdit("/x/schema.sql", "switching to a FK"),
      userLine("perfect, that's it"),
    );
    const events = parseTranscriptContent(content, ctx);
    const windows = segmentWindows(events);
    expect(windows).toHaveLength(1);
    const w = windows[0]!;
    expect(w.locusKind).toBe("human-reaction");
    expect(w.cues).toEqual(expect.arrayContaining(["instead", "repeat-target", "praise"]));
    // anchored on the correction, not the opening prompt
    expect(w.anchor.line).toBe(3);
  });

  test("a git-revert Bash command is a self-correction window with no human turn", () => {
    const content = jsonl(
      userLine("apply the migration"),
      assistantEdit("/x/schema.sql"),
      assistantBash("git checkout -- /x/schema.sql"),
    );
    const events = parseTranscriptContent(content, ctx);
    const windows = segmentWindows(events);
    expect(windows.length).toBeGreaterThanOrEqual(1);
    expect(windows.some((w) => w.cues.includes("revert-cmd"))).toBe(true);
  });

  test("two well-separated corrections yield two windows", () => {
    const filler = Array.from({ length: 8 }, () => assistantEdit("/x/other.ts", "working"));
    const content = jsonl(
      userLine("start"),
      assistantEdit("/x/a.ts"),
      userLine("no, that's wrong"),
      ...filler,
      userLine("actually, simpler please"),
      assistantEdit("/x/b.ts"),
    );
    const events = parseTranscriptContent(content, ctx);
    const windows = segmentWindows(events, { kBefore: 1, kAfter: 1 });
    expect(windows.length).toBe(2);
  });

  test("a destructive rm command flags an abandoned-path self-correction (different target)", () => {
    const content = jsonl(
      userLine("create the module"),
      assistantEdit("/x/foo.ts"),
      assistantBash("rm /x/foo.ts"),
      assistantEdit("/x/bar.ts"),
    );
    const events = parseTranscriptContent(content, ctx);
    const windows = segmentWindows(events);
    expect(windows.some((w) => w.cues.includes("destructive-cmd"))).toBe(true);
  });

  test("a terse lexicon-free correction after an edit is caught by the post-action recall floor", () => {
    const content = jsonl(
      userLine("build the id field"),
      assistantEdit("/x/schema.sql"),
      userLine("make it a UUID column"), // hits no reaction lexicon
    );
    const events = parseTranscriptContent(content, ctx);
    const windows = segmentWindows(events);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.cues).toContain("post-action");
  });

  test("a bare acknowledgement after an edit is NOT flagged (post-action floor needs substance)", () => {
    const content = jsonl(userLine("do it"), assistantEdit("/x/a.ts"), userLine("ok"));
    const events = parseTranscriptContent(content, ctx);
    expect(segmentWindows(events)).toHaveLength(0);
  });

  test("the human-reaction flag survives a tool_result event between edit and reaction", () => {
    const toolResult = {
      type: "user",
      uuid: `u${uuid++}`,
      parentUuid: null,
      timestamp: "t",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_x", content: "done", is_error: false }] },
    };
    const content = jsonl(userLine("do the thing"), assistantEdit("/x/a.ts"), toolResult, userLine("no, that's wrong"));
    const events = parseTranscriptContent(content, ctx);
    const windows = segmentWindows(events);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.locusKind).toBe("human-reaction");
  });

  test("empty event stream yields no windows", () => {
    expect(segmentWindows([])).toEqual([]);
  });
});
