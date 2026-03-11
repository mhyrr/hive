import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter } from "../src/lib/frontmatter";
import {
  appendTurn,
  createSession,
  getActiveSession,
  getSession,
  getSessionHistory,
  getSessionPrompt,
  listSessions,
  parseHistory,
} from "../src/lib/sessions";

let sessionsDir: string;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hive-sessions-"));
  sessionsDir = join(root, "sessions");
  await mkdir(sessionsDir, { recursive: true });
  process.env.HIVE_FIXED_NOW = "2026-03-11T14:11:05Z";
});

afterEach(async () => {
  delete process.env.HIVE_FIXED_NOW;
  await rm(root, { recursive: true, force: true });
});

describe("session management", () => {
  test("create a session produces correct directory structure with meta.md, history.md, prompt.md", async () => {
    const session = await createSession({
      sessionsDir,
      project: "dealsplit",
      runtime: "claude",
      model: "claude-sonnet-4",
      systemPrompt: "You are the hive mind.",
    });

    expect(session.sessionId).toBe("20260311-141105Z");
    expect(session.project).toBe("dealsplit");
    expect(session.runtime).toBe("claude");
    expect(session.model).toBe("claude-sonnet-4");
    expect(session.turns).toBe(0);
    expect(session.status).toBe("active");

    const sessionDir = join(sessionsDir, session.sessionId);
    const entries = await readdir(sessionDir);
    expect(entries.sort()).toEqual(["history.md", "meta.md", "prompt.md"]);

    // Verify meta.md
    const metaContent = await Bun.file(join(sessionDir, "meta.md")).text();
    const { attributes } = parseFrontmatter(metaContent);
    expect(attributes.session).toBe("20260311-141105Z");
    expect(attributes.project).toBe("dealsplit");
    expect(attributes.runtime).toBe("claude");
    expect(attributes.model).toBe("claude-sonnet-4");
    expect(attributes.turns).toBe("0");
    expect(attributes.status).toBe("active");
    expect(attributes.started).toBe("2026-03-11T14:11:05Z");

    // Verify history.md
    const historyContent = await Bun.file(join(sessionDir, "history.md")).text();
    expect(historyContent).toContain("# Session 20260311-141105Z");

    // Verify prompt.md
    const promptContent = await Bun.file(join(sessionDir, "prompt.md")).text();
    expect(promptContent.trim()).toBe("You are the hive mind.");
  });

  test("append turns updates history.md format and meta.md turns count", async () => {
    const session = await createSession({
      sessionsDir,
      project: "dealsplit",
      runtime: "claude",
      model: null,
      systemPrompt: "HIVE console session",
    });

    await appendTurn({
      sessionsDir,
      sessionId: session.sessionId,
      role: "human",
      content: "how's auth going?",
    });

    await appendTurn({
      sessionsDir,
      sessionId: session.sessionId,
      role: "assistant",
      content: "Alpha finished the endpoint at 14:52 with Joken for JWT.",
    });

    // Verify history.md format
    const historyContent = await Bun.file(
      join(sessionsDir, session.sessionId, "history.md"),
    ).text();
    expect(historyContent).toContain("## human (14:11:05)");
    expect(historyContent).toContain("how's auth going?");
    expect(historyContent).toContain("## assistant (14:11:05)");
    expect(historyContent).toContain("Alpha finished the endpoint at 14:52 with Joken for JWT.");

    // Verify meta.md turns count
    const metaContent = await Bun.file(
      join(sessionsDir, session.sessionId, "meta.md"),
    ).text();
    const { attributes } = parseFrontmatter(metaContent);
    expect(attributes.turns).toBe("2");
  });

  test("parse history roundtrip: write turns then read them back", async () => {
    const session = await createSession({
      sessionsDir,
      project: "dealsplit",
      runtime: "claude",
      model: null,
      systemPrompt: "HIVE console session",
    });

    await appendTurn({
      sessionsDir,
      sessionId: session.sessionId,
      role: "human",
      content: "how's auth going?",
    });

    await appendTurn({
      sessionsDir,
      sessionId: session.sessionId,
      role: "assistant",
      content: "Alpha finished the endpoint at 14:52 with Joken for JWT.",
    });

    await appendTurn({
      sessionsDir,
      sessionId: session.sessionId,
      role: "human",
      content: "the token should expire in 1 hour, not 24",
    });

    await appendTurn({
      sessionsDir,
      sessionId: session.sessionId,
      role: "assistant",
      content: "Got it. Sending correction to alpha.",
    });

    const turns = await getSessionHistory(sessionsDir, session.sessionId);
    expect(turns).toHaveLength(4);
    expect(turns[0].role).toBe("human");
    expect(turns[0].content).toBe("how's auth going?");
    expect(turns[0].ts).toBe("14:11:05");
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].content).toBe("Alpha finished the endpoint at 14:52 with Joken for JWT.");
    expect(turns[2].role).toBe("human");
    expect(turns[2].content).toBe("the token should expire in 1 hour, not 24");
    expect(turns[3].role).toBe("assistant");
    expect(turns[3].content).toBe("Got it. Sending correction to alpha.");
  });

  test("active session pointer: create session and verify active.md points to it", async () => {
    const session = await createSession({
      sessionsDir,
      project: "dealsplit",
      runtime: "claude",
      model: null,
      systemPrompt: "HIVE console session",
    });

    const activeContent = await Bun.file(join(sessionsDir, "active.md")).text();
    const { attributes } = parseFrontmatter(activeContent);
    expect(attributes.session).toBe(session.sessionId);
    expect(attributes.project).toBe("dealsplit");
    expect(attributes.runtime).toBe("claude");

    const active = await getActiveSession(sessionsDir);
    expect(active).not.toBeNull();
    expect(active!.sessionId).toBe(session.sessionId);
    expect(active!.project).toBe("dealsplit");
  });

  test("list sessions: create multiple and verify list returns all with correct metadata", async () => {
    process.env.HIVE_FIXED_NOW = "2026-03-11T14:11:05Z";
    await createSession({
      sessionsDir,
      project: "dealsplit",
      runtime: "claude",
      model: "claude-sonnet-4",
      systemPrompt: "First session",
    });

    process.env.HIVE_FIXED_NOW = "2026-03-11T15:22:10Z";
    await createSession({
      sessionsDir,
      project: "webapp",
      runtime: "codex",
      model: null,
      systemPrompt: "Second session",
    });

    const sessions = await listSessions(sessionsDir);
    expect(sessions).toHaveLength(2);

    // Sorted by started descending (newest first)
    expect(sessions[0].project).toBe("webapp");
    expect(sessions[0].runtime).toBe("codex");
    expect(sessions[1].project).toBe("dealsplit");
    expect(sessions[1].model).toBe("claude-sonnet-4");
  });

  test("new session replaces active pointer", async () => {
    process.env.HIVE_FIXED_NOW = "2026-03-11T14:11:05Z";
    const first = await createSession({
      sessionsDir,
      project: "dealsplit",
      runtime: "claude",
      model: null,
      systemPrompt: "First",
    });

    process.env.HIVE_FIXED_NOW = "2026-03-11T15:22:10Z";
    const second = await createSession({
      sessionsDir,
      project: "webapp",
      runtime: "codex",
      model: null,
      systemPrompt: "Second",
    });

    const active = await getActiveSession(sessionsDir);
    expect(active).not.toBeNull();
    expect(active!.sessionId).toBe(second.sessionId);
    expect(active!.sessionId).not.toBe(first.sessionId);
  });

  test("empty session: get history for session with no turns returns empty array", async () => {
    const session = await createSession({
      sessionsDir,
      project: "dealsplit",
      runtime: "claude",
      model: null,
      systemPrompt: "HIVE console session",
    });

    const turns = await getSessionHistory(sessionsDir, session.sessionId);
    expect(turns).toEqual([]);
  });

  test("session ID format is YYYYMMDD-HHmmssZ", async () => {
    process.env.HIVE_FIXED_NOW = "2026-03-11T14:11:05Z";
    const session1 = await createSession({
      sessionsDir,
      project: "dealsplit",
      runtime: "claude",
      model: null,
      systemPrompt: "test",
    });
    expect(session1.sessionId).toBe("20260311-141105Z");

    process.env.HIVE_FIXED_NOW = "2026-12-25T09:30:00Z";

    // Need a different session dir since same dir would collide
    const otherSessionsDir = join(root, "sessions2");
    await mkdir(otherSessionsDir, { recursive: true });

    const session2 = await createSession({
      sessionsDir: otherSessionsDir,
      project: "dealsplit",
      runtime: "claude",
      model: null,
      systemPrompt: "test",
    });
    expect(session2.sessionId).toBe("20261225-093000Z");

    // Verify format with regex
    const pattern = /^\d{8}-\d{6}Z$/;
    expect(pattern.test(session1.sessionId)).toBe(true);
    expect(pattern.test(session2.sessionId)).toBe(true);
  });

  test("parseHistory handles multiline content correctly", () => {
    const content = `# Session 20260311-141105Z

## human (14:11:05)
how's auth going?

## assistant (14:11:12)
Alpha finished the endpoint at 14:52 with Joken for JWT. Beta is
building the login form now, about 70% done. No blockers.

## human (14:15:30)
the token should expire in 1 hour, not 24

## assistant (14:15:38)
Got it. Sending correction to alpha.
`;

    const turns = parseHistory(content);
    expect(turns).toHaveLength(4);
    expect(turns[0].role).toBe("human");
    expect(turns[0].ts).toBe("14:11:05");
    expect(turns[0].content).toBe("how's auth going?");
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].ts).toBe("14:11:12");
    expect(turns[1].content).toContain("Alpha finished the endpoint");
    expect(turns[1].content).toContain("Beta is\nbuilding the login form");
    expect(turns[2].content).toBe("the token should expire in 1 hour, not 24");
    expect(turns[3].content).toBe("Got it. Sending correction to alpha.");
  });

  test("getSession returns null for nonexistent session", async () => {
    const result = await getSession(sessionsDir, "nonexistent-session");
    expect(result).toBeNull();
  });

  test("getActiveSession returns null when no active.md exists", async () => {
    const result = await getActiveSession(sessionsDir);
    expect(result).toBeNull();
  });

  test("getSessionPrompt returns the stored system prompt", async () => {
    const session = await createSession({
      sessionsDir,
      project: "dealsplit",
      runtime: "claude",
      model: null,
      systemPrompt: "You are the hive mind.\n\nManage agents effectively.",
    });

    const prompt = await getSessionPrompt(sessionsDir, session.sessionId);
    expect(prompt).toBe("You are the hive mind.\n\nManage agents effectively.");
  });

  test("model null is handled correctly in meta.md", async () => {
    const session = await createSession({
      sessionsDir,
      project: "dealsplit",
      runtime: "claude",
      model: null,
      systemPrompt: "test",
    });

    const meta = await getSession(sessionsDir, session.sessionId);
    expect(meta).not.toBeNull();
    expect(meta!.model).toBeNull();

    // meta.md should NOT have a model key when null
    const metaContent = await Bun.file(
      join(sessionsDir, session.sessionId, "meta.md"),
    ).text();
    expect(metaContent).not.toContain("model:");
  });
});
