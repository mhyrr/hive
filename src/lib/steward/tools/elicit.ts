import { Type } from "@mariozechner/pi-ai";

import { createMessage } from "../../messages";

type ElicitContext = {
  msgDir: string;
  projectId: string;
};

export function createElicitationTools(ctx: ElicitContext) {
  return [
    {
      name: "ask_human",
      description:
        "Ask the human a structured question with optional choices. Use this when you need a decision, preference, or clarification from the human. The question will be rendered as a decision card in the gateway UI. Prefer this over asking questions in freeform text — it creates a clear, trackable decision point.",
      parameters: Type.Object({
        question: Type.String({ description: "The question to ask" }),
        options: Type.Optional(
          Type.Array(Type.String(), {
            description: "2-5 choices for the human. Omit for open-ended questions.",
          }),
        ),
        context: Type.Optional(
          Type.String({
            description: "Background context that helps the human understand why this question matters",
          }),
        ),
        blocking: Type.Optional(
          Type.Boolean({
            description: "If true (default), the steward should wait for the answer before proceeding. If false, continue working while the human considers.",
          }),
        ),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const question = String(args.question ?? "").trim();
        const options = Array.isArray(args.options)
          ? args.options.map((o) => String(o).trim()).filter(Boolean)
          : null;
        const context = args.context ? String(args.context).trim() : null;
        const blocking = args.blocking !== false;

        if (!question) {
          throw new Error("question is required.");
        }

        // Build the message body with structured question format.
        const bodyLines: string[] = [question];

        if (options && options.length > 0) {
          bodyLines.push("");
          bodyLines.push("Options:");
          for (const option of options) {
            bodyLines.push(`- [ ] ${option}`);
          }
        }

        if (context) {
          bodyLines.push("");
          bodyLines.push("Context:");
          bodyLines.push(context);
        }

        const message = await createMessage(ctx.msgDir, {
          from: "steward",
          to: "human",
          type: "ask",
          project: ctx.projectId,
          body: bodyLines.join("\n"),
          attributes: {
            blocking: String(blocking),
            ...(options ? { "option-count": String(options.length) } : {}),
          },
        });

        const modeLabel = blocking ? "Blocking" : "Non-blocking";
        const optionsLabel = options
          ? ` with ${options.length} options`
          : " (open-ended)";

        return [
          `${modeLabel} question sent to human${optionsLabel}.`,
          `  file: ${message.filename}`,
          blocking
            ? "  The human's response will appear in the next turn's notifications."
            : "  You can continue working — the response will arrive asynchronously.",
        ].join("\n");
      },
    },
  ];
}
