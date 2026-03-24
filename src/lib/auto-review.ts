import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createMessage } from "./messages";
import { HivePaths, getProjectPaths } from "./paths";
import { RunResult } from "./runs";
import { toCompactTimestamp } from "./time";

export type AutoReviewConfig = {
  projectId: string;
  projectPaths: ReturnType<typeof getProjectPaths>;
  hivePaths: HivePaths;
  reviewerModel?: string;
  reviewerPersona?: string;
};

export type AutoReviewResult = {
  triggered: boolean;
  reason: string;
  reviewMessageId?: string;
};

export function shouldAutoReview(runResult: RunResult, projectConfig: string): boolean {
  if (!runResult.agentId.includes("craftsman")) {
    return false;
  }

  if (runResult.status === "failed" || runResult.status === "cancelled") {
    return false;
  }

  if (projectConfig.includes("auto-review: false")) {
    return false;
  }

  return true;
}

export async function dispatchAutoReview(
  runResult: RunResult,
  config: AutoReviewConfig,
): Promise<AutoReviewResult> {
  const criticId = `critic-auto-${toCompactTimestamp()}`;
  const taskId = runResult.taskId ?? "unknown";

  const body = `# Auto-Review: ${runResult.agentId}

## Assignment
Review the changes made by craftsman run \`${runResult.runId}\`.

Run: \`git show HEAD\` or \`git diff HEAD~1\` to see the changes.

Assess the changes for:
- Correctness: do the changes do what they claim?
- TypeScript: no type errors, proper imports
- Integration: does it fit with surrounding code patterns?
- Build: verify \`bun build src/cli.ts --outfile /tmp/hive-build-test\` still passes

Write your verdict to: state/reviews/${runResult.runId}-review.md

Format:
\`\`\`
verdict: approve | request-changes | escalate
summary: one sentence
notes: detailed feedback if request-changes or escalate
\`\`\`

## Original Task
${taskId}

## Review Metadata
reviewOf: ${runResult.runId}
originalAgent: ${runResult.agentId}`;

  const message = await createMessage(config.hivePaths.msgDir, {
    from: "steward",
    to: criticId,
    type: "assign",
    project: config.projectId,
    body,
    attributes: {
      persona: config.reviewerPersona ?? "critic",
      model: config.reviewerModel ?? "sonnet",
      "review-of": runResult.runId,
    },
  });

  return {
    triggered: true,
    reason: "craftsman run completed",
    reviewMessageId: message.filename,
  };
}

export async function processReviewVerdict(
  reviewRunId: string,
  config: AutoReviewConfig,
): Promise<void> {
  const reviewFile = join(config.projectPaths.stateReviewsDir, `${reviewRunId}-review.md`);
  const file = Bun.file(reviewFile);

  if (!(await file.exists())) {
    console.warn(`[auto-review] review file missing: ${reviewFile}`);
    return;
  }

  const text = await file.text();
  const verdictMatch = text.match(/^verdict:\s*(\S+)/m);
  const verdict = verdictMatch?.[1]?.trim();

  if (!verdict) {
    console.warn(`[auto-review] could not parse verdict from: ${reviewFile}`);
    return;
  }

  if (verdict === "approve") {
    console.log(`[auto-review] verdict: approved (${reviewRunId})`);
    return;
  }

  if (verdict === "request-changes") {
    const notesMatch = text.match(/^notes:\s*([\s\S]+?)(?=\n[a-z]+:|$)/m);
    const notes = notesMatch?.[1]?.trim() ?? "(no notes)";

    // Find the original agent from the review file — parse originalAgent line
    const agentMatch = text.match(/^originalAgent:\s*(\S+)/m);
    const originalAgent = agentMatch?.[1]?.trim();

    if (!originalAgent) {
      console.warn(`[auto-review] could not determine originalAgent from: ${reviewFile}`);
      return;
    }

    await createMessage(config.hivePaths.msgDir, {
      from: "steward",
      to: originalAgent,
      type: "assign",
      project: config.projectId,
      body: `# Revision Request\n\nThe critic reviewed your last run (\`${reviewRunId}\`) and requested changes.\n\n## Notes\n${notes}`,
      attributes: {
        "review-of": reviewRunId,
      },
    });

    console.log(`[auto-review] revision request dispatched to ${originalAgent}`);
    return;
  }

  if (verdict === "escalate") {
    const notesMatch = text.match(/^notes:\s*([\s\S]+?)(?=\n[a-z]+:|$)/m);
    const notes = notesMatch?.[1]?.trim() ?? "(no notes)";

    await createMessage(config.hivePaths.msgDir, {
      from: "steward",
      to: "steward",
      type: "nudge",
      project: config.projectId,
      body: `# Critic Escalation\n\nReview of run \`${reviewRunId}\` was escalated.\n\n## Concerns\n${notes}`,
      attributes: {
        "review-of": reviewRunId,
      },
    });

    console.log(`[auto-review] escalation nudge written to steward`);
    return;
  }

  console.warn(`[auto-review] unknown verdict "${verdict}" in: ${reviewFile}`);
}

export async function ensureReviewsDir(config: AutoReviewConfig): Promise<void> {
  await mkdir(config.projectPaths.stateReviewsDir, { recursive: true });
}
