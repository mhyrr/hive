import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkNextAvailability, parseNextSelection, readNextSelection, writeNextSelection } from "./next";
import { ensureHiveScaffold } from "./paths";
import { createTicket, updateTicket } from "./ticket";

describe("next selection", () => {
  test("replaces one guarded JSON record", async () => {
    const paths = await ensureHiveScaffold(await mkdtemp(join(tmpdir(), "hive-next-")));
    const first = {
      version: 1 as const,
      disposition: "recommended" as const,
      selectedAt: "2026-08-24T10:00:00Z",
      sourceWatch: "act",
      projectId: "alpha",
      ticketId: "TK-001",
      rationale: "First reason.",
    };
    await writeNextSelection(paths, first);
    await writeNextSelection(paths, { ...first, ticketId: "TK-002", rationale: "Second reason." });

    expect(await readNextSelection(paths)).toEqual({
      ...first,
      ticketId: "TK-002",
      rationale: "Second reason.",
    });
    expect(parseNextSelection({ ...first, disposition: "started" })).toBeNull();
  });

  test("revalidates the live ticket and its dependencies", async () => {
    const paths = await ensureHiveScaffold(await mkdtemp(join(tmpdir(), "hive-next-ready-")));
    const dependency = await createTicket(paths, "alpha", { title: "Dependency", body: "Finish this first." });
    const ticket = await createTicket(paths, "alpha", {
      title: "Recommended",
      body: "A complete specification.",
      depends: [dependency.id],
    });
    const selection = {
      version: 1 as const,
      disposition: "recommended" as const,
      selectedAt: "2026-08-24T10:00:00Z",
      sourceWatch: "act",
      projectId: "alpha",
      ticketId: ticket.id,
      rationale: "It follows directly.",
    };

    expect(await checkNextAvailability(paths, selection)).toMatchObject({
      available: false,
      reason: `blocked by ${dependency.id}`,
    });
    await updateTicket(paths, "alpha", dependency.id, { status: "closed" });
    expect(await checkNextAvailability(paths, selection)).toMatchObject({ available: true });
    await updateTicket(paths, "alpha", ticket.id, { status: "in_progress" });
    expect(await checkNextAvailability(paths, selection)).toMatchObject({
      available: false,
      reason: "status is in_progress",
    });
  });
});
