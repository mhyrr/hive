import { describe, test, expect, afterEach } from "bun:test";
import { withDeadline, nightlyCallTimeoutMs } from "../lib/claude";

// withDeadline is the in-process bound the nightly pipeline relies on so a
// stalled `claude --print` (it hangs for hours on OAuth/Keychain in the
// detached launchd context) fails fast and visibly instead of eating the run.

describe("withDeadline", () => {
  test("returns the value when run settles before the deadline", async () => {
    const v = await withDeadline(1000, "fast", async () => 42);
    expect(v).toBe(42);
  });

  test("rejects with a timeout error and aborts the signal on deadline", async () => {
    const start = Date.now();
    let aborted = false;
    await expect(
      withDeadline(20, "slow", (signal) =>
        // Never settles on its own; only the deadline's abort ends it. Mirrors
        // a stalled child that completeClaudeText kills via the same signal.
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
      ),
    ).rejects.toThrow(/slow timed out after 20ms/);
    expect(aborted).toBe(true);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  test("propagates run's own rejection rather than masking it as a timeout", async () => {
    await expect(
      withDeadline(1000, "boom", async () => {
        throw new Error("inner failure");
      }),
    ).rejects.toThrow(/inner failure/);
  });

  test("does not abort the signal when run settles in time", async () => {
    let aborted = false;
    const v = await withDeadline(1000, "ok", async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return "done";
    });
    expect(v).toBe("done");
    expect(aborted).toBe(false);
  });
});

describe("nightlyCallTimeoutMs", () => {
  const prev = process.env.HIVE_NIGHTLY_CALL_TIMEOUT_MS;
  afterEach(() => {
    if (prev === undefined) delete process.env.HIVE_NIGHTLY_CALL_TIMEOUT_MS;
    else process.env.HIVE_NIGHTLY_CALL_TIMEOUT_MS = prev;
  });

  test("defaults to 15 minutes", () => {
    delete process.env.HIVE_NIGHTLY_CALL_TIMEOUT_MS;
    expect(nightlyCallTimeoutMs()).toBe(900_000);
  });

  test("honors a positive env override", () => {
    process.env.HIVE_NIGHTLY_CALL_TIMEOUT_MS = "1234";
    expect(nightlyCallTimeoutMs()).toBe(1234);
  });

  test("ignores a non-numeric or non-positive override", () => {
    process.env.HIVE_NIGHTLY_CALL_TIMEOUT_MS = "nope";
    expect(nightlyCallTimeoutMs()).toBe(900_000);
    process.env.HIVE_NIGHTLY_CALL_TIMEOUT_MS = "0";
    expect(nightlyCallTimeoutMs()).toBe(900_000);
  });
});
