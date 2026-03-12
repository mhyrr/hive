# HIVE Events And Hooks

This document defines the event layer that should connect the steward,
supervisor, pipelines, and future integrations.

## Problem

HIVE already has:

- durable feed entries
- run ledger
- WebSocket gateway broadcasts

But those are still mostly presentation outputs, not a formal event kernel.

Without a first-class event layer:

- integrations become ad hoc
- automation logic gets scattered across commands
- the steward cannot reason over normalized incidents and triggers

## Product Goal

HIVE should accept internal and external events through one normalized path.

Examples:

- run completed
- run stalled
- approval requested
- approval resolved
- CI failed
- Sentry issue opened
- deploy finished

The steward should see a compact event summary, not raw webhook payloads.

## Event Model

### Internal events

Stored in:

- `events/internal/YYYY-MM-DD.jsonl`

Examples:

- `run.completed`
- `run.failed`
- `approval.requested`
- `approval.resolved`
- `memory.extraction.completed`

### External events

Stored in:

- `events/external/YYYY-MM-DD.jsonl`

Examples:

- `github.pr.opened`
- `sentry.issue.created`
- `ci.build.failed`

### Derived view

Per-project or global summaries in:

- `state/recent-events.json`
- `state/open-incidents.json`

## Hook Architecture

External systems should not write directly into project files.

They should pass through:

1. a hook endpoint
2. a transform module
3. a normalized event record
4. optional steward or project message creation

This preserves deterministic boundaries.

## Transform Contract

A hook transform should:

- validate the source payload
- normalize it into a stable event shape
- classify severity and project target
- optionally emit a recommended action

The transform should not perform autonomous LLM reasoning.

## Relationship To Feed

`feed.md` remains the human-facing high-signal narrative.

Events are lower-level and more structured.

The feed should be derived from significant events, not vice versa.

## First Integration Targets

When hooks land, start with:

- GitHub/CI
- Sentry
- deploy notifications

These fit HIVE’s engineering focus and create immediate leverage.

## Current Implementation Slice

The first event slice should stay small and deterministic:

- scaffold `~/.hive/events/internal/` and `~/.hive/events/external/`
- append normalized JSONL event records
- emit approval lifecycle events first
- expose `hive events` for direct inspection

That gives HIVE a durable event kernel before adding HTTP hooks, transforms, or
incident automation.
