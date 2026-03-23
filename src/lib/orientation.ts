import { callAnthropic } from "./anthropic-client";

export type OrientationSummary = {
  updatedAt: string;
  activeGoal: string;
  state: string;
  workers: string;
  posture: "converging" | "exploring" | "blocked" | "idle";
  watchFor: string;
  ignore: string;
};

const REGEN_SYSTEM = `You are HIVE's orientation synthesizer. Given current project context, produce a compressed orientation summary. Be specific and terse — every word must earn its place. This summary is read by a fast tactical evaluator on every signal, so it must be immediately actionable.`;

const REGEN_PROMPT_TEMPLATE = `## Current Context

### Active Goal
{goal}

### Board Digest
{board}

### Recent Evidence
{evidence}

### Active Workers
{workers}

Produce a compressed orientation summary using exactly these fields:
ACTIVE_GOAL: <title or "none">
STATE: <one sentence: what is happening right now>
WORKERS: <brief comma-separated list, or "none">
POSTURE: <converging | exploring | blocked | idle>
WATCH_FOR: <what signals matter right now — one sentence>
IGNORE: <what signals to discard — one sentence>`;

function parseOrientation(text: string, existing: OrientationSummary | null): OrientationSummary {
  const extract = (key: string): string | null => {
    const match = text.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match?.[1]?.trim() ?? null;
  };

  const activeGoal = extract("ACTIVE_GOAL");
  const state = extract("STATE");
  const workers = extract("WORKERS");
  const postureRaw = extract("POSTURE");
  const watchFor = extract("WATCH_FOR");
  const ignore = extract("IGNORE");

  const validPostures = ["converging", "exploring", "blocked", "idle"] as const;
  type Posture = (typeof validPostures)[number];

  const posture: Posture =
    validPostures.includes(postureRaw as Posture)
      ? (postureRaw as Posture)
      : (existing?.posture ?? "idle");

  if (!activeGoal || !state || !workers || !watchFor || !ignore) {
    return null as unknown as OrientationSummary; // signals parse failure to caller
  }

  return {
    updatedAt: new Date().toISOString(),
    activeGoal,
    state,
    workers,
    posture,
    watchFor,
    ignore,
  };
}

export class OrientationCache {
  private summary: OrientationSummary | null = null;
  private lastRegenAt: Date | null = null;

  get(): OrientationSummary | null {
    return this.summary;
  }

  patch(fields: Partial<OrientationSummary>): void {
    if (!this.summary) {
      return;
    }

    this.summary = {
      ...this.summary,
      ...fields,
      updatedAt: new Date().toISOString(),
    };
  }

  async regenerate(context: {
    goal: string;
    board: string;
    evidence: string;
    workers: string;
  }): Promise<OrientationSummary> {
    const prompt = REGEN_PROMPT_TEMPLATE
      .replace("{goal}", context.goal)
      .replace("{board}", context.board)
      .replace("{evidence}", context.evidence)
      .replace("{workers}", context.workers);

    let text: string;

    try {
      text = await callAnthropic({
        model: "claude-sonnet-4-6",
        system: REGEN_SYSTEM,
        messages: [{ role: "user", content: prompt }],
        maxTokens: 300,
        timeoutMs: 8000,
      });
    } catch (err) {
      console.warn(
        `[orientation] regen failed: ${err instanceof Error ? err.message : String(err)}`,
      );

      if (this.summary) {
        return this.summary;
      }

      throw err;
    }

    const parsed = parseOrientation(text, this.summary);

    if (!parsed) {
      console.warn("[orientation] regen parse failed — keeping existing summary");
      console.warn("[orientation] raw output:", text.slice(0, 300));

      if (this.summary) {
        return this.summary;
      }

      // No existing summary; build a safe fallback
      const fallback: OrientationSummary = {
        updatedAt: new Date().toISOString(),
        activeGoal: context.goal.slice(0, 80) || "none",
        state: "Orientation regen failed — operating with minimal context.",
        workers: context.workers.slice(0, 100) || "none",
        posture: "idle",
        watchFor: "worker completions, human messages",
        ignore: "routine file changes",
      };

      this.summary = fallback;
      this.lastRegenAt = new Date();

      return fallback;
    }

    this.summary = parsed;
    this.lastRegenAt = new Date();

    return parsed;
  }

  isStale(thresholdMinutes = 10): boolean {
    if (!this.lastRegenAt) {
      return true;
    }

    const ageMs = Date.now() - this.lastRegenAt.getTime();

    return ageMs > thresholdMinutes * 60 * 1000;
  }

  format(): string {
    const s = this.summary;

    if (!s) {
      return "## Orientation\n(not yet initialized)";
    }

    return [
      `## Orientation [updated: ${s.updatedAt}]`,
      `Active goal: ${s.activeGoal}`,
      `State: ${s.state}`,
      `Workers: ${s.workers}`,
      `Posture: ${s.posture}`,
      `Watch for: ${s.watchFor}`,
      `Ignore: ${s.ignore}`,
    ].join("\n");
  }
}
