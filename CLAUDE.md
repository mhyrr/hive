# HIVE

Identity, project memory, and the reflection protocol load via the user-level
SessionStart hook at `~/.claude/hooks/load-identity.sh` — no per-repo wiring
needed. If identity feels missing, run `hive doctor`.

Claude Code is the default interactive harness. Pi is optional via `hive -3`
/ `hive --pi`; HIVE injects identity with a generated `pi -e` extension and
Pi owns provider/model selection. Codex is optional via `hive -x` /
`hive --codex`; `hive init` wires `~/.codex/AGENTS.md`,
`[mcp_servers.hive]`, and a Codex SessionStart hook when Codex is installed.

HIVE MCP tools (loaded eagerly via `alwaysLoad: true` on the MCP registration):
- `convene_council` — Multi-model deliberation. Standard, analyst, or dialectic modes.
- `read_hive_memory` — Read project intelligence (full knowledge or lightweight index).
- `write_hive_memory` — Queue a fact/convention/decision/question as a candidate. Mid-session writes go to `candidates.md`; the nightly verifier (Pass V) admits them to canon.
- `search_memory` — BM25 search across knowledge and session logs. Bumps recall metadata for retrieval strengthening.
- `search_taste` — Retrieve ACTIVE (approved) taste units for a work-type category (IDEAS/DESIGN/IMPLEMENTATION/TEST_EVAL/COMMUNICATION/PROCESS). Merges the project + general stores; only approved units are returned. Reach for it when starting a kind of work.
- `reflect_session` — Batch-queue session learnings as candidates. Raw entries also land in the session log.
- `create_ticket` — Create a ticket (bug, feature, task, epic, chore) with priority, tags, and dependencies.
- `list_tickets` — List and filter project tickets by status, type, or tags.
- `show_ticket` — Show full ticket details including notes.
- `update_ticket` — Update ticket status, priority, tags, or other fields.
- `add_ticket_note` — Add a timestamped note to a ticket.
- `add_project` — Register a new project with HIVE.
- `hive_status` — Full system dashboard (identity, projects, tickets, runs, agents).
- `manage_heartbeat` — Enable, disable, or check project heartbeat status.

## Auth

HIVE defaults to **subscription OAuth** for spawned claude runs (dispatch,
heartbeat). API key auth is supported for users who don't have a Claude
subscription, but the default is OAuth — the dispatch wrapper unsets
`ANTHROPIC_API_KEY` before launch to enforce that default. If subscription
OAuth fails, the run fails — surface the failure, don't silently fall back.

On macOS the OAuth token lives in Keychain (`Claude Code-credentials` in
`login.keychain-db`). Detached subprocesses without a GUI session can hit
Keychain access errors, which claude surfaces as `ConnectionRefused`. That's
a real failure to expose, not paper over with an API key fallback.

To opt into API key auth (e.g. forks running on machines without a
subscription), edit the `unset ANTHROPIC_API_KEY` line out of the wrapper
in `src/commands/dispatch.ts`. A proper opt-in env var (`HIVE_ALLOW_API_KEY`)
is a future TK if it becomes a recurring ask.

## Development

- Runtime: Bun + TypeScript
- Build (deployable binaries): `bun build src/cli.ts --compile --outfile hive-bin`
  and `bun build src/mcp-server.ts --compile --outfile hive-mcp`. Use `--compile`,
  not `--target bun` — the latter emits a `// @bun` JS bundle that only runs via
  `bun <file>`, not a standalone executable, so it can't be installed as `hive`.
- Install a rebuilt binary: `rm ~/.local/bin/hive && cp hive-bin ~/.local/bin/hive`
  (rm-then-cp — overwriting in place trips the macOS cdhash cache and SIGKILLs the
  next run). `~/.local/bin/hive-mcp` symlinks to the repo's `hive-mcp`.
- Run CLI directly (no build): `bun run src/cli.ts <command>`
- Test MCP server: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}' | bun src/mcp-server.ts`

## Architecture

~80 source files, ~22,900 lines. Two entry points:
- `src/cli.ts` — CLI (init, doctor, context, identity, project, stack, council, memory, ticket, dispatch, heartbeat, watch, inbox, kill, ps, dashboard) plus interactive harness routing (`hive` -> Claude Code, `hive -3` -> Pi, `hive -x` -> Codex). The `memory` subcommand exposes the V1 nightly pipeline: `condition`, `extract-project`, `extract-reflections`, `verify`, `apply`, `nightly`.
- `src/mcp-server.ts` — MCP server (same tools as the bullet list above).

Crown-jewel modules:
- `src/lib/council.ts` — parallel multi-model deliberation
- `src/lib/harness.ts` / `src/lib/pi-wire.ts` / `src/lib/codex-wire.ts` — interactive harness selection and optional runtime wiring
- `src/lib/orchestrator.ts` — nightly pipeline (Pass A → B → C → V → F → P)
- `src/lib/verify.ts` — Opus verifier; the only path into `knowledge.md`
- `src/lib/memory.ts` — storage layer: BM25, decay, hashed supersede/merge primitives, candidates queue

Identity lives in `~/.hive/`. Nightly artifacts at `~/.hive/memory/runs/{DATE}/`.
See `docs/memory-architecture.md` for the read/write paths and pipeline diagram.
