const DEFAULT_BASE_URL = "https://hub.claw.dev/api/v1";

export type HubSkillSummary = {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
};

export type HubSkillDetail = {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  content: string;
};

export type ClawHubClientOptions = {
  baseUrl?: string;
};

export class ClawHubClient {
  private baseUrl: string;
  private cache = new Map<string, { data: unknown; at: number }>();
  private cacheTtlMs = 5 * 60 * 1000; // 5 minutes

  constructor(options: ClawHubClientOptions = {}) {
    this.baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async search(query: string, tags?: string[]): Promise<HubSkillSummary[]> {
    const params = new URLSearchParams({ q: query });

    if (tags?.length) {
      params.set("tags", tags.join(","));
    }

    return this.get<HubSkillSummary[]>(`/skills/search?${params}`);
  }

  async list(category?: string): Promise<HubSkillSummary[]> {
    const params = category ? `?category=${encodeURIComponent(category)}` : "";

    return this.get<HubSkillSummary[]>(`/skills${params}`);
  }

  async info(skillId: string): Promise<HubSkillDetail> {
    return this.get<HubSkillDetail>(`/skills/${encodeURIComponent(skillId)}`);
  }

  async fetch(skillId: string): Promise<string> {
    const detail = await this.info(skillId);

    return detail.content;
  }

  private async get<T>(path: string): Promise<T> {
    const cached = this.cache.get(path);

    if (cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.data as T;
    }

    const url = `${this.baseUrl}${path}`;
    let response: Response;

    try {
      response = await globalThis.fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("abort") || message.includes("timeout")) {
        throw new HubUnavailableError("Hub request timed out");
      }

      throw new HubUnavailableError(`Hub unreachable: ${message}`);
    }

    if (!response.ok) {
      if (response.status === 404) {
        throw new HubNotFoundError(path);
      }

      throw new HubUnavailableError(`Hub returned ${response.status}: ${response.statusText}`);
    }

    const data = (await response.json()) as T;
    this.cache.set(path, { data, at: Date.now() });

    return data;
  }
}

export class HubUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubUnavailableError";
  }
}

export class HubNotFoundError extends Error {
  constructor(path: string) {
    super(`Not found: ${path}`);
    this.name = "HubNotFoundError";
  }
}

/**
 * Extract `claw-hub-url` from hive config, falling back to the default.
 */
export function resolveHubUrl(globalConfig: string): string {
  const match = globalConfig.match(/^claw-hub-url:\s*(.+)$/m);

  return match ? match[1].trim() : DEFAULT_BASE_URL;
}
