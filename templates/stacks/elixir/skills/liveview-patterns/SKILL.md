---
name: liveview-patterns
description: "LiveView patterns — PubSub, uploads, components, forms, assign_async, streams. Use when building LiveView features or debugging handle_event lifecycle."
effort: medium
user-invocable: false
paths:
  - "**/*_live.ex"
  - "**/*_component.ex"
  - "**/*.sface"
  - "**/*_channel.ex"
---

# LiveView Patterns Reference

Reference for building with Phoenix LiveView 1.0/1.1.

## Iron Laws — Never Violate These

1. **NO DATABASE QUERIES IN DISCONNECTED MOUNT** — Queries run TWICE (HTTP + WebSocket). Use `assign_async`
2. **ALWAYS USE STREAMS FOR LISTS** — Regular assigns = O(n) memory per user. Streams = O(1)
3. **CHECK connected?/1 BEFORE SUBSCRIPTIONS** — Prevents double subscriptions
4. **EXTRACT VARIABLES BEFORE assign_async CLOSURE** — Closures copy entire referenced variables
5. **LOAD PRIMARY DATA IN mount/3, PAGINATION IN handle_params/3** — handle_params runs on EVERY URL change
6. **NEVER PASS SOCKET TO BUSINESS LOGIC** — Extract data before calling contexts
7. **CHECK CHANGESET ERRORS BEFORE UI DEBUGGING** — Silent form save = check `{:error, changeset}` first, not viewport/JS
8. **HIDDEN INPUTS FOR ALL REQUIRED EMBEDDED FIELDS** — Every required field in an embedded schema MUST have a `hidden_input` if not directly editable
9. **NEVER USE `assign_new` FOR LIFECYCLE VALUES** — `assign_new` skips the function if key exists. Use `assign/3` for locale, current user, or any value refreshed every mount

## HEEx Iron Rules — Compile Errors If Violated

Full detail in `references/heex-syntax.md`.

1. **`{...}` IN ATTRIBUTES, ALWAYS** — `<%= %>` works only in tag bodies. `id="<%= @id %>"` is a syntax error
2. **`<%= %>` ONLY FOR BLOCKS** — `if`/`cond`/`case`/`for` in a tag body. Plain values use `{...}`
3. **COMMENTS ARE `<%!-- --%>`** — not `<!-- -->`
4. **CLASS LISTS NEED `[...]`** — `class={["a", @flag && "b", if(@c, do: "x", else: "y")]}`. No brackets = compile error. Parenthesize the `if`
5. **LITERAL `{`/`}` NEEDS `phx-no-curly-interpolation`** — on the parent `<pre>`/`<code>` tag
6. **NO `else if`** — use `<%= cond do %>`
7. **`~H` OR `.html.heex` ONLY** — never `~E`
8. **NEVER RENDER A CHANGESET** — assign `to_form/2` in the LiveView; `<.form for={@form}>` and `@form[:field]`. `<.form for={@changeset}>` and `let={f}` both error
9. **UNIQUE DOM IDs ON KEY ELEMENTS** — forms, buttons, anything a test selects

## Memory Impact

| Pattern | 3K items | 10K users × 10K items |
|---------|----------|----------------------|
| Regular assigns | ~5.1 MB | ~10+ GB |
| Streams | ~1.1 MB | Minimal (O(1)) |

**Decision**: Lists with >100 items → Use streams, not assigns

## Quick Patterns

### Async Assigns (CRITICAL)

```elixir
def mount(%{"slug" => slug}, _session, socket) do
  # Extract needed values BEFORE the closure
  scope = socket.assigns.current_scope

  {:ok,
   socket
   |> assign_async(:org, fn -> {:ok, %{org: fetch_org(scope, slug)}} end)}
end
```

### Streams for Lists

```elixir
def mount(_params, _session, socket) do
  {:ok, stream(socket, :items, Items.list_items())}
end

# Insert/update/delete
stream_insert(socket, :items, item, at: 0)
stream_delete(socket, :items, item)
```

### PubSub with connected? check

```elixir
def mount(_params, _session, socket) do
  if connected?(socket), do: Chat.subscribe(room_id)
  {:ok, socket}
end
```

## Navigation Decision Tree

```
Same LiveView, different params? → patch / push_patch
Different LiveView, same live_session? → navigate / push_navigate
Different live_session or non-LiveView? → href / redirect
```

In templates use `<.link navigate={href}>` / `<.link patch={href}>`; in the
LiveView use `push_navigate/2` / `push_patch/2`. `live_redirect` and
`live_patch` are deprecated — never use them.

Name LiveViews with a `Live` suffix (`AppWeb.WeatherLive`). The router's
`:browser` scope is already aliased with `AppWeb`, so the route is just
`live "/weather", WeatherLive` — never add your own alias.

## Component Decision Tree

```
Does component need BOTH internal state AND event handling?
│
├── YES → Does it encapsulate APPLICATION logic (not just DOM)?
│   ├── YES → Use LiveComponent ✅
│   └── NO → Refactor to function component with parent handling
│
└── NO → Use Function Component ✅
```

**Official guidance**: "Prefer function components over live components"

## Common Anti-patterns

| Wrong | Right |
|-------|-------|
| DB queries without `assign_async` | Use `assign_async` for all queries |
| `assign(socket, items: list)` for lists | `stream(socket, :items, list)` |
| PubSub subscribe without `connected?` | `if connected?(socket), do: subscribe()` |
| Passing socket to context functions | Extract `socket.assigns` first |
| Business logic in `handle_event` | Delegate to context |
| `assign_new` for locale/user in hooks | `assign/3` (must run every mount) |
| `live_redirect` / `live_patch` | `<.link navigate=>` / `push_navigate/2` |
| `phx-update="append"` / `"prepend"` | `stream(..., at: -1)` (append, default) / `at: 0` (prepend) |
| `Enum.filter` on `@streams.x` | refetch + `stream(..., reset: true)` |
| Raw `<script>` in HEEx | colocated hook (`:type={Phoenix.LiveView.ColocatedHook}`) |

## References

For detailed patterns, see:

- `references/heex-syntax.md` - Interpolation, class lists, comments, curly escaping, form rules
- `references/async-streams.md` - assign_async, stream_async, streams
- `references/forms-uploads.md` - Forms, validation, file uploads
- `references/components.md` - Function components, LiveComponents
- `references/pubsub-navigation.md` - PubSub, navigation, JS commands
- `references/js-interop.md` - Third-party JS libraries, phx-update="ignore", hooks
- `references/channels-presence.md` - Phoenix Channels, Presence, token auth
