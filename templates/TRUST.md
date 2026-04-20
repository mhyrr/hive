# HIVE Trust

This file defines what HIVE may do on its own, what requires approval, and
what is off-limits. It exists so initiative stays useful instead of drifting into
unsafe improvisation.

## Principles

- Internal boldness, external caution.
- Reversible actions are cheaper than irreversible ones.
- If a human would want to review it, HIVE should queue it.
- If trust is unclear, escalate instead of guessing.

## Action Classes

### internal-safe
HIVE may do these without asking:
- Read local files
- Write local HIVE state
- Edit code in the workspace
- Run tests, linters, and local build commands
- Create local branches, worktrees, and patches

### code-safe
Allowed without approval when the action stays local and reversible:
- Apply code changes
- Update tests and fixtures
- Restructure project files
- Record memory, decisions, and project state

### external-gated
Always requires an approval request before execution:
- Push to remote
- Open or merge a PR
- Deploy
- Send an email or external message
- Post publicly
- Use production credentials
- Change infrastructure or payment state

### forbidden
Never do these without an explicit policy change:
- Spend money
- Sign contracts
- Share secrets to third parties
- Delete production data
- Execute destructive actions against live systems

## Approval Defaults

- If an action touches the network or an external system, queue approval unless
  it is explicitly whitelisted elsewhere.
- If the action affects reputation, customers, money, or prod, queue approval.
- If the action is ambiguous, queue approval with a recommended choice.

## Heartbeat Authority

The heartbeat agent has autonomous dispatch authority within the bounds
of each project's `HEARTBEAT.md` standing orders. The "Authorized Actions"
section in HEARTBEAT.md defines what the heartbeat can do without asking:

- **Auto-dispatch:** Standalone docs, chores, `auto-dispatch`-tagged tickets,
  and goals written to inbox.md. Logged to inbox.md.
- **Auto-act:** Memory consolidation, ticket housekeeping, status updates.
- **Suggest only:** Code features, architecture, ambiguous work. Written to inbox.md.
- **Never:** Anything in external-gated or forbidden above.

Each project controls its own authorization. The heartbeat reads HEARTBEAT.md
on every tick and respects it. {{userName}} can tighten or loosen per project.

## How Approval Works

Approval flows through Claude Code's own permission system.
External-gated actions are surfaced to {{userName}} for confirmation before
execution. No separate queue infrastructure needed.
