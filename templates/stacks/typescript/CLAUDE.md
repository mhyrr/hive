# TypeScript / React / Next.js Stack

This project uses the `typescript` HIVE stack. Three specialist skills ship
with it — reach for them by topic rather than reading reference files by
hand.

## When to reach for which skill

- **`typescript-types`** — advanced TypeScript: generics, conditional types,
  mapped types, discriminated unions, branded types, utility types, tRPC
  end-to-end safety, `tsconfig.json` strict-mode wiring. Default skill for
  type-heavy work, monorepo setup, or when the compiler is fighting you.
- **`typescript-react`** — React 18/19: hooks, Server Components, Suspense,
  `useActionState`, `use()`, TanStack Query, Zustand. Invoke on `.tsx`
  components, custom hook design, or when debugging rendering.
- **`typescript-nextjs`** — Next.js 14+ App Router: RSC vs client components,
  server actions, route handlers, middleware, streaming SSR, metadata for
  SEO, `loading.tsx` / `error.tsx` boundaries, Vercel deploy config. Invoke
  on anything under `app/` or when touching route config.

Each SKILL.md is the quick reference; deep dives live in `references/*.md`
and load on demand.

## Cross-cutting rules

Distilled from the three skills' `MUST DO` / `MUST NOT DO` blocks.

1. **Strict mode, no exceptions.** Every `tsconfig.json` flag in strict
   mode is on. No `"strict": false` projects; no "temporary" `any`.
2. **`unknown` over `any`.** When the type is genuinely unknown, narrow
   it with a type guard — don't escape the type system.
3. **Discriminated unions for state.** Every non-trivial state shape has
   a `kind` / `status` / `_tag` discriminator. No "optional everything"
   object shapes.
4. **Branded types for domain primitives.** `UserId`, `Cents`, `Email`
   get branded. Raw `string` / `number` at boundaries only.
5. **Never assert with `as` across unrelated types.** If the compiler
   rejects it, the runtime will too. Use type guards or narrow properly.
6. **Exhaustive switches with `never`.** `const _exhaustive: never = x;`
   in the default branch catches new variants at compile time.
7. **Server Components by default** in Next.js App Router. Mark with
   `"use client"` only when you need interactivity, browser APIs, or hooks.
8. **Server actions take `FormData`, return serializable results.** No
   class instances, no functions, no `Date` objects leaving the server.
9. **No `useEffect` for derived state.** Compute it in render. `useEffect`
   is for synchronizing with external systems (subscriptions, DOM, network).
10. **Suspense boundaries close to the source of async.** Not at the root.

## Design philosophy

- **Types are documentation.** A well-typed signature replaces a
  paragraph of comments. Lean into generics and branded types.
- **Push work to the compiler.** Discriminated unions + exhaustive
  switches + branded types catch bugs before runtime.
- **Boundaries should be narrow and typed.** Validate external data
  once at the edge (Zod, io-ts, branded parsers) then trust the types
  internally.
- **Servers render HTML, clients hydrate interaction.** In Next.js App
  Router, the default is always "run on the server." Only pay for the
  client bundle when you need it.

## Attribution

Skill content derived from
[Jeffallan/claude-skills](https://github.com/Jeffallan/claude-skills)
(MIT). Full license text in `LICENSE`. Vendored at commit
[`5b76101`](https://github.com/Jeffallan/claude-skills/commit/5b76101)
(2026-03-23); see `.vendored-commit` for the exact SHA.
