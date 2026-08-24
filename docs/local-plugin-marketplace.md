# Local Claude Plugin Marketplace

HIVE uses a local Claude marketplace when an upstream plugin bundles useful
components with hooks that do not match local policy. The local copy becomes
the executable plugin. The upstream installation remains the source for
deliberate updates.

This is a Claude Code surface. `hive init` does not create or update the
marketplace today. TK-108 tracks whether HIVE should automate that work and
how the same policy should map to Codex. The `hive-local` name records policy
ownership. It does not claim current CLI automation.

## Why the Marketplace Exists

Claude Code merges a plugin's `hooks/hooks.json` into the active hook set when
the plugin is enabled. Claude Code can disable all hooks or a whole plugin. It
cannot disable one plugin hook while keeping the rest of that plugin active.

Editing `~/.claude/plugins/cache/` is not a fix. Claude Code replaces cached
plugin files during an update. A local marketplace puts the policy in a stable
source directory that Claude Code copies into its cache.

The rule is simple:

- Keep the upstream plugin name. Skill names such as
  `/superpowers:systematic-debugging` stay stable.
- Copy the upstream license and only the components you want.
- Treat `hooks/hooks.json` as an allowlist. Omit it when no hook is approved.
- Never edit the installed cache as the source of truth.
- Update the local copy deliberately. Upstream updates do not flow into it.

## Canonical Layout

The HIVE-local marketplace lives under Claude's configuration because Claude
owns plugin discovery. It does not belong in `~/.hive/`, which HIVE tracks as
identity, memory, and operational state.

```text
~/.claude/local-marketplaces/hive-local/
├── .claude-plugin/
│   └── marketplace.json
└── plugins/
    └── <plugin-name>/
        ├── .claude-plugin/
        │   └── plugin.json
        ├── LICENSE
        ├── skills/                 # copy when approved
        ├── agents/                 # copy when approved
        ├── commands/               # copy when approved
        ├── .mcp.json               # copy when approved
        └── hooks/
            └── hooks.json          # create only for approved hooks
```

Claude Code copies an installed local plugin to:

```text
~/.claude/plugins/cache/hive-local/<plugin-name>/<version>/
```

That cache is output. Edit the marketplace source above it.

The marketplace is machine-local and is not part of HIVE's git sync. Back it
up separately if another machine must reproduce the same plugin policy.

## One-Time Marketplace Setup

Create the marketplace directories:

```bash
mkdir -p /Users/you/.claude/local-marketplaces/hive-local/.claude-plugin
mkdir -p /Users/you/.claude/local-marketplaces/hive-local/plugins
```

Create
`~/.claude/local-marketplaces/hive-local/.claude-plugin/marketplace.json`:

```json
{
  "name": "hive-local",
  "owner": {
    "name": "Your Name"
  },
  "description": "Local Claude plugins with HIVE-controlled hooks",
  "plugins": []
}
```

Register it once:

```bash
claude plugin marketplace add /Users/you/.claude/local-marketplaces/hive-local
```

Use an absolute path. The marketplace is user-level machine configuration.

## Add a Controlled Plugin

First, find the upstream installation and version:

```bash
claude plugin list --json
```

Create `plugins/<plugin-name>/`. Copy these items from the upstream
`installPath`:

1. `.claude-plugin/plugin.json`
2. `LICENSE`
3. Each component directory that local policy approves

Do not copy `hooks/` by default. If one upstream hook is useful, create a new
`hooks/hooks.json` and copy only that hook entry. This keeps hook selection
explicit when the upstream plugin adds another hook later.

Add the plugin to the `plugins` array in the marketplace catalog:

```json
{
  "name": "example-plugin",
  "source": "./plugins/example-plugin",
  "description": "Locally controlled example-plugin components"
}
```

Validate the source before installation:

```bash
claude plugin validate /Users/you/.claude/local-marketplaces/hive-local
```

Then switch installations:

```bash
claude plugin disable example-plugin@upstream-marketplace --scope user
claude plugin install example-plugin@hive-local --scope user
```

Keep only one enabled copy of a plugin name. Two enabled copies make skill and
component provenance harder to inspect.

## Superpowers Without SessionStart

The Superpowers case keeps its skills and removes its automatic context
injection. The local plugin contains:

```text
plugins/superpowers/
├── .claude-plugin/plugin.json
├── LICENSE
└── skills/
```

It contains no `hooks/` directory. The marketplace entry is:

```json
{
  "name": "superpowers",
  "source": "./plugins/superpowers",
  "description": "Superpowers skills without automatic hooks"
}
```

Switch to it with:

```bash
claude plugin disable superpowers@claude-plugins-official --scope user
claude plugin install superpowers@hive-local --scope user
```

The plugin name remains `superpowers`, so explicit skill calls remain
`/superpowers:<skill-name>`.

## Verify the Boundary

Run these checks after every installation or update:

1. Run `claude plugin list --json`. Confirm that the upstream plugin is
   disabled and `<plugin-name>@hive-local` is enabled.
2. Start a new Claude session. An old session can retain context that an old
   `SessionStart` hook already injected.
3. Run `/hooks`. Confirm that every hook from the local plugin is intentional.
4. Invoke one copied skill explicitly. Confirm that its namespace did not
   change.

`/reload-plugins` reloads plugin files in a running session. It cannot remove
text that a previous `SessionStart` hook already added to that session.

## Update a Local Copy

Local control trades automatic updates for review. Use this sequence:

1. Update or inspect the disabled upstream plugin.
2. Read its release notes and component changes.
3. Copy approved component changes into the local marketplace source.
4. Keep the local hook allowlist unchanged unless policy changed.
5. Update the version in the local `plugin.json`.
6. Run `claude plugin validate`.
7. Run `claude plugin marketplace update hive-local`.
8. Run `claude plugin update <plugin-name>@hive-local`.
9. Repeat the verification checks above in a new session.

Do not copy the upstream plugin directory wholesale during an update. That
would silently restore every upstream hook.

## HIVE Automation Contract

If TK-108 adds a HIVE command for this flow, the command should:

1. Create and register `hive-local` once.
2. Import an installed plugin by explicit component selection.
3. Preserve the upstream plugin name, manifest attribution, and license.
4. Require an explicit hook allowlist. An empty allowlist means no hooks.
5. Validate the local source before it changes the enabled plugin.
6. Let `hive doctor` report upstream version drift and unexpected local hooks.

`hive init` must not overwrite a local plugin or accept a new upstream hook.
Those actions change local policy and require a deliberate update.

## References

- [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)
- [Claude Code local marketplace guide](https://code.claude.com/docs/en/plugin-marketplaces)
- TK-108 — design one HIVE plugin-packaging strategy for Claude Code and Codex
