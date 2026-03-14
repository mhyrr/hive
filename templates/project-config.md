# Project: {{project_name}}

## Repo
path: {{repo_path}}

## Runtime
# Override the global runtime/model for this project.
# runtime: claude
# model: claude-sonnet-4-6

## Stack
# language: typescript
# framework: bun
# database: postgresql
# testing: bun test

## Default Team
- orchestrator: steward
- alpha: craftsman
- beta: craftsman
- gamma: critic
# Uncomment to activate additional roles:
# - delta: architect
# - epsilon: scout

## Rules
# Project-specific rules that override or extend AGENTS.md.
# Examples:
# - All database changes require a migration file.
# - No direct writes to production tables — use the API layer.
# - Tests must pass before any task is marked done.
