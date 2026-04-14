# TypeScript Stack

Opinionated bundle for TypeScript-heavy projects — advanced types, React, and
Next.js App Router. Tight scope on v1; expand when real gaps appear.

## Skills

- `typescript-types` *(source: `typescript-pro`)* — generics, conditional &
  mapped types, discriminated unions, branded types, utility types, tRPC,
  strict mode config
- `typescript-react` *(source: `react-expert`)* — React 18/19, hooks, Server
  Components, Suspense, `useActionState`, state management, performance
- `typescript-nextjs` *(source: `nextjs-developer`)* — App Router, RSC,
  server actions, middleware, streaming SSR, metadata, Vercel deploys

Each skill has a `SKILL.md` quick reference and `references/*.md` deep-dives
loaded on demand.

## Not included (yet)

- Databases (Drizzle / Prisma / SQL tuning) — not every TS project is backend
- Testing (Vitest / Playwright / Testing Library) — future `typescript-testing` skill
- Hono / tRPC / TanStack — frameworks that deserve their own stacks when demand appears
- NestJS — separate server framework; install as a sibling stack if needed

## Attribution

Skill content derived from
[Jeffallan/claude-skills](https://github.com/Jeffallan/claude-skills)
(MIT License). Full license text in `LICENSE`.

Vendored at upstream commit
[`5b76101`](https://github.com/Jeffallan/claude-skills/commit/5b76101) (2026-03-23).
The commit SHA is recorded in `.vendored-commit` so a future update can diff
cleanly against upstream.

## Source-tree renames

To produce clean deployed skill names (`typescript-<topic>`), the source
directory names are shortened from Jeffallan's originals:

| Source dir (HIVE)  | Upstream name (Jeffallan) |
| ------------------ | ------------------------- |
| `skills/types`     | `typescript-pro`          |
| `skills/react`     | `react-expert`            |
| `skills/nextjs`    | `nextjs-developer`        |

Frontmatter `name:` is rewritten on sync to match (`typescript-types`,
`typescript-react`, `typescript-nextjs`).

## Updating

Edit `skills/<topic>/SKILL.md` (or files under `references/`), then:

    hive stack sync typescript

Changes take effect on the next Claude Code session. Deployed copies land in
`~/.claude/skills/typescript-*`.

## Upstream drift

This stack is a snapshot. When Jeffallan's repo gets meaningful updates,
re-vendor manually by cloning
[Jeffallan/claude-skills](https://github.com/Jeffallan/claude-skills),
diffing `skills/typescript-pro`, `skills/react-expert`,
`skills/nextjs-developer` against our vendored copies, merging desirable
changes, and bumping `.vendored-commit` to the new SHA.
