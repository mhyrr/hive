import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";
import { toIsoTimestamp } from "./time";

export type GoalStatus = "active" | "resolved" | "stuck" | "needs-human" | "review";

export type GoalRecord = {
  id: string;
  description: string;
  status: GoalStatus;
  plan: string;
  evidence: string[];
  waveAgents: string[];
  waveNumber: number;
  createdAt: string;
  updatedAt: string;
};

export type Goal = GoalRecord;

function generateGoalId(): string {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = Math.random().toString(16).slice(2, 8);
  return `goal-${date}-${suffix}`;
}

function goalPath(goalsDir: string, id: string): string {
  return join(goalsDir, `${id}.md`);
}

function serializeGoal(goal: GoalRecord): string {
  const evidenceLines =
    goal.evidence.length > 0 ? goal.evidence.map((e) => `- ${e}`).join("\n") : "(none)";
  const planText = goal.plan || "(none)";
  const body = `## Plan\n${planText}\n\n## Evidence\n${evidenceLines}`;

  return stringifyFrontmatter(
    {
      id: goal.id,
      description: goal.description,
      status: goal.status,
      waveAgents: goal.waveAgents.join(","),
      waveNumber: String(goal.waveNumber),
      createdAt: goal.createdAt,
      updatedAt: goal.updatedAt,
    },
    body,
  );
}

function parseWaveAgents(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [];
  }

  return value
    .split(",")
    .map((agent) => agent.trim())
    .filter(Boolean);
}

function parseWaveNumber(value: string | undefined): number {
  if (!value?.trim()) {
    return 0;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) ? parsed : 0;
}

function parseGoalFile(content: string): GoalRecord | null {
  const { attributes, body } = parseFrontmatter(content);

  if (!attributes.id || !attributes.description) {
    return null;
  }

  const planMatch = body.match(/^## Plan\n([\s\S]*?)(?=\n## |$)/m);
  const evidenceMatch = body.match(/^## Evidence\n([\s\S]*?)(?=\n## |$)/m);

  const planRaw = planMatch ? planMatch[1].trim() : "";
  const evidenceRaw = evidenceMatch ? evidenceMatch[1].trim() : "";

  const plan = planRaw === "(none)" ? "" : planRaw;
  const evidence =
    !evidenceRaw || evidenceRaw === "(none)"
      ? []
      : evidenceRaw
          .split("\n")
          .filter((l) => l.startsWith("- "))
          .map((l) => l.slice(2).trim());

  return {
    id: attributes.id,
    description: attributes.description,
    status: (attributes.status as GoalStatus) || "active",
    plan,
    evidence,
    waveAgents: parseWaveAgents(attributes.waveAgents),
    waveNumber: parseWaveNumber(attributes.waveNumber),
    createdAt: attributes.createdAt || "",
    updatedAt: attributes.updatedAt || "",
  };
}

export async function writeGoalRecord(
  goalsDir: string,
  goal: GoalRecord,
): Promise<void> {
  await Bun.write(goalPath(goalsDir, goal.id), serializeGoal(goal));
}

export async function createGoal(goalsDir: string, description: string): Promise<GoalRecord> {
  await mkdir(goalsDir, { recursive: true });

  const now = toIsoTimestamp();
  const goal: GoalRecord = {
    id: generateGoalId(),
    description,
    status: "active",
    plan: "",
    evidence: [],
    waveAgents: [],
    waveNumber: 0,
    createdAt: now,
    updatedAt: now,
  };

  await writeGoalRecord(goalsDir, goal);
  return goal;
}

export async function readGoal(goalsDir: string, id: string): Promise<GoalRecord | null> {
  const file = Bun.file(goalPath(goalsDir, id));
  if (!(await file.exists())) return null;
  const content = await file.text();
  return parseGoalFile(content);
}

export async function updateGoalStatus(
  goalsDir: string,
  id: string,
  status: GoalStatus,
): Promise<void> {
  const goal = await readGoal(goalsDir, id);
  if (!goal) throw new Error(`Goal not found: ${id}`);
  goal.status = status;
  goal.updatedAt = toIsoTimestamp();
  await writeGoalRecord(goalsDir, goal);
}

export async function appendEvidence(
  goalsDir: string,
  id: string,
  finding: string,
): Promise<void> {
  const goal = await readGoal(goalsDir, id);
  if (!goal) throw new Error(`Goal not found: ${id}`);
  goal.evidence.push(finding);
  goal.updatedAt = toIsoTimestamp();
  await writeGoalRecord(goalsDir, goal);
}

export async function updatePlan(goalsDir: string, id: string, plan: string): Promise<void> {
  const goal = await readGoal(goalsDir, id);
  if (!goal) throw new Error(`Goal not found: ${id}`);
  goal.plan = plan;
  goal.updatedAt = toIsoTimestamp();
  await writeGoalRecord(goalsDir, goal);
}

export async function listGoals(goalsDir: string): Promise<GoalRecord[]> {
  const entries = await readdir(goalsDir, { withFileTypes: true }).catch(() => []);
  const goals: GoalRecord[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = Bun.file(join(goalsDir, entry.name));
    const content = await file.text();
    const goal = parseGoalFile(content);
    if (goal) goals.push(goal);
  }

  return goals.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function listActiveGoals(goalsDir: string): Promise<Goal[]> {
  const all = await listGoals(goalsDir);
  return all.filter((g) => g.status === "active");
}
