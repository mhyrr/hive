import { appendFileSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { callAnthropic } from "./anthropic-client";
import { createMessage } from "./messages";
import type { HivePaths, ProjectPaths } from "./paths";
import type { TacticalEvaluation } from "./tactical-evaluator";

export type StrategicLoopConfig = {
  hivePaths: HivePaths;
  projectId: string;
  projectPaths: ProjectPaths;
  runtimeOverride?: string;
  modelOverride?: string;
};

export type StrategicDecision =
  | { action: "dispatch"; agentId: string; assignment: string; reasoning: string }
  | { action: "log"; reasoning: string }
  | { action: "escalate"; message: string; reasoning: string };

const STRATEGIC_MODEL = "claude-haiku-4-5-20251001";

const SYSTEM_PROMPT = `You are the strategic evaluator for a HIVE multi-agent project. Given the current board state, recent log, and a tactical trigger, decide the single highest-value next action. Be terse and decisive. Output exactly the labeled lines requested — nothing else.`;

async function readBoardText(boardPath: string): Promise<string> {
  try {
    return readFileSync(boardPath, "utf-8").trim();
  } catch {
    return "(board unavailable)";
  }
}

async function readRecentLog(logPath: string, lineCount = 20): Promise<string> {
  try {
    const text = readFileSync(logPath, "utf-8");
    const lines = text.split("\n").filter((l) => l.trim());
    return lines.slice(-lineCount).join("\n") || "(log empty)";
  } catch {
    return "(log unavailable)";
  }
}

async function countOpenMessages(msgDir: string): Promise<number> {
  try {
    const entries = await readdir(msgDir, { withFileTypes: true });
    let count = 0;

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      try {
        const text = readFileSync(join(msgDir, entry.name), "utf-8");

        if (/^status:\s*open\s*$/m.test(text)) {
          count++;
        }
      } catch {
        // skip unreadable files
      }
    }

    return count;
  } catch {
    return 0;
  }
}

function buildOrientPrompt(opts: {
  projectId: string;
  boardText: string;
  recentLog: string;
  openMessageCount: number;
  trigger: TacticalEvaluation;
}): string {
  const { projectId, boardText, recentLog, openMessageCount, trigger } = opts;

  // Board section: keep it bounded — first 60 lines max
  const boardLines = boardText.split("\n").slice(0, 60).join("\n");

  // Log: already bounded to 20 lines
  const logExcerpt = recentLog.slice(0, 1000);

  return `## Project: ${projectId}

## Board State
${boardLines}

## Recent Log (last 20 entries)
${logExcerpt}

## System State
- Open messages: ${openMessageCount}

## Triggering Signal
Classification: ${trigger.classification}
Urgency: ${trigger.urgency}
Reasoning: ${trigger.reasoning}

## Strategic Evaluation

What is the single highest-value next action for this project right now?

Choose ONE:
- dispatch: assign a specific task to an available agent
- log: no action needed, continue watching
- escalate: something requires human attention

Output exactly these labeled lines:
ACTION: <dispatch | log | escalate>
AGENT: <agent_id — only if dispatch, e.g. "alpha", "beta", "gamma">
ASSIGNMENT: <one or two sentences describing what the agent should do — only if dispatch>
MESSAGE: <one or two sentences explaining what needs human attention — only if escalate>
REASONING: <one sentence explaining why>`;
}

function parseDecision(text: string): StrategicDecision | null {
  const extract = (key: string): string | null => {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));
    return match?.[1]?.trim() ?? null;
  };

  const action = extract("ACTION")?.toLowerCase();
  const reasoning = extract("REASONING") ?? "no reasoning provided";

  if (!action) {
    return null;
  }

  if (action === "dispatch") {
    const agentId = extract("AGENT");
    const assignment = extract("ASSIGNMENT");

    if (!agentId || !assignment) {
      return { action: "log", reasoning: `dispatch parse failed — ${reasoning}` };
    }

    return { action: "dispatch", agentId, assignment, reasoning };
  }

  if (action === "escalate") {
    const message = extract("MESSAGE") ?? "Strategic loop requires human review.";
    return { action: "escalate", message, reasoning };
  }

  if (action === "log") {
    return { action: "log", reasoning };
  }

  // Unknown action — fallback to log
  return { action: "log", reasoning: `unknown action '${action}' — ${reasoning}` };
}

function fallbackDecision(reason: string): StrategicDecision {
  return { action: "log", reasoning: `strategic pass failed — ${reason}` };
}

function appendStrategicEvalLog(logPath: string, entry: {
  ts: string;
  trigger: TacticalEvaluation;
  decision: StrategicDecision;
}): void {
  try {
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  } catch {
    // Non-fatal
  }
}

async function actOnDecision(
  decision: StrategicDecision,
  config: StrategicLoopConfig,
  trigger: TacticalEvaluation,
): Promise<void> {
  const ts = new Date().toISOString();
  const strategicEvalLogPath = join(config.projectPaths.stateDir, "strategic-eval.log");

  switch (decision.action) {
    case "dispatch": {
      const body = `# Strategic Dispatch

${decision.assignment}

## Trigger
- Classification: ${trigger.classification}
- Urgency: ${trigger.urgency}
- Reasoning: ${trigger.reasoning}

## Strategic Reasoning
${decision.reasoning}`;

      try {
        await createMessage(config.hivePaths.msgDir, {
          from: "alpha",
          to: decision.agentId,
          type: "assign",
          project: config.projectId,
          body,
        });
        console.log(`[strategic-loop] dispatched assignment to ${decision.agentId}`);
      } catch (err) {
        console.warn(
          `[strategic-loop] failed to write dispatch message: ${err instanceof Error ? err.message : String(err)}`,
        );
        appendStrategicEvalLog(strategicEvalLogPath, { ts, trigger, decision });
      }
      break;
    }

    case "log": {
      appendStrategicEvalLog(strategicEvalLogPath, { ts, trigger, decision });
      break;
    }

    case "escalate": {
      const body = `# Strategic Escalation

${decision.message}

## Trigger
- Classification: ${trigger.classification}
- Urgency: ${trigger.urgency}
- Reasoning: ${trigger.reasoning}

## Strategic Reasoning
${decision.reasoning}`;

      try {
        await createMessage(config.hivePaths.msgDir, {
          from: "alpha",
          to: "steward",
          type: "nudge",
          project: config.projectId,
          body,
        });
        console.log("[strategic-loop] escalation nudge sent to steward");
      } catch (err) {
        console.warn(
          `[strategic-loop] failed to write escalation message: ${err instanceof Error ? err.message : String(err)}`,
        );
        appendStrategicEvalLog(strategicEvalLogPath, { ts, trigger, decision });
      }
      break;
    }
  }
}

export async function runStrategicPass(
  config: StrategicLoopConfig,
  trigger: TacticalEvaluation,
): Promise<StrategicDecision> {
  const model = config.modelOverride ?? STRATEGIC_MODEL;

  const [boardText, recentLog, openMessageCount] = await Promise.all([
    readBoardText(config.projectPaths.board),
    readRecentLog(config.projectPaths.log),
    countOpenMessages(config.hivePaths.msgDir),
  ]);

  const prompt = buildOrientPrompt({
    projectId: config.projectId,
    boardText,
    recentLog,
    openMessageCount,
    trigger,
  });

  let decision: StrategicDecision;

  try {
    const text = await callAnthropic({
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 300,
      timeoutMs: 15000,
    });

    const parsed = parseDecision(text);

    if (!parsed) {
      console.warn("[strategic-loop] parse failed, raw output:", text.slice(0, 300));
      decision = fallbackDecision("parse failed");
    } else {
      decision = parsed;
    }
  } catch (err) {
    console.warn(
      `[strategic-loop] model call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    decision = fallbackDecision(err instanceof Error ? err.message : String(err));
  }

  await actOnDecision(decision, config, trigger);

  return decision;
}
