/**
 * Council engine — dispatches the same question to multiple models in parallel,
 * collects their independent positions, and returns structured output for the
 * steward to synthesize as chair.
 *
 * Inspired by Perplexity's Model Council and Karpathy's LLM Council, but
 * designed for the hive: the steward IS the chair, not a separate model.
 */

import { extractConfigValue, extractConfigValueAlias } from "./config";
import { type ModelPoolEntry, parseModelPool } from "./project";
import { completeClaudeText } from "./claude";
import { completeCodexText } from "./codex";
import { completeGeminiText } from "./gemini";
import type { ModelTextCompletion } from "./model";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CouncilMember = {
  model: ModelPoolEntry;
  /** Canonical runtime: "claude" | "codex" | "gemini" | "ollama" */
  runtime: string;
  modelId: string;
};

export type CouncilPosition = {
  modelName: string;
  modelId: string;
  provider: string;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  error: string | null;
};

export type CouncilResult = {
  question: string;
  positions: CouncilPosition[];
  durationMs: number;
};

// ---------------------------------------------------------------------------
// Dialectic types
// ---------------------------------------------------------------------------

export type Camp = {
  name: string;
  position: string;
  brief?: string;
};

export type DialecticAssignment = {
  member: CouncilMember;
  role: "advocate" | "skeptic";
  camp?: Camp;
};

export type DialecticPosition = CouncilPosition & {
  role: "advocate" | "skeptic";
  campName?: string;
  roundNumber: number;
};

export type DialecticRound = {
  roundNumber: number;
  positions: DialecticPosition[];
  durationMs: number;
};

export type DialecticResult = {
  question: string;
  camps: Camp[];
  rounds: DialecticRound[];
  totalDurationMs: number;
};

// ---------------------------------------------------------------------------
// Runtime aliases → canonical name
// ---------------------------------------------------------------------------

const RUNTIME_ALIASES: Record<string, string> = {
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  openai: "codex",
  gemini: "gemini",
  "gemini-cli": "gemini",
  google: "gemini",
  ollama: "ollama",
  local: "ollama",
  oss: "ollama",
};

function normalizeRuntime(runtime: string): string {
  return RUNTIME_ALIASES[runtime.trim().toLowerCase()] ?? runtime.trim().toLowerCase();
}

function runtimeToProvider(runtime: string): string {
  const r = normalizeRuntime(runtime);
  if (r === "claude") return "anthropic";
  if (r === "codex") return "openai";
  if (r === "gemini") return "google";
  if (r === "ollama") return "ollama";
  return r;
}

// ---------------------------------------------------------------------------
// Ollama direct call (for local models)
// ---------------------------------------------------------------------------

const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

function resolveOllamaBaseUrl(globalConfig: string): string {
  const configured = extractConfigValueAlias(globalConfig, [
    "ollama-base-url",
    "ollama_base_url",
  ]);

  if (!configured?.trim()) {
    return DEFAULT_OLLAMA_BASE_URL;
  }

  return configured.trim().replace(/\/+$/, "");
}

async function callOllama(input: {
  baseUrl: string;
  model: string;
  system: string;
  prompt: string;
  timeoutMs?: number;
}): Promise<{ text: string; durationMs: number }> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? 120_000,
  );

  try {
    const response = await fetch(`${input.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: input.model,
        system: input.system,
        prompt: input.prompt,
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Ollama returned ${response.status}: ${body.slice(0, 200)}`,
      );
    }

    const data = (await response.json()) as { response?: string };

    return {
      text: data.response?.trim() ?? "",
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Resolve council members from model pool
// ---------------------------------------------------------------------------

export function resolveCouncilMembers(
  globalConfig: string,
  modelNames: string[],
): { members: CouncilMember[]; errors: string[] } {
  const pool = parseModelPool(globalConfig);
  const members: CouncilMember[] = [];
  const errors: string[] = [];

  const supportedRuntimes = ["claude", "codex", "gemini", "ollama"];

  for (const name of modelNames) {
    const entry = pool.find((e) => e.name === name);

    if (!entry) {
      const available = pool.map((e) => e.name).join(", ");
      errors.push(
        `Unknown model '${name}'. Available: ${available || "(none configured)"}`,
      );
      continue;
    }

    const runtime = normalizeRuntime(entry.runtime);

    if (!supportedRuntimes.includes(runtime)) {
      errors.push(
        `Unsupported runtime '${entry.runtime}' for model '${name}'. ` +
          `Supported: ${supportedRuntimes.join(", ")}.`,
      );
      continue;
    }

    members.push({
      model: entry,
      runtime,
      modelId: entry.model,
    });
  }

  return { members, errors };
}

// ---------------------------------------------------------------------------
// Call a single council member
// ---------------------------------------------------------------------------

async function callCliProvider(
  runtime: string,
  modelId: string,
  systemPrompt: string,
  userContent: string,
): Promise<ModelTextCompletion> {
  switch (runtime) {
    case "claude":
      return completeClaudeText({ modelId, systemPrompt, userContent });
    case "codex":
      return completeCodexText({ modelId, systemPrompt, userContent });
    case "gemini":
      return completeGeminiText({ modelId, systemPrompt, userContent });
    default:
      throw new Error(`No CLI driver for runtime '${runtime}'.`);
  }
}

async function callCouncilMember(
  member: CouncilMember,
  systemPrompt: string,
  question: string,
  globalConfig: string,
): Promise<CouncilPosition> {
  const provider = runtimeToProvider(member.runtime);
  const base: Omit<CouncilPosition, "text" | "durationMs" | "error" | "inputTokens" | "outputTokens"> = {
    modelName: member.model.name,
    modelId: member.modelId,
    provider,
  };

  try {
    if (member.runtime === "ollama") {
      const baseUrl = resolveOllamaBaseUrl(globalConfig);
      const result = await callOllama({
        baseUrl,
        model: member.modelId,
        system: systemPrompt,
        prompt: question,
      });

      return {
        ...base,
        text: result.text,
        durationMs: result.durationMs,
        inputTokens: null,
        outputTokens: null,
        error: null,
      };
    }

    // CLI-backed provider — each driver handles its own auth natively
    const result = await callCliProvider(member.runtime, member.modelId, systemPrompt, question);

    return {
      ...base,
      text: result.text,
      durationMs: result.durationMs ?? 0,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      error: null,
    };
  } catch (err) {
    return {
      ...base,
      text: "",
      durationMs: 0,
      inputTokens: null,
      outputTokens: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Council system prompt
// ---------------------------------------------------------------------------

export function buildCouncilMemberPrompt(persona: string | null): string {
  const base = [
    "You are a council member asked to give your independent analysis of a question.",
    "Your response will be compared with other models' responses to surface agreement and disagreement.",
    "",
    "Guidelines:",
    "- State your position clearly and directly.",
    "- Identify your key assumptions.",
    "- Flag uncertainty — say what you're confident about and what you're not.",
    "- Be specific and concrete, not vague.",
    "- If the question has multiple valid answers, explain the tradeoffs.",
    "- Keep your response focused and concise.",
  ];

  if (persona === "analyst") {
    base.push(
      "",
      "You are an analyst. Structure your thinking:",
      "- Frame the problem precisely before solving it.",
      "- Consider multiple angles: risk, opportunity, precedent, second-order effects.",
      "- Distinguish facts from inferences from speculation.",
      "- End with a clear recommendation or position.",
    );
  }

  return base.join("\n");
}

// ---------------------------------------------------------------------------
// Dialectic: camp assignment
// ---------------------------------------------------------------------------

export function assignCamps(
  members: CouncilMember[],
  camps: Camp[],
): DialecticAssignment[] {
  const assignments: DialecticAssignment[] = [];

  for (let i = 0; i < members.length; i++) {
    if (i < camps.length) {
      // First N members get one camp each
      assignments.push({ member: members[i]!, role: "advocate", camp: camps[i]! });
    } else if (camps.length > 0 && members.length > camps.length) {
      // Extra members beyond camp count: first extra becomes skeptic,
      // rest round-robin back to camps
      const extraIndex = i - camps.length;
      if (extraIndex === 0) {
        assignments.push({ member: members[i]!, role: "skeptic" });
      } else {
        const campIndex = (extraIndex - 1) % camps.length;
        assignments.push({ member: members[i]!, role: "advocate", camp: camps[campIndex]! });
      }
    }
  }

  return assignments;
}

// ---------------------------------------------------------------------------
// Dialectic: prompt generation
// ---------------------------------------------------------------------------

function formatPreviousRoundPositions(positions: DialecticPosition[]): string {
  const lines: string[] = [];

  for (const pos of positions) {
    if (pos.error) continue;
    const label = pos.role === "skeptic"
      ? `${pos.modelName} (skeptic)`
      : `${pos.modelName} (arguing for: ${pos.campName})`;
    lines.push(`### ${label}`);
    lines.push(pos.text);
    lines.push("");
  }

  return lines.join("\n");
}

export function buildDialecticPrompt(
  assignment: DialecticAssignment,
  roundNumber: number,
  previousRounds: DialecticRound[],
  camps: Camp[],
): string {
  const prevPositions = previousRounds.length > 0
    ? previousRounds[previousRounds.length - 1]!.positions
    : [];
  const prevFormatted = formatPreviousRoundPositions(prevPositions);

  if (assignment.role === "skeptic") {
    if (roundNumber === 1) {
      return [
        "You are the skeptic in a structured dialectic. You do not advocate for any position. You pressure-test each one.",
        "",
        "For each position being argued, identify:",
        "- The strongest counterargument they haven't addressed",
        "- The assumption most likely to be wrong",
        "- The failure mode they're underweighting",
        "",
        `Positions being argued: ${camps.map((c) => `"${c.name}" — ${c.position}`).join("; ")}`,
      ].join("\n");
    }

    return [
      `You are the skeptic in round ${roundNumber} of a structured dialectic.`,
      "",
      "Here is what was argued in the previous round:",
      "",
      prevFormatted,
      "Update your analysis. Which positions got stronger? Which got weaker? What are they still not addressing?",
    ].join("\n");
  }

  // Advocate
  const camp = assignment.camp!;

  if (roundNumber === 1) {
    return [
      "You are arguing for the following position in a structured dialectic:",
      "",
      `Position: ${camp.position}`,
      camp.brief ? `\nContext for your position: ${camp.brief}` : "",
      "",
      "Make the STRONGEST possible case. This is not about balance — it is about rigor.",
      "Find every supporting argument. Anticipate counterarguments and preempt them.",
      "",
      "You are not performing a character. You are doing the intellectual work of finding",
      "the best version of this argument. If the position has genuine weaknesses,",
      "acknowledge them briefly and explain why the position is still the best option despite them.",
    ].join("\n");
  }

  return [
    `You are in round ${roundNumber} of a dialectic arguing for: ${camp.position}`,
    "",
    "Here is what was argued in the previous round:",
    "",
    prevFormatted,
    "Refine your position. Address the strongest points made against you.",
    "Concede where denial would undermine your credibility. Sharpen where the other side was weak.",
    "",
    roundNumber >= 3
      ? "This is the final round. Make your strongest case, incorporating everything you've learned from the debate. Where has your position genuinely improved? Where has the other side made points you can't dismiss?"
      : "Do not repeat your previous arguments verbatim. Evolve them.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main entry point: convene the council
// ---------------------------------------------------------------------------

export async function conveneCouncil(input: {
  question: string;
  members: CouncilMember[];
  globalConfig: string;
  persona?: string | null;
}): Promise<CouncilResult> {
  const startedAt = Date.now();
  const systemPrompt = buildCouncilMemberPrompt(input.persona ?? null);

  // Fire all model calls in parallel
  const results = await Promise.all(
    input.members.map((member) =>
      callCouncilMember(member, systemPrompt, input.question, input.globalConfig),
    ),
  );

  return {
    question: input.question,
    positions: results,
    durationMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Main entry point: convene a dialectic
// ---------------------------------------------------------------------------

const DEFAULT_DIALECTIC_ROUNDS = 3;
const MIN_DIALECTIC_ROUNDS = 1;
const MAX_DIALECTIC_ROUNDS = 5;

export function clampRounds(rounds: number | undefined | null): number {
  const n = rounds ?? DEFAULT_DIALECTIC_ROUNDS;
  return Math.max(MIN_DIALECTIC_ROUNDS, Math.min(MAX_DIALECTIC_ROUNDS, n));
}

export async function conveneDialectic(input: {
  question: string;
  camps: Camp[];
  members: CouncilMember[];
  globalConfig: string;
  rounds?: number;
}): Promise<DialecticResult> {
  const totalStart = Date.now();
  const numRounds = clampRounds(input.rounds);
  const assignments = assignCamps(input.members, input.camps);
  const completedRounds: DialecticRound[] = [];

  for (let round = 1; round <= numRounds; round++) {
    const roundStart = Date.now();

    // All members argue in parallel within each round
    const positions = await Promise.all(
      assignments.map(async (assignment): Promise<DialecticPosition> => {
        const systemPrompt = buildDialecticPrompt(
          assignment,
          round,
          completedRounds,
          input.camps,
        );

        const pos = await callCouncilMember(
          assignment.member,
          systemPrompt,
          input.question,
          input.globalConfig,
        );

        return {
          ...pos,
          role: assignment.role,
          campName: assignment.camp?.name,
          roundNumber: round,
        };
      }),
    );

    completedRounds.push({
      roundNumber: round,
      positions,
      durationMs: Date.now() - roundStart,
    });
  }

  return {
    question: input.question,
    camps: input.camps,
    rounds: completedRounds,
    totalDurationMs: Date.now() - totalStart,
  };
}

// ---------------------------------------------------------------------------
// Format dialectic results for steward consumption
// ---------------------------------------------------------------------------

export function formatDialecticResultsForSteward(result: DialecticResult): string {
  const lines: string[] = [
    `## Dialectic Deliberation`,
    `**Question:** ${result.question}`,
    `**Camps:** ${result.camps.map((c) => `${c.name} ("${c.position}")`).join(" vs. ")}`,
    `**Rounds:** ${result.rounds.length} | **Total time:** ${(result.totalDurationMs / 1000).toFixed(1)}s`,
    "",
  ];

  for (const round of result.rounds) {
    lines.push(`### Round ${round.roundNumber} (${(round.durationMs / 1000).toFixed(1)}s)`);
    lines.push("");

    for (const pos of round.positions) {
      const roleLabel = pos.role === "skeptic"
        ? "SKEPTIC"
        : `ADVOCATE: ${pos.campName}`;
      const timing = pos.durationMs ? `${(pos.durationMs / 1000).toFixed(1)}s` : "n/a";
      const tokens =
        pos.inputTokens || pos.outputTokens
          ? ` | ${pos.inputTokens ?? "?"}→${pos.outputTokens ?? "?"} tokens`
          : "";

      lines.push(`#### ${pos.modelName} [${roleLabel}]`);
      lines.push(`*${timing}${tokens}*`);
      lines.push("");

      if (pos.error) {
        lines.push(`**Error:** ${pos.error}`);
      } else {
        lines.push(pos.text);
      }

      lines.push("");
    }

    lines.push("---");
    lines.push("");
  }

  lines.push(
    "**You are the chair.** You just oversaw a multi-round dialectic. Synthesize:",
    "",
    "**Evolution:** How did positions change across rounds? What was conceded? What hardened?",
    "",
    "**Strongest surviving argument from each camp:** After multiple rounds of pressure, what still stands?",
    "",
    "**Exposed weaknesses:** Where did a position fail to hold up even with its own advocate refining it?",
    "",
    "**Emerged insights:** What surfaced that wasn't in the original framing?",
    "",
    "**Your judgment:** Given the strongest battle-tested versions of all arguments, what do you recommend — and why?",
    "",
    "Do not split the difference. Take a position.",
  );

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Format council results for steward consumption
// ---------------------------------------------------------------------------

export function formatCouncilResultsForSteward(result: CouncilResult): string {
  const lines: string[] = [
    `## Council Deliberation`,
    `**Question:** ${result.question}`,
    `**Models consulted:** ${result.positions.length} | **Total time:** ${(result.durationMs / 1000).toFixed(1)}s`,
    "",
  ];

  for (const pos of result.positions) {
    const timing = pos.durationMs ? `${(pos.durationMs / 1000).toFixed(1)}s` : "n/a";
    const tokens =
      pos.inputTokens || pos.outputTokens
        ? ` | ${pos.inputTokens ?? "?"}→${pos.outputTokens ?? "?"} tokens`
        : "";

    lines.push(`### ${pos.modelName} (${pos.provider}/${pos.modelId})`);
    lines.push(`*${timing}${tokens}*`);
    lines.push("");

    if (pos.error) {
      lines.push(`**Error:** ${pos.error}`);
    } else {
      lines.push(pos.text);
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push(
    "**You are the chair.** Synthesize a unified answer:",
    "",
    "**Consensus:** What the council agreed on (be specific)",
    "**Divergence:** Where they disagreed and why it matters",
    "**Recommendation:** Your synthesized position, informed by the above",
    "",
    "Do not simply list positions — produce a coherent synthesis.",
  );

  return lines.join("\n");
}
