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
import { completePiText, isPiProviderSupported, type PiTextCompletion } from "./pi";
import { resolvePiRuntimeRoute } from "./runtime-routes";
import { resolvePiApiKey } from "./auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CouncilMember = {
  model: ModelPoolEntry;
  provider: string;
  modelId: string;
  authPolicy?: "oauth-only" | "env" | null;
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
// Ollama direct call (for local models not in pi-ai)
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

  for (const name of modelNames) {
    const entry = pool.find((e) => e.name === name);

    if (!entry) {
      const available = pool.map((e) => e.name).join(", ");
      errors.push(
        `Unknown model '${name}'. Available: ${available || "(none configured)"}`,
      );
      continue;
    }

    // Resolve pi provider for this runtime
    const piRoute = resolvePiRuntimeRoute({ globalConfig, runtime: entry.runtime });
    const isOllama =
      entry.runtime === "ollama" ||
      entry.runtime === "local" ||
      entry.runtime === "oss";

    if (isOllama) {
      members.push({
        model: entry,
        provider: "ollama",
        modelId: entry.model,
      });
    } else if (piRoute.provider && isPiProviderSupported(piRoute.provider)) {
      members.push({
        model: entry,
        provider: piRoute.provider,
        modelId: piRoute.model ?? entry.model,
        authPolicy: piRoute.authPolicy,
      });
    } else {
      errors.push(
        `No provider route for model '${name}' (runtime: ${entry.runtime}). ` +
          `Configure pi-provider-${entry.runtime} in ~/.hive/config.md.`,
      );
    }
  }

  return { members, errors };
}

// ---------------------------------------------------------------------------
// Call a single council member
// ---------------------------------------------------------------------------

async function callCouncilMember(
  member: CouncilMember,
  systemPrompt: string,
  question: string,
  globalConfig: string,
): Promise<CouncilPosition> {
  const base: Omit<CouncilPosition, "text" | "durationMs" | "error" | "inputTokens" | "outputTokens"> = {
    modelName: member.model.name,
    modelId: member.modelId,
    provider: member.provider,
  };

  try {
    if (member.provider === "ollama") {
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

    // Pi-supported provider — respect the config's auth policy (e.g. oauth-only for subscriptions)
    const resolved = await resolvePiApiKey(member.provider, { authPolicy: member.authPolicy ?? null });

    if (!resolved) {
      return {
        ...base,
        text: "",
        durationMs: 0,
        inputTokens: null,
        outputTokens: null,
        error: `No API credentials for provider '${member.provider}'.`,
      };
    }

    const result: PiTextCompletion = await completePiText({
      provider: member.provider,
      modelId: member.modelId,
      systemPrompt,
      userContent: question,
      apiKey: resolved.token,
    });

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
