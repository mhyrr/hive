---
name: typescript-pro
description: Implements advanced TypeScript type systems, creates custom type guards, utility types, and branded types, and configures tRPC for end-to-end type safety. Use when building TypeScript applications requiring advanced generics, conditional or mapped types, discriminated unions, monorepo setup, or full-stack type safety with tRPC.
license: MIT
metadata:
  author: https://github.com/Jeffallan
  version: "1.1.0"
  domain: language
  triggers: TypeScript, generics, type safety, conditional types, mapped types, tRPC, tsconfig, type guards, discriminated unions
  role: specialist
  scope: implementation
  output-format: code
  related-skills: fullstack-guardian, api-designer
---

# TypeScript Pro

## Reference Guide

Load detailed guidance based on context:

| Topic | Reference | Load When |
|-------|-----------|-----------|
| Advanced Types | `references/advanced-types.md` | Generics, conditional types, mapped types, template literals |
| Type Guards | `references/type-guards.md` | Type narrowing, discriminated unions, assertion functions |
| Utility Types | `references/utility-types.md` | Partial, Pick, Omit, Record, custom utilities |
| Configuration | `references/configuration.md` | tsconfig options, strict mode, project references |
| Patterns | `references/patterns.md` | Builder pattern, factory pattern, type-safe APIs |

## Code Examples

### Branded Types
```typescript
// Branded type for domain modeling
type Brand<T, B extends string> = T & { readonly __brand: B };
type UserId  = Brand<string, "UserId">;
type OrderId = Brand<number, "OrderId">;

const toUserId  = (id: string): UserId  => id as UserId;
const toOrderId = (id: number): OrderId => id as OrderId;

// Usage — prevents accidental id mix-ups at compile time
function getOrder(userId: UserId, orderId: OrderId) { /* ... */ }
```

### Discriminated Unions & Type Guards
```typescript
type LoadingState = { status: "loading" };
type SuccessState = { status: "success"; data: string[] };
type ErrorState   = { status: "error";   error: Error };
type RequestState = LoadingState | SuccessState | ErrorState;

// Type predicate guard
function isSuccess(state: RequestState): state is SuccessState {
  return state.status === "success";
}

// Exhaustive switch with discriminated union
function renderState(state: RequestState): string {
  switch (state.status) {
    case "loading": return "Loading…";
    case "success": return state.data.join(", ");
    case "error":   return state.error.message;
    default: {
      const _exhaustive: never = state;
      throw new Error(`Unhandled state: ${_exhaustive}`);
    }
  }
}
```

### Custom Utility Types
```typescript
// Deep readonly — immutable nested objects
type DeepReadonly<T> = {
  readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K];
};

// Require exactly one of a set of keys
type RequireExactlyOne<T, Keys extends keyof T = keyof T> =
  Pick<T, Exclude<keyof T, Keys>> &
  { [K in Keys]-?: Required<Pick<T, K>> & Partial<Record<Exclude<Keys, K>, never>> }[Keys];
```

### tsconfig.json for a published Node library
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true,
    "declaration": true,
    "declarationMap": true,
    "incremental": true,
    "skipLibCheck": false
  }
}
```

Apps built by a bundler (Next.js, Vite) use `"moduleResolution": "bundler"` and `noEmit` instead — see `references/configuration.md` → Framework-Specific Configs.

## Constraints

- Keep `strict` on. Fix or narrow instead of adding `any` or `as`; one that is genuinely needed gets a comment saying why.
- Prefer `as const` objects over `enum` (enums emit runtime code).
- Model state machines as discriminated unions with an exhaustive `never` check.
- Libraries ship declaration files; applications don't need them.

## Knowledge Reference

TypeScript 5.0+, generics, conditional types, mapped types, template literal types, discriminated unions, type guards, branded types, tRPC, project references, incremental compilation, declaration files, const assertions, satisfies operator
