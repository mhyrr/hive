# @hive/pi-package

HIVE packaged as a Pi ([pi-coding-agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent))
extension package. See `docs/specs/2026-04-22-hive-on-pi-design.md`.

**Status:** Scaffold. No Pi functionality yet — this directory is
structure for the migration work that follows.

## Layout

```
extensions/   TypeScript modules registered via pi.on(...) / pi.registerTool / etc.
skills/       HIVE-owned skills (brainstorming, TDD, stack-specific, …)
commands/     HIVE slash commands (/council, /memory, /ticket, …)
prompt/       System-prompt fragments (behaviors ported from Claude Code §3.1)
mcp.json      MCP server registrations (HIVE MCP, Tidewave, Playwright, Context7)
models.json   Provider/model configuration (optional)
```

## Migration step

This directory is created in **Step 0 — Scaffold** of the hive-on-pi
migration sequence. Subsequent steps populate it:

- Step 1 (foundations): `extensions/identity.ts`, `extensions/stacks.ts`,
  `extensions/trust.ts`, `extensions/observability.ts`, `mcp.json`.
- Step 3 (skills): `skills/` populated from `~/.hive/stacks/` and
  ported superpowers skills.
- Step 4 (interactive parity): `commands/` populated with HIVE slash
  commands wrapping MCP tool calls.
- Step 5–6: extensions/teams.ts, RPC-mode dispatch integration.

## Install (manual, pre-Step-7)

Until `hive init` handles it automatically:

```bash
# 1. Install pi-mcp-adapter (once)
pi install npm:pi-mcp-adapter

# 2. Copy mcp.json to Pi's agent dir
cp packages/hive-pi/mcp.json ~/.pi/agent/mcp.json

# 3. Launch with identity extension
pi --print -e $(pwd)/packages/hive-pi/extensions/identity.ts \
   --thinking off --provider anthropic \
   "your prompt here"
```

Caveat: `mcp.json` contains a machine-specific path to the HIVE MCP
server (`/Users/.../work/hive/src/mcp-server.ts`). On another machine,
edit the path before copying. Step 7 of the migration adds install
templating.

## Build discipline

Before adding a new extension here, exhaust the in-tree pi-mono examples
(`packages/coding-agent/examples/extensions/`) and the nicobailon
ecosystem (`pi-subagents`, `pi-mcp-adapter`, etc.). Fresh code is the
last option, not the first. (Spec §2 build discipline.)
