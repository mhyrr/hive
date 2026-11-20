// Nightly pass configuration — the ONE place each pass's model, effort and
// prompt-cache policy are set.
//
// Model resolution, most specific first:
//   HIVE_NIGHTLY_MODEL_<PASS>   one pass, e.g. HIVE_NIGHTLY_MODEL_VBRIEF=claude-sonnet-5-5
//   the pass's legacy variable  HIVE_EXTRACT_MODEL (B, C), HIVE_VERIFY_MODEL (V, VBRIEF),
//                               HIVE_TASTE_{CLASSIFY,ANALYZE,CONSOLIDATE,REPLAY}_MODEL
//   NIGHTLY_PASSES below
// A value of the form "provider/model" also sets the provider, as before.
//
// Effort: HIVE_NIGHTLY_EFFORT_<PASS> overrides the map.
//
// Defaults (2026-11-20): extraction and taste run on Sonnet 5.5, which costs
// half of Opus 5.5 per token. V's project shards and the Brief stay on Opus
// because they judge candidates against canon. TA stays on Haiku: it runs with
// thinking disabled, which Sonnet 5.5 and Opus 5.5 reject with a 400, and Haiku
// costs half of Sonnet. Quality on Sonnet is unmeasured as of this change.

import { completeClaudeTextBounded, type ClaudeEffort } from "./claude";
import type { ModelCaller } from "./extract";

export type NightlyPass = "B" | "C" | "V" | "VBRIEF" | "TA" | "TB" | "TC" | "TR";

export interface NightlyPassConfig {
  model: string;
  /** `--effort` for the call. Undefined runs at the CLI default. */
  effort?: ClaudeEffort;
}

// prettier-ignore
export const NIGHTLY_PASSES: Record<NightlyPass, NightlyPassConfig> = {
  B:      { model: "claude-sonnet-5-5", effort: "medium" },
  C:      { model: "claude-sonnet-5-5", effort: "medium" },
  V:      { model: "claude-opus-5-5",   effort: "high" },
  VBRIEF: { model: "claude-opus-5-5",   effort: "high" },
  TA:     { model: "claude-haiku-4-5" },
  TB:     { model: "claude-sonnet-5-5", effort: "medium" },
  TC:     { model: "claude-sonnet-5-5", effort: "medium" },
  TR:     { model: "claude-sonnet-5-5", effort: "medium" },
};

const LEGACY_MODEL_ENV: Record<NightlyPass, string> = {
  B: "HIVE_EXTRACT_MODEL",
  C: "HIVE_EXTRACT_MODEL",
  V: "HIVE_VERIFY_MODEL",
  VBRIEF: "HIVE_VERIFY_MODEL",
  TA: "HIVE_TASTE_CLASSIFY_MODEL",
  TB: "HIVE_TASTE_ANALYZE_MODEL",
  TC: "HIVE_TASTE_CONSOLIDATE_MODEL",
  TR: "HIVE_TASTE_REPLAY_MODEL",
};

const LEGACY_PROVIDER_ENV: Record<NightlyPass, string> = {
  B: "HIVE_EXTRACT_PROVIDER",
  C: "HIVE_EXTRACT_PROVIDER",
  V: "HIVE_VERIFY_PROVIDER",
  VBRIEF: "HIVE_VERIFY_PROVIDER",
  TA: "HIVE_TASTE_PROVIDER",
  TB: "HIVE_TASTE_PROVIDER",
  TC: "HIVE_TASTE_PROVIDER",
  TR: "HIVE_TASTE_PROVIDER",
};

const EFFORTS = new Set<ClaudeEffort>(["low", "medium", "high", "xhigh", "max"]);

export function nightlyModel(pass: NightlyPass): { provider: string; modelId: string } {
  const override =
    process.env[`HIVE_NIGHTLY_MODEL_${pass}`] || process.env[LEGACY_MODEL_ENV[pass]];
  if (override && override.includes("/")) {
    const [provider, modelId] = override.split("/", 2);
    return { provider: provider!, modelId: modelId! };
  }
  return {
    provider: process.env[LEGACY_PROVIDER_ENV[pass]] || "anthropic",
    modelId: override || NIGHTLY_PASSES[pass].model,
  };
}

export function nightlyEffort(pass: NightlyPass): ClaudeEffort | undefined {
  const raw = process.env[`HIVE_NIGHTLY_EFFORT_${pass}`];
  if (raw && EFFORTS.has(raw as ClaudeEffort)) return raw as ClaudeEffort;
  return NIGHTLY_PASSES[pass].effort;
}

/**
 * Prompt caching for nightly `claude --print` calls. Off by default.
 *
 * Measured from the nightly's own transcripts (2026-11-17..20): `claude --print`
 * writes each call's whole prompt to the 1-hour cache, billed at 2× base input,
 * and reads back only the ~1k-token system prompt. The night's hit rate was
 * 1.4%, and V's was 1.1%. No nightly prompt repeats inside an hour, and the
 * longest TTL is one hour while nights are 24 hours apart, so a write is never
 * read. Turning caching off bills every input token once at base.
 *
 * HIVE_NIGHTLY_PROMPT_CACHE=on restores Claude Code's default.
 */
export function nightlyPromptCacheOff(): boolean {
  return process.env.HIVE_NIGHTLY_PROMPT_CACHE !== "on";
}

/** The deadline-bounded `claude --print` caller for one pass, with that pass's
 * effort and the nightly cache policy. The model comes from the caller's input
 * (nightlyModel), so an injected test caller sees the same model id. */
export function nightlyCaller(pass: NightlyPass): ModelCaller {
  return (input) =>
    completeClaudeTextBounded({
      modelId: input.modelId,
      systemPrompt: input.systemPrompt,
      userContent: input.userContent,
      effort: nightlyEffort(pass),
      promptCacheOff: nightlyPromptCacheOff(),
    });
}

/** The taste track (TA/TB/TC/TR) runs every N nights. HIVE_TASTE_EVERY_NIGHTS
 * overrides; 1 restores every night. */
export const DEFAULT_TASTE_EVERY_NIGHTS = 2;

export function tasteEveryNights(): number {
  const raw = Number(process.env.HIVE_TASTE_EVERY_NIGHTS);
  return Number.isInteger(raw) && raw >= 1 ? raw : DEFAULT_TASTE_EVERY_NIGHTS;
}
