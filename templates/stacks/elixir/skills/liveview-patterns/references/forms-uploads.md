# Forms and Uploads Reference

## Form Handling

```elixir
# Simple form
def mount(_params, _session, socket) do
  changeset = Accounts.change_user(%User{})
  {:ok, assign(socket, form: to_form(changeset))}
end

def handle_event("validate", %{"user" => params}, socket) do
  changeset =
    %User{}
    |> Accounts.change_user(params)
    |> Map.put(:action, :validate)  # Triggers error display

  {:noreply, assign(socket, form: to_form(changeset))}
end

def handle_event("save", %{"user" => params}, socket) do
  case Accounts.create_user(socket.assigns.current_scope, params) do
    {:ok, _user} ->
      {:noreply,
       socket
       |> put_flash(:info, "User created")
       |> push_navigate(to: ~p"/users")}

    {:error, changeset} ->
      {:noreply, assign(socket, form: to_form(changeset))}
  end
end

# Template — always an explicit, unique DOM id
~H"""
<.form for={@form} id="user-form" phx-change="validate" phx-submit="save">
  <.input field={@form[:name]} label="Name" />
  <.input field={@form[:email]} type="email" label="Email" />
  <.button>Save</.button>
</.form>
"""
```

The UI must **always** be driven by a `to_form/2` assign derived from a
changeset — never by the changeset itself. See `heex-syntax.md` "Forms".

## Building the Form Assign

### From a changeset (the default)

`to_form/1` pulls data, params and errors off the changeset, and computes `:as`
from the schema. A `MyApp.Users.User` changeset submits as `%{"user" => params}`.

```elixir
%MyApp.Users.User{}
|> Ecto.Changeset.change()
|> to_form()
```

### From raw params

A map passed to `to_form/1` is treated as form params, and is expected to have
**string keys**:

```elixir
def handle_event("submitted", params, socket) do
  {:noreply, assign(socket, form: to_form(params))}
end
```

Pass `:as` to nest them under a name:

```elixir
def handle_event("submitted", %{"user" => user_params}, socket) do
  {:noreply, assign(socket, form: to_form(user_params, as: :user))}
end
```

## Debouncing & Throttling

```elixir
# Wait until user stops typing (500ms)
<input phx-debounce="500" />

# On blur only
<input phx-debounce="blur" />

# Rate limit (immediate, then 1x/second)
<button phx-throttle="1000">+</button>
```

## Dynamic Nested Forms

```elixir
# Changeset
|> cast_assoc(:items, sort_param: :items_sort, drop_param: :items_drop)

# Template
~H"""
<.inputs_for :let={item} field={@form[:items]}>
  <input type="hidden" name="order[items_sort][]" value={item.index} />
  <.input field={item[:name]} label="Item Name" />
  <button type="button" name="order[items_drop][]" value={item.index}>
    Remove
  </button>
</.inputs_for>
<button type="button" name="order[items_sort][]" value="new">
  Add Item
</button>
"""
```

## File Uploads

```elixir
def mount(_params, _session, socket) do
  {:ok,
   socket
   |> assign(:uploaded_files, [])
   |> allow_upload(:avatar,
       accept: ~w(.jpg .jpeg .png),
       max_entries: 2,
       max_file_size: 8_000_000)}
end

def handle_event("save", _params, socket) do
  uploaded_files =
    consume_uploaded_entries(socket, :avatar, fn %{path: path}, entry ->
      dest = Path.join(["priv", "static", "uploads", entry.client_name])
      File.cp!(path, dest)
      {:ok, ~p"/uploads/#{entry.client_name}"}
    end)

  {:noreply, update(socket, :uploaded_files, &(&1 ++ uploaded_files))}
end

# Template
~H"""
<form id="upload-form" phx-submit="save" phx-change="validate">
  <.live_file_input upload={@uploads.avatar} />

  <%= for entry <- @uploads.avatar.entries do %>
    <progress value={entry.progress} max="100">{entry.progress}%</progress>

    <%= for err <- upload_errors(@uploads.avatar, entry) do %>
      <p class="error">{error_to_string(err)}</p>
    <% end %>
  <% end %>

  <.button type="submit">Upload</.button>
</form>
"""
```

## LiveView 1.0/1.1 Breaking Changes

```elixir
# ❌ REMOVED - phx-feedback-for attribute
# ✅ USE - Phoenix.Component.used_input?/1
errors = if Phoenix.Component.used_input?(field), do: field.errors, else: []

# ❌ REMOVED - live_component/2,3 helper
<%= live_component(FormComponent, id: "form") %>
# ✅ USE - component syntax
<.live_component module={FormComponent} id="form" />

# ❌ REMOVED - push_redirect
# ✅ USE - push_navigate
push_navigate(socket, to: ~p"/path")
```
