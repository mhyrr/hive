import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ticketsCommand } from "../commands/ticket";
import { ensureHiveScaffold, type HivePaths } from "../lib/paths";
import {
  createTicket,
  updateTicket,
  sortTicketsForDisplay,
  formatTicketRow,
  formatTicketSummary,
  type Ticket,
} from "../lib/ticket";

let paths: HivePaths;
let repoDir: string;
let prevHome: string | undefined;
let prevCwd: string;
let output: string[];
let realLog: typeof console.log;

async function registerProject(name: string, path: string): Promise<void> {
  const dir = join(paths.projectsDir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "config.md"), `---\nname: ${name}\npath: ${path}\n---\n`);
}

beforeEach(async () => {
  // realpath: macOS tmpdir() is /var/... while process.cwd() reports /private/var/...
  const home = await realpath(await mkdtemp(join(tmpdir(), "hive-tickets-")));
  repoDir = await realpath(await mkdtemp(join(tmpdir(), "hive-repo-")));

  prevHome = process.env.HIVE_HOME;
  process.env.HIVE_HOME = home;
  prevCwd = process.cwd();
  process.chdir(repoDir);

  paths = await ensureHiveScaffold(home);
  await registerProject("alpha", repoDir);

  output = [];
  realLog = console.log;
  console.log = (...args: unknown[]) => { output.push(args.join(" ")); };
});

afterEach(() => {
  console.log = realLog;
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = prevHome;
});

const text = () => output.join("\n");

describe("hive tickets", () => {
  test("lists open and in-progress tickets, hides closed", async () => {
    const a = await createTicket(paths, "alpha", { title: "still open" });
    const b = await createTicket(paths, "alpha", { title: "being worked" });
    const c = await createTicket(paths, "alpha", { title: "already done" });
    await updateTicket(paths, "alpha", b.id, { status: "in_progress" });
    await updateTicket(paths, "alpha", c.id, { status: "closed" });

    await ticketsCommand([]);

    expect(text()).toContain(a.id);
    expect(text()).toContain(b.id);
    expect(text()).not.toContain(c.id);
    expect(text()).toContain("alpha — 2 open (1 in progress)");
  });

  test("resolves the project from cwd with no flags", async () => {
    await createTicket(paths, "alpha", { title: "from cwd" });
    await ticketsCommand([]);
    expect(text()).toContain("from cwd");
  });

  test("--all includes closed", async () => {
    const done = await createTicket(paths, "alpha", { title: "already done" });
    await updateTicket(paths, "alpha", done.id, { status: "closed" });

    await ticketsCommand(["--all"]);
    expect(text()).toContain(done.id);
  });

  test("--all composes with a following flag", async () => {
    const bug = await createTicket(paths, "alpha", { title: "a bug", type: "bug" });
    await updateTicket(paths, "alpha", bug.id, { status: "closed" });
    const chore = await createTicket(paths, "alpha", { title: "a chore", type: "chore" });

    await ticketsCommand(["--all", "--type", "bug"]);
    expect(text()).toContain(bug.id);
    expect(text()).not.toContain(chore.id);
  });

  test("--status closed shows only closed", async () => {
    const open = await createTicket(paths, "alpha", { title: "open one" });
    const done = await createTicket(paths, "alpha", { title: "closed one" });
    await updateTicket(paths, "alpha", done.id, { status: "closed" });

    await ticketsCommand(["--status", "closed"]);
    expect(text()).toContain(done.id);
    expect(text()).not.toContain(open.id);
  });

  test("empty project says so instead of printing a bare header", async () => {
    await ticketsCommand([]);
    expect(text()).toBe("alpha — no open tickets.");
  });

  test("forwards subcommands to hive ticket", async () => {
    const t = await createTicket(paths, "alpha", { title: "detail me" });
    await ticketsCommand(["show", t.id]);
    expect(text()).toContain(`# ${t.id}: detail me`);
  });

  test("--project overrides cwd resolution", async () => {
    const other = await realpath(await mkdtemp(join(tmpdir(), "hive-other-")));
    await registerProject("beta", other);
    await createTicket(paths, "beta", { title: "beta work" });
    await createTicket(paths, "alpha", { title: "alpha work" });

    await ticketsCommand(["--project", "beta"]);
    expect(text()).toContain("beta work");
    expect(text()).not.toContain("alpha work");
  });
});

const stubTicket = (over: Partial<Ticket> = {}): Ticket => ({
  id: "TK-001", title: "t", status: "open", type: "task", priority: 2,
  tags: [], created: "", updated: "", closed: null, ref: null,
  depends: [], parentEpic: null, ...over,
});

describe("formatTicketRow", () => {
  const t = stubTicket({
    title: "Pass V prompt exceeds 200k context — nightly canon writes blocked",
    status: "in_progress",
    priority: 0,
    type: "bug",
    tags: ["nightly", "verify", "memory", "orchestrator"],
  });

  test("wraps the description into its own column with a hanging indent", () => {
    const lines = formatTicketRow(t, 100).split("\n");
    expect(lines.length).toBeGreaterThan(1);

    const column = formatTicketSummary(t).indexOf(t.title);
    for (const line of lines.slice(1)) {
      expect(line.slice(0, column)).toBe(" ".repeat(column));
      expect(line[column]).not.toBe(" ");
    }
  });

  test("no line exceeds the terminal width", () => {
    for (const width of [80, 100, 120]) {
      for (const line of formatTicketRow(t, width).split("\n")) {
        expect(line.length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("width 0 (piped output) stays one line per ticket", () => {
    expect(formatTicketRow(t, 0)).toBe(formatTicketSummary(t));
    expect(formatTicketRow(t, 0)).not.toContain("\n");
  });

  test("a terminal too narrow to hold a description column is left alone", () => {
    expect(formatTicketRow(t, 50)).toBe(formatTicketSummary(t));
  });

  test("a short description never wraps", () => {
    const short = stubTicket({ title: "Fix it" });
    expect(formatTicketRow(short, 120)).toBe(formatTicketSummary(short));
  });

  test("a word longer than the column is broken, not bled past the edge", () => {
    const long = stubTicket({ title: "x".repeat(200) });
    for (const line of formatTicketRow(long, 100).split("\n")) {
      expect(line.length).toBeLessThanOrEqual(100);
    }
  });

  test("wrapping preserves every word of the description", () => {
    const flat = formatTicketRow(t, 100)
      .split("\n")
      .map((l) => l.trim())
      .join(" ");
    expect(flat).toContain(t.title);
    expect(flat).toContain("[nightly, verify, memory, orchestrator]");
  });
});

describe("sortTicketsForDisplay", () => {
  const t = (id: string, status: Ticket["status"], priority: 0 | 1 | 2 | 3): Ticket =>
    stubTicket({ id, title: id, status, priority });

  test("in_progress first, then priority, then ticket number", () => {
    const sorted = sortTicketsForDisplay([
      t("TK-003", "open", 0),
      t("TK-001", "open", 2),
      t("TK-002", "in_progress", 3),
      t("TK-010", "open", 0),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["TK-002", "TK-003", "TK-010", "TK-001"]);
  });

  test("does not mutate the input", () => {
    const input = [t("TK-002", "open", 2), t("TK-001", "in_progress", 2)];
    sortTicketsForDisplay(input);
    expect(input.map((x) => x.id)).toEqual(["TK-002", "TK-001"]);
  });

  test("sorts TK-010 after TK-009, not before", () => {
    const sorted = sortTicketsForDisplay([t("TK-010", "open", 2), t("TK-009", "open", 2)]);
    expect(sorted.map((x) => x.id)).toEqual(["TK-009", "TK-010"]);
  });
});
