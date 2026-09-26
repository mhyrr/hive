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

## Rules

1. **Mount runs twice** — once for the static HTTP render, again when the socket connects, so every query in `mount/3` runs twice. Put slow or non-essential loads in `assign_async` (it runs only once connected); cheap primary data stays in `mount/3` (rule 5)
2. **Streams for large or growing lists** — a list in assigns is held in server memory for every connected user; a stream is not. Use streams past ~100 items or for anything unbounded; a small fixed list can stay an assign
3. **Check connected?/1 before subscriptions** — Prevents double subscriptions
4. **Extract variables before assign_async closure** — Closures copy entire referenced variables
5. **Load primary data in mount/3, pagination in handle_params/3** — handle_params runs on every URL change
6. **Never pass socket to business logic** — Extract data before calling contexts
7. **Check changeset errors before UI debugging** — Silent form save = check `{:error, changeset}` first, not viewport/JS
8. **Hidden inputs for all required embedded fields** — Every required field in an embedded schema must have a `hidden_input` if not directly editable
9. **`assign_new` reuses a value already present** — on the disconnected render it reads `conn.assigns`, and a child LiveView reads the parent's; that is why phx.gen.auth mounts `:current_scope` with it. Use `assign/3` for a value that must be recomputed on every mount

## HEEx Rules (phx.new canon)

Some fail compilation (`<%= %>` in an attribute, class lists without `[...]`); the rest are conventions the generators and LiveView test helpers assume. Full detail in `references/heex-syntax.md`.

1. **`{...}` in attributes, always** — `<%= %>` works only in tag bodies. `id="<%= @id %>"` is a syntax error
2. **`<%= %>` only for blocks** — `if`/`cond`/`case`/`for` in a tag body. Plain values use `{...}`
3. **Comments are `<%!-- --%>`** — not `<!-- -->`
4. **Class lists need `[...]`** — `class={["a", @flag && "b", if(@c, do: "x", else: "y")]}`. No brackets = compile error. Parenthesize the `if`
5. **Literal `{`/`}` needs `phx-no-curly-interpolation`** — on the parent `<pre>`/`<code>` tag
6. **NO `else if`** — use `<%= cond do %>`
7. **`~H` or `.html.heex` only** — never `~E`
8. **Never render a changeset** — assign `to_form/2` in the LiveView; `<.form for={@form}>` and `@form[:field]`. `<.form for={@changeset}>` and `let={f}` both error
9. **Unique DOM IDs on key elements** — forms, buttons, anything a test selects

## Memory Impact

| Pattern | 3K items | 10K users × 10K items |
|---------|----------|----------------------|
| Regular assigns | ~5.1 MB | ~10+ GB |
| Streams | ~1.1 MB | Minimal (O(1)) |

**Decision**: Lists with >100 items → Use streams, not assigns

## Quick Patterns

### Async Assigns

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
| Slow query run synchronously in `mount/3` | `assign_async` |
| `assign(socket, items: list)` for lists | `stream(socket, :items, list)` |
| PubSub subscribe without `connected?` | `if connected?(socket), do: subscribe()` |
| Passing socket to context functions | Extract `socket.assigns` first |
| Business logic in `handle_event` | Delegate to context |
| `assign_new` for a value that must be recomputed every mount | `assign/3` |
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
