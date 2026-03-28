import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { parseFrontmatter } from "./frontmatter";
import { createMessage } from "./messages";
import { type RunResult } from "./runs";
import { toIsoTimestamp } from "./time";

export type ReviewVerdict = "approve" | "request-changes" | "escalate";

export type AutoReviewRecord = {
  runId: string;
  agentId: string;
  reviewAgentId: string;
  reviewFile: string;
  createdAt: string;
};

export function shouldAutoReview(result: RunResult, projectConfig: string): boolean {
  if (!result.agentId.includes("craftsman")) return false;
  if (result.status !== "exited") return false;
  if (/^auto-review:\s*false\s*$/m.test(projectConfig)) return false;
  return true;
}

export async function dispatchAutoReview(input: {
  result: RunResult;
  msgDir: string;
  projectId: string;
  stateReviewsDir: string;
}): Promise<AutoReviewRecord> {
  const { result, msgDir, projectId, stateReviewsDir } = input;
  await mkdir(stateReviewsDir, { recursive: true });

  // Write a pending marker immediately so subsequent supervisor ticks don't
  // re-dispatch a second critic before the first one writes the real verdict.
  const pendingMarker = join(stateReviewsDir, `${result.runId}-review.md`);
  const markerExists = await Bun.file(pendingMarker).exists().catch(() => false);
  if (markerExists) {
    // Already dispatched or completed — return a no-op record.
    return {
      runId: result.runId,
      agentId: result.agentId,
      reviewAgentId: "(already dispatched)",
      reviewFile: pendingMarker,
      createdAt: toIsoTimestamp(),
    };
  }
  await Bun.write(pendingMarker, `---\nverdict: pending\n---\n\nReview dispatched. Awaiting critic verdict.\n`);

  const reviewAgentId = `critic-auto-${Date.now()}`;
  const reviewFile = join(stateReviewsDir, `${result.runId}-review.md`);

  const body = `Review the completed work by agent ${result.agentId} (run ${result.runId}). Check changed files for quality, correctness, and alignment with task. Write your verdict to ${reviewFile} as a markdown file with frontmatter \`verdict: approve|request-changes|escalate\` and a body explaining your assessment.`;

  await createMessage(msgDir, {
    from: "supervisor",
    to: reviewAgentId,
    type: "assign",
    project: projectId,
    body,
    attributes: {
      persona: "critic",
      launch: "auto",
      "auto-review": "true",
    },
  });

  return {
    runId: result.runId,
    agentId: result.agentId,
    reviewAgentId,
    reviewFile,
    createdAt: toIsoTimestamp(),
  };
}

export async function processReviewVerdict(reviewFile: string): Promise<ReviewVerdict | null> {
  const raw = await Bun.file(reviewFile).text().catch(() => null);
  if (!raw) return null;

  const { attributes } = parseFrontmatter(raw);
  const verdict = attributes.verdict?.trim();

  if (verdict === "approve" || verdict === "request-changes" || verdict === "escalate") {
    return verdict;
  }

  return null;
}
