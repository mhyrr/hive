import { createHash } from "node:crypto";

export type CognitionPacketKind =
  | "run-result"
  | "human-request"
  | "diff-triage"
  | "log-rollup"
  | "phase-summary"
  | "memory-hotset"
  | "stale-memory";

export type MaterializedPacketKind =
  | CognitionPacketKind
  | "board-health"
  | "open-decisions"
  | "worker-brief";

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

export type MaterializedPacket = {
  packetId: string;
  kind: MaterializedPacketKind;
  projectId: string;
  fingerprint: string;
  producedAt: string;
  expiresAt: string | null;
  tier: 0 | 1;
  summary: string;
  details: Record<string, unknown>;
  source: {
    taskId: string | null;
    trigger: CognitionTaskTrigger | "derived-state";
    path: string | null;
  };
};

export type MaterializedPacketRef = {
  packetId: string;
  kind: MaterializedPacketKind;
  path: string;
  fingerprint: string;
  producedAt: string;
  expiresAt: string | null;
  tier: 0 | 1;
  summary: string;
};

export type CompilerCacheIndex = {
  projectId: string;
  revision: number;
  updatedAt: string;
  packets: MaterializedPacketRef[];
};

export type StewardWorkingSet = {
  consumer: "steward-refresh";
  projectId: string;
  revision: number;
  producedAt: string;
  packets: MaterializedPacketRef[];
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

export function toMaterializedPacketRef(
  packet: MaterializedPacket,
  path: string,
): MaterializedPacketRef {
  return {
    packetId: packet.packetId,
    kind: packet.kind,
    path,
    fingerprint: packet.fingerprint,
    producedAt: packet.producedAt,
    expiresAt: packet.expiresAt,
    tier: packet.tier,
    summary: packet.summary,
  };
}

export function mergeMaterializedPacketRefs(input: {
  existing: MaterializedPacketRef[];
  replaceKinds: MaterializedPacketKind[];
  next: MaterializedPacketRef[];
}): MaterializedPacketRef[] {
  const replaceKinds = new Set(input.replaceKinds);
  const merged = [
    ...input.existing.filter((packet) => !replaceKinds.has(packet.kind)),
    ...input.next,
  ];

  return merged.sort((left, right) => left.path.localeCompare(right.path));
}
