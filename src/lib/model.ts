// Shared completion interface for all CLI-backed model drivers.
// Each driver (claude.ts, codex.ts, gemini.ts) returns this shape.

export interface ModelTextCompletion {
  provider: string;
  model: string;
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  durationMs: number | null;
}
