// Shared completion interface for all CLI-backed model drivers.
// Each driver (claude.ts, codex.ts, gemini.ts) returns this shape.

import type { CacheTokens } from "./pricing";

export interface ModelTextCompletion extends CacheTokens {
  provider: string;
  model: string;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
}
