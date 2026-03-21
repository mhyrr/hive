import { Type } from "@mariozechner/pi-ai";

import { createMessage } from "../../messages";
import { type ModelPoolEntry, parseModelPool } from "../../project";

export const DELEGATE_PERSONAS = ["architect", "craftsman", "critic", "scout"] as const;

type DelegateContext = {
  msgDir: string;
  projectId: string;
  globalConfig: string;
};

function generateAgentId(persona: string, model: string): string {
  const suffix = crypto.randomUUID().slice(0, 4);

  return `${persona}-${model}-${suffix}`;
}

function getModelPool(ctx: DelegateContext): ModelPoolEntry[] {
  return parseModelPool(ctx.globalConfig);
}

function formatPoolNames(pool: ModelPoolEntry[]): string {
  return pool.map((e) => e.name).join(", ");
}

export function createDelegationTools(ctx: DelegateContext) {
  return [
    {
      name: "delegate",
      description:
        "Dispatch a worker with validated model and persona. Use this instead of writing assignment files manually.",
      parameters: Type.Object({
        model: Type.String({ description: "Pool name like 'opus', 'sonnet', 'gpt54'" }),
        persona: Type.Union(
          DELEGATE_PERSONAS.map((p) => Type.Literal(p)),
          { description: "Cognitive lens for the worker" },
        ),
        task: Type.String({ description: "Task ID or description" }),
        scope: Type.String({ description: "Comma-separated scope roots, e.g. 'src/auth, tests/auth'. Use '*' for whole-repo access. Disjoint scopes allow parallel workers." }),
        brief: Type.String({ description: "Worker instructions" }),
        verify: Type.Optional(Type.String({ description: "Shell command to run after worker completes. Exit 0 = pass. e.g. 'bun test tests/auth/'" })),
        maxAttempts: Type.Optional(Type.Number({ description: "Max verification attempts before blocking for steward review. Default: 1" })),
        autoRevert: Type.Optional(Type.Boolean({ description: "Revert scoped changes on verification failure. Default: true" })),
      }),
      async execute(_toolCallId: string, args: Record<string, unknown>) {
        const model = String(args.model ?? "").trim();
        const persona = String(args.persona ?? "").trim();
        const task = String(args.task ?? "").trim();
        const scope = String(args.scope ?? "").trim();
        const brief = String(args.brief ?? "").trim();
        const verify = args.verify ? String(args.verify).trim() : null;
        const maxAttempts = args.maxAttempts != null ? Number(args.maxAttempts) : null;
        const autoRevert = args.autoRevert != null ? args.autoRevert : null;

        if (!model) {
          throw new Error("model is required.");
        }

        if (!persona || !(DELEGATE_PERSONAS as readonly string[]).includes(persona)) {
          throw new Error(`Invalid persona '${persona}'. Available: ${DELEGATE_PERSONAS.join(", ")}`);
        }

        if (!task) {
          throw new Error("task is required.");
        }

        if (!scope) {
          throw new Error("scope is required. Use '*' for whole-repo access, or specify paths like 'src/auth, tests/auth'.");
        }

        if (!brief) {
          throw new Error("brief is required.");
        }

        const pool = getModelPool(ctx);
        const entry = pool.find((e) => e.name === model);

        if (!entry) {
          const available = formatPoolNames(pool);

          throw new Error(
            `Unknown model '${model}'. Available: ${available || "(none configured)"}`,
          );
        }

        const agentId = generateAgentId(persona, model);
        const message = await createMessage(ctx.msgDir, {
          from: "steward",
          to: agentId,
          type: "assign",
          project: ctx.projectId,
          body: brief,
          attributes: {
            task,
            scope,
            persona,
            runtime: entry.runtime,
            model: entry.model,
            launch: "auto",
            ...(verify ? { verify } : {}),
            ...(maxAttempts != null ? { "max-attempts": String(maxAttempts) } : {}),
            ...(autoRevert != null ? { "auto-revert": String(autoRevert) } : {}),
          },
        });

        return [
          `Delegated to ${agentId}`,
          `  model: ${entry.name} (${entry.runtime}, ${entry.model})`,
          `  persona: ${persona}`,
          `  task: ${task}`,
          `  file: ${message.filename}`,
        ].join("\n");
      },
    },
    {
      name: "list_models",
      description: "List available models from the pool.",
      parameters: Type.Object({}),
      async execute() {
        const pool = getModelPool(ctx);

        if (pool.length === 0) {
          return "No models configured in the model pool.";
        }

        const lines = pool.map(
          (e) => `- ${e.name}: ${e.runtime}, ${e.model} — ${e.description}`,
        );

        return lines.join("\n");
      },
    },
  ];
}
