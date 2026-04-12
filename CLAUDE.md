# HIVE

Read and internalize these files at the start of every session:
- ~/.hive/SOUL.md — your values and craft standards
- ~/.hive/IDENTITY.md — who you are
- ~/.hive/SELF.md — who you're working with
- ~/.hive/TRUST.md — action classification and approval rules
- ~/.hive/AGENTS.md — operational doctrine

Read your project memory:
- ~/.hive/memory/projects/hive.md — accumulated facts, conventions, decisions

You have HIVE MCP tools:
- `convene_council` — Multi-model analysis. Sends a question to multiple AI models in parallel. You act as chair — synthesize agreement and disagreement.
- `read_hive_memory` — Read accumulated project intelligence.
- `write_hive_memory` — Record new facts, conventions, or decisions.
- `create_ticket` — Create a ticket (bug, feature, task, epic, chore) with priority, tags, and dependencies.
- `list_tickets` — List and filter project tickets by status, type, or tags.
- `show_ticket` — Show full ticket details including notes.
- `update_ticket` — Update ticket status, priority, tags, or other fields.
- `add_ticket_note` — Add a timestamped note to a ticket.

## Development

- Runtime: Bun + TypeScript
- Build: `bun build src/cli.ts --target bun --outfile hive-bin`
- MCP server: `bun build src/mcp-server.ts --target bun --outfile hive-mcp`
- Run CLI directly: `bun run src/cli.ts <command>`
- Test MCP server: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | bun src/mcp-server.ts`

## Architecture

29 source files, ~6,700 lines. Two entry points:
- `src/cli.ts` — CLI (init, project, council, memory)
- `src/mcp-server.ts` — MCP server (convene_council, read_hive_memory, write_hive_memory)

The crown jewel is `src/lib/council.ts` — parallel multi-model deliberation.
Identity lives in `~/.hive/`. Projects reference it in CLAUDE.md. Claude Code reads it directly.
