import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

import {
  readHeartbeatConfig,
  writeHeartbeatConfig,
  shouldTickNow,
  defaultConfig,
  type HeartbeatConfig,
} from "../lib/heartbeat";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hive-heartbeat-test-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// defaultConfig
// ---------------------------------------------------------------------------

describe("defaultConfig", () => {
  test("returns sensible defaults", () => {
    const config = defaultConfig();
    expect(config.enabled).toBe(true);
    expect(config.intervalMinutes).toBe(30);
    expect(config.tickCount).toBe(0);
    expect(config.consecutiveFailures).toBe(0);
    // sessionId is no longer part of defaults — heartbeat is stateless (TK-024).
    // Existing configs on disk may still have sessionId/createdAt; the field is
    // optional in HeartbeatConfig so old files parse cleanly but we don't write
    // them on new configs.
    expect(config.sessionId).toBeUndefined();
  });

  test("accepts custom interval", () => {
    const config = defaultConfig(60);
    expect(config.intervalMinutes).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// readHeartbeatConfig / writeHeartbeatConfig
// ---------------------------------------------------------------------------

describe("config read/write", () => {
  test("returns null when no config exists", () => {
    expect(readHeartbeatConfig(tempDir)).toBeNull();
  });

  test("round-trips a config", async () => {
    const config = defaultConfig(15);
    config.sessionId = "test-session-id";
    config.createdAt = "2026-04-01T00:00:00Z";
    config.lastTick = "2026-04-01T01:00:00Z";
    config.tickCount = 5;
    config.lastResult = "HEARTBEAT_OK";

    await writeHeartbeatConfig(tempDir, config);

    const read = readHeartbeatConfig(tempDir);
    expect(read).not.toBeNull();
    expect(read!.sessionId).toBe("test-session-id");
    expect(read!.intervalMinutes).toBe(15);
    expect(read!.tickCount).toBe(5);
    expect(read!.enabled).toBe(true);
    expect(read!.lastResult).toBe("HEARTBEAT_OK");
  });

  test("writes valid JSON", async () => {
    await writeHeartbeatConfig(tempDir, defaultConfig());
    const raw = readFileSync(join(tempDir, "heartbeat.json"), "utf-8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("returns null on corrupt JSON", async () => {
    await Bun.write(join(tempDir, "heartbeat.json"), "not json");
    expect(readHeartbeatConfig(tempDir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shouldTickNow
// ---------------------------------------------------------------------------

describe("shouldTickNow", () => {
  test("returns false when disabled", () => {
    const config = defaultConfig();
    config.enabled = false;
    expect(shouldTickNow(config)).toBe(false);
  });

  test("returns true when no lastTick (first tick)", () => {
    const config = defaultConfig();
    config.enabled = true;
    config.lastTick = "";
    expect(shouldTickNow(config)).toBe(true);
  });

  test("returns false when interval not elapsed", () => {
    const config = defaultConfig(30);
    config.lastTick = new Date().toISOString(); // just now
    expect(shouldTickNow(config)).toBe(false);
  });

  test("returns true when interval has elapsed", () => {
    const config = defaultConfig(30);
    // 31 minutes ago
    config.lastTick = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    expect(shouldTickNow(config)).toBe(true);
  });

  test("respects custom interval", () => {
    const config = defaultConfig(5);
    // 6 minutes ago
    config.lastTick = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    expect(shouldTickNow(config)).toBe(true);

    // 3 minutes ago
    config.lastTick = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    expect(shouldTickNow(config)).toBe(false);
  });

  test("handles edge case at exactly the interval boundary", () => {
    const config = defaultConfig(30);
    // Exactly 30 minutes ago
    config.lastTick = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(shouldTickNow(config)).toBe(true);
  });
});
