import { join } from "node:path";

import { parseFrontmatter, stringifyFrontmatter } from "./frontmatter";
import { isProcessAlive } from "./supervisor";

export const GATEWAY_STATE_FILE = "gateway.md";

export type GatewayStateRecord = {
  status: string;
  pid: number | null;
  port: number | null;
  started: string;
  url: string;
  supervisorPid: number | null;
  supervisorStatus: string | null;
  supervisorProject: string | null;
};

export function gatewayStatePath(hiveHome: string): string {
  return join(hiveHome, GATEWAY_STATE_FILE);
}

function toNullableNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

export async function readGatewayState(hiveHome: string): Promise<GatewayStateRecord | null> {
  const file = Bun.file(gatewayStatePath(hiveHome));

  if (!(await file.exists())) {
    return null;
  }

  const text = await file.text();
  const { attributes } = parseFrontmatter(text);

  return {
    status: attributes.status ?? "unknown",
    pid: toNullableNumber(attributes.pid),
    port: toNullableNumber(attributes.port),
    started: attributes.started ?? "",
    url: attributes.url ?? "",
    supervisorPid: toNullableNumber(attributes["supervisor-pid"]),
    supervisorStatus: attributes["supervisor-status"] ?? null,
    supervisorProject: attributes["supervisor-project"] ?? null,
  };
}

export async function writeGatewayState(
  hiveHome: string,
  state: GatewayStateRecord,
): Promise<void> {
  const attributes: Record<string, string> = {
    status: state.status,
    started: state.started,
    url: state.url,
  };

  if (state.pid !== null) {
    attributes.pid = String(state.pid);
  }

  if (state.port !== null) {
    attributes.port = String(state.port);
  }

  if (state.supervisorPid !== null) {
    attributes["supervisor-pid"] = String(state.supervisorPid);
  }

  if (state.supervisorStatus) {
    attributes["supervisor-status"] = state.supervisorStatus;
  }

  if (state.supervisorProject) {
    attributes["supervisor-project"] = state.supervisorProject;
  }

  await Bun.write(gatewayStatePath(hiveHome), stringifyFrontmatter(attributes, ""));
}

export async function updateGatewayState(
  hiveHome: string,
  patch: Partial<GatewayStateRecord>,
): Promise<GatewayStateRecord | null> {
  const current = await readGatewayState(hiveHome);

  if (!current) {
    return null;
  }

  const next = {
    ...current,
    ...patch,
  };

  await writeGatewayState(hiveHome, next);
  return next;
}

export async function reconcileGatewayState(hiveHome: string): Promise<GatewayStateRecord | null> {
  const state = await readGatewayState(hiveHome);

  if (!state) {
    return null;
  }

  if (state.status === "active" && state.pid && !isProcessAlive(state.pid)) {
    const next = {
      ...state,
      status: "stopped",
      supervisorPid: null,
      supervisorStatus: state.supervisorStatus === "active" ? "stopped" : state.supervisorStatus,
    };

    await writeGatewayState(hiveHome, next);
    return next;
  }

  return state;
}
