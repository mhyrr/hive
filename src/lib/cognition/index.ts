import { CognitionWorkbench } from "./workbench";
import {
  cognitionTasks,
  compressCompletedRunOutputTask,
  preprocessHumanMessageTask,
  triageRunDiffForStewardTask,
  type CompressCompletedRunOutputInput,
  type PreprocessHumanMessageInput,
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
  cognitionTasks,
  compressCompletedRunOutputTask,
  preprocessHumanMessageTask,
  triageRunDiffForStewardTask,
  type CompressCompletedRunOutputInput,
  type PreprocessHumanMessageInput,
  type Tier1CloudTextRunner,
  type Tier1DiffTriageDecision,
  type Tier1HumanMessageClassification,
  type Tier1HumanMessagePreprocessResult,
  type TriageRunDiffForStewardInput,
} from "./tasks";

export const defaultCognitionWorkbench = new CognitionWorkbench(
  [...cognitionTasks],
);

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
