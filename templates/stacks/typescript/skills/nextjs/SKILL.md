---
name: nextjs-developer
description: "Next.js App Router work — route segments and layouts, Server vs Client Components, Server Actions, route handlers, data fetching and caching, streaming with loading/error boundaries, metadata for SEO, and deployment. Use when editing files under `app/`, `next.config.*`, or Next.js route conventions."
license: MIT
metadata:
  author: https://github.com/Jeffallan
  version: "1.1.0"
  domain: frontend
  role: specialist
  scope: implementation
  output-format: code
  related-skills: typescript-pro
---

# Next.js Developer

Senior Next.js developer with expertise in the Next.js App Router, server components, and full-stack deployment with focus on performance and SEO excellence.

## Reference Guide

Load detailed guidance based on context:

| Topic | Reference | Load When |
|-------|-----------|-----------|
| App Router | `references/app-router.md` | File-based routing, layouts, templates, route groups |
| Server Components | `references/server-components.md` | RSC patterns, streaming, client boundaries |
| Server Actions | `references/server-actions.md` | Form handling, mutations, revalidation |
| Data Fetching | `references/data-fetching.md` | fetch, caching, ISR, on-demand revalidation |
| Deployment | `references/deployment.md` | Vercel, self-hosting, Docker, optimization |

## Constraints

- New routes go in `app/`. In a codebase still on `pages/`, follow its router unless the task is the migration.
- Components are Server Components by default; add `'use client'` at the smallest leaf that needs state, effects, or browser APIs. Fetch on the server rather than converting a component to reach data.
- Set caching explicitly on each `fetch` (`force-cache`, `next: { revalidate }`, or `no-store`); an unmarked fetch is not cached (Next.js 15+).
- SEO tags come from `metadata`/`generateMetadata`, not hand-written `<title>`/`<meta>`. Content images use `next/image`.
- Async route segments get a loading state (`loading.tsx` or `<Suspense>`) and an `error.tsx`.

## Code Examples

### Server Component with data fetching and caching
```tsx
// app/products/page.tsx
import { Suspense } from 'react'

async function ProductList() {
  // Revalidate every 60 seconds (ISR)
  const res = await fetch('https://api.example.com/products', {
    next: { revalidate: 60 },
  })
  if (!res.ok) throw new Error('Failed to fetch products')
  const products: Product[] = await res.json()

  return (
    <ul>
      {products.map((p) => (
        <li key={p.id}>{p.name}</li>
      ))}
    </ul>
  )
}

export default function Page() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <ProductList />
    </Suspense>
  )
}
```

### Server Action with form handling and revalidation
```tsx
// app/products/actions.ts
'use server'

import { revalidatePath } from 'next/cache'

export async function createProduct(formData: FormData) {
  const name = formData.get('name') as string
  await db.product.create({ data: { name } })
  revalidatePath('/products')
}

// app/products/new/page.tsx
import { createProduct } from '../actions'

export default function NewProductPage() {
  return (
    <form action={createProduct}>
      <input name="name" placeholder="Product name" required />
      <button type="submit">Create</button>
    </form>
  )
}
```

### generateMetadata for dynamic SEO
```tsx
// app/products/[id]/page.tsx
import type { Metadata } from 'next'

export async function generateMetadata(
  { params }: { params: Promise<{ id: string }> }
): Promise<Metadata> {
  const { id } = await params
  const product = await fetchProduct(id)
  return {
    title: product.name,
    description: product.description,
    openGraph: { title: product.name, images: [product.imageUrl] },
  }
}
```

## Knowledge Reference

Next.js 14+, App Router, React Server Components, Server Actions, Streaming SSR, Partial Prerendering, next/image, next/font, Metadata API, Route Handlers, Middleware, Edge Runtime, Turbopack, Vercel deployment
