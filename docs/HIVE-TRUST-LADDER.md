# HIVE Trust Ladder

This document defines how HIVE should make and gate decisions as it becomes
more autonomous.

The goal is not to make HIVE timid. The goal is to make it confidently useful
inside clear boundaries.

## Problem

Right now HIVE has strong engineering doctrine but weak execution trust
boundaries.

That creates two failure modes:

1. The steward hesitates on actions it should take immediately.
2. The system has no durable, reviewable queue for actions that should require
   explicit approval.

If HIVE is going to handle webhooks, bug pipelines, PR creation, deploys, or
external communications, it needs a first-class trust model.

## Product Goal

The human experience should be:

1. HIVE acts autonomously for safe internal work.
2. HIVE asks for approval in a structured queue for risky or external work.
3. Every approval request is durable, inspectable, and easy to resolve.
4. Trust policy lives in files, not hidden code paths.

## Design Principles

- Internal boldness, external caution.
- Reversible actions get more autonomy than irreversible ones.
- Approval is a product surface, not an exception path.
- Every escalation should include a recommendation, not just a question.
- The queue should be durable and auditable.

## Trust Classes

### 1. `internal-safe`

Allowed without approval:

- Read local files
- Update HIVE state
- Write logs, memory, and board state
- Edit code locally
- Run tests, builds, and local analysis

### 2. `code-safe`

Allowed without approval when local and reversible:

- Apply patches
- Create worktrees and branches
- Refactor project files
- Generate tests and fixtures

### 3. `external-gated`

Requires approval:

- Push to remote
- Open, merge, or close PRs
- Deploy
- Send email or external messages
- Post publicly
- Change infrastructure state
- Use production credentials

### 4. `forbidden`

Blocked unless policy changes explicitly:

- Spend money
- Sign contracts
- Delete production data
- Share sensitive secrets externally
- Execute destructive live-system actions

## Files

### `~/.hive/TRUST.md`

Source of truth for autonomy policy.

### `~/.hive/approvals/pending/*.md`

Open approval requests.

### `~/.hive/approvals/resolved/*.md`

Approved or rejected requests, preserved for audit.

## Approval Request Contract

Each request should contain:

- stable id
- status
- kind
- project
- summary
- requested-by
- created timestamp
- optional note/recommendation

The steward should write requests in a format the human can review directly.

## Gateway Shape

The gateway should eventually expose:

- pending approvals count in top-level status
- approval queue panel
- one-click approve/reject actions
- approval detail modal with rationale and impact

This should feel like “HIVE asking for trust,” not an ops queue.

## Execution Policy

When the steward encounters a gated action:

1. classify the action
2. read `TRUST.md`
3. if allowed, execute
4. if gated, write an approval request and surface it to the human
5. if forbidden, stop and explain why

## Current Implementation Slice

The first slice is intentionally narrow:

- scaffold `TRUST.md`
- add file-backed approval queue primitives
- add CLI listing/request/approve/reject
- emit feed entries for request and resolution

This makes trust durable before wiring approvals into gateway actions, hook
transforms, and autonomous pipelines.
