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

## Models
- opus: claude, claude-opus-4-6, frontier deep work
- sonnet: claude, claude-sonnet-4-6, general workhorse
- haiku: claude, claude-haiku-4-5-20251001, fast triage
# Uncomment to activate additional models:
# - codex: codex, codex-5.4, code-focused

## Rules
# Project-specific rules that override or extend AGENTS.md.
# Examples:
# - All database changes require a migration file.
# - No direct writes to production tables — use the API layer.
# - Tests must pass before any task is marked done.
