import { describe, expect, test } from "bun:test";

import {
  buildCognitiveRoutingSnapshot,
  discoverLocalModels,
  readCognitiveTier1Config,
  readCognitiveRoutingPolicy,
  renderCognitiveRoutingPromptPolicy,
} from "../src/lib/cognitive-routing";

describe("cognitive routing policy", () => {
  test("defaults preserve Claude's implicit Pi lane and direct CLI lanes for Codex and Gemini", () => {
    const policy = readCognitiveRoutingPolicy("");
    const claudeLane = policy.runtimeLanes.find((lane) => lane.runtime === "claude");
    const codexLane = policy.runtimeLanes.find((lane) => lane.runtime === "codex");
    const geminiLane = policy.runtimeLanes.find((lane) => lane.runtime === "gemini");

    expect(policy.bias).toBe("balanced");
    expect(policy.maxFanOut).toBe(2);
    expect(policy.maxParallel).toBe(2);
    expect(claudeLane?.piRoute.provider).toBe("anthropic");
    expect(claudeLane?.piRoute.authPolicy).toBe("oauth-only");
    expect(claudeLane?.piRoute.providerSource).toBe("implicit");
    expect(codexLane?.directAuth).toBe("cli");
    expect(codexLane?.piRoute.provider).toBeNull();
    expect(geminiLane?.directAuth).toBe("cli");
    expect(geminiLane?.piRoute.provider).toBeNull();
  });

  test("config can raise routing depth and explicitly Pi-route Codex", () => {
    const policy = readCognitiveRoutingPolicy(
      [
        "runtime: claude",
        "model: claude-sonnet-4-6",
        "cognitive-bias: quality",
        "cognitive-max-fanout: 4",
        "cognitive-max-parallel: 3",
        "pi-provider-codex: openai",
        "pi-model-codex: gpt-5",
        "pi-auth-openai: env",
      ].join("\n"),
    );
    const codexLane = policy.runtimeLanes.find((lane) => lane.runtime === "codex");
    const pluralMode = policy.modes.find((mode) => mode.id === "plural-synthesis");

    expect(policy.bias).toBe("quality");
    expect(policy.maxFanOut).toBe(4);
    expect(policy.maxParallel).toBe(3);
    expect(codexLane?.piRoute.provider).toBe("openai");
    expect(codexLane?.piRoute.model).toBe("gpt-5");
    expect(pluralMode?.fanOut).toContain("cap 4");
    expect(pluralMode?.parallelism).toContain("Cap 3");
  });

  test("prompt policy rendering includes the current steward lane and routing modes", () => {
    const rendered = renderCognitiveRoutingPromptPolicy({
      globalConfig: "",
      skillsDir: "/tmp/skills",
      sessionRuntime: "claude",
      sessionModel: "claude-sonnet-4-6",
    });

    expect(rendered).toContain("/tmp/skills/cognitive-resource-routing.md");
    expect(rendered).toContain("current steward lane: claude (claude-sonnet-4-6)");
    expect(rendered).toContain("direct-answer");
    expect(rendered).toContain("targeted-inspection");
    expect(rendered).toContain("plural-synthesis");
  });

  test("tier-1 defaults prefer qwen locally and haiku in cloud", () => {
    const tier1 = readCognitiveTier1Config("");

    expect(tier1.localModel).toBe("qwen3:4b");
    expect(tier1.cloudModel).toBe("haiku");
    expect(tier1.fallbackModel).toBe("haiku");
    expect(tier1.ollamaBaseUrl).toBe("http://127.0.0.1:11434");
  });

  test("local model discovery reports availability and configured model status", async () => {
    const discovery = await discoverLocalModels({
      configuredModel: "qwen3:4b",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            models: [
              { name: "gemma3:4b" },
              { name: "qwen3:4b", modified_at: "2026-03-16T00:00:00Z" },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });

    expect(discovery.available).toBeTrue();
    expect(discovery.configuredModelStatus).toBe("available");
    expect(discovery.models.map((model) => model.name)).toEqual([
      "gemma3:4b",
      "qwen3:4b",
    ]);
  });

  test("routing snapshot carries the active session lane and missing local model state", async () => {
    const snapshot = await buildCognitiveRoutingSnapshot({
      globalConfig: [
        "runtime: claude",
        "model: claude-sonnet-4-6",
        "tier1_local: gemma3:4b",
      ].join("\n"),
      session: {
        sessionId: "20260316-005525Z",
        project: "hive",
        runtime: "claude",
        model: "claude-opus-4-6",
      },
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            models: [{ name: "qwen3:4b" }],
          }),
          { status: 200 },
        )) as typeof fetch,
    });

    expect(snapshot.activeLane?.runtime).toBe("claude");
    expect(snapshot.defaultLane?.runtime).toBe("claude");
    expect(snapshot.activeSession?.project).toBe("hive");
    expect(snapshot.localModels.configuredModelStatus).toBe("missing");
  });
});
