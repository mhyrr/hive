import { appendFileSync } from "node:fs";

import { callAnthropic } from "./anthropic-client";

export type SignalClass =
  | "noise"
  | "status_update"
  | "evidence"
  | "blocker"
  | "reorientation_trigger"
  | "interrupt";

export type Urgency = "background" | "normal" | "urgent" | "critical";

export type TacticalRouting =
  | { action: "discard" }
  | { action: "log" }
  | { action: "tactical"; command: string }
  | { action: "wake_strategic" }
  | { action: "interrupt"; workerId: string };

export type TacticalEvaluation = {
  classification: SignalClass;
  urgency: Urgency;
  routing: TacticalRouting;
  reasoning: string;
  timestamp: string;
};

export type Signal = {
  type:
    | "worker_complete"
    | "board_change"
    | "message"
    | "run_change"
    | "feed_entry"
    | "unknown";
  description: string;
  payload?: string;
};

export type ActiveContext = {
  goalTitle: string;
  workerCount: number;
  workerSummaries: string;
  boardDigest: string;
  lastStrategicEval: string;
};

const SYSTEM_PROMPT = `You are the tactical evaluator for a running HIVE multi-agent system. Classify incoming signals quickly and accurately. Be terse. Output exactly the four labeled lines requested — nothing else.`;

function buildPrompt(opts: {
  signal: Signal;
  orientation: string;
  context: ActiveContext;
}): string {
  const { signal, orientation, context } = opts;

  const payloadLine = signal.payload
    ? `\nExcerpt: ${signal.payload.slice(0, 200)}`
    : "";

  return `${orientation}

## Signal
${signal.type}: ${signal.description}${payloadLine}

## Active Context
- Goal: ${context.goalTitle}
- Workers in flight: ${context.workerCount} (${context.workerSummaries})
- Board state: ${context.boardDigest}
- Last strategic evaluation: ${context.lastStrategicEval}

## Evaluate
Given the orientation and signal:
1. CLASSIFICATION: [noise | status_update | evidence | blocker | reorientation_trigger | interrupt]
2. URGENCY: [background | normal | urgent | critical]
3. ROUTING: [discard | log | tactical_action:<action> | wake_strategic | interrupt:<worker_id>]
4. REASONING: One sentence explaining why.`;
}

const VALID_CLASSES: SignalClass[] = [
  "noise",
  "status_update",
  "evidence",
  "blocker",
  "reorientation_trigger",
  "interrupt",
];

const VALID_URGENCIES: Urgency[] = ["background", "normal", "urgent", "critical"];

function parseRouting(raw: string): TacticalRouting {
  const s = raw.trim().toLowerCase();

  if (s === "discard") return { action: "discard" };
  if (s === "log") return { action: "log" };
  if (s === "wake_strategic") return { action: "wake_strategic" };

  if (s.startsWith("interrupt:")) {
    const workerId = raw.slice("interrupt:".length).trim();
    return { action: "interrupt", workerId };
  }

  if (s.startsWith("tactical_action:")) {
    const command = raw.slice("tactical_action:".length).trim();
    return { action: "tactical", command };
  }

  // Fallback: anything unrecognized → log
  return { action: "log" };
}

function parseEvaluation(text: string): TacticalEvaluation | null {
  const extract = (key: string): string | null => {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "mi"));
    return match?.[1]?.trim() ?? null;
  };

  const classRaw = extract("CLASSIFICATION");
  const urgencyRaw = extract("URGENCY");
  const routingRaw = extract("ROUTING");
  const reasoning = extract("REASONING");

  if (!classRaw || !urgencyRaw || !routingRaw || !reasoning) {
    return null;
  }

  const classification = VALID_CLASSES.includes(classRaw.toLowerCase() as SignalClass)
    ? (classRaw.toLowerCase() as SignalClass)
    : null;

  const urgency = VALID_URGENCIES.includes(urgencyRaw.toLowerCase() as Urgency)
    ? (urgencyRaw.toLowerCase() as Urgency)
    : null;

  if (!classification || !urgency) {
    return null;
  }

  return {
    classification,
    urgency,
    routing: parseRouting(routingRaw),
    reasoning,
    timestamp: new Date().toISOString(),
  };
}

function fallbackEvaluation(): TacticalEvaluation {
  return {
    classification: "status_update",
    urgency: "background",
    routing: { action: "log" },
    reasoning: "evaluation failed — fallback",
    timestamp: new Date().toISOString(),
  };
}

function appendToEvalLog(evalLogPath: string, entry: TacticalEvaluation & { signal: Signal }): void {
  try {
    appendFileSync(evalLogPath, JSON.stringify(entry) + "\n");
  } catch {
    // Non-fatal — don't let log write failures break the evaluation loop
  }
}

export async function evaluateSignal(opts: {
  signal: Signal;
  orientation: string;
  context: ActiveContext;
  evalLogPath: string;
}): Promise<TacticalEvaluation> {
  const { signal, orientation, context, evalLogPath } = opts;

  const prompt = buildPrompt({ signal, orientation, context });

  let result: TacticalEvaluation;

  try {
    const text = await callAnthropic({
      model: "claude-haiku-4-5-20251001",
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      maxTokens: 150,
      timeoutMs: 5000,
    });

    const parsed = parseEvaluation(text);

    if (!parsed) {
      console.warn("[tactical-evaluator] parse failed, using fallback");
      console.warn("[tactical-evaluator] raw output:", text.slice(0, 300));
      result = fallbackEvaluation();
    } else {
      result = parsed;
    }
  } catch (err) {
    console.warn(
      `[tactical-evaluator] model call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    result = fallbackEvaluation();
  }

  appendToEvalLog(evalLogPath, { ...result, signal });

  return result;
}
