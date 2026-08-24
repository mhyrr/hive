import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

function readMcpMetadata(): { instructions: string; councilDescription: string } {
  const messages = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "council-trigger-policy-test", version: "1.0.0" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ];

  const result = spawnSync(process.execPath, [join(repoRoot, "src", "mcp-server.ts")], {
    cwd: repoRoot,
    input: messages.map((message) => JSON.stringify(message)).join("\n") + "\n",
    encoding: "utf-8",
  });

  expect(result.status, result.stderr).toBe(0);
  const responses = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const initialize = responses.find((response) => response.id === 1);
  const toolsList = responses.find((response) => response.id === 2);
  const council = toolsList?.result?.tools?.find((tool: { name: string }) => tool.name === "convene_council");

  return {
    instructions: initialize?.result?.instructions ?? "",
    councilDescription: council?.description ?? "",
  };
}

describe("council trigger policy", () => {
  test("MCP metadata makes the council user-triggered", () => {
    const metadata = readMcpMetadata();

    expect(metadata.instructions.toLowerCase()).not.toContain("council");
    expect(metadata.councilDescription).toContain(
      "only when the current user request explicitly mentions convening or using a council",
    );
    expect(metadata.councilDescription).toContain("otherwise do not mention or call it");
    expect(metadata.councilDescription).not.toContain("reasonable people would diverge");
  });

  test("identity and planner templates do not promote the council", () => {
    const agents = readFileSync(join(repoRoot, "templates", "AGENTS.md"), "utf-8");
    const identity = readFileSync(join(repoRoot, "templates", "IDENTITY.md"), "utf-8");
    const planner = readFileSync(join(repoRoot, "templates", "agents", "maya-planner.md"), "utf-8");

    expect(agents).toContain("current request explicitly mentions convening or using a council");
    expect(identity.toLowerCase()).not.toContain("council");
    expect(planner.toLowerCase()).not.toContain("council");
  });
});
