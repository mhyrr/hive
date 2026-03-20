import { CognitionWorkbench } from "./workbench";
import { defaultCognitionWorkbench } from "./default-workbench";
import {
  cognitionTasks,
  compressCompletedRunOutputTask,
  logRollupTask,
  memoryHotsetTask,
  phaseSummaryTask,
  preprocessHumanMessageTask,
  staleMemoryTask,
  triageRunDiffForStewardTask,
  type CompressCompletedRunOutputInput,
  type LogRollupData,
  type LogRollupInput,
  type MemoryHotsetData,
  type MemoryHotsetInput,
  type PhaseSummaryData,
  type PhaseSummaryInput,
  type PreprocessHumanMessageInput,
  type StaleMemoryData,
  type StaleMemoryInput,
  type Tier1CloudTextRunner,
  type Tier1DiffTriageDecision,
  type Tier1HumanMessageClassification,
  type Tier1HumanMessagePreprocessResult,
  type TriageRunDiffForStewardInput,
} from "./tasks";

export {
  CognitionWorkbench,
  type CognitionWorkbenchOptions,
} from "./workbench";
export type {
  CognitionConcurrencyBucket,
  CognitionPacket,
  CognitionPacketKind,
  CognitionTaskPriority,
  CognitionTaskTrigger,
  CompileTask,
} from "./packets";
export {
  packetExpiresAt,
  upsertPacket,
} from "./packets";
export {
  buildCompiledStateView,
  type CompilationMetrics,
  type CompiledStateView,
} from "./working-set";
export {
  compileIdleProjectCognition,
  getLogRollupPacketPath,
  getPhaseSummaryPacketPath,
  readLogRollupDigest,
  type IdleCognitionResult,
} from "./idle";
export {
  getWorkerBriefPacketPath,
  materializeWorkerBriefPacket,
  type WorkerBriefPacketDetails,
} from "./worker-brief";
export {
  cognitionTasks,
  compressCompletedRunOutputTask,
  logRollupTask,
  memoryHotsetTask,
  phaseSummaryTask,
  preprocessHumanMessageTask,
  staleMemoryTask,
  triageRunDiffForStewardTask,
  type CompressCompletedRunOutputInput,
  type LogRollupData,
  type LogRollupInput,
  type MemoryHotsetData,
  type MemoryHotsetInput,
  type PhaseSummaryData,
  type PhaseSummaryInput,
  type PreprocessHumanMessageInput,
  type StaleMemoryData,
  type StaleMemoryInput,
  type Tier1CloudTextRunner,
  type Tier1DiffTriageDecision,
  type Tier1HumanMessageClassification,
  type Tier1HumanMessagePreprocessResult,
  type TriageRunDiffForStewardInput,
} from "./tasks";

export { defaultCognitionWorkbench } from "./default-workbench";

export async function compressCompletedRunOutput(
  input: CompressCompletedRunOutputInput,
) {
  const packet = await defaultCognitionWorkbench.runTask(
    compressCompletedRunOutputTask,
    input,
  );

  return packet?.data ?? null;
}

export async function preprocessHumanMessage(
  input: PreprocessHumanMessageInput,
) {
  const packet = await defaultCognitionWorkbench.runTask(
    preprocessHumanMessageTask,
    input,
  );

  return packet?.data ?? null;
}

export async function triageRunDiffForSteward(
  input: TriageRunDiffForStewardInput,
): Promise<Tier1DiffTriageDecision> {
  const packet = await defaultCognitionWorkbench.runTask(
    triageRunDiffForStewardTask,
    input,
  );

  if (!packet) {
    throw new Error("Diff triage task unexpectedly returned no packet.");
  }

  return packet.data;
}

export async function triageRunDiffsForSteward(
  inputs: TriageRunDiffForStewardInput[],
): Promise<Tier1DiffTriageDecision[]> {
  const packets = await defaultCognitionWorkbench.runBatch(
    triageRunDiffForStewardTask,
    inputs,
  );

  return packets.map((packet) => {
    if (!packet) {
      throw new Error("Diff triage task unexpectedly returned no packet.");
    }

    return packet.data;
  });
}
