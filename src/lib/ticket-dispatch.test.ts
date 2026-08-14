import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureHiveScaffold, type HivePaths } from "./paths";
import {
  claimTicketForDispatch,
  createTicket,
  readTicket,
  releaseTicketDispatchClaim,
  updateTicket,
} from "./ticket";

describe("review dispatch ticket ownership", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    paths = await ensureHiveScaffold(await mkdtemp(join(tmpdir(), "hive-ticket-claim-")));
    await mkdir(join(paths.projectsDir, "alpha"), { recursive: true });
  });

  test("claim persists the run and branch and rejects a second owner", async () => {
    const ticket = await createTicket(paths, "alpha", { title: "Follow on", body: "Complete spec." });
    await claimTicketForDispatch(paths, "alpha", ticket.id, "RUN-001", "hive/act/alpha-tk-001-run-001");

    expect(await readTicket(paths, "alpha", ticket.id)).toMatchObject({
      status: "in_progress",
      dispatchRun: "RUN-001",
      dispatchBranch: "hive/act/alpha-tk-001-run-001",
    });
    await expect(claimTicketForDispatch(paths, "alpha", ticket.id, "RUN-002", "other")).rejects.toThrow("no longer available");
  });

  test("only the owning run may release; human close cannot be reopened", async () => {
    const ticket = await createTicket(paths, "alpha", { title: "Follow on", body: "Complete spec." });
    await claimTicketForDispatch(paths, "alpha", ticket.id, "RUN-001", "review-branch");

    expect(await releaseTicketDispatchClaim(paths, "alpha", ticket.id, "RUN-002")).toBe(false);
    expect((await readTicket(paths, "alpha", ticket.id))?.status).toBe("in_progress");

    await updateTicket(paths, "alpha", ticket.id, { status: "closed" });
    expect(await releaseTicketDispatchClaim(paths, "alpha", ticket.id, "RUN-001")).toBe(false);
    expect(await readTicket(paths, "alpha", ticket.id)).toMatchObject({
      status: "closed",
      dispatchRun: null,
      dispatchBranch: null,
    });
  });
});
