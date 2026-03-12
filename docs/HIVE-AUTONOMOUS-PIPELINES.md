# HIVE Autonomous Pipelines

This document defines how HIVE should turn normalized events plus trust policy
into focused autonomous workflows.

## Problem

HIVE can already coordinate workers, but it does not yet have clean productized
pipelines for recurring autonomous jobs.

Examples that should become first-class:

- bug triage and autofix
- CI failure triage
- deploy readiness checks
- approval-driven external execution

## Product Goal

Pipelines should feel like repeatable capabilities HIVE owns, not one-off prompt
hacks.

Each pipeline should define:

- trigger
- trust classification
- worker plan
- verification
- human escalation conditions
- closure behavior

## Pipeline Shape

### 1. Trigger

Comes from:

- human request
- internal event
- external hook
- scheduled job

### 2. Triage

A deterministic classifier or cheap model decides:

- project
- severity
- auto-fixable or escalate
- required approvals

### 3. Work

The steward or supervisor launches the right worker pattern:

- direct steward action
- one worker
- multi-worker coordinated pass

### 4. Verification

The pipeline is not done until verification runs.

Examples:

- tests pass
- lint passes
- diff is coherent
- target issue is linked

### 5. Closure

The system should write:

- run result
- feed event
- memory/journal entry when durable
- approval request if further action is gated

## Recommended First Pipelines

### Sentry autofix

Green-light only for:

- null checks
- missing imports
- obvious edge-case guards

Escalate for:

- auth
- payments
- schema changes
- ambiguous business logic

### CI failure triage

Detect whether:

- it is flaky
- it is a local regression
- it needs a worker fix pass

### Approval-backed publish/deploy

Once trust queue is real, the steward can prepare the action and wait for
approval instead of stalling or silently doing it.

## Build Order

1. trust ladder and approval queue
2. event kernel and transforms
3. narrow bug/CI pipelines
4. richer external execution surfaces

Pipelines should grow from audited, narrow wins, not from broad autonomy
claims.
