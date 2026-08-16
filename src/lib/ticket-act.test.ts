import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureHiveScaffold, type HivePaths } from "./paths";
import {
  claimTicketForAct,
  createTicket,
  readTicket,
  releaseTicketActClaim,
  updateTicket,
} from "./ticket";

describe("Watch Act ticket ownership", () => {
  let paths: HivePaths;

  beforeEach(async () => {
    paths = await ensureHiveScaffold(await mkdtemp(join(tmpdir(), "hive-ticket-claim-")));
    await mkdir(join(paths.projectsDir, "alpha"), { recursive: true });
  });

  test("claim persists the run and branch and rejects a second owner", async () => {
    const ticket = await createTicket(paths, "alpha", { title: "Follow on", body: "Complete spec." });
    await claimTicketForAct(paths, "alpha", ticket.id, "RUN-001", "hive/act/alpha-tk-001-run-001");

    expect(await readTicket(paths, "alpha", ticket.id)).toMatchObject({
      status: "in_progress",
      actRun: "RUN-001",
      actBranch: "hive/act/alpha-tk-001-run-001",
    });
    await expect(claimTicketForAct(paths, "alpha", ticket.id, "RUN-002", "other")).rejects.toThrow("no longer available");
  });

  test("only the owning run may release; human close cannot be reopened", async () => {
    const ticket = await createTicket(paths, "alpha", { title: "Follow on", body: "Complete spec." });
    await claimTicketForAct(paths, "alpha", ticket.id, "RUN-001", "review-branch");

    expect(await releaseTicketActClaim(paths, "alpha", ticket.id, "RUN-002")).toBe(false);
    expect((await readTicket(paths, "alpha", ticket.id))?.status).toBe("in_progress");

    await updateTicket(paths, "alpha", ticket.id, { status: "closed" });
    expect(await releaseTicketActClaim(paths, "alpha", ticket.id, "RUN-001")).toBe(false);
    expect(await readTicket(paths, "alpha", ticket.id)).toMatchObject({
      status: "closed",
      actRun: null,
      actBranch: null,
    });
  });

  test("legacy claim fields migrate on the next ticket write", async () => {
    const file = join(paths.projectsDir, "alpha", "tickets", "TK-001.md");
    await mkdir(join(paths.projectsDir, "alpha", "tickets"), { recursive: true });
    await writeFile(file, `---
id: TK-001
title: Legacy claim
status: in_progress
type: task
priority: 2
tags:
created: 2026-08-01T00:00:00Z
updated: 2026-08-01T00:00:00Z
dispatch_run: RUN-041
dispatch_branch: hive/act/alpha-tk-001-run-041
---

Complete spec.
`);

    expect(await readTicket(paths, "alpha", "TK-001")).toMatchObject({
      actRun: "RUN-041",
      actBranch: "hive/act/alpha-tk-001-run-041",
    });
    await updateTicket(paths, "alpha", "TK-001", { tags: ["act"] });
    const migrated = await Bun.file(file).text();
    expect(migrated).toContain("act_run: RUN-041");
    expect(migrated).toContain("act_branch: hive/act/alpha-tk-001-run-041");
    expect(migrated).not.toContain("dispatch_run:");
    expect(migrated).not.toContain("dispatch_branch:");
  });
});
