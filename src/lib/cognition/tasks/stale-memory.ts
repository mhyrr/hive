import type {
  MemoryHeatState,
  MemoryRecentDecisionsState,
  ProjectMemorySnapshot,
} from "../../memory";
import type { CompileTask } from "../packets";
import { fingerprintParts } from "../packets";
import { DEFAULT_PACKET_FRESHNESS_MS } from "./shared";

export type StaleMemoryInput = {
  projectId: string;
  heat: MemoryHeatState | null;
  recentDecisions: MemoryRecentDecisionsState | null;
  projectMemory: ProjectMemorySnapshot;
};

export type StaleMemoryData = {
  status: "fresh" | "review";
  reasons: string[];
  accessCount: number | null;
  lastAccessed: string | null;
  signalCount: number | null;
  memoryItems: number;
};

export const staleMemoryTask: CompileTask<StaleMemoryInput, StaleMemoryData> = {
  id: "stale-memory",
  kind: "stale-memory",
  trigger: "idle",
  freshnessMs: DEFAULT_PACKET_FRESHNESS_MS,
  priority: "background",
  shouldRun(input) {
    return (
      input.projectMemory.facts.length > 0 ||
      input.projectMemory.conventions.length > 0 ||
      input.projectMemory.questions.length > 0 ||
      (input.heat?.projects.some((project) => project.id === input.projectId) ?? false)
    );
  },
  fingerprint(input) {
    return fingerprintParts(
      "stale-memory",
      input.projectId,
      input.heat,
      input.recentDecisions,
      input.projectMemory,
    );
  },
  classify() {
    return "deterministic";
  },
  async run(input) {
    const projectHeat = input.heat?.projects.find((project) => project.id === input.projectId) ?? null;
    const reasons: string[] = [];
    const memoryItems =
      input.projectMemory.facts.length +
      input.projectMemory.conventions.length +
      input.projectMemory.decisions.length +
      input.projectMemory.questions.length;
    const latestProjectDecision = (input.recentDecisions?.items ?? []).find(
      (item) => item.project === input.projectId,
    );

    if (memoryItems > 0 && (projectHeat?.accessCount ?? 0) === 0) {
      reasons.push("Project memory exists but has never been accessed in prompt context.");
    }

    if ((projectHeat?.status ?? "unknown") === "cold" && (projectHeat?.signalCount ?? 0) === 0 && memoryItems > 0) {
      reasons.push("Project memory is cold and has no recent signal refresh.");
    }

    if (input.projectMemory.questions.length > 0 && !latestProjectDecision) {
      reasons.push("Open memory questions exist without any recorded project decision.");
    }

    return {
      status: reasons.length > 0 ? "review" : "fresh",
      reasons,
      accessCount: projectHeat?.accessCount ?? null,
      lastAccessed: projectHeat?.lastAccessed ?? null,
      signalCount: projectHeat?.signalCount ?? null,
      memoryItems,
    };
  },
};
