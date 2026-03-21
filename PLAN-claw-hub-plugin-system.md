# Plan: Claw Hub Plugin System

## Goal

Build a lightweight plugin system for hive so that external modules (starting with a Claw Hub connector) can extend hive's capabilities without bloating the core. The first plugin provides an interface to Claw Hub — an open ecosystem of reusable agent skills — so the hive and its agents can discover, install, and use community skills on demand.

---

## Design Principles

1. **Plugins live outside hive core** — they register capabilities through a defined interface, not by modifying `src/lib/` internals
2. **File-native** — consistent with hive's philosophy: installed skills are markdown files in `~/.hive/skills/`, plugin config is markdown, no databases
3. **Zero new dependencies** — uses Bun built-ins (`fetch`, `Bun.file`, etc.)
4. **Agents can use it** — the steward gets a tool to search/install hub skills at runtime, so agents self-serve the skills they need

---

## Architecture

```
src/lib/plugins/
  types.ts          # Plugin interface contract
  registry.ts       # Discovers and loads plugins, routes commands
  index.ts          # Public API

src/plugins/
  claw-hub/
    index.ts        # Plugin definition (implements HivePlugin)
    client.ts       # HTTP client for Claw Hub API
    commands.ts     # CLI subcommands: search, install, list, info
    tool.ts         # Steward tool: hub_search, hub_install
```

### Plugin Interface (`types.ts`)

```typescript
export type HivePlugin = {
  name: string;                              // e.g. "claw-hub"
  version: string;
  description: string;

  // CLI extension — registers subcommands under `hive <plugin.name>`
  commands?: PluginCommand[];

  // Steward tools — merged into the steward's tool set at session start
  tools?: (ctx: PluginToolContext) => PersistentStewardTool[];

  // Lifecycle hooks (future-proofing, optional for now)
  onInit?: (paths: HivePaths) => Promise<void>;
};

export type PluginCommand = {
  name: string;                              // subcommand name
  description: string;
  execute: (args: string[]) => Promise<string>;
};

export type PluginToolContext = {
  hiveHome: string;
  skillsDir: string;
  globalConfig: string;
};
```

### Plugin Registry (`registry.ts`)

- Statically imports known plugins (no dynamic `import()` magic — keeps it simple and compile-friendly)
- Provides `getPlugins()`, `routePluginCommand(name, args)`, `getPluginTools(ctx)`
- The list of active plugins is the `src/plugins/` directory — adding a plugin means adding a folder and one import line in `registry.ts`

---

## Claw Hub Plugin

### What is Claw Hub?

A community registry of agent skills (markdown documents teaching patterns, behaviors, and operational knowledge). The plugin needs a configurable registry endpoint — defaulting to a reasonable URL but overridable in `~/.hive/config.md` with a `claw-hub-url` key.

### Client (`client.ts`)

Talks to the Claw Hub API:
- `search(query: string, tags?: string[])` → list of skill summaries
- `fetch(skillId: string)` → full skill content (markdown)
- `list(category?: string)` → browse available skills
- `info(skillId: string)` → metadata (author, version, description, tags)

The client handles:
- Base URL from config (default: `https://hub.claw.dev/api/v1`)
- Response parsing and error handling
- Caching of search results (in-memory, session-scoped)

### CLI Commands (`commands.ts`)

Registered under `hive hub`:

| Command | Description |
|---------|-------------|
| `hive hub search <query>` | Search for skills by keyword |
| `hive hub install <skill-id>` | Download skill markdown to `~/.hive/skills/` |
| `hive hub list [--installed]` | List available or installed skills |
| `hive hub info <skill-id>` | Show skill details (description, author, tags) |
| `hive hub remove <skill-id>` | Remove an installed hub skill |
| `hive hub sync` | Update all installed hub skills to latest versions |

### Steward Tool (`tool.ts`)

Two tools given to the steward so agents can self-serve:

1. **`hub_search`** — search the hub for skills matching a query. Returns summaries so the steward can decide what to install.
2. **`hub_install`** — install a skill by ID. Downloads the markdown and writes it to `~/.hive/skills/<skill-id>.md`. Returns confirmation.

This means the steward can autonomously discover and install skills mid-session when it realizes it needs a capability it doesn't have.

### Installed Skill Tracking

When a skill is installed from the hub, we add a small YAML frontmatter block to the downloaded markdown:

```markdown
---
source: claw-hub
skill-id: advanced-testing-patterns
version: 1.2.0
installed: 2026-03-21
---
# Skill: Advanced Testing Patterns
...
```

This lets `hive hub list --installed` and `hive hub sync` know which skills came from the hub vs. locally authored ones.

---

## Integration Points

### 1. CLI Router (`src/cli.ts`)

Add a plugin dispatch case before the `default` throw:

```typescript
// Try plugin commands before failing
const pluginResult = await routePluginCommand(command, rest);
if (pluginResult !== null) return pluginResult;

throw new UsageError(`Unknown command: ${command}`);
```

This means any plugin that registers commands automatically gets `hive <plugin-name> <subcommand>`.

### 2. Steward Tools (`src/lib/steward/tools/index.ts`)

Append plugin tools to the steward's tool set:

```typescript
return [
  ...createFileTools(execution),
  ...createSearchTools(execution),
  createBashTool(execution),
  ...createDelegationTools({...}),
  ...getPluginTools({ hiveHome, skillsDir, globalConfig }),
] as PersistentStewardTool[];
```

### 3. Help (`src/commands/help.ts`)

Add hub commands to the help output.

### 4. Paths (`src/lib/paths.ts`)

Add `pluginsDir` to `HivePaths` (for future per-plugin state storage at `~/.hive/plugins/`). Ensure it gets created in `ensureHiveScaffold`.

---

## What This Does NOT Do

- **No dynamic plugin loading from disk** — plugins are compiled into the binary. This keeps things fast and auditable. Future work could add `~/.hive/plugins/` with dynamic imports if needed.
- **No plugin marketplace/install** — the plugin system itself is not a package manager. Plugins are added by devs to `src/plugins/` and recompiled.
- **No auth/payments** — Claw Hub access is assumed open/free for now. Auth can be layered in later via config keys.

---

## Implementation Order

1. **Plugin types + registry** (`src/lib/plugins/`) — the interface contract and loader
2. **Claw Hub client** (`src/plugins/claw-hub/client.ts`) — HTTP client for the hub API
3. **Claw Hub commands** (`src/plugins/claw-hub/commands.ts`) — CLI subcommands
4. **Claw Hub steward tool** (`src/plugins/claw-hub/tool.ts`) — agent-facing tools
5. **Claw Hub plugin entry** (`src/plugins/claw-hub/index.ts`) — wires it all together
6. **Integration** — CLI router, steward tools, help text, paths
7. **Test** — verify CLI commands work, tool registration works

---

## Open Questions

1. **Claw Hub API** — What's the actual API shape? If it doesn't exist yet, we can build the client against a reasonable contract and adapt when the real API materializes. The client is isolated enough to swap easily.
2. **Skill namespacing** — Should hub skills be installed to `~/.hive/skills/hub/` to separate them from local skills? Or flat in `~/.hive/skills/` with frontmatter marking the source?
3. **Per-project skill sets** — Should projects be able to declare which hub skills they want (in project `config.md`)? This would let different projects auto-install different skill sets.
4. **Offline mode** — Should the client gracefully degrade when there's no network? (Probably yes — just use what's already installed.)
