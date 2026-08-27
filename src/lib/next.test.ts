import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkNextAvailability,
  parseNextBoard,
  parseNextSelection,
  readNextBoard,
  writeNextSelection,
} from "./next";
import { ensureHiveScaffold } from "./paths";
import { createTicket, updateTicket } from "./ticket";

const ALPHA = {
  disposition: "recommended" as const,
  selectedAt: "2026-08-24T10:00:00Z",
  sourceWatch: "alpha/act",
  projectId: "alpha",
  ticketId: "TK-001",
  rationale: "First reason.",
};

describe("next selection", () => {
  test("upserts per project and leaves other projects in place", async () => {
    const paths = await ensureHiveScaffold(await mkdtemp(join(tmpdir(), "hive-next-")));
    await writeNextSelection(paths, ALPHA);
    await writeNextSelection(paths, {
      ...ALPHA,
      projectId: "beta",
      sourceWatch: "beta/act",
      ticketId: "TK-010",
      rationale: "Beta follow-on.",
    });
    await writeNextSelection(paths, { ...ALPHA, ticketId: "TK-002", rationale: "Second reason." });

    expect(await readNextBoard(paths)).toEqual({
      version: 2,
      selections: [
        { ...ALPHA, ticketId: "TK-002", rationale: "Second reason." },
        {
          disposition: "recommended",
          selectedAt: "2026-08-24T10:00:00Z",
          sourceWatch: "beta/act",
          projectId: "beta",
          ticketId: "TK-010",
          rationale: "Beta follow-on.",
        },
      ],
    });
    expect(parseNextSelection({ ...ALPHA, disposition: "started" })).toBeNull();
  });

  test("reads a leftover v1 singleton as a one-item board", async () => {
    const paths = await ensureHiveScaffold(await mkdtemp(join(tmpdir(), "hive-next-v1-")));
    await writeFile(
      paths.next,
      `${JSON.stringify({ version: 1, ...ALPHA, sourceWatch: "act" }, null, 2)}\n`,
    );
    expect(await readNextBoard(paths)).toEqual({
      version: 2,
      selections: [{ ...ALPHA, sourceWatch: "act" }],
    });
    expect(parseNextBoard({ version: 1, ...ALPHA, sourceWatch: "act" }).selections).toHaveLength(1);
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
      disposition: "recommended" as const,
      selectedAt: "2026-08-24T10:00:00Z",
      sourceWatch: "alpha/act",
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
