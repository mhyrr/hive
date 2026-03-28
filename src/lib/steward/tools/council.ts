import { Type } from "@mariozechner/pi-ai";

import {
  conveneCouncil,
  formatCouncilResultsForSteward,
  resolveCouncilMembers,
} from "../../council";
import { parseModelPool } from "../../project";

type CouncilContext = {
  globalConfig: string;
};

export function createCouncilTools(ctx: CouncilContext) {
  return [
    {
      name: "convene_council",
      description:
        "Send the same question to multiple models in parallel and collect their independent positions. " +
        "Use this for analysis, strategy, architecture decisions, or any question where multiple perspectives " +
        "add value. You act as the chair — synthesize the results into a unified answer, surfacing agreement and disagreement.",
      parameters: Type.Object({
        question: Type.String({
          description:
            "The question or analysis prompt to send to all council members. Be specific and give enough context for each model to reason independently.",
        }),
        models: Type.Array(Type.String(), {
          description:
            "Model pool names to consult (e.g. ['opus', 'sonnet', 'gpt54']). Minimum 2, recommended 3+. Use diverse models for better coverage.",
          minItems: 2,
        }),
        persona: Type.Optional(
          Type.String({
            description:
              "Shared persona lens for council members. Use 'analyst' for structured analysis. Default: general council member.",
          }),
        ),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const question = String(args.question ?? "").trim();
        const models = (args.models as string[]) ?? [];
        const persona = args.persona ? String(args.persona).trim() : null;

        if (!question) {
          throw new Error("question is required.");
        }

        if (!models.length || models.length < 2) {
          throw new Error(
            "At least 2 models are required for a council. Provide model pool names like ['opus', 'sonnet'].",
          );
        }

        const { members, errors } = resolveCouncilMembers(
          ctx.globalConfig,
          models,
        );

        if (members.length < 2) {
          const pool = parseModelPool(ctx.globalConfig);
          const available = pool.map((e) => e.name).join(", ");
          throw new Error(
            `Could not resolve enough council members (need 2+, got ${members.length}). ` +
              `${errors.join(" ")} Available models: ${available || "(none configured)"}`,
          );
        }

        const result = await conveneCouncil({
          question,
          members,
          globalConfig: ctx.globalConfig,
          persona,
        });

        const errorCount = result.positions.filter((p) => p.error).length;
        const successCount = result.positions.length - errorCount;

        if (successCount === 0) {
          throw new Error(
            `All ${result.positions.length} council members failed. Errors: ${result.positions.map((p) => `${p.modelName}: ${p.error}`).join("; ")}`,
          );
        }

        // Format structured output for the steward to synthesize as chair
        let output = formatCouncilResultsForSteward(result);

        if (errors.length > 0) {
          output += `\n\n**Resolution warnings:** ${errors.join(" ")}`;
        }

        if (errorCount > 0) {
          const failed = result.positions
            .filter((p) => p.error)
            .map((p) => `${p.modelName}: ${p.error}`)
            .join("; ");
          output += `\n\n**Failed members (${errorCount}):** ${failed}`;
        }

        return output;
      },
    },
  ];
}
