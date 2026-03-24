import { homedir } from "node:os";
import { join } from "node:path";

import { getEnvApiKey, getModel, getModels, type KnownProvider } from "@mariozechner/pi-ai";

import { UsageError } from "../errors";
import { isPiModelSupported, isPiProviderSupported } from "../pi";
import { resolvePiRuntimeRoute } from "../runtime";

let cachedClaudeOAuthToken: string | null = null;
let cachedClaudeOAuthExpiry: number = 0;

async function tryRefreshClaudeCliToken(): Promise<void> {
  cachedClaudeOAuthToken = null;
  cachedClaudeOAuthExpiry = 0;

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_OAUTH_TOKEN;

  try {
    const proc = Bun.spawn(["claude", "auth", "status", "--json"], {
      env,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    });
    await proc.exited;
  } catch {
    // Best-effort probe only. If the CLI cannot refresh non-interactively,
    // the follow-up credential read will return null and the caller can fail honestly.
  }
}

async function readClaudeSubscriptionToken(
  options: { allowRefresh?: boolean } = {},
): Promise<string | null> {
  const allowRefresh = options.allowRefresh ?? true;

  // Return cached token if still valid (with 5min buffer)
  if (cachedClaudeOAuthToken && cachedClaudeOAuthExpiry > Date.now() + 300_000) {
    return cachedClaudeOAuthToken;
  }

  try {
    // Try macOS keychain first (newer Claude CLI), then fall back to file
    let credText: string | null = null;

    if (process.platform === "darwin") {
      try {
        const proc = Bun.spawn(
          ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 },
        );
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        if (out.trim().startsWith("{")) {
          credText = out.trim();
        }
      } catch {
        // keychain not available
      }
    }

    // Fall back to credentials file
    if (!credText) {
      const credPath = join(homedir(), ".claude", ".credentials.json");
      credText = await Bun.file(credPath).text();
    }

    const creds = JSON.parse(credText);
    const oauth = creds?.claudeAiOauth;
    if (!oauth) return null;

    const token = oauth.accessToken;
    const refreshToken = oauth.refreshToken;
    const expiresAt = oauth.expiresAt ? new Date(oauth.expiresAt).getTime() : 0;

    if (typeof token === "string" && token.trim() && (!expiresAt || expiresAt > Date.now() + 300_000)) {
      cachedClaudeOAuthToken = token.trim();
      cachedClaudeOAuthExpiry = expiresAt;
      return cachedClaudeOAuthToken;
    }

    if (allowRefresh && typeof refreshToken === "string" && refreshToken.trim()) {
      console.error("[hive-auth] OAuth token expired, probing Claude CLI for a refreshed token...");
      await tryRefreshClaudeCliToken();
      return readClaudeSubscriptionToken({ allowRefresh: false });
    }

    if (typeof token === "string" && token.trim() && expiresAt > 0) {
      console.error("[hive-auth] Claude CLI token is expired and could not be refreshed non-interactively.");
    }
  } catch (err) {
    console.error(`[hive-auth] failed to read Claude credentials: ${err instanceof Error ? err.message : String(err)}`);
  }

  return null;
}

export type ResolvedApiKey = {
  token: string;
  isOAuth: boolean;
};

export type PersistentStewardRuntimeConfig = {
  provider: string;
  modelId: string;
  authPolicy: "oauth-only" | "env" | null;
  runtimeSignature: string;
};

export function describePiModel(input: {
  provider: string;
  modelId: string;
}): string {
  return `${input.provider}/${input.modelId}`;
}

export async function resolvePiApiKey(
  provider: string,
  input: {
    authPolicy: "oauth-only" | "env" | null;
  },
): Promise<ResolvedApiKey | undefined> {
  // 1. Explicit env var for OAuth token
  const oauthToken = process.env.ANTHROPIC_OAUTH_TOKEN?.trim();
  if (provider === "anthropic" && oauthToken) {
    return { token: oauthToken, isOAuth: true };
  }

  // 2. Standard env var (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)
  if (input.authPolicy !== "oauth-only") {
    const apiKey = getEnvApiKey(provider);
    if (typeof apiKey === "string" && apiKey.trim()) {
      return { token: apiKey, isOAuth: false };
    }
  }

  // 3. Read subscription OAuth token from Claude CLI credentials
  if (provider === "anthropic") {
    const subscriptionToken = await readClaudeSubscriptionToken();
    if (subscriptionToken) {
      return { token: subscriptionToken, isOAuth: true };
    }
    console.error(`[hive-auth] readClaudeSubscriptionToken returned null for provider=${provider} authPolicy=${input.authPolicy}`);
  } else {
    console.error(`[hive-auth] skipping subscription token read: provider=${provider} !== anthropic`);
  }

  return undefined;
}

export function resolvePersistentStewardModel(input: {
  provider: string;
  configuredModel: string | null;
  sessionModel: string | null;
}): string {
  if (input.configuredModel) {
    if (!isPiModelSupported(input.provider, input.configuredModel)) {
      throw new UsageError(
        `Configured Pi model '${input.configuredModel}' is not supported for provider '${input.provider}'.`,
      );
    }

    return input.configuredModel;
  }

  if (input.sessionModel && isPiModelSupported(input.provider, input.sessionModel)) {
    return input.sessionModel;
  }

  const fallback = getModels(input.provider as KnownProvider)[0]?.id ?? null;

  if (!fallback) {
    throw new UsageError(`No Pi model is available for provider '${input.provider}'.`);
  }

  return fallback;
}

export function resolvePersistentStewardRuntime(input: {
  globalConfig: string;
  runtime: string;
  sessionModel: string | null;
  repoPath: string;
}): PersistentStewardRuntimeConfig {
  const piRoute = resolvePiRuntimeRoute({
    globalConfig: input.globalConfig,
    runtime: input.runtime,
  });

  if (!piRoute.provider) {
    throw new UsageError(
      `No Pi provider route is configured for runtime '${input.runtime}'. Configure pi-provider-${input.runtime}: <provider> in ~/.hive/config.md or use the direct steward path.`,
    );
  }

  if (!isPiProviderSupported(piRoute.provider)) {
    throw new UsageError(`Pi provider '${piRoute.provider}' is not supported in-process.`);
  }

  const modelId = resolvePersistentStewardModel({
    provider: piRoute.provider,
    configuredModel: piRoute.model,
    sessionModel: input.sessionModel,
  });

  return {
    provider: piRoute.provider,
    modelId,
    authPolicy: piRoute.authPolicy,
    runtimeSignature: [
      input.runtime,
      modelId,
      piRoute.provider,
      piRoute.authPolicy ?? "",
      input.repoPath,
    ].join(":"),
  };
}

export function buildPiModel(input: PersistentStewardRuntimeConfig) {
  return getModel(input.provider as never, input.modelId as never);
}
