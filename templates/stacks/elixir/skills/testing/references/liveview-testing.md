# LiveView Testing Reference

Assertions run through `Phoenix.LiveViewTest` and `LazyHTML` (shipped with it).
Forms are driven by `render_submit/2` and `render_change/2`.

## Selecting, Not Scraping

- **Never** assert against raw HTML. Use `element/2`, `has_element?/2` and
  selector-based helpers: `assert has_element?(view, "#my-form")`.
- **Always reference the DOM ids you put in the template.** That is what those
  ids are for — see `elixir-liveview-patterns` `references/heex-syntax.md`.
- Favor the presence of key elements over text content, which changes.
- Test outcomes, not implementation details.
- `Phoenix.Component` functions like `<.form>` may emit different HTML than you
  picture. Assert against the real output structure.

### Debugging a failing selector

Print the actual markup, narrowed by `LazyHTML` so the output stays readable:

```elixir
html = render(view)
document = LazyHTML.from_fragment(html)
matches = LazyHTML.filter(document, "your-complex-selector")
IO.inspect(matches, label: "Matches")
```

### Test plan

Split major cases into small, isolated files. Start with tests that verify
content exists, then layer interaction tests on top.

## Mount and Interact

```elixir
test "user can interact with counter", %{conn: conn} do
  {:ok, view, html} = live(conn, ~p"/counter")
  assert html =~ "Count: 0"

  html = view
    |> element("button", "Increment")
    |> render_click()

  assert html =~ "Count: 1"
end
```

## Form Testing

```elixir
test "validates form on change", %{conn: conn} do
  {:ok, view, _html} = live(conn, ~p"/users/new")

  # Validation on change
  html = view
    |> form("#user-form", user: %{email: "invalid"})
    |> render_change()

  assert html =~ "must be a valid email"

  # Submission
  view
  |> form("#user-form", user: %{email: "valid@example.com", name: "Jane"})
  |> render_submit()

  assert_redirect(view, ~p"/users")
end
```

## Async Operations (CRITICAL)

```elixir
test "loads data asynchronously", %{conn: conn} do
  {:ok, view, html} = live(conn, ~p"/dashboard")
  assert html =~ "Loading..."

  # MUST call render_async for assign_async
  html = render_async(view)
  assert html =~ "Dashboard Data"
end
```

## PubSub Testing

```elixir
test "updates on broadcast", %{conn: conn} do
  {:ok, view, _html} = live(conn, ~p"/chat/room1")

  Phoenix.PubSub.broadcast(MyApp.PubSub, "chat:room1", {:new_message, "Hello!"})

  # Re-render to see update
  assert render(view) =~ "Hello!"
end
```

## File Uploads

```elixir
test "uploads file", %{conn: conn} do
  {:ok, view, _html} = live(conn, ~p"/upload")

  avatar = file_input(view, "#avatar-form", :avatar, [
    %{
      name: "photo.jpg",
      content: File.read!("test/fixtures/photo.jpg"),
      type: "image/jpeg"
    }
  ])

  assert render_upload(avatar, "photo.jpg") =~ "100%"

  view |> form("#avatar-form") |> render_submit()
  assert render(view) =~ "Upload complete"
end
```

## Navigation Testing

```elixir
# Patch (same LiveView, different params)
assert_patch(view, ~p"/posts/#{post.id}")

# Redirect (different LiveView or dead view)
assert_redirect(view, ~p"/login")

# Navigate within LiveView
view |> element("a", "Next Page") |> render_click()
```

## Common Mistakes

```elixir
# ❌ Missing render_async for assign_async
test "loads data" do
  {:ok, view, _html} = live(conn, ~p"/dashboard")
  assert render(view) =~ "Data"  # Will fail - async not resolved!
end

# ✅ Call render_async
test "loads data" do
  {:ok, view, _html} = live(conn, ~p"/dashboard")
  html = render_async(view)
  assert html =~ "Data"
end
```
