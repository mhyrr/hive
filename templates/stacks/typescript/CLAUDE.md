# TypeScript / React / Next.js root file starter

Copy the body below to your repo's `AGENTS.md` (Codex reads only that name)
with `CLAUDE.md` a symlink or a one-line `@AGENTS.md` import. Fill in the
angle brackets, delete what doesn't apply, keep it under 8 KB and 200 lines.
`CLAUDE-starter.md` has the six rules and the porting procedure.

The `typescript-*` skills carry this stack's canon — type system, React,
App Router — and load on demand. Never copy that canon here; a root file that
restates a skill pays for it in every session.

---

# <App>

<One paragraph: what this is, who it's for, the current focus.> Next.js <x>
App Router, React <x>, TypeScript strict, <Postgres/Prisma/Drizzle>, <runtime>.

| Read this | For |
|---|---|
| `README.md`, `PRODUCT.md` | What it is, who it's for, what it promises |
| `docs/design/<doc>.md` | The architecture and its numbered decisions |
| `DESIGN.md` | The surface. Binding; it overrides generic UI guidance |

## The line the codebase is built around

- **External data is parsed once, at the edge.** Every boundary (request
  body, third-party response, env) goes through a schema parser, and the
  types are trusted inside. `unknown` at the seam, never `any`.
- **Never floats for money.** Integer cents behind a branded `Cents`; the
  formatting happens at the edge, once.
- **<The one rule this app cannot break.>** <What breaks without it.>

## Where things live

```text
app/                  routes: page.tsx, layout.tsx, route.ts
app/api/<name>/       route handlers
src/lib/              <the domain logic — framework-free>
src/components/       shared UI
src/db/               schema and queries, the only place they live
```

## Commands

```sh
bun test <path> -t "<name>"   # one test by name
bunx tsc --noEmit             # types only, without a full build
bunx next build               # production build
```

## Conventions

- Migrations are append-only once merged; a mistake gets a new migration.
- Server actions take `FormData` and return plain serializable values
  (primitives, plain objects and arrays, `Date`, `Map`/`Set`) — no class
  instances or functions.
- Env is read once, in one typed module, never `process.env` in a component.
- Incidents and gotchas go to HIVE memory, not this file.

---

Skill content derived from
[Jeffallan/claude-skills](https://github.com/Jeffallan/claude-skills) (MIT).
Full license text in `LICENSE`; vendored at commit
[`5b76101`](https://github.com/Jeffallan/claude-skills/commit/5b76101) — see
`.vendored-commit` for the exact SHA.
