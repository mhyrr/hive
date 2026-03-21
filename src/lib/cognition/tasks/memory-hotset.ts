import type {
  MemoryHeatState,
  MemoryRecentDecisionsState,
  MemorySummaryState,
  ProjectMemorySnapshot,
} from "../../memory";
import type { CompileTask } from "../packets";
import { fingerprintParts } from "../packets";
import { DEFAULT_PACKET_FRESHNESS_MS, truncateInline } from "./shared";

export type MemoryHotsetInput = {
  projectId: string;
  summary: MemorySummaryState | null;
  heat: MemoryHeatState | null;
  recentDecisions: MemoryRecentDecisionsState | null;
  projectMemory: ProjectMemorySnapshot;
};

export type MemoryHotsetData = {
  projectStatus: "hot" | "warm" | "cold" | "unknown";
  globalKnowledge: string[];
  facts: string[];
  conventions: string[];
  recentDecisions: string[];
  openQuestions: string[];
};

export const memoryHotsetTask: CompileTask<MemoryHotsetInput, MemoryHotsetData> = {
  id: "memory-hotset",
  kind: "memory-hotset",
  trigger: "idle",
  freshnessMs: DEFAULT_PACKET_FRESHNESS_MS,
  priority: "background",
  shouldRun(input) {
    return (
      input.projectMemory.facts.length > 0 ||
      input.projectMemory.conventions.length > 0 ||
      input.projectMemory.decisions.length > 0 ||
      input.projectMemory.questions.length > 0 ||
      (input.summary?.knowledge.length ?? 0) > 0
    );
  },
  fingerprint(input) {
    return fingerprintParts(
      "memory-hotset",
      input.projectId,
      input.summary,
      input.heat,
      input.recentDecisions,
      input.projectMemory,
    );
  },
  classify() {
    return "deterministic";
  },
  async run(input) {
    const projectHeat = input.heat?.projects.find((project) => project.id === input.projectId);

    return {
      projectStatus: projectHeat?.status ?? "unknown",
      globalKnowledge: (input.summary?.knowledge ?? []).slice(0, 5).map((line) => truncateInline(line, 180)),
      facts: input.projectMemory.facts.slice(0, 5).map((line) => truncateInline(line, 180)),
      conventions: input.projectMemory.conventions.slice(0, 5).map((line) => truncateInline(line, 180)),
      recentDecisions: (input.recentDecisions?.items ?? [])
        .filter((item) => item.project === null || item.project === input.projectId)
        .slice(0, 6)
        .map((item) => truncateInline(item.text, 180)),
      openQuestions: input.projectMemory.questions.slice(0, 4).map((line) => truncateInline(line, 180)),
    };
  },
};
