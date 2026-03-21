import type { CompileTask } from "../packets";

export {
  compressCompletedRunOutputTask,
  type CompressCompletedRunOutputInput,
} from "./run-compression";
export {
  preprocessHumanMessageTask,
  type PreprocessHumanMessageInput,
  type Tier1HumanMessageClassification,
  type Tier1HumanMessagePreprocessResult,
} from "./message-preprocess";
export {
  triageRunDiffForStewardTask,
  type Tier1DiffTriageDecision,
  type TriageRunDiffForStewardInput,
} from "./diff-triage";
export {
  logRollupTask,
  type LogRollupData,
  type LogRollupInput,
} from "./log-rollup";
export {
  phaseSummaryTask,
  type PhaseSummaryData,
  type PhaseSummaryInput,
} from "./phase-summary";
export {
  memoryHotsetTask,
  type MemoryHotsetData,
  type MemoryHotsetInput,
} from "./memory-hotset";
export {
  staleMemoryTask,
  type StaleMemoryData,
  type StaleMemoryInput,
} from "./stale-memory";
export { type Tier1CloudTextRunner } from "./shared";

import { compressCompletedRunOutputTask } from "./run-compression";
import { preprocessHumanMessageTask } from "./message-preprocess";
import { triageRunDiffForStewardTask } from "./diff-triage";
import { logRollupTask } from "./log-rollup";
import { phaseSummaryTask } from "./phase-summary";
import { memoryHotsetTask } from "./memory-hotset";
import { staleMemoryTask } from "./stale-memory";

export const cognitionTasks = [
  compressCompletedRunOutputTask,
  preprocessHumanMessageTask,
  triageRunDiffForStewardTask,
  logRollupTask,
  phaseSummaryTask,
  memoryHotsetTask,
  staleMemoryTask,
] as const satisfies Array<CompileTask<unknown, unknown>>;
