# HIVE

Identity, project memory, and the reflection protocol load via the user-level
SessionStart hook at `~/.claude/hooks/load-identity.sh` — no per-repo wiring
needed. If identity feels missing, run `hive doctor`.

HIVE MCP tools (pre-fetched by the hook):
- `convene_council` — Multi-model deliberation. Standard, analyst, or dialectic modes.
- `read_hive_memory` — Read project intelligence (full knowledge or lightweight index).
- `write_hive_memory` — Record new facts, conventions, or decisions.
- `search_memory` — BM25 search across knowledge and session logs.
- `reflect_session` — Batch-write session learnings (knowledge + log + index rebuild).
- `create_ticket` — Create a ticket (bug, feature, task, epic, chore) with priority, tags, and dependencies.
- `list_tickets` — List and filter project tickets by status, type, or tags.
- `show_ticket` — Show full ticket details including notes.
- `update_ticket` — Update ticket status, priority, tags, or other fields.
- `add_ticket_note` — Add a timestamped note to a ticket.
- `add_project` — Register a new project with HIVE.
- `hive_status` — Full system dashboard (identity, projects, tickets, runs, agents).
- `manage_heartbeat` — Enable, disable, or check project heartbeat status.

## Development

- Runtime: Bun + TypeScript
- Build: `bun build src/cli.ts --compile --outfile hive-bin`
- MCP server: `bun build src/mcp-server.ts --compile --outfile hive-mcp`
- Run CLI directly: `bun run src/cli.ts <command>`
- Test MCP server: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | bun src/mcp-server.ts`

## Architecture

43 source files, ~11,200 lines. Two entry points:
- `src/cli.ts` — CLI (init, doctor, project, stack, council, memory, ticket, dispatch, heartbeat, inbox, kill, ps, dashboard)
- `src/mcp-server.ts` — MCP server (convene_council, read_hive_memory, write_hive_memory, search_memory, reflect_session, create_ticket, list_tickets, show_ticket, update_ticket, add_ticket_note, add_project, hive_status, manage_heartbeat)

The crown jewel is `src/lib/council.ts` — parallel multi-model deliberation.
Identity lives in `~/.hive/`.
