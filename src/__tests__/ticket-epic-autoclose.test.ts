import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import { createTicket, updateTicket, readTicket } from "../lib/ticket";

let paths: HivePaths;

async function registerProject(name: string): Promise<void> {
  const dir = join(paths.projectsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "config.md"),
    `---\nname: ${name}\npath: /tmp/${name}\n---\n`,
  );
}

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "hive-autoclose-"));
  paths = await ensureHiveScaffold(home);
  await registerProject("alpha");
});

describe("epic auto-close on last child close", () => {
  test("closes epic when its only child closes", async () => {
    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    const child = await createTicket(paths, "alpha", {
      title: "c1",
      type: "task",
      parentEpic: epic.id,
    });

    await updateTicket(paths, "alpha", child.id, { status: "closed" });

    const updated = await readTicket(paths, "alpha", epic.id);
    expect(updated?.status).toBe("closed");
    expect(updated?.closed).toBeTruthy();
  });

  test("waits until ALL children are closed", async () => {
    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    const c1 = await createTicket(paths, "alpha", {
      title: "c1",
      type: "task",
      parentEpic: epic.id,
    });
    const c2 = await createTicket(paths, "alpha", {
      title: "c2",
      type: "task",
      parentEpic: epic.id,
    });

    await updateTicket(paths, "alpha", c1.id, { status: "closed" });
    let parent = await readTicket(paths, "alpha", epic.id);
    expect(parent?.status).toBe("open");

    await updateTicket(paths, "alpha", c2.id, { status: "closed" });
    parent = await readTicket(paths, "alpha", epic.id);
    expect(parent?.status).toBe("closed");
  });

  test("does NOT close an epic with zero children (decomposition pending)", async () => {
    const epic = await createTicket(paths, "alpha", { title: "Empty", type: "epic" });
    // Touch an unrelated ticket so the cascade gets a chance to mis-fire.
    const other = await createTicket(paths, "alpha", { title: "other", type: "task" });
    await updateTicket(paths, "alpha", other.id, { status: "closed" });

    const parent = await readTicket(paths, "alpha", epic.id);
    expect(parent?.status).toBe("open");
  });

  test("cascades up epic-of-epic chain", async () => {
    const grand = await createTicket(paths, "alpha", { title: "G", type: "epic" });
    const parent = await createTicket(paths, "alpha", {
      title: "P",
      type: "epic",
      parentEpic: grand.id,
    });
    const child = await createTicket(paths, "alpha", {
      title: "c",
      type: "task",
      parentEpic: parent.id,
    });

    await updateTicket(paths, "alpha", child.id, { status: "closed" });

    expect((await readTicket(paths, "alpha", parent.id))?.status).toBe("closed");
    expect((await readTicket(paths, "alpha", grand.id))?.status).toBe("closed");
  });

  test("does not close epic if one sibling is in_progress", async () => {
    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    const c1 = await createTicket(paths, "alpha", {
      title: "c1",
      type: "task",
      parentEpic: epic.id,
    });
    const c2 = await createTicket(paths, "alpha", {
      title: "c2",
      type: "task",
      parentEpic: epic.id,
    });

    await updateTicket(paths, "alpha", c2.id, { status: "in_progress" });
    await updateTicket(paths, "alpha", c1.id, { status: "closed" });

    expect((await readTicket(paths, "alpha", epic.id))?.status).toBe("open");
  });

  test("closing a non-child ticket leaves unrelated epic alone", async () => {
    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    await createTicket(paths, "alpha", {
      title: "child",
      type: "task",
      parentEpic: epic.id,
    });
    const standalone = await createTicket(paths, "alpha", {
      title: "lone",
      type: "task",
    });

    await updateTicket(paths, "alpha", standalone.id, { status: "closed" });

    expect((await readTicket(paths, "alpha", epic.id))?.status).toBe("open");
  });

  test("idempotent: closing an already-closed ticket doesn't error", async () => {
    const epic = await createTicket(paths, "alpha", { title: "E", type: "epic" });
    const child = await createTicket(paths, "alpha", {
      title: "c",
      type: "task",
      parentEpic: epic.id,
    });

    await updateTicket(paths, "alpha", child.id, { status: "closed" });
    expect((await readTicket(paths, "alpha", epic.id))?.status).toBe("closed");

    // Touching the closed child again — the epic is already closed, so the
    // cascade's early-exit kicks in.
    await updateTicket(paths, "alpha", child.id, { status: "closed" });
    expect((await readTicket(paths, "alpha", epic.id))?.status).toBe("closed");
  });
});
