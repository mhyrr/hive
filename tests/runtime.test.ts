import { describe, expect, test } from "bun:test";

import {
  getConfiguredDirectAuthPolicy,
  readRuntimeAccessPolicy,
  resolvePiRuntimeRoute,
  shouldSuppressRuntimeLine,
} from "../src/lib/runtime";

describe("runtime output filtering", () => {
  test("suppresses known codex rollout path noise", () => {
    expect(
      shouldSuppressRuntimeLine(
        "codex",
        "2026-03-10T14:10:38.725633Z ERROR codex_core::rollout::list: state db missing rollout path for thread 019cd57a-6aa2-77b2-a7a5-3977e3791bb6",
      ),
    ).toBeTrue();
  });

  test("suppresses benign codex no-server mcp startup line", () => {
    expect(shouldSuppressRuntimeLine("codex", "mcp startup: no servers")).toBeTrue();
  });

  test("suppresses known codex state-db discrepancy warnings", () => {
    expect(
      shouldSuppressRuntimeLine(
        "codex",
        "2026-03-10T15:26:20.145324Z  WARN codex_core::state_db: state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
      ),
    ).toBeTrue();
  });

  test("keeps ordinary runtime output visible", () => {
    expect(shouldSuppressRuntimeLine("codex", "OpenAI Codex v0.101.0 (research preview)")).toBeFalse();
    expect(shouldSuppressRuntimeLine("codex", "Review complete. No blocker in HIVE-004 itself.")).toBeFalse();
    expect(shouldSuppressRuntimeLine("claude", "mcp startup: no servers")).toBeFalse();
  });
});

describe("runtime access policy", () => {
  test("reads explicit direct auth and Pi routing from global config", () => {
    const config = [
      "runtime: claude",
      "model: claude-sonnet-4-6",
      "direct-auth-codex: api",
      "pi-provider-claude: anthropic",
      "pi-model-claude: claude-opus-4-6",
      "pi-auth-anthropic: oauth-only",
      "pi-provider-codex: openai",
      "pi-auth-openai: env",
    ].join("\n");

    const policy = readRuntimeAccessPolicy(config);

    expect(policy.defaultRuntime).toBe("claude");
    expect(policy.defaultModel).toBe("claude-sonnet-4-6");
    expect(policy.directAuthByRuntime.claude).toBe("subscription");
    expect(policy.directAuthByRuntime.codex).toBe("api");
    expect(policy.piProviderByRuntime.claude).toBe("anthropic");
    expect(policy.piModelByRuntime.claude).toBe("claude-opus-4-6");
    expect(policy.piAuthByProvider.anthropic).toBe("oauth-only");
  });

  test("resolves Pi route from config when there is no env override", () => {
    const route = resolvePiRuntimeRoute({
      globalConfig: [
        "pi-provider-claude: anthropic",
        "pi-model-claude: claude-sonnet-4-6",
        "pi-auth-anthropic: oauth-only",
      ].join("\n"),
      runtime: "claude",
      env: {},
    });

    expect(route.provider).toBe("anthropic");
    expect(route.model).toBe("claude-sonnet-4-6");
    expect(route.providerContext).toBe("anthropic");
    expect(route.authPolicy).toBe("oauth-only");
    expect(route.providerSource).toBe("config");
    expect(route.modelSource).toBe("config");
  });

  test("env overrides win over config for Pi route resolution", () => {
    const route = resolvePiRuntimeRoute({
      globalConfig: [
        "pi-provider-codex: openai",
        "pi-model-codex: gpt-5",
      ].join("\n"),
      runtime: "codex",
      env: {
        HIVE_PI_PROVIDER: "google",
        HIVE_PI_MODEL: "gemini-2.5-pro",
      },
    });

    expect(route.provider).toBe("google");
    expect(route.model).toBe("gemini-2.5-pro");
    expect(route.providerContext).toBe("google");
    expect(route.providerSource).toBe("env");
    expect(route.modelSource).toBe("env");
  });

  test("codex and gemini do not get implicit Pi provider routes", () => {
    const codexRoute = resolvePiRuntimeRoute({
      globalConfig: "",
      runtime: "codex",
      env: {},
    });
    const geminiRoute = resolvePiRuntimeRoute({
      globalConfig: "",
      runtime: "gemini",
      env: {},
    });

    expect(codexRoute.provider).toBeNull();
    expect(codexRoute.providerContext).toBeNull();
    expect(codexRoute.authPolicy).toBeNull();
    expect(geminiRoute.provider).toBeNull();
    expect(geminiRoute.providerContext).toBeNull();
    expect(geminiRoute.authPolicy).toBeNull();
  });

  test("direct auth defaults stay opinionated even without config", () => {
    expect(getConfiguredDirectAuthPolicy("claude", "")).toBe("subscription");
    expect(getConfiguredDirectAuthPolicy("codex", "")).toBe("cli");
    expect(getConfiguredDirectAuthPolicy("gemini", "")).toBe("cli");
  });
});
