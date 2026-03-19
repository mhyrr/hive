import { createHash } from "node:crypto";

export type CognitionPacketKind =
  | "run-result"
  | "human-request"
  | "diff-triage";

export type CognitionTaskTrigger = "event" | "turn-start" | "idle";

export type CognitionTaskPriority = "foreground" | "background";

export type CognitionConcurrencyBucket =
  | "deterministic"
  | "tier1-local"
  | "tier1-cloud";

export type CognitionPacket<Data> = {
  taskId: string;
  kind: CognitionPacketKind;
  fingerprint: string;
  compiledAt: string;
  data: Data;
};

export type CompileTask<Input, Data> = {
  id: string;
  kind: CognitionPacketKind;
  trigger: CognitionTaskTrigger;
  freshnessMs: number;
  priority?: CognitionTaskPriority;
  shouldRun(input: Input): boolean;
  fingerprint(input: Input): string;
  classify(input: Input): CognitionConcurrencyBucket;
  run(input: Input): Promise<Data | null>;
};

export function fingerprintParts(...parts: unknown[]): string {
  const hash = createHash("sha1");

  for (const part of parts) {
    hash.update(JSON.stringify(part));
    hash.update("\0");
  }

  return hash.digest("hex");
}
