# Async and Streams Reference

## Lifecycle Execution Order

```
[Initial HTTP Request]
     ↓
mount/3 (disconnected) → handle_params/3 → render/1
     ↓
[WebSocket Connection]
     ↓
mount/3 (connected) → handle_params/3 → render/1
     ↓
[Stateful Loop]
handle_event/3, handle_info/2, handle_async/3
```

**Critical**: Code in mount runs TWICE unless you use `assign_async` or check `connected?/1`

## Async Assigns (LiveView 1.0+)

**CRITICAL**: Extract variables BEFORE closure to avoid copying socket:

```elixir
def mount(%{"slug" => slug}, _session, socket) do
  # Extract needed values BEFORE the closure
  scope = socket.assigns.current_scope

  {:ok,
   socket
   |> assign(:page_title, "Dashboard")
   |> assign_async(:org, fn -> {:ok, %{org: fetch_org(scope, slug)}} end)
   |> assign_async([:posts, :comments], fn ->
     {:ok, %{posts: list_posts(slug), comments: list_comments(slug)}}
   end)}
end

# In template - handle loading state
~H"""
<.async_result :let={org} assign={@org}>
  <:loading>Loading <.spinner /></:loading>
  <:failed :let={_failure}>Error loading</:failed>
  {org.name}
</.async_result>
"""
```

### Cancel Async Operations

```elixir
def handle_event("cancel_search", _, socket) do
  {:noreply, cancel_async(socket, :search_results)}
end
```

### Testing Async Operations

```elixir
test "loads data asynchronously", %{conn: conn} do
  {:ok, view, html} = live(conn, ~p"/dashboard")
  assert html =~ "Loading..."

  html = render_async(view)  # Wait for async to complete
  assert html =~ "Dashboard Data"
end
```

## stream_async (LiveView 1.1+)

```elixir
def mount(%{"slug" => slug}, _, socket) do
  {:ok, stream_async(socket, :posts, fn -> {:ok, list_posts!()} end)}
end
```

## Streams (for Lists)

### Basic Stream Operations

```elixir
# Mount - initialize stream
def mount(_params, _session, socket) do
  {:ok, stream(socket, :items, Items.list_items())}
end

# Insert item (at beginning)
def handle_event("create", params, socket) do
  {:ok, item} = Items.create_item(params)
  {:noreply, stream_insert(socket, :items, item, at: 0)}
end

# Update item
def handle_event("update", %{"id" => id} = params, socket) do
  item = Items.get_item!(id)
  {:ok, updated} = Items.update_item(item, params)
  {:noreply, stream_insert(socket, :items, updated)}
end

# Delete item
def handle_event("delete", %{"id" => id}, socket) do
  item = Items.get_item!(id)
  {:ok, _} = Items.delete_item(item)
  {:noreply, stream_delete(socket, :items, item)}
end
```

### Streams Are Not Enumerable

`@streams.name` cannot be filtered, counted, or reduced. `Enum.filter/2`,
`Enum.reject/2` and `Enum.count/1` do not work on it.

To filter, prune or refresh, **refetch and re-stream the whole collection with
`reset: true`**:

```elixir
def handle_event("filter", %{"filter" => filter}, socket) do
  messages = list_messages(filter)

  {:noreply,
   socket
   |> assign(:messages_empty?, messages == [])
   |> stream(:messages, messages, reset: true)}
end
```

Counts need their own assign, as above — the stream cannot supply one.

### Re-stream When an Assign Changes Streamed Content

If an assign drives markup *inside* a streamed item, changing that assign alone
patches nothing. `stream_insert/3` the affected item along with the assign:

```elixir
def handle_event("edit_message", %{"message_id" => id}, socket) do
  message = Chat.get_message!(id)

  {:noreply,
   socket
   |> stream_insert(:messages, message)
   |> assign(:editing_message_id, String.to_integer(id))}
end
```

### Stream Pagination with Limit

```elixir
# Append new items, prune from top (keep last 30)
stream(socket, :posts, new_posts, at: -1, limit: -30)

# Prepend items, prune from bottom (keep first 30)
stream(socket, :posts, Enum.reverse(posts), at: 0, limit: 30)
```

### Empty Stream Handling (Use CSS)

Streams do not support empty states. Use `:only-child` — it works only when the
empty-state element is the sole sibling of the stream comprehension:

```elixir
~H"""
<tbody id="songs" phx-update="stream">
  <tr id="songs-empty" class="only:table-row hidden">
    <td colspan="3">No songs found</td>
  </tr>
  <tr :for={{dom_id, song} <- @streams.songs} id={dom_id}>
    <td>{song.title}</td>
  </tr>
</tbody>
"""
```

### Stream Template

```elixir
~H"""
<div id="items" phx-update="stream">
  <div :for={{dom_id, item} <- @streams.items} id={dom_id}>
    {item.name}
  </div>
</div>
"""
```

## Anti-patterns

```elixir
# ❌ Database queries when disconnected (runs TWICE)
def mount(_params, _session, socket) do
  data = Repo.all(User)  # ← HTTP render + WebSocket connect
  {:ok, assign(socket, data: data)}
end

# ✅ Use assign_async (runs only when connected)
def mount(_params, _session, socket) do
  {:ok, assign_async(socket, :data, fn -> {:ok, %{data: Repo.all(User)}} end)}
end

# ❌ Copying socket to async closure
assign_async(socket, :org, fn -> {:ok, %{org: fetch_org(socket.assigns.slug)}} end)

# ✅ Extract before closure
slug = socket.assigns.slug
assign_async(socket, :org, fn -> {:ok, %{org: fetch_org(slug)}} end)

# ❌ Not using streams for lists (memory hog)
{:ok, assign(socket, items: Items.list_items())}

# ✅ Use streams (O(1) memory)
{:ok, stream(socket, :items, Items.list_items())}

# ❌ Deprecated collection updates
<div phx-update="append">   # also "prepend"
# ✅ Position with the stream API instead
stream(socket, :items, items, at: -1)  # append (default); at: 0 prepends
```

## Template Contract

Every stream needs both halves or nothing renders:

1. The parent element carries `phx-update="stream"` **and** a DOM id.
2. The comprehension consumes `@streams.name` and uses the yielded id as each
   child's DOM id.

```heex
<div id="messages" phx-update="stream">
  <div :for={{id, msg} <- @streams.messages} id={id}>
    {msg.text}
  </div>
</div>
```
